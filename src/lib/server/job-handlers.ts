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
import { getEbirdApiKey, syncTaxonomy } from '$server/ebird';
import { syncLifeListFromEbird, EbirdLoginError } from '$server/ebird-account';
import { rematchPhotoLinks } from '$server/gallery';
import {
	cancelRunningJob,
	completeJob,
	failJob,
	recordEvent,
	requeueInterrupted,
	scheduleRetry,
	updateProgress
} from '$server/jobs';
import {
	jobOutcome,
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
		if (err instanceof EbirdLoginError) {
			await failJob(job.id, attempts, message);
			return;
		}
		if (attempts < job.max_attempts) {
			await scheduleRetry(job.id, attempts, retryDelayMs(attempts, 'transient'), message);
			return;
		}
		await failJob(job.id, attempts, message);
	}
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
