/**
 * The "Where and when to look" view (td-eec7db Phase 4, td-b6ddfc):
 * /reports/[source]/[region]. One source, one region, optionally one
 * municipality: which species are reported there in a month, which months
 * and municipalities each species is reported in, the places with the most
 * reports and the most active birders. Counts of reports, never likelihoods.
 * Plan: docs/2026-10-21-external-sources-plan-CC.md → "Phase 4 rev B".
 */
import type { PoolClient } from 'pg';
import { withReadSnapshot } from '$lib/db';
import {
	PIN_MAX_UNCERTAINTY_M,
	externalSourcesForRegion,
	type ExternalObserver,
	type ExternalRegionState
} from './reports';

type Db = Pick<PoolClient, 'query'>;

/** Municipalities named per species at region scope. */
export const WHERE_PLACES = 3;

export interface WhereWhenPlace {
	/** The municipality's name, unique within the region; the URL's `place`. */
	name: string;
	/** All bird reports there, Jan…Dec. */
	monthTotals: number[];
	reports: number;
}

export interface WhereWhenSpecies {
	code: string;
	name: string;
	sciName: string | null;
	/** The viewer's life list has it. */
	seen: boolean;
	/** Reports in the chosen place, Jan…Dec. */
	months: number[];
	reports: number;
	/** Region scope only: the municipalities with most reports in the chosen month. */
	whereMonth: { name: string; reports: number }[];
	/** Region scope only: the municipalities with most reports across the window. */
	whereWindow: { name: string; reports: number }[];
}

/** Region scope: each municipality's figures for the chosen month and the window. */
export interface WhereWhenPlaceRow {
	name: string;
	monthReports: number;
	monthSpecies: number;
	monthNeeds: number;
	reports: number;
	species: number;
	needs: number;
}

export interface WhereWhenLocality {
	rank: number;
	locality: string;
	reports: number;
	/** Only for a locality that passes the source's pin rule. */
	lat: number | null;
	lon: number | null;
}

export interface WhereWhenView {
	state: ExternalRegionState;
	regionName: string;
	month: number;
	/** The chosen municipality; null for the whole region. */
	place: string | null;
	/** Every municipality, by name. */
	places: WhereWhenPlace[];
	/** All bird reports in the chosen place (region or municipality), Jan…Dec. */
	monthTotals: number[];
	species: WhereWhenSpecies[];
	/** Region scope only. */
	placeRows: WhereWhenPlaceRow[];
	/** Municipality scope only: its places with most reports, all birds. */
	localities: WhereWhenLocality[];
	/** The most active birders in the chosen place; empty unless the source stores observers. */
	observers: ExternalObserver[];
}

function months12(): number[] {
	return new Array<number>(12).fill(0);
}

/**
 * The view, or null when the source is not active or does not cover the
 * region. `place` is a municipality name; one the region does not have
 * reads as the whole region. `userId` decides "seen" (the viewer's scope).
 */
export function externalWhereWhen(opts: {
	sourceId: string;
	regionCode: string;
	place: string | null;
	month: number;
	userId: number;
}): Promise<WhereWhenView | null> {
	return withReadSnapshot((db) => _readWhereWhen(db, opts));
}

