/**
 * Region reference data accessor (refactor plan Phase 3,
 * docs/2026-08-30-regions-reference-data-refactor-plan.md).
 *
 * The `regions` table (0043) is static reference data seeded offline by
 * scripts/generate-regions.mjs — so it is loaded ONCE per process and served
 * from memory (3,621 rows ≈ 300 KB). Deploys restart the process right
 * after migrating, so a new seed is picked up by the same deploy that ships
 * it; there is deliberately no TTL, because the contrast with the deleted
 * region_centroids runtime cache is the whole point of the refactor.
 *
 * THE LABEL RULE (the one place the render sites look):
 * - country              → bare name            ("Denmark")
 * - subnational1         → "Name, CountryName"  ("Bornholm, Denmark")
 * - within its own country (opts.within) → bare ("Bornholm") — for pages
 *   already scoped to a country, where the suffix is noise (AGY review)
 * - unknown code         → null, NEVER a guess. Callers fall back to
 *   countyMeta() / loc_name / the raw code explicitly, at the call site.
 * - subnational2 is out of scope by design (plan decision 2) → null.
 */
import { query } from '$lib/db';
import { parseRegionCode } from '$lib/region-code';
import { boxSupportsProximity, type RegionBox } from '$lib/geo';
// Inlined by Vite at build time — see EXCLUDED_PARENTS below.
import EXCLUDED_CODES_RAW from '../../../backend/db/regions-excluded-codes.txt?raw';

export interface Region {
	code: string;
	name: string;
	level: 'country' | 'subnational1';
	parent: string | null;
	lat: number;
	lon: number;
	/**
	 * The region's extent (0047). Null for codes eBird gives no usable box
	 * for — those degrade to centroid distance rather than carry an invented
	 * one (td-a4a3bf). `minLon > maxLon` is a legal antimeridian wrap.
	 */
	box: RegionBox | null;
}

interface RegionIndex {
	byCode: Map<string, Region>;
	/** Sorted by localeCompare (Åland, Östergötland are real data). */
	countries: Region[];
	sub1ByCountry: Map<string, Region[]>;
}

async function load(): Promise<RegionIndex> {
	const r = await query<{
		code: string;
		name: string;
		level: 'country' | 'subnational1';
		parent_code: string | null;
		lat: number;
		lon: number;
		min_lat: number | null;
		max_lat: number | null;
		min_lon: number | null;
		max_lon: number | null;
	}>(
		`SELECT code, name, level, parent_code, lat, lon,
		        min_lat, max_lat, min_lon, max_lon
		   FROM regions`
	);
	// A successful zero-row read is not a valid reference snapshot. This can
	// happen when a process starts after 0043 creates the table but before 0044
	// seeds it (most plausibly in local/manual startup). Treat it like a failed
	// bootstrap so regionIndex() clears the memo and a later call can recover;
	// caching it would make every picker/validator empty until process restart.
	if (r.rows.length === 0) {
		throw new Error('regions reference table is empty');
	}
	const byCode = new Map<string, Region>();
	for (const row of r.rows) {
		byCode.set(row.code, {
			code: row.code,
			name: row.name,
			level: row.level,
			parent: row.parent_code,
			lat: Number(row.lat),
			lon: Number(row.lon),
			// All four or none (0047 CHECK); a partial row cannot exist.
			box:
				row.min_lat != null && row.max_lat != null && row.min_lon != null && row.max_lon != null
					? {
							minLat: Number(row.min_lat),
							maxLat: Number(row.max_lat),
							minLon: Number(row.min_lon),
							maxLon: Number(row.max_lon)
						}
					: null
		});
	}
	const byName = (a: Region, b: Region) =>
		a.name.localeCompare(b.name) || a.code.localeCompare(b.code);
	const countries = [...byCode.values()].filter((x) => x.level === 'country').sort(byName);
	const sub1ByCountry = new Map<string, Region[]>();
	for (const x of byCode.values()) {
		if (x.level !== 'subnational1' || !x.parent) continue;
		let list = sub1ByCountry.get(x.parent);
		if (!list) sub1ByCountry.set(x.parent, (list = []));
		list.push(x);
	}
	for (const list of sub1ByCountry.values()) list.sort(byName);
	return { byCode, countries, sub1ByCountry };
}

