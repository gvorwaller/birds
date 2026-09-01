/**
 * eBird API v2 client. Public-data endpoints only (taxonomy, recent obs,
 * notable, hotspots) — personal data comes from ebird-account.ts (web login).
 *
 * Rules (cs.md): cache first, clear errors on bad/missing key or rate limit,
 * fall back to cached data, never log the key.
 */
import { query, withTransaction } from '$lib/db';
import { timed } from '$server/request-timing';
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
	/** Checklist id ("S123456789") — present on recent/notable obs payloads. */
	subId?: string;
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
	return decodeEbirdApiKey(r.rows[0]?.api_key_enc ?? null);
}

/**
 * Decrypt an already-fetched `user_ebird.api_key_enc`. Lets a caller that
 * needs other columns of that row (the Home loader wants `life_list_*` too)
 * read the row ONCE instead of paying a second SELECT for the key alone.
 */
export function decodeEbirdApiKey(enc: string | null): string | null {
	return enc ? decryptSecret(enc) : null;
}

/**
 * Like ebirdFetch, but the statuses in `nullOn` return null instead of
 * throwing — for endpoints where they are expected data states, not faults:
 * hotspot info 404s for personal L-ids; checklist view 403/404s for
 * unshared checklists (GROK td-b5986c pin 2). Everything else throws —
 * notably a hotspot-info 403 is an INVALID API KEY on eBird, never a
 * personal location, and must stop the caller rather than persist a
 * negative (GROK re-review: a bad key would otherwise poison a capful of
 * loc_ids per sync).
 */
export async function ebirdFetchOrNull<T>(
	path: string,
	apiKey: string,
	opts: EbirdFetchOpts & {
		fetcher?: typeof fetch;
		nullOn?: readonly number[];
	} = {}
): Promise<T | null> {
	const doFetch = opts.fetcher ?? fetch;
	const nullOn = opts.nullOn ?? [404];
	// Same ceiling as ebirdFetch — this path was equally unbounded.
	const deadlineMs = opts.deadlineMs ?? EBIRD_DEFAULT_TIMEOUT_MS;
	const deadline = AbortSignal.timeout(deadlineMs);
	const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
	let res: Response;
	try {
		res = await timed('ebird', () =>
			doFetch(`${API}${path}`, {
				headers: { 'X-eBirdApiToken': apiKey, Accept: 'application/json' },
				signal
			})
		);
	} catch (err) {
		if (opts.signal?.aborted) {
			throw new EbirdError('eBird API request aborted (caller cancelled).');
		}
		if (deadline.aborted) {
			throw new EbirdError(
				`eBird did not respond within ${Math.round(deadlineMs / 1000)}s.`,
				504
			);
		}
		throw new EbirdError(`eBird API unreachable: ${err instanceof Error ? err.message : err}`);
	}
	if (nullOn.includes(res.status)) return null;
	if (res.status === 429) {
		throw new EbirdError('eBird API rate limit hit.', 429);
	}
	if (!res.ok) {
		throw new EbirdError(`eBird API error ${res.status} for ${path}`, res.status);
	}
	// Personal L-ids return HTTP 200 with an empty body (not 404) from
	// hotspot/info. Bare res.json() throws SyntaxError — not an EbirdError —
	// which bypassed the resolver's catch and aborted every prod pass
	// (td-2fbfc1 root cause). Parse safely: empty or non-JSON 200 → null.
	const body = await res.text();
	if (!body.trim()) return null;
	try {
		return JSON.parse(body) as T;
	} catch {
		return null;
	}
}

