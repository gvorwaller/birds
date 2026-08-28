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
import { query, queryTimed, withTransaction } from '$lib/db';
import { scrubStoredValue, type JobProgress, type JobRow } from '$server/job-policy';

export type JobType =
	| 'load_hotspots'
	| 'load_region'
	| 'analyze_counties'
	| 'refresh_loc'
	| 'retry_loc'
	| 'sync_lifelist'
	| 'sync_taxonomy'
	| 'scan_need_alerts'
	| 'enrich_species'
	| 'scan_enrichment'
	| 'enrich_species_media';

/**
 * System-recurring types: self-rescheduling singletons owned by the lowest-id
 * admin. Not user-cancellable (requestCancel noops; the worker's idle-tick
 * reconciliation would resurrect them anyway) — disable the FEATURE in
 * Settings instead of killing the scheduler.
 */
export const RECURRING_TYPES: ReadonlySet<string> = new Set([
	'scan_need_alerts',
	'scan_enrichment'
]);

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
	| 'yielded'
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
	/**
	 * Delay before the job becomes claimable (INSERT-time next_retry_at —
	 * claimNextJob already gates on it). Used by the recurring scheduler; the
	 * enqueued event's details say 'scheduled' so /admin never conflates a
	 * scheduled future run with a failure backoff (waiting_retry).
	 */
	runAfterMs?: number;
}

