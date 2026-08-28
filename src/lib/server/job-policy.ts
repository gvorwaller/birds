/**
 * Pure job-queue policy — no DB, no runes, fully unit-tested.
 * Plan: docs/2026-08-15-ebird-worker-job-queue-plan.md §3.
 *
 * Failure KINDS are attached per unit inside ensureFrequencies where the typed
 * error is still in hand (CODEX1 #2) — this module only consumes structured
 * kinds; it never parses messages.
 */
import { createHash } from 'node:crypto';
import { HOTSPOT_FAILURE_COOLDOWN_MS } from '$server/barchart';

export type FailureKind = 'credential' | 'rate_limited' | 'transient' | 'unit' | 'cooldown';

export interface UnitFailure {
	code: string;
	error: string;
	kind: FailureKind;
}

/** The subset of EnsureResult the outcome policy needs. */
export interface EnsureSummary {
	ready: string[];
	refreshed: string[];
	failed: UnitFailure[];
	notAttempted: string[];
	credentialProblem: string | null;
	rateLimited: boolean;
}

export type JobOutcome =
	| { kind: 'complete'; result: EnsureSummary }
	| { kind: 'retry'; delayMs: number; reason: string; result: EnsureSummary }
	| { kind: 'fail'; error: string; result: EnsureSummary };

/**
 * Transient retry schedule — every delay is deliberately ≥ the 15-minute
 * hotspot failure cooldown, so a retry round never arrives to find all its
 * units still cooling down (property-tested).
 */
/** Enrichment Phase 2: ON. AI-missing rows with prose count as stale
 * (CODEX1 #6). Lives here (pure module) so page actions can read it
 * without importing the worker (GROK td-b7d021 nit). */
export const AI_STAGE_ENABLED = true;

export const TRANSIENT_RETRY_DELAYS_MS = [16 * 60_000, 45 * 60_000, 120 * 60_000] as const;
export const RATE_LIMIT_RETRY_DELAY_MS = 30 * 60_000;
export const DEFAULT_MAX_ATTEMPTS = 4; // initial + 3 retries

export function retryDelayMs(attempt: number, kind: 'transient' | 'rate_limited'): number {
	if (kind === 'rate_limited') return RATE_LIMIT_RETRY_DELAY_MS;
	const idx = Math.min(Math.max(attempt - 1, 0), TRANSIENT_RETRY_DELAYS_MS.length - 1);
	return TRANSIENT_RETRY_DELAYS_MS[idx];
}

/**
 * Decide a job attempt's fate from the ensure summary.
 *
 * - credential problem → terminal fail (message points at Settings), no retry.
 * - rate limited (429 stopped the batch) → retry after the flat backoff.
 * - notAttempted remainder (drain/stop or transient batch abort) → retry per
 *   the transient schedule while attempts remain, else terminal.
 * - remainder consisting ONLY of cooldown skips → retry at the cooldown
 *   expiry; a cooldown round is never a "failed attempt" (CODEX1 #6), so it
 *   also does not exhaust the budget: if attempts are spent, complete with the
 *   cooldown units reported in the result rather than failing generically
 *   (GROK #11j).
 * - transient unit failures remaining (5xx that survived the in-batch retry)
 *   → retry while attempts remain.
 * - otherwise complete; permanent unit failures live in the result, not in a
 *   job failure — unless NOTHING succeeded and everything failed permanently,
 *   which completes too (the result says so honestly; the per-loc attempts
 *   table carries the detail).
 */
