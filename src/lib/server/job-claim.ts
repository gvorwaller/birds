/**
 * Claim fencing for the job queue (td-894144 B5 plan §3z; td-b99b6d spec
 * docs/2026-10-09-job-claim-fencing-spec.md). A handler runs under the claim
 * that started it; a continuation whose claim is no longer the live one (the
 * row left `running`, or a newer claim owns it) is a STALE execution and must
 * not commit anything. This module holds the claim context, the errors that
 * signal a lost claim, and the helpers that fence a durable side effect to the
 * live claim. It imports only $lib/db so library modules (barchart,
 * species-enrichment, eval-sample, the tag-engine runtime) can call it without
 * importing the queue; jobs.ts re-exports all of it.
 *
 * Without a claim context (web requests, admin actions, scripts, tests) every
 * fencing helper is a pass-through: today's statements and locks exactly.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import { query, withTransaction } from '$lib/db';

/**
 * The claim a handler runs under: the job and its per-claim identity
 * (jobs.claim_seq — incremented by every claim, never refunded, unlike
 * `attempts`, which a drain or yield refunds). runJob runs each handler inside
 * this context, so every async continuation of THAT execution — including a
 * late one after a requeue and a same-process re-claim — keeps its own claim.
 */
export interface JobClaim {
	jobId: number;
	claimSeq: string;
}
const claimContext = new AsyncLocalStorage<JobClaim>();

/** Run `fn` as the holder of this claim (the worker's runJob; tests). */
export function runWithClaim<T>(job: { id: number; claim_seq?: string | number | null }, fn: () => Promise<T>): Promise<T> {
	return claimContext.run({ jobId: job.id, claimSeq: String(job.claim_seq ?? '0') }, fn);
}

/** The claim this execution holds for `jobId`, if any (queue APIs targeting a job id). */
export function currentClaim(jobId: number): JobClaim | null {
	const c = claimContext.getStore();
	return c && c.jobId === jobId ? c : null;
}

/**
 * The claim this execution holds (any job), or null outside a handler. For a
 * BUSINESS effect the authorisation is simply "this execution holds a live
 * claim", so library code fences without knowing which job it serves.
 */
export function heldClaim(): JobClaim | null {
	return claimContext.getStore() ?? null;
}

/**
 * This execution no longer holds its job's claim (the job left `running`, or
 * a newer claim owns it). Thrown by fenced writes; runJob catches it once at
 * its boundary and stops without further writes.
 */
export class StaleClaimError extends Error {
	constructor(jobId: number, where: string) {
		super(`stale claim: job ${jobId} is no longer held by this execution (${where})`);
		this.name = 'StaleClaimError';
	}
}

export const isStaleClaim = (err: unknown): boolean =>
	err instanceof StaleClaimError ||
	(err instanceof Error && /^stale claim\b/.test(err.message));

/**
 * Programmer error, not a lost claim: a queue write on the job row from INSIDE
 * that job's own fenced transaction. The transaction holds the row FOR SHARE
 * and the queue write needs FOR NO KEY UPDATE on another pooled connection —
 * each would wait for the other and Postgres cannot see the cycle. Thrown
 * synchronously before any SQL (spec §4.3).
 */
export class ClaimTxMisuseError extends Error {
	constructor(jobId: number, op: string, where: string) {
		super(`claim misuse: ${op} on job ${jobId} inside its own fenced transaction (${where}) would self-deadlock`);
		this.name = 'ClaimTxMisuseError';
	}
}

/** A single bounded queue write (a web request's cancel) could not take its row lock in time. */
export class QueueLockTimeoutError extends Error {
	readonly code = '55P03';
	constructor(where: string, lockTimeoutMs: number) {
		super(`queue row busy: ${where} could not lock the job row within ${lockTimeoutMs} ms`);
		this.name = 'QueueLockTimeoutError';
	}
}

/**
 * A queue writer kept hitting its lock timeout past the total deadline. Every
 * code-path holder of a job row lock is capped below that deadline, so this
 * means a lock held from OUTSIDE this codebase; the worker exits and its
 * startup reclaim resolves the row (spec §4.3 last resort).
 */
export class QueueWriteUnrecoverableError extends Error {
	constructor(
		readonly jobId: number | null,
		readonly where: string,
		readonly elapsedMs: number
	) {
		super(
			`queue row ${jobId ?? '?'} could not be written for ${Math.round(elapsedMs / 1000)} s (${where})`
		);
		this.name = 'QueueWriteUnrecoverableError';
	}
}

// ── bounds ──────────────────────────────────────────────────────────────────

