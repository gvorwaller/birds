/**
 * birds-worker — the dedicated eBird load process (PM2 app `birds-worker`).
 * Plan: docs/2026-08-15-ebird-worker-job-queue-plan.md §5.
 *
 * Startup: env guards → advisory lock (GLOBAL single-worker guarantee,
 * CODEX1 #3 — PM2 instances:1 is not a lock) → startup reclaim → status row →
 * poll loop. Termination has ONE path per cause (GROK #6): SIGTERM/SIGINT
 * drain (in-flight job requeued with the attempt refunded), crash → next
 * boot's reclaim.
 */
// Before ANY import that could touch the shared pool: the pool is created
// lazily on first query and reads env then, so setting this here makes every
// worker connection identify as birds-worker in pg_stat_activity (CODEX1
// re-review #6). The dedicated lock client below stays birds-worker-lock.
process.env.BIRDS_DB_APP_NAME = 'birds-worker';

import pg from 'pg';
import { claimNextJob, markWorkerStarted, bumpWorkerHeartbeat, setWorkerStatus, reclaimStartupJobs, pruneHistory } from '$server/jobs';
import { runJob, ensureNeedAlertScan, ensureEnrichmentScan } from '$server/job-handlers';

declare const __GIT_SHA__: string;
const VERSION = typeof __GIT_SHA__ === 'string' ? __GIT_SHA__ : 'dev';

const POLL_IDLE_MS = 2_000;
const HEARTBEAT_MS = 10_000;
/** Arbitrary but stable app-scoped advisory lock id for "the birds worker". */
const WORKER_LOCK_KEY = 0xb15d0001;

function fatal(msg: string): never {
	console.error(`[birds-worker] FATAL: ${msg}`);
	process.exit(1);
}

/** Environment guards (GROK #7): a misloaded env must never aim at the wrong DB. */
function assertEnvironment(): void {
	for (const k of ['PGPASSWORD', 'EBIRD_KEY_SECRET']) {
		if (!process.env[k]) fatal(`missing required env ${k}`);
	}
	const port = Number(process.env.PGPORT ?? 5436);
	const db = process.env.PGDATABASE ?? 'birds';
	const birdsEnv = process.env.BIRDS_ENV ?? '';
	if ([5433, 5434, 5435].includes(port)) {
		fatal(`refusing reserved Postgres port ${port} (sibling apps)`);
	}
	if ((port === 5436 || db === 'birds') && birdsEnv !== 'production') {
		fatal(
			`refusing prod cluster (port ${port}, db ${db}) without BIRDS_ENV=production — set BIRDS_ENV=test for the test cluster`
		);
	}
	if (birdsEnv === 'test' && port !== 15436) {
		fatal(`BIRDS_ENV=test requires the test cluster on 15436 (got ${port})`);
	}
}

async function main(): Promise<void> {
	assertEnvironment();

	// Dedicated connection holding the advisory lock for the process lifetime.
	// A second worker (deploy overlap, operator mistake) fails to acquire and
	// exits — it can neither reclaim a live worker's jobs nor claim new ones.
	const lockClient = new pg.Client({
		host: process.env.PGHOST ?? '127.0.0.1',
		port: Number(process.env.PGPORT ?? 5436),
		database: process.env.PGDATABASE ?? 'birds',
		user: process.env.PGUSER ?? 'birds_app',
		password: process.env.PGPASSWORD,
		application_name: 'birds-worker-lock'
	});
	await lockClient.connect();
	const lock = await lockClient.query<{ locked: boolean }>(
		'SELECT pg_try_advisory_lock($1) AS locked',
		[WORKER_LOCK_KEY]
	);
	if (!lock.rows[0]?.locked) {
		console.error('[birds-worker] another worker holds the lock — exiting');
		await lockClient.end();
		process.exit(0);
	}

	const reclaimed = await reclaimStartupJobs('worker startup');
	if (reclaimed > 0) console.log(`[birds-worker] reclaimed ${reclaimed} interrupted job(s)`);
	await pruneHistory();
	await ensureNeedAlertScan().catch((err) => {
		console.error(
			'[birds-worker] startup scan ensure failed:',
			err instanceof Error ? err.message : err
		);
	});
	await ensureEnrichmentScan().catch((err) => {
		console.error(
			'[birds-worker] startup enrichment ensure failed:',
			err instanceof Error ? err.message : err
		);
	});
	await markWorkerStarted(process.pid, VERSION);
	console.log(`[birds-worker] started pid=${process.pid} version=${VERSION}`);

	let draining = false;
	let currentJobId: number | null = null;
	const ctx = { isDraining: () => draining };

	const drain = (signal: string) => {
		if (draining) return;
		draining = true;
		console.log(`[birds-worker] ${signal} received — draining`);
		void setWorkerStatus(
			{ pid: process.pid, version: VERSION, state: 'draining', currentJobId },
			'drain'
		);
	};
	process.on('SIGTERM', () => drain('SIGTERM'));
	process.on('SIGINT', () => drain('SIGINT'));

	const heartbeat = setInterval(() => {
		bumpWorkerHeartbeat().catch(() => {});
	}, HEARTBEAT_MS);

	for (;;) {
		if (draining) break;
		let job = null;
		try {
			job = await claimNextJob();
		} catch (err) {
			console.error('[birds-worker] claim failed:', err instanceof Error ? err.message : err);
			await new Promise((r) => setTimeout(r, POLL_IDLE_MS));
			continue;
		}
		if (!job) {
			// Idle-tick reconciliation (plan A2): the recurring scan singleton
			// self-heals against ANY lost chain — cheap indexed SELECT.
			await ensureNeedAlertScan().catch((err) => {
				console.error(
					'[birds-worker] scan reconciliation failed:',
					err instanceof Error ? err.message : err
				);
			});
			await ensureEnrichmentScan().catch((err) => {
				console.error(
					'[birds-worker] enrichment reconciliation failed:',
					err instanceof Error ? err.message : err
				);
			});
			await new Promise((r) => setTimeout(r, POLL_IDLE_MS));
			continue;
		}
		currentJobId = job.id;
		await setWorkerStatus(
			{ pid: process.pid, version: VERSION, state: 'working', currentJobId: job.id },
			`job ${job.id} (${job.type})`
		);
		console.log(`[birds-worker] job ${job.id} ${job.type} "${job.label}" attempt ${job.attempts}`);
		await runJob(job, ctx);
		currentJobId = null;
		if (!draining) {
			await setWorkerStatus(
				{ pid: process.pid, version: VERSION, state: 'idle', currentJobId: null }
			);
		}
	}

	clearInterval(heartbeat);
	await setWorkerStatus(
		{ pid: process.pid, version: VERSION, state: 'draining', currentJobId: null },
		'shutdown'
	);
	await lockClient.end();
	console.log('[birds-worker] drained — exiting');
	process.exit(0);
}

main().catch((err) => {
	console.error('[birds-worker] crash:', err);
	process.exit(1);
});
