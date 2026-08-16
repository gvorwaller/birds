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
	updateProgress
} from '$server/jobs';
import {
	jobOutcome,
	RATE_LIMIT_RETRY_DELAY_MS,
	retryDelayMs,
	sanitizeErrorText,
	type JobProgress,
	type JobRow
} from '$server/job-policy';

export interface WorkerContext {
	/** True once SIGTERM/SIGINT received — jobs wind down and requeue. */
	isDraining: () => boolean;
}

interface FrequencyPayload {
	locs: LocToEnsure[];
	force?: boolean;
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
 * Shared frequency-load runner. Drives ensureFrequencies over the WHOLE
 * target set (maxFetches/timeBudget Infinity) with per-unit events, progress
 * heartbeats, cooperative cancel, and drain requeue — one termination path
 * per cause (GROK #6).
 */
async function runFrequencyJob(
	job: JobRow,
	locs: LocToEnsure[],
	force: boolean,
	ctx: WorkerContext
): Promise<void> {
	const attempts = job.attempts;
	let cancelSeen = false;
	let stopCause: Exclude<StopSignal, 'no'> | null = null;

	const progress: JobProgress = {
		phase: 'fetching',
		unitsTotal: locs.length,
		unitsDone: 0,
		unitsFailed: 0,
		unitsSkipped: 0,
		round: attempts
	};
	await recordEvent(job.id, 'claimed', { attempt: attempts, units: locs.length });
	await updateProgress(job.id, progress);

	const shouldStop = async (): Promise<StopSignal> => {
		if (cancelSeen) return (stopCause = 'cancel');
		if (ctx.isDraining()) return (stopCause = 'drain');
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

function frequencyLocs(job: JobRow): { locs: LocToEnsure[]; force: boolean } {
	const p = job.payload as unknown as FrequencyPayload;
	if (!Array.isArray(p?.locs) || p.locs.length === 0) {
		throw new Error('frequency job payload has no locs');
	}
	return { locs: p.locs, force: p.force === true };
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
				// Absolute URL (CODEX1 Rev-2 addendum #1) — species only,
				// never coordinates, private or not.
				const clickUrl = `${origin}/forecast/species?species=${encodeURIComponent(c.speciesCode)}`;
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
					INSERT INTO need_alert_log (user_id, species_code, title, body, url)
					SELECT user_id, species_code, $6, $7, $8 FROM sent`,
					[
						u.user_id,
						c.speciesCode,
						c.obs.locId,
						c.obs.obsDt,
						c.obs.subId,
						c.title,
						c.body,
						clickUrl
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

/** Dispatch a claimed job. Never throws — failures become failJob. */
export async function runJob(job: JobRow, ctx: WorkerContext): Promise<void> {
	try {
		switch (job.type) {
			case 'load_hotspots':
			case 'load_region':
			case 'refresh_loc':
			case 'retry_loc': {
				const { locs, force } = frequencyLocs(job);
				await runFrequencyJob(job, locs, force, ctx);
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
				await runFrequencyJob(job, locs, false, ctx);
				return;
			}
			case 'sync_lifelist': {
				await runSyncJob(job, async () => {
					const r = await syncLifeListFromEbird(job.requested_by);
					return {
						total: r.total,
						matched: r.matched,
						unmatchedCount: r.unmatched.length,
						unmatched: r.unmatched.slice(0, 10)
					};
				});
				return;
			}
			case 'scan_need_alerts': {
				await runNeedAlertScan(job);
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
