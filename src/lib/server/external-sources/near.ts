/**
 * "What can I see?" → "Reported on <source> near <place>" (td-46fff6 rev B):
 * the stored reports (td-769300) within the chosen radius of a point, in the
 * chosen month, inside each county's loaded window. Counts of reports, never
 * likelihoods; nothing here touches the eBird frequency tables.
 * Plan: docs/2026-10-28-forecast-external-card-plan-CC.md → "Rev B".
 */
import type { PoolClient } from 'pg';
import { withReadSnapshot } from '$lib/db';
import { PIN_MAX_UNCERTAINTY_M, type ExternalSourceInfo } from './reports';

type Db = Pick<PoolClient, 'query'>;

/** Places named per species. */
export const NEAR_SPECIES_PLACES = 3;
/** The busiest places for all birds. */
export const NEAR_PLACES = 5;
/** With nothing in the radius, the nearest report is looked for this far (× radius, at least the floor). */
export const NEAREST_FACTOR = 3;
export const NEAREST_FLOOR_KM = 30;

const EARTH_KM = 6371;

export interface NearCounty {
	code: string;
	name: string;
	/** YYYY-MM-DD, inclusive. */
	windowStart: string;
	windowEnd: string;
}

export interface NearPlaceRef {
	/** Stable within the card: the place's county or municipality key and its locality. */
	key: string;
	locality: string;
	municipality: string | null;
	reports: number;
	/** The closest of its reports, km from the point. */
	km: number;
}

export interface NearSpecies {
	code: string;
	name: string;
	sciName: string | null;
	seen: boolean;
	reports: number;
	/** Years of the month (within the window) with a report of it nearby. */
	years: number;
	/** The county with most of its nearby reports, for "Where in …". */
	regionCode: string;
	regionName: string;
	where: NearPlaceRef[];
}

export interface NearPlace extends NearPlaceRef {
	regionCode: string;
	/** Only when its best-placed report passes the pin rule. */
	lat: number | null;
	lon: number | null;
}

export interface NearMunicipality {
	regionCode: string;
	name: string;
	reports: number;
}

export interface ExternalNearCard {
	source: ExternalSourceInfo;
	month: number;
	radiusKm: number;
	/** The counties the reports come from, by name. */
	counties: NearCounty[];
	/** All bird reports within the radius that month (species or not). */
	reports: number;
	/** Years of the month inside the counties' windows. */
	monthYears: number;
	/** Every species reported, most reports first. */
	species: NearSpecies[];
	places: NearPlace[];
	municipalities: NearMunicipality[];
	/** Only when nothing is within the radius: the closest report that month. */
	nearest: (NearPlaceRef & { regionCode: string }) | null;
}

/**
 * A latitude/longitude box that contains the whole circle of `km` around the
 * point (CODEX1 td-46fff6 F2: the exact spherical extent, not dLat/cos(lat),
 * which falls short of the circle's widest longitude). A circle that reaches
 * a pole or crosses ±180° gets every longitude; the haversine cut that
 * follows trims the extra.
 */
export function boxAround(lat: number, lon: number, km: number) {
	const a = km / EARTH_KM;
	const dLat = (a * 180) / Math.PI;
	const phi = (lat * Math.PI) / 180;
	const full = { minLon: -180, maxLon: 180 };
	let lons = full;
	if (Math.abs(phi) + a < Math.PI / 2) {
		const dLon = (Math.asin(Math.min(Math.sin(a) / Math.cos(phi), 1)) * 180) / Math.PI;
		if (lon - dLon >= -180 && lon + dLon <= 180) lons = { minLon: lon - dLon, maxLon: lon + dLon };
	}
	return { minLat: Math.max(lat - dLat, -90), maxLat: Math.min(lat + dLat, 90), ...lons };
}

/** Years y with month (y, m) wholly inside some window (windows are month-aligned). */
export function monthYearsIn(windows: { windowStart: string; windowEnd: string }[], month: number): number {
	const years = new Set<number>();
	for (const w of windows) {
		const y0 = Number(w.windowStart.slice(0, 4));
		const y1 = Number(w.windowEnd.slice(0, 4));
		for (let y = y0; y <= y1; y++) {
			const first = `${y}-${String(month).padStart(2, '0')}-01`;
			const last = new Date(Date.UTC(y, month, 0)).toISOString().slice(0, 10);
			if (first >= w.windowStart && last <= w.windowEnd) years.add(y);
		}
	}
	return years.size;
}