export function jobOutcome(
	summary: EnsureSummary,
	attempt: number,
	maxAttempts: number
): JobOutcome {
	if (summary.credentialProblem) {
		return { kind: 'fail', error: summary.credentialProblem, result: summary };
	}

	const attemptsLeft = attempt < maxAttempts;
	const cooldownFailures = summary.failed.filter((f) => f.kind === 'cooldown');
	const transientFailures = summary.failed.filter((f) => f.kind === 'transient');

	if (summary.rateLimited) {
		if (attemptsLeft) {
			return {
				kind: 'retry',
				delayMs: retryDelayMs(attempt, 'rate_limited'),
				reason: 'eBird rate limit — backing off',
				result: summary
			};
		}
		return { kind: 'fail', error: 'eBird rate limit persisted across retries.', result: summary };
	}

	if (summary.notAttempted.length > 0) {
		if (attemptsLeft) {
			return {
				kind: 'retry',
				delayMs: retryDelayMs(attempt, 'transient'),
				reason: `${summary.notAttempted.length} location(s) not yet attempted`,
				result: summary
			};
		}
		return {
			kind: 'fail',
			error: `${summary.notAttempted.length} location(s) could not be attempted after ${maxAttempts} tries.`,
			result: summary
		};
	}

	if (transientFailures.length > 0) {
		if (attemptsLeft) {
			return {
				kind: 'retry',
				delayMs: retryDelayMs(attempt, 'transient'),
				reason: `${transientFailures.length} location(s) hit transient eBird errors`,
				result: summary
			};
		}
		// Exhausted transient failures are a TERMINAL failure, never a quiet
		// success — a location that 500s through every round must surface as
		// failed in the UI (CODEX1 re-review #1). The summary still carries
		// whatever did load.
		return {
			kind: 'fail',
			error: `${transientFailures.length} location(s) still failing with transient eBird errors after ${maxAttempts} attempts.`,
			result: summary
		};
	}

	if (cooldownFailures.length > 0 && attemptsLeft) {
		return {
			kind: 'retry',
			delayMs: HOTSPOT_FAILURE_COOLDOWN_MS + 60_000,
			reason: `${cooldownFailures.length} location(s) waiting out a failure cooldown`,
			result: summary
		};
	}

	return { kind: 'complete', result: summary };
}

// ---------------------------------------------------------------------------
// Dedup keys
// ---------------------------------------------------------------------------

export function dedupKeyForLocs(prefix: string, locCodes: readonly string[]): string {
	const h = createHash('sha256')
		.update([...locCodes].sort().join(','))
		.digest('hex')
		.slice(0, 16);
	return `${prefix}:${h}`;
}

export const dedupKeys = {
	loadHotspots: (locCodes: readonly string[]) => dedupKeyForLocs('load_hotspots', locCodes),
	loadRegion: (regionCode: string) => `load_region:${regionCode}`,
	analyzeCounties: (regionCode: string) => `analyze_counties:${regionCode}`,
	refreshLoc: (locCode: string) => `refresh_loc:${locCode}`,
	retryLoc: (locCode: string) => `retry_loc:${locCode}`,
	syncLifelist: (userId: number) => `sync_lifelist:u${userId}`,
	syncTaxonomy: () => 'sync_taxonomy:global',
	scanNeedAlerts: () => 'scan_need_alerts:global',
	// Content-hashed per chunk (CODEX1 plan #2): identical chunk dedups,
	// different codes are distinct jobs — a constant key would silently drop
	// newly-scoped codes because enqueueJob dedup never merges payloads.
	enrichChunk: (codes: readonly string[]) => dedupKeyForLocs('enrich_species', codes),
	enrichAiChunk: (codes: readonly string[]) => dedupKeyForLocs('enrich_species_ai', codes),
	enrichSpeciesOne: (code: string) => `enrich_species:one:${code}`,
	scanEnrichment: () => 'scan_enrichment:global',
	enrichMediaChunk: (codes: readonly string[]) => dedupKeyForLocs('enrich_media', codes),
	enrichMediaForceChunk: (codes: readonly string[]) => dedupKeyForLocs('enrich_media_force', codes),
	enrichMediaOne: (code: string) => `enrich_media:one:${code}`,
	enrichInatChunk: (codes: readonly string[]) => dedupKeyForLocs('enrich_inat', codes),
	enrichInatOne: (code: string) => `enrich_inat:one:${code}`
} as const;

// ---------------------------------------------------------------------------
// Durable-storage sanitization (cs.md: never log eBird credentials)
// ---------------------------------------------------------------------------

/**
 * Redact credential-shaped material from free text before it can reach
 * durable storage (CODEX1 Phase-2 review #1). The realistic vector is
 * upstream error text — a proxy or login page echoing request material —
 * which the pipeline stores verbatim in progress.lastError, job_events
 * details, and job results. Patterns require a key[=:]value shape so plain
 * place names ("Token Creek", "Login Rd") never match.
 */
