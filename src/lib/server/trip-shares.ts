/**
 * Public trip share links (td-8b959f follow-up).
 *
 * This is deliberately the ONLY module allowed to read a trip without the
 * userId scoping every trips.ts query enforces — `tripForToken` trades the
 * cookie credential for the token credential (unguessable 32-byte value,
 * revocable, one active per trip by partial unique index). Everything else
 * here re-checks ownership even when the caller already did: these are the
 * writes that decide who can see a trip.
 */
import { randomBytes } from 'node:crypto';
import { query, withTransaction } from '$lib/db';
import type { Trip } from '$server/trips';

/**
 * Create (or regenerate) the share link for a trip the user owns. Returns
 * the new token, or null when the trip isn't theirs — the ownership check
 * runs FIRST, before any write.
 */
export async function createShare(userId: number, tripId: number): Promise<string | null> {
	const owned = await query(`SELECT 1 FROM trips WHERE id = $1 AND user_id = $2`, [
		tripId,
		userId
	]);
	if (owned.rows.length === 0) return null;
	const token = randomBytes(32).toString('base64url');
	// Revoke-then-insert in one transaction: the partial unique index
	// (one ACTIVE share per trip) would reject the insert otherwise, and a
	// half-done regenerate must not leave the trip with no working link.
	await withTransaction(async (client) => {
		await client.query(
			`UPDATE trip_shares SET revoked_at = NOW() WHERE trip_id = $1 AND revoked_at IS NULL`,
			[tripId]
		);
		await client.query(`INSERT INTO trip_shares (token, trip_id) VALUES ($1, $2)`, [
			token,
			tripId
		]);
	});
	return token;
}

export async function getActiveShare(
	userId: number,
	tripId: number
): Promise<{ token: string; created_at: string } | null> {
	const r = await query<{ token: string; created_at: string }>(
		`SELECT s.token, s.created_at::text AS created_at
		   FROM trip_shares s JOIN trips t ON t.id = s.trip_id
		  WHERE s.trip_id = $1 AND t.user_id = $2 AND s.revoked_at IS NULL`,
		[tripId, userId]
	);
	return r.rows[0] ?? null;
}

/** Revoke the active share. False when there was none (or not their trip). */
export async function revokeShare(userId: number, tripId: number): Promise<boolean> {
	const r = await query(
		`UPDATE trip_shares s SET revoked_at = NOW()
		   FROM trips t
		  WHERE s.trip_id = t.id AND t.id = $1 AND t.user_id = $2
		    AND s.revoked_at IS NULL`,
		[tripId, userId]
	);
	return (r.rowCount ?? 0) > 0;
}

/**
 * Resolve a share token to its trip — the public page's credential exchange.
 * A single PK lookup on an unguessable value; revoked tokens are dead.
 */
export async function tripForToken(token: string): Promise<Trip | null> {
	const r = await query<Trip>(
		`SELECT t.id, t.user_id, t.name, t.start_date::text AS start_date,
		        t.end_date::text AS end_date, t.notes, t.created_at::text AS created_at
		   FROM trip_shares s JOIN trips t ON t.id = s.trip_id
		  WHERE s.token = $1 AND s.revoked_at IS NULL`,
		[token]
	);
	return r.rows[0] ?? null;
}
