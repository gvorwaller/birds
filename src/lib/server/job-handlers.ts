/**
 * Worker-side job execution. One handler per job type; every handler performs
 * its own terminal transition (complete/retry/fail/cancel/requeue) using the
 * CAS primitives in jobs.ts — the worker loop only claims and dispatches.
 * Plan: docs/2026-08-15-ebird-worker-job-queue-plan.md §5.
 *
 * Payload contract: frequency payloads carry RESOLVED, action-validated
 * targets (CODEX1 #1) — the worker never re-derives or re-authorizes them.
 * Payloads/events/results never contain credentials (cs.md sacred rules).
 */
import {
	BATCH_TIME_BUDGET_MS,
	ensureFrequencies,
	type EnsureResult,
	type LocToEnsure,
	type StopSignal
} from '$server/barchart';
import { coverageFromMeta, recentFailures } from '$server/forecast';
import { frequencyMeta, attemptMeta, lastCompleteYear } from '$server/barchart';
import { env } from '$env/dynamic/private';
import { query, queryTimed } from '$lib/db';
import { getEbirdApiKey, notableNearbyObs, syncTaxonomy, EbirdError } from '$server/ebird';
import { seenSet } from '$server/needs';
import { sendWebPush, PushError, type PushSubscriptionRow } from '$server/push';
import {
	alertCandidates,
	SCAN_INTERVAL_MS,
	type AlertObs
} from '$lib/need-alerts-policy';
import {
	syncLifeListFromEbird,
	EbirdLoginError,
	EbirdUpstreamError
} from '$server/ebird-account';
import { rematchPhotoLinks } from '$server/gallery';
import {
	cancelRunningJob,
	completeJob,
	enqueueJob,
	failJob,
	hasActiveJob,
	recordEvent,
	requeueInterrupted,
	scheduleRetry,
	terminalizeAndReschedule,
	updateProgress,
	yieldRemainder
} from '$server/jobs';
import {
	AI_STAGE_ENABLED,
	dedupKeys,
	jobOutcome,
	RATE_LIMIT_RETRY_DELAY_MS,
	retryDelayMs,
	sanitizeErrorText,
	type JobProgress,
	type JobRow
} from '$server/job-policy';
import {
	fetchWikidataBatch,
	fetchWikidataBySciName,
	isRateLimitedError,
	validSpeciesCode,
	WikidataError,
	type WikidataSpeciesRow
} from '$server/wikidata';
import { fetchArticlePlaintext, WikipediaError } from '$server/wikipedia';
import {
	ERROR_RETRY_DAYS,
	aiDueCodes,
	aiStageInputFor,
	enrichmentScope,
	enrichSpeciesMedia,
	markAiError,
	markMediaError,
	markWikiError,
	markWikiNoArticle,
	mediaDueCodes,
	mediaFresh,
	similarCandidatesFor,
	similarCandidatesHash,
	touchSimilarFresh,
	upsertAiData,
	upsertResolution,
	upsertWikiOk,
	wikiFetchTitleFor,
	wikiStaleCodes
} from '$server/species-enrichment';
import {
	generateSpeciesAnnotation,
	EnrichmentAiError,
	AI_MODEL
} from '$server/ai-enrichment';

export interface WorkerContext {
	/** True once SIGTERM/SIGINT received — jobs wind down and requeue. */
	isDraining: () => boolean;
}

/** Cumulative narration across budget yields: the ORIGINAL batch total and
 * the completions banked by earlier chunks. Deliberately NOT failed/skipped —
 * failed units stay in the payload and may succeed on a later chunk, so
 * banking those counts would leave recovered locations falsely failed in the
 * terminal UI (CODEX1 #2 on afb305d); each chunk reports its own current
 * failed/skipped truth instead. */
interface FrequencyBase {
	total: number;
	done: number;
}

interface FrequencyPayload {
	locs: LocToEnsure[];
	force?: boolean;
	base?: FrequencyBase;
	/** ORIGINAL loc codes, set on the first yield: jobLocCodes unions this so
	 * covered/queued UI flags keep the whole batch while locs narrows. */
	allCodes?: string[];
}

interface AnalyzeCountiesPayload {
	regionCode: string;
	regionName: string;
	/** Resolved at enqueue time from the official region list (CODEX1 #1). */
	counties: { code: string; name: string }[];
}

/**
 * Summarize an EnsureResult for the jobs.result column — compact, and every
 * free-text field sanitized here as well as at the jobs.ts durable boundary
 * (defense in depth; upstream error text is the credential-leak vector).
 */
function summarize(r: EnsureResult) {
	return {
		ready: r.ready.length,
		refreshed: r.refreshed.length,
		failed: r.failed.map((f) => ({
			code: f.code,
			kind: f.kind,
			error: sanitizeErrorText(f.error).slice(0, 200)
		})),
		notAttempted: r.notAttempted.length,
		credentialProblem: r.credentialProblem ? sanitizeErrorText(r.credentialProblem) : null,
		rateLimited: r.rateLimited
	};
}

/**
 * Shared frequency-load runner. Drives ensureFrequencies with per-unit
 * events, progress heartbeats, cooperative cancel, drain requeue, and a
 * BATCH_TIME_BUDGET_MS chunk boundary — one termination path per cause
 * (GROK #6). At the boundary the job YIELDS: remaining work goes back to
 * pending BEHIND anything enqueued meanwhile (CODEX1 P1 on 2171eb7 — a
 * 1000-loc one-tap load must not monopolize the single-concurrency queue).
 * opts.remainderPayload builds the narrowed payload for the yield; job
 * types that re-derive their remainder at claim time (analyze_counties)
 * omit it and keep their payload verbatim. opts.base seeds cumulative
 * narration so the bar keeps counting the ORIGINAL batch across chunks.
 */
async function runFrequencyJob(
	job: JobRow,
	locs: LocToEnsure[],
	force: boolean,
	ctx: WorkerContext,
	opts: {
		base?: FrequencyBase;
		remainderPayload?: (remaining: LocToEnsure[], base: FrequencyBase) => unknown;
	} = {}
): Promise<void> {
	const attempts = job.attempts;
	let cancelSeen = false;
	let stopCause: Exclude<StopSignal, 'no'> | null = null;

	const progress: JobProgress = {
		phase: 'fetching',
		unitsTotal: opts.base?.total ?? locs.length,
		unitsDone: opts.base?.done ?? 0,
		unitsFailed: 0,
		unitsSkipped: 0,
		round: attempts
	};
	await recordEvent(job.id, 'claimed', { attempt: attempts, units: locs.length });
	await updateProgress(job.id, progress);

	const chunkStart = Date.now();
	const shouldStop = async (): Promise<StopSignal> => {
		if (cancelSeen) return (stopCause = 'cancel');
		if (ctx.isDraining()) return (stopCause = 'drain');
		if (Date.now() - chunkStart > BATCH_TIME_BUDGET_MS) return (stopCause = 'budget');
		return 'no';
	};

	const onUnit = async (loc: LocToEnsure, outcome: { status: string; kind?: string; error?: string }) => {
		if (outcome.status === 'ok') progress.unitsDone++;
		else if (outcome.status === 'skipped') progress.unitsSkipped++;
		else progress.unitsFailed++;
		progress.currentUnit = { code: loc.code, name: loc.name };
		const cleanError = outcome.error
			? sanitizeErrorText(outcome.error).slice(0, 200)
			: undefined;
		if (cleanError) progress.lastError = cleanError;
		try {
			await recordEvent(
				job.id,
				outcome.status === 'ok'
					? 'unit_ok'
					: outcome.status === 'skipped'
						? 'unit_skipped'
						: 'unit_failed',
				{ code: loc.code, name: loc.name, kind: outcome.kind, error: cleanError }
			);
			const { cancelRequested } = await updateProgress(job.id, progress);
			if (cancelRequested) cancelSeen = true;
		} catch {
			// Progress/event write failures must never fail the load itself
			// (CODEX1 #6) — the next unit's write will catch up.
		}
	};

	const ensure = await ensureFrequencies(job.requested_by, locs, {
		force,
		maxFetches: Infinity,
		timeBudgetMs: Infinity,
		onUnit,
		shouldStop
	});
	// Ready locs (made current by jobs that ran ahead of this one — the
	// fairness interleaving creates exactly this) never pass through onUnit.
	// Fold them into the cumulative count on EVERY return path, not only the
	// yield branch, or a resumed chunk that completes normally terminalizes
	// with a false partial bar (CODEX1 #1 on afb305d).
	if (ensure.ready.length > 0) {
		progress.unitsDone = (progress.unitsDone ?? 0) + ensure.ready.length;
		try {
			const { cancelRequested } = await updateProgress(job.id, progress);
			if (cancelRequested) cancelSeen = true;
		} catch {
			// Same policy as per-unit writes: never fail the load over telemetry.
		}
	}
	const summary = summarize(ensure);

	// Resolve termination ONCE MORE after ensure returns (CODEX1 re-review #2).
	// Race policy, most-specific intent first:
	// - cancel: a cancel observed by the LAST unit's progress write never went
	//   through shouldStop — without this re-check the job would record
	//   succeeded against the user's explicit cancel (and cancel_requested
	//   would linger TRUE on a terminal row).
	// - drain: any drain with work REMAINING is necessarily observed by
	//   shouldStop (checked at the loop top and around the 5xx-retry sleep), so
	//   an unobserved drain means every unit was attempted; completing (or
	//   letting jobOutcome schedule its 429/transient backoff) is then correct,
	//   and a blanket requeue would re-run a finished force-job from scratch or
	//   turn a rate-limit backoff into an immediate re-hit. No post-check.
	if (!stopCause && cancelSeen) stopCause = 'cancel';

	// One termination path per cause (GROK #6):
	if (stopCause === 'cancel') {
		await cancelRunningJob(job.id, attempts, summary);
		return;
	}
	if (stopCause === 'drain') {
		await requeueInterrupted(job.id, attempts);
		return;
	}
	if (stopCause === 'budget') {
		// Everything not banked as loaded stays in the job: notAttempted
		// resumes next chunk, and failed units keep riding the payload so the
		// existing cooldown/retry semantics still reach them.
		const banked = new Set([...ensure.ready, ...ensure.refreshed]);
		const remaining = locs.filter((l) => !banked.has(l.code));
		if (remaining.length > 0) {
			const newBase: FrequencyBase = {
				total: progress.unitsTotal ?? locs.length,
				// Ready was already folded into unitsDone above — no double-add.
				done: progress.unitsDone ?? 0
			};
			await yieldRemainder(
				job.id,
				attempts,
				opts.remainderPayload ? opts.remainderPayload(remaining, newBase) : null,
				{ ...summary, remaining: remaining.length }
			);
			return;
		}
		// Budget hit exactly at the last unit — nothing remains; fall through
		// to the normal outcome resolution below.
	}
	const outcome = jobOutcome(
		{
			ready: ensure.ready,
			refreshed: ensure.refreshed,
			failed: ensure.failed,
			notAttempted: ensure.notAttempted,
			credentialProblem: ensure.credentialProblem,
			rateLimited: ensure.rateLimited
		},
		attempts,
		job.max_attempts
	);
	if (outcome.kind === 'complete') {
		await completeJob(job.id, attempts, summary);
	} else if (outcome.kind === 'retry') {
		await scheduleRetry(job.id, attempts, outcome.delayMs, outcome.reason, summary);
	} else {
		// outcome.error may embed raw upstream text (credentialProblem) —
		// sanitize here too, not only at the jobs.ts boundary.
		await failJob(job.id, attempts, sanitizeErrorText(outcome.error), summary);
	}
}