/**
 * Wall-clock ceiling for ONE eBird HTTP call when the caller names no policy.
 *
 * A guard against unbounded waits, not a performance target. Without it,
 * undici's defaults let a stalled request run for minutes: `/data/nearest/
 * geo/recent/{sp}` holds the connection ~60 s and then 500s whenever a species
 * has many records and none near the search point (measured 2026-09-01 —
 * Black-capped Chickadee from Jacksonville 500 at 60.1 s, reproducible; the
 * same species from Seattle 0.47 s; American Robin a legitimate SUCCESS at
 * 23.4 s). The species page inherited the whole stall as a spinner because
 * nginx (`deploy/nginx.conf`, proxy_read_timeout 60s) cut the streamed
 * response before any error chunk could ship.
 *
 * 45 s clears that measured 23.4 s success ~2x and still lands inside nginx's
 * 60 s. Endpoints with their own cost profile pass `deadlineMs` instead.
 *
 * `EBIRD_TIMEOUT_MS` exists so tests can collapse it — real timers, since
 * AbortSignal.timeout ignores fake clocks.
 */
const EBIRD_DEFAULT_TIMEOUT_MS = Number(process.env.EBIRD_TIMEOUT_MS ?? '') || 45_000;

export interface EbirdFetchOpts {
	/**
	 * CALLER cancellation (a superseded navigation) — never a deadline, and
	 * never a reason to fall back to another strategy. Callers that share work
	 * through `cachedFetch` should use this to stop SCHEDULING rather than to
	 * cancel a fetch another request may be awaiting (the needs.ts rule).
	 */
	signal?: AbortSignal;
	/** Internal per-endpoint deadline policy. Defaults to the module ceiling. */
	deadlineMs?: number;
}