/** Exported for the snapshot test only. */
export async function _readWhereWhen(
	db: Db,
	opts: { sourceId: string; regionCode: string; place: string | null; month: number; userId: number }
): Promise<WhereWhenView | null> {
	const { sourceId, regionCode, month, userId } = opts;
	const state = (await externalSourcesForRegion(regionCode, db)).find((s) => s.source.id === sourceId);
	if (!state) return null;
	const region = await db.query<{ name: string }>('SELECT name FROM regions WHERE code = $1', [regionCode]);
	const regionName = region.rows[0]?.name ?? regionCode;
	const empty: WhereWhenView = {
		state,
		regionName,
		month,
		place: null,
		places: [],
		monthTotals: months12(),
		species: [],
		placeRows: [],
		localities: [],
		observers: []
	};
	if (!state.published) return empty;

	// Totals for the region and every municipality, keyed by place.
	const totals = await db.query<{
		place_key: string;
		name: string;
		level: string;
		month: number | null;
		reports: number | null;
	}>(
		`SELECT p.place_key, p.name, p.level, t.month, t.reports
		   FROM external_places p
		   LEFT JOIN external_place_month_totals t ON t.source_id = p.source_id AND t.place_key = p.place_key
		  WHERE p.source_id = $1 AND p.region_code = $2`,
		[sourceId, regionCode]
	);
	const byKey = new Map<string, { name: string; level: string; months: number[] }>();
	for (const t of totals.rows) {
		let e = byKey.get(t.place_key);
		if (!e) {
			e = { name: t.name, level: t.level, months: months12() };
			byKey.set(t.place_key, e);
		}
		if (t.month != null) e.months[t.month - 1] = Number(t.reports ?? 0);
	}
	const places: WhereWhenPlace[] = [...byKey.values()]
		.filter((e) => e.level === 'subregion')
		.map((e) => ({ name: e.name, monthTotals: e.months, reports: e.months.reduce((a, b) => a + b, 0) }))
		.sort((a, b) => a.name.localeCompare(b.name, 'nb'));
	const placeKey = [...byKey.entries()].find(([, e]) => e.level === 'subregion' && e.name === opts.place)?.[0] ?? null;
	const key = placeKey ?? regionCode;

	const species = await db.query<{
		species_code: string;
		com_name: string | null;
		sci_name: string | null;
		seen: boolean;
		month: number;
		reports: number;
	}>(
		`SELECT x.species_code, t.com_name, t.sci_name, x.month, x.reports,
		        EXISTS (SELECT 1 FROM seen_species s WHERE s.user_id = $3 AND s.species_code = x.species_code) AS seen
		   FROM external_place_month_species x
		   LEFT JOIN taxonomy_cache t ON t.species_code = x.species_code
		  WHERE x.source_id = $1 AND x.place_key = $2 AND x.reports > 0
		  ORDER BY t.taxon_order NULLS LAST, x.species_code`,
		[sourceId, key, userId]
	);
	const bySpecies = new Map<string, WhereWhenSpecies>();
	for (const r of species.rows) {
		let s = bySpecies.get(r.species_code);
		if (!s) {
			s = {
				code: r.species_code,
				name: r.com_name ?? r.species_code,
				sciName: r.sci_name,
				seen: r.seen,
				months: months12(),
				reports: 0,
				whereMonth: [],
				whereWindow: []
			};
			bySpecies.set(r.species_code, s);
		}
		s.months[r.month - 1] = Number(r.reports);
		s.reports += Number(r.reports);
	}

	let placeRows: WhereWhenPlaceRow[] = [];
	let localities: WhereWhenLocality[] = [];
	if (!placeKey) {
		// Each species' top municipalities, for the month and for the window.
		const where = await db.query<{
			species_code: string;
			name: string;
			w: string;
			mo: string | null;
			rw: string;
			rm: string;
		}>(
			`WITH m AS (
			   SELECT x.species_code, p.name, SUM(x.reports) AS w, SUM(x.reports) FILTER (WHERE x.month = $3) AS mo
			     FROM external_place_month_species x
			     JOIN external_places p ON p.source_id = x.source_id AND p.place_key = x.place_key
			    WHERE x.source_id = $1 AND x.region_code = $2 AND p.level = 'subregion' AND x.reports > 0
			    GROUP BY x.species_code, p.name)
			 SELECT species_code, name, w, mo, rw, rm FROM (
			   SELECT m.*,
			          row_number() OVER (PARTITION BY species_code ORDER BY w DESC, name) AS rw,
			          row_number() OVER (PARTITION BY species_code ORDER BY mo DESC NULLS LAST, name) AS rm
			     FROM m) r
			  WHERE rw <= ${WHERE_PLACES} OR (rm <= ${WHERE_PLACES} AND mo > 0)
			  ORDER BY species_code, name`,
			[sourceId, regionCode, month]
		);
		const ranked = new Map<
			string,
			{ w: { name: string; reports: number; r: number }[]; m: { name: string; reports: number; r: number }[] }
		>();
		for (const r of where.rows) {
			const e = ranked.get(r.species_code) ?? { w: [], m: [] };
			if (Number(r.rw) <= WHERE_PLACES) e.w.push({ name: r.name, reports: Number(r.w), r: Number(r.rw) });
			if (Number(r.rm) <= WHERE_PLACES && Number(r.mo ?? 0) > 0)
				e.m.push({ name: r.name, reports: Number(r.mo), r: Number(r.rm) });
			ranked.set(r.species_code, e);
		}
		for (const [code, e] of ranked) {
			const s = bySpecies.get(code);
			if (!s) continue;
			s.whereWindow = e.w.sort((a, b) => a.r - b.r).map(({ name, reports }) => ({ name, reports }));
			s.whereMonth = e.m.sort((a, b) => a.r - b.r).map(({ name, reports }) => ({ name, reports }));
		}

		const rows = await db.query<{
			name: string;
			month_species: string;
			month_needs: string;
			species: string;
			needs: string;
		}>(
			`SELECT p.name,
			        COUNT(DISTINCT x.species_code) FILTER (WHERE x.month = $3) AS month_species,
			        COUNT(DISTINCT x.species_code) FILTER (WHERE x.month = $3 AND s.species_code IS NULL) AS month_needs,
			        COUNT(DISTINCT x.species_code) AS species,
			        COUNT(DISTINCT x.species_code) FILTER (WHERE s.species_code IS NULL) AS needs
			   FROM external_place_month_species x
			   JOIN external_places p ON p.source_id = x.source_id AND p.place_key = x.place_key
			   LEFT JOIN seen_species s ON s.user_id = $4 AND s.species_code = x.species_code
			  WHERE x.source_id = $1 AND x.region_code = $2 AND p.level = 'subregion' AND x.reports > 0
			  GROUP BY p.name`,
			[sourceId, regionCode, month, userId]
		);
		const counts = new Map(rows.rows.map((r) => [r.name, r]));
		placeRows = places.map((p) => {
			const c = counts.get(p.name);
			return {
				name: p.name,
				monthReports: p.monthTotals[month - 1],
				monthSpecies: Number(c?.month_species ?? 0),
				monthNeeds: Number(c?.month_needs ?? 0),
				reports: p.reports,
				species: Number(c?.species ?? 0),
				needs: Number(c?.needs ?? 0)
			};
		});
	} else {
		const locs = await db.query<{
			rank: number;
			locality: string;
			reports: number;
			lat: number | null;
			lon: number | null;
			uncertainty_m: number | null;
			placement: string;
		}>(
			`SELECT rank, locality, reports, lat, lon, uncertainty_m, placement
			   FROM external_top_localities WHERE source_id = $1 AND place_key = $2 ORDER BY rank`,
			[sourceId, placeKey]
		);
		localities = locs.rows.map((l) => {
			// The connector's pin rule decides; the 1 km bound is a guard on top of it.
			const pin =
				l.placement === 'pin' &&
				l.lat != null &&
				l.lon != null &&
				l.uncertainty_m != null &&
				l.uncertainty_m <= PIN_MAX_UNCERTAINTY_M;
			return {
				rank: l.rank,
				locality: l.locality,
				reports: Number(l.reports),
				lat: pin ? l.lat : null,
				lon: pin ? l.lon : null
			};
		});
	}

	let observers: ExternalObserver[] = [];
	if (state.source.storeObservers) {
		const o = await db.query<ExternalObserver>(
			`SELECT rank, observer, days, species, localities, reports
			   FROM external_top_observers WHERE source_id = $1 AND place_key = $2 ORDER BY rank`,
			[sourceId, key]
		);
		observers = o.rows;
	}

	return {
		state,
		regionName,
		month,
		place: placeKey ? (byKey.get(placeKey)?.name ?? null) : null,
		places,
		monthTotals: byKey.get(key)?.months ?? months12(),
		species: [...bySpecies.values()],
		placeRows,
		localities,
		observers
	};
}
