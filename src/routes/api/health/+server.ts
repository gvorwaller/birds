import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dbHealthCheck } from '$lib/db';
import { galleryHealth } from '$server/gallery';
import { workerHealth } from '$server/jobs';

const VERSION = __GIT_SHA__;

export const GET: RequestHandler = async () => {
	const [dbOk, gallerySource] = await Promise.all([dbHealthCheck(), galleryHealth()]);
	const db = dbOk ? 'ok' : 'error';

	// Worker heartbeat from worker_status. Must never throw — before migration
	// 0015 (or before the worker's first boot) this reports 'never'.
	let worker: 'ok' | 'stale' | 'never' = 'never';
	try {
		const w = await workerHealth();
		worker = w.alive ? 'ok' : w.heartbeatAt ? 'stale' : 'never';
	} catch {
		worker = 'never';
	}

	// db gates the endpoint status; worker is gated by the DEPLOY script (a
	// dead worker must fail deploys loudly, but must not 503 normal traffic).
	const status = db === 'ok' ? 200 : 503;

	return json({ db, worker, gallery_source: gallerySource, version: VERSION }, { status });
};
