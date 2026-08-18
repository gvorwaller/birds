import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getJob, jobEvents } from '$server/jobs';
import { canViewJobEvents } from '$server/job-policy';

export const GET: RequestHandler = async ({ params, locals }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) throw error(400, 'bad job id');
	const job = await getJob(id);
	if (!job) throw error(404, 'no such job');
	// Frequency-load events are communal (matching the hub's communal
	// cancel); everything else may reference individual users — admin only.
	if (!canViewJobEvents(job.type, locals.user?.role)) {
		throw error(403, 'not allowed for this job type');
	}
	const { events, total } = await jobEvents(id);
	return json(
		{ events: events.map((e) => ({ ...e, at: e.at.toISOString() })), total },
		{ headers: { 'cache-control': 'private, no-store' } }
	);
};
