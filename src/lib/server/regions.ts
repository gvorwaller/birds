/**
 * Region reference data accessor (refactor plan Phase 3,
 * docs/2026-08-30-regions-reference-data-refactor-plan.md).
 *
 * The `regions` table (0043) is static reference data seeded offline by
 * scripts/generate-regions.mjs — so it is loaded ONCE per process and served
 * from memory (~4,250 rows ≈ 300 KB). Deploys restart the process right
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

export interface Region {
	code: string;
	name: string;
	level: 'country' | 'subnational1';
	parent: string | null;
	lat: number;
	lon: number;
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
	}>('SELECT code, name, level, parent_code, lat, lon FROM regions');
	const byCode = new Map<string, Region>();
	for (const row of r.rows) {
		byCode.set(row.code, {
			code: row.code,
			name: row.name,
			level: row.level,
			parent: row.parent_code,
			lat: Number(row.lat),
			lon: Number(row.lon)
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

/** A country's subnational1 regions, name-sorted. Replaces `subregions(…, 'subnational1')` on read paths. */
export async function subnational1Of(country: string): Promise<Region[]> {
	return (await regionIndex()).sub1ByCountry.get(country) ?? [];
}

export async function regionCoords(code: string): Promise<{ lat: number; lon: number } | null> {
	const r = await getRegion(code);
	return r ? { lat: r.lat, lon: r.lon } : null;
}

/** Coordinates for many codes at once — the shape the proximity pickers consume. */
export async function regionCoordsFor(
	codes: readonly string[]
): Promise<Map<string, { lat: number; lon: number }>> {
	const idx = await regionIndex();
	const out = new Map<string, { lat: number; lon: number }>();
	for (const code of new Set(codes)) {
		const r = idx.byCode.get(code);
		if (r) out.set(code, { lat: r.lat, lon: r.lon });
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
