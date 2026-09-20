/**
 * On-demand detail for ONE region group on /forecast/data (td-3bf3a2;
 * Gaylon 2026-08-31: "the fetch on demand is the right behavior").
 *
 * The page previously shipped every loaded location — 3,459 county rows and
 * 4,731 hotspot rows, ~1.2 MB of serialized loader data before JSON overhead
 * — on every visit, to render 65 collapsed summary lines. Even after the
 * markup stopped RENDERING collapsed groups, that payload still had to be
 * transferred, parsed, and made reactive, which is what kept the country
 * search box inert for ~10 s on a phone.
 *
 * The collapsed view needs only per-group counts, which the loader still
 * computes. This module serves the expensive part — a group's county blocks
 * and their nested hotspots — for the one group actually being opened.
 */
import { query } from '$lib/db';
import { lastCompleteYear } from '$server/barchart';
import { countyMapQuery, countySeat } from '$server/county-meta';
import { parentOf, parseRegionCode } from '$lib/region-code';

/** Mirrors the DataRow the page already renders. */
export interface DetailRow {
	locCode: string;
	locKind: 'region' | 'hotspot';
	locName: string;
	beginYear: number;
	endYear: number;
	nSpecies: number;
	nUnmatched: number;
	fetchedAt: string;
	current: boolean;
}

export interface DetailBlock {
	countyCode: string;
	countyName: string;
	seat: string | null;
	mapQuery: string;
	county: DetailRow | null;
	hotspots: DetailRow[];
}

export interface RegionDetail {
	countyBlocks: DetailBlock[];
	/** Hotspots recorded directly under the region (no subnational2 on file). */
	stateHotspots: DetailRow[];
}

/**
 * Everything nested under `regionCode`: its child regions' own rows, and
 * every hotspot whose region_code is the region or one of its children.
 * `stateName` only feeds the county Maps query string.
 */
export async function regionDetail(regionCode: string, stateName: string): Promise<RegionDetail> {
	const parsed = parseRegionCode(regionCode);
	if (!parsed || parsed.level === 'subnational2') {
		return { countyBlocks: [], stateHotspots: [] };
	}
	const code = parsed.code;
	const r = await query<{
		loc_code: string;
		loc_kind: 'region' | 'hotspot';
		loc_name: string;
		begin_year: number;
		end_year: number;
		n_species: number;
		n_unmatched: number;
		fetched_at: string;
		region_code: string | null;
		current: boolean;
	}>(
		// Scoped to one group: the region's descendants plus any hotspot filed
		// under it. The page-wide query this replaces returned every row in the
		// table.
		`SELECT loc_code, loc_kind, loc_name, begin_year, end_year, n_species,
		        n_unmatched, fetched_at, region_code,
		        (end_year >= $2) AS current
		   FROM frequency_fetch
		  WHERE (loc_kind = 'region' AND loc_code LIKE $1)
		     OR (loc_kind = 'hotspot' AND (region_code = $3 OR region_code LIKE $1))
		  ORDER BY loc_kind, loc_name`,
		[`${code}-%`, lastCompleteYear(), code]
	);

	const toRow = (x: (typeof r.rows)[number]): DetailRow => ({
		locCode: x.loc_code,
		locKind: x.loc_kind,
		locName: x.loc_name,
		beginYear: Number(x.begin_year),
		endYear: Number(x.end_year),
		nSpecies: Number(x.n_species),
		nUnmatched: Number(x.n_unmatched),
		fetchedAt: x.fetched_at,
		current: x.current
	});

	const blocks = new Map<string, DetailBlock>();
	const stateHotspots: DetailRow[] = [];
	const blockFor = (childCode: string): DetailBlock => {
		let b = blocks.get(childCode);
		if (!b) {
			b = {
				countyCode: childCode,
				countyName: childCode,
				seat: countySeat(childCode),
				mapQuery: '',
				county: null,
				hotspots: []
			};
			blocks.set(childCode, b);
		}
		return b;
	};

	for (const x of r.rows) {
		const row = toRow(x);
		if (x.loc_kind === 'region') {
			// Direct children only — a LIKE 'US-%' would also match grandchildren
			// under a country-level code (the same trap the page loader documents).
			if (parentOf(x.loc_code) !== code) continue;
			const b = blockFor(x.loc_code);
			b.county = row;
			b.countyName = row.locName;
		} else {
			const rc = x.region_code ? parseRegionCode(x.region_code) : null;
			if (rc && rc.code !== code && parentOf(rc.code) === code) {
				blockFor(rc.code).hotspots.push(row);
			} else {
				stateHotspots.push(row);
			}
		}
	}

	const countyBlocks = [...blocks.values()].sort((a, b) =>
		a.countyName.localeCompare(b.countyName)
	);
	for (const b of countyBlocks) {
		b.mapQuery = countyMapQuery(b.countyCode, b.countyName, stateName);
	}
	return { countyBlocks, stateHotspots };
}
