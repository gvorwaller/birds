/**
 * Hotspot Workspace Phase 1 — server gateway for /hotspots/[locId]
 * (plan: docs/2026-08-18-hotspot-workspace-plan-CC1.md; GROK pins binding).
 *
 * There is no hotspots table by design: metadata comes from the cached
 * hotspot payloads (ebird_cache stores full raw JSON), the frequency_fetch
 * row when loaded, and the previously-dark ebird_locations Google data.
 */
import { query } from '$lib/db';
import {
	FREQ_LIKELY,
	FREQ_POSSIBLE,
	monthlyStat,
	richnessFromSpecies,
	type MonthRichness
} from '$server/forecast';

const LOC_ID_RE = /^L\d+$/;

export function validLocId(locId: string): boolean {
	return LOC_ID_RE.test(locId);
}

export interface HotspotMeta {
	locId: string;
	locName: string | null;
	lat: number | null;
	lng: number | null;
	countyCode: string | null;
	stateCode: string | null;
	numSpeciesAllTime: number | null;
	latestObsDt: string | null;
	/** Found in any cached hotspot payload → it's a verified eBird hotspot. */
	isHotspot: boolean;
}

/**
 * Resolve one locId from the cached hotspot payloads (first match wins).
 * A jsonb scan over hotspot caches — acceptable for a single page load; the
 * partial index keeps the candidate set small (hotspot namespaces only).
 */
export async function hotspotFromCache(locId: string): Promise<HotspotMeta | null> {
	const r = await query<{
		loc_name: string | null;
		lat: number | null;
		lng: number | null;
		subnational1: string | null;
		subnational2: string | null;
		num_species: number | null;
		latest_obs: string | null;
	}>(
		`SELECT h->>'locName' AS loc_name,
		        (h->>'lat')::float8 AS lat,
		        (h->>'lng')::float8 AS lng,
		        h->>'subnational1Code' AS subnational1,
		        h->>'subnational2Code' AS subnational2,
		        (h->>'numSpeciesAllTime')::int AS num_species,
		        h->>'latestObsDt' AS latest_obs
		   FROM ebird_cache c, jsonb_array_elements(c.payload) h
		  WHERE (c.cache_key LIKE 'hotspotsRegion:%' OR c.cache_key LIKE 'hotspots:%')
		    AND h->>'locId' = $1
		  ORDER BY c.fetched_at DESC
		  LIMIT 1`,
		[locId]
	);
	const row = r.rows[0];
	if (!row) return null;
	return {
		locId,
		locName: row.loc_name,
		lat: row.lat,
		lng: row.lng,
		countyCode: row.subnational2,
		stateCode: row.subnational1,
		numSpeciesAllTime: row.num_species,
		latestObsDt: row.latest_obs,
		isHotspot: true
	};
}

export interface HotspotPlace {
	googlePlaceId: string | null;
	googlePlaceName: string | null;
	/** Allowlisted venue types, only for confident matches (GROK pin). */
	venueTypes: string[];
	locName: string | null;
}

/** Meaningful venue types; generic establishment/POI noise dropped (GROK). */
const VENUE_ALLOWLIST: Record<string, string> = {
	park: 'park',
	national_park: 'national park',
	state_park: 'state park',
	natural_feature: 'natural area',
	campground: 'campground',
	rv_park: 'RV park',
	hiking_area: 'hiking area',
	wildlife_refuge: 'wildlife refuge',
	zoo: 'zoo',
	beach: 'beach',
	marina: 'marina',
	cemetery: 'cemetery',
	golf_course: 'golf course'
};
const MIN_VENUE_CONFIDENCE = 0.7; // mirrors location-placeids DEFAULT_MIN_CONFIDENCE

