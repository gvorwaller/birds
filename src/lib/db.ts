import pg from 'pg';
import { env } from '$env/dynamic/private';

const { Pool } = pg;

let pool: pg.Pool | undefined;

function getPool(): pg.Pool {
	if (!pool) {
		pool = new Pool({
			host: env.PGHOST ?? '127.0.0.1',
			port: Number(env.PGPORT ?? 5436),
			database: env.PGDATABASE ?? 'birds',
			user: env.PGUSER ?? 'birds_app',
			password: env.PGPASSWORD,
			max: 10,
			idleTimeoutMillis: 30_000,
			// The worker process sets BIRDS_DB_APP_NAME before its first query so
			// its claims/progress/handler traffic is distinguishable from web
			// traffic in pg_stat_activity (CODEX1 re-review #6).
			application_name: env.BIRDS_DB_APP_NAME ?? 'birds-app'
		});
	}
	return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
	text: string,
	params?: unknown[]
): Promise<pg.QueryResult<T>> {
	return getPool().query<T>(text, params as never);
}

/**
 * Query with a HARD client-side deadline covering BOTH pool acquisition and
 * query execution (node-postgres query_timeout arms only inside
 * Client.query, so pool.query alone can wait forever on checkout — CODEX1).
 * For deadline-bounded writes (need-alert scan budget) where an unbounded
 * await would wedge the caller's wall-clock guarantee.
 *
 * - Acquisition is raced against the deadline. Losing does NOT abandon the
 *   pending checkout: a late-arriving clean client is released back to the
 *   pool untouched (no query was ever issued on it).
 * - The query itself gets the REMAINING interval as query_timeout; on any
 *   error/timeout the client is destroyed (release(err)), never reused in
 *   an unknown state.
 */
export async function queryTimed<T extends pg.QueryResultRow = pg.QueryResultRow>(
	text: string,
	params: unknown[] | undefined,
	timeoutMs: number
): Promise<pg.QueryResult<T>> {
	const deadlineAt = Date.now() + Math.max(1, Math.round(timeoutMs));
	const connectP = getPool().connect();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const acquired = await Promise.race([
		connectP.then((client) => ({ client })),
		new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), Math.max(1, deadlineAt - Date.now()));
		})
	]).finally(() => clearTimeout(timer));
	if (acquired === 'timeout') {
		// Safe late-acquisition cleanup: the checkout may still complete later —
		// hand the (clean, never-queried) client straight back; swallow a
		// connect rejection.
		connectP.then(
			(client) => client.release(),
			() => {}
		);
		throw new Error(`queryTimed: pool acquisition exceeded ${timeoutMs}ms`);
	}
	const client = acquired.client;
	let ok = false;
	try {
		const remaining = Math.max(1, deadlineAt - Date.now());
		const r = await client.query<T>({
			text,
			values: params as never,
			query_timeout: remaining
		} as never);
		ok = true;
		return r;
	} finally {
		client.release(ok ? undefined : new Error('queryTimed: discarding client after error/timeout'));
	}
}

/**
 * Run `fn` inside a single transaction on a dedicated pooled client.
 * Commits on success, rolls back and rethrows on any error, always releasing
 * the client. Use for multi-statement atomic writes (imports, photo-link sync).
 */
export async function withTransaction<T>(
	fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
	const client = await getPool().connect();
	try {
		await client.query('BEGIN');
		const result = await fn(client);
		await client.query('COMMIT');
		return result;
	} catch (err) {
		try {
			await client.query('ROLLBACK');
		} catch {
			/* ROLLBACK failure is secondary */
		}
		throw err;
	} finally {
		client.release();
	}
}

export async function dbHealthCheck(): Promise<boolean> {
	try {
		const r = await query<{ one: number }>('SELECT 1 AS one');
		return r.rows[0]?.one === 1;
	} catch {
		return false;
	}
}
