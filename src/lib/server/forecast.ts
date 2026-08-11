/**
 * Forecast engine — td-854207 "Bird forecast by location and month".
 *
 * Pure month/frequency math over the stored barchart data (barchart.ts),
 * modeled on query-engine.ts: pure ranking/statistics functions behind
 * explicit contracts, thin async readers, no fabricated numbers — every value
 * shown is observed frequency ("fraction of checklists reporting") with its
 * sample size, per cs.md's no-synthetic-data rule.
 *
 * Weeks are eBird's 48 pseudo-weeks: 4 per month, week 1 = Jan 1-7, week 4 =
 * Jan 22-end of Jan, etc. Monthly stats are checklist-weighted means of the
 * month's 4 weeks — Σ(freqᵢ·nᵢ)/Σnᵢ — NEVER an unweighted mean (CODEX1 #2).
 */
import { query } from '$lib/db';
import { frequencyMeta, lastCompleteYear, WEEKS, type FrequencyMeta } from '$server/barchart';
import { hotspotsNear, type EbirdHotspot } from '$server/ebird';
import { seenSet } from '$server/needs';
import { haversineKm } from '$lib/geo';

/**
 * Months whose 4-week checklist total is below this are excluded from
 * "best month" and rankings whenever better-sampled alternatives exist
 * (a 100% week with n=1 must not beat 30% with n=2,000).
 */
export const MIN_MONTH_N = 40;

export const MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
] as const;

/** Observed monthly stat: checklist-weighted frequency + total checklists. */
export interface MonthStat {
	/** 1-12 */
	month: number;
	/** Fraction of checklists reporting the species (0-1). */
	freq: number;
	/** Total checklists across the month's 4 pseudo-weeks. */
	n: number;
}

export interface BestMonth {
	month: number;
	freq: number;
	n: number;
	/** True when no adequately-sampled month existed and low-n months were used. */
	lowSample: boolean;
}

/** 1-based inclusive week range for a month: Jan → 1..4, Dec → 45..48. */
export function monthWeeks(month: number): { from: number; to: number } {
	if (!Number.isInteger(month) || month < 1 || month > 12) {
		throw new Error(`Month out of range: ${month}`);
	}
	return { from: (month - 1) * 4 + 1, to: month * 4 };
}

/**
 * Checklist-weighted monthly frequency. freqByWeek is sparse (absent week =
 * frequency 0 — but its checklists still count in the denominator).
 * Zero-checklist weeks drop out of the weighting naturally.
 */
export function monthlyStat(
	freqByWeek: ReadonlyMap<number, number>,
	sampleSizes: readonly number[],
	month: number
): MonthStat {
	const { from, to } = monthWeeks(month);
	let num = 0;
	let n = 0;
	for (let w = from; w <= to; w++) {
		const weekN = sampleSizes[w - 1] ?? 0;
		num += (freqByWeek.get(w) ?? 0) * weekN;
		n += weekN;
	}
	return { month, freq: n > 0 ? num / n : 0, n };
}

/** All 12 monthly stats for one species at one location. */
export function monthCurve(
	freqByWeek: ReadonlyMap<number, number>,
	sampleSizes: readonly number[]
): MonthStat[] {
	const curve: MonthStat[] = [];
	for (let m = 1; m <= 12; m++) curve.push(monthlyStat(freqByWeek, sampleSizes, m));
	return curve;
}

/**
 * Best month = argmax frequency over adequately-sampled months (n >= MIN_MONTH_N).
 * Falls back to low-n months (flagged lowSample) only when no month qualifies.
 * Returns null when the species was never reported (all freqs 0).
 */
export function bestMonth(curve: readonly MonthStat[]): BestMonth | null {
	const pick = (candidates: readonly MonthStat[]): MonthStat | null => {
		let best: MonthStat | null = null;
		for (const s of candidates) {
			if (s.freq > 0 && (best == null || s.freq > best.freq)) best = s;
		}
		return best;
	};
	const sampled = pick(curve.filter((s) => s.n >= MIN_MONTH_N));
	if (sampled) return { ...sampled, lowSample: false };
	const any = pick(curve.filter((s) => s.n > 0));
	return any ? { ...any, lowSample: true } : null;
}

// ---------------------------------------------------------------------------
// Readers (cached data only — these never fetch from eBird)
// ---------------------------------------------------------------------------

export interface SpeciesLocForecast {
	meta: FrequencyMeta;
	curve: MonthStat[];
	best: BestMonth | null;
	/** True when the species has a stored fetch but zero reported weeks. */
	neverReported: boolean;
}

// ---------------------------------------------------------------------------
// Mode A: place + month → ranked needed species (td-854207 Phase 2)
// ---------------------------------------------------------------------------

/** How many nearby hotspots Mode A analyzes per query. */
export const FORECAST_HOTSPOT_LIMIT = 8;

/**
 * Deterministic hotspot selection: half nearest to the origin, half most
 * active (numSpeciesAllTime), deduped, remainder filled by nearest. The mix
 * counters famous-hotspot selection bias without ignoring high-signal sites
 * (CODEX1 #9). Pure. Returned nearest-first for stable display.
 */
