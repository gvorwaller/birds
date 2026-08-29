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
import { fetchRegionCentroid, EbirdError } from '$server/ebird';
import { frequencyMeta, lastCompleteYear, WEEKS, type FrequencyMeta } from '$server/barchart';
import { hotspotsNear, subregions, type EbirdHotspot } from '$server/ebird';
import { seenSet } from '$server/needs';
import { haversineKm } from '$lib/geo';
import { countryOf, isCountry, isSubnational1, parentOf } from '$lib/region-code';

/**
 * Months whose 4-week checklist total is below this are excluded from
 * "best month" and rankings whenever better-sampled alternatives exist
 * (a 100% week with n=1 must not beat 30% with n=2,000).
 */
export const MIN_MONTH_N = 40;

export { calendarMonth, FORECAST_CALENDAR_TZ } from '$lib/forecast-calendar';

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
 * Reliability bands for a single observed frequency. These are display
 * groupings, not a fabricated probability: "likely" means the species showed
 * up on at least 1 in 5 historical checklists.
 */
export const FREQ_LIKELY = 0.2;
export const FREQ_POSSIBLE = 0.05;

export type Reliability = 'likely' | 'possible' | 'longshot';

export function reliabilityOf(freq: number): Reliability {
	if (freq >= FREQ_LIKELY) return 'likely';
	if (freq >= FREQ_POSSIBLE) return 'possible';
	return 'longshot';
}

/**
 * How concentrated a species is across the analyzed hotspots.
 * - local: one site is ≥2.5× the next, or only one site reports it
 * - widespread: ≥3 sites within 50% of the top site's frequency
 * - mixed: everything else (don't call it out in the UI)
 */
export type Concentration = 'local' | 'widespread' | 'mixed';

export function concentrationOf(hotspots: readonly { freq: number }[]): Concentration {
	const positive = hotspots.filter((h) => h.freq > 0).sort((a, b) => b.freq - a.freq);
	if (positive.length <= 1) return 'local';
	const top = positive[0].freq;
	const close = positive.filter((h) => h.freq >= top * 0.5).length;
	if (close >= 3) return 'widespread';
	if (top >= positive[1].freq * 2.5) return 'local';
	return 'mixed';
}

/** eBird personal/broad locations that shouldn't win a "best hotspot" slot. */
export function vagueLocName(name: string): boolean {
	return /please use more specific/i.test(name);
}

/** Months within `ratio` of the adequately-sampled peak (inclusive). */
export function goodMonths(curve: readonly MonthStat[], ratio = 0.8): number[] {
	const peak = bestMonth(curve);
	if (!peak || peak.freq <= 0) return [];
	const floor = peak.freq * ratio;
	return curve
		.filter((s) => s.freq >= floor && (peak.lowSample || s.n >= MIN_MONTH_N))
		.map((s) => s.month);
}

const WEEK_SLOT = ['early', 'mid', 'mid-to-late', 'late'] as const;

/**
 * A single week must reach this many checklists before it can decide
 * "peaks late January". Below that we suppress week-level precision
 * rather than let n=1 beat a well-sampled neighboring week.
 */
export const MIN_WEEK_N = 10;

/**
 * "late January" from a 1–48 eBird week. Returns null when no week is
 * both positive-frequency and adequately sampled.
 */
export function peakWeekPhrase(
	freqByWeek: ReadonlyMap<number, number>,
	sampleSizes: readonly number[]
): string | null {
	let bestWeek = 0;
	let bestFreq = 0;
	for (const [week, freq] of freqByWeek) {
		if (week < 1 || week > WEEKS || freq <= 0) continue;
		const n = sampleSizes[week - 1] ?? 0;
		if (n < MIN_WEEK_N) continue;
		if (freq > bestFreq) {
			bestFreq = freq;
			bestWeek = week;
		}
	}
	if (bestWeek === 0) return null;
	const month = Math.ceil(bestWeek / 4);
	const slot = WEEK_SLOT[(bestWeek - 1) % 4];
	return `${slot} ${MONTH_NAMES[month - 1]}`;
}

// ---------------------------------------------------------------------------
// Weekly resolution (td-af8393) — GROK-pinned truthfulness: a week with
// n === 0 is NO DATA (never a 0% bar); n < MIN_WEEK_N is inadequate — hatched
// in charts and NEITHER presence nor absence for migration inference.
// ---------------------------------------------------------------------------

export interface WeekStat {
	week: number; // 1-48
	freq: number;
	n: number;
}

/** All 48 weekly stats — the single-week analog of monthCurve. */
export function weekCurve(
	freqByWeek: ReadonlyMap<number, number>,
	sampleSizes: readonly number[]
): WeekStat[] {
	const out: WeekStat[] = [];
	for (let w = 1; w <= WEEKS; w++) {
		out.push({
			week: w,
			freq: freqByWeek.get(w) ?? 0,
			n: sampleSizes[w - 1] ?? 0
		});
	}
	return out;
}

/** "early April" from a 1-48 week (the peakWeekPhrase slot vocabulary). */
export function weekPhrase(week: number): string {
	const month = Math.ceil(week / 4);
	return `${WEEK_SLOT[(week - 1) % 4]} ${MONTH_NAMES[month - 1]}`;
}

/** How many consecutive winter-or-summer absent weeks make a "season". */
export const MIGRATION_ABSENCE_WEEKS = 8;
/** Presence needs at least this many consecutive adequate present weeks. */
export const MIGRATION_PRESENCE_WEEKS = 2;

/**
 * Arrival/departure for MIGRATORY shapes only (GROK pins): presence =
 * adequate week (n ≥ MIN_WEEK_N) with freq ≥ FREQ_POSSIBLE; absence =
 * adequate week below it; inadequate weeks break BOTH runs (unknown is
 * neither). Requires exactly ONE circular absence run of ≥8 weeks (a
 * double-gap passage shape can't be told in one sentence → null) and a
 * ≥2-week presence run on each side of it. Year-round, vagrant, and
 * unknown-effort shapes all return null — never a fabricated story.
 */