function frequencyLocs(job: JobRow): {
	locs: LocToEnsure[];
	force: boolean;
	base?: FrequencyBase;
	allCodes?: string[];
} {
	const p = job.payload as unknown as FrequencyPayload;
	if (!Array.isArray(p?.locs) || p.locs.length === 0) {
		throw new Error('frequency job payload has no locs');
	}
	return { locs: p.locs, force: p.force === true, base: p.base, allCodes: p.allCodes };
}

/**
 * analyze_counties: the payload's county list was resolved and validated at
 * enqueue time. The worker recomputes only COVERAGE over that snapshot (what
 * is already current, what is cooling down) and loads the remainder.
 */
async function analyzeCountiesLocs(job: JobRow): Promise<LocToEnsure[]> {
	const p = job.payload as unknown as AnalyzeCountiesPayload;
	if (!Array.isArray(p?.counties) || p.counties.length === 0 || !p.regionCode) {
		throw new Error('analyze_counties payload has no resolved counties');
	}
	const codes = p.counties.map((c) => c.code);
	const [meta, attempts] = await Promise.all([frequencyMeta(codes), attemptMeta(codes)]);
	const cov = coverageFromMeta(codes, meta, recentFailures(attempts, new Date()), lastCompleteYear());
	const currentSet = new Set(cov.current);
	return p.counties
		.filter((c) => !currentSet.has(c.code))
		.map((c) => ({
			code: c.code,
			kind: 'region' as const,
			name: c.name,
			regionCode: p.regionCode
		}));
}

/**
 * Single-unit sync runner (Phase 3: sync_lifelist / sync_taxonomy). One
 * attempt = one call; credential failures are terminal, anything else
 * retries per the transient schedule while budget remains. Result payloads
 * are compact counts (never row dumps, never credentials).
 */
async function runSyncJob(job: JobRow, fn: () => Promise<unknown>): Promise<void> {
	const attempts = job.attempts;
	await recordEvent(job.id, 'claimed', { attempt: attempts });
	await updateProgress(job.id, {
		phase: 'fetching',
		unitsTotal: 1,
		unitsDone: 0,
		unitsFailed: 0,
		unitsSkipped: 0,
		round: attempts
	});
	try {
		const result = await fn();
		await updateProgress(job.id, {
			phase: 'fetching',
			unitsTotal: 1,
			unitsDone: 1,
			unitsFailed: 0,
			unitsSkipped: 0,
			round: attempts
		});
		await completeJob(job.id, attempts, result);
	} catch (err) {
		const message = sanitizeErrorText(
			err instanceof Error ? err.message : String(err)
		).slice(0, 300);
		// Typed classification (CODEX1 Phase-3): EbirdLoginError is reserved
		// for credential/auth-flow failures (casLogin now throws
		// EbirdUpstreamError for reachability/5xx); an official-API 401/403 is
		// a bad key — both terminal. 429 anywhere honors the queue's flat
		// rate-limit backoff; everything else follows the transient schedule.
		const status =
			err instanceof EbirdUpstreamError
				? err.status
				: err instanceof EbirdError
					? (err.status ?? null)
					: null;
		const isCredential =
			err instanceof EbirdLoginError ||
			(err instanceof EbirdError && (status === 401 || status === 403));
		if (isCredential) {
			await failJob(job.id, attempts, message);
			return;
		}
		if (attempts < job.max_attempts) {
			const delay =
				status === 429 ? RATE_LIMIT_RETRY_DELAY_MS : retryDelayMs(attempts, 'transient');
			await scheduleRetry(job.id, attempts, delay, message);
			return;
		}
		await failJob(job.id, attempts, message);
	}
}

// ---------------------------------------------------------------------------
// Need-alert scan (plan Part A) — system-recurring singleton
// ---------------------------------------------------------------------------

/** Per-user wall budget inside a scan — one hung user must not starve the rest. */
const SCAN_USER_BUDGET_MS = 60_000;

class ScanBudgetExceeded extends Error {
	constructor() {
		super('per-user scan budget exceeded');
		this.name = 'ScanBudgetExceeded';
	}
}

/** ONE shared settlement-grace window past the deadline for must-settle
 * writes — NOT per-operation (CODEX1: fresh per-write graces stack). */
const WRITE_GRACE_MS = 5_000;

/**
 * HARD per-user wall deadline with no abandoned side effects (CODEX1
 * reviews). Every awaited leg inside the budget is bounded:
 * - the eBird fetch carries the AbortSignal (notableNearbyObs → ebirdFetch)
 *   — a hung fetch STOPS at the deadline;
 * - side-effect-FREE reads (API-key lookup, seenSet, sent-rows/subs SELECT)
 *   go through raceRead: on deadline the AWAIT rejects and the underlying
 *   read is detached — provably safe, a SELECT/decrypt that settles later
 *   mutates nothing and its result is discarded;
 * - web pushes take no signal (the web-push lib doesn't) — each is bounded
 *   by the adapter's own PUSH_TIMEOUT_MS, with checkpoint() before every
 *   send, so at most ONE send can straddle the deadline;
 * - must-settle WRITES (sent-row upsert, gone-endpoint prune) are never
 *   detached — each is bounded by queryTimed sized to graceLeftMs(), the
 *   SHARED absolute window (deadline + WRITE_GRACE_MS): however many writes
 *   remain, they split ONE grace, they don't stack fresh ones.
 * True outer wall: budget + PUSH_TIMEOUT_MS (one straddling send) +
 * WRITE_GRACE_MS — a fixed bound, tested.
 * The scan's OWN infra writes (skip/unit events, progress) are outside the
 * budget by design: they hit the same DB as the queue's heartbeat and
 * claims — a stall there is a stalled worker, recovered by heartbeat
 * staleness + startup reclaim, not a per-user budget.
 */
