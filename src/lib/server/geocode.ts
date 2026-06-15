/**
 * Server-side geocoding (Google, shared GOOGLE_GEOCODING_KEY). Used by the
 * /api/geocode endpoint (map picker) and the Targets place search, so the
 * user types place names, never eBird region codes.
 */
import { env } from "$env/dynamic/private";

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
	const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
	url.searchParams.set("key", env.GOOGLE_GEOCODING_KEY);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

	let res: Response;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(10000) });
	} catch {
		return null;
	}
	if (!res.ok) return null;
	const data = (await res.json()) as GoogleGeocodeResponse;
	if (data.status !== "OK" || !data.results?.length) return null;
	const top = data.results[0];
	return {
		lat: top.geometry.location.lat,
		lng: top.geometry.location.lng,
		name: top.formatted_address ?? (params.address || ""),
		bounds: top.geometry.viewport ?? null,
	};
}

export function geocodePlace(query: string): Promise<GeoResult | null> {
	const q = query.trim();
	if (!q || q.length > 200) return Promise.resolve(null);
	return call({ address: q });
}

export async function reverseGeocode(
	lat: number,
	lng: number,
): Promise<string | null> {
	const r = await call({ latlng: `${lat},${lng}` });
	return r?.name ?? null;
}

export function geocodeConfigured(): boolean {
	return !!env.GOOGLE_GEOCODING_KEY;
}

export interface NearbyPlace {
	name: string;
	lat: number;
	lng: number;
	vicinity: string | null;
	types: string[];
}

/**
 * Typed outcome of a Places lookup. Unlike geocodePlace()'s `| null`, trip
 * planning needs to tell apart "Places API not enabled" from "nothing found"
 * from "rate limited" so the UI can surface the real reason and never invent a
 * stop. (Codex review note.)
 */
export type PlacesNearbyResult =
	| { status: "ok"; places: NearbyPlace[] }
	| { status: "not_configured" }
	| { status: "not_found" }
	| { status: "rate_limited" }
	| { status: "upstream_error" };

interface GooglePlacesResponse {
	status: string;
	error_message?: string;
	results?: {
		name?: string;
		geometry?: { location?: { lat: number; lng: number } };
		vicinity?: string;
		types?: string[];
	}[];
}

/**
 * Google Places Nearby Search for a historical/cultural point near a coord.
 * Defaults to tourist attractions biased toward history/culture via keyword.
 * Requires the Places API enabled on the shared GOOGLE_GEOCODING_KEY; a
 * REQUEST_DENIED (not enabled / restricted) surfaces as `upstream_error`.
 */
export async function placesNearby(
	lat: number,
	lng: number,
	opts: { radiusM?: number; type?: string; keyword?: string } = {},
): Promise<PlacesNearbyResult> {
	if (!env.GOOGLE_GEOCODING_KEY) return { status: "not_configured" };
	const url = new URL(
		"https://maps.googleapis.com/maps/api/place/nearbysearch/json",
	);
	url.searchParams.set("key", env.GOOGLE_GEOCODING_KEY);
	url.searchParams.set("location", `${lat},${lng}`);
	url.searchParams.set("radius", String(Math.round(opts.radiusM ?? 16000)));
	url.searchParams.set("type", opts.type ?? "tourist_attraction");
	url.searchParams.set(
		"keyword",
		opts.keyword ?? "historic landmark museum culture",
	);

	let res: Response;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(10000) });
	} catch {
		return { status: "upstream_error" };
	}
	if (!res.ok) return { status: "upstream_error" };
	const data = (await res.json()) as GooglePlacesResponse;

	if (data.status === "ZERO_RESULTS") return { status: "not_found" };
	if (data.status === "OVER_QUERY_LIMIT") return { status: "rate_limited" };
	if (data.status !== "OK") return { status: "upstream_error" }; // REQUEST_DENIED, INVALID_REQUEST, etc.

	const places: NearbyPlace[] = (data.results ?? [])
		.filter((r) => r.geometry?.location)
		.map((r) => ({
			name: r.name ?? "Point of interest",
			lat: r.geometry!.location!.lat,
			lng: r.geometry!.location!.lng,
			vicinity: r.vicinity ?? null,
			types: r.types ?? [],
		}));
	return places.length ? { status: "ok", places } : { status: "not_found" };
}
