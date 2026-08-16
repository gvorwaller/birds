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

	if (transientFailures.length > 0 && attemptsLeft) {
		return {
			kind: 'retry',
			delayMs: retryDelayMs(attempt, 'transient'),
			reason: `${transientFailures.length} location(s) hit transient eBird errors`,
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
	syncTaxonomy: () => 'sync_taxonomy:global'
} as const;

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
	sync_taxonomy: 'Sync taxonomy'
};

export function displayName(job: Pick<JobRow, 'type' | 'label'>): string {
	const base = TYPE_NAMES[job.type] ?? job.type;
	return job.label ? `${base} — ${job.label}` : base;
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