export function migrationWindow(
	curve: readonly WeekStat[]
): { arriveWeek: number; departWeek: number } | null {
	const N = curve.length;
	if (N === 0) return null;
	type Cls = 'present' | 'absent' | 'unknown';
	const cls: Cls[] = curve.map((w) =>
		w.n < MIN_WEEK_N ? 'unknown' : w.freq >= FREQ_POSSIBLE ? 'present' : 'absent'
	);

	// Circular runs of a class: scan LINEARLY (no modulo in the extension —
	// wrapping there double-counts the head run), then merge the boundary
	// pair when the year wraps within one run.
	const runs = (want: Cls): { start: number; len: number }[] => {
		const out: { start: number; len: number }[] = [];
		let i = 0;
		while (i < N) {
			if (cls[i] !== want) {
				i++;
				continue;
			}
			let j = i;
			while (j < N && cls[j] === want) j++;
			out.push({ start: i, len: j - i });
			i = j;
		}
		if (out.length >= 2) {
			const first = out[0];
			const last = out[out.length - 1];
			if (first.start === 0 && last.start + last.len === N) {
				last.len += first.len;
				out.shift();
			}
		}
		return out;
	};

	const absences = runs('absent').filter((r) => r.len >= MIGRATION_ABSENCE_WEEKS);
	if (absences.length !== 1) return null; // year-round, vagrant, or double-gap
	const gap = absences[0];

	// Arrival: first ≥2-week presence run scanning forward from the gap's end.
	const after = (gap.start + gap.len) % N;
	let arrive = -1;
	for (let step = 0; step < N - gap.len; step++) {
		const i = (after + step) % N;
		if (cls[i] === 'present' && cls[(i + 1) % N] === 'present') {
			arrive = i;
			break;
		}
	}
	// Departure: last week of a ≥2-week presence run scanning backward from
	// the gap's start.
	let depart = -1;
	for (let step = 1; step <= N - gap.len; step++) {
		const i = (gap.start - step + N) % N;
		if (cls[i] === 'present' && cls[(i - 1 + N) % N] === 'present') {
			depart = i;
			break;
		}
	}
	if (arrive < 0 || depart < 0) return null;
	return { arriveWeek: curve[arrive].week, departWeek: curve[depart].week };
}

/** "arrives ~early April · departs ~late October", or null. */
export function migrationSentence(curve: readonly WeekStat[]): string | null {
	const w = migrationWindow(curve);
	if (!w) return null;
	return `arrives ~${weekPhrase(w.arriveWeek)} · departs ~${weekPhrase(w.departWeek)}`;
}

export interface MonthRichness {
	month: number;
	likely: number;
	possible: number;
	longshot: number;
}

/** Count reliability bands per month from already-ranked species lists. */
export function richnessFromSpecies(
	byMonth: ReadonlyMap<number, readonly { areaFreq: number; lowSample: boolean }[]>
): MonthRichness[] {
	const out: MonthRichness[] = [];
	for (let m = 1; m <= 12; m++) {
		const usable = (byMonth.get(m) ?? []).filter((s) => !s.lowSample && s.areaFreq > 0);
		out.push({
			month: m,
			likely: usable.filter((s) => s.areaFreq >= FREQ_LIKELY).length,
			possible: usable.filter((s) => s.areaFreq >= FREQ_POSSIBLE && s.areaFreq < FREQ_LIKELY)
				.length,
			longshot: usable.filter((s) => s.areaFreq > 0 && s.areaFreq < FREQ_POSSIBLE).length
		});
	}
	return out;
}

