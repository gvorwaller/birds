/**
 * birds-connector-artsobs (td-eec7db Phase 2 rev B): the Norway connector, a
 * PM2 app of its own. It never touches the database; it reads Artsobservasjoner
 * through Artskart and talks to the app only through /api/ingest/.
 *
 * Its env file (CONNECTOR_ENV_FILE, written by scripts/connector-token.mjs)
 * holds INGEST_URL and INGEST_TOKEN. The file is read again before every
 * claim, so a new or rotated token takes effect without a restart. With no
 * token it idles and stays healthy (the first prod step deploys it that way).
 *
 *   --once   claim at most one load, run it, and exit (local verification).
 */
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CLAIM_EVERY_MS, NO_TOKEN_RECHECK_MS } from './config';
import { ArtskartClient, abortableSleep } from './artskart';
import { IngestCallError, IngestClient, ingestBase } from './ingest';
import { runLoad } from './run';

declare const __GIT_SHA__: string;
const VERSION = typeof __GIT_SHA__ === 'string' ? __GIT_SHA__ : 'dev';

function log(event: string, fields: Record<string, unknown> = {}): void {
	console.log(`[connector] ${JSON.stringify({ event, ...fields })}`);
}

interface Settings {
	base: URL | null;
	token: string | null;
	problem: string | null;
}

function readSettings(file: string): Settings {
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		return { base: null, token: null, problem: `no env file at ${file}` };
	}
	const env = new Map<string, string>();
	for (const line of text.split('\n')) {
		const i = line.indexOf('=');
		if (i > 0 && !line.trimStart().startsWith('#')) env.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
	}
	const base = ingestBase(env.get('INGEST_URL'));
	const token = env.get('INGEST_TOKEN') ?? '';
	if (!base) return { base: null, token: null, problem: 'INGEST_URL is missing or is not an …/api/ingest/ URL' };
	if (!/^ext_[A-Za-z0-9_-]{20,}$/.test(token)) return { base, token: null, problem: 'INGEST_TOKEN is missing' };
	return { base, token, problem: null };
}

async function main(): Promise<void> {
	const envFile = process.env.CONNECTOR_ENV_FILE;
	if (!envFile) {
		console.error('[connector] FATAL: CONNECTOR_ENV_FILE is not set');
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

	const artskart = new ArtskartClient();
	const claimPrefix = `${hostname().replace(/[^A-Za-z0-9.-]/g, '-').slice(0, 40)}-${process.pid}`;
	let lastProblem: string | null = null;
	log('started', { version: VERSION, env_file: envFile, once });

	while (!stop.signal.aborted) {
		const s = readSettings(envFile);
		if (!s.base || !s.token) {
			if (s.problem !== lastProblem) log('idle', { reason: s.problem });
			lastProblem = s.problem;
			if (once) break;
			await abortableSleep(NO_TOKEN_RECHECK_MS, stop.signal).catch(() => {});
			continue;
		}
		if (lastProblem !== null) log('ready', { ingest: s.base.origin });
		lastProblem = null;
		const ingest = new IngestClient(s.base, s.token);
		let wait = CLAIM_EVERY_MS;
		try {
			// One key per claim; the client retries a lost answer with the same key.
			const load = await ingest.claim(`${claimPrefix}-${randomUUID()}`, stop.signal);
			if (load) {
				await runLoad({ artskart, ingest, log }, load, stop.signal);
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

void main();
