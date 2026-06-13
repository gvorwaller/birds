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
			application_name: 'birds-app'
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
