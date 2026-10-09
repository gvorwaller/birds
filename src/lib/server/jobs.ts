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
 * - Under a handler's claim every write is fenced to that claim (td-b99b6d,
 *   job-claim.ts): queue writes by claim_seq, events by a FOR SHARE locking
 *   CTE, enqueues inside withClaimTx. Every queue writer is a bounded
 *   lock_timeout micro-transaction retried to a deadline, so a held row
 *   delays a transition but never wedges it.
 */
import type pg from 'pg';
import { query, queryTimed } from '$lib/db';
import {
	assertNotInOwnClaimTx,
	boundedQueueWrite,
	currentClaim,
	StaleClaimError,
	withClaimTx
} from './job-claim';
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
	| 'enrich_species_media'
	| 'enrich_species_inat'
	| 'enrich_families'
	| 'tag_repair'
	| 'tag_consistency'
	| 'tag_stage'
	| 'tag_benchmark'
	| 'tag_activate'
	| 'tag_retire'
	| 'tag_rollback'
	| 'tag_draft_rules'
	| 'tag_design_simulation'
	| 'tag_eval_create'
	| 'tag_gate_report'
	| 'tag_preview'
	| 'tag_family_refs';

/**
 * System-recurring types: self-rescheduling singletons owned by the lowest-id
 * admin. Not user-cancellable (requestCancel noops; the worker's idle-tick
 * reconciliation would resurrect them anyway) — disable the FEATURE in
 * Settings instead of killing the scheduler.
 */