async function ebirdFetch<T>(path: string, apiKey: string, opts: EbirdFetchOpts = {}): Promise<T> {
	const deadlineMs = opts.deadlineMs ?? EBIRD_DEFAULT_TIMEOUT_MS;
	const deadline = AbortSignal.timeout(deadlineMs);
	const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
	let res: Response;
	try {
		// Only live HTTP is timed — cachedFetch hits never reach this function,
		// which is exactly the cache-hit/miss distinction worth measuring.
		res = await timed('ebird', () =>
			fetch(`${API}${path}`, {
				headers: { 'X-eBirdApiToken': apiKey, Accept: 'application/json' },
				signal
			})
		);
	} catch (err) {
		// Order matters. Caller cancellation is not a provider fault and must
		// not read as one; a blown deadline is distinct from "unreachable",
		// which would misattribute a stalled upstream to the network.
		if (opts.signal?.aborted) {
			throw new EbirdError('eBird API request aborted (caller cancelled).');
		}
		if (deadline.aborted) {
			throw new EbirdError(
				`eBird did not respond within ${Math.round(deadlineMs / 1000)}s.`,
				504
			);
		}
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
 * Per-process coalescing of concurrent reads of the same cache key
 * (td-d561a8 §2), the same shape as `enrichOneNowCoalesced` in
 * species-enrichment.ts.
 *
 * Motivated by the Home split: with the shell returning in ~400 ms instead of
 * ~2.3 s, a user can now change radius/window three or four times while the
 * first per-species fan-out is still running, and every overlapping COLD miss
 * used to become its own upstream call. Coalescing makes concurrent callers
 * share one HTTP request, which is the cs.md rate-limit rule ("cache first,
 * respect rate limits") applied to the in-flight window the DB cache cannot
 * cover. Cross-process duplication (a second PM2 worker) is still possible and
 * stays on td-3bf3a2 — this covers the same-user overlap the fast shell
 * invents.
 *
 * Callers share the resolved object, including its `data` array. Nothing in
 * this codebase mutates an observation payload (aggregate/rankPlaces read it;
 * attachGooglePlaceIds maps to new objects), so the shared reference is safe.
 */
const inFlight = new Map<string, Promise<CachedResult<unknown>>>();

async function cachedFetch<T>(
	cacheKey: string,
	ttlMinutes: number,
	fetcher: () => Promise<T>
): Promise<CachedResult<T>> {
	const existing = inFlight.get(cacheKey) as Promise<CachedResult<T>> | undefined;
	if (existing) return existing;
	const p = cachedFetchUncoalesced(cacheKey, ttlMinutes, fetcher).finally(() =>
		inFlight.delete(cacheKey)
	);
	inFlight.set(cacheKey, p as Promise<CachedResult<unknown>>);
	return p;
}

/**
 * TTL cache over the ebird_cache table. On fetch failure, falls back to a
 * stale cached payload when one exists (stale: true) instead of throwing.
 */
async function cachedFetchUncoalesced<T>(
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
		return {
			data: row.payload,
			fetchedAt: new Date(row.fetched_at),
			stale: false
		};
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
			return {
				data: row.payload,
				fetchedAt: new Date(row.fetched_at),
				stale: true
			};
		}
		throw err;
	}
}

/**
 * How long a saved observation feed counts as fresh.
 *
 * Three hours, not the original thirty minutes (owner's call 2026-09-01): a
 * given area gets a handful of new checklists a day, so re-asking every half
 * hour bought almost nothing and cost a slow page on every visit. Missing a
 * report for a couple of hours cannot meaningfully change "which birds are
 * around" or "how far is the nearest one".
 */
const OBS_TTL_MIN = 180;

/**
 * Rare-bird feeds keep the SHORT window, deliberately.
 *
 * This is the one place where a late report is the whole point: the alerts
 * worker reads this same cache to decide whether to push "a rarity was just
 * reported near you" (job-handlers.ts), and it refuses to notify from a stale
 * row at all. Stretching this to three hours would delay a notification about
 * a bird someone would drive out to see, which is exactly the value the
 * feature exists to deliver.
 */
const NOTABLE_TTL_MIN = 30;

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
	return cachedFetch(`notable:${region}:${back}`, NOTABLE_TTL_MIN, () =>
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
	back: number,
	opts?: { signal?: AbortSignal }
): Promise<CachedResult<EbirdObs[]>> {
	const la = lat.toFixed(2);
	const ln = lng.toFixed(2);
	return cachedFetch(`geonote:${la}:${ln}:${distKm}:${back}`, NOTABLE_TTL_MIN, () =>
		ebirdFetch<EbirdObs[]>(
			`/data/obs/geo/recent/notable?lat=${la}&lng=${ln}&dist=${distKm}&back=${back}&detail=simple`,
			apiKey,
			{ signal: opts?.signal }
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

export interface EbirdHotspot {
	locId: string;
	locName: string;
	lat: number;
	lng: number;
	numSpeciesAllTime?: number;
	latestObsDt?: string;
	/** State/province region code, e.g. 'US-ME' (present in the API payload). */
	subnational1Code?: string;
	/** County region code, e.g. 'US-ME-009' (present in the API payload). */
	subnational2Code?: string;
}

const HOTSPOT_TTL_MIN = 1440; // hotspots change rarely

/** All eBird hotspots in a region (ref/hotspot/{regionCode}) — e.g. one county. */
export async function hotspotsInRegion(
	apiKey: string,
	regionCode: string
): Promise<CachedResult<EbirdHotspot[]>> {
	const region = regionCode.trim();
	return cachedFetch(`hotspotsRegion:${region}`, HOTSPOT_TTL_MIN, () =>
		ebirdFetch<EbirdHotspot[]>(`/ref/hotspot/${encodeURIComponent(region)}?fmt=json`, apiKey)
	);
}

/**
 * Recent observations at a single location (data/obs/{locId}/recent) — the
 * Hotspot Workspace Phase-1 feed (plan: docs/2026-08-18-hotspot-workspace-
 * plan-CC1.md). back is whitelisted by the caller to 7|14|30 (GROK pin).
 *
 * includeProvisional=true (Gaylon, td-e64d93 session 2026-08-18): eBird's
 * default EXCLUDES not-yet-reviewed records — which is exactly what a
 * flagged rarity is, so a Roseate Tern that fired a need alert was invisible
 * on its hotspot's Recent tab. Provisional rows arrive with obsValid=false
 * and render with the Unconfirmed chip ("ALL reports" ruling; the GROK
 * Phase-1 review anticipated precisely this pairing). Cache namespace bumped
 * (hotspotObs2) so stale provisional-free payloads never serve.
 */
export async function recentHotspotObs(
	apiKey: string,
	locId: string,
	back: number
): Promise<CachedResult<EbirdObs[]>> {
	const loc = locId.trim();
	const b = Math.min(Math.max(Math.trunc(back), 1), 30);
	return cachedFetch(`hotspotObs2:${loc}:${b}`, OBS_TTL_MIN, () =>
		ebirdFetch<EbirdObs[]>(
			`/data/obs/${encodeURIComponent(loc)}/recent?back=${b}&detail=simple&includeProvisional=true`,
			apiKey
		)
	);
}

/** eBird species-code shape — validated before entering a URL path. */
const SPECIES_CODE_RE = /^[a-z][a-z0-9-]{1,14}$/;

export function validEbirdSpeciesCode(code: string): boolean {
	return SPECIES_CODE_RE.test(code);
}

/**
 * Nearest recent observations of ONE species (data/nearest/geo/recent) —
 * the previously unused endpoint behind "what's the closest bird I've never
 * seen?" (td-a6c322; plan docs/2026-08-19-nearest-lifer-weekly-timing-plan).
 * GROK pins: NO dist param (unbounded is the feature), NO hotspot=true
 * (would hide personal locations — ALL-reports ruling),
 * includeProvisional=true, maxResults=5, coords rounded in the key like
 * recentNearbyObs. Callers sort by OUR haversine, never API order.
 */
export async function nearestObsOfSpecies(
	apiKey: string,
	speciesCode: string,
	lat: number,
	lng: number,
	back: number,
	opts: { deadlineMs?: number } = {}
): Promise<CachedResult<EbirdObs[]>> {
	if (!validEbirdSpeciesCode(speciesCode)) {
		throw new EbirdError('Unrecognized species code.', 400);
	}
	const b = Math.min(Math.max(Math.trunc(back), 1), 30);
	const la = lat.toFixed(2);
	const ln = lng.toFixed(2);
	// `deadlineMs` is INTERNAL POLICY, built inside the fetcher closure rather
	// than taken as a caller AbortSignal: `cachedFetch` coalesces concurrent
	// callers of this key onto one promise, and a caller-owned signal would let
	// whoever navigated away cancel the fetch another request is awaiting.
	// Coalesced callers therefore share whichever policy started the call.
	return cachedFetch(`nearestObs:${speciesCode}:${la}:${ln}:${b}`, OBS_TTL_MIN, () =>
		ebirdFetch<EbirdObs[]>(
			`/data/nearest/geo/recent/${encodeURIComponent(speciesCode)}?lat=${la}&lng=${ln}&back=${b}&includeProvisional=true&maxResults=5`,
			apiKey,
			{ deadlineMs: opts.deadlineMs }
		)
	);
}

/**
 * Recent observations of ONE species inside ONE region — the ladder's rung
 * (td-73e6f9).
 *
 * This is the endpoint that makes "nearest, any distance" viable again.
 * `/data/nearest/geo/recent` does a radial scan whose cost grows with the
 * species' record volume, so a common bird far from its range never returns;
 * this one is region-indexed and answers in the same fraction of a second
 * whether the region is empty or huge (measured 2026-09-01: Black-capped
 * Chickadee across all of New York, 2,071 rows, 0.45 s; European Robin across
 * Great Britain, 4,288 rows, 0.45 s; an empty state 0.24 s / 2 bytes).
 *
 * Parameter choices are pinned, not defaulted:
 * - `includeProvisional=true` matches `nearestObsOfSpecies`. This endpoint
 *   defaults it FALSE, so omitting it would silently change which reports
 *   count as "nearest" depending on which path answered.
 * - `maxResults=10000` is the documented ceiling. eBird does not return rows
 *   in distance order, so a truncated payload can hide the closest report —
 *   callers must treat a full 10,000 as saturated rather than complete.
 * - An 8 s deadline is built in here rather than inherited: measured rungs run
 *   0.24–0.49 s, and a ladder that let rungs use the 45 s module ceiling could
 *   stack past nginx's 60 s cut.
 */
export const REGION_PROBE_DEADLINE_MS = 8_000;
export const REGION_PROBE_MAX_RESULTS = 10_000;

export async function recentSpeciesInRegion(
	apiKey: string,
	regionCode: string,
	speciesCode: string,
	back: number
): Promise<CachedResult<EbirdObs[]>> {
	if (!validEbirdSpeciesCode(speciesCode)) {
		throw new EbirdError('Unrecognized species code.', 400);
	}
	const region = regionCode.trim();
	// Clamped BEFORE both the URL and the cache key, so `back=0` and `back=1`
	// cannot occupy different keys while fetching identical data.
	const b = Math.min(Math.max(Math.trunc(back), 1), 30);
	return cachedFetch(`spReg:${region}:${speciesCode}:${b}`, OBS_TTL_MIN, () =>
		ebirdFetch<EbirdObs[]>(
			`/data/obs/${encodeURIComponent(region)}/recent/${encodeURIComponent(speciesCode)}` +
				`?back=${b}&includeProvisional=true&maxResults=${REGION_PROBE_MAX_RESULTS}`,
			apiKey,
			{ deadlineMs: REGION_PROBE_DEADLINE_MS }
		)
	);
}

/** eBird hotspots within distKm of a point (ref/hotspot/geo). */
export async function hotspotsNear(
	apiKey: string,
	lat: number,
	lng: number,
	distKm: number
): Promise<CachedResult<EbirdHotspot[]>> {
	const la = lat.toFixed(2);
	const ln = lng.toFixed(2);
	const dist = Math.min(Math.max(distKm, 1), 50);
	return cachedFetch(`hotspots:${la}:${ln}:${dist}`, HOTSPOT_TTL_MIN, () =>
		ebirdFetch<EbirdHotspot[]>(`/ref/hotspot/geo?lat=${la}&lng=${ln}&dist=${dist}&fmt=json`, apiKey)
	);
}

export interface EbirdRegion {
	code: string; // e.g. 'US-FL' (subnational1), 'US-FL-057' (subnational2)
	name: string;
}

const REGION_TTL_MIN = 43_200; // 30 days — political subdivisions barely change

/** Child regions of a parent (ref/region/list): states of a country, counties of a state. */
export async function subregions(
	apiKey: string,
	parentRegion: string,
	level: 'subnational1' | 'subnational2'
): Promise<CachedResult<EbirdRegion[]>> {
	const parent = parentRegion.trim();
	return cachedFetch(`regions:${level}:${parent}`, REGION_TTL_MIN, () =>
		ebirdFetch<EbirdRegion[]>(
			`/ref/region/list/${level}/${encodeURIComponent(parent)}?fmt=json`,
			apiKey
		)
	);
}

/** All eBird countries (ref/region/list/country/world) — drives the country
 * picker for international region loads (td-f1d6da). Same cache/TTL shape
 * as subregions(): political geography barely changes. */
export async function countries(apiKey: string): Promise<CachedResult<EbirdRegion[]>> {
	return cachedFetch('regions:country:world', REGION_TTL_MIN, () =>
		ebirdFetch<EbirdRegion[]>('/ref/region/list/country/world?fmt=json', apiKey)
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
	// Exempt from the module ceiling: this is a multi-megabyte download on the
	// worker, not a request path, and 45 s would be far too tight.
	const taxa = await ebirdFetch<TaxonEntry[]>('/ref/taxonomy/ebird?fmt=json', apiKey, {
		deadlineMs: 180_000
	});
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

