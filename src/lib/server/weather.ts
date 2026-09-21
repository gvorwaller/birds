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
import {
	reportSchemaDrift,
	UpstreamSchemaError,
	validateNwsForecast,
	validateNwsPoints
} from '$server/upstream-schema';

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

function validateCachedPayload(value: unknown): CachedPayload {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new UpstreamSchemaError('NWS', 'weather cache', ['payload must be an object']);
	const row = value as Record<string, unknown>;
	if (row.label != null && typeof row.label !== 'string')
		throw new UpstreamSchemaError('NWS', 'weather cache', ['label must be string or null']);
	if (!Array.isArray(row.periods))
		throw new UpstreamSchemaError('NWS', 'weather cache', ['periods must be an array']);
	const issues: string[] = [];
	for (const [i, raw] of row.periods.entries()) {
		const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
		for (const key of ['name', 'windSpeed', 'windDirection', 'shortForecast'])
			if (typeof p[key] !== 'string' || !p[key]) issues.push(`periods[${i}].${key} must be a non-empty string`);
		if (typeof p.isDaytime !== 'boolean') issues.push(`periods[${i}].isDaytime must be boolean`);
		if (typeof p.tempF !== 'number' || !Number.isFinite(p.tempF)) issues.push(`periods[${i}].tempF must be numeric`);
		if (p.precipPct != null && (typeof p.precipPct !== 'number' || !Number.isFinite(p.precipPct)))
			issues.push(`periods[${i}].precipPct must be numeric or null`);
	}
	if (issues.length) throw new UpstreamSchemaError('NWS', 'weather cache', issues);
	return value as CachedPayload;
}

async function fetchForecast(lat: number, lng: number): Promise<CachedPayload> {
	const headers = { 'User-Agent': UA, Accept: 'application/geo+json' };
	const pointsRes = await fetch(
		`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`,
		{ headers, signal: AbortSignal.timeout(10000) },
	);
	if (pointsRes.status === 404) throw new WeatherUnavailable();
	if (!pointsRes.ok) throw new Error(`NWS points ${pointsRes.status}`);
	const { forecastUrl, label } = validateNwsPoints(await pointsRes.json());

	const fRes = await fetch(forecastUrl, {
		headers,
		signal: AbortSignal.timeout(10000),
	});
	if (!fRes.ok) throw new Error(`NWS forecast ${fRes.status}`);
	const periods: WeatherPeriod[] = validateNwsForecast(await fRes.json());
	return { label, periods };
}

/**
 * Current + short forecast near a coordinate. Returns null when there's no NWS
 * coverage (outside the US) or when the fetch fails with no cached fallback.
 */
export async function weatherFor(
	lat: number,
	lng: number,
): Promise<WeatherResult | null> {
	const key = `weather:${lat.toFixed(3)}:${lng.toFixed(3)}`;
	const cached = await query<{ payload: unknown; fetched_at: string }>(
		'SELECT payload, fetched_at FROM ebird_cache WHERE cache_key = $1',
		[key],
	);
	const row = cached.rows[0];
	let cachedPayload: CachedPayload | null = null;
	if (row) {
		try { cachedPayload = validateCachedPayload(row.payload); }
		catch (err) { reportSchemaDrift(err, `cache ${key}`); }
	}
	const fresh =
		row && Date.now() - new Date(row.fetched_at).getTime() < TTL_MIN * 60_000;
	if (row && fresh && cachedPayload) {
		return {
			locationLabel: cachedPayload.label,
			periods: cachedPayload.periods,
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
		reportSchemaDrift(err, `fetch ${key}`);
		if (err instanceof WeatherUnavailable) return null; // outside US — no forecast
		if (row && cachedPayload) {
			return {
				locationLabel: cachedPayload.label,
				periods: cachedPayload.periods,
				stale: true,
				fetchedAt: new Date(row.fetched_at).toISOString(),
			};
		}
		return null; // no data + fetch failed → show nothing, never crash
	}
}