/**
 * Memoize the PROMISE (concurrent first callers dedup to one query — the
 * lesson the deleted 80-line inFlightCentroidFetches map learned the hard
 * way, in four lines) but RESET on rejection: caching a rejected promise
 * would turn one DB blip at bootstrap into every region lookup failing
 * until a PM2 restart (CODEX1 P2-2).
 */
let indexP: Promise<RegionIndex> | null = null;

function regionIndex(): Promise<RegionIndex> {
	return (indexP ??= load().catch((err) => {
		indexP = null;
		throw err;
	}));
}

export function __resetRegionsCacheForTests(): void {
	indexP = null;
}

export async function getRegion(code: string): Promise<Region | null> {
	return (await regionIndex()).byCode.get(code) ?? null;
}

export async function regionLabel(
	code: string,
	opts: { within?: string } = {}
): Promise<string | null> {
	const idx = await regionIndex();
	const r = idx.byCode.get(code);
	if (!r) return null;
	if (r.level === 'country') return r.name;
	if (opts.within && r.parent === opts.within) return r.name;
	const country = r.parent ? idx.byCode.get(r.parent) : null;
	return country ? `${r.name}, ${country.name}` : r.name;
}

export async function regionLabels(
	codes: readonly string[],
	opts: { within?: string } = {}
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const code of new Set(codes)) {
		const label = await regionLabel(code, opts);
		if (label != null) out.set(code, label);
	}
	return out;
}

/** World country list, name-sorted. Replaces `countries(apiKey)` on read paths. */
export async function countriesList(): Promise<Region[]> {
	return (await regionIndex()).countries;
}

/**
 * Countries where the load hub can still add frequency data.
 *
 * Non-US countries require a countrywide row plus every seeded subnational1
 * row. The US is complete once its states are loaded because a countrywide US
 * export is intentionally never offered. Older stored rows still count as
 * loaded; refreshing them is a separate workflow.
 */
export function filterCountriesNeedingFrequencyLoad(
	countries: readonly Region[],
	sub1ByCountry: ReadonlyMap<string, readonly Pick<Region, 'code'>[]>,
	loadedRegionCodes: ReadonlySet<string>
): Region[] {
	return [...countries]
		.filter((country) => {
			const children = sub1ByCountry.get(country.code) ?? [];
			const childrenComplete = children.every((child) => loadedRegionCodes.has(child.code));
			const countrywideComplete = country.code === 'US' || loadedRegionCodes.has(country.code);
			return !childrenComplete || !countrywideComplete;
		})
		.sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
}

/** World country list reduced to unfinished frequency-load work, name-sorted. */
export async function countriesNeedingFrequencyLoad(
	loadedRegionCodes: ReadonlySet<string>
): Promise<Region[]> {
	const idx = await regionIndex();
	return filterCountriesNeedingFrequencyLoad(idx.countries, idx.sub1ByCountry, loadedRegionCodes);
}

/** A country's subnational1 regions, name-sorted. Replaces `subregions(…, 'subnational1')` on read paths. */
export async function subnational1Of(country: string): Promise<Region[]> {
	return (await regionIndex()).sub1ByCountry.get(country) ?? [];
}

/**
 * Countries eBird lists a subnational1 for that we could not seed — the file
 * the generator writes when eBird has never geocoded a code (0,0 coordinates,
 * and `lat`/`lon` are NOT NULL; fabricating one is forbidden by cs.md).
 *
 * Inlined at build time rather than read from disk at runtime: the deployed
 * process must not depend on a repo path resolving relative to its cwd.
 */
