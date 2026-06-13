import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dbHealthCheck } from '$lib/db';
import { galleryHealth } from '$server/gallery';

const VERSION = process.env.GIT_SHA ?? 'dev';

export const GET: RequestHandler = async () => {
	const [dbOk, gallerySource] = await Promise.all([dbHealthCheck(), galleryHealth()]);
	const db = dbOk ? 'ok' : 'error';

	// Only db gates deploys; gallery_source is informational (stale cache is fine).
	const status = db === 'ok' ? 200 : 503;

	return json({ db, gallery_source: gallerySource, version: VERSION }, { status });
};
