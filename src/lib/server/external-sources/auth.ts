/**
 * Connector authentication for /api/ingest/ (td-eec7db Phase 1, [C-P2-6]).
 *
 * A connector token is `ext_` + 32 random bytes (base64url). Only its SHA-256
 * is stored (external_connectors.token_sha256), and the source a connector
 * may write to comes from that row, never from the request body. A revoked
 * token or an inactive source is refused on every call.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { query, withTransaction } from '$lib/db';
import { isConnectorVersion, parseConnectorStarted } from '$lib/connector-health-policy';

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
 * What a connector says about itself in its headers (td-afba28): its build
 * version and process start. A value that isn't believable is null, and a
 * null never overwrites what was stored; it never refuses the call.
 */
export function connectorMeta(request: Request): { version: string | null; startedAt: Date | null } {
	const v = request.headers.get('x-connector-version');
	return {
		version: isConnectorVersion(v) ? v : null,
		startedAt: parseConnectorStarted(request.headers.get('x-connector-started'))
	};
}

/**
 * Looks the token up by its hash. Runs before the body is read or parsed.
 * Also records `last_seen_at` (at most every 5 s, so polling stays cheap), the
 * reported version and start, and — that check-in being proof the connector
 * is back — closes its source's open outage at that moment (td-afba28 [C-1]).
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
	const meta = connectorMeta(request);
	await recordCheckIn(row.id, row.source_id, meta);
	return {
		ok: true,
		connector: { connectorId: Number(row.id), sourceId: row.source_id, storeObservers: row.store_observers }
	};
}

/**
 * A check-in, and the end of its source's open outage, in one transaction
 * (td-afba28). It counts only while the token is still unrevoked and the
 * source still on when it is written — a revoke or switch-off committing
 * after the lookup above makes it a no-op (CODEX1 code review #3): the
 * source row is held FOR SHARE (a switch-off waits, or is seen), and a revoke
 * of the token row is re-checked by the UPDATE itself.
 *
 * The outage close is a separate statement after the token is locked and
 * written, on purpose: when the worker's outage check holds this token row,
 * the lock waits for it, and the close then sees the outage it just opened
 * (refresh.ts watchConnectors).
 * Throttled: at most every 5 s per token, so polling stays cheap.
 */
export async function recordCheckIn(
	connectorId: string,
	sourceId: string,
	meta: { version: string | null; startedAt: Date | null },
	/** Tests: runs once the source row is held, before the token is written. */
	afterSourceLock?: () => Promise<void>
): Promise<void> {
	const due = await query(
		`SELECT 1 FROM external_connectors WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 seconds')`,
		[connectorId]
	);
	if (!due.rowCount) return;
	await withTransaction(async (c) => {
		const on = await c.query(`SELECT 1 FROM external_sources WHERE id = $1 AND active FOR SHARE`, [sourceId]);
		if (!on.rowCount) return;
		if (afterSourceLock) await afterSourceLock();
		// The token row locked first (a load step holding it FOR SHARE, or the
		// worker's outage check, can make this wait); only then is the time
		// read, so a long wait can't record a stale check-in that makes a real
		// recovery look old (CODEX1 round 6).
		const due = await c.query(
			`SELECT 1 FROM external_connectors
			  WHERE id = $1 AND revoked_at IS NULL AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 seconds')
			    FOR UPDATE`,
			[connectorId]
		);
		if (!due.rowCount) return;
		await c.query(
			`UPDATE external_connectors
			    SET last_seen_at = clock_timestamp(), version = COALESCE($2, version), started_at = COALESCE($3, started_at)
			  WHERE id = $1`,
			[connectorId, meta.version, meta.startedAt]
		);
		// Closed at that same moment, read back from the row (a JavaScript Date
		// would drop the microseconds): never before the outage was detected
		// (CODEX1 round 5), and the recovering check-in is exactly its end.
		await c.query(
			`UPDATE external_connector_outages
			    SET closed_at = (SELECT last_seen_at FROM external_connectors WHERE id = $2), closed_reason = 'back_online'
			  WHERE source_id = $1 AND closed_at IS NULL`,
			[sourceId, connectorId]
		);
	});
}