export function selectForecastHotspots(
	hotspots: readonly EbirdHotspot[],
	origin: { lat: number; lng: number },
	limit = FORECAST_HOTSPOT_LIMIT
): EbirdHotspot[] {
	const byDistance = [...hotspots].sort(
		(a, b) =>
			haversineKm(origin.lat, origin.lng, a.lat, a.lng) -
			haversineKm(origin.lat, origin.lng, b.lat, b.lng)
	);
	const byActivity = [...hotspots].sort(
		(a, b) => (b.numSpeciesAllTime ?? 0) - (a.numSpeciesAllTime ?? 0)
	);
	const chosen = new Map<string, EbirdHotspot>();
	const half = Math.ceil(limit / 2);
	for (const h of byDistance.slice(0, half)) chosen.set(h.locId, h);
	for (const h of byActivity) {
		if (chosen.size >= limit) break;
		chosen.set(h.locId, h);
	}
	for (const h of byDistance) {
		if (chosen.size >= limit) break;
		chosen.set(h.locId, h);
	}
	return byDistance.filter((h) => chosen.has(h.locId));
}

export interface ForecastHotspotStat {
	locId: string;
	locName: string;
	/** Fraction of this hotspot's month checklists reporting the species. */
	freq: number;
	/** This hotspot's month checklist count. */
	n: number;
	lowSample: boolean;
}

export interface ForecastSpecies {
	code: string;
	comName: string;
	sciName: string;
	/** Checklist-weighted frequency across ALL analyzed hotspots with data. */
	areaFreq: number;
	/** Total month checklists across analyzed hotspots with data. */
	areaN: number;
	lowSample: boolean;
	/** Best individual hotspots for this species (freq desc, top 3). */
	topHotspots: ForecastHotspotStat[];
}

export interface AnalyzedHotspot {
	locId: string;
	locName: string;
	lat: number;
	lng: number;
	distanceKm: number;
	hasData: boolean;
	/** Stored data covers the newest complete year (false = annual refresh due). */
	current: boolean;
	fetchedAt: string | null; // ISO
}

export interface ForecastNeedsView {
	month: number;
	/** Ranked: adequately-sampled first (by areaFreq), then low-sample. */
	species: ForecastSpecies[];
	analyzed: AnalyzedHotspot[];
	/** Total hotspots eBird lists within range (analyzed is a subset). */
	totalNearby: number;
	/** From the official hotspot-list cache, not the barchart data. */
	hotspotListStale: boolean;
	oldestFetchedAt: string | null; // ISO, across analyzed-with-data
	/** Hotspots with stored data from an outdated annual window. */
	outdatedCount: number;
	/** Actual year span of the stored data used (never a hardcoded label). */
	dataYears: { begin: number; end: number } | null;
}

interface SpeciesLocAgg {
	code: string;
	comName: string;
	sciName: string;
	locId: string;
	/** Σ(freq·n) over the month's weeks at this hotspot. */
	num: number;
}

/**
 * Pure ranking core: combine per-species-per-hotspot numerators with
 * per-hotspot month denominators into area-weighted ranked needs.
 * Exported for tests.
 */
export function buildForecastSpecies(
	aggRows: readonly SpeciesLocAgg[],
	denomByLoc: ReadonlyMap<string, number>,
	locNames: ReadonlyMap<string, string>,
	seen: ReadonlySet<string>
): ForecastSpecies[] {
	const areaN = [...denomByLoc.values()].reduce((a, b) => a + b, 0);
	const byCode = new Map<
		string,
		{ comName: string; sciName: string; num: number; hotspots: ForecastHotspotStat[] }
	>();
	for (const row of aggRows) {
		if (seen.has(row.code)) continue;
		const denom = denomByLoc.get(row.locId) ?? 0;
		let entry = byCode.get(row.code);
		if (!entry) {
			entry = { comName: row.comName, sciName: row.sciName, num: 0, hotspots: [] };
			byCode.set(row.code, entry);
		}
		entry.num += row.num;
		if (denom > 0) {
			entry.hotspots.push({
				locId: row.locId,
				locName: locNames.get(row.locId) ?? row.locId,
				freq: row.num / denom,
				n: denom,
				lowSample: denom < MIN_MONTH_N
			});
		}
	}

	const species: ForecastSpecies[] = [];
	for (const [code, e] of byCode) {
		const areaFreq = areaN > 0 ? e.num / areaN : 0;
		if (areaFreq <= 0) continue;
		e.hotspots.sort((a, b) => b.freq - a.freq);
		species.push({
			code,
			comName: e.comName,
			sciName: e.sciName,
			areaFreq,
			areaN,
			lowSample: areaN < MIN_MONTH_N,
			topHotspots: e.hotspots.slice(0, 3)
		});
	}
	// Adequately-sampled block first, each block by frequency descending.
	species.sort((a, b) => {
		if (a.lowSample !== b.lowSample) return a.lowSample ? 1 : -1;
		if (b.areaFreq !== a.areaFreq) return b.areaFreq - a.areaFreq;
		return a.comName.localeCompare(b.comName);
	});
	return species;
}

