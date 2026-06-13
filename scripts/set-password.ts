#!/usr/bin/env npx tsx
// Set/update a user's password (interactive).
// Usage: npx tsx --env-file=.env.test scripts/set-password.ts
import argon2 from 'argon2';
import pg from 'pg';
import * as readline from 'readline';

const ARGON2_OPTS: argon2.Options & { raw?: false } = {
	type: argon2.argon2id,
	memoryCost: 19456,
	timeCost: 2,
	parallelism: 1
};

async function prompt(question: string): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

async function main() {
	const pool = new pg.Pool({
		host: process.env.PGHOST ?? '127.0.0.1',
		port: Number(process.env.PGPORT ?? 5436),
		database: process.env.PGDATABASE ?? 'birds',
		user: process.env.PGUSER ?? 'birds_app',
		password: process.env.PGPASSWORD
	});

	const users = await pool.query<{ id: number; username: string; role: string }>(
		'SELECT id, username, role FROM users ORDER BY id'
	);

	console.log('\nUsers:');
	for (const u of users.rows) {
		console.log(`  ${u.username} (${u.role})`);
	}
	console.log('');

	for (const u of users.rows) {
		const password = await prompt(`Password for ${u.username} (blank to skip): `);
		if (!password) {
			console.log(`  Skipped ${u.username}`);
			continue;
		}
		const hash = await argon2.hash(password, ARGON2_OPTS);
		await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, u.id]);
		console.log(`  Updated ${u.username}`);
	}

	await pool.end();
	console.log('\nDone.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