/**
 * One card per active source with reports within reach of the point, by
 * source name. Empty when no source has any (every place outside the
 * sources' countries). `userId` decides "seen" (the viewer's scope).
 */
export function externalNear(opts: {
	lat: number;
	lon: number;
	radiusKm: number;
	month: number;
	userId: number;
}): Promise<ExternalNearCard[]> {
	return withReadSnapshot((db) => _readNear(db, opts));
}

// Records near the point, in the month and inside their county's published
// window, from active sources. $1 lat, $2 lon, $3..$6 the box, $7 month.
// The box goes first so the GiST index on point(lon, lat) does the cut.
const NEAR_RECORDS = `
	WITH b AS MATERIALIZED (
	  SELECT e.source_id, e.region_code, e.place_key, e.locality, e.upstream_taxon_id, e.canonical_name,
	         e.observed_on, e.lat, e.lon, e.uncertainty_m, e.load_id
	    FROM external_records e
	   WHERE point(e.lon, e.lat) <@ box(point($4, $3), point($6, $5))
	     AND e.lat IS NOT NULL
	     AND EXTRACT(MONTH FROM e.observed_on) = $7),
	r AS (
	  SELECT b.*,
	         2 * ${EARTH_KM} * asin(sqrt(power(sin(radians(b.lat - $1) / 2), 2)
	           + cos(radians($1)) * cos(radians(b.lat)) * power(sin(radians(b.lon - $2) / 2), 2))) AS km
	    FROM b
	    JOIN external_sources s ON s.id = b.source_id AND s.active
	    JOIN external_loads l ON l.id = b.load_id
	   WHERE b.observed_on BETWEEN l.window_start AND l.window_end)`;

