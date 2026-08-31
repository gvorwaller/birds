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

/** One row of the hub search results on /forecast/data. */
export interface HubHit {
	kind: 'state' | 'county' | 'hotspot' | 'failed';
	code: string;
	name: string;
	context: string;
	row: {
		beginYear: number;
		endYear: number;
		nSpecies: number;
		current: boolean;
	} | null;
	error?: string;
}

/** Results are capped; the UI says so rather than silently truncating. */
export const HUB_SEARCH_LIMIT = 200;

/**
 * Search every loaded location by name or exact code — server-side
 * (td-3bf3a2). This used to be a client-side filter over an index built from
 * the whole page payload, which is precisely why that payload had to be
 * shipped. Searching ~8,200 rows is a trivial query; shipping them to search
 * locally was the expensive part.
 */
export async function hubSearch(q: string): Promise<{ hits: HubHit[]; capped: boolean }> {
	const term = q.trim();
	if (term.length < 2) return { hits: [], capped: false };
	const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
	const exact = term.toUpperCase();

	const [loaded, failed] = await Promise.all([
		query<{
			loc_code: string;
			loc_kind: 'region' | 'hotspot';
			loc_name: string;
			region_code: string | null;
			begin_year: number;
			end_year: number;
			n_species: number;
			current: boolean;
		}>(
			`SELECT loc_code, loc_kind, loc_name, region_code, begin_year, end_year,
			        n_species, (end_year >= $3) AS current
			   FROM frequency_fetch
			  WHERE loc_name ILIKE $1 OR upper(loc_code) = $2
			  ORDER BY loc_kind, loc_name
			  LIMIT ${HUB_SEARCH_LIMIT + 1}`,
			[like, exact, lastCompleteYear()]
		),
		query<{
			loc_code: string;
			loc_name: string | null;
			region_code: string | null;
			error: string | null;
		}>(
			`SELECT a.loc_code, a.loc_name, a.region_code, a.error
			   FROM frequency_fetch_attempts a
			  WHERE a.status = 'error'
			    AND NOT EXISTS (SELECT 1 FROM frequency_fetch f WHERE f.loc_code = a.loc_code)
			    AND (a.loc_name ILIKE $1 OR upper(a.loc_code) = $2)
			  ORDER BY a.last_attempt_at DESC
			  LIMIT 50`,
			[like, exact]
		)
	]);

	// Resolve the parent names the context strings need, in ONE extra query
	// rather than per row.
	const parents = new Set<string>();
	for (const x of loaded.rows) {
		const owner = x.loc_kind === 'region' ? parentOf(x.loc_code) : x.region_code;
		if (owner) {
			parents.add(owner);
			const grand = parentOf(owner);
			if (grand) parents.add(grand);
		}
	}
	const names = new Map<string, string>();
	if (parents.size > 0) {
		const p = await query<{ loc_code: string; loc_name: string }>(
			'SELECT loc_code, loc_name FROM frequency_fetch WHERE loc_code = ANY($1)',
			[[...parents]]
		);
		for (const x of p.rows) names.set(x.loc_code, x.loc_name);
	}
	const nameOf = (code: string | null | undefined): string =>
		code ? (names.get(code) ?? code) : '';

	const hits: HubHit[] = [];
	for (const x of loaded.rows.slice(0, HUB_SEARCH_LIMIT)) {
		const row = {
			beginYear: Number(x.begin_year),
			endYear: Number(x.end_year),
			nSpecies: Number(x.n_species),
			current: x.current
		};
		if (x.loc_kind === 'region') {
			const parsed = parseRegionCode(x.loc_code);
			if (parsed?.level === 'subnational2') {
				hits.push({
					kind: 'county',
					code: x.loc_code,
					name: x.loc_name,
					context: nameOf(parentOf(x.loc_code)),
					row
				});
			} else {
				hits.push({
					kind: 'state',
					code: x.loc_code,
					name: x.loc_name,
					context: parsed?.country === 'US' ? 'statewide' : 'regionwide',
					row
				});
			}
		} else {
			const rc = x.region_code ? parseRegionCode(x.region_code) : null;
			const context =
				rc?.level === 'subnational2'
					? `${nameOf(rc.code)}, ${nameOf(parentOf(rc.code))}`
					: nameOf(x.region_code);
			hits.push({ kind: 'hotspot', code: x.loc_code, name: x.loc_name, context, row });
		}
	}
	for (const f of failed.rows) {
		hits.push({
			kind: 'failed',
			code: f.loc_code,
			name: f.loc_name ?? f.loc_code,
			context: nameOf(f.region_code),
			row: null,
			error: f.error ?? undefined
		});
	}
	return { hits, capped: loaded.rows.length > HUB_SEARCH_LIMIT };
}