/**
 * H = 120 s is the largest code-path cap on a transaction that holds a job row
 * (withClaimTx); the queue writers retry 15 s lock_timeout attempts until
 * D = H + 30 s, so the holder is always terminated by Postgres before a writer
 * gives up. Every other holder is capped below H: the tag engine's 20 s / 30 s,
 * retryFamilyGaps' jobs-TABLE lock 30 s, and each queue writer's own
 * micro-transaction 30 s (it may lock several statements' worth of rows — a
 * successor INSERT can wait on the dedup index — so its DURATION is capped,
 * not only each lock wait; CODEX1 Phase A review #2).
 */
export interface ClaimBounds {
	/** Per-attempt lock_timeout of a queue writer's micro-transaction. */
	lockTimeoutMs: number;
	/** Total retry deadline of a queue writer, from its first attempt. */
	deadlineMs: number;
	/** transaction_timeout of each queue-writer micro-transaction (a holder cap ≤ H). */
	queueTxTimeoutMs: number;
	/** transaction_timeout of every withClaimTx transaction (the holder cap H). */
	claimTxTimeoutMs: number;
	/** transaction_timeout of retryFamilyGaps' LOCK TABLE jobs transaction. */
	jobsTableLockTxTimeoutMs: number;
}
export const CLAIM_BOUNDS: Readonly<ClaimBounds> = Object.freeze({
	lockTimeoutMs: 15_000,
	deadlineMs: 150_000,
	queueTxTimeoutMs: 30_000,
	claimTxTimeoutMs: 120_000,
	jobsTableLockTxTimeoutMs: 30_000
});
interface BoundsOverride extends Partial<ClaimBounds> {
	/** Test observation: called once per lock-timed-out queue-write attempt. */
	onLockTimeout?: (where: string) => void;
}
const boundsOverride = new AsyncLocalStorage<BoundsOverride>();

/** Tests only: run `fn` with scaled bounds, scoped to its async context (no global mutation). */
export function withClaimBoundsForTest<T>(b: BoundsOverride, fn: () => Promise<T>): Promise<T> {
	return boundsOverride.run(b, fn);
}

export function claimBounds(): ClaimBounds {
	const o = boundsOverride.getStore();
	return o ? { ...CLAIM_BOUNDS, ...o } : CLAIM_BOUNDS;
}

/** Interpolated into SET LOCAL (which takes no bind parameters): integers only. */
const msSetting = (ms: number) => `${Math.max(1, Math.round(ms))}ms`;

// ── the fenced-transaction scope (self-deadlock guard) ─────────────────────

const claimTxContext = new AsyncLocalStorage<{ jobId: number; where: string }>();

/** Queue writers call this first, synchronously: refuse a write on the row this execution holds FOR SHARE. */
export function assertNotInOwnClaimTx(jobId: number, op: string): void {
	const scope = claimTxContext.getStore();
	if (scope?.jobId === jobId) throw new ClaimTxMisuseError(jobId, op, scope.where);
}

/** Enter the fenced-transaction scope for `fn` (withClaimTx, withTagWriteTx). No-op without a claim. */
export function runInClaimTxScope<T>(where: string, fn: () => Promise<T>): Promise<T> {
	const claim = heldClaim();
	return claim ? claimTxContext.run({ jobId: claim.jobId, where }, fn) : fn();
}

// ── checkpoints ─────────────────────────────────────────────────────────────

/**
 * Throw StaleClaimError unless the held claim is still the live running claim.
 * No-op without a claim. A plain PK read, no lock: the checkpoint before a
 * NON-transactional effect (Phase B places these before provider requests).
 * Deliberately not updateProgress: it must not move the heartbeat or read as a
 * unit boundary. Allowed inside a fenced transaction (it locks nothing).
 */
export async function assertClaimHeld(where = 'checkpoint'): Promise<void> {
	const claim = heldClaim();
	if (!claim) return;
	const r = await query(`SELECT 1 FROM jobs WHERE id = $1 AND status = 'running' AND claim_seq = $2`, [
		claim.jobId,
		claim.claimSeq
	]);
	if (!r.rowCount) throw new StaleClaimError(claim.jobId, where);
}

/**
 * Inside an open transaction on `client`: lock the job row FOR SHARE and
 * verify the held claim, so the check and the transaction's writes commit
 * atomically — a transition (FOR NO KEY UPDATE) of that row waits for our
 * COMMIT/ROLLBACK, and one that committed first makes this find no row
 * (READ COMMITTED re-evaluates the new version) or raise 40001 (REPEATABLE
 * READ). No-op without a claim.
 *
 * Issues NO `SET LOCAL` of any kind: it runs inside transactions whose caps
 * are already set (withTagWriteTx 20 s / 30 s) and a later SET LOCAL would
 * overwrite them. Only withClaimTx and withTagWriteTx may call it (the
 * discovery test enforces the owners).
 */