/** Exported for the snapshot test only. */
export async function _readNear(
	db: Db,
	opts: { lat: number; lon: number; radiusKm: number; month: number; userId: number }
): Promise<ExternalNearCard[]> {
	const { lat, lon, radiusKm, month, userId } = opts;
	const box = boxAround(lat, lon, radiusKm);
	const groups = await db.query<{
		source_id: string;
		region_code: string;
		place_key: string;
		municipality: string | null;
		locality: string | null;
		species_code: string | null;
		seen: boolean;
		yr: number;
		n: string;
		km: number;
		best_lat: number;
		best_lon: number;
		best_unc: number | null;
	}>(
		`${NEAR_RECORDS}
		 SELECT r.source_id, r.region_code, r.place_key, p.name AS municipality, r.locality, t.species_code,
		        (t.species_code IS NOT NULL AND EXISTS (
		          SELECT 1 FROM seen_species s WHERE s.user_id = $9 AND s.species_code = t.species_code)) AS seen,
		        EXTRACT(YEAR FROM r.observed_on)::int AS yr, COUNT(*) AS n, MIN(r.km) AS km,
		        (array_agg(r.lat ORDER BY r.uncertainty_m NULLS LAST, r.observed_on DESC))[1] AS best_lat,
		        (array_agg(r.lon ORDER BY r.uncertainty_m NULLS LAST, r.observed_on DESC))[1] AS best_lon,
		        (array_agg(r.uncertainty_m ORDER BY r.uncertainty_m NULLS LAST, r.observed_on DESC))[1] AS best_unc
		   FROM r
		   JOIN external_taxa t
		     ON t.source_id = r.source_id AND t.upstream_taxon_id = r.upstream_taxon_id AND t.canonical_name = r.canonical_name
		   LEFT JOIN external_places p ON p.source_id = r.source_id AND p.place_key = r.place_key AND p.level = 'subregion'
		  WHERE r.km <= $8
		  GROUP BY r.source_id, r.region_code, r.place_key, p.name, r.locality, t.species_code, yr`,
		[lat, lon, box.minLat, box.minLon, box.maxLat, box.maxLon, month, radiusKm, userId]
	);

	// The nearest report for each active source with nothing in the radius
	// (CODEX1 F3: one source's reports must not hide another's nearest).
	const found = [...new Set(groups.rows.map((g) => g.source_id))];
	const missing = await db.query<{ id: string }>(
		`SELECT id FROM external_sources WHERE active AND NOT (id = ANY($1::text[]))`,
		[found]
	);
	let nearestBy = new Map<string, NearPlaceRef & { regionCode: string }>();
	if (missing.rows.length > 0) {
		const far = Math.max(radiusKm * NEAREST_FACTOR, NEAREST_FLOOR_KM);
		const fb = boxAround(lat, lon, far);
		const nearest = await db.query<{
			source_id: string;
			region_code: string;
			place_key: string;
			municipality: string | null;
			locality: string | null;
			km: number;
		}>(
			`${NEAR_RECORDS}
			 SELECT DISTINCT ON (r.source_id) r.source_id, r.region_code, r.place_key, p.name AS municipality, r.locality, r.km
			   FROM r
			   LEFT JOIN external_places p ON p.source_id = r.source_id AND p.place_key = r.place_key AND p.level = 'subregion'
			  WHERE r.km <= $8 AND r.source_id = ANY($9::text[])
			  ORDER BY r.source_id, r.km, r.locality`,
			[lat, lon, fb.minLat, fb.minLon, fb.maxLat, fb.maxLon, month, far, missing.rows.map((m) => m.id)]
		);
		nearestBy = new Map(
			nearest.rows.map((n) => [
				n.source_id,
				{
					key: `${n.place_key}\u0000${n.locality ?? ''}`,
					locality: n.locality ?? n.municipality ?? n.region_code,
					municipality: n.municipality,
					reports: 0,
					km: Number(n.km),
					regionCode: n.region_code
				}
			])
		);
	}

	const sourceIds = [...new Set([...groups.rows.map((g) => g.source_id), ...nearestBy.keys()])];
	if (sourceIds.length === 0) return [];

	const sources = await db.query<{
		id: string;
		name: string;
		publisher: string;
		license: string;
		license_url: string;
		citation: string;
		doi: string | null;
		attribution: string;
		homepage: string;
		store_observers: boolean;
		country_name: string;
	}>(
		`SELECT s.id, s.name, s.publisher, s.license, s.license_url, s.citation, s.doi, s.attribution, s.homepage,
		        s.store_observers, c.name AS country_name
		   FROM external_sources s JOIN regions c ON c.code = s.covers_country
		  WHERE s.id = ANY($1) ORDER BY s.name, s.id`,
		[sourceIds]
	);
	const regionCodes = [
		...new Set([...groups.rows.map((g) => g.region_code), ...[...nearestBy.values()].map((n) => n.regionCode)])
	];
	const counties = await db.query<{
		source_id: string;
		code: string;
		name: string;
		window_start: string;
		window_end: string;
	}>(
		`SELECT p.source_id, p.region_code AS code, g.name,
		        to_char(l.window_start, 'YYYY-MM-DD') AS window_start, to_char(l.window_end, 'YYYY-MM-DD') AS window_end
		   FROM external_places p
		   JOIN external_loads l ON l.id = p.load_id
		   JOIN regions g ON g.code = p.region_code
		  WHERE p.source_id = ANY($1) AND p.place_key = p.region_code AND p.region_code = ANY($2)
		  ORDER BY g.name`,
		[sourceIds, regionCodes]
	);
	const codes = [...new Set(groups.rows.map((g) => g.species_code).filter((c): c is string => c !== null))];
	const names = await db.query<{ species_code: string; com_name: string; sci_name: string | null }>(
		`SELECT species_code, com_name, sci_name FROM taxonomy_cache WHERE species_code = ANY($1)`,
		[codes]
	);
	const nameOf = new Map(names.rows.map((n) => [n.species_code, n]));

	return sources.rows.map((s) => {
		const mine = groups.rows.filter((g) => g.source_id === s.id);
		const sourceCounties: NearCounty[] = counties.rows
			.filter((c) => c.source_id === s.id)
			.map((c) => ({ code: c.code, name: c.name, windowStart: c.window_start, windowEnd: c.window_end }));
		const countyName = new Map(sourceCounties.map((c) => [c.code, c.name]));
		const placeKey = (g: (typeof mine)[number]) => `${g.place_key}\u0000${g.locality ?? ''}`;
		const label = (g: (typeof mine)[number]) => g.locality ?? g.municipality ?? countyName.get(g.region_code) ?? g.region_code;

		// Places, all birds: reports, the closest report and the best-placed one.
		const placeAcc = new Map<string, NearPlace & { bestUnc: number | null; bestLat: number; bestLon: number }>();
		const muniAcc = new Map<string, NearMunicipality>();
		let reports = 0;
		for (const g of mine) {
			const n = Number(g.n);
			reports += n;
			const k = placeKey(g);
			const p = placeAcc.get(k);
			const unc = g.best_unc;
			if (!p) {
				placeAcc.set(k, {
					key: k,
					locality: label(g),
					municipality: g.municipality,
					regionCode: g.region_code,
					reports: n,
					km: Number(g.km),
					lat: null,
					lon: null,
					bestUnc: unc,
					bestLat: g.best_lat,
					bestLon: g.best_lon
				});
			} else {
				p.reports += n;
				p.km = Math.min(p.km, Number(g.km));
				if (unc !== null && (p.bestUnc === null || unc < p.bestUnc)) {
					p.bestUnc = unc;
					p.bestLat = g.best_lat;
					p.bestLon = g.best_lon;
				}
			}
			if (g.municipality) {
				const mk = `${g.region_code}\u0000${g.municipality}`;
				const m = muniAcc.get(mk) ?? { regionCode: g.region_code, name: g.municipality, reports: 0 };
				m.reports += n;
				muniAcc.set(mk, m);
			}
		}
		const byReports = <T extends { reports: number; km: number; locality: string }>(a: T, b: T) =>
			b.reports - a.reports || a.km - b.km || a.locality.localeCompare(b.locality, 'nb');
		const places: NearPlace[] = [...placeAcc.values()]
			.sort(byReports)
			.slice(0, NEAR_PLACES)
			.map(({ bestUnc, bestLat, bestLon, ...p }) => {
				const pin = bestUnc !== null && bestUnc <= PIN_MAX_UNCERTAINTY_M;
				return { ...p, lat: pin ? bestLat : null, lon: pin ? bestLon : null };
			});
		const municipalities = [...muniAcc.values()].sort(
			(a, b) => b.reports - a.reports || a.name.localeCompare(b.name, 'nb')
		);

		// Species: reports, the years with one, their top places and counties.
		const spAcc = new Map<
			string,
			{ seen: boolean; reports: number; years: Set<number>; at: Map<string, NearPlaceRef>; regions: Map<string, number> }
		>();
		for (const g of mine) {
			if (!g.species_code) continue;
			const n = Number(g.n);
			const e = spAcc.get(g.species_code) ?? {
				seen: g.seen,
				reports: 0,
				years: new Set<number>(),
				at: new Map<string, NearPlaceRef>(),
				regions: new Map<string, number>()
			};
			e.reports += n;
			e.years.add(g.yr);
			const k = placeKey(g);
			const at = e.at.get(k) ?? { key: k, locality: label(g), municipality: g.municipality, reports: 0, km: Number(g.km) };
			at.reports += n;
			at.km = Math.min(at.km, Number(g.km));
			e.at.set(k, at);
			e.regions.set(g.region_code, (e.regions.get(g.region_code) ?? 0) + n);
			spAcc.set(g.species_code, e);
		}
		const species: NearSpecies[] = [...spAcc.entries()]
			.map(([code, e]) => {
				const regionCode = [...e.regions.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
				const t = nameOf.get(code);
				return {
					code,
					name: t?.com_name ?? code,
					sciName: t?.sci_name ?? null,
					seen: e.seen,
					reports: e.reports,
					years: e.years.size,
					regionCode,
					regionName: countyName.get(regionCode) ?? regionCode,
					where: [...e.at.values()].sort(byReports).slice(0, NEAR_SPECIES_PLACES)
				};
			})
			.sort((a, b) => b.reports - a.reports || a.name.localeCompare(b.name));

		const shownCounties = sourceCounties.filter(
			(c) => mine.some((g) => g.region_code === c.code) || nearestBy.get(s.id)?.regionCode === c.code
		);
		return {
			source: {
				id: s.id,
				name: s.name,
				publisher: s.publisher,
				license: s.license,
				licenseUrl: s.license_url,
				citation: s.citation,
				doi: s.doi,
				attribution: s.attribution,
				homepage: s.homepage,
				countryName: s.country_name,
				regionLink: null,
				storeObservers: s.store_observers
			},
			month,
			radiusKm,
			counties: shownCounties,
			reports,
			monthYears: monthYearsIn(shownCounties, month),
			species,
			places,
			municipalities,
			nearest: mine.length === 0 ? (nearestBy.get(s.id) ?? null) : null
		};
	});
}
