/**
 * The read side of external sources (td-eec7db Phase 3, td-6895f6): what the
 * Norway cards and panels show. Everything is driven by the registry: only
 * active sources mapped to the region appear, and each carries its own
 * name, licence and links. These are counts of reports, never likelihoods;
 * nothing here touches the eBird frequency tables.
 * Plan: docs/2026-10-21-external-sources-plan-CC.md → "Phase 3 rev B".
 */
import type { PoolClient } from 'pg';
import { query, withReadSnapshot } from '$lib/db';

/**
 * Every reader runs its statements on ONE read snapshot (CODEX1 F2): a load
 * that finishes between two plain queries would otherwise pair one load's
 * window or numerator with another's counts or denominator.
 */
type Db = Pick<PoolClient, 'query'>;

/** Latest reports shown per species and region. */
export const LATEST_REPORTS = 10;
/** Municipalities listed per species on the card. */
export const TOP_PLACES = 10;
/** A report gets a coordinate map link only within this uncertainty. */
export const PIN_MAX_UNCERTAINTY_M = 1000;

export interface ExternalSourceInfo {
	id: string;
	name: string;
	publisher: string;
	license: string;
	licenseUrl: string;
	citation: string;
	doi: string | null;
	attribution: string;
	homepage: string;
	/** The country the source covers, for map searches ("Bodø, Nordland, Norway"). */
	countryName: string;
	/** The source's page for this region, when its template gives one. */
	regionLink: string | null;
	storeObservers: boolean;
}

/** The data a region currently shows: the load that published it. */
export interface ExternalPublished {
	loadId: string;
	/** YYYY-MM-DD, inclusive. */
	windowStart: string;
	windowEnd: string;
	retrievedAt: string | null;
	finishedAt: string;
}

export interface ExternalRegionState {
	source: ExternalSourceInfo;
	published: ExternalPublished | null;
	/** A load queued or running for this region now (anyone's). */
	active: {
		status: 'queued' | 'running';
		done: number;
		total: number;
		phase: string | null;
	} | null;
	/** The last failed load, only when it is newer than the published data. */
	failed: { at: string; error: string | null } | null;
}

interface SourceRow {
	id: string;
	name: string;
	publisher: string;
	license: string;
	license_url: string;
	citation: string;
	doi: string | null;
	attribution: string;
	homepage: string;
	region_link_template: string | null;
	store_observers: boolean;
	country_name: string;
	upstream_key: string;
	load_id: string | null;
	window_start: string | null;
	window_end: string | null;
	retrieved_at: Date | null;
	finished_at: Date | null;
	active_status: string | null;
	active_progress: { phase?: string; done?: number; total?: number } | null;
	failed_error: string | null;
	failed_at: Date | null;
}

function regionLink(template: string | null, upstreamKey: string): string | null {
	if (!template) return null;
	return template.replaceAll('{upstream_key}', encodeURIComponent(upstreamKey));
}

function toState(r: SourceRow): ExternalRegionState {
	const published: ExternalPublished | null =
		r.load_id && r.window_start && r.window_end && r.finished_at
			? {
					loadId: r.load_id,
					windowStart: r.window_start,
					windowEnd: r.window_end,
					retrievedAt: r.retrieved_at?.toISOString() ?? null,
					finishedAt: r.finished_at.toISOString()
				}
			: null;
	const p = r.active_progress ?? {};
	const active = r.active_status
		? {
				status: r.active_status === 'queued' ? ('queued' as const) : ('running' as const),
				done: Number.isFinite(p.done) ? Number(p.done) : 0,
				total: Number.isFinite(p.total) ? Number(p.total) : 0,
				phase: typeof p.phase === 'string' ? p.phase : null
			}
		: null;
	const failed =
		r.failed_at && (!r.finished_at || r.failed_at > r.finished_at)
			? { at: r.failed_at.toISOString(), error: r.failed_error }
			: null;
	return {
		source: {
			id: r.id,
			name: r.name,
			publisher: r.publisher,
			license: r.license,
			licenseUrl: r.license_url,
			citation: r.citation,
			doi: r.doi,
			attribution: r.attribution,
			homepage: r.homepage,
			countryName: r.country_name,
			regionLink: regionLink(r.region_link_template, r.upstream_key),
			storeObservers: r.store_observers
		},
		published,
		active,
		failed
	};
}

