/**
 * Weather via the US National Weather Service (api.weather.gov) — free, no key.
 * Two hops: /points/{lat},{lng} → a gridpoint forecast URL → forecast periods.
 *
 * Cached in the shared TTL cache (the `ebird_cache` table, used here as a generic
 * HTTP cache — keyed `weather:lat:lng`); on fetch error falls back to the stale
 * cached payload when present, and returns null outside US coverage (points 404)
 * so the page simply shows no weather rather than crashing.
 *
 * NWS asks for a descriptive User-Agent with contact info.
 */
import { query } from '$lib/db';

const UA = 'birds.gaylon.photos trip planner (gaylon@vorwaller.net)';
const TTL_MIN = 60;

/** Internal marker: lat/lng has no NWS forecast (outside the US). */
class WeatherUnavailable extends Error {}

export interface WeatherPeriod {
	name: string; // "Overnight", "Tuesday", "Tuesday Night"
	isDaytime: boolean;
	tempF: number;
	precipPct: number | null;
	windSpeed: string; // "12 mph"
	windDirection: string; // "SW"
	shortForecast: string; // "Slight Chance Rain Showers"
}

export interface WeatherResult {
	locationLabel: string | null; // "Atlantic Beach, FL"
	periods: WeatherPeriod[]; // next few periods (≤4)
	stale: boolean;
	fetchedAt: string; // ISO
}

interface CachedPayload {
	label: string | null;
	periods: WeatherPeriod[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function fetchForecast(lat: number, lng: number): Promise<CachedPayload> {
	const headers = { 'User-Agent': UA, Accept: 'application/geo+json' };
	const pointsRes = await fetch(
		`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`,
		{ headers, signal: AbortSignal.timeout(10000) },
	);
	if (pointsRes.status === 404) throw new WeatherUnavailable();
	if (!pointsRes.ok) throw new Error(`NWS points ${pointsRes.status}`);
	const pts = (await pointsRes.json()) as any;
	const forecastUrl: string | undefined = pts?.properties?.forecast;
	if (!forecastUrl) throw new Error('NWS points response missing forecast URL');
	const rel = pts?.properties?.relativeLocation?.properties;
	const label = rel?.city && rel?.state ? `${rel.city}, ${rel.state}` : null;

	const fRes = await fetch(forecastUrl, {
		headers,
		signal: AbortSignal.timeout(10000),
	});
	if (!fRes.ok) throw new Error(`NWS forecast ${fRes.status}`);
	const f = (await fRes.json()) as any;
	const periods: WeatherPeriod[] = (f?.properties?.periods ?? [])
		.slice(0, 4)
		.map((p: any) => ({
			name: String(p.name ?? ''),
			isDaytime: !!p.isDaytime,
			tempF: Number(p.temperature),
			precipPct: p.probabilityOfPrecipitation?.value ?? null,
			windSpeed: String(p.windSpeed ?? ''),
			windDirection: String(p.windDirection ?? ''),
			shortForecast: String(p.shortForecast ?? ''),
		}));
	return { label, periods };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Current + short forecast near a coordinate. Returns null when there's no NWS
 * coverage (outside the US) or when the fetch fails with no cached fallback.
 */
export async function weatherFor(
	lat: number,
	lng: number,
): Promise<WeatherResult | null> {
	const key = `weather:${lat.toFixed(3)}:${lng.toFixed(3)}`;
	const cached = await query<{ payload: CachedPayload; fetched_at: string }>(
		'SELECT payload, fetched_at FROM ebird_cache WHERE cache_key = $1',
		[key],
	);
	const row = cached.rows[0];
	const fresh =
		row && Date.now() - new Date(row.fetched_at).getTime() < TTL_MIN * 60_000;
	if (row && fresh) {
		return {
			locationLabel: row.payload.label,
			periods: row.payload.periods,
			stale: false,
			fetchedAt: new Date(row.fetched_at).toISOString(),
		};
	}

	try {
		const data = await fetchForecast(lat, lng);
		await query(
			`INSERT INTO ebird_cache (cache_key, payload, fetched_at)
			 VALUES ($1, $2, NOW())
			 ON CONFLICT (cache_key) DO UPDATE SET payload = $2, fetched_at = NOW()`,
			[key, JSON.stringify(data)],
		);
		return {
			locationLabel: data.label,
			periods: data.periods,
			stale: false,
			fetchedAt: new Date().toISOString(),
		};
	} catch (err) {
		if (err instanceof WeatherUnavailable) return null; // outside US — no forecast
		if (row) {
			return {
				locationLabel: row.payload.label,
				periods: row.payload.periods,
				stale: true,
				fetchedAt: new Date(row.fetched_at).toISOString(),
			};
		}
		return null; // no data + fetch failed → show nothing, never crash
	}
}
