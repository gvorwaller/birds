/**
 * Durable job queue over Postgres — shared by the web app (enqueue, list,
 * cancel) and the worker (claim, progress, transitions).
 * Plan: docs/2026-08-15-ebird-worker-job-queue-plan.md §3.
 *
 * Invariants:
 * - Claiming is ONE SQL statement (SKIP LOCKED is per-connection — GROK #7).
 * - Every terminal/requeue transition is compare-and-set on
 *   (status='running' AND attempts=$expected) so raced cancel/complete/requeue
 *   can never double-fire or resurrect a terminal row (CODEX1 #4).
 * - Enqueue dedup is a single transaction with a bounded retry loop
 *   (CODEX1 #5): the returned id and the recorded event always refer to the
 *   winning row.
 * - Payloads/events/results NEVER contain credentials (cs.md sacred rules).
 */
import { query, withTransaction } from '$lib/db';
import type { JobProgress, JobRow } from '$server/job-policy';

export type JobType =
	| 'load_hotspots'
	| 'load_region'
	| 'analyze_counties'
	| 'refresh_loc'
	| 'retry_loc'
	| 'sync_lifelist'
	| 'sync_taxonomy';

export type JobEventAction =
	| 'enqueued'
	| 'deduped'
	| 'claimed'
	| 'unit_ok'
	| 'unit_failed'
	| 'unit_skipped'
	| 'progress'
	| 'retry_scheduled'
	| 'reclaimed'
	| 'interrupted'
	| 'completed'
	| 'failed'
	| 'cancelled';

export interface EnqueueParams {
	type: JobType;
	payload: unknown;
	dedupKey: string | null;
	requestedBy: number;
	label: string;
	maxAttempts?: number;
}

export async function recordEvent(
	jobId: number,
	action: JobEventAction,
	details: unknown = {}
): Promise<void> {
	await query('INSERT INTO job_events (job_id, action, details) VALUES ($1, $2, $3)', [
		jobId,
		action,
		JSON.stringify(details ?? {})
	]);
}

/**
 * Enqueue with atomic dedup. One transaction, bounded retry: INSERT with the
 * partial-unique-index inference predicate; on conflict SELECT the active
 * winner; if it finished in the gap, loop and insert again (max 3).
 */
export async function enqueueJob(p: EnqueueParams): Promise<{ jobId: number; deduped: boolean }> {
	for (let round = 0; round < 3; round++) {
		const outcome = await withTransaction(async (client) => {
			const ins = await client.query<{ id: number }>(
				`INSERT INTO jobs (type, payload, dedup_key, requested_by, label, max_attempts)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('pending','running')
				 DO NOTHING
				 RETURNING id`,
				[
					p.type,
					JSON.stringify(p.payload ?? {}),
					p.dedupKey,
					p.requestedBy,
					p.label,
					p.maxAttempts ?? 4
				]
			);
			if (ins.rows[0]) {
				await client.query(
					`INSERT INTO job_events (job_id, action, details) VALUES ($1, 'enqueued', $2)`,
					[ins.rows[0].id, JSON.stringify({ type: p.type, label: p.label, requestedBy: p.requestedBy })]
				);
				return { jobId: ins.rows[0].id, deduped: false };
			}
			const active = await client.query<{ id: number }>(
				`SELECT id FROM jobs
				  WHERE dedup_key = $1 AND status IN ('pending','running')
				  ORDER BY id DESC LIMIT 1`,
				[p.dedupKey]
			);
			if (active.rows[0]) {
				await client.query(
					`INSERT INTO job_events (job_id, action, details) VALUES ($1, 'deduped', $2)`,
					[active.rows[0].id, JSON.stringify({ requestedBy: p.requestedBy, label: p.label })]
				);
				return { jobId: active.rows[0].id, deduped: true };
			}
			return null; // winner finished between INSERT and SELECT — retry
		});
		if (outcome) return outcome;
	}
	throw new Error('enqueueJob: dedup race did not settle after 3 rounds');
}

/** Claim the next runnable job. ONE statement; caller must hold the worker advisory lock. */
export async function claimNextJob(): Promise<JobRow | null> {
	const r = await query<JobRow>(
		`UPDATE jobs
		    SET status = 'running', started_at = NOW(), attempts = attempts + 1, heartbeat_at = NOW()
		  WHERE id = (SELECT id FROM jobs
		               WHERE status = 'pending'
		                 AND NOT cancel_requested
		                 AND (next_retry_at IS NULL OR next_retry_at <= NOW())
		               ORDER BY enqueued_at
		               LIMIT 1
		               FOR UPDATE SKIP LOCKED)
		  RETURNING *`
	);
	return r.rows[0] ?? null;
}