/**
 * Every active source that covers this region, with what it has published
 * there and any load in progress. Empty for a region no source covers.
 */
export async function externalSourcesForRegion(regionCode: string, db?: Db): Promise<ExternalRegionState[]> {
	if (!db) return withReadSnapshot((c) => externalSourcesForRegion(regionCode, c));
	const r = await db.query<SourceRow>(
		`SELECT s.id, s.name, s.publisher, s.license, s.license_url, s.citation, s.doi, s.attribution,
		        s.homepage, s.region_link_template, s.store_observers, c.name AS country_name, m.upstream_key,
		        pl.id AS load_id, to_char(pl.window_start, 'YYYY-MM-DD') AS window_start,
		        to_char(pl.window_end, 'YYYY-MM-DD') AS window_end, pl.retrieved_at, pl.finished_at,
		        al.status AS active_status, al.progress AS active_progress,
		        fl.error AS failed_error, fl.finished_at AS failed_at
		   FROM external_sources s
		   JOIN regions c ON c.code = s.covers_country
		   JOIN external_region_map m ON m.source_id = s.id AND m.region_code = $1
		   LEFT JOIN external_places p ON p.source_id = s.id AND p.place_key = $1
		   LEFT JOIN external_loads pl ON pl.id = p.load_id
		   LEFT JOIN LATERAL (
		     SELECT status, progress FROM external_loads
		      WHERE source_id = s.id AND region_code = $1 AND status IN ('queued', 'leased', 'staging')
		      LIMIT 1) al ON true
		   LEFT JOIN LATERAL (
		     SELECT error, finished_at FROM external_loads
		      WHERE source_id = s.id AND region_code = $1 AND status = 'failed'
		      ORDER BY finished_at DESC NULLS LAST LIMIT 1) fl ON true
		  WHERE s.active
		  ORDER BY s.name, s.id`,
		[regionCode]
	);
	return r.rows.map(toState);
}

function monthArray(rows: { month: number; reports: number }[]): number[] {
	const out = new Array<number>(12).fill(0);
	for (const row of rows) out[row.month - 1] = Number(row.reports);
	return out;
}

export interface ExternalObserver {
	rank: number;
	observer: string;
	days: number;
	species: number;
	localities: number;
	reports: number;
}

export interface ExternalOverviewRegion {
	code: string;
	name: string;
	/** The source's page for this region, when its template gives one. */
	link: string | null;
	published:
		| (ExternalPublished & {
				reports: number;
				species: number;
				places: number;
				monthTotals: number[];
		  })
		| null;
	active: ExternalRegionState['active'];
	failed: ExternalRegionState['failed'];
	/** The most active observers in the region; empty unless the source stores observers. */
	observers: ExternalObserver[];
}

export interface ExternalOverviewSource {
	source: ExternalSourceInfo;
	country: { code: string; name: string };
	regions: ExternalOverviewRegion[];
}

/**
 * Hotspots & data's "Reports from other sources" card: every active source
 * with every region it covers, loaded or not. A fixed handful of queries
 * whatever the number of regions.
 */
export function externalOverview(): Promise<ExternalOverviewSource[]> {
	return withReadSnapshot(_readOverview);
}

