import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';

/**
 * Forward + reverse geocoding via Google (same GOOGLE_GEOCODING_KEY as
 * gaylon.photos). POST { query } → place; POST { lat, lng } → nearest address.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!env.GOOGLE_GEOCODING_KEY) {
		return json({ error: 'Geocoding is not configured (GOOGLE_GEOCODING_KEY missing).' }, { status: 503 });
	}

	let body: { query?: unknown; lat?: unknown; lng?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
	url.searchParams.set('key', env.GOOGLE_GEOCODING_KEY);

	const query = typeof body.query === 'string' ? body.query.trim() : '';
	const lat = Number(body.lat);
	const lng = Number(body.lng);

	if (query) {
		if (query.length > 200) return json({ error: 'Query is too long' }, { status: 400 });
		url.searchParams.set('address', query);
	} else if (Number.isFinite(lat) && Number.isFinite(lng)) {
		url.searchParams.set('latlng', `${lat},${lng}`);
	} else {
		return json({ error: 'Provide a search query or lat/lng.' }, { status: 400 });
	}

	let response: Response;
	try {
		response = await fetch(url, { signal: AbortSignal.timeout(10000) });
	} catch {
		return json({ error: 'Geocoding service unreachable.' }, { status: 502 });
	}
	if (!response.ok) {
		return json({ error: `Geocoding HTTP ${response.status}` }, { status: 502 });
	}

	const data = (await response.json()) as {
		status: string;
		error_message?: string;
		results?: {
			geometry: { location: { lat: number; lng: number }; viewport?: unknown };
			formatted_address?: string;
		}[];
	};
	if (data.status !== 'OK' || !data.results?.length) {
		return json({ error: data.error_message || 'Place not found' }, { status: 404 });
	}

	const top = data.results[0];
	return json({
		lat: top.geometry.location.lat,
		lng: top.geometry.location.lng,
		name: top.formatted_address || query,
		bounds: top.geometry.viewport ?? null
	});
};