/** Argmax of likely, then possible. Null when every month is empty. */
export function richestMonth(year: readonly MonthRichness[]): MonthRichness | null {
	let best: MonthRichness | null = null;
	for (const m of year) {
		if (m.likely + m.possible === 0) continue;
		if (
			!best ||
			m.likely > best.likely ||
			(m.likely === best.likely && m.possible > best.possible)
		) {
			best = m;
		}
	}
	return best;
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
	/** "late January" from the peak weekly bin, when one exists. */
	peakPhrase: string | null;
	/** Months within 80% of the adequately-sampled peak (the "good window"). */
	good: number[];
	/** True when the species has a stored fetch but zero reported weeks. */
	neverReported: boolean;
	weeks: WeekStat[];
	migration: string | null;
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
/**
 * Split a candidate pool into properly named hotspots and eBird's vague
 * catch-alls ("… (please use more specific location if possible)"). Selection
 * fills from specific sites first and dips into vague ones ONLY for the
 * shortfall — never all-or-nothing (CODEX1 2026-08-15 #5: with 7 specific of
 * a limit of 8, exactly one vague site may enter, not several).
 */
function splitByNameQuality(hotspots: readonly EbirdHotspot[]): {
	specific: EbirdHotspot[];
	vague: EbirdHotspot[];
} {
	const specific: EbirdHotspot[] = [];
	const vague: EbirdHotspot[] = [];
	for (const h of hotspots) (vagueLocName(h.locName) ? vague : specific).push(h);
	return { specific, vague };
}

function mixByDistanceActivity(
	pool: readonly EbirdHotspot[],
	origin: { lat: number; lng: number },
	limit: number
): EbirdHotspot[] {
	const byDistance = [...pool].sort(
		(a, b) =>
			haversineKm(origin.lat, origin.lng, a.lat, a.lng) -
			haversineKm(origin.lat, origin.lng, b.lat, b.lng)
	);
	const byActivity = [...pool].sort(
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

export function selectForecastHotspots(
	hotspots: readonly EbirdHotspot[],
	origin: { lat: number; lng: number },
	limit = FORECAST_HOTSPOT_LIMIT
): EbirdHotspot[] {
	const { specific, vague } = splitByNameQuality(hotspots);
	const picked = mixByDistanceActivity(specific, origin, limit);
	if (picked.length < limit) {
		picked.push(...mixByDistanceActivity(vague, origin, limit - picked.length));
	}
	return picked.sort(
		(a, b) =>
			haversineKm(origin.lat, origin.lng, a.lat, a.lng) -
			haversineKm(origin.lat, origin.lng, b.lat, b.lng)
	);
}

/**
 * Validate a user's multi-select of hotspot ids against the official
 * in-range list. Policy (td-8a6f97): ANY unknown id rejects the whole
 * request — stricter boundary, same rule as the single-loc path; a stale
 * selection (radius changed mid-session) legitimately re-picks after the
 * page re-renders. Pure.
 */
export function validateLocSelection(
	inRange: readonly EbirdHotspot[],
	requested: readonly string[]
): { ok: true; selected: EbirdHotspot[] } | { ok: false; missing: string[] } {
	const byId = new Map(inRange.map((h) => [h.locId, h]));
	const missing = requested.filter((id) => !byId.has(id));
	if (missing.length > 0) return { ok: false, missing };
	// Dedupe while preserving the caller's order.
	const seen = new Set<string>();
	const selected: EbirdHotspot[] = [];
	for (const id of requested) {
		if (!seen.has(id)) {
			seen.add(id);
			selected.push(byId.get(id)!);
		}
	}
	return { ok: true, selected };
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
	/** How site-specific this species is across the analyzed set. */
	concentration: Concentration;
	/**
	 * True only when "mostly at {topHotspots[0]}" is honest — the displayed
	 * top site is also the true frequency leader (not a vague name we hid).
	 */
	localClaim: boolean;
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

export interface UnloadedHotspot {
	locId: string;
	locName: string;
	lat: number;
	lng: number;
	distanceKm: number;
	numSpeciesAllTime: number | null;
}

export interface ForecastNeedsView {
	month: number;
	/** Ranked: adequately-sampled first (by areaFreq), then low-sample. */
	species: ForecastSpecies[];
	/** ALL loaded hotspots in range — the set the numbers are computed from. */
	analyzed: AnalyzedHotspot[];
	/** The auto-mix suggestion, minus already-loaded (bulk-load button). */
	suggested: AnalyzedHotspot[];
	/** ALL in-range hotspots without data, nearest first (individual Load). */
	unloadedNearby: UnloadedHotspot[];
	/** Total hotspots eBird lists within range (analyzed is a subset). */
	totalNearby: number;
	/** From the official hotspot-list cache, not the barchart data. */
	hotspotListStale: boolean;
	oldestFetchedAt: string | null; // ISO, across analyzed-with-data
	/** Hotspots with stored data from an outdated annual window. */
	outdatedCount: number;
	/** Actual year span of the stored data used (never a hardcoded label). */
	dataYears: { begin: number; end: number } | null;
	/** Needed-species richness for every month at the same analyzed set. */
	year: MonthRichness[];
	/** Majority state of the analyzed hotspots, when they agree. */
	regionCode: string | null;
	regionName: string | null;
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
		{
			comName: string;
			sciName: string;
			num: number;
			hotspots: ForecastHotspotStat[];
		}
	>();
	for (const row of aggRows) {
		if (seen.has(row.code)) continue;
		const denom = denomByLoc.get(row.locId) ?? 0;
		let entry = byCode.get(row.code);
		if (!entry) {
			entry = {
				comName: row.comName,
				sciName: row.sciName,
				num: 0,
				hotspots: []
			};
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
		const specific = e.hotspots.filter((h) => !vagueLocName(h.locName));
		const forDisplay = specific.length > 0 ? specific : e.hotspots;
		const concentration = concentrationOf(e.hotspots);
		const trueTop = e.hotspots[0];
		const shownTop = forDisplay[0];
		species.push({
			code,
			comName: e.comName,
			sciName: e.sciName,
			areaFreq,
			areaN,
			lowSample: areaN < MIN_MONTH_N,
			topHotspots: forDisplay.slice(0, 3),
			concentration,
			localClaim:
				concentration === 'local' && !!trueTop && !!shownTop && trueTop.locId === shownTop.locId
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
	month: number,
	seen?: ReadonlySet<string>
): Promise<ForecastNeedsView> {
	const hotspots = await hotspotsNear(apiKey, lat, lng, distKm);
	const inRange = hotspots.data;
	// EVERY loaded hotspot in range counts (GBV 2026-08-15): which hotspots the
	// auto-mix would suggest must never gate which loaded data gets used —
	// loading is the user's choice, and analysis honors all of it.
	const meta = await frequencyMeta(inRange.map((h) => h.locId));
	const loaded = inRange.filter((h) => meta.has(h.locId));
	const withData = loaded.map((h) => h.locId);
	// The deterministic mix is now only a SUGGESTION for the bulk-load button.
	const suggestedPick = selectForecastHotspots(inRange, { lat, lng }).filter(
		(h) => !meta.has(h.locId)
	);

	let species: ForecastSpecies[] = [];
	let year: MonthRichness[] = richnessFromSpecies(new Map());
	if (withData.length > 0) {
		const [aggRes, denomRes, seenResolved] = await Promise.all([
			query<{
				species_code: string;
				com_name: string;
				sci_name: string;
				loc_code: string;
				month: number;
				num: number;
			}>(
				`SELECT sf.species_code, tc.com_name, tc.sci_name, sf.loc_code,
				        ((sf.week - 1) / 4 + 1)::int AS month,
				        SUM(sf.freq * ss.n)::float8 AS num
				   FROM species_frequency sf
				   JOIN frequency_fetch ff ON ff.loc_code = sf.loc_code
				   JOIN LATERAL unnest(ff.sample_sizes) WITH ORDINALITY AS ss(n, week)
				     ON ss.week = sf.week
				   JOIN taxonomy_cache tc ON tc.species_code = sf.species_code
				  WHERE sf.loc_code = ANY($1)
				  GROUP BY sf.species_code, tc.com_name, tc.sci_name, sf.loc_code, month`,
				[withData]
			),
			query<{ loc_code: string; month: number; n: number }>(
				`SELECT ff.loc_code, ((ss.week - 1) / 4 + 1)::int AS month, SUM(ss.n)::float8 AS n
				   FROM frequency_fetch ff,
				        LATERAL unnest(ff.sample_sizes) WITH ORDINALITY AS ss(n, week)
				  WHERE ff.loc_code = ANY($1)
				  GROUP BY ff.loc_code, month`,
				[withData]
			),
			seen ?? seenSet(userId)
		]);
		const locNames = new Map(loaded.map((h) => [h.locId, h.locName]));
		const byMonth = new Map<number, ForecastSpecies[]>();
		for (let m = 1; m <= 12; m++) {
			const denomByLoc = new Map(
				denomRes.rows.filter((r) => Number(r.month) === m).map((r) => [r.loc_code, Number(r.n)])
			);
			byMonth.set(
				m,
				buildForecastSpecies(
					aggRes.rows
						.filter((r) => Number(r.month) === m)
						.map((r) => ({
							code: r.species_code,
							comName: r.com_name,
							sciName: r.sci_name,
							locId: r.loc_code,
							num: Number(r.num)
						})),
					denomByLoc,
					locNames,
					seenResolved
				)
			);
		}
		species = byMonth.get(month) ?? [];
		year = richnessFromSpecies(byMonth);
	}

	const newestCompleteYear = lastCompleteYear();
	const toAnalyzed = (h: EbirdHotspot): AnalyzedHotspot => {
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
	};
	const analyzed = loaded.map(toAnalyzed).sort((a, b) => a.distanceKm - b.distanceKm);
	const suggested = suggestedPick.map(toAnalyzed);
	// EVERYTHING in range without data, nearest first — the user's pick list.
	// No cap (GBV 2026-08-15): every local hotspot must be offerable for load;
	// the page handles progressive disclosure client-side.
	const unloadedNearby = inRange
		.filter((h) => !meta.has(h.locId))
		.map((h) => ({
			locId: h.locId,
			locName: h.locName,
			lat: h.lat,
			lng: h.lng,
			distanceKm: haversineKm(lat, lng, h.lat, h.lng),
			numSpeciesAllTime: h.numSpeciesAllTime ?? null
		}))
		.sort((a, b) => a.distanceKm - b.distanceKm);
	const fetchDates = analyzed.filter((a) => a.fetchedAt).map((a) => a.fetchedAt!);
	const usedMetas = withData.map((id) => meta.get(id)!);
	const rawRegion = majorityRegionCode(loaded.length > 0 ? loaded : inRange);
	const regionCode = rawRegion && isSubnational1(rawRegion) ? rawRegion : null;
	let regionName: string | null = null;
	if (regionCode) {
		try {
			const parentCountry = countryOf(regionCode)!;
			const states = (await subregions(apiKey, parentCountry, 'subnational1')).data;
			regionName = states.find((s) => s.code === regionCode)?.name ?? null;
		} catch {
			regionName = null;
		}
		if (!regionName) {
			const named = (await frequencyMeta([regionCode])).get(regionCode);
			regionName = named?.locName && named.locName !== regionCode ? named.locName : regionCode;
		}
	}

	return {
		month,
		species,
		analyzed,
		suggested,
		unloadedNearby,
		totalNearby: hotspots.data.length,
		hotspotListStale: hotspots.stale,
		oldestFetchedAt: fetchDates.length ? fetchDates.sort()[0] : null,
		outdatedCount: analyzed.filter((a) => a.hasData && !a.current).length,
		dataYears: usedMetas.length
			? {
					begin: Math.min(...usedMetas.map((m) => m.beginYear)),
					end: Math.max(...usedMetas.map((m) => m.endYear))
				}
			: null,
		year,
		regionCode,
		regionName
	};
}

/**
 * Strict majority subnational1 among hotspots that carry one.
 * A mere plurality or a tie returns null — "Where in …" and county-needs
 * must not pick an arbitrary border state.
 */
export function majorityRegionCode(hotspots: readonly EbirdHotspot[]): string | null {
	const counts = new Map<string, number>();
	let tagged = 0;
	for (const h of hotspots) {
		const code = h.subnational1Code;
		if (!code) continue;
		tagged += 1;
		counts.set(code, (counts.get(code) ?? 0) + 1);
	}
	if (tagged === 0) return null;
	let best: string | null = null;
	let n = 0;
	for (const [code, k] of counts) {
		if (k > n) {
			best = code;
			n = k;
		}
	}
	if (!best || n * 2 <= tagged) return null;
	return best;
}

// ---------------------------------------------------------------------------
// Mode B "where": county ranking + hotspot drill-down (td-854207 Phase 3)
// ---------------------------------------------------------------------------

/** Hotspots analyzed per county drill-down. */
export const COUNTY_HOTSPOT_LIMIT = 6;

/**
 * Deterministic county drill selection: half by all-time species count, half
 * by most recent activity, deduped, remainder by species count — with vague
 * catch-all locations excluded whenever enough specific candidates exist.
 * Pure; lives in the engine so it's testable (was module-private in the
 * species route).
 */
function mixBySpeciesRecency(pool: readonly EbirdHotspot[], limit: number): EbirdHotspot[] {
	const bySpecies = [...pool].sort(
		(a, b) => (b.numSpeciesAllTime ?? 0) - (a.numSpeciesAllTime ?? 0)
	);
	const byRecency = [...pool].sort((a, b) =>
		(b.latestObsDt ?? '').localeCompare(a.latestObsDt ?? '')
	);
	const chosen = new Map<string, EbirdHotspot>();
	for (const h of bySpecies.slice(0, Math.ceil(limit / 2))) chosen.set(h.locId, h);
	for (const h of byRecency) {
		if (chosen.size >= limit) break;
		chosen.set(h.locId, h);
	}
	for (const h of bySpecies) {
		if (chosen.size >= limit) break;
		chosen.set(h.locId, h);
	}
	return bySpecies.filter((h) => chosen.has(h.locId));
}

export function selectCountyHotspots(
	hotspots: readonly EbirdHotspot[],
	limit = COUNTY_HOTSPOT_LIMIT
): EbirdHotspot[] {
	const { specific, vague } = splitByNameQuality(hotspots);
	const picked = mixBySpeciesRecency(specific, limit);
	if (picked.length < limit) {
		picked.push(...mixBySpeciesRecency(vague, limit - picked.length));
	}
	return picked.sort((a, b) => (b.numSpeciesAllTime ?? 0) - (a.numSpeciesAllTime ?? 0));
}

/**
 * Coverage of a code list against stored metadata, with ANNUAL-WINDOW
 * semantics shared by loaders and actions (CODEX8 P1): a row is only
 * "current" when its endYear reaches the newest complete year; older rows
 * are "stale" — usable for fail-soft ranking but still needing a refresh, so
 * they count toward `remaining` and re-enable the analyze/refresh actions
 * after a year rollover. `failed` only counts non-current codes, so a
 * stale-row-plus-failed-refresh is never double-counted and
 * current + failed never exceeds the total. Pure.
 */
export interface LocCoverage {
	current: string[];
	stale: string[];
	missing: string[];
	/** Recent failures among non-current codes (subset of stale ∪ missing). */
	failed: string[];
	/** Codes needing a fetch and not sitting out a failure cooldown. */
	remaining: number;
}

export function coverageFromMeta(
	codes: readonly string[],
	meta: ReadonlyMap<string, { endYear: number }>,
	recentFailed: ReadonlySet<string>,
	newestCompleteYear: number
): LocCoverage {
	const current: string[] = [];
	const stale: string[] = [];
	const missing: string[] = [];
	const failed: string[] = [];
	for (const c of codes) {
		const m = meta.get(c);
		if (m && m.endYear >= newestCompleteYear) {
			current.push(c);
			continue;
		}
		if (recentFailed.has(c)) failed.push(c);
		if (m) stale.push(c);
		else missing.push(c);
	}
	return {
		current,
		stale,
		missing,
		failed,
		remaining: stale.length + missing.length - failed.length
	};
}

/** A failed location sits out of resumable batch loops for this long. */
export const FAILED_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Failed-and-cooling-down loc codes (excluded from batch loops). */
export function recentFailures(
	attempts: ReadonlyMap<string, { status: string; lastAttemptAt: Date }>,
	now: Date
): Set<string> {
	const out = new Set<string>();
	for (const [code, a] of attempts) {
		if (
			a.status === 'error' &&
			now.getTime() - a.lastAttemptAt.getTime() < FAILED_RETRY_COOLDOWN_MS
		) {
			out.add(code);
		}
	}
	return out;
}

/** One location's checklist-weighted stat for a species in a month. */
export interface RankedLoc {
	code: string;
	name: string;
	/** Fraction of the location's month checklists reporting the species. */
	freq: number;
	/** Month checklist count at the location. */
	n: number;
	lowSample: boolean;
}

/**
 * Checklist-weighted month frequency of ONE species across many stored
 * locations (counties or hotspots), ranked. The weighting unnests each
 * location's weekly sample sizes so a 1-checklist week never counts like a
 * 10,000-checklist week, and absent sparse rows still contribute their
 * checklists to the denominator (CODEX1 #2). Locations without stored data
 * simply don't appear — callers report coverage separately.
 */
export async function rankLocsForSpeciesMonth(
	locCodes: readonly string[],
	speciesCode: string,
	month: number
): Promise<RankedLoc[]> {
	if (locCodes.length === 0) return [];
	const { from, to } = monthWeeks(month);
	const r = await query<{
		loc_code: string;
		loc_name: string;
		freq: number | null;
		n: number;
	}>(
		`SELECT ff.loc_code, ff.loc_name,
		        SUM(COALESCE(sf.freq, 0) * ss.n) / NULLIF(SUM(ss.n), 0) AS freq,
		        SUM(ss.n)::float8 AS n
		   FROM frequency_fetch ff
		   JOIN LATERAL unnest(ff.sample_sizes) WITH ORDINALITY AS ss(n, week)
		     ON ss.week BETWEEN $2 AND $3
		   LEFT JOIN species_frequency sf
		     ON sf.loc_code = ff.loc_code AND sf.species_code = $4 AND sf.week = ss.week
		  WHERE ff.loc_code = ANY($1)
		  GROUP BY ff.loc_code, ff.loc_name`,
		[locCodes, from, to, speciesCode]
	);
	return r.rows
		.map((row) => ({
			code: row.loc_code,
			name: row.loc_name,
			freq: Number(row.freq ?? 0),
			n: Number(row.n),
			lowSample: Number(row.n) < MIN_MONTH_N
		}))
		.sort((a, b) => {
			if (a.lowSample !== b.lowSample) return a.lowSample ? 1 : -1;
			if (b.freq !== a.freq) return b.freq - a.freq;
			return a.name.localeCompare(b.name);
		});
}

export interface CountyNeedsRank {
	code: string;
	name: string;
	likely: number;
	possible: number;
	longshot: number;
	/** Month checklist count at this county (area n). */
	n: number;
}

/**
 * Rank a state's stored counties by how many of the user's needs are
 * likely/possible there in `month`. Counties without stored data are omitted.
 */
export async function rankCountiesForNeeds(
	userId: number,
	regionCode: string,
	month: number,
	seen?: ReadonlySet<string>
): Promise<CountyNeedsRank[]> {
	if (!isSubnational1(regionCode) && !isCountry(regionCode)) return [];
	const { from, to } = monthWeeks(month);
	const [countiesRaw, seenResolved] = await Promise.all([
		query<{ loc_code: string; loc_name: string }>(
			`SELECT loc_code, loc_name FROM frequency_fetch
			  WHERE loc_kind = 'region' AND loc_code LIKE $1`,
			[`${regionCode}-%`]
		),
		seen ?? seenSet(userId)
	]);
	// LIKE alone also matches grandchildren under a country-level code (e.g.
	// 'US-FL-057' under 'US') — keep only direct children of regionCode.
	const counties = countiesRaw.rows.filter((c) => parentOf(c.loc_code) === regionCode);
	if (counties.length === 0) return [];
	const codes = counties.map((c) => c.loc_code);
	const names = new Map(counties.map((c) => [c.loc_code, c.loc_name]));
	const r = await query<{
		loc_code: string;
		species_code: string;
		freq: number | null;
		n: number;
	}>(
		`SELECT ff.loc_code, sp.species_code,
		        SUM(COALESCE(sf.freq, 0) * ss.n) / NULLIF(SUM(ss.n), 0) AS freq,
		        SUM(ss.n)::float8 AS n
		   FROM frequency_fetch ff
		   JOIN LATERAL unnest(ff.sample_sizes) WITH ORDINALITY AS ss(n, week)
		     ON ss.week BETWEEN $2 AND $3
		   JOIN (
		        SELECT DISTINCT loc_code, species_code
		          FROM species_frequency
		         WHERE loc_code = ANY($1) AND week BETWEEN $2 AND $3
		   ) sp ON sp.loc_code = ff.loc_code
		   LEFT JOIN species_frequency sf
		     ON sf.loc_code = ff.loc_code
		    AND sf.species_code = sp.species_code
		    AND sf.week = ss.week
		  WHERE ff.loc_code = ANY($1)
		  GROUP BY ff.loc_code, sp.species_code`,
		[codes, from, to]
	);
	const byLoc = new Map<
		string,
		{ likely: number; possible: number; longshot: number; n: number }
	>();
	for (const row of r.rows) {
		if (seenResolved.has(row.species_code)) continue;
		const freq = Number(row.freq ?? 0);
		const n = Number(row.n);
		if (freq <= 0 || n < MIN_MONTH_N) continue;
		let entry = byLoc.get(row.loc_code);
		if (!entry) {
			entry = { likely: 0, possible: 0, longshot: 0, n };
			byLoc.set(row.loc_code, entry);
		}
		const band = reliabilityOf(freq);
		entry[band] += 1;
	}
	return [...byLoc.entries()]
		.map(([code, e]) => ({
			code,
			name: names.get(code) ?? code,
			likely: e.likely,
			possible: e.possible,
			longshot: e.longshot,
			n: e.n
		}))
		.filter((c) => c.likely + c.possible > 0)
		.sort((a, b) => {
			if (b.likely !== a.likely) return b.likely - a.likely;
			if (b.possible !== a.possible) return b.possible - a.possible;
			return a.name.localeCompare(b.name);
		});
}

/**
 * Best adequately-sampled month for one species at each stored location.
 * Locations with no qualifying month are omitted.
 */
export async function bestMonthsByLoc(
	locCodes: readonly string[],
	speciesCode: string
): Promise<Map<string, BestMonth>> {
	const out = new Map<string, BestMonth>();
	if (locCodes.length === 0) return out;
	const r = await query<{
		loc_code: string;
		month: number;
		freq: number | null;
		n: number;
	}>(
		`SELECT ff.loc_code,
		        ((ss.week - 1) / 4 + 1)::int AS month,
		        SUM(COALESCE(sf.freq, 0) * ss.n) / NULLIF(SUM(ss.n), 0) AS freq,
		        SUM(ss.n)::float8 AS n
		   FROM frequency_fetch ff
		   JOIN LATERAL unnest(ff.sample_sizes) WITH ORDINALITY AS ss(n, week) ON TRUE
		   LEFT JOIN species_frequency sf
		     ON sf.loc_code = ff.loc_code AND sf.species_code = $2 AND sf.week = ss.week
		  WHERE ff.loc_code = ANY($1)
		  GROUP BY ff.loc_code, month`,
		[locCodes, speciesCode]
	);
	const byLoc = new Map<string, MonthStat[]>();
	for (const row of r.rows) {
		const list = byLoc.get(row.loc_code) ?? [];
		list.push({
			month: Number(row.month),
			freq: Number(row.freq ?? 0),
			n: Number(row.n)
		});
		byLoc.set(row.loc_code, list);
	}
	for (const [code, curve] of byLoc) {
		const best = bestMonth(curve);
		if (best) out.set(code, best);
	}
	return out;
}

export interface TeaserCandidate {
	locCode: string;
	locName: string;
	best: BestMonth | null;
	neverReported: boolean;
}

/**
 * Pure picker: adequately-sampled peak wins; low-n is only a fallback when
 * no sampled state exists. Ties break toward more checklists.
 */
export function pickTeaserCandidate(
	states: readonly TeaserCandidate[]
): { locCode: string; locName: string } | null {
	const usable = states.filter((s) => !s.neverReported && s.best && s.best.freq > 0);
	const sampled = usable.filter((s) => s.best && !s.best.lowSample);
	const pool = sampled.length > 0 ? sampled : usable;
	let best: TeaserCandidate | null = null;
	for (const s of pool) {
		const b = s.best!;
		if (
			!best ||
			!best.best ||
			b.freq > best.best.freq ||
			(b.freq === best.best.freq && b.n > best.best.n) ||
			(b.freq === best.best.freq &&
				b.n === best.best.n &&
				s.locCode.localeCompare(best.locCode) < 0)
		) {
			best = s;
		}
	}
	return best ? { locCode: best.locCode, locName: best.locName } : null;
}

export interface SpeciesTeaserPick {
	locCode: string;
	locName: string;
	curve: MonthStat[];
	/** 48-week resolution for the Month|Week chart toggle (td-af8393). */
	weeks: WeekStat[];
	migration: string | null;
	best: BestMonth | null;
	peakPhrase: string | null;
	/** True when the pick is proximity-based (home + centroid known). */
	nearestBased: boolean;
	distanceKm: number | null;
	/** The globally most-findable region, when it differs from the pick. */
	alsoBest: { locCode: string; locName: string } | null;
}

/**
 * Among loaded subnational1 regions and whole-country loads, pick the one
 * where this species is most findable. One query for every stored
 * countrywide or subnational1 row (e.g. 'US-FL', 'NO-03', 'IS') — no N+1.
 */
/** All stored countrywide/subnational1 frequency regions (teaser universe). */
export async function frequencyRegionCodes(): Promise<string[]> {
	const r = await query<{ loc_code: string }>(
		`SELECT loc_code FROM frequency_fetch
		  WHERE loc_kind = 'region' AND loc_code ~ '^[A-Z]{2}(-[^-]+)?$'`
	);
	return r.rows.map((x) => x.loc_code);
}

/** How long a 404/410 ("no such region") stays cached before re-checking —
 * matches REGION_TTL_MIN (ebird.ts): political subdivisions barely change,
 * but eBird DOES occasionally split/rename/add a code, and AGY's review
 * (2026-08-29) correctly flagged that a NULL retry_after here meant a code
 * invalid today stays negative-cached forever with no recovery path. */
const CENTROID_NEGATIVE_TTL_DAYS = 30;
/** Cooldown for a transient failure (network blip, 5xx) before retrying the
 * SAME region code — short, because the failure is expected to clear soon. */
const CENTROID_TRANSIENT_COOLDOWN_DAYS = 1;

/** Process-local de-dup for concurrent identical live lookups (AGY P2: two
 * tabs / a fast back-button loading the same page can both find the same
 * missing code before either write lands). Scoped to one worker process —
 * cross-process races still just do one extra harmless eBird call. */
const inFlightCentroidFetches = new Map<string, Promise<{ lat: number; lon: number } | null>>();

/**
 * Cached region centroids, lazily filled from eBird (0039/0040). At most
 * `maxFetches` live lookups per call; callers can share a mutable `budget`
 * across picker levels to enforce a whole-page cap. Durable misses and
 * transient cooldowns both carry a TTL so a bad or since-corrected code
 * eventually re-checks instead of starving behind it forever. A null apiKey
 * serves cache-only. An account-level failure (bad key, rate limit) aborts
 * the whole sweep instead of writing a per-region cooldown — the failure
 * says nothing about whether THIS region's centroid is valid, and every
 * other in-flight code would fail identically anyway (AGY P1: the original
 * catch-all would have cooled down up to `maxFetches` unrelated regions for
 * 24h off a single bad key, degrading the picker for every subsequent
 * request on that shared cache).
 */
export async function ensureRegionCentroids(
	apiKey: string | null,
	codes: readonly string[],
	opts: { maxFetches?: number; budget?: { remaining: number } } = {}
): Promise<Map<string, { lat: number; lon: number }>> {
	const out = new Map<string, { lat: number; lon: number }>();
	const uniqueCodes = [...new Set(codes)];
	if (uniqueCodes.length === 0) return out;
	const cached = await query<{
		loc_code: string;
		lat: number | null;
		lon: number | null;
		retry_after: string | Date | null;
	}>(
		`SELECT loc_code, lat, lon, retry_after
		   FROM region_centroids WHERE loc_code = ANY($1::text[])`,
		[uniqueCodes]
	);
	const cachedByCode = new Map(cached.rows.map((row) => [row.loc_code, row]));
	for (const row of cached.rows) {
		if (row.lat != null && row.lon != null) out.set(row.loc_code, { lat: row.lat, lon: row.lon });
	}
	if (!apiKey) return out;
	const now = Date.now();
	const maxFetches = Math.max(0, Math.floor(opts.maxFetches ?? 5));
	const allowance = Math.max(0, Math.min(maxFetches, opts.budget?.remaining ?? maxFetches));
	const missing = uniqueCodes
		.filter((code) => {
			const row = cachedByCode.get(code);
			if (!row) return true;
			if (row.lat != null) return false;
			return row.retry_after != null && new Date(row.retry_after).getTime() <= now;
		})
		.slice(0, allowance);
	for (const code of missing) {
		if (opts.budget) opts.budget.remaining = Math.max(0, opts.budget.remaining - 1);
		try {
			let fetchPromise = inFlightCentroidFetches.get(code);
			if (!fetchPromise) {
				fetchPromise = fetchRegionCentroid(apiKey, code);
				inFlightCentroidFetches.set(code, fetchPromise);
				fetchPromise.finally(() => inFlightCentroidFetches.delete(code)).catch(() => {});
			}
			const c = await fetchPromise;
			if (c) {
				await query(
					`INSERT INTO region_centroids (loc_code, lat, lon) VALUES ($1, $2, $3)
					 ON CONFLICT (loc_code) DO UPDATE
					 SET lat = EXCLUDED.lat, lon = EXCLUDED.lon,
					     fetched_at = NOW(), retry_after = NULL`,
					[code, c.lat, c.lon]
				).catch(() => {});
				out.set(code, c);
			} else {
				await query(
					`INSERT INTO region_centroids (loc_code, lat, lon, retry_after)
					 VALUES ($1, NULL, NULL, NOW() + INTERVAL '${CENTROID_NEGATIVE_TTL_DAYS} days')
						 ON CONFLICT (loc_code) DO UPDATE
						 SET lat = NULL, lon = NULL, fetched_at = NOW(),
						     retry_after = NOW() + INTERVAL '${CENTROID_NEGATIVE_TTL_DAYS} days'
						 WHERE region_centroids.lat IS NULL`,
					[code]
				).catch(() => {});
			}
		} catch (err) {
			if (err instanceof EbirdError && (err.status === 401 || err.status === 403 || err.status === 429)) {
				// Account-level failure (bad/expired key, rate limit) — not a fact
				// about this region. Every remaining code would fail identically,
				// so stop the sweep rather than write a cooldown that poisons the
				// SHARED cache for every other user (AGY P1).
				break;
			}
			// A per-region transient failure (network blip, 5xx from eBird) cools
			// down briefly so one bad prefix cannot starve the tail of a large
			// country list on every page load, while still re-checking soon.
			await query(
				`INSERT INTO region_centroids (loc_code, lat, lon, retry_after)
				 VALUES ($1, NULL, NULL, NOW() + INTERVAL '${CENTROID_TRANSIENT_COOLDOWN_DAYS} days')
					 ON CONFLICT (loc_code) DO UPDATE
					 SET lat = NULL, lon = NULL, fetched_at = NOW(),
					     retry_after = NOW() + INTERVAL '${CENTROID_TRANSIENT_COOLDOWN_DAYS} days'
					 WHERE region_centroids.lat IS NULL`,
				[code]
			).catch(() => {});
		}
	}
	return out;
}

/**
 * Pure proximity picker (Gaylon 2026-08-29): the nearest region where the
 * species is actually findable, honoring the same sampled-over-low-n
 * discipline as pickTeaserCandidate. Regions with unknown centroids rank
 * last (Infinity); ties break toward higher peak frequency, checklist count,
 * then loc code.
 * Null when nothing findable has a known distance — callers fall back to
 * the global pick.
 */
export function pickNearestTeaserCandidate(
	states: readonly TeaserCandidate[],
	home: { lat: number; lon: number },
	centroids: ReadonlyMap<string, { lat: number; lon: number }>
): { locCode: string; locName: string; distanceKm: number } | null {
	const usable = states.filter((s) => !s.neverReported && s.best && s.best.freq > 0);
	const sampled = usable.filter((s) => s.best && !s.best.lowSample);
	const pool = sampled.length > 0 ? sampled : usable;
	let best: { s: TeaserCandidate; d: number } | null = null;
	for (const s of pool) {
		const c = centroids.get(s.locCode);
		const d = c ? haversineKm(home.lat, home.lon, c.lat, c.lon) : Infinity;
		if (
			!best ||
			d < best.d ||
			(d === best.d &&
				(s.best!.freq > best.s.best!.freq ||
					(s.best!.freq === best.s.best!.freq && s.best!.n > best.s.best!.n) ||
					(s.best!.freq === best.s.best!.freq &&
						s.best!.n === best.s.best!.n &&
						s.locCode.localeCompare(best.s.locCode) < 0)))
		) {
			best = { s, d };
		}
	}
	if (!best || best.d === Infinity) return null;
	return {
		locCode: best.s.locCode,
		locName: best.s.locName,
		distanceKm: best.d
	};
}

/**
 * Pure proximity sort for picker lists (country/region dropdowns, Gaylon
 * 2026-08-29 follow-up to the species-page teaser): nearest-to-home first,
 * unknown-distance entries (centroid not yet cached) fall to the end,
 * tie-broken alphabetically. With no home,
 * this degrades to a plain alphabetical sort — the pre-existing behavior for
 * users who haven't set one.
 */
export function sortByProximity<T extends { code: string; name: string }>(
	items: readonly T[],
	home: { lat: number; lon: number } | null,
	centroids: ReadonlyMap<string, { lat: number; lon: number }>,
	pinnedCode?: string
): T[] {
	const distanceOf = (code: string): number => {
		if (!home) return 0; // irrelevant when unused below
		const c = centroids.get(code);
		return c ? haversineKm(home.lat, home.lon, c.lat, c.lon) : Infinity;
	};
	return [...items].sort((a, b) => {
		if (pinnedCode && a.code !== b.code) {
			if (a.code === pinnedCode) return -1;
			if (b.code === pinnedCode) return 1;
		}
		if (home) {
			const aDistance = distanceOf(a.code);
			const bDistance = distanceOf(b.code);
			if (aDistance !== bDistance) return aDistance < bDistance ? -1 : 1;
		}
		return a.name.localeCompare(b.name) || a.code.localeCompare(b.code);
	});
}

export async function pickSpeciesTeaserState(
	speciesCode: string,
	opts: {
		home?: { lat: number; lon: number } | null;
		centroids?: ReadonlyMap<string, { lat: number; lon: number }>;
	} = {}
): Promise<SpeciesTeaserPick | null> {
	const r = await query<{
		loc_code: string;
		loc_name: string;
		sample_sizes: number[];
		week: number | null;
		freq: number | null;
	}>(
		`SELECT ff.loc_code, ff.loc_name, ff.sample_sizes, sf.week, sf.freq
		   FROM frequency_fetch ff
		   LEFT JOIN species_frequency sf
		     ON sf.loc_code = ff.loc_code AND sf.species_code = $1
		  WHERE ff.loc_kind = 'region' AND ff.loc_code ~ '^[A-Z]{2}(-[^-]+)?$'`,
		[speciesCode]
	);
	if (r.rows.length === 0) return null;

	const byLoc = new Map<
		string,
		{ locName: string; sampleSizes: number[]; freqByWeek: Map<number, number> }
	>();
	for (const row of r.rows) {
		let entry = byLoc.get(row.loc_code);
		if (!entry) {
			const sizes = Array.isArray(row.sample_sizes) ? row.sample_sizes.map((n) => Number(n)) : [];
			entry = {
				locName: row.loc_name,
				sampleSizes: sizes,
				freqByWeek: new Map()
			};
			byLoc.set(row.loc_code, entry);
		}
		if (row.week != null && row.freq != null) {
			const week = Number(row.week);
			if (week >= 1 && week <= WEEKS) entry.freqByWeek.set(week, Number(row.freq));
		}
	}

	const built: {
		candidate: TeaserCandidate;
		curve: MonthStat[];
		peakPhrase: string | null;
	}[] = [];
	for (const [locCode, e] of byLoc) {
		const curve = monthCurve(e.freqByWeek, e.sampleSizes);
		const best = bestMonth(curve);
		const rawPeak = peakWeekPhrase(e.freqByWeek, e.sampleSizes);
		const peakPhrase =
			best && rawPeak && rawPeak.endsWith(MONTH_NAMES[best.month - 1]) ? rawPeak : null;
		built.push({
			candidate: {
				locCode,
				locName: e.locName,
				best,
				neverReported: e.freqByWeek.size === 0
			},
			curve,
			peakPhrase
		});
	}
	const globalPick = pickTeaserCandidate(built.map((b) => b.candidate));
	if (!globalPick) return null;
	// Proximity-first (Gaylon 2026-08-29): the actionable region is the one a
	// birder can reach from home; the world's best region is a footnote, not
	// the headline. Falls back to the global pick when home/centroids are
	// unavailable.
	const nearest =
		opts.home != null
			? pickNearestTeaserCandidate(
					built.map((b) => b.candidate),
					opts.home,
					opts.centroids ?? new Map()
				)
			: null;
	const pick = nearest ?? globalPick;
	const win = built.find((b) => b.candidate.locCode === pick.locCode);
	if (!win) return null;
	const e = byLoc.get(pick.locCode)!;
	const weeks = weekCurve(e.freqByWeek, e.sampleSizes);
	return {
		locCode: pick.locCode,
		locName: pick.locName,
		curve: win.curve,
		weeks,
		migration: migrationSentence(weeks),
		best: win.candidate.best,
		peakPhrase: win.peakPhrase,
		nearestBased: nearest != null,
		distanceKm: nearest?.distanceKm ?? null,
		alsoBest:
			nearest != null && globalPick.locCode !== nearest.locCode
				? { locCode: globalPick.locCode, locName: globalPick.locName }
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
	const best = bestMonth(curve);
	const rawPeak = peakWeekPhrase(freqByWeek, meta.sampleSizes);
	// Only keep weekly timing when it refines the best month ("late January"),
	// never when a single noisy week in another month would contradict it.
	const peakPhrase =
		best && rawPeak && rawPeak.endsWith(MONTH_NAMES[best.month - 1]) ? rawPeak : null;
	const weeks = weekCurve(freqByWeek, meta.sampleSizes);
	return {
		meta,
		curve,
		weeks,
		migration: migrationSentence(weeks),
		best,
		peakPhrase,
		// The window, not just the peak: months within 80% of the best —
		// trip planning rarely controls the exact month.
		good: goodMonths(curve),
		neverReported: freqByWeek.size === 0
	};
}