/** Exported for the snapshot test only. */
export async function _readOverview(db: Db): Promise<ExternalOverviewSource[]> {
	const regions = await db.query<
		SourceRow & {
			source_id: string;
			region_code: string;
			region_name: string;
			covers_country: string;
		}
	>(
		`SELECT s.id, s.id AS source_id, s.name, s.publisher, s.license, s.license_url, s.citation, s.doi, s.attribution,
		        s.homepage, s.region_link_template, s.store_observers, s.covers_country, c.name AS country_name,
		        m.upstream_key, m.region_code, g.name AS region_name,
		        pl.id AS load_id, to_char(pl.window_start, 'YYYY-MM-DD') AS window_start,
		        to_char(pl.window_end, 'YYYY-MM-DD') AS window_end, pl.retrieved_at, pl.finished_at,
		        al.status AS active_status, al.progress AS active_progress,
		        fl.error AS failed_error, fl.finished_at AS failed_at
		   FROM external_sources s
		   JOIN regions c ON c.code = s.covers_country
		   JOIN external_region_map m ON m.source_id = s.id
		   JOIN regions g ON g.code = m.region_code
		   LEFT JOIN external_places p ON p.source_id = s.id AND p.place_key = m.region_code
		   LEFT JOIN external_loads pl ON pl.id = p.load_id
		   LEFT JOIN LATERAL (
		     SELECT status, progress FROM external_loads
		      WHERE source_id = s.id AND region_code = m.region_code AND status IN ('queued', 'leased', 'staging')
		      LIMIT 1) al ON true
		   LEFT JOIN LATERAL (
		     SELECT error, finished_at FROM external_loads
		      WHERE source_id = s.id AND region_code = m.region_code AND status = 'failed'
		      ORDER BY finished_at DESC NULLS LAST LIMIT 1) fl ON true
		  WHERE s.active
		  ORDER BY s.name, s.id, g.name, m.region_code`
	);
	if (regions.rows.length === 0) return [];
	const totals = await db.query<{
		source_id: string;
		place_key: string;
		month: number;
		reports: number;
	}>(
		`SELECT t.source_id, t.place_key, t.month, t.reports
			   FROM external_place_month_totals t JOIN external_sources s ON s.id = t.source_id AND s.active
			  WHERE t.place_key = t.region_code`
	);
	const species = await db.query<{
		source_id: string;
		region_code: string;
		n: string;
	}>(
		`SELECT x.source_id, x.region_code, COUNT(DISTINCT x.species_code) AS n
			   FROM external_place_month_species x JOIN external_sources s ON s.id = x.source_id AND s.active
			  WHERE x.place_key = x.region_code AND x.reports > 0
			  GROUP BY x.source_id, x.region_code`
	);
	const places = await db.query<{
		source_id: string;
		region_code: string;
		n: string;
	}>(
		`SELECT p.source_id, p.region_code, COUNT(*) AS n
			   FROM external_places p JOIN external_sources s ON s.id = p.source_id AND s.active
			  WHERE p.level = 'subregion'
			  GROUP BY p.source_id, p.region_code`
	);
	const observers = await db.query<ExternalObserver & { source_id: string; region_code: string }>(
		`SELECT o.source_id, o.region_code, o.rank, o.observer, o.days, o.species, o.localities, o.reports
			   FROM external_top_observers o JOIN external_sources s ON s.id = o.source_id AND s.active AND s.store_observers
			  WHERE o.place_key = o.region_code
			  ORDER BY o.source_id, o.region_code, o.rank`
	);
	const key = (sourceId: string, region: string) => `${sourceId}\u0000${region}`;
	const monthTotals = new Map<string, number[]>();
	for (const t of totals.rows) {
		const k = key(t.source_id, t.place_key);
		const arr = monthTotals.get(k) ?? new Array<number>(12).fill(0);
		arr[t.month - 1] = Number(t.reports);
		monthTotals.set(k, arr);
	}
	const speciesBy = new Map(species.rows.map((r) => [key(r.source_id, r.region_code), Number(r.n)]));
	const placesBy = new Map(places.rows.map((r) => [key(r.source_id, r.region_code), Number(r.n)]));
	const observersBy = new Map<string, ExternalObserver[]>();
	for (const o of observers.rows) {
		const k = key(o.source_id, o.region_code);
		const list = observersBy.get(k) ?? [];
		list.push({
			rank: o.rank,
			observer: o.observer,
			days: o.days,
			species: o.species,
			localities: o.localities,
			reports: o.reports
		});
		observersBy.set(k, list);
	}
	const out: ExternalOverviewSource[] = [];
	for (const row of regions.rows) {
		const state = toState(row);
		let s = out.at(-1);
		if (!s || s.source.id !== row.source_id) {
			// Region links belong to each region below, not to the source.
			s = {
				source: { ...state.source, regionLink: null },
				country: { code: row.covers_country, name: row.country_name },
				regions: []
			};
			out.push(s);
		}
		const k = key(row.source_id, row.region_code);
		const months = monthTotals.get(k) ?? new Array<number>(12).fill(0);
		s.regions.push({
			code: row.region_code,
			name: row.region_name,
			link: state.source.regionLink,
			published: state.published
				? {
						...state.published,
						reports: months.reduce((a, b) => a + b, 0),
						species: speciesBy.get(k) ?? 0,
						places: placesBy.get(k) ?? 0,
						monthTotals: months
					}
				: null,
			active: state.active,
			failed: state.failed,
			observers: state.published ? (observersBy.get(k) ?? []) : []
		});
	}
	return out;
}