export async function assertClaimHeldTx(client: pg.PoolClient, where = 'transaction'): Promise<void> {
	const claim = heldClaim();
	if (!claim) return;
	let r: pg.QueryResult;
	try {
		r = await client.query(
			`SELECT 1 FROM jobs WHERE id = $1 AND status = 'running' AND claim_seq = $2 FOR SHARE`,
			[claim.jobId, claim.claimSeq]
		);
	} catch (err) { // stale-safe: maps 40001 to StaleClaimError, rethrows everything else
		// REPEATABLE READ: the row changed after this transaction's snapshot —
		// the claim died under us. Never retried into a successful write.
		if ((err as { code?: string } | null)?.code === '40001') throw new StaleClaimError(claim.jobId, where);
		throw err;
	}
	if (!r.rowCount) throw new StaleClaimError(claim.jobId, where);
}

/**
 * A business-write transaction fenced to the held claim. Under a claim: its
 * OWN transaction — optional SET TRANSACTION (must precede any query), the
 * 120 s holder cap (set here and only here), then assertClaimHeldTx FIRST,
 * then `fn` inside the fenced-transaction scope (a queue write on this job
 * from `fn` throws ClaimTxMisuseError instead of deadlocking). Without a
 * claim it is exactly withTransaction (plus the requested isolation).
 */
export async function withClaimTx<T>(
	fn: (client: pg.PoolClient) => Promise<T>,
	opts: { isolation?: 'REPEATABLE READ'; where?: string } = {}
): Promise<T> {
	const claim = heldClaim();
	const where = opts.where ?? 'claim transaction';
	return withTransaction(async (client) => {
		if (opts.isolation) await client.query(`SET TRANSACTION ISOLATION LEVEL ${opts.isolation}`);
		if (!claim) return fn(client);
		await client.query(`SET LOCAL transaction_timeout = '${msSetting(claimBounds().claimTxTimeoutMs)}'`);
		await assertClaimHeldTx(client, where);
		return claimTxContext.run({ jobId: claim.jobId, where }, () => fn(client));
	});
}

/**
 * One autocommit business write fenced to the held claim: without a claim
 * exactly `query(text, params)`; under a claim the same statement inside its
 * own withClaimTx (assert first, atomic with the write).
 */
export async function claimFencedQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
	text: string,
	params: unknown[],
	where = 'fenced write'
): Promise<pg.QueryResult<T>> {
	if (!heldClaim()) return query<T>(text, params);
	return withClaimTx((client) => client.query<T>(text, params as never[]), { where });
}

// ── bounded queue writes ────────────────────────────────────────────────────

const isLockTimeout = (err: unknown) => (err as { code?: string } | null)?.code === '55P03';
/** 25P04: Postgres ended the micro-transaction at its transaction_timeout — nothing committed. */
const isTxTimeout = (err: unknown) => (err as { code?: string } | null)?.code === '25P04';

/**
 * A queue write on a job row, inside a micro-transaction with a scoped
 * `SET LOCAL lock_timeout` and `transaction_timeout` (never pool-wide: that
 * would govern every web query). On a lock timeout (55P03) or the
 * transaction cap (25P04) the whole transaction rolled back (nothing durable)
 * and is retried immediately — the wait IS the lock wait — until the
 * deadline, then QueueWriteUnrecoverableError. `retry: false` (a web
 * request's cancel) makes one attempt and throws QueueLockTimeoutError.
 */
export async function boundedQueueWrite<T>(
	jobId: number | null,
	where: string,
	fn: (client: pg.PoolClient) => Promise<T>,
	opts: { retry: boolean } = { retry: true }
): Promise<T> {
	const b = claimBounds();
	const startedAt = Date.now();
	for (;;) {
		try {
			return await withTransaction(async (client) => {
				await client.query(`SET LOCAL lock_timeout = '${msSetting(b.lockTimeoutMs)}'`);
				await client.query(`SET LOCAL transaction_timeout = '${msSetting(b.queueTxTimeoutMs)}'`);
				return fn(client);
			});
		} catch (err) { // stale-safe: rethrows everything but a lock or transaction timeout
			if (!isLockTimeout(err) && !isTxTimeout(err)) throw err;
			boundsOverride.getStore()?.onLockTimeout?.(where);
			if (!opts.retry) throw new QueueLockTimeoutError(where, b.lockTimeoutMs);
			const elapsed = Date.now() - startedAt;
			if (elapsed >= b.deadlineMs) throw new QueueWriteUnrecoverableError(jobId, where, elapsed);
		}
	}
}
