import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { QueueLockTimeoutError, requestCancel } from '$server/jobs';

/** Stable body for a cancel that could not lock the job row in time (td-b99b6d Rev 3.1). */
const JOB_BUSY_BODY = {
	error: 'job_busy',
	message: 'That job is finishing a step — try cancelling again in a few seconds.'
} as const;

/**
 * Any non-viewer may cancel a communal job (GROK #14 — one household pool;
 * the hub shows requested_by so cancellations aren't mysterious). Viewers are
 * already blocked from every non-GET by hooks.
 *
 * The cancel UPDATE waits at most 15 s for the job row: the worker may hold it
 * inside a fenced transaction (a large region store). A row still busy then is
 * a 503 the hub shows inline — the request never hangs.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) throw error(400, 'bad job id');
	let outcome: Awaited<ReturnType<typeof requestCancel>>;
	try {
		outcome = await requestCancel(id, locals.user!.id);
	} catch (err) {
		if (err instanceof QueueLockTimeoutError || (err as { code?: string } | null)?.code === '55P03') {
			return json(JOB_BUSY_BODY, {
				status: 503,
				headers: { 'cache-control': 'private, no-store', 'retry-after': '5' }
			});
		}
		throw err;
	}
	return json({ outcome }, { headers: { 'cache-control': 'private, no-store' } });
};