export interface ExternalPlaceReports {
	name: string;
	reports: number;
}

export interface ExternalLatestReport {
	id: string;
	observedOn: string;
	count: number | null;
	locality: string;
	place: string | null;
	/** Only for a precise, non-generalized report. */
	lat: number | null;
	lon: number | null;
	url: string;
	/** The party as the source gives it; null unless the source stores observers. */
	observer: string | null;
}

interface LatestRow {
	upstream_record_id: string;
	observed_on: string;
	count: number | null;
	locality: string;
	place: string | null;
	lat: number | null;
	lon: number | null;
	uncertainty_m: number | null;
	generalized: boolean;
	record_url: string;
	observer: string | null;
}

export interface ExternalSpeciesCard extends ExternalRegionState {
	/** This species' reports per month (Jan…Dec); null until published. */
	months: number[] | null;
	/** All bird reports per month in the region, the share's denominator. */
	monthTotals: number[] | null;
	month: number;
	/**
	 * Municipalities for the chosen month; the whole window when the region
	 * has no reports of it that month. A month whose reports are all placed
	 * at county level keeps scope 'month' with no places.
	 */
	places: ExternalPlaceReports[];
	placesScope: 'month' | 'window';
	latest: ExternalLatestReport[];
}

/**
 * The species card on forecast/species for one region. `month` is the page's
 * chosen month; null picks this species' busiest month in the first source
 * that has reports (the page then uses it too), else the current month.
 */
export function externalSpeciesInRegion(
	regionCode: string,
	speciesCode: string,
	month: number | null,
	currentMonth: number
): Promise<{ month: number; cards: ExternalSpeciesCard[] }> {
	return withReadSnapshot((db) => _readSpeciesInRegion(db, regionCode, speciesCode, month, currentMonth));
}