/** Progress write doubles as job heartbeat AND cancel check — one query per unit. */
export async function updateProgress(
	jobId: number,
	progress: JobProgress
): Promise<{ cancelRequested: boolean }> {
	const r = await query<{ cancel_requested: boolean }>(
		`UPDATE jobs SET progress = $2, heartbeat_at = NOW()
		  WHERE id = $1
		  RETURNING cancel_requested`,
		[jobId, JSON.stringify(progress)]
	);
	return { cancelRequested: r.rows[0]?.cancel_requested ?? false };
}

/**
 * CAS guard shared by every running→X transition, with cancel honored AT THE
 * SQL LINEARIZATION POINT (CODEX1 re-re-review): a cancel_requested flag set
 * at any moment before this UPDATE commits atomically resolves the row to
 * 'cancelled' instead of the desired state — no SELECT-then-write window. A
 * cancel arriving AFTER this statement correctly gets requestCancel's noop;
 * the row-lock ordering of the two UPDATEs defines the boundary.
 *
 * Returns the FINAL status when this caller won the CAS (so it can emit the
 * matching single event), or null when it lost.
 */
async function transition(
	jobId: number,
	expectedAttempts: number,
	desiredSet: string,
	params: unknown[]
): Promise<string | null> {
	const r = await query<{ status: string }>(
		`UPDATE jobs SET ${desiredSet}
		  WHERE id = $1 AND status = 'running' AND attempts = $2
		  RETURNING status`,
		[jobId, expectedAttempts, ...params]
	);
	return r.rows[0]?.status ?? null;
}

export async function completeJob(
	jobId: number,
	expectedAttempts: number,
	result: unknown
): Promise<boolean> {
	const final = await transition(
		jobId,
		expectedAttempts,
		`status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'succeeded' END,
		 result = $3, finished_at = NOW()`,
		[JSON.stringify(result ?? null)]
	);
	if (final === 'succeeded') await recordEvent(jobId, 'completed', { result });
	else if (final === 'cancelled') await recordEvent(jobId, 'cancelled', { when: 'at_completion' });
	return final != null;
}

export async function failJob(
	jobId: number,
	expectedAttempts: number,
	error: string,
	result?: unknown
): Promise<boolean> {
	const final = await transition(
		jobId,
		expectedAttempts,
		`status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
		 error = CASE WHEN cancel_requested THEN NULL ELSE $3 END,
		 result = $4, finished_at = NOW()`,
		[error, JSON.stringify(result ?? null)]
	);
	if (final === 'failed') await recordEvent(jobId, 'failed', { error });
	else if (final === 'cancelled') await recordEvent(jobId, 'cancelled', { when: 'at_failure' });
	return final != null;
}

export async function cancelRunningJob(
	jobId: number,
	expectedAttempts: number,
	result?: unknown
): Promise<boolean> {
	const final = await transition(
		jobId,
		expectedAttempts,
		`status = 'cancelled', result = $3, finished_at = NOW()`,
		[JSON.stringify(result ?? null)]
	);
	if (final != null) await recordEvent(jobId, 'cancelled', { when: 'running' });
	return final != null;
}

export async function scheduleRetry(
	jobId: number,
	expectedAttempts: number,
	delayMs: number,
	reason: string,
	result?: unknown
): Promise<boolean> {
	const final = await transition(
		jobId,
		expectedAttempts,
		`status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'pending' END,
		 next_retry_at = CASE WHEN cancel_requested THEN NULL
		                      ELSE NOW() + make_interval(secs => $3) END,
		 finished_at = CASE WHEN cancel_requested THEN NOW() ELSE NULL END,
		 result = $4,
		 progress = CASE WHEN cancel_requested THEN progress
		                 ELSE progress || '{"phase":"waiting_retry"}'::jsonb END`,
		[Math.round(delayMs / 1000), JSON.stringify(result ?? null)]
	);
	if (final === 'pending')
		await recordEvent(jobId, 'retry_scheduled', {
			delayMs,
			reason,
			attempt: expectedAttempts
		});
	else if (final === 'cancelled') await recordEvent(jobId, 'cancelled', { when: 'at_retry' });
	return final != null;
}