const REDACT_PATTERNS: [RegExp, string][] = [
	[/(password|passwd|pwd)\s*[=:]\s*[^\s&]+/gi, '$1=[redacted]'],
	// Header values redact through end-of-line (CR/LF): a Cookie header can
	// carry MULTIPLE `name=value; name=value` pairs and every one is
	// potentially a credential (CODEX1 Phase-2 re-review #1).
	[/(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, '$1: [redacted]'],
	[/(api[_-]?key|apikey|access[_-]?token|secret)\s*[=:]\s*[^\s&]+/gi, '$1=[redacted]'],
	[/(username|user|login|email)\s*[=:]\s*[^\s&]+/gi, '$1=[redacted]'],
	[/bearer\s+[a-z0-9._~+/-]+=*/gi, 'bearer [redacted]'],
	// JSON-form: an upstream error echoing a request body as JSON carries
	// `"password":"…"` — quoted key, quoted value (GROK Phase-2 nit).
	[
		/"(password|passwd|pwd|api[_-]?key|apikey|access[_-]?token|secret|authorization|cookie|username|user|login|email)"\s*:\s*"[^"]*"/gi,
		'"$1":"[redacted]"'
	]
];

export function sanitizeErrorText(text: string): string {
	let out = text;
	for (const [re, replacement] of REDACT_PATTERNS) {
		out = out.replace(re, replacement);
	}
	return out;
}

/**
 * Deep-scrub every string in a JSON-bound value. Applied by jobs.ts at THE
 * durable boundary (events/progress/results/errors) so no caller can forget.
 */
export function scrubStoredValue<T>(value: T): T {
	if (typeof value === 'string') return sanitizeErrorText(value) as unknown as T;
	if (Array.isArray(value)) return value.map((v) => scrubStoredValue(v)) as unknown as T;
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubStoredValue(v)])
		) as unknown as T;
	}
	return value;
}

// ---------------------------------------------------------------------------
// Safe payload projections (for /api/jobs decoration — never credentials)
// ---------------------------------------------------------------------------

/**
 * The job's target identity for UI scoping — e.g. the species page must bind
 * "Analyzing…" to THAT region's job, not any analyze job globally (CODEX1
 * re-review #3). Region jobs answer with their region code; multi-loc loads
 * have no single identity and answer null.
 */
export function jobTarget(type: string, payload: unknown): string | null {
	const p = payload as {
		regionCode?: unknown;
		areaCode?: unknown;
		locs?: { code?: unknown }[];
	} | null;
	if (type === 'analyze_counties' && typeof p?.regionCode === 'string') {
		return p.regionCode;
	}
	// A county sweep (td-372d2a) answers with the county it covers so the row
	// that launched it can show progress; piecemeal hotspot loads still answer
	// null — many locs, no single identity.
	if (type === 'load_hotspots' && typeof p?.areaCode === 'string') {
		return p.areaCode;
	}
	if (
		(type === 'load_region' || type === 'refresh_loc' || type === 'retry_loc') &&
		Array.isArray(p?.locs) &&
		typeof p.locs[0]?.code === 'string'
	) {
		return p.locs[0].code;
	}
	return null;
}

/**
 * Every loc code an active job covers, so pages can disable per-row Load
 * buttons for locations already being fetched (CODEX1 re-review #5). Codes
 * only — names/regions stay out of the wire format.
 */
/** The frequency-load family: communal by design (this page lets any user
 * see and cancel anyone's load), so their per-unit events are communal too.
 * Every OTHER job type's events may reference individual users (alert scans,
 * syncs, enrichment) — admin-only (CODEX1 P1 on e3ac335). */
export const FREQUENCY_JOB_TYPES: ReadonlySet<string> = new Set([
	'load_hotspots',
	'load_region',
	'analyze_counties',
	'refresh_loc',
	'retry_loc'
]);

export function canViewJobEvents(jobType: string, role: string | undefined): boolean {
	return role === 'admin' || FREQUENCY_JOB_TYPES.has(jobType);
}