/** Exported for the snapshot test only. */
export async function _readSpeciesInRegion(
	db: Db,
	regionCode: string,
	speciesCode: string,
	month: number | null,
	currentMonth: number
): Promise<{ month: number; cards: ExternalSpeciesCard[] }> {
	const states = await externalSourcesForRegion(regionCode, db);
	const read: ({
		months: number[];
		totals: number[];
		latest: LatestRow[];
	} | null)[] = [];
	for (const s of states) {
		if (!s.published) {
			read.push(null);
			continue;
		}
		const sourceId = s.source.id;
		const months = await db.query<{ month: number; reports: number }>(
			`SELECT month, reports FROM external_place_month_species
					  WHERE source_id = $1 AND place_key = $2 AND species_code = $3`,
			[sourceId, regionCode, speciesCode]
		);
		const totals = await db.query<{ month: number; reports: number }>(
			`SELECT month, reports FROM external_place_month_totals WHERE source_id = $1 AND place_key = $2`,
			[sourceId, regionCode]
		);
		const latest = await db.query<LatestRow>(
			`SELECT r.upstream_record_id, to_char(r.observed_on, 'YYYY-MM-DD') AS observed_on, r.count,
					        r.locality, CASE WHEN p.level = 'subregion' THEN p.name END AS place,
					        r.lat, r.lon, r.uncertainty_m, r.generalized, r.record_url, r.observer
					   FROM external_recent_reports r
					   LEFT JOIN external_places p ON p.source_id = r.source_id AND p.place_key = r.place_key
					  WHERE r.source_id = $1 AND r.region_code = $2 AND r.species_code = $3
					  ORDER BY r.observed_on DESC, r.upstream_record_id DESC
					  LIMIT ${LATEST_REPORTS}`,
			[sourceId, regionCode, speciesCode]
		);
		read.push({
			months: monthArray(months.rows),
			totals: monthArray(totals.rows),
			latest: latest.rows
		});
	}
	const busiest = read.map((r) => (r ? busiestMonth(r.months) : null)).find((m) => m !== null) ?? null;
	const chosen = month ?? busiest ?? currentMonth;
	const cards: ExternalSpeciesCard[] = [];
	for (const [i, s] of states.entries()) {
		const got = read[i];
		if (!got) {
			cards.push({
				...s,
				months: null,
				monthTotals: null,
				month: chosen,
				places: [],
				placesScope: 'month',
				latest: []
			});
			continue;
		}
		const places = await db.query<{
			name: string;
			reports: string;
			in_month: string | null;
		}>(
			`SELECT p.name, SUM(x.reports) AS reports,
				        SUM(x.reports) FILTER (WHERE x.month = $4) AS in_month
				   FROM external_place_month_species x
				   JOIN external_places p ON p.source_id = x.source_id AND p.place_key = x.place_key
				  WHERE x.source_id = $1 AND x.region_code = $2 AND p.level = 'subregion'
				    AND x.species_code = $3 AND x.reports > 0
				  GROUP BY p.name`,
			[s.source.id, regionCode, speciesCode, chosen]
		);
		const inMonth = places.rows
			.map((p) => ({ name: p.name, reports: Number(p.in_month ?? 0) }))
			.filter((p) => p.reports > 0);
		// The region's own count decides "no reports that month" (CODEX1 F4):
		// reports placed only at county level still count.
		const scope: 'month' | 'window' = got.months[chosen - 1] > 0 ? 'month' : 'window';
		const ranked = (
			scope === 'month' ? inMonth : places.rows.map((p) => ({ name: p.name, reports: Number(p.reports) }))
		)
			.sort((a, b) => b.reports - a.reports || a.name.localeCompare(b.name, 'nb'))
			.slice(0, TOP_PLACES);
		cards.push({
			...s,
			months: got.months,
			monthTotals: got.totals,
			month: chosen,
			places: ranked,
			placesScope: scope,
			latest: got.latest.map((r) => {
				const precise =
					!r.generalized &&
					r.lat != null &&
					r.lon != null &&
					r.uncertainty_m != null &&
					r.uncertainty_m <= PIN_MAX_UNCERTAINTY_M;
				return {
					id: r.upstream_record_id,
					observedOn: r.observed_on,
					count: r.count,
					locality: r.locality,
					place: r.place,
					lat: precise ? r.lat : null,
					lon: precise ? r.lon : null,
					url: r.record_url,
					observer: s.source.storeObservers ? r.observer : null
				};
			})
		});
	}
	return { month: chosen, cards };
}

/** The month with the most reports (earliest on a tie); null when there are none. */
function busiestMonth(months: number[]): number | null {
	let best: number | null = null;
	for (let i = 0; i < 12; i++) if (months[i] > 0 && (best === null || months[i] > months[best - 1])) best = i + 1;
	return best;
}

export interface ExternalSpeciesRegion {
	regionCode: string;
	regionName: string;
	reports: number;
	months: number[];
	windowStart: string;
	windowEnd: string;
}

export interface ExternalSpeciesSummary {
	source: Pick<ExternalSourceInfo, 'id' | 'name' | 'attribution' | 'license' | 'licenseUrl' | 'homepage'>;
	country: string;
	regions: ExternalSpeciesRegion[];
}

/**
 * Where an active source has reports of this species: each published region
 * with its total and months, busiest region first. Only regions with at least
 * one report appear. `country` narrows it to one country's sources.
 */
