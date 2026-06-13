/**
 * eBird API v2 client. Public-data endpoints only (taxonomy, recent obs,
 * notable, hotspots) — personal data comes from ebird-account.ts (web login).
 *
 * Rules (cs.md): cache first, clear errors on bad/missing key or rate limit,
 * fall back to cached data, never log the key.
 */
import { query, withTransaction } from '$lib/db';
import { decryptSecret } from '$server/crypto';

const API = 'https://api.ebird.org/v2';

export class EbirdError extends Error {
	constructor(
		message: string,
		public status?: number
	) {
		super(message);
		this.name = 'EbirdError';
	}
}

export interface EbirdObs {
	speciesCode: string;
	comName: string;
	sciName: string;
	locId: string;
	locName: string;
	obsDt: string; // "YYYY-MM-DD HH:mm"
	howMany?: number;
	lat: number;
	lng: number;
	obsValid: boolean;
	obsReviewed: boolean;
	locationPrivate: boolean;
}

export interface CachedResult<T> {
	data: T;
	fetchedAt: Date;
	stale: boolean;
}

export async function getEbirdApiKey(userId: number): Promise<string | null> {
	const r = await query<{ api_key_enc: string | null }>(
		'SELECT api_key_enc FROM user_ebird WHERE user_id = $1',
		[userId]
	);
	const enc = r.rows[0]?.api_key_enc;
	return enc ? decryptSecret(enc) : null;
}

async function ebirdFetch<T>(path: string, apiKey: string): Promise<T> {
	let res: Response;
	try {
		res = await fetch(`${API}${path}`, {
			headers: { 'X-eBirdApiToken': apiKey, Accept: 'application/json' }
		});
	} catch (err) {
		throw new EbirdError(`eBird API unreachable: ${err instanceof Error ? err.message : err}`);
	}
	if (res.status === 403 || res.status === 401) {
		throw new EbirdError('eBird API key is missing or invalid — check Settings.', res.status);
	}
	if (res.status === 429) {
		throw new EbirdError('eBird API rate limit hit — showing cached data if available.', 429);
	}
	if (!res.ok) {
		throw new EbirdError(`eBird API error ${res.status} for ${path}`, res.status);
	}
	return (await res.json()) as T;
}

/**
 * TTL cache over the ebird_cache table. On fetch failure, falls back to a
 * stale cached payload when one exists (stale: true) instead of throwing.
 */
async function cachedFetch<T>(
	cacheKey: string,
	ttlMinutes: number,
	fetcher: () => Promise<T>
): Promise<CachedResult<T>> {
	const cached = await query<{ payload: T; fetched_at: string }>(
		'SELECT payload, fetched_at FROM ebird_cache WHERE cache_key = $1',
		[cacheKey]
	);
	const row = cached.rows[0];
	const fresh = row && Date.now() - new Date(row.fetched_at).getTime() < ttlMinutes * 60_000;
	if (row && fresh) {
		return { data: row.payload, fetchedAt: new Date(row.fetched_at), stale: false };
	}

	try {
		const data = await fetcher();
		await query(
			`INSERT INTO ebird_cache (cache_key, payload, fetched_at)
			 VALUES ($1, $2, NOW())
			 ON CONFLICT (cache_key) DO UPDATE SET payload = $2, fetched_at = NOW()`,
			[cacheKey, JSON.stringify(data)]
		);
		return { data, fetchedAt: new Date(), stale: false };
	} catch (err) {
		if (row) {
			return { data: row.payload, fetchedAt: new Date(row.fetched_at), stale: true };
		}
		throw err;
	}
}

const OBS_TTL_MIN = 30;

export async function recentObs(
	apiKey: string,
	regionCode: string,
	back: number
): Promise<CachedResult<EbirdObs[]>> {
	const region = regionCode.trim();
	return cachedFetch(`obs:${region}:${back}`, OBS_TTL_MIN, () =>
		ebirdFetch<EbirdObs[]>(`/data/obs/${encodeURIComponent(region)}/recent?back=${back}`, apiKey)
	);
}