export function jobLocCodes(payload: unknown): string[] {
	const p = payload as {
		locs?: { code?: unknown }[];
		counties?: { code?: unknown }[];
		allCodes?: unknown[];
	} | null;
	const arr = Array.isArray(p?.locs) ? p.locs : Array.isArray(p?.counties) ? p.counties : [];
	const current = arr.map((x) => x?.code).filter((c): c is string => typeof c === 'string');
	// A budget yield narrows payload.locs to the remaining work set; allCodes
	// preserves the ORIGINAL coverage so the UI's covered/queued flags don't
	// flap mid-job — a banked loc flipping back to "unloaded" between yield
	// and the next data refresh let Load-all re-enqueue it (GROK P1 #2 on
	// afb305d). Union, never replace: a job without allCodes behaves as before.
	const all = Array.isArray(p?.allCodes)
		? p.allCodes.filter((c): c is string => typeof c === 'string')
		: [];
	return all.length > 0 ? [...new Set([...all, ...current])] : current;
}

// ---------------------------------------------------------------------------
// Progress + decoration
// ---------------------------------------------------------------------------

export interface JobProgress {
	phase: 'starting' | 'fetching' | 'waiting_retry';
	unitsTotal: number;
	unitsDone: number;
	unitsFailed: number;
	unitsSkipped: number;
	currentUnit?: { code: string; name: string };
	lastError?: string;
	round: number;
}

export interface JobRow {
	id: number;
	type: string;
	status: string;
	/** Job inputs, resolved and validated at enqueue time. NEVER credentials. */
	payload: unknown;
	label: string;
	attempts: number;
	max_attempts: number;
	next_retry_at: string | Date | null;
	cancel_requested: boolean;
	progress: JobProgress | Record<string, never>;
	result: unknown;
	error: string | null;
	requested_by: number;
	/** Joined in listJobs only (users.display_name) — absent on bare SELECTs. */
	requested_by_name?: string;
	enqueued_at: string | Date;
	started_at: string | Date | null;
	finished_at: string | Date | null;
	heartbeat_at: string | Date | null;
}

const TYPE_NAMES: Record<string, string> = {
	load_hotspots: 'Load hotspots',
	load_region: 'Load state data',
	analyze_counties: 'Analyze counties',
	refresh_loc: 'Refresh data',
	retry_loc: 'Retry load',
	sync_lifelist: 'Sync life list',
	sync_taxonomy: 'Sync taxonomy',
	scan_need_alerts: 'Need-alert scan (system)',
	enrich_species: 'Species data',
	scan_enrichment: 'Enrichment scan (system)',
	enrich_species_media: 'Species media',
	enrich_species_inat: 'Species confusion data'
};

export function displayName(job: Pick<JobRow, 'type' | 'label'>): string {
	const base = TYPE_NAMES[job.type] ?? job.type;
	return job.label ? `${base} — ${job.label}` : base;
}

/** Recurring singleton types that sit 'pending' between runs by design. */
const RECURRING_SINGLETONS = new Set(['scan_enrichment', 'scan_need_alerts']);

/**
 * A recurring singleton parked until its NEXT scheduled run (td-b7d021,
 * GROK pin a): pending + future next_retry_at + not actually retrying.
 * These must never read as "queued" work — the chip skips them, the poll
 * idles, and the hub shows a dedicated "next scan" line instead.
 */
export function isScheduledSingleton(
	job: Pick<JobRow, 'type' | 'status' | 'next_retry_at' | 'progress'>,
	now: Date = new Date()
): boolean {
	if (!RECURRING_SINGLETONS.has(job.type)) return false;
	if (job.status !== 'pending') return false;
	if (!job.next_retry_at || new Date(job.next_retry_at).getTime() <= now.getTime()) return false;
	const phase = (job.progress as { phase?: string } | null)?.phase;
	return phase !== 'waiting_retry';
}

export function durationMs(
	job: Pick<JobRow, 'started_at' | 'finished_at'>,
	now: Date = new Date()
): number | null {
	if (!job.started_at) return null;
	const start = new Date(job.started_at).getTime();
	const end = job.finished_at ? new Date(job.finished_at).getTime() : now.getTime();
	return Math.max(0, end - start);
}

/** Status → semantic color CLASS name (color + text label per cs.md, never color alone). */
export function statusColor(status: string): 'ok' | 'busy' | 'warn' | 'error' | 'muted' {
	switch (status) {
		case 'succeeded':
			return 'ok';
		case 'running':
			return 'busy';
		case 'pending':
			return 'warn';
		case 'failed':
			return 'error';
		default:
			return 'muted';
	}
}