export async function externalSpeciesSummary(speciesCode: string, country?: string): Promise<ExternalSpeciesSummary[]> {
	const r = await query<{
		source_id: string;
		source_name: string;
		attribution: string;
		license: string;
		license_url: string;
		homepage: string;
		covers_country: string;
		region_code: string;
		region_name: string;
		month: number;
		reports: number;
		window_start: string;
		window_end: string;
	}>(
		`SELECT s.id AS source_id, s.name AS source_name, s.attribution, s.license, s.license_url, s.homepage,
		        s.covers_country, x.region_code, g.name AS region_name, x.month, x.reports,
		        to_char(l.window_start, 'YYYY-MM-DD') AS window_start, to_char(l.window_end, 'YYYY-MM-DD') AS window_end
		   FROM external_place_month_species x
		   JOIN external_sources s ON s.id = x.source_id AND s.active
		   JOIN regions g ON g.code = x.region_code
		   JOIN external_places p ON p.source_id = x.source_id AND p.place_key = x.region_code
		   JOIN external_loads l ON l.id = p.load_id
		  WHERE x.species_code = $1 AND x.place_key = x.region_code AND x.reports > 0
		    AND ($2::text IS NULL OR s.covers_country = $2)
		  ORDER BY s.name, s.id`,
		[speciesCode, country ?? null]
	);
	const bySource = new Map<string, ExternalSpeciesSummary>();
	const byRegion = new Map<string, ExternalSpeciesRegion>();
	for (const row of r.rows) {
		let s = bySource.get(row.source_id);
		if (!s) {
			s = {
				source: {
					id: row.source_id,
					name: row.source_name,
					attribution: row.attribution,
					license: row.license,
					licenseUrl: row.license_url,
					homepage: row.homepage
				},
				country: row.covers_country,
				regions: []
			};
			bySource.set(row.source_id, s);
		}
		const key = `${row.source_id}\u0000${row.region_code}`;
		let g = byRegion.get(key);
		if (!g) {
			g = {
				regionCode: row.region_code,
				regionName: row.region_name,
				reports: 0,
				months: new Array<number>(12).fill(0),
				windowStart: row.window_start,
				windowEnd: row.window_end
			};
			byRegion.set(key, g);
			s.regions.push(g);
		}
		g.months[row.month - 1] = Number(row.reports);
		g.reports += Number(row.reports);
	}
	for (const s of bySource.values()) {
		s.regions.sort((a, b) => b.reports - a.reports || a.regionName.localeCompare(b.regionName));
	}
	return [...bySource.values()];
}

export interface ExternalLoadState {
	sourceId: string;
	regionCode: string;
	/** A load is queued or running for it now. */
	active: boolean;
	/** The load whose data is published there now, if any. */
	publishedLoadId: string | null;
}

/**
 * Whether loads for these (source, region) pairs are still in progress, and
 * which load each one shows (CODEX1 F3): the cards watch loads other users
 * started, which the signed-in user's own job poll never sees end.
 */
export async function externalLoadStates(pairs: { sourceId: string; regionCode: string }[]): Promise<ExternalLoadState[]> {
	if (pairs.length === 0) return [];
	const r = await query<{ source_id: string; region_code: string; active: boolean; published: string | null }>(
		`SELECT k.source_id, k.region_code,
		        EXISTS (SELECT 1 FROM external_loads l
		                 WHERE l.source_id = k.source_id AND l.region_code = k.region_code
		                   AND l.status IN ('queued', 'leased', 'staging')) AS active,
		        (SELECT p.load_id::text FROM external_places p
		          WHERE p.source_id = k.source_id AND p.place_key = k.region_code) AS published
		   FROM unnest($1::text[], $2::text[]) AS k(source_id, region_code)`,
		[pairs.map((p) => p.sourceId), pairs.map((p) => p.regionCode)]
	);
	return r.rows.map((x) => ({
		sourceId: x.source_id,
		regionCode: x.region_code,
		active: x.active,
		publishedLoadId: x.published
	}));
}
