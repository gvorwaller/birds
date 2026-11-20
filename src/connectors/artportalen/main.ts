/**
 * birds-connector-artportalen (td-99eebf): the Sweden connector, a PM2 app of
 * its own. It never touches the database; it reads Artportalen through SLU's
 * Species Observation System API and talks to the app only through
 * /api/ingest/.
 *
 * Its env file (CONNECTOR_ENV_FILE) holds INGEST_URL and INGEST_TOKEN
 * (scripts/connector-token.mjs) plus ARTPORTALEN_API_KEY. The file is read
 * again before every claim, so a new or rotated token or key takes effect
 * without a restart. Without BOTH secrets it idles before claiming and stays
 * healthy (plan [C1-6]): a load is never claimed that it couldn't read.
 *
 *   --once   claim at most one load, run it, and exit (local verification).
 */
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { abortableSleep } from '../shared/http';
import { IngestCallError, IngestClient, ingestBase } from '../shared/ingest';
import { CLAIM_EVERY_MS, NO_TOKEN_RECHECK_MS } from '../shared/limits';
import { SosClient } from './sos';
import { runLoad } from './run';

declare const __GIT_SHA__: string;
const VERSION = typeof __GIT_SHA__ === 'string' ? __GIT_SHA__ : 'dev';

function log(event: string, fields: Record<string, unknown> = {}): void {
	console.log(`[connector-se] ${JSON.stringify({ event, ...fields })}`);
}

interface Settings {
	base: URL | null;
	token: string | null;
	key: string | null;
	problem: string | null;
}

export function readSettings(text: string | null, file: string): Settings {
	if (text === null) return { base: null, token: null, key: null, problem: `no env file at ${file}` };
	const env = new Map<string, string>();
	for (const line of text.split('\n')) {
		const i = line.indexOf('=');
		if (i > 0 && !line.trimStart().startsWith('#')) env.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
	}
	const base = ingestBase(env.get('INGEST_URL'));
	const token = env.get('INGEST_TOKEN') ?? '';
	const key = env.get('ARTPORTALEN_API_KEY') ?? '';
	if (!base) return { base: null, token: null, key: null, problem: 'INGEST_URL is missing or is not an …/api/ingest/ URL' };
	if (!/^ext_[A-Za-z0-9_-]{20,}$/.test(token)) return { base, token: null, key: null, problem: 'INGEST_TOKEN is missing' };
	if (!/^[A-Za-z0-9]{16,128}$/.test(key)) return { base, token, key: null, problem: 'ARTPORTALEN_API_KEY is missing' };
	return { base, token, key, problem: null };
}

function readEnvFile(file: string): string | null {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const envFile = process.env.CONNECTOR_ENV_FILE;
	if (!envFile) {
		console.error('[connector-se] FATAL: CONNECTOR_ENV_FILE is not set');
		process.exit(1);
	}
	const once = process.argv.includes('--once');
	const stop = new AbortController();
	const shutdown = (sig: string) => {
		if (stop.signal.aborted) return;
		log('stopping', { signal: sig });
		stop.abort(new Error('shutdown'));
		// PM2's kill_timeout is the backstop; this one lets fail() go out first.
		setTimeout(() => process.exit(0), 12_000).unref();
	};
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));

	const claimPrefix = `${hostname().replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 40)}-${process.pid}`;
	let lastProblem: string | null = null;
	log('started', { version: VERSION, env_file: envFile, once });

	while (!stop.signal.aborted) {
		const s = readSettings(readEnvFile(envFile), envFile);
		if (!s.base || !s.token || !s.key) {
			if (s.problem !== lastProblem) log('idle', { reason: s.problem });
			lastProblem = s.problem;
			if (once) break;
			await abortableSleep(NO_TOKEN_RECHECK_MS, stop.signal).catch(() => {});
			continue;
		}
		if (lastProblem !== null) log('ready', { ingest: s.base.origin });
		lastProblem = null;
		const ingest = new IngestClient(s.base, s.token);
		const sos = new SosClient(s.key);
		let wait = CLAIM_EVERY_MS;
		try {
			// One key per claim; the client retries a lost answer with the same key.
			const load = await ingest.claim(`${claimPrefix}-${randomUUID()}`, stop.signal);
			if (load) {
				await runLoad({ sos, ingest, log }, load, stop.signal);
				wait = 0;
			} else if (once) {
				log('no_work');
				break;
			}
		} catch (err) {
			if (stop.signal.aborted) break;
			const message = err instanceof Error ? err.message : String(err);
			if (err instanceof IngestCallError && err.status === 401) {
				lastProblem = `the app refused the token (${err.code})`;
				log('idle', { reason: lastProblem });
				wait = NO_TOKEN_RECHECK_MS;
			} else log('claim_failed', { error: message });
		}
		if (once) break;
		if (wait > 0) await abortableSleep(wait, stop.signal).catch(() => {});
	}
	log('stopped');
	process.exit(0);
}

if (process.env.VITEST !== 'true') void main();