/**
 * Mode A entry point: needed species likely near (lat,lng) in `month`, from
 * stored barchart data for a deterministic mix of nearby hotspots. Reads ONLY
 * stored frequency data — the official hotspot list may lazily refresh via
 * its own cachedFetch, but ebird.org/barchartData is never touched here.
 */
export async function forecastNeedsNear(
	userId: number,
	apiKey: string,
	lat: number,
	lng: number,
	distKm: number,
	month: number
): Promise<ForecastNeedsView> {
	const { from, to } = monthWeeks(month);
	const hotspots = await hotspotsNear(apiKey, lat, lng, distKm);
	const selected = selectForecastHotspots(hotspots.data, { lat, lng });
	const locIds = selected.map((h) => h.locId);

	const meta = await frequencyMeta(locIds);
	const withData = locIds.filter((id) => meta.has(id));

	let species: ForecastSpecies[] = [];
	if (withData.length > 0) {
		const [aggRes, denomRes, seen] = await Promise.all([
			query<{ species_code: string; com_name: string; sci_name: string; loc_code: string; num: number }>(
				`SELECT sf.species_code, tc.com_name, tc.sci_name, sf.loc_code,
				        SUM(sf.freq * ss.n)::float8 AS num
				   FROM species_frequency sf
				   JOIN frequency_fetch ff ON ff.loc_code = sf.loc_code
				   JOIN LATERAL unnest(ff.sample_sizes) WITH ORDINALITY AS ss(n, week)
				     ON ss.week = sf.week
				   JOIN taxonomy_cache tc ON tc.species_code = sf.species_code
				  WHERE sf.loc_code = ANY($1) AND sf.week BETWEEN $2 AND $3
				  GROUP BY sf.species_code, tc.com_name, tc.sci_name, sf.loc_code`,
				[withData, from, to]
			),
			query<{ loc_code: string; n: number }>(
				`SELECT ff.loc_code, SUM(ss.n)::float8 AS n
				   FROM frequency_fetch ff,
				        LATERAL unnest(ff.sample_sizes) WITH ORDINALITY AS ss(n, week)
				  WHERE ff.loc_code = ANY($1) AND ss.week BETWEEN $2 AND $3
				  GROUP BY ff.loc_code`,
				[withData, from, to]
			),
			seenSet(userId)
		]);
		const denomByLoc = new Map(denomRes.rows.map((r) => [r.loc_code, Number(r.n)]));
		const locNames = new Map(selected.map((h) => [h.locId, h.locName]));
		species = buildForecastSpecies(
			aggRes.rows.map((r) => ({
				code: r.species_code,
				comName: r.com_name,
				sciName: r.sci_name,
				locId: r.loc_code,
				num: Number(r.num)
			})),
			denomByLoc,
			locNames,
			seen
		);
	}

	const newestCompleteYear = lastCompleteYear();
	const analyzed: AnalyzedHotspot[] = selected.map((h) => {
		const m = meta.get(h.locId);
		return {
			locId: h.locId,
			locName: h.locName,
			lat: h.lat,
			lng: h.lng,
			distanceKm: haversineKm(lat, lng, h.lat, h.lng),
			hasData: m != null,
			current: m != null && m.endYear >= newestCompleteYear,
			fetchedAt: m?.fetchedAt.toISOString() ?? null
		};
	});
	const fetchDates = analyzed.filter((a) => a.fetchedAt).map((a) => a.fetchedAt!);
	const usedMetas = withData.map((id) => meta.get(id)!);

	return {
		month,
		species,
		analyzed,
		totalNearby: hotspots.data.length,
		hotspotListStale: hotspots.stale,
		oldestFetchedAt: fetchDates.length ? fetchDates.sort()[0] : null,
		outdatedCount: analyzed.filter((a) => a.hasData && !a.current).length,
		dataYears: usedMetas.length
			? {
					begin: Math.min(...usedMetas.map((m) => m.beginYear)),
					end: Math.max(...usedMetas.map((m) => m.endYear))
				}
			: null
	};
}

/**
 * Month curve for one species at one stored location (region or hotspot).
 * Returns null when no barchart data has been fetched for the location at all
 * — callers distinguish "no data loaded" from "loaded, species not reported".
 */
export async function speciesLocForecast(
	locCode: string,
	speciesCode: string
): Promise<SpeciesLocForecast | null> {
	const meta = (await frequencyMeta([locCode])).get(locCode);
	if (!meta) return null;

	const r = await query<{ week: number; freq: number }>(
		'SELECT week, freq FROM species_frequency WHERE loc_code = $1 AND species_code = $2',
		[locCode, speciesCode]
	);
	const freqByWeek = new Map<number, number>();
	for (const row of r.rows) {
		const week = Number(row.week);
		if (week >= 1 && week <= WEEKS) freqByWeek.set(week, Number(row.freq));
	}
	const curve = monthCurve(freqByWeek, meta.sampleSizes);
	return {
		meta,
		curve,
		best: bestMonth(curve),
		neverReported: freqByWeek.size === 0
	};
}
