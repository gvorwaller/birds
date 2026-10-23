/**
 * Connector authentication for /api/ingest/ (td-eec7db Phase 1, [C-P2-6]).
 *
 * A connector token is `ext_` + 32 random bytes (base64url). Only its SHA-256
 * is stored (external_connectors.token_sha256), and the source a connector
 * may write to comes from that row, never from the request body. A revoked
 * token or an inactive source is refused on every call.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { query } from '$lib/db';

export interface Connector {
	connectorId: number;
	sourceId: string;
	storeObservers: boolean;
}

export type AuthFailure = 'missing' | 'unknown' | 'revoked' | 'inactive';

const TOKEN_SHAPE = /^ext_[A-Za-z0-9_-]{43}$/;

export function newConnectorToken(): string {
	return `ext_${randomBytes(32).toString('base64url')}`;
}

export function tokenHash(token: string): Buffer {
	return createHash('sha256').update(token, 'utf8').digest();
}

export function bearerToken(request: Request): string | null {
	const header = request.headers.get('authorization') ?? '';
	const match = header.match(/^Bearer ([^\s]+)$/);
	return match?.[1] ?? null;
}

/**
 * Looks the token up by its hash. Runs before the body is read or parsed.
 * Also records `last_seen_at` (at most every 5 s, so polling stays cheap).
 */
export async function authenticateConnector(
	request: Request
): Promise<{ ok: true; connector: Connector } | { ok: false; reason: AuthFailure }> {
	const token = bearerToken(request);
	if (!token || !TOKEN_SHAPE.test(token)) return { ok: false, reason: token ? 'unknown' : 'missing' };
	const hash = tokenHash(token);
	const r = await query<{
		id: string;
		source_id: string;
		token_sha256: Buffer;
		revoked_at: Date | null;
		active: boolean;
		store_observers: boolean;
	}>(
		`SELECT c.id, c.source_id, c.token_sha256, c.revoked_at, s.active, s.store_observers
		   FROM external_connectors c JOIN external_sources s ON s.id = c.source_id
		  WHERE c.token_sha256 = $1`,
		[hash]
	);
	const row = r.rows[0];
	if (!row || row.token_sha256.length !== hash.length || !timingSafeEqual(row.token_sha256, hash)) {
		return { ok: false, reason: 'unknown' };
	}
	if (row.revoked_at) return { ok: false, reason: 'revoked' };
	if (!row.active) return { ok: false, reason: 'inactive' };
	await query(
		`UPDATE external_connectors SET last_seen_at = now()
		  WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 seconds')`,
		[row.id]
	);
	return {
		ok: true,
		connector: { connectorId: Number(row.id), sourceId: row.source_id, storeObservers: row.store_observers }
	};
}