export async function hotspotPlace(locId: string): Promise<HotspotPlace> {
	const r = await query<{
		loc_name: string | null;
		google_place_id: string | null;
		google_place_name: string | null;
		google_place_types: string[];
		google_place_confidence: number | null;
		google_place_status: string | null;
	}>(
		`SELECT loc_name, google_place_id, google_place_name, google_place_types,
		        google_place_confidence, google_place_status
		   FROM ebird_locations WHERE loc_id = $1`,
		[locId]
	);
	const row = r.rows[0];
	if (!row) return { googlePlaceId: null, googlePlaceName: null, venueTypes: [], locName: null };
	const confident =
		row.google_place_status === 'matched' &&
		(row.google_place_confidence ?? 0) >= MIN_VENUE_CONFIDENCE;
	const venueTypes = confident
		? [...new Set((row.google_place_types ?? []).map((t) => VENUE_ALLOWLIST[t]).filter(Boolean))]
		: [];
	return {
		googlePlaceId: confident ? row.google_place_id : null,
		googlePlaceName: confident ? row.google_place_name : null,
		venueTypes: venueTypes as string[],
		locName: row.loc_name
	};
}

export interface HotspotMonthSpecies {
	speciesCode: string;
	comName: string;
	freq: number;
	n: number;
	lowSample: boolean;
	need: boolean;
	band: 'likely' | 'possible' | 'longshot';
}

export interface HotspotMonthly {
	/** Needs-richness per month for the year strip (needs only). */
	year: MonthRichness[];
	/** Species present in the selected month, needs first, by freq. */
	species: HotspotMonthSpecies[];
}

const MIN_MONTH_N = 10;

/**
 * Monthly view for ONE loaded hotspot: per-species month frequency from the
 * stored 48-week data + needs overlay. Pure DB read (Monthly tab must never
 * hit eBird — GROK pin).
 */
export async function hotspotMonthly(
	locId: string,
	month: number,
	seen: ReadonlySet<string>,
	sampleSizes: readonly number[]
): Promise<HotspotMonthly> {
	const rows = await query<{ species_code: string; com_name: string; week: number; freq: number }>(
		`SELECT sf.species_code, tc.com_name, sf.week, sf.freq
		   FROM species_frequency sf
		   JOIN taxonomy_cache tc USING (species_code)
		  WHERE sf.loc_code = $1 AND tc.category = 'species'`,
		[locId]
	);
	const bySpecies = new Map<string, { comName: string; freqByWeek: Map<number, number> }>();
	for (const r of rows.rows) {
		let e = bySpecies.get(r.species_code);
		if (!e) {
			e = { comName: r.com_name, freqByWeek: new Map() };
			bySpecies.set(r.species_code, e);
		}
		e.freqByWeek.set(r.week, Number(r.freq));
	}

	const byMonth = new Map<number, { areaFreq: number; lowSample: boolean }[]>();
	const monthSpecies: HotspotMonthSpecies[] = [];
	for (const [code, e] of bySpecies) {
		const need = !seen.has(code);
		for (let m = 1; m <= 12; m++) {
			const stat = monthlyStat(e.freqByWeek, sampleSizes, m);
			if (stat.freq <= 0) continue;
			if (need) {
				const list = byMonth.get(m) ?? [];
				list.push({ areaFreq: stat.freq, lowSample: stat.n < MIN_MONTH_N });
				byMonth.set(m, list);
			}
			if (m === month) {
				monthSpecies.push({
					speciesCode: code,
					comName: e.comName,
					freq: stat.freq,
					n: stat.n,
					lowSample: stat.n < MIN_MONTH_N,
					need,
					band:
						stat.freq >= FREQ_LIKELY
							? 'likely'
							: stat.freq >= FREQ_POSSIBLE
								? 'possible'
								: 'longshot'
				});
			}
		}
	}
	monthSpecies.sort(
		(a, b) => Number(b.need) - Number(a.need) || b.freq - a.freq || a.comName.localeCompare(b.comName)
	);
	return { year: richnessFromSpecies(byMonth), species: monthSpecies };
}

/**
 * Resolve region codes (US-FL, US-FL-103) to display names from the cached
 * subregion lists — read-only, loader-safe (never fetches).
 */
export async function regionNames(codes: readonly string[]): Promise<Map<string, string>> {
	const wanted = codes.filter(Boolean);
	if (wanted.length === 0) return new Map();
	const r = await query<{ code: string; name: string }>(
		`SELECT DISTINCT h->>'code' AS code, h->>'name' AS name
		   FROM ebird_cache c, jsonb_array_elements(c.payload) h
		  WHERE c.cache_key LIKE 'regions:%'
		    AND h->>'code' = ANY($1)`,
		[wanted]
	);
	return new Map(r.rows.map((x) => [x.code, x.name]));
}
