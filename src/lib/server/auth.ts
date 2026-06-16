import argon2 from 'argon2';
import { query } from '$lib/db';

const ARGON2_OPTS: argon2.Options & { raw?: false } = {
	type: argon2.argon2id,
	memoryCost: 19456,
	timeCost: 2,
	parallelism: 1
};

export async function hashPassword(password: string): Promise<string> {
	return argon2.hash(password, ARGON2_OPTS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
	try {
		return await argon2.verify(hash, password);
	} catch {
		return false;
	}
}

export type UserRole = 'admin' | 'user' | 'viewer';

export interface DbUser {
	id: number;
	username: string;
	display_name: string;
	role: UserRole;
	password_hash: string;
	home_lat: number | null;
	home_lon: number | null;
	last_login_at: string | null;
}

let cachedOwnerId: number | null = null;

/** The single admin/owner whose data the app surfaces. Cached (never changes). */
export async function getOwnerId(): Promise<number> {
	if (cachedOwnerId != null) return cachedOwnerId;
	const r = await query<{ id: number }>(
		"SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1"
	);
	if (!r.rows[0]) throw new Error('No admin/owner user exists');
	cachedOwnerId = r.rows[0].id;
	return cachedOwnerId;
}

export async function findUserByUsername(username: string): Promise<DbUser | null> {
	const res = await query<DbUser>(
		`SELECT id, username, display_name, role, password_hash, home_lat, home_lon, last_login_at
		   FROM users WHERE username = $1`,
		[username]
	);
	return res.rows[0] ?? null;
}

export async function recordLogin(userId: number): Promise<void> {
	await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [userId]);
}