export async function notableObs(
	apiKey: string,
	regionCode: string,
	back: number
): Promise<CachedResult<EbirdObs[]>> {
	const region = regionCode.trim();
	return cachedFetch(`notable:${region}:${back}`, OBS_TTL_MIN, () =>
		ebirdFetch<EbirdObs[]>(
			`/data/obs/${encodeURIComponent(region)}/recent/notable?back=${back}&detail=simple`,
			apiKey
		)
	);
}

export async function recentNearbyObs(
	apiKey: string,
	lat: number,
	lng: number,
	distKm: number,
	back: number
): Promise<CachedResult<EbirdObs[]>> {
	// Round coords in the cache key so tiny GPS jitter reuses the cache.
	const la = lat.toFixed(2);
	const ln = lng.toFixed(2);
	return cachedFetch(`geo:${la}:${ln}:${distKm}:${back}`, OBS_TTL_MIN, () =>
		ebirdFetch<EbirdObs[]>(
			`/data/obs/geo/recent?lat=${la}&lng=${ln}&dist=${distKm}&back=${back}`,
			apiKey
		)
	);
}

export async function notableNearbyObs(
	apiKey: string,
	lat: number,
	lng: number,
	distKm: number,
	back: number
): Promise<CachedResult<EbirdObs[]>> {
	const la = lat.toFixed(2);
	const ln = lng.toFixed(2);
	return cachedFetch(`geonote:${la}:${ln}:${distKm}:${back}`, OBS_TTL_MIN, () =>
		ebirdFetch<EbirdObs[]>(
			`/data/obs/geo/recent/notable?lat=${la}&lng=${ln}&dist=${distKm}&back=${back}&detail=simple`,
			apiKey
		)
	);
}

export async function recentNearbySpeciesObs(
	apiKey: string,
	speciesCode: string,
	lat: number,
	lng: number,
	distKm: number,
	back: number
): Promise<CachedResult<EbirdObs[]>> {
	const la = lat.toFixed(2);
	const ln = lng.toFixed(2);
	return cachedFetch(`geosp:${speciesCode}:${la}:${ln}:${distKm}:${back}`, OBS_TTL_MIN, () =>
		ebirdFetch<EbirdObs[]>(
			`/data/obs/geo/recent/${encodeURIComponent(speciesCode)}?lat=${la}&lng=${ln}&dist=${distKm}&back=${back}`,
			apiKey
		)
	);
}

interface TaxonEntry {
	sciName: string;
	comName: string;
	speciesCode: string;
	category: string;
	familyComName?: string;
	familySciName?: string;
}

/** Full taxonomy pull (~17k rows) into taxonomy_cache. Re-run quarterly or on demand. */
export async function syncTaxonomy(apiKey: string): Promise<number> {
	const taxa = await ebirdFetch<TaxonEntry[]>('/ref/taxonomy/ebird?fmt=json', apiKey);
	if (!Array.isArray(taxa) || taxa.length === 0) {
		throw new EbirdError('Taxonomy endpoint returned no rows — aborting sync.');
	}
	await withTransaction(async (client) => {
		await client.query('DELETE FROM taxonomy_cache');
		// Batch inserts: 500 rows per statement keeps parameter counts sane.
		const BATCH = 500;
		for (let i = 0; i < taxa.length; i += BATCH) {
			const slice = taxa.slice(i, i + BATCH);
			const values: string[] = [];
			const params: unknown[] = [];
			slice.forEach((t, j) => {
				const o = j * 5;
				values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5})`);
				params.push(t.speciesCode, t.comName, t.sciName, t.category, t.familyComName ?? null);
			});
			await client.query(
				`INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
				 VALUES ${values.join(',')}
				 ON CONFLICT (species_code) DO UPDATE
				   SET com_name = EXCLUDED.com_name, sci_name = EXCLUDED.sci_name,
				       category = EXCLUDED.category, family = EXCLUDED.family`,
				params
			);
		}
		await client.query(`UPDATE taxonomy_cache SET fetched_at = NOW()`);
	});
	return taxa.length;
}

export async function taxonomyCount(): Promise<number> {
	const r = await query<{ n: string }>('SELECT COUNT(*) AS n FROM taxonomy_cache');
	return Number(r.rows[0]?.n ?? 0);
}
