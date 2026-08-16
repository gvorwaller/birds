import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listJobs, workerHealth } from '$server/jobs';
import { displayName, durationMs, statusColor, type JobRow } from '$server/job-policy';

export interface DecoratedJob {
	id: number;
	type: string;
	status: string;
	label: string;
	displayName: string;
	statusColor: string;
	attempts: number;
	maxAttempts: number;
	nextRetryAt: string | null;
	cancelRequested: boolean;
	progress: JobRow['progress'];
	error: string | null;
	requestedBy: number;
	enqueuedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	durationMs: number | null;
}

function decorate(job: JobRow, now: Date): DecoratedJob {
	return {
		id: Number(job.id),
		type: job.type,
		status: job.status,
		label: job.label,
		displayName: displayName(job),
		statusColor: statusColor(job.status),
		attempts: job.attempts,
		maxAttempts: job.max_attempts,
		nextRetryAt: job.next_retry_at ? new Date(job.next_retry_at).toISOString() : null,
		cancelRequested: job.cancel_requested,
		progress: job.progress,
		error: job.error,
		requestedBy: job.requested_by,
		enqueuedAt: new Date(job.enqueued_at).toISOString(),
		startedAt: job.started_at ? new Date(job.started_at).toISOString() : null,
		finishedAt: job.finished_at ? new Date(job.finished_at).toISOString() : null,
		durationMs: durationMs(job, now)
	};
}

/**
 * Jobs are communal like the frequency pool: every logged-in account sees
 * them (viewers included — read-only). Auth is hooks-level (401 JSON for
 * expired sessions on /api/*).
 */
export const GET: RequestHandler = async () => {
	const now = new Date();
	const [worker, jobs] = await Promise.all([workerHealth(), listJobs(15)]);
	return json(
		{
			worker: {
				alive: worker.alive,
				state: worker.state,
				pid: worker.pid,
				version: worker.version,
				startedAt: worker.startedAt?.toISOString() ?? null,
				heartbeatAt: worker.heartbeatAt?.toISOString() ?? null,
				currentJobId: worker.currentJobId
			},
			jobs: jobs.map((j) => decorate(j, now))
		},
		// Safari heuristically caches authenticated GETs — never this one
		// (hooks set it too when unset; explicit per GROK #12).
		{ headers: { 'cache-control': 'private, no-store' } }
	);
};