const EXCLUDED_PARENTS: ReadonlySet<string> = new Set(
	EXCLUDED_CODES_RAW.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith('#'))
		.map((code) => parseRegionCode(code)?.country)
		.filter((country): country is string => !!country)
);

/**
 * Candidates for a proximity SEARCH that walks outward from a point
 * (td-73e6f9's nearest ladder), as opposed to the label/picker accessors above.
 *
 * Three arms, and the reasoning for each matters:
 *
 * 1. Every subnational1 — the tightest boxes we have, so the best bounds.
 * 2. Countries with NO seeded subnational1 — otherwise their territory is
 *    unreachable entirely.
 * 3. Countries that DO have seeded subnational1s but are missing at least one
 *    to the excluded list. Probing the country covers the hole its missing
 *    children would leave. (Hungary is missing 22 counties, Latvia 112,
 *    Moldova 29 — searching only the seeded children would silently skip
 *    them while the UI claimed the area was searched.)
 *
 * Note arm 3 keys on the EXCLUDED list, not on "a seeded code that also
 * appears in the excluded file" — the generator deletes excluded codes from
 * the seed, so that intersection is empty by construction and the arm would
 * never fire (GROK P1-2).
 *
 * Regions whose box cannot support proximity are omitted: an antimeridian
 * region's conventional [-180, 180] box is ~360° wide, so it has no usable
 * lower bound — it would sort first from everywhere and, because a zero bound
 * can never be exceeded, would also stop a branch-and-bound search from ever
 * terminating. They remain reachable through the direct nearest endpoint.
 */
export async function allProximityRegions(): Promise<{
	candidates: Region[];
	/** Excluded for an unusable box — surfaced so callers can be honest about coverage. */
	unsafe: Region[];
}> {
	const idx = await regionIndex();
	const candidates: Region[] = [];
	const unsafe: Region[] = [];
	const take = (r: Region) => {
		// A null box is not "unsafe" — it has no bound at all, and the ladder
		// handles it by sorting on the centroid and never pruning on it.
		if (r.box && !boxSupportsProximity(r.box)) unsafe.push(r);
		else candidates.push(r);
	};

	for (const country of idx.countries) {
		const children = idx.sub1ByCountry.get(country.code) ?? [];
		for (const child of children) take(child);
		if (children.length === 0 || EXCLUDED_PARENTS.has(country.code)) take(country);
	}
	return { candidates, unsafe };
}

export async function regionCoords(code: string): Promise<{ lat: number; lon: number } | null> {
	const r = await getRegion(code);
	return r ? { lat: r.lat, lon: r.lon } : null;
}

/**
 * Centroid AND extent for many codes — the shape the proximity pickers
 * consume. Carrying the box lets callers measure to a region's edge (zero
 * inside it) instead of to its centre, which is what "closest" means to a
 * birder standing in a large state (td-a4a3bf).
 */
export type RegionPoint = { lat: number; lon: number; box: RegionBox | null };

export async function regionCoordsFor(
	codes: readonly string[]
): Promise<Map<string, RegionPoint>> {
	const idx = await regionIndex();
	const out = new Map<string, RegionPoint>();
	for (const code of new Set(codes)) {
		const r = idx.byCode.get(code);
		if (r) out.set(code, { lat: r.lat, lon: r.lon, box: r.box });
	}
	return out;
}

/**
 * Validate untrusted region input in one call: syntax (via the shared
 * parser), level (country/subnational1 only — subnational2 is rejected here
 * exactly as the three former eBird-membership validators did), and
 * membership in the reference set. Replaces validateRegion +
 * its two inline duplicates; a local lookup has no network failure mode, so
 * the callers' "could not verify against eBird" 502 branches disappear.
 */
export async function validateRegionCode(raw: string): Promise<Region | null> {
	const parsed = parseRegionCode(raw);
	if (!parsed || parsed.level === 'subnational2') return null;
	return getRegion(parsed.code);
}
