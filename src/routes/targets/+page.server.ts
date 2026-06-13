import type { PageServerLoad } from './$types';
import { query } from '$lib/db';
import { getEbirdApiKey, EbirdError } from '$server/ebird';
import { geoTargets, type TargetsView } from '$server/needs';
import { geocodePlace } from '$server/geocode';

const DEFAULT_DIST_KM = 50; // eBird geo endpoints cap at 50 km
const PLACE_SUGGESTIONS = [
	'Jacksonville, FL',
	'Hancock County, ME',
	'Bar Harbor, ME',
	'Merritt Island NWR, FL'
];

export const load: PageServerLoad = async ({ locals, url }) => {
	const userId = locals.user!.id;
	const place = (url.searchParams.get('place') ?? '').trim();
	const dist = Math.min(Math.max(Number(url.searchParams.get('dist') ?? DEFAULT_DIST_KM) || DEFAULT_DIST_KM, 1), 50);
	const back = Math.min(Math.max(Number(url.searchParams.get('back') ?? 7) || 7, 1), 30);

	const userRow = await query<{ home_lat: number | null; home_lon: number | null; home_label: string | null }>(
		'SELECT home_lat, home_lon, home_label FROM users WHERE id = $1',
		[userId]
	);
	const home = userRow.rows[0];

	// Resolve the location: searched place → geocode; else fall back to home.
	let location: { lat: number; lng: number; label: string } | null = null;
	let placeError: string | null = null;

	if (place) {
		const geo = await geocodePlace(place);
		if (geo) {
			location = { lat: geo.lat, lng: geo.lng, label: geo.name };
		} else {
			placeError = `Couldn't find "${place}". Try a city, county, park, or address.`;
		}
	}
	if (!location && home?.home_lat != null && home.home_lon != null) {
		location = {
			lat: home.home_lat,
			lng: home.home_lon,
			label: home.home_label ?? 'Home'
		};
	}

	const apiKey = await getEbirdApiKey(userId);
	let view: TargetsView | null = null;
	let error: string | null = placeError;

	if (!location) {
		// No place searched and no home set — guide the user.
		return { location: null, dist, back, suggestions: PLACE_SUGGESTIONS, view: null, error, needsLocation: true };
	}
	if (!apiKey) {
		error = error ?? 'Add your eBird API key in Settings to load live targets.';
	} else {
		try {
			view = await geoTargets(userId, apiKey, location.lat, location.lng, dist, back);
		} catch (err) {
			error = err instanceof EbirdError ? err.message : `Could not load data for ${location.label}.`;
		}
	}

	return { location, dist, back, suggestions: PLACE_SUGGESTIONS, view, error, needsLocation: false };
};