async function withBudget<T>(
	fn: (tools: {
		signal: AbortSignal;
		checkpoint: () => void;
		raceRead: <R>(p: Promise<R>) => Promise<R>;
		graceLeftMs: () => number;
	}) => Promise<T>,
	budgetMs: number
): Promise<T> {
	const controller = new AbortController();
	const deadlineAt = Date.now() + budgetMs;
	const timer = setTimeout(() => controller.abort(new ScanBudgetExceeded()), budgetMs);
	const checkpoint = () => {
		if (controller.signal.aborted) throw new ScanBudgetExceeded();
	};
	const raceRead = <R>(p: Promise<R>): Promise<R> => {
		if (controller.signal.aborted) return Promise.reject(new ScanBudgetExceeded());
		return new Promise<R>((resolve, reject) => {
			const onAbort = () => reject(new ScanBudgetExceeded());
			controller.signal.addEventListener('abort', onAbort, { once: true });
			p.then(
				(v) => {
					controller.signal.removeEventListener('abort', onAbort);
					resolve(v);
				},
				(e) => {
					controller.signal.removeEventListener('abort', onAbort);
					reject(e);
				}
			);
		});
	};
	const graceLeftMs = () => Math.max(1, deadlineAt + WRITE_GRACE_MS - Date.now());
	try {
		return await fn({ signal: controller.signal, checkpoint, raceRead, graceLeftMs });
	} catch (err) {
		if (controller.signal.aborted) throw new ScanBudgetExceeded();
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

async function lowestAdminId(): Promise<number> {
	const r = await query<{ id: number }>(
		`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`
	);
	if (!r.rows[0]) throw new Error('no admin user exists to own the recurring scan');
	return r.rows[0].id;
}

function scanEnqueueParams(adminId: number, runAfterMs: number) {
	return {
		type: 'scan_need_alerts' as const,
		payload: {},
		dedupKey: 'scan_need_alerts:global',
		requestedBy: adminId,
		label: 'every 30 min',
		runAfterMs
	};
}

/**
 * Ensure exactly one active scan job exists — called at worker startup AND
 * every idle tick (CODEX1 plan #1: the reconciliation backstop that repairs
 * a chain lost to ANY cause without a restart). Cheap: one indexed SELECT.
 */
export async function ensureNeedAlertScan(): Promise<void> {
	if (await hasActiveJob('scan_need_alerts:global')) return;
	const adminId = await lowestAdminId();
	await enqueueJob(scanEnqueueParams(adminId, 5_000));
}

/**
 * One scan: for every enabled user, notable-near-home ∩ needs → Web Push to
 * every enrolled device.
 * Delivery is explicitly AT-LEAST-ONCE (CODEX1 plan #3): send, then upsert
 * need_alerts_sent immediately per species — a crash in that window may
 * duplicate one push next scan; record-first would silently LOSE alerts.
 * Terminalization always goes through terminalizeAndReschedule so the next
 * run is scheduled atomically with this one's completion.
 */
async function runNeedAlertScan(job: JobRow): Promise<void> {
	const attempts = job.attempts;
	const origin = env.BIRDS_PUBLIC_ORIGIN ?? 'https://birds.gaylon.photos';
	await recordEvent(job.id, 'claimed', { attempt: attempts });

	const users = await query<{
		user_id: number;
		radius_km: number;
		realert_days: number;
		home_lat: number | null;
		home_lon: number | null;
	}>(
		`SELECT p.user_id, p.radius_km, p.realert_days, u.home_lat, u.home_lon
		   FROM user_alert_prefs p JOIN users u ON u.id = p.user_id
		  WHERE p.enabled ORDER BY p.user_id`
	);

	const progress: JobProgress = {
		phase: 'fetching',
		unitsTotal: users.rows.length,
		unitsDone: 0,
		unitsFailed: 0,
		unitsSkipped: 0,
		round: attempts
	};
	await updateProgress(job.id, progress);

	let alertsSent = 0;
	for (const u of users.rows) {
		// Everything the user's pipeline sends is tallied here so accounting
		// survives a budget expiry mid-candidate (CODEX1: unit_ok must report
		// ACTUAL sends, never the candidate count).
		const tally = { sent: 0 };
		const skip = async (reason: string) => {
			progress.unitsSkipped++;
			await recordEvent(job.id, 'unit_skipped', { userId: u.user_id, reason });
			await updateProgress(job.id, progress);
		};
		const processUser = async (tools: {
			signal: AbortSignal;
			checkpoint: () => void;
			raceRead: <R>(p: Promise<R>) => Promise<R>;
			graceLeftMs: () => number;
		}): Promise<'done' | 'skipped'> => {
			const { signal, checkpoint, raceRead, graceLeftMs } = tools;
			if (u.home_lat == null || u.home_lon == null) {
				await skip('no-home');
				return 'skipped';
			}
			// Side-effect-free read — detachable on deadline.
			const apiKey = await raceRead(getEbirdApiKey(u.user_id));
			if (!apiKey) {
				await skip('no-api-key');
				return 'skipped';
			}
			const notable = await notableNearbyObs(apiKey, u.home_lat, u.home_lon, u.radius_km, 1, {
				signal
			});
			checkpoint();
			if (notable.stale) {
				// NEVER notify from stale data (CODEX1 plan #4): old sightings
				// must not arrive as "just reported". Next scan retries.
				await skip('stale-cache');
				return 'skipped';
			}
			// Side-effect-free reads — detachable on deadline.
			const [seen, sentRows, subRows] = await raceRead(
				Promise.all([
					seenSet(u.user_id),
					query<{ species_code: string; sent_at: string }>(
						`SELECT species_code, sent_at FROM need_alerts_sent WHERE user_id = $1`,
						[u.user_id]
					),
					query<PushSubscriptionRow>(
						`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
						[u.user_id]
					)
				])
			);
			if (subRows.rows.length === 0) {
				// Enabled but no enrolled device (all pruned / never enrolled).
				await skip('no-devices');
				return 'skipped';
			}
			const sentAt = new Map(
				sentRows.rows.map((r) => [r.species_code, new Date(r.sent_at).getTime()])
			);
			const candidates = alertCandidates({
				notable: notable.data as AlertObs[],
				seen,
				sentAt,
				now: new Date(),
				realertDays: u.realert_days,
				home: { lat: u.home_lat, lng: u.home_lon }
			});
			// Devices that answer 404/410 during this user are pruned once in
			// the SETTLEMENT path below (runs even when the user fails —
			// CODEX1: a 410 sibling next to a 500 sibling must not survive to
			// repeat on every retry); dead endpoints are skipped for later
			// candidates within the same scan.
			const goneEndpoints = new Set<string>();
			try {
			for (const c of candidates) {
				// No NEW side effect starts past the deadline. Each push is
				// bounded by the adapter's own timeout (web-push has no
				// AbortSignal), the candidate count is capped, so the send
				// phase is wall-bounded: cap × devices × PUSH_TIMEOUT_MS.
				checkpoint();
				let delivered = 0;
				let lastErr: PushError | null = null;
				// Click lands on the TRIGGERING REPORT (td-78a7b1, Gaylon P1):
				// the closest observation's public eBird checklist. Payload still
				// carries no raw coordinates; Web Push payloads are E2E-encrypted
				// (RFC 8291) and a checklist id is eBird's own public handle.
				// No subId (rare) → the in-app species page as before.
				const clickUrl = c.obs.subId
					? `https://ebird.org/checklist/${encodeURIComponent(c.obs.subId)}`
					: `${origin}/forecast/species?species=${encodeURIComponent(c.speciesCode)}`;
				for (const sub of subRows.rows) {
					if (goneEndpoints.has(sub.endpoint)) continue;
					checkpoint();
					try {
						await sendWebPush(sub, {
							title: c.title,
							body: c.body,
							url: clickUrl,
							tag: `need-${c.speciesCode}`
						});
						delivered++;
					} catch (err) {
						if (err instanceof PushError && err.gone) {
							goneEndpoints.add(sub.endpoint);
						} else if (err instanceof PushError) {
							lastErr = err;
						} else {
							throw err;
						}
					}
				}
				if (delivered === 0) {
					// Nothing reached ANY device: no sent-row (the next scan
					// re-attempts inside the re-alert window's absence).
					if (lastErr) throw lastErr;
					continue; // every endpoint was gone — the no-devices prune below
				}
				// A delivered push MUST record its sent-row (or the next scan
				// re-pings) — never detached; bounded by the SHARED settlement
				// grace (all remaining writes split one window, they don't
				// stack fresh per-write graces — CODEX1). The /alerts history
				// row rides the SAME statement via a writable CTE: once the
				// suppression row exists no later scan would repair a missing
				// history line, so the pair must commit atomically or fail
				// together into the normal retry path (CODEX1 round 2) — and
				// it costs one grace-bounded write, not two.
				await queryTimed(
					`WITH sent AS (
						INSERT INTO need_alerts_sent (user_id, species_code, first_loc_id, first_obs_dt, sub_id, sent_at)
						VALUES ($1, $2, $3, $4, $5, NOW())
						ON CONFLICT (user_id, species_code)
						DO UPDATE SET first_loc_id = $3, first_obs_dt = $4, sub_id = $5, sent_at = NOW()
						RETURNING user_id, species_code
					)
					INSERT INTO need_alert_log (user_id, species_code, title, body, url, reports)
					SELECT user_id, species_code, $6, $7, $8, $9 FROM sent`,
					[
						u.user_id,
						c.speciesCode,
						c.obs.locId,
						c.obs.obsDt,
						c.obs.subId,
						c.title,
						c.body,
						clickUrl,
						JSON.stringify(c.reports)
					],
					graceLeftMs()
				);
				tally.sent++;
			}
			return 'done';
			} finally {
				// Settlement path: prune accumulated dead endpoints even when a
				// candidate/user failed, best-effort within the same shared
				// grace — a prune failure must not mask the real outcome.
				if (goneEndpoints.size > 0) {
					await queryTimed(
						`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = ANY($2)`,
						[u.user_id, [...goneEndpoints]],
						graceLeftMs()
					).catch(() => {});
				}
			}
		};
		try {
			const outcome = await withBudget(processUser, SCAN_USER_BUDGET_MS);
			alertsSent += tally.sent;
			if (outcome === 'done') {
				progress.unitsDone++;
				await recordEvent(job.id, 'unit_ok', { userId: u.user_id, alerts: tally.sent });
			}
		} catch (err) {
			// Sends completed before the failure still count (they happened —
			// and their sent-rows are recorded, so no re-ping next scan).
			alertsSent += tally.sent;
			progress.unitsFailed++;
			const message = sanitizeErrorText(
				err instanceof Error ? err.message : String(err)
			).slice(0, 200);
			progress.lastError = message;
			await recordEvent(job.id, 'unit_failed', {
				userId: u.user_id,
				error: message,
				...(err instanceof ScanBudgetExceeded ? { budget: true, sentBeforeExpiry: tally.sent } : {})
			});
		}
		await updateProgress(job.id, progress);
	}

	const eligible = progress.unitsDone + progress.unitsFailed;
	const summary = {
		usersScanned: users.rows.length,
		alertsSent,
		skipped: progress.unitsSkipped,
		failed: progress.unitsFailed
	};
	// Aggregate rule (CODEX1 plan #5): 100% failure of eligible users must not
	// read as success — take the retry schedule; the retrying row still holds
	// the dedup key, so no successor is scheduled from here (GROK gap list).
	if (eligible > 0 && progress.unitsDone === 0 && attempts < job.max_attempts) {
		await scheduleRetry(
			job.id,
			attempts,
			retryDelayMs(attempts, 'transient'),
			'every eligible user failed',
			summary
		);
		return;
	}
	const adminId = await lowestAdminId();
	const outcome =
		eligible > 0 && progress.unitsDone === 0
			? ({ kind: 'fail', error: 'every eligible user failed', result: summary } as const)
			: ({ kind: 'complete', result: summary } as const);
	await terminalizeAndReschedule(
		job.id,
		attempts,
		outcome,
		scanEnqueueParams(adminId, SCAN_INTERVAL_MS)
	);
}

// ---------------------------------------------------------------------------
// Species enrichment (plan: docs/2026-08-17-species-enrichment-plan.md)
// ---------------------------------------------------------------------------

// AI_STAGE_ENABLED lives in job-policy (pure module) so page actions can
// read it without importing the worker (GROK td-b7d021 nit).
export { AI_STAGE_ENABLED };

/**
 * Extra attempts when the AI returns no similar-species notes despite having
 * been offered candidates. Fires only on empty, so cost scales with the miss
 * rate, not with corpus size.
 */
export const SIMILAR_EMPTY_RETRIES = 2;

export const ENRICH_CHUNK_SIZE = 30;
/** Chunks enqueued per scan pass — bounds hub noise AND queue occupancy. */
export const ENRICH_CHUNKS_PER_SCAN = 8;
/** Wall budget per chunk job: past this, no NEW network side effect starts. */
export const ENRICH_WALL_BUDGET_MS = 10 * 60_000;
/** Politeness between Wikipedia fetches (serial; Wikimedia etiquette + UA). */
const WIKI_POLITENESS_MS = 400;
/** Successor cadence: fast while work remains, daily once drained. */
export const ENRICH_SCAN_DRAIN_MS = 15 * 60_000;
export const ENRICH_SCAN_IDLE_MS = 24 * 60 * 60_000;

/**
 * Field-guide sample media (td-86a2b6). Smaller chunk than wiki enrichment
 * (30) because each species hits TWO external APIs (Commons + xeno-canto).
 */
export const MEDIA_CHUNK_SIZE = 20;
/** Wall budget per media chunk job: past this, no NEW network side effect starts. */
export const MEDIA_WALL_BUDGET_MS = 8 * 60_000;
/** Politeness between species (serial; two external APIs per unit). */
const MEDIA_POLITENESS_MS = 500;

interface EnrichPayload {
	codes: string[];
	force?: boolean;
	/**
	 * AI-only chunk: reads STORED prose, never touches WDQS or Wikipedia —
	 * the durable retry/backfill primitive for the AI stage (CODEX1 Phase-2
	 * P1 #2). Error rows are always due here (the job exists because they
	 * failed); bounded by the row's own max_attempts.
	 */
	aiOnly?: boolean;
}

interface MediaEnrichPayload {
	codes: string[];
	force?: boolean;
}

function enrichScanParams(adminId: number, runAfterMs: number) {
	return {
		type: 'scan_enrichment' as const,
		payload: {},
		dedupKey: dedupKeys.scanEnrichment(),
		requestedBy: adminId,
		label: 'daily',
		runAfterMs
	};
}

/** Chain reconciliation — worker startup + idle tick, beside the alert scan. */
export async function ensureEnrichmentScan(): Promise<void> {
	if (await hasActiveJob(dedupKeys.scanEnrichment())) return;
	const adminId = await lowestAdminId();
	await enqueueJob(enrichScanParams(adminId, 10_000));
}

/**
 * Admin "impatient nudge" (Gaylon 2026-08-17): pull the pending scan's
 * next_retry_at to NOW so a pass runs immediately — useful right after new
 * hotspot loads put fresh species in scope, instead of waiting out the
 * idle 24h cadence (the exact gap the Phase-2 deploy exposed). If no
 * pending scan exists (lost chain edge), enqueue one. A RUNNING scan is
 * left alone — its successor will chain normally.
 */
export interface EnrichmentWorkSummary {
	candidates: number;
	wikiCandidates: number;
	aiCandidates: number;
	mediaCandidates: number;
	chunksEnqueued: number;
	deduped: number;
	remaining: number;
}

/**
 * One scan PASS: compute the due work (partitioned wiki vs AI-only causes)
 * and enqueue bounded chunks. Shared by the recurring scan AND the admin
 * nudge — the nudge enqueues work DIRECTLY rather than manipulating scan
 * timers, so it is deterministic regardless of scan state (CODEX1: a
 * running scan's successor delay comes from a stale snapshot; racing it
 * with timer writes recreates the deploy gap). Content-hash dedup makes
 * concurrent passes collision-safe: identical chunks dedup, never double.
 */
async function enqueueEnrichmentChunks(
	adminId: number,
	maxChunks: number,
	opts: { retryRecentMediaFailures?: boolean } = {}
): Promise<EnrichmentWorkSummary> {
	// Partitioned causes (CODEX1 Phase-2 P1 #2): wiki work goes through
	// the full pipeline; AI-only work (wiki current, AI due) becomes
	// aiOnly chunks that never touch WDQS/Wikipedia.
	const [missing, wikiStale] = [await enrichmentScope(), await wikiStaleCodes()];
	const wikiWork = [...new Set([...missing, ...wikiStale])].sort();
	const wikiSet = new Set(wikiWork);
	const aiWork = AI_STAGE_ENABLED
		? (await aiDueCodes()).filter((c) => !wikiSet.has(c)).sort()
		: [];
	let enqueued = 0;
	let deduped = 0;
	// Represented CODES, not chunk-count × max-size — partial chunks made
	// the old arithmetic lie across mixed partitions (CODEX1).
	let covered = 0;
	for (let i = 0; i < wikiWork.length && enqueued < maxChunks; i += ENRICH_CHUNK_SIZE) {
		const codes = wikiWork.slice(i, i + ENRICH_CHUNK_SIZE);
		const r = await enqueueJob({
			type: 'enrich_species',
			payload: { codes } satisfies EnrichPayload as unknown as Record<string, unknown>,
			dedupKey: dedupKeys.enrichChunk(codes),
			requestedBy: adminId,
			label: `${codes.length} species`
		});
		if (r.deduped) deduped++;
		else enqueued++;
		covered += codes.length;
	}
	for (let i = 0; i < aiWork.length && enqueued < maxChunks; i += ENRICH_CHUNK_SIZE) {
		const codes = aiWork.slice(i, i + ENRICH_CHUNK_SIZE);
		const r = await enqueueJob({
			type: 'enrich_species',
			payload: { codes, aiOnly: true } satisfies EnrichPayload as unknown as Record<
				string,
				unknown
			>,
			dedupKey: dedupKeys.enrichAiChunk(codes),
			requestedBy: adminId,
			label: `${codes.length} species (AI)`
		});
		if (r.deduped) deduped++;
		else enqueued++;
		covered += codes.length;
	}
	// Media partition (td-86a2b6): separate from wiki/AI — a media failure
	// never blocks or is blocked by prose/annotation work. Do not subtract
	// wikiWork here: enrich_species does not repair media, and a species can
	// legitimately need both independent jobs in the same scan.
	const mediaWork = (
		await mediaDueCodes({ includeRecentFailures: opts.retryRecentMediaFailures === true })
	)
		.sort();
	for (let i = 0; i < mediaWork.length && enqueued < maxChunks; i += MEDIA_CHUNK_SIZE) {
		const codes = mediaWork.slice(i, i + MEDIA_CHUNK_SIZE);
		const r = await enqueueJob({
			type: 'enrich_species_media',
			payload: {
				codes,
				...(opts.retryRecentMediaFailures ? { force: true } : {})
			} satisfies MediaEnrichPayload as unknown as Record<string, unknown>,
			dedupKey: opts.retryRecentMediaFailures
				? dedupKeys.enrichMediaForceChunk(codes)
				: dedupKeys.enrichMediaChunk(codes),
			requestedBy: adminId,
			label: `${codes.length} species media`
		});
		if (r.deduped) deduped++;
		else enqueued++;
		covered += codes.length;
	}
	const total = wikiWork.length + aiWork.length + mediaWork.length;
	return {
		candidates: total,
		wikiCandidates: wikiWork.length,
		aiCandidates: aiWork.length,
		mediaCandidates: mediaWork.length,
		chunksEnqueued: enqueued,
		deduped,
		remaining: Math.max(0, total - covered)
	};
}

/**
 * Admin "impatient nudge": run a scan pass NOW, synchronously — all
 * currently-due work is enqueued when this returns, independent of any
 * pending/running scan (their enqueues dedup against ours). Also pulls a
 * pending scan's timer forward so the drain cadence keeps chewing any
 * remainder past the per-pass chunk cap.
 */
export async function nudgeEnrichmentScan(): Promise<EnrichmentWorkSummary> {
	const adminId = await lowestAdminId();
	// UNCAPPED (CODEX1): an explicit admin nudge enqueues ALL currently-due
	// work before returning — no remainder to race a stale running scan's
	// 24h successor. The per-pass cap protects the recurring cadence only.
	// An explicit admin scan is also an explicit retry request: include media
	// rows currently marked error even when their normal 24-hour retry clock
	// has not elapsed. The unattended recurring scan retains that backoff.
	const summary = await enqueueEnrichmentChunks(adminId, Infinity, {
		retryRecentMediaFailures: true
	});
	// Timer pull is purely a cadence assist for the recurring chain.
	await query(
		`UPDATE jobs SET next_retry_at = NOW()
		  WHERE type = 'scan_enrichment' AND status = 'pending'`
	).catch(() => {});
	return summary;
}

/**
 * Recurring singleton: computes what's missing/stale and enqueues BOUNDED
 * enrich_species chunks (CODEX1 #1: heavy work never lives in the recurring
 * job — chunks interleave with user jobs under the single-worker lock).
 * Content-hash dedup per chunk (CODEX1 #2) makes re-enqueues of identical
 * remainders no-ops rather than lost or duplicated work.
 */
async function runScanEnrichment(job: JobRow): Promise<void> {
	const attempts = job.attempts;
	await recordEvent(job.id, 'claimed', { attempt: attempts });
	try {
		const adminId = await lowestAdminId();
		const summary = await enqueueEnrichmentChunks(adminId, ENRICH_CHUNKS_PER_SCAN);
		// Fast cadence while a backlog exists (cold run drains in hours, not
		// days); daily heartbeat once caught up.
		const runAfterMs = summary.candidates > 0 ? ENRICH_SCAN_DRAIN_MS : ENRICH_SCAN_IDLE_MS;
		await terminalizeAndReschedule(
			job.id,
			attempts,
			{ kind: 'complete', result: summary },
			enrichScanParams(adminId, runAfterMs)
		);
	} catch (err) {
		// Scanner transient failure retries the SAME row — never a false
		// success, never a lost chain (idle-tick ensure is the backstop).
		const message = sanitizeErrorText(err instanceof Error ? err.message : String(err)).slice(
			0,
			300
		);
		if (attempts < job.max_attempts) {
			await scheduleRetry(job.id, attempts, retryDelayMs(attempts, 'transient'), message);
		} else {
			await failJob(job.id, attempts, message);
		}
	}
}

/**
 * Shared chunk-lifecycle harness (td-eae0fc): runEnrichSpecies and
 * runEnrichSpeciesMedia hand-copied this ~200-line skeleton — claim event,
 * progress init, per-unit loop (drain/cancel/budget/rate-limit stops), and
 * the terminal ladder (cancel/rate-limit/spillover/failed-retry/complete).
 * Extracted to ONE implementation; each wrapper supplies only the pieces
 * that genuinely differ, as closures over its own local counters: the
 * per-unit work (with its own accounting), the chunk summary, the spillover
 * payload/dedup/label, and the final terminal transition (`finalize` — home
 * for wiki's aiOnly aggregate branch and AI-remediation enqueue, neither of
 * which applies to media or to a wiki row's non-aiOnly path).
 */

/** attempts < max ⇒ scheduleRetry, else failJob — ALWAYS carrying the chunk
 * summary as the `result` column so a terminal row (retry OR fail) still
 * shows what the chunk actually did. (td-eae0fc drift fix: runEnrichSpecies's
 * wiki-rate-limit-exhausted failJob call used to drop `summary` while every
 * other failJob call in both handlers passed it — an oversight, not an
 * intentional distinction; unified here on always passing it.) */
async function retryOrFail(
	job: JobRow,
	attempts: number,
	delayMs: number,
	retryReason: string,
	failReason: string,
	summary?: unknown
): Promise<void> {
	if (attempts < job.max_attempts) {
		await scheduleRetry(job.id, attempts, delayMs, retryReason, summary);
	} else {
		await failJob(job.id, attempts, failReason, summary);
	}
}

/**
 * Generic "any attempted unit failed ⇒ retry the whole row" aggregate used
 * by media and by a wiki row's non-aiOnly path (CODEX1 P1 #2): failures are
 * naturally narrowed on the next attempt because successes freshness-skip.
 * Exhaustion fails honestly with whatever was persisted. Zero failures runs
 * `onSuccess` (wiki's AI-remediation enqueue) before completing.
 */
async function completeChunk(
	job: JobRow,
	attempts: number,
	failedCount: number,
	unitLabel: string,
	summary: unknown,
	onSuccess?: () => Promise<void>
): Promise<void> {
	if (failedCount > 0) {
		await retryOrFail(
			job,
			attempts,
			retryDelayMs(attempts, 'transient'),
			`${failedCount} ${unitLabel} failed transiently`,
			`${failedCount} ${unitLabel} failed after ${attempts} attempts`,
			summary
		);
		return;
	}
	if (onSuccess) await onSuccess();
	await completeJob(job.id, attempts, summary);
}

/** Claim event + initial JobProgress + heartbeat write — identical across
 * every chunk-based enrichment worker. */
async function claimChunk(
	job: JobRow,
	attempts: number,
	unitsTotal: number
): Promise<JobProgress> {
	await recordEvent(job.id, 'claimed', { attempt: attempts, codes: unitsTotal });
	const progress: JobProgress = {
		phase: 'fetching',
		unitsTotal,
		unitsDone: 0,
		unitsFailed: 0,
		unitsSkipped: 0,
		round: attempts
	};
	await updateProgress(job.id, progress);
	return progress;
}

interface ChunkLifecycleOpts<S> {
	job: JobRow;
	ctx: WorkerContext;
	attempts: number;
	codes: string[];
	wallBudgetMs: number;
	progress: JobProgress;
	/**
	 * Run one unit; the callback owns ALL of its own progress/event
	 * accounting (unit_ok/unit_failed/unit_skipped) exactly as before — the
	 * harness never inspects it. Returning `{ retryAfterMs }` stops the batch
	 * the same way the historic in-loop `break` did: the harness marks
	 * `codes[i..]` as the remainder WITHOUT the trailing updateProgress call
	 * for this unit (that unit never finished, so no extra heartbeat is
	 * owed for it).
	 */
	runUnit: (code: string) => Promise<{ retryAfterMs: number } | void>;
	/** Built once, after the loop settles, with the FINAL remainder. */
	buildSummary: (budgetRemainder: string[]) => S;
	rateLimitReason: string;
	rateLimitExhaustedReason: string;
	/** Called only when the loop stopped with unstarted work remaining. */
	spillover: (remainder: string[]) => Promise<void>;
	/** Owns the final terminal transition on the non-cancel, non-rate-limit
	 * path — typically a `completeChunk` call, or (wiki aiOnly) a wholly
	 * different aggregate ladder. */
	finalize: (summary: S) => Promise<void>;
}

/**
 * The ~200-line skeleton itself: per-unit loop (drain → requeue and return;
 * cancel → break; wall budget → capture remainder and break; per-unit work;
 * rate-limit → capture remainder and break WITHOUT a progress write) then
 * the terminal ladder (cancel → cancelRunningJob; rate-limit → retryOrFail;
 * budget remainder → spillover; else → wrapper-supplied `finalize`).
 */
async function runChunkLifecycle<S>(opts: ChunkLifecycleOpts<S>): Promise<void> {
	const { job, ctx, attempts, codes, wallBudgetMs, progress } = opts;
	const startedAt = Date.now();
	let cancelSeen = false;
	let rateLimit: { retryAfterMs: number } | null = null;
	let budgetRemainder: string[] = [];

	for (let i = 0; i < codes.length; i++) {
		if (ctx.isDraining()) {
			await requeueInterrupted(job.id, attempts);
			return;
		}
		if (cancelSeen) break;
		// Wall budget (CODEX1 #1): never START a new unit past the budget —
		// the remainder becomes a fresh content-hashed chunk so this job ends
		// promptly and user jobs interleave.
		if (Date.now() - startedAt > wallBudgetMs) {
			budgetRemainder = codes.slice(i);
			break;
		}
		const outcome = await opts.runUnit(codes[i]);
		if (outcome?.retryAfterMs != null) {
			rateLimit = { retryAfterMs: outcome.retryAfterMs };
			budgetRemainder = codes.slice(i);
			break;
		}
		const { cancelRequested } = await updateProgress(job.id, progress);
		if (cancelRequested) cancelSeen = true;
	}

	const summary = opts.buildSummary(budgetRemainder);

	if (cancelSeen) {
		await cancelRunningJob(job.id, attempts, summary);
		return;
	}
	if (rateLimit) {
		await retryOrFail(
			job,
			attempts,
			rateLimit.retryAfterMs,
			opts.rateLimitReason,
			opts.rateLimitExhaustedReason,
			summary
		);
		return;
	}
	if (budgetRemainder.length > 0) {
		await opts.spillover(budgetRemainder);
	}
	await opts.finalize(summary);
}

/**
 * One bounded chunk (≤30 species): SPARQL batch resolution, then serial
 * polite Wikipedia fetches. Per-species freshness makes overlapping chunks
 * idempotent; `force` bypasses freshness EXCEPT for rows already refreshed
 * since this job row was enqueued (so a retry never redoes force successes).
 */
async function runEnrichSpecies(job: JobRow, ctx: WorkerContext): Promise<void> {
	const attempts = job.attempts;
	const payload = job.payload as unknown as EnrichPayload;
	const codes = [...new Set(payload.codes ?? [])];
	const force = payload.force === true;
	const aiOnly = payload.aiOnly === true;
	// Hard ≤ chunk-size cap (CODEX1 P2 #5): larger payloads violate the
	// queue-fairness bound (and >50 would poison-loop on the SPARQL batch
	// limit) — terminal, not retryable.
	if (codes.length === 0 || codes.length > ENRICH_CHUNK_SIZE || !codes.every(validSpeciesCode)) {
		await failJob(job.id, attempts, 'invalid enrich_species payload');
		return;
	}
	const progress = await claimChunk(job, attempts, codes.length);

	// Resolution stage: ONE batched SPARQL request refreshes facts for the
	// whole chunk. Nothing has been attempted per-unit yet, so a transient
	// failure retries the whole row. aiOnly chunks SKIP this entirely —
	// stored-prose annotation must not be hostage to WDQS availability.
	let resolved: Map<string, WikidataSpeciesRow> = new Map();
	if (!aiOnly)
		try {
			resolved = await fetchWikidataBatch(codes);
			// Sci-name fallback (td-e64d93): codes with no P3444 anywhere —
			// eBird split survivors like gubter2 — get one more chance via the
			// stable binomial (P225). SOFT failure policy: the primary data is
			// already in hand, so a fallback error must not fail or retry the
			// whole chunk; unresolved codes simply stay no_mapping and the
			// next pass tries again.
			const missing = codes.filter((c) => !resolved.has(c));
			if (missing.length > 0) {
				try {
					const sci = await query<{ species_code: string; sci_name: string }>(
						`SELECT species_code, sci_name FROM taxonomy_cache
						  WHERE species_code = ANY($1)`,
						[missing]
					);
					const fallback = await fetchWikidataBySciName(
						sci.rows.map((r) => ({ code: r.species_code, sciName: r.sci_name }))
					);
					for (const [code, row] of fallback) {
						resolved.set(code, row);
						await recordEvent(job.id, 'unit_ok', {
							code,
							kind: 'sci_name_fallback',
							qid: row.qid
						});
					}
				} catch {
					// Soft: see above. WDQS transient/rate-limit on the fallback
					// leaves the primary results fully usable.
				}
			}
		} catch (err) {
			const message = sanitizeErrorText(err instanceof Error ? err.message : String(err)).slice(
				0,
				300
			);
			const delayMs =
				err instanceof WikidataError && err.rateLimited
					? (err.retryAfterMs ?? RATE_LIMIT_RETRY_DELAY_MS)
					: retryDelayMs(attempts, 'transient');
			await retryOrFail(job, attempts, delayMs, message, message, undefined);
			return;
		}

	// Taxonomy names for the AI prompt AND the sci-name sitelink fallback —
	// one query for the whole chunk, needed regardless of the AI flag.
	const taxa = new Map<string, { com_name: string; sci_name: string; family: string | null }>();
	{
		const t = await query<{
			species_code: string;
			com_name: string;
			sci_name: string;
			family: string | null;
		}>(
			`SELECT species_code, com_name, sci_name, family
			   FROM taxonomy_cache WHERE species_code = ANY($1)`,
			[codes]
		);
		for (const r of t.rows) taxa.set(r.species_code, r);
	}

	const counts = { ok: 0, noArticle: 0, noMapping: 0, noSitelink: 0, fresh: 0, aiOk: 0 };
	const failed: string[] = [];
	const aiFailed: string[] = [];
	/** AI-due codes never attempted (rate-limit stop / skipped-under-flag) —
	 * remediated by a narrowed aiOnly chunk, never silently left to cadence. */
	const aiPending: string[] = [];
	let aiRateLimited = false;
	let aiRetryAfterMs: number | null = null;

	type AiOutcome = 'ok' | 'error' | 'rate_limited' | 'no_taxonomy' | 'disabled';

	/**
	 * AI stage for one species with stored/known prose. Returns a
	 * discriminated outcome — the CALLER accounts truthfully (CODEX1 Phase-2
	 * P1 #1): only 'ok' may become a done unit.
	 */
	const runAiStage = async (
		code: string,
		// The substage fields are OPTIONAL because the just-fetched-article
		// caller has no stored state to pass. Absent means "cannot be fresh",
		// which is correct there: new prose always means new notes.
		prose: {
			extract: string;
			sections: { title: string; text: string }[];
			revId: number;
			aiStatus?: string | null;
			aiSourceRevId?: number | null;
			similarStatus?: string | null;
			similarCandidatesHash?: string | null;
			similarSourceRevId?: number | null;
		}
	): Promise<AiOutcome> => {
		if (!AI_STAGE_ENABLED) return 'disabled';
		const t = taxa.get(code);
		if (!t) {
			// Explicit, not silent (CODEX1 #5) — scope normally excludes these;
			// reaching here means a taxonomy race worth seeing in events.
			await recordEvent(job.id, 'progress', { code, aiSkipped: 'no-taxonomy' });
			return 'no_taxonomy';
		}
		try {
			// Closed candidate set for the similar-species notes (td-8f0ed8).
			// Same set the page renders, by construction — see candidateSet.
			const candidates = await similarCandidatesFor(code, t.sci_name);
			const hash = similarCandidatesHash(candidates.map((c) => c.code));

			// The scanner deliberately over-selects after a taxonomy sync. If
			// the candidate set is actually unchanged and everything else is
			// current, there is nothing to ask the model — re-stamp the clock
			// and skip the call rather than spend it.
			const nothingToDo =
				prose.aiStatus === 'ok' &&
				prose.aiSourceRevId === prose.revId &&
				prose.similarStatus != null &&
				prose.similarStatus !== 'error' &&
				prose.similarCandidatesHash === hash &&
				prose.similarSourceRevId === prose.revId;
			if (nothingToDo) {
				await touchSimilarFresh(code);
				counts.fresh++;
				return 'ok';
			}

			const annotate = () =>
				generateSpeciesAnnotation({
					comName: t.com_name,
					sciName: t.sci_name,
					family: t.family,
					extract: prose.extract,
					sections: prose.sections,
					candidates,
					speciesCode: code
				});

			let ann = await annotate();
			// An empty `similar` when candidates WERE offered is ambiguous: either
			// the model judged none of them worth a note, or it returned nothing
			// usable. Both were observed on identical input, so left alone they are
			// indistinguishable.
			//
			// The retry must never LOSE a good attempt. A first call can succeed
			// (valid tags + field craft, empty similar) and the retry then throw —
			// e.g. on the request timeout — which previously discarded the first
			// result entirely and cost a first-time species its field craft too
			// (GROK P1). Keep the best result seen and let a failing retry fall
			// back to it rather than propagate.
			// Retrying only on a WHOLLY empty result misses the partial case: with
			// three candidates and one note dropped as malformed, `similar` is
			// non-empty and the dropped candidate silently gets nothing. ~2% of
			// live notes were corrupted, so this is not hypothetical. Trigger on
			// "some eBird-slash candidate still has no note" instead — that is the
			// set the schema marks required and the set a birder is owed.
			const owed = () => {
				const have = new Set(ann.similar.map((s) => s.code));
				return candidates
					.filter((c) => c.basis === 'ebird_slash' && !have.has(c.code))
					.map((c) => c.code);
			};
			for (let attempt = 0; attempt < SIMILAR_EMPTY_RETRIES; attempt++) {
				if (candidates.length === 0) break;
				if (ann.similar.length > 0 && owed().length === 0) break;
				await recordEvent(job.id, 'progress', { code, similarEmpty: 'retrying', attempt });
				try {
					const next = await annotate();
					// Keep the new attempt ONLY if it owes strictly fewer notes. On a
					// tie the earlier attempt wins: an equal-count retry can fill a
					// different slash candidate or drop genus notes, so "no worse"
					// is not the same as "no change" and churn is not an improvement
					// (GROK — the previous >-comparison let a tie replace the result
					// while the comment claimed it could not).
					const before = owed().length;
					const prev = ann;
					ann = next;
					if (owed().length >= before) ann = prev;
				} catch (err) {
					// Keep the earlier successful annotation and stop retrying; the
					// species still gets its field craft, and the missing notes are
					// recorded below so the substage retries on its own clock.
					await recordEvent(job.id, 'progress', {
						code,
						similarEmpty: 'retry_failed',
						error: sanitizeErrorText(err instanceof Error ? err.message : String(err)).slice(0, 120)
					});
					break;
				}
			}
			const stillOwed = owed();
			if (candidates.length > 0 && stillOwed.length > 0) {
				// Survived every attempt. Recorded with the OWED CODES, not just a
				// flag: a partial miss leaves real notes on the page, so without
				// this the only breadcrumb was droppedSimilar on the kept attempt.
				// upsertAiData stores this as an ERROR, not 'none' or 'ok', so the
				// 7-day window applies and the good notes are preserved.
				await recordEvent(job.id, 'progress', {
					code,
					similarEmpty: ann.similar.length === 0 ? 'confirmed' : 'partial',
					owed: stillOwed
				});
			}
			await upsertAiData(code, {
				fieldCraft: ann.fieldCraft,
				tags: ann.tags,
				model: AI_MODEL,
				sourceRevId: prose.revId,
				similar: ann.similar,
				similarCandidatesHash: hash,
				candidateCount: candidates.length,
				owedCodes: stillOwed
			});
			counts.aiOk++;
			if (ann.droppedTags.length > 0) {
				// Vocabulary gaps surface in events, never silently (plan rule).
				await recordEvent(job.id, 'progress', { code, droppedTags: ann.droppedTags });
			}
			if (ann.droppedSimilar.length > 0) {
				// Codes outside the closed set — same "never silently" rule.
				await recordEvent(job.id, 'progress', { code, droppedSimilar: ann.droppedSimilar });
			}
			return 'ok';
		} catch (err) {
			if (err instanceof EnrichmentAiError && err.rateLimited) {
				aiRateLimited = true;
				aiRetryAfterMs = err.retryAfterMs;
				await recordEvent(job.id, 'progress', { aiRateLimited: true, from: code });
				return 'rate_limited';
			}
			const message = sanitizeErrorText(err instanceof Error ? err.message : String(err)).slice(
				0,
				200
			);
			await markAiError(code, message).catch(() => {});
			aiFailed.push(code);
			await recordEvent(job.id, 'unit_failed', { code, stage: 'ai', error: message });
			return 'error';
		}
	};

	/** Truthful accounting for an attempted AI stage (CODEX1 Phase-2 P1 #1):
	 * only 'ok' becomes a done unit; errors are failed units; a rate-limit
	 * stop parks the code for the narrowed remediation chunk. */
	const accountAiAttempt = async (aiCode: string, outcome: AiOutcome): Promise<void> => {
		if (outcome === 'ok') {
			progress.unitsDone++;
			await recordEvent(job.id, 'unit_ok', { code: aiCode, outcome: 'ai_only' });
		} else if (outcome === 'error') {
			progress.unitsFailed++; // unit_failed already recorded by runAiStage
		} else if (outcome === 'rate_limited') {
			aiPending.push(aiCode);
			progress.unitsSkipped++;
			await recordEvent(job.id, 'unit_skipped', { code: aiCode, reason: 'ai_rate_limited' });
		} else {
			progress.unitsSkipped++;
			await recordEvent(job.id, 'unit_skipped', { code: aiCode, reason: outcome });
		}
	};

	const runUnit = async (code: string): Promise<{ retryAfterMs: number } | void> => {
		const unitOk = async (outcome: string) => {
			progress.unitsDone++;
			await recordEvent(job.id, 'unit_ok', { code, outcome });
		};

		try {
			if (aiOnly) {
				// AI-only route (CODEX1 Phase-2 P1 #2): stored prose in, no WDQS,
				// no Wikipedia. Error rows are ALWAYS due here — this job exists
				// because they failed; the row's max_attempts bounds retries.
				// STAGE-AWARE failure handling (CODEX1 round 2 P1 #2): an
				// unexpected read/input failure here is an AI-stage failure —
				// it must never reach the outer catch, which would stamp a
				// bogus wiki error and dodge the aiOnly aggregate.
				try {
					if (aiRateLimited) {
						aiPending.push(code);
						progress.unitsSkipped++;
						await recordEvent(job.id, 'unit_skipped', { code, reason: 'ai_rate_limited' });
						} else {
							const ai = await aiStageInputFor(code);
							if (ai == null) {
								progress.unitsSkipped++;
								await recordEvent(job.id, 'unit_skipped', { code, reason: 'no-prose' });
							} else {
								// Presence in an aiOnly payload is the durable due decision. It
								// may have been selected by the legacy AI clock OR solely by the
								// similar-note substage (backfill, error retry, taxonomy sync).
								// Re-applying only the legacy predicates here silently discards
								// the latter. runAiStage's candidate hash is the authoritative
								// cheap no-op check for taxonomy over-selection.
								await accountAiAttempt(code, await runAiStage(code, ai));
							}
						}
				} catch (err) {
					const message = sanitizeErrorText(
						err instanceof Error ? err.message : String(err)
					).slice(0, 200);
					await markAiError(code, message).catch(() => {});
					aiFailed.push(code);
					progress.unitsFailed++;
					progress.lastError = message;
					await recordEvent(job.id, 'unit_failed', { code, stage: 'ai', error: message });
				}
			} else {
			// Skip-if-fresh (idempotent overlap); force skips only rows already
			// refreshed since THIS job row was enqueued (retry ≠ redo).
			const fresh = await query<{
				skip: boolean;
				resolution: string | null;
				wiki_status: string | null;
				retry_due: boolean;
			}>(
				`SELECT (wiki_status IN ('ok','no_article') AND (
				          ($2 = false AND wiki_fetched_at > NOW() - INTERVAL '180 days')
				       OR ($2 = true  AND wiki_fetched_at > $3::timestamptz)
				        )) AS skip,
				        resolution,
				        wiki_status,
				        (wiki_fetched_at < NOW() - INTERVAL '${ERROR_RETRY_DAYS} days')
				          AS retry_due
				   FROM species_enrichment WHERE species_code = $1`,
				[code, force, job.enqueued_at]
			);
			// no_mapping rescue (GROK on 4694222 + CODEX1 anti-loop REJECT):
			// a split survivor sits at resolution='no_mapping' with a "fresh"
			// no_article clock. Two cases must NOT take the fresh-skip:
			// - the fallback resolved it THIS chunk (hit) — run resolution +
			//   wiki on the QID instead of discarding it;
			// - the row is due under the WEEKLY retry lane (miss included) —
			//   the terminal no_mapping path must run so markWikiNoArticle
			//   RESTAMPS the clock. Skipping here left wiki_fetched_at
			//   untouched, wikiStaleCodes kept returning the row, and the
			//   scan's 15-minute drain cadence turned "weekly" into a
			//   quarter-hourly WDQS loop.
			const row0 = fresh.rows[0];
			// no_sitelink joins the weekly lane on retry_due ONLY (GROK pin d):
			// its P3444 batch lookup already succeeded, so a resolved.has()
			// rescue would re-open Wikipedia for every fresh no_sitelink row in
			// every chunk. The sci-name article attempt runs on force, weekly
			// retry_due, or a stale clock — never on a fresh skip.
			const rescued =
				(row0?.resolution === 'no_mapping' &&
					(resolved.has(code) || row0.retry_due === true)) ||
				(row0?.resolution === 'no_sitelink' &&
					row0.wiki_status !== 'ok' &&
					row0.retry_due === true);
			if (row0?.skip === true && !rescued) {
				// Wiki is fresh — but the AI stage may still be missing, behind
				// the stored revision, past its error window, or forced. This is
				// how the whole pre-Phase-2 corpus gets annotated without a
				// single wasted Wikipedia refetch.
				const ai = AI_STAGE_ENABLED ? await aiStageInputFor(code) : null;
				const errorRetryDue =
					ai?.aiStatus === 'error' &&
					(ai.aiAttemptedAt == null ||
						Date.now() - new Date(ai.aiAttemptedAt).getTime() > 7 * 86_400_000);
				// The similar-note substage has its OWN due conditions
				// (td-8f0ed8). Without them the 1,123 species already annotated
				// at the current revision are invisible to this gate and would
				// never generate a note — the schema growing a field is not
				// something a revision-based clock can see.
				const similarErrorRetryDue =
					ai?.similarStatus === 'error' &&
					(ai.similarAttemptedAt == null ||
						Date.now() - new Date(ai.similarAttemptedAt).getTime() > 7 * 86_400_000);
				const similarDue =
					ai != null && (ai.similarStatus == null || similarErrorRetryDue);
				const aiDue =
					ai != null &&
					(force ||
						ai.aiStatus == null ||
						(ai.aiStatus === 'ok' && ai.aiSourceRevId !== ai.revId) ||
						errorRetryDue ||
						similarDue);
				if (aiDue && aiRateLimited) {
					aiPending.push(code);
					progress.unitsSkipped++;
					await recordEvent(job.id, 'unit_skipped', { code, reason: 'ai_rate_limited' });
				} else if (aiDue && ai != null) {
					await accountAiAttempt(code, await runAiStage(code, ai));
				} else {
					counts.fresh++;
					progress.unitsSkipped++;
					await recordEvent(job.id, 'unit_skipped', { code, reason: 'fresh' });
				}
			} else {
				const row = resolved.get(code) ?? null;
				await upsertResolution(code, row);
				if (row == null) {
					// Terminal data state — stamp the freshness clock via the
					// no_article path or the scanner re-enqueues this code every
					// pass forever (CODEX1 P1 #1). `resolution` keeps the
					// no_mapping/no_article distinction for the UI.
					await markWikiNoArticle(code);
					counts.noMapping++;
					await unitOk('no_mapping');
				} else {
					// Sitelink when Wikidata has one, else the binomial redirect
					// (shared helper — same decision as enrichOneNow, GROK pin d).
					const target = wikiFetchTitleFor(row, taxa.get(code)?.sci_name ?? null);
					if (target == null) {
						// No sitelink and no usable binomial — terminal; restamp
						// the clock or the weekly lane re-enqueues it forever.
						await markWikiNoArticle(code);
						counts.noSitelink++;
						await unitOk('no_sitelink');
					} else {
					// Politeness gap before every Wikipedia hit (serial batch).
					await new Promise((r) => setTimeout(r, WIKI_POLITENESS_MS));
					try {
						const article = await fetchArticlePlaintext(target.title);
						if (article == null) {
							await markWikiNoArticle(code);
							if (target.viaFallback) {
								// Fallback MISS keeps the no_sitelink resolution and
								// the weekly retry lane (restamped just above).
								counts.noSitelink++;
								await unitOk('no_sitelink');
							} else {
								counts.noArticle++;
								await unitOk('no_article');
							}
						} else {
							await upsertWikiOk(code, article);
							// Wiki success is the unit's anchor; a failed AI stage is
							// recorded in aiFailed and remediated by a narrowed
							// aiOnly chunk at completion — never silently green.
							if (aiRateLimited) {
								aiPending.push(code);
							} else {
								const aiOut = await runAiStage(code, {
									extract: article.extract,
									sections: article.sections,
									revId: article.revId
								});
								if (aiOut === 'rate_limited') aiPending.push(code);
							}
							counts.ok++;
							await unitOk('ok');
						}
					} catch (err) {
						if (err instanceof WikipediaError && err.rateLimited) {
							// Stop the batch — remaining units keep their state and
							// the whole row retries after the server's Retry-After
							// when it sent one (CODEX1 P2 #6).
							return { retryAfterMs: err.retryAfterMs ?? RATE_LIMIT_RETRY_DELAY_MS };
						}
						throw err;
					}
					}
				}
			}
			}
		} catch (err) {
			const message = sanitizeErrorText(err instanceof Error ? err.message : String(err)).slice(
				0,
				200
			);
			await markWikiError(code, message).catch(() => {});
			failed.push(code);
			progress.unitsFailed++;
			progress.lastError = message;
			await recordEvent(job.id, 'unit_failed', { code, error: message });
		}
	};

	await runChunkLifecycle({
		job,
		ctx,
		attempts,
		codes,
		wallBudgetMs: ENRICH_WALL_BUDGET_MS,
		progress,
		runUnit,
		buildSummary: (budgetRemainder) => ({
			...counts,
			failed,
			aiFailed,
			aiPending,
			aiRateLimited,
			remainder: budgetRemainder.length
		}),
		rateLimitReason: 'wikipedia rate limit',
		rateLimitExhaustedReason: 'wikipedia rate limit — retries exhausted',
		spillover: async (remainder) => {
			// Spill the un-started remainder into its own chunk; this job then
			// completes honestly with what it actually did. The spill PRESERVES
			// the route (CODEX1 round 2 P1 #1): an aiOnly remainder stays aiOnly
			// in its own dedup namespace — never demoted to a wiki chunk.
			await enqueueJob({
				type: 'enrich_species',
				payload: {
					codes: remainder,
					...(force ? { force } : {}),
					...(aiOnly ? { aiOnly } : {})
				},
				dedupKey: aiOnly ? dedupKeys.enrichAiChunk(remainder) : dedupKeys.enrichChunk(remainder),
				requestedBy: job.requested_by,
				label: `${remainder.length} species (spillover${aiOnly ? ', AI' : ''})`
			});
			await recordEvent(job.id, 'progress', { spillover: remainder.length, aiOnly });
		},
		finalize: async (summary) => {
			// aiOnly aggregate (CODEX1 Phase-2 P1 #1): AI work IS this job's
			// work — failures retry the row (errors are always due on the next
			// attempt) and exhaustion fails honestly; a 429 stop retries after
			// the server's Retry-After. Never a green complete over an
			// unannotated chunk. This branch — and the AI-remediation enqueue
			// below it — are genuinely wiki-only, so they live in this
			// wrapper's `finalize` rather than the shared harness (td-eae0fc).
			if (aiOnly) {
				if (aiRateLimited) {
					await retryOrFail(
						job,
						attempts,
						aiRetryAfterMs ?? RATE_LIMIT_RETRY_DELAY_MS,
						'AI rate limit',
						'AI rate limit — retries exhausted',
						summary
					);
					return;
				}
				// aiFailed is the expected bucket; `failed` is belt-and-braces
				// (the stage-aware catch should make it unreachable in aiOnly)
				// — either way, failures never complete green (CODEX1 round 2
				// P1 #2).
				const aiOnlyFailures = aiFailed.length + failed.length;
				if (aiOnlyFailures > 0) {
					await retryOrFail(
						job,
						attempts,
						retryDelayMs(attempts, 'transient'),
						`${aiOnlyFailures} AI annotations failed`,
						`${aiOnlyFailures} AI annotations failed after ${attempts} attempts`,
						summary
					);
					return;
				}
				await completeJob(job.id, attempts, summary);
				return;
			}

			// Aggregate rule (CODEX1 P1 #2): ANY transient unit failure retries
			// the row — the retry is NATURALLY narrowed to the failed codes
			// because successes are freshness-skipped on the next attempt
			// (error rows are not "fresh", so only they re-run; force
			// successes are covered by the refreshed-since-enqueue check).
			// Exhaustion fails honestly — persisted per-species data stays,
			// but the job never reads green with holes. Wiki work succeeded →
			// AI holes get a DURABLE narrowed remediation chunk (CODEX1
			// Phase-2 P1 #1/#2/P2 #3) before the job completes honestly.
			await completeChunk(job, attempts, failed.length, 'species', summary, async () => {
				const remediation = [...new Set([...aiFailed, ...aiPending])].sort();
				if (remediation.length > 0) {
					await enqueueJob({
						type: 'enrich_species',
						payload: {
							codes: remediation,
							aiOnly: true
						} satisfies EnrichPayload as unknown as Record<string, unknown>,
						dedupKey: dedupKeys.enrichAiChunk(remediation),
						requestedBy: job.requested_by,
						label: `${remediation.length} species (AI remediation)`,
						runAfterMs: aiRateLimited ? (aiRetryAfterMs ?? RATE_LIMIT_RETRY_DELAY_MS) : 0
					});
					await recordEvent(job.id, 'progress', { aiRemediation: remediation.length });
				}
			});
		}
	});
}

// ---------------------------------------------------------------------------
// Field-guide sample media (plan: docs/2026-08-23-field-guide-sample-media-
// CLAUDE.md §7). Uses the shared chunk-lifecycle harness above; its wrapper
// retains media-specific freshness, provider calls, spillover, and summary
// accounting. Two external APIs per species (Commons + xeno-canto), so the
// chunk is smaller and the politeness gap wider than wiki enrichment.
// ---------------------------------------------------------------------------
/**
 * One bounded chunk (≤20 species): resolves each code's stored QID + sci
 * name, then serially runs enrichSpeciesMedia with a politeness gap. Per-
 * species freshness makes overlapping chunks idempotent; `force` bypasses it
 * (the species-page refresh action always forces a single-code job).
 */
async function runEnrichSpeciesMedia(job: JobRow, ctx: WorkerContext): Promise<void> {
	const attempts = job.attempts;
	const payload = job.payload as unknown as MediaEnrichPayload;
	const codes = [...new Set(payload.codes ?? [])];
	const force = payload.force === true;
	// Hard ≤ chunk-size cap (mirrors runEnrichSpecies's ENRICH_CHUNK_SIZE
	// guard) — terminal, not retryable.
	if (codes.length === 0 || codes.length > MEDIA_CHUNK_SIZE || !codes.every(validSpeciesCode)) {
		await failJob(job.id, attempts, 'invalid enrich_species_media payload');
		return;
	}
	const progress = await claimChunk(job, attempts, codes.length);

	// Pre-load QIDs + sci names for the whole chunk (two batch SELECTs) —
	// media needs both and neither changes mid-chunk.
	const qids = new Map<string, string>();
	{
		const r = await query<{ species_code: string; wikidata_qid: string | null }>(
			`SELECT species_code, wikidata_qid FROM species_enrichment WHERE species_code = ANY($1)`,
			[codes]
		);
		for (const row of r.rows) if (row.wikidata_qid) qids.set(row.species_code, row.wikidata_qid);
	}
	const sciNames = new Map<string, string>();
	{
		const r = await query<{ species_code: string; sci_name: string }>(
			`SELECT species_code, sci_name FROM taxonomy_cache WHERE species_code = ANY($1)`,
			[codes]
		);
		for (const row of r.rows) sciNames.set(row.species_code, row.sci_name);
	}

	const counts = { ok: 0, partial: 0, noMedia: 0, fresh: 0 };
	const failed: string[] = [];
	let attemptedAny = false;

	const skipUnit = async (code: string, reason: string) => {
		progress.unitsSkipped++;
		await recordEvent(job.id, 'unit_skipped', { code, reason });
	};

	const runUnit = async (code: string): Promise<{ retryAfterMs: number } | void> => {
		const qid = qids.get(code);
		const sciName = sciNames.get(code);
		try {
			if (!qid) {
				await skipUnit(code, 'no-qid');
			} else if (!sciName) {
				await skipUnit(code, 'no-sci-name');
			} else if (!force && (await mediaFresh(code))) {
				counts.fresh++;
				await skipUnit(code, 'fresh');
			} else {
				if (attemptedAny) await new Promise((r) => setTimeout(r, MEDIA_POLITENESS_MS));
				attemptedAny = true;
				const outcome = await enrichSpeciesMedia(code, qid, sciName);
				if (outcome === 'ok') counts.ok++;
				else if (outcome === 'partial') counts.partial++;
				else counts.noMedia++;
				progress.unitsDone++;
				await recordEvent(job.id, 'unit_ok', { code, outcome });
			}
		} catch (err) {
			// Structural check — covers CommonsError, WikidataError, and
			// XenoCantoError today, plus any future provider error carrying the
			// shared {rateLimited, retryAfterMs} provider-error shape.
			if (isRateLimitedError(err)) {
				return { retryAfterMs: err.retryAfterMs ?? RATE_LIMIT_RETRY_DELAY_MS };
			}
			const message = sanitizeErrorText(err instanceof Error ? err.message : String(err)).slice(
				0,
				200
			);
			await markMediaError(code, message).catch(() => {});
			failed.push(code);
			progress.unitsFailed++;
			progress.lastError = message;
			await recordEvent(job.id, 'unit_failed', { code, error: message });
		}
	};

	await runChunkLifecycle({
		job,
		ctx,
		attempts,
		codes,
		wallBudgetMs: MEDIA_WALL_BUDGET_MS,
		progress,
		runUnit,
		buildSummary: (budgetRemainder) => ({ ...counts, failed, remainder: budgetRemainder.length }),
		rateLimitReason: 'media provider rate limit',
		rateLimitExhaustedReason: 'media provider rate limit — retries exhausted',
		spillover: async (remainder) => {
			await enqueueJob({
				type: 'enrich_species_media',
				payload: {
					codes: remainder,
					...(force ? { force } : {})
				} satisfies MediaEnrichPayload as unknown as Record<string, unknown>,
				dedupKey: force
					? dedupKeys.enrichMediaForceChunk(remainder)
					: dedupKeys.enrichMediaChunk(remainder),
				requestedBy: job.requested_by,
				label: `${remainder.length} species media (spillover)`
			});
			await recordEvent(job.id, 'progress', { spillover: remainder.length });
		},
		// ANY transient unit failure retries the row — naturally narrowed to
		// the failed codes next attempt (error rows are not "fresh",
		// successes are).
		finalize: (summary) => completeChunk(job, attempts, failed.length, 'species media', summary)
	});
}

/** Dispatch a claimed job. Never throws — failures become failJob. */
export async function runJob(job: JobRow, ctx: WorkerContext): Promise<void> {
	try {
		switch (job.type) {
			case 'load_hotspots':
			case 'load_region':
			case 'refresh_loc':
			case 'retry_loc': {
				const { locs, force, base, allCodes } = frequencyLocs(job);
				await runFrequencyJob(job, locs, force, ctx, {
					base,
					// On a budget yield the payload narrows to the remainder;
					// base carries the original total + banked completions, and
					// allCodes pins the ORIGINAL coverage for the UI's
					// covered/queued flags (GROK P1 #2 — this claim's locs ARE
					// the original set on the first yield).
					remainderPayload: (remaining, newBase) => ({
						locs: remaining,
						force,
						base: newBase,
						allCodes: allCodes ?? locs.map((l) => l.code)
					})
				});
				return;
			}
			case 'analyze_counties': {
				const locs = await analyzeCountiesLocs(job);
				if (locs.length === 0) {
					await completeJob(job.id, job.attempts, {
						ready: (job.payload as unknown as AnalyzeCountiesPayload).counties.length,
						refreshed: 0,
						failed: [],
						notAttempted: 0,
						credentialProblem: null,
						rateLimited: false
					});
					return;
				}
				// No remainderPayload: analyzeCountiesLocs re-derives what is
				// still uncovered at every claim, so a yielded job resumes with
				// its payload untouched. The base is derived the same way — the
				// ORIGINAL county snapshot is the total, and whatever the claim
				// found already covered counts as done, so the bar keeps
				// narrating N of TOTAL across yields instead of jumping back to
				// 0 of remaining (CODEX1 #3 on afb305d).
				const total = (job.payload as unknown as AnalyzeCountiesPayload).counties.length;
				await runFrequencyJob(job, locs, false, ctx, {
					base: { total, done: total - locs.length }
				});
				return;
			}
			case 'sync_lifelist': {
				await runSyncJob(job, async () => {
					const heartbeat = async () => {
						const { cancelRequested } = await updateProgress(job.id, {
							phase: 'fetching',
							unitsTotal: 1,
							unitsDone: 0,
							unitsFailed: 0,
							unitsSkipped: 0,
							round: job.attempts
						});
						return { cancel: cancelRequested };
					};
					const r = await syncLifeListFromEbird(job.requested_by, { heartbeat });
					return {
						total: r.total,
						matched: r.matched,
						unmatchedCount: r.unmatched.length,
						unmatched: r.unmatched.slice(0, 10),
						// Life-list map loc resolution (td-b5986c): full disclosure
						// of the capped/fail-soft pass in the job record.
						...(r.locs ? { locs: r.locs } : {})
					};
				});
				return;
			}
			case 'scan_need_alerts': {
				await runNeedAlertScan(job);
				return;
			}
			case 'scan_enrichment': {
				await runScanEnrichment(job);
				return;
			}
			case 'enrich_species': {
				await runEnrichSpecies(job, ctx);
				return;
			}
			case 'enrich_species_media': {
				await runEnrichSpeciesMedia(job, ctx);
				return;
			}
			case 'sync_taxonomy': {
				await runSyncJob(job, async () => {
					const apiKey = await getEbirdApiKey(job.requested_by);
					if (!apiKey) {
						throw new EbirdLoginError('An eBird API key is required — add one in Settings.');
					}
					const taxa = await syncTaxonomy(apiKey);
					const rematch = await rematchPhotoLinks();
					return { taxa, photosMatched: rematch.matched, photosUnmatched: rematch.unmatched };
				});
				return;
			}
			default:
				await failJob(job.id, job.attempts, `no handler for job type "${job.type}"`);
				return;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await failJob(job.id, job.attempts, sanitizeErrorText(message).slice(0, 300));
	}
}