/**
 * Drain requeue (SIGTERM): back to pending immediately, refunding the attempt
 * — a deploy must not consume retry budget (plan §5). A raced cancel still
 * wins: the job must not resurrect as pending on the next worker.
 */
export async function requeueInterrupted(jobId: number, expectedAttempts: number): Promise<boolean> {
	const final = await transition(
		jobId,
		expectedAttempts,
		`status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'pending' END,
		 next_retry_at = CASE WHEN cancel_requested THEN NULL ELSE NOW() END,
		 finished_at = CASE WHEN cancel_requested THEN NOW() ELSE NULL END,
		 attempts = GREATEST(attempts - 1, 0)`,
		[]
	);
	if (final === 'pending') await recordEvent(jobId, 'interrupted', { reason: 'worker draining' });
	else if (final === 'cancelled') await recordEvent(jobId, 'cancelled', { when: 'at_requeue' });
	return final != null;
}

/**
 * Cancel request from the UI — ONE conditional UPDATE over both live states
 * (CODEX1 re-review): pending → cancelled outright; running → flag only (the
 * worker honors it cooperatively); terminal → no row, noop. Single-statement
 * matters: two autocommit UPDATEs left a window where a concurrent reclaim
 * could move running→pending between them and the cancel was silently lost.
 * Under READ COMMITTED a blocked cancel re-evaluates the committed row, so a
 * reclaim that re-pends the job while we wait still gets cancelled here.
 */
export async function requestCancel(
	jobId: number,
	requestedBy: number
): Promise<'cancelled' | 'flagged' | 'noop'> {
	const r = await query<{ status: string }>(
		`UPDATE jobs SET
		    status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
		    finished_at = CASE WHEN status = 'pending' THEN NOW() ELSE finished_at END,
		    cancel_requested = CASE WHEN status = 'running' THEN TRUE ELSE cancel_requested END
		  WHERE id = $1 AND status IN ('pending', 'running')
		  RETURNING status`,
		[jobId]
	);
	const final = r.rows[0]?.status ?? null;
	if (final === 'cancelled') {
		await recordEvent(jobId, 'cancelled', { when: 'pending', requestedBy });
		return 'cancelled';
	}
	if (final === 'running') return 'flagged';
	return 'noop';
}

/**
 * Startup reclaim: with the advisory lock held, any 'running' row is crash
 * wreckage from a previous worker. Cancel-flagged → cancelled; budget left →
 * pending (event carries the inference + prior progress); exhausted → failed.
 */
export async function reclaimStartupJobs(note: string): Promise<number> {
	// ONE conditional UPDATE for all crash-wreckage rows: the cancelled vs
	// pending vs failed decision is made INSIDE the statement from each row's
	// committed state at lock time — no SELECT/recheck window, so a cancel
	// whose flag commits before this statement acquires the row can never be
	// overwritten into pending/failed (CODEX1 re-review). A cancel-flagged row
	// must resolve to cancelled, never pending: claimNextJob excludes flagged
	// pending rows, so re-pending it would wedge the job forever. Events are
	// emitted only for rows the UPDATE actually returned, matching the FINAL
	// status of each.
	const r = await query<{ id: number; status: string; progress: unknown }>(
		`UPDATE jobs SET
		    status = CASE
		      WHEN cancel_requested THEN 'cancelled'
		      WHEN attempts < max_attempts THEN 'pending'
		      ELSE 'failed'
		    END,
		    next_retry_at = CASE WHEN NOT cancel_requested AND attempts < max_attempts
		                         THEN NOW() ELSE next_retry_at END,
		    finished_at = CASE WHEN cancel_requested OR attempts >= max_attempts
		                       THEN NOW() ELSE finished_at END,
		    error = CASE WHEN NOT cancel_requested AND attempts >= max_attempts
		                 THEN 'worker crashed or restarted during this job'
		                 ELSE error END
		  WHERE status = 'running'
		  RETURNING id, status, progress`
	);
	for (const row of r.rows) {
		if (row.status === 'cancelled') {
			await recordEvent(row.id, 'cancelled', { when: 'at_reclaim', note });
		} else if (row.status === 'pending') {
			await recordEvent(row.id, 'reclaimed', { note, priorProgress: row.progress });
		} else {
			await recordEvent(row.id, 'failed', { note: `${note} (attempts exhausted)` });
		}
	}
	return r.rows.length;
}

