/**
 * "Where and when to look" (td-eec7db Phase 4, td-b6ddfc): one external
 * source's reports for one region, by month or by species, for the whole
 * region or one municipality. Params: month (1–12, default this month),
 * place (a municipality name), view (month | species), seen (needs | all).
 */
import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { calendarMonth } from '$lib/forecast-calendar';
import { isRegionCode } from '$server/external-sources/contract';
import { externalWhereWhen } from '$server/external-sources/where-when';
import { queueExternalLoadAction } from '$server/external-sources/queue-action';

function parseMonth(raw: string | null): number | null {
	const n = Number(raw);
	return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

export const load: PageServerLoad = async ({ params, url, locals }) => {
	if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(params.source) || !isRegionCode(params.region)) error(404, 'Not found');
	const rawPlace = (url.searchParams.get('place') ?? '').trim();
	const view = await externalWhereWhen({
		sourceId: params.source,
		regionCode: params.region,
		place: rawPlace && rawPlace.length <= 120 ? rawPlace : null,
		month: parseMonth(url.searchParams.get('month')) ?? calendarMonth(),
		userId: locals.scopeId!
	});
	if (!view) error(404, 'No active source covers this region.');
	return {
		...view,
		regionCode: params.region,
		mode: url.searchParams.get('view') === 'species' ? ('species' as const) : ('month' as const),
		seen: url.searchParams.get('seen') === 'all' ? ('all' as const) : ('needs' as const),
		accountId: locals.user!.id,
		canLoad: locals.user?.role !== 'viewer'
	};
};

export const actions: Actions = {
	/** Queue a load for this region (Phase 3's action). */
	queueExternalLoad: queueExternalLoadAction
};