export const RECURRING_TYPES: ReadonlySet<string> = new Set([
	'scan_need_alerts',
	'scan_enrichment',
	'enrich_families',
	'tag_consistency'
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

// ── claim fencing (td-894144 B5 plan §3z; td-b99b6d) ─────────────────────
// The claim context, its errors and the fencing helpers live in job-claim.ts
// (imports only $lib/db, so library modules can fence without importing the
// queue); re-exported here so queue callers keep one import.
export {
	type JobClaim,
	runWithClaim,
	currentClaim,
	heldClaim,
	StaleClaimError,
	isStaleClaim,
	ClaimTxMisuseError,
	QueueLockTimeoutError,
	QueueWriteUnrecoverableError,
	assertClaimHeld,
	withClaimTx,
	claimFencedQuery
} from './job-claim';

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

/**
 * A handler's job event. Under the holder's claim it is fenced at COMMIT time
 * (td-b99b6d spec §4.1): the locking CTE takes the job row FOR SHARE, so a
 * transition (FOR NO KEY UPDATE) either waits for this INSERT to commit or —
 * having committed first — leaves no qualifying row (READ COMMITTED
 * re-evaluates the new version) and the event is refused with
 * StaleClaimError. A lock-free EXISTS would only check the statement's
 * snapshot, and the INSERT's own FK lock (FOR KEY SHARE) does not conflict
 * with a transition. Without a claim context it is a plain INSERT.
 */
export async function recordEvent(
	jobId: number,
	action: JobEventAction,
	details: unknown = {}
): Promise<void> {
	const claim = currentClaim(jobId);
	if (!claim) return recordQueueEvent(jobId, action, details);
	const r = await query(
		`WITH j AS (
		   SELECT id FROM jobs
		    WHERE id = $1 AND status = 'running' AND claim_seq = $3
		    FOR SHARE
		 )
		 INSERT INTO job_events (job_id, action, details)
		 SELECT $1, $2, $4 FROM j`,
		[jobId, action, claim.claimSeq, JSON.stringify(scrubStoredValue(details ?? {}))]
	);
	if (!r.rowCount) throw new StaleClaimError(jobId, `${action} event`);
}

/**
 * The queue's OWN events, unfenced: post-transition events (written only by
 * the CAS winner, after the row left `running`) and the no-claim writers
 * (requestCancel, reclaimStartupJobs). Handlers never call this — the
 * catch-discovery test refuses it outside jobs.ts.
 */
export async function recordQueueEvent(
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

/** The handler's "claimed" event — kept as an alias so the B5 call sites read as before. */
export async function recordClaimedEvent(jobId: number, details: unknown = {}): Promise<void> {
	return recordEvent(jobId, 'claimed', details);
}

/**
 * The INSERT half of an enqueue, on a caller-owned client: the jobs row (with
 * the partial-unique dedup inference) and its 'enqueued' event, in whatever
 * transaction the caller holds. Returns null when an active row already owns
 * the dedup key. enqueueJob wraps it; the tag engine calls it inside its own
 * exclusive transaction so a repair generation and its job commit together
 * (td-894144 plan rev 21 — never call enqueueJob from inside that txn).
 */
export async function insertJobOn(client: pg.PoolClient, p: EnqueueParams): Promise<number | null> {
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
	if (!ins.rows[0]) return null;
	await client.query(`INSERT INTO job_events (job_id, action, details) VALUES ($1, 'enqueued', $2)`, [
		ins.rows[0].id,
		JSON.stringify({
			type: p.type,
			label: p.label,
			requestedBy: p.requestedBy,
			...(p.runAfterMs != null ? { scheduled: true, runAfterMs: p.runAfterMs } : {})
		})
	]);
	return ins.rows[0].id;
}

/**
 * Enqueue with atomic dedup. One transaction, bounded retry: INSERT with the
 * partial-unique-index inference predicate; on conflict SELECT the active
 * winner; if it finished in the gap, loop and insert again (max 3). From a
 * handler the transaction is fenced to its claim (withClaimTx asserts first):
 * a stale execution can no longer CREATE work (td-b99b6d §4.4).
 */
export async function enqueueJob(p: EnqueueParams): Promise<{ jobId: number; deduped: boolean }> {
	for (let round = 0; round < 3; round++) {
		const outcome = await withClaimTx(async (client) => {
			const inserted = await insertJobOn(client, p);
			if (inserted != null) return { jobId: inserted, deduped: false };
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
		}, { where: 'enqueue' });
		if (outcome) return outcome;
	}
	throw new Error('enqueueJob: dedup race did not settle after 3 rounds');
}

/**
 * Test-only scope for claim/reclaim (td-d425c1). Integration tests share the
 * birds_test queue with real recurring jobs (scan_need_alerts, scan_enrichment,
 * enrich_families), so an unscoped claim can take a real due job instead of
 * the test's fixture and leave it 'running'. Every field present narrows the
 * statement to rows the caller owns. The worker always calls unscoped.
 */
export interface ClaimScope {
	jobIds?: readonly number[];
	/** SQL LIKE pattern on jobs.label, e.g. 'JOBTEST %'. */
	labelLike?: string;
}

function claimScopeSql(scope: ClaimScope | undefined) {
	const clauses: string[] = [];
	const params: unknown[] = [];
	if (scope?.jobIds) {
		params.push([...scope.jobIds]);
		clauses.push(`AND id = ANY($${params.length}::bigint[])`);
	}
	if (scope?.labelLike != null) {
		params.push(scope.labelLike);
		clauses.push(`AND label LIKE $${params.length}`);
	}
	return { sql: clauses.join(' '), params };
}

/** Claim the next runnable job. ONE statement; caller must hold the worker advisory lock. */
export async function claimNextJob(scope?: ClaimScope): Promise<JobRow | null> {
	const s = claimScopeSql(scope);
	const r = await query<JobRow>(
		`UPDATE jobs
		    SET status = 'running', started_at = NOW(), attempts = attempts + 1, heartbeat_at = NOW(),
		        claim_seq = claim_seq + 1
		  WHERE id = (SELECT id FROM jobs
		               WHERE status = 'pending'
		                 AND NOT cancel_requested
		                 AND (type <> 'enrich_families' OR EXISTS(SELECT 1 FROM family_enrichment_control WHERE singleton AND NOT paused AND (blocked_until IS NULL OR blocked_until<=NOW())))
		                 AND (next_retry_at IS NULL OR next_retry_at <= NOW())
		                 ${s.sql}
		               ORDER BY enqueued_at
		               LIMIT 1
		               FOR UPDATE SKIP LOCKED)
		  RETURNING *`,
		s.params
	);
	return r.rows[0] ?? null;
}

/**
 * Progress write doubles as job heartbeat AND cancel check — one query per
 * unit. Under the holder's claim it is fenced (running + claim_seq) and a
 * miss throws StaleClaimError: a stale execution never overwrites the current
 * claim's progress or heartbeat, and never reads its cancel flag. Like every
 * queue writer it runs as a bounded micro-transaction retried to the deadline
 * (td-b99b6d §4.3), and it refuses to run inside its own job's fenced
 * transaction (ClaimTxMisuseError — that would self-deadlock).
 */
export async function updateProgress(
	jobId: number,
	progress: JobProgress
): Promise<{ cancelRequested: boolean }> {
	assertNotInOwnClaimTx(jobId, 'updateProgress');
	const claim = currentClaim(jobId);
	const r = await boundedQueueWrite(jobId, 'updateProgress', (c) =>
		c.query<{ cancel_requested: boolean }>(
			`UPDATE jobs SET progress = $2, heartbeat_at = NOW()
			  WHERE id = $1${claim ? ` AND status = 'running' AND claim_seq = $3` : ''}
			  RETURNING cancel_requested`,
			claim
				? [jobId, JSON.stringify(scrubStoredValue(progress)), claim.claimSeq]
				: [jobId, JSON.stringify(scrubStoredValue(progress))]
		)
	);
	if (claim && r.rows.length === 0) throw new StaleClaimError(jobId, 'progress');
	return { cancelRequested: r.rows[0]?.cancel_requested ?? false };
}

/**
 * The job's display label, written by the handler itself (the family job names
 * the family it is working on). Fenced exactly like updateProgress: under the
 * holder's claim only while running under THAT claim, else StaleClaimError.
 */
export async function setJobLabel(jobId: number, label: string): Promise<void> {
	assertNotInOwnClaimTx(jobId, 'setJobLabel');
	const claim = currentClaim(jobId);
	const r = await boundedQueueWrite(jobId, 'setJobLabel', (c) =>
		c.query(
			`UPDATE jobs SET label = $2
			  WHERE id = $1${claim ? ` AND status = 'running' AND claim_seq = $3` : ''}`,
			claim ? [jobId, label, claim.claimSeq] : [jobId, label]
		)
	);
	if (claim && !r.rowCount) throw new StaleClaimError(jobId, 'label');
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
 * matching single event), or null when it lost. Under the holder's claim the
 * CAS also requires the claim_seq (plan §3z) and a loss throws
 * StaleClaimError — attempts alone repeats after a refunding drain.
 * Bounded micro-transaction retried to the deadline (td-b99b6d §4.3): it
 * never throws a lock timeout before D, and past D it throws
 * QueueWriteUnrecoverableError.
 */
async function transition(
	jobId: number,
	expectedAttempts: number,
	desiredSet: string,
	params: unknown[]
): Promise<string | null> {
	assertNotInOwnClaimTx(jobId, 'transition');
	const claim = currentClaim(jobId);
	const r = await boundedQueueWrite(jobId, 'transition', (c) =>
		c.query<{ status: string }>(
			`UPDATE jobs SET ${desiredSet}
			  WHERE id = $1 AND status = 'running' AND attempts = $2${claim ? ` AND claim_seq = $${params.length + 3}` : ''}
			  RETURNING status`,
			claim ? [jobId, expectedAttempts, ...params, claim.claimSeq] : [jobId, expectedAttempts, ...params]
		)
	);
	if (claim && r.rows.length === 0) throw new StaleClaimError(jobId, 'transition');
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
	if (final === 'succeeded') await recordQueueEvent(jobId, 'completed', { result });
	else if (final === 'cancelled') await recordQueueEvent(jobId, 'cancelled', { when: 'at_completion' });
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
	if (final === 'failed') await recordQueueEvent(jobId, 'failed', { error });
	else if (final === 'cancelled') await recordQueueEvent(jobId, 'cancelled', { when: 'at_failure' });
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
	if (final != null) await recordQueueEvent(jobId, 'cancelled', { when: 'running' });
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
		await recordQueueEvent(jobId, 'retry_scheduled', {
			delayMs,
			reason,
			attempt: expectedAttempts
		});
	else if (final === 'cancelled') await recordQueueEvent(jobId, 'cancelled', { when: 'at_retry' });
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
	if (final === 'pending') await recordQueueEvent(jobId, 'yielded', { summary: chunkSummary });
	else if (final === 'cancelled') await recordQueueEvent(jobId, 'cancelled', { when: 'at_yield' });
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
	if (final === 'pending') await recordQueueEvent(jobId, 'interrupted', { reason });
	else if (final === 'cancelled') await recordQueueEvent(jobId, 'cancelled', { when: 'at_requeue' });
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
 * A queue writer like transition(): the whole transaction is the bounded
 * micro-transaction (nothing durable precedes its UPDATE), retried to the
 * deadline on a lock timeout (td-b99b6d §4.3).
 */
export async function terminalizeAndReschedule(
	jobId: number,
	expectedAttempts: number,
	outcome:
		| { kind: 'complete'; result: unknown }
		| { kind: 'fail'; error: string; result?: unknown },
	successor: EnqueueParams
): Promise<{ won: boolean; finalStatus: string | null; successorId: number | null }> {
	assertNotInOwnClaimTx(jobId, 'terminalizeAndReschedule');
	const claim = currentClaim(jobId);
	return boundedQueueWrite(jobId, 'terminalizeAndReschedule', async (client) => {
		const desired = outcome.kind === 'complete' ? 'succeeded' : 'failed';
		const term = await client.query<{ status: string }>(
			`UPDATE jobs SET
			    status = CASE WHEN cancel_requested THEN 'cancelled' ELSE '${desired}' END,
			    error = CASE WHEN cancel_requested THEN NULL ELSE $3 END,
			    result = $4, finished_at = NOW()
			  WHERE id = $1 AND status = 'running' AND attempts = $2${claim ? ' AND claim_seq = $5' : ''}
			  RETURNING status`,
			[
				jobId,
				expectedAttempts,
				outcome.kind === 'fail' ? scrubStoredValue(outcome.error) : null,
				JSON.stringify(scrubStoredValue(outcome.result ?? null)),
				...(claim ? [claim.claimSeq] : [])
			]
		);
		const final = term.rows[0]?.status ?? null;
		if (final == null && claim) throw new StaleClaimError(jobId, 'terminalizeAndReschedule');
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
 * A web request: ONE bounded attempt (15 s lock_timeout) — a job row held by
 * the worker's fenced transaction throws QueueLockTimeoutError, which the
 * route answers with 503 job_busy instead of hanging (td-b99b6d Rev 3.1).
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
	const r = await boundedQueueWrite(
		jobId,
		'requestCancel',
		(c) =>
			c.query<{ status: string }>(
				`UPDATE jobs SET
				    status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
				    finished_at = CASE WHEN status = 'pending' THEN NOW() ELSE finished_at END,
				    cancel_requested = CASE WHEN status = 'running' THEN TRUE ELSE cancel_requested END
				  WHERE id = $1 AND status IN ('pending', 'running')
				  RETURNING status`,
				[jobId]
			),
		{ retry: false }
	);
	const final = r.rows[0]?.status ?? null;
	if (final === 'cancelled') {
		await recordQueueEvent(jobId, 'cancelled', { when: 'pending', requestedBy });
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
export async function reclaimStartupJobs(note: string, scope?: ClaimScope): Promise<number> {
	// One conditional UPDATE PER crash-wreckage row: the cancelled vs pending
	// vs failed decision is made INSIDE the statement from the row's committed
	// state at lock time — no SELECT/recheck window, so a cancel whose flag
	// commits before this statement acquires the row can never be overwritten
	// into pending/failed (CODEX1 re-review). A cancel-flagged row must resolve
	// to cancelled, never pending: claimNextJob excludes flagged pending rows,
	// so re-pending it would wedge the job forever. Events are emitted only for
	// rows an UPDATE actually returned, matching the FINAL status of each.
	//
	// Per row, in id order, each its own bounded micro-transaction retried to
	// the deadline (td-b99b6d §4.3): one multirow UPDATE would keep every row
	// it had already locked while it waited on a later one, so a run of waits
	// just under the lock timeout could hold an early row past the deadline of
	// another writer — our own code breaking the holder bound (CODEX1 Phase A
	// review #2). The id list is only a candidate set: a row that left
	// `running` in the meantime simply returns nothing. If a row cannot be
	// written before the deadline, startup fails and PM2 restarts the worker
	// (operator-visible: health reports no worker).
	const s = claimScopeSql(scope);
	const candidates = await query<{ id: number }>(
		`SELECT id FROM jobs WHERE status = 'running' ${s.sql} ORDER BY id`,
		s.params
	);
	let reclaimed = 0;
	for (const { id } of candidates.rows) {
		const r = await boundedQueueWrite(id, 'reclaimStartupJobs', (c) =>
			c.query<{ id: number; status: string; progress: unknown }>(
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
				  WHERE id = $1 AND status = 'running'
				  RETURNING id, status, progress`,
				[id]
			)
		);
		const row = r.rows[0];
		if (!row) continue;
		reclaimed++;
		if (row.status === 'cancelled') {
			await recordQueueEvent(row.id, 'cancelled', { when: 'at_reclaim', note });
		} else if (row.status === 'pending') {
			await recordQueueEvent(row.id, 'reclaimed', { note, priorProgress: row.progress });
		} else {
			await recordQueueEvent(row.id, 'failed', { note: `${note} (attempts exhausted)` });
		}
	}
	return reclaimed;
}

/**
 * Test-only scope for the retention sweeps (td-e00d6f). Integration tests run
 * against the shared birds_test snapshot, so they must prove the retention
 * rules on rows they own without sweeping everyone else's history. Each field
 * limits one sweep to the caller's rows; a sweep whose field is absent is
 * skipped entirely (worker_status_history cannot be owned, so it never runs
 * under a scope). Production always calls pruneHistory() unscoped.
 */
export interface PruneScope {
	jobIds?: readonly number[];
	/** td-7739c2: limit the memory-sample sweep to these rows. */
	memorySampleIds?: readonly number[];
	alertUserId?: number;
	cacheKeyLike?: string;
}

export async function pruneHistory(scope?: PruneScope): Promise<void> {
	if (!scope || scope.jobIds) {
		const jobs = scope?.jobIds ? 'AND jobs.id = ANY($1::bigint[])' : '';
		const params = scope?.jobIds ? [[...scope.jobIds]] : [];
		await query(
			`DELETE FROM job_events USING jobs
			  WHERE job_events.job_id = jobs.id
			    AND jobs.finished_at IS NOT NULL AND jobs.finished_at < NOW() - interval '30 days'
			    ${jobs}`,
			params
		);
		await query(
			`DELETE FROM jobs
			  WHERE finished_at IS NOT NULL AND finished_at < NOW() - interval '90 days'
			    ${jobs}`,
			params
		);
	}
	if (!scope) {
		await query(
			`DELETE FROM worker_status_history
			  WHERE id NOT IN (SELECT id FROM worker_status_history ORDER BY id DESC LIMIT 500)`
		);
	}
	// Need-alert history (/alerts): half a year is plenty of lookback; the
	// re-alert memory (need_alerts_sent) is separate and never pruned.
	if (!scope) {
		await query(`DELETE FROM need_alert_log WHERE sent_at < NOW() - interval '180 days'`);
	} else if (scope.alertUserId != null) {
		await query(
			`DELETE FROM need_alert_log WHERE sent_at < NOW() - interval '180 days' AND user_id = $1`,
			[scope.alertUserId]
		);
	}
	// Server health memory samples (td-7739c2): 7 days.
	if (!scope) {
		await query(`DELETE FROM process_memory_samples WHERE sampled_at < NOW() - interval '7 days'`);
	} else if (scope.memorySampleIds) {
		await query(
			`DELETE FROM process_memory_samples
			  WHERE sampled_at < NOW() - interval '7 days' AND id = ANY($1::bigint[])`,
			[[...scope.memorySampleIds]]
		);
	}
	if (!scope || scope.cacheKeyLike) await pruneEbirdCache(scope?.cacheKeyLike);
}

/**
 * `ebird_cache` has no eviction of its own — the TTL decides FRESHNESS, and a
 * row living past its TTL is deliberately kept as the fail-soft fallback when
 * eBird errors (cs.md: "fall back to cached data"). Rows otherwise persist
 * until an admin flushes the whole table.
 *
 * That was survivable while keys were bounded. The nearest ladder (td-73e6f9)
 * adds `spReg:` keys keyed by species × region × window, and a single region
 * payload can exceed a megabyte, so the family needs a ceiling.
 *
 * SCOPED BY KEY FAMILY, never blanket, and by an ALLOW-list rather than a
 * deny-list: forgetting to add a new short-TTL family here means it simply is
 * not pruned, while forgetting to EXCLUDE a new long-TTL family would delete
 * live data. The two mistakes are not equally bad.
 *
 * Listed families hold TTLs from 30 minutes to 24 hours, so a 48-hour floor
 * still leaves every one of them a fail-soft window. Deliberately absent: `regions:`,
 * `tideStations:v1` and `tidePred:` carry THIRTY-DAY TTLs — pruning them at
 * 48 hours would evict rows that are still fresh, re-download a ~2 MB NOAA
 * station list every other day, and strip the county-name fallback that
 * hotspot pages read straight out of this table (GROK P1-3).
 */
const PRUNABLE_CACHE_FAMILIES = [
	'spReg', // ladder region probes — species × region × window, up to ~1 MB each
	'obs',
	'notable',
	'geo',
	'geonote',
	'geosp', // pre-td-48c22e key; kept so old rows age out
	'geosp2',
	'hotspotObs2',
	'nearestObs',
	'hotspots',
	'hotspotsRegion',
	'weather'
] as const;

/** `cacheKeyLike` is test-only (td-e00d6f): limits the sweep to keys a test owns. */
export async function pruneEbirdCache(cacheKeyLike?: string): Promise<number> {
	const r = await query<{ n: string }>(
		`WITH d AS (
		   DELETE FROM ebird_cache
		    WHERE fetched_at < NOW() - interval '48 hours'
		      AND split_part(cache_key, ':', 1) = ANY($1::text[])
		      AND ($2::text IS NULL OR cache_key LIKE $2)
		   RETURNING 1
		 ) SELECT COUNT(*) AS n FROM d`,
		[[...PRUNABLE_CACHE_FAMILIES], cacheKeyLike ?? null]
	);
	return Number(r.rows[0]?.n ?? 0);
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
	} catch (err) { // stale-safe: pause-control read only; fails safe to paused
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

/**
 * A history note beside the worker's current status row (pid/version/state as
 * they stand) — for an event the worker reports without changing state, such
 * as the unrecoverable-queue-write exit (td-b99b6d §4.3). Callers treat it as
 * best-effort.
 */
export async function recordWorkerHistoryNote(note: string, currentJobId: number | null): Promise<void> {
	await query(
		`INSERT INTO worker_status_history (pid, version, state, current_job_id, note)
		 SELECT pid, version, state, $2, $1 FROM worker_status WHERE id = TRUE`,
		[note, currentJobId]
	);
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
