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
import {
	cancelRunningJob,
	completeJob,
	failJob,
	recordEvent,
	requeueInterrupted,
	scheduleRetry,
	updateProgress
} from '$server/jobs';
import { jobOutcome, type JobProgress, type JobRow } from '$server/job-policy';

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

/** Summarize an EnsureResult for the jobs.result column (compact, no secrets). */
function summarize(r: EnsureResult) {
	return {
		ready: r.ready.length,
		refreshed: r.refreshed.length,
		failed: r.failed.map((f) => ({ code: f.code, kind: f.kind, error: f.error.slice(0, 200) })),
		notAttempted: r.notAttempted.length,
		credentialProblem: r.credentialProblem,
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
		if (outcome.error) progress.lastError = outcome.error.slice(0, 200);
		try {
			await recordEvent(
				job.id,
				outcome.status === 'ok'
					? 'unit_ok'
					: outcome.status === 'skipped'
						? 'unit_skipped'
						: 'unit_failed',
				{ code: loc.code, name: loc.name, kind: outcome.kind, error: outcome.error?.slice(0, 200) }
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
		await failJob(job.id, attempts, outcome.error, summary);
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
			default:
				// sync_lifelist / sync_taxonomy land in Phase 3.
				await failJob(job.id, job.attempts, `no handler for job type "${job.type}"`);
				return;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await failJob(job.id, job.attempts, message.slice(0, 300));
	}
}