export async function recordEvent(
	jobId: number,
	action: JobEventAction,
	details: unknown = {}
): Promise<void> {
	// Every durable write scrubs credential-shaped strings (cs.md; CODEX1
	// Phase-2 #1) — upstream error text is the vector, and this boundary is
	// the one place no caller can forget.
	await query('INSERT INTO job_events (job_id, action, details) VALUES ($1, $2, $3)', [
		jobId,
		action,
		JSON.stringify(scrubStoredValue(details ?? {}))
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
				`INSERT INTO jobs (type, payload, dedup_key, requested_by, label, max_attempts, next_retry_at)
				 VALUES ($1, $2, $3, $4, $5, $6,
				         CASE WHEN $7::int IS NULL THEN NULL
				              ELSE NOW() + make_interval(secs => $7::int / 1000.0) END)
				 ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('pending','running')
				 DO NOTHING
				 RETURNING id`,
				[
					p.type,
					JSON.stringify(p.payload ?? {}),
					p.dedupKey,
					p.requestedBy,
					p.label,
					p.maxAttempts ?? 4,
					p.runAfterMs ?? null
				]
			);
			if (ins.rows[0]) {
				await client.query(
					`INSERT INTO job_events (job_id, action, details) VALUES ($1, 'enqueued', $2)`,
					[
						ins.rows[0].id,
						JSON.stringify({
							type: p.type,
							label: p.label,
							requestedBy: p.requestedBy,
							...(p.runAfterMs != null ? { scheduled: true, runAfterMs: p.runAfterMs } : {})
						})
					]
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
		[jobId, JSON.stringify(scrubStoredValue(progress))]
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
		[JSON.stringify(scrubStoredValue(result ?? null))]
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
		[scrubStoredValue(error), JSON.stringify(scrubStoredValue(result ?? null))]
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
		[JSON.stringify(scrubStoredValue(result ?? null))]
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
		[Math.round(delayMs / 1000), JSON.stringify(scrubStoredValue(result ?? null))]
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
 * Budget yield (queue fairness — CODEX1 P1 on 2171eb7): a chunk boundary hit
 * with work remaining. Back to pending with enqueued_at reset to NOW(), so
 * the FIFO claim order (ORDER BY enqueued_at) serves every job that arrived
 * during the chunk BEFORE the remainder resumes — one huge load can no
 * longer monopolize the single-concurrency queue. The attempt is refunded (a
 * yield is neither failure nor retry), and newPayload — when given — narrows
 * the job to its remaining work; pass null for job types that re-derive
 * their remainder at claim time. A raced cancel still wins.
 */
export async function yieldRemainder(
	jobId: number,
	expectedAttempts: number,
	newPayload: unknown | null,
	chunkSummary: unknown
): Promise<boolean> {
	const final = await transition(
		jobId,
		expectedAttempts,
		`status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'pending' END,
		 payload = COALESCE($3::jsonb, payload),
		 enqueued_at = CASE WHEN cancel_requested THEN enqueued_at ELSE NOW() END,
		 next_retry_at = NULL,
		 finished_at = CASE WHEN cancel_requested THEN NOW() ELSE NULL END,
		 attempts = GREATEST(attempts - 1, 0)`,
		[newPayload == null ? null : JSON.stringify(scrubStoredValue(newPayload))]
	);
	if (final === 'pending') await recordEvent(jobId, 'yielded', { summary: chunkSummary });
	else if (final === 'cancelled') await recordEvent(jobId, 'cancelled', { when: 'at_yield' });
	return final != null;
}

/**
 * Drain requeue (SIGTERM): back to pending immediately, refunding the attempt
 * — a deploy must not consume retry budget (plan §5). A raced cancel still
 * wins: the job must not resurrect as pending on the next worker.
 */
export async function requeueInterrupted(
	jobId: number,
	expectedAttempts: number,
	reason = 'worker draining'
): Promise<boolean> {
	const final = await transition(
		jobId,
		expectedAttempts,
		`status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'pending' END,
		 next_retry_at = CASE WHEN cancel_requested THEN NULL ELSE NOW() END,
		 finished_at = CASE WHEN cancel_requested THEN NOW() ELSE NULL END,
		 attempts = GREATEST(attempts - 1, 0)`,
		[]
	);
	if (final === 'pending') await recordEvent(jobId, 'interrupted', { reason });
	else if (final === 'cancelled') await recordEvent(jobId, 'cancelled', { when: 'at_requeue' });
	return final != null;
}

/**
 * Terminalize the CURRENT recurring run and insert its successor in ONE
 * transaction (plan A2; CODEX1 #1 + Rev-2 addendum #2): because the current
 * row leaves the active state inside the same txn, the partial-unique dedup
 * index admits the successor — no self-dedup and no crash gap between
 * completing and rescheduling. BOTH audit events (the terminal event and the
 * successor's 'enqueued' with scheduled details) commit atomically with the
 * two row writes, so /admin history can never show recurrence rows without
 * their events. Cancel is still honored by the same CASE as every terminal
 * transition; a cancel win skips the successor (the worker's idle-tick
 * reconciliation revives the chain).
 *
 * Returns {won, successorId} — won=false when the CAS lost (raced transition);
 * successorId=null when the successor was skipped (cancel win / dedup race).
 */
export async function terminalizeAndReschedule(
	jobId: number,
	expectedAttempts: number,
	outcome:
		| { kind: 'complete'; result: unknown }
		| { kind: 'fail'; error: string; result?: unknown },
	successor: EnqueueParams
): Promise<{ won: boolean; finalStatus: string | null; successorId: number | null }> {
	return withTransaction(async (client) => {
		const desired = outcome.kind === 'complete' ? 'succeeded' : 'failed';
		const term = await client.query<{ status: string }>(
			`UPDATE jobs SET
			    status = CASE WHEN cancel_requested THEN 'cancelled' ELSE '${desired}' END,
			    error = CASE WHEN cancel_requested THEN NULL ELSE $3 END,
			    result = $4, finished_at = NOW()
			  WHERE id = $1 AND status = 'running' AND attempts = $2
			  RETURNING status`,
			[
				jobId,
				expectedAttempts,
				outcome.kind === 'fail' ? scrubStoredValue(outcome.error) : null,
				JSON.stringify(scrubStoredValue(outcome.result ?? null))
			]
		);
		const final = term.rows[0]?.status ?? null;
		if (final == null) return { won: false, finalStatus: null, successorId: null };
		await client.query(
			`INSERT INTO job_events (job_id, action, details) VALUES ($1, $2, $3)`,
			[
				jobId,
				final === 'succeeded' ? 'completed' : final === 'failed' ? 'failed' : 'cancelled',
				JSON.stringify(
					scrubStoredValue(
						final === 'succeeded'
							? { result: outcome.result }
							: final === 'failed'
								? { error: (outcome as { error: string }).error }
								: { when: 'at_terminalize' }
					)
				)
			]
		);
		if (final === 'cancelled') return { won: true, finalStatus: final, successorId: null };

		const ins = await client.query<{ id: number }>(
			`INSERT INTO jobs (type, payload, dedup_key, requested_by, label, max_attempts, next_retry_at)
			 VALUES ($1, $2, $3, $4, $5, $6,
			         CASE WHEN $7::int IS NULL THEN NULL
			              ELSE NOW() + make_interval(secs => $7::int / 1000.0) END)
			 ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('pending','running')
			 DO NOTHING
			 RETURNING id`,
			[
				successor.type,
				JSON.stringify(successor.payload ?? {}),
				successor.dedupKey,
				successor.requestedBy,
				successor.label,
				successor.maxAttempts ?? 4,
				successor.runAfterMs ?? null
			]
		);
		const successorId = ins.rows[0]?.id ?? null;
		if (successorId != null) {
			await client.query(
				`INSERT INTO job_events (job_id, action, details) VALUES ($1, 'enqueued', $2)`,
				[
					successorId,
					JSON.stringify({
						type: successor.type,
						label: successor.label,
						requestedBy: successor.requestedBy,
						scheduled: true,
						runAfterMs: successor.runAfterMs ?? 0
					})
				]
			);
		}
		return { won: true, finalStatus: final, successorId };
	});
}

/** True when an ACTIVE (pending/running) job holds the dedup key. */
export async function hasActiveJob(dedupKey: string): Promise<boolean> {
	const r = await query(
		`SELECT 1 FROM jobs WHERE dedup_key = $1 AND status IN ('pending','running') LIMIT 1`,
		[dedupKey]
	);
	return (r.rowCount ?? 0) > 0;
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
	// System-recurring singletons are not cancellable (CODEX1 plan #2): the
	// scheduler chain must not be killable from the hub; disable the feature
	// in Settings instead. Reconciliation would resurrect it regardless.
	const typeRow = await query<{ type: string }>(`SELECT type FROM jobs WHERE id = $1`, [jobId]);
	if (typeRow.rows[0] && RECURRING_TYPES.has(typeRow.rows[0].type)) return 'noop';
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
	// Need-alert history (/alerts): half a year is plenty of lookback; the
	// re-alert memory (need_alerts_sent) is separate and never pruned.
	await query(`DELETE FROM need_alert_log WHERE sent_at < NOW() - interval '180 days'`);
}

// ---------------------------------------------------------------------------
// Worker status
// ---------------------------------------------------------------------------

export type WorkerState = 'idle' | 'working' | 'paused' | 'draining';

const WORKER_CONTROL_READ_TIMEOUT_MS = 5_000;

/** Persist the operator's desired state. The worker acknowledges this at a
 * safe unit boundary; this write never pretends an in-flight call stopped
 * synchronously. */
export async function setWorkerPauseRequested(paused: boolean): Promise<void> {
	await query(
		`UPDATE worker_status SET pause_requested = $1, updated_at = NOW() WHERE id = TRUE`,
		[paused]
	);
}

/** Hot-path control read. A DB error fails safe to PAUSED: continuing an
 * expensive AI drain when its kill switch cannot be read is the unsafe side
 * of the ambiguity. */
export async function workerPauseRequested(): Promise<boolean> {
	try {
		const r = await queryTimed<{ pause_requested: boolean }>(
			`SELECT pause_requested FROM worker_status WHERE id = TRUE`,
			[],
			WORKER_CONTROL_READ_TIMEOUT_MS
		);
		return r.rows[0]?.pause_requested ?? true;
	} catch (err) {
		console.error(
			'[birds-worker] pause control read failed; pausing safely:',
			err instanceof Error ? err.message : err
		);
		return true;
	}
}

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
		    SET pid = $1, version = $2,
		        state = CASE WHEN pause_requested THEN 'paused' ELSE 'idle' END,
		        current_job_id = NULL,
		        started_at = NOW(), heartbeat_at = NOW(), updated_at = NOW()
		  WHERE id = TRUE`,
		[pid, version]
	);
	await query(
		`INSERT INTO worker_status_history (pid, version, state, note)
		 SELECT $1, $2, state, 'startup' FROM worker_status WHERE id = TRUE`,
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
	pauseRequested: boolean;
}

export const WORKER_ALIVE_WINDOW_MS = 60_000;

export async function workerHealth(): Promise<WorkerHealth> {
	const r = await query<{
		pid: number | null;
		version: string | null;
		state: WorkerState;
		current_job_id: number | null;
		pause_requested: boolean;
		started_at: string | null;
		heartbeat_at: string | null;
	}>(`SELECT pid, version, state, current_job_id, started_at, heartbeat_at, pause_requested FROM worker_status WHERE id = TRUE`);
	const row = r.rows[0];
	if (!row) {
		return {
			alive: false,
			state: null,
			pid: null,
			version: null,
			startedAt: null,
			heartbeatAt: null,
			currentJobId: null,
			pauseRequested: false
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
		currentJobId: row.current_job_id,
		pauseRequested: row.pause_requested
	};
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export async function listJobs(limit = 15): Promise<JobRow[]> {
	// display_name rides along so the hub can say WHO queued a communal job
	// (GROK #14 — cancellations must not be mysterious).
	const r = await query<JobRow>(
		`(SELECT j.*, u.display_name AS requested_by_name FROM jobs j
		   JOIN users u ON u.id = j.requested_by
		  WHERE j.status IN ('pending','running') ORDER BY j.enqueued_at)
		 UNION ALL
		 (SELECT j.*, u.display_name AS requested_by_name FROM jobs j
		   JOIN users u ON u.id = j.requested_by
		  WHERE j.status NOT IN ('pending','running')
		  ORDER BY j.finished_at DESC NULLS LAST LIMIT $1)`,
		[limit]
	);
	return r.rows;
}

/**
 * The NEWEST `limit` events, in chronological order. Long jobs write far more
 * than the window — ORDER BY id LIMIT used to return the OLDEST window, which
 * froze the hub's live activity feed once a load passed 200 events (CODEX1
 * P1 on e3ac335). `total` lets callers disclose truncation honestly.
 */
export async function jobEvents(jobId: number, limit = 200): Promise<{
	events: { id: number; at: Date; action: JobEventAction; details: unknown }[];
	total: number;
}> {
	const [rows, count] = await Promise.all([
		query<{ id: number; at: string; action: JobEventAction; details: unknown }>(
			`SELECT id, at, action, details FROM (
			   SELECT id, at, action, details FROM job_events
			    WHERE job_id = $1 ORDER BY id DESC LIMIT $2
			 ) newest ORDER BY id`,
			[jobId, limit]
		),
		query<{ n: string }>(`SELECT COUNT(*) AS n FROM job_events WHERE job_id = $1`, [jobId])
	]);
	return {
		events: rows.rows.map((row) => ({ ...row, at: new Date(row.at) })),
		total: Number(count.rows[0]?.n ?? 0)
	};
}

export async function getJob(jobId: number): Promise<JobRow | null> {
	const r = await query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
	return r.rows[0] ?? null;
}
