// @ts-nocheck
import type { PageServerLoad } from './$types';
import { query } from '$lib/db';
import { getEbirdApiKey, EbirdError } from '$server/ebird';
import { regionTargets, type TargetsView } from '$server/needs';

const DEFAULT_REGION = 'US-FL-031'; // Duval County, FL
const REGION_PRESETS = [
	{ code: 'US-FL-031', label: 'Duval County, FL' },
	{ code: 'US-ME-009', label: 'Hancock County, ME' },
	{ code: 'US-FL', label: 'Florida' },
	{ code: 'US-ME', label: 'Maine' }
];

export const load = async ({ locals, url }: Parameters<PageServerLoad>[0]) => {
	const userId = locals.user!.id;
	const region = (url.searchParams.get('region') ?? DEFAULT_REGION).trim();
	const back = Math.min(Math.max(Number(url.searchParams.get('back') ?? 7) || 7, 1), 30);

	const userRow = await query<{ home_lat: number | null; home_lon: number | null }>(
		'SELECT home_lat, home_lon FROM users WHERE id = $1',
		[userId]
	);
	const home =
		userRow.rows[0]?.home_lat != null && userRow.rows[0]?.home_lon != null
			? { lat: userRow.rows[0].home_lat, lon: userRow.rows[0].home_lon }
			: null;

	const apiKey = await getEbirdApiKey(userId);
	let view: TargetsView | null = null;
	let error: string | null = null;

	if (!apiKey) {
		error = 'Add your eBird API key in Settings to load live targets.';
	} else {
		try {
			view = await regionTargets(userId, apiKey, region, back, home);
		} catch (err) {
			error = err instanceof EbirdError ? err.message : `Could not load data for ${region}.`;
		}
	}

	return { region, back, presets: REGION_PRESETS, view, error };
};
