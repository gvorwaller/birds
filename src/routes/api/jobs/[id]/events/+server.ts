import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getJob, jobEvents } from '$server/jobs';

export const GET: RequestHandler = async ({ params }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) throw error(400, 'bad job id');
	const job = await getJob(id);
	if (!job) throw error(404, 'no such job');
	const events = await jobEvents(id);
	return json(
		{ events: events.map((e) => ({ ...e, at: e.at.toISOString() })) },
		{ headers: { 'cache-control': 'private, no-store' } }
	);
};
