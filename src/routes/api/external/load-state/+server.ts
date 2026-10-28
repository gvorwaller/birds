import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isRegionCode } from '$server/external-sources/contract';
import { externalLoadStates } from '$server/external-sources/reports';

/**
 * Load progress for the Norway cards (td-eec7db Phase 3, CODEX1 F3):
 * `?k=<source>:<region>` repeated. The cards poll it only while a load they
 * show as in progress belongs to someone else, and reload when it ends.
 */
const MAX_KEYS = 40;

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.scopeId) throw error(401, 'Unauthorized');
	const keys = url.searchParams.getAll('k');
	if (keys.length === 0 || keys.length > MAX_KEYS) throw error(400, `Give 1 to ${MAX_KEYS} keys.`);
	const pairs = keys.map((k) => {
		const i = k.indexOf(':');
		const sourceId = k.slice(0, i);
		const regionCode = k.slice(i + 1);
		if (i < 1 || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(sourceId) || !isRegionCode(regionCode)) throw error(400, 'Bad key.');
		return { sourceId, regionCode };
	});
	return json({ states: await externalLoadStates(pairs) }, { headers: { 'Cache-Control': 'private, no-store' } });
};