export async function pruneHistory(): Promise<void> {
	await query(
		`DELETE FROM job_events USING jobs
		  WHERE job_events.job_id = jobs.id
		    AND jobs.finished_at IS NOT NULL AND jobs.finished_at < NOW() - interval '30 days'`
	);
	await query(
		`DELETE FROM jobs
		  WHERE finished_at IS NOT NULL AND finished_at < NOW() - interval '90 days'`
	);
	await query(
		`DELETE FROM worker_status_history
		  WHERE id NOT IN (SELECT id FROM worker_status_history ORDER BY id DESC LIMIT 500)`
	);
}

// ---------------------------------------------------------------------------
// Worker status
// ---------------------------------------------------------------------------

export type WorkerState = 'idle' | 'working' | 'draining';

export async function setWorkerStatus(
	fields: { pid: number; version: string; state: WorkerState; currentJobId: number | null },
	historyNote?: string
): Promise<void> {
	await query(
		`UPDATE worker_status
		    SET pid = $1, version = $2, state = $3, current_job_id = $4,
		        started_at = COALESCE(started_at, NOW()), heartbeat_at = NOW(), updated_at = NOW()
		  WHERE id = TRUE`,
		[fields.pid, fields.version, fields.state, fields.currentJobId]
	);
	if (historyNote) {
		await query(
			`INSERT INTO worker_status_history (pid, version, state, current_job_id, note)
			 VALUES ($1, $2, $3, $4, $5)`,
			[fields.pid, fields.version, fields.state, fields.currentJobId, historyNote]
		);
	}
}

export async function markWorkerStarted(pid: number, version: string): Promise<void> {
	await query(
		`UPDATE worker_status
		    SET pid = $1, version = $2, state = 'idle', current_job_id = NULL,
		        started_at = NOW(), heartbeat_at = NOW(), updated_at = NOW()
		  WHERE id = TRUE`,
		[pid, version]
	);
	await query(
		`INSERT INTO worker_status_history (pid, version, state, note)
		 VALUES ($1, $2, 'idle', 'startup')`,
		[pid, version]
	);
}

export async function bumpWorkerHeartbeat(): Promise<void> {
	await query(`UPDATE worker_status SET heartbeat_at = NOW(), updated_at = NOW() WHERE id = TRUE`);
}

export interface WorkerHealth {
	alive: boolean;
	state: WorkerState | null;
	pid: number | null;
	version: string | null;
	startedAt: Date | null;
	heartbeatAt: Date | null;
	currentJobId: number | null;
}

export const WORKER_ALIVE_WINDOW_MS = 60_000;

export async function workerHealth(): Promise<WorkerHealth> {
	const r = await query<{
		pid: number | null;
		version: string | null;
		state: WorkerState;
		current_job_id: number | null;
		started_at: string | null;
		heartbeat_at: string | null;
	}>(`SELECT pid, version, state, current_job_id, started_at, heartbeat_at FROM worker_status WHERE id = TRUE`);
	const row = r.rows[0];
	if (!row) {
		return {
			alive: false,
			state: null,
			pid: null,
			version: null,
			startedAt: null,
			heartbeatAt: null,
			currentJobId: null
		};
	}
	const hb = row.heartbeat_at ? new Date(row.heartbeat_at) : null;
	return {
		alive: hb != null && Date.now() - hb.getTime() < WORKER_ALIVE_WINDOW_MS,
		state: row.state,
		pid: row.pid,
		version: row.version,
		startedAt: row.started_at ? new Date(row.started_at) : null,
		heartbeatAt: hb,
		currentJobId: row.current_job_id
	};
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export async function listJobs(limit = 15): Promise<JobRow[]> {
	const r = await query<JobRow>(
		`(SELECT * FROM jobs WHERE status IN ('pending','running') ORDER BY enqueued_at)
		 UNION ALL
		 (SELECT * FROM jobs WHERE status NOT IN ('pending','running')
		   ORDER BY finished_at DESC NULLS LAST LIMIT $1)`,
		[limit]
	);
	return r.rows;
}

export async function jobEvents(jobId: number, limit = 200): Promise<
	{ id: number; at: Date; action: JobEventAction; details: unknown }[]
> {
	const r = await query<{ id: number; at: string; action: JobEventAction; details: unknown }>(
		`SELECT id, at, action, details FROM job_events
		  WHERE job_id = $1 ORDER BY id LIMIT $2`,
		[jobId, limit]
	);
	return r.rows.map((row) => ({ ...row, at: new Date(row.at) }));
}

export async function getJob(jobId: number): Promise<JobRow | null> {
	const r = await query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
	return r.rows[0] ?? null;
}
