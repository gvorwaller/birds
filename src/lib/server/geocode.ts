/**
 * Server-side geocoding (Google, shared GOOGLE_GEOCODING_KEY). Used by the
 * /api/geocode endpoint (map picker) and the Targets place search, so the
 * user types place names, never eBird region codes.
 */
import { env } from '$env/dynamic/private';

export interface GeoResult {
	lat: number;
	lng: number;
	name: string;
	bounds: unknown | null;
}

interface GoogleGeocodeResponse {
	status: string;
	error_message?: string;
	results?: {
		geometry: { location: { lat: number; lng: number }; viewport?: unknown };
		formatted_address?: string;
	}[];
}

async function call(params: Record<string, string>): Promise<GeoResult | null> {
	if (!env.GOOGLE_GEOCODING_KEY) return null;
	const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
	url.searchParams.set('key', env.GOOGLE_GEOCODING_KEY);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

	let res: Response;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(10000) });
	} catch {
		return null;
	}
	if (!res.ok) return null;
	const data = (await res.json()) as GoogleGeocodeResponse;
	if (data.status !== 'OK' || !data.results?.length) return null;
	const top = data.results[0];
	return {
		lat: top.geometry.location.lat,
		lng: top.geometry.location.lng,
		name: top.formatted_address ?? (params.address || ''),
		bounds: top.geometry.viewport ?? null
	};
}

export function geocodePlace(query: string): Promise<GeoResult | null> {
	const q = query.trim();
	if (!q || q.length > 200) return Promise.resolve(null);
	return call({ address: q });
}

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
	const r = await call({ latlng: `${lat},${lng}` });
	return r?.name ?? null;
}

export function geocodeConfigured(): boolean {
	return !!env.GOOGLE_GEOCODING_KEY;
}
