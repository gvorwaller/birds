import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requestCancel } from '$server/jobs';

/**
 * Any non-viewer may cancel a communal job (GROK #14 — one household pool;
 * the hub shows requested_by so cancellations aren't mysterious). Viewers are
 * already blocked from every non-GET by hooks.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) throw error(400, 'bad job id');
	const outcome = await requestCancel(id, locals.user!.id);
	return json({ outcome }, { headers: { 'cache-control': 'private, no-store' } });
};
