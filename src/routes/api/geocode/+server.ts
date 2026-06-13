import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { geocodeConfigured, geocodePlace, reverseGeocode } from '$server/geocode';

/**
 * Forward + reverse geocoding. POST { query } → place; POST { lat, lng } →
 * nearest address. Backed by $server/geocode (GOOGLE_GEOCODING_KEY).
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!geocodeConfigured()) {
		return json({ error: 'Geocoding is not configured (GOOGLE_GEOCODING_KEY missing).' }, { status: 503 });
	}

	let body: { query?: unknown; lat?: unknown; lng?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const query = typeof body.query === 'string' ? body.query.trim() : '';
	const lat = Number(body.lat);
	const lng = Number(body.lng);

	if (query) {
		const r = await geocodePlace(query);
		if (!r) return json({ error: 'Place not found' }, { status: 404 });
		return json(r);
	}
	if (Number.isFinite(lat) && Number.isFinite(lng)) {
		const name = await reverseGeocode(lat, lng);
		return json({ lat, lng, name: name ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`, bounds: null });
	}
	return json({ error: 'Provide a search query or lat/lng.' }, { status: 400 });
};
