/**
 * The ONE executable path for every tag-affecting transaction (td-894144
 * Release B, plan rev 18 §B2): both wiki entry points, replaceTaxonomy,
 * activation, rollback and consistency batches.
 *
 *   preAttemptNo := begin_tag_attempt()                 -- autocommit, before BEGIN
 *   BEGIN; SET LOCAL lock_timeout/statement_timeout/transaction_timeout
 *   pg_advisory_xact_lock[_shared](TAG_ENGINE_KEY)      -- 1st work statement
 *   pg_advisory_xact_lock(TAG_FAILKEY_NS, hash(key))    -- 2nd: serialize this key
 *   postAttemptNo := begin_tag_attempt()                -- 3rd
 *   fn(tx); clear_materialization_failure(key, post); COMMIT
 *   on error: stamp with post if it was allocated, else pre (follow-up txn)
 *
 * Lock order is fixed — engine lock, exactly one key lock, then rows — so no
 * cycle is possible. A `TagWriteTx` can only be obtained here (branded type;
 * the static guard rejects any other construction), so an entry point cannot
 * be called without the lock.
 */
import type pg from 'pg';
import { query, withTransaction } from '$lib/db';
import { sanitizeErrorText } from '$server/job-policy';

/** Advisory lock key for the whole tag engine (single-bigint form). */
export const TAG_ENGINE_KEY = 894144n;
/** Namespace for per-failure-key locks (two-int4 form, distinct space). */
export const TAG_FAILKEY_NS = 894145;

const TX_CAP = { shared: '20s', exclusive: '30s' } as const;

type Exec = <T extends pg.QueryResultRow = pg.QueryResultRow>(
	text: string,
	params?: unknown[]
) => Promise<{ rows: T[]; rowCount?: number | null }>;

/**
 * Throw this from inside withTagWriteTx to roll the transaction back ON
 * PURPOSE (dry runs, benchmarks). It is not a materialization failure, so
 * nothing is recorded in tag_materialization_failure.
 */
export class TagTxRollback extends Error {
	constructor() {
		super('intentional rollback');
		this.name = 'TagTxRollback';
	}
}

/**
 * An expected refusal inside withTagWriteTx (a stale claim, data that moved
 * under a Preview): rolled back like TagTxRollback, so it is NOT recorded as a
 * materialization failure, but it carries the reason to the caller.
 */
export class TagTxRefusal extends TagTxRollback {
	constructor(readonly reason: string) {
		super();
		this.name = 'TagTxRefusal';
		this.message = reason;
	}
}

declare const tagWriteTxBrand: unique symbol;

/** A transaction that holds the tag-engine lock. Only withTagWriteTx makes one. */
export interface TagWriteTx {
	readonly [tagWriteTxBrand]: true;
	readonly mode: 'shared' | 'exclusive';
	readonly client: pg.PoolClient;
	readonly exec: Exec;
	readonly postAttemptNo: bigint;
}

async function beginAttempt(exec: Exec): Promise<bigint> {
	const r = await exec<{ n: string }>('SELECT public.begin_tag_attempt() AS n');
	return BigInt(r.rows[0].n);
}

export async function withTagWriteTx<T>(
	mode: 'shared' | 'exclusive',
	failureKey: string,
	entryPoint: string,
	fn: (tx: TagWriteTx) => Promise<T>,
	opts: { speciesCode?: string | null } = {}
): Promise<T> {
	const autocommit: Exec = ((text, params) => query(text, params)) as Exec;
	const preAttemptNo = await beginAttempt(autocommit);
	let postAttemptNo: bigint | null = null;
	try {
		return await withTransaction(async (client) => {
			const exec: Exec = ((text, params) => client.query(text, params as never[])) as Exec;
			await client.query(`SET LOCAL lock_timeout = '10s'`);
			await client.query(`SET LOCAL statement_timeout = '60s'`);
			await client.query(`SET LOCAL transaction_timeout = '${TX_CAP[mode]}'`);
			await client.query(
				mode === 'shared'
					? 'SELECT pg_advisory_xact_lock_shared($1::bigint)'
					: 'SELECT pg_advisory_xact_lock($1::bigint)',
				[TAG_ENGINE_KEY.toString()]
			);
			await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [TAG_FAILKEY_NS, failureKey]);
			postAttemptNo = await beginAttempt(exec);
			const tx = { mode, client, exec, postAttemptNo } as unknown as TagWriteTx;
			const result = await fn(tx);
			await client.query('SELECT public.clear_materialization_failure($1, $2)', [
				failureKey,
				postAttemptNo.toString()
			]);
			return result;
		});
	} catch (err) {
		if (err instanceof TagTxRollback) throw err;
		// Mechanical token rule (rev 18): post if allocated, else pre.
		const token = postAttemptNo ?? preAttemptNo;
		try {
			await query('SELECT public.record_materialization_failure($1, $2, $3, $4, $5)', [
				failureKey,
				opts.speciesCode ?? null,
				entryPoint,
				sanitizeErrorText(err instanceof Error ? err.message : String(err)).slice(0, 500),
				token.toString()
			]);
		} catch {
			/* recording is best-effort; the original error is what matters */
		}
		throw err;
	}
}
