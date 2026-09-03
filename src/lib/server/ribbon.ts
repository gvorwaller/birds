/**
 * Migration ribbon — server aggregation (td-59c2d0 build spec, TD-B).
 *
 * `speciesRibbon` reads the 0050 band-grain rollups (band_locs,
 * band_month_samples, species_band_month_freq — td-8d3526) and folds them
 * into a (band × continent-column × month) grid under two weightings:
 * "equal" (each country counts once inside its column, and each continent
 * counts once in the world row — never let one heavily-birded country like
 * the US drown out everything else) and "checklists" (straight
 * checklist-weighted Σnum/Σn, the same math the rest of the app uses).
 *
 * `ribbonRegions` is the drill-down: the individual loaded regions inside one
 * band/column cell, each carrying the same month/week curve shape the
 * Best-time-of-year card uses (built with forecast.ts's own helpers so the
 * two cards never compute "best month" two different ways).
 *
 * Everything here reads ONE `withReadSnapshot()` client per call (CODEX1
 * P1-2): three separate `query()` calls could straddle a country's band
 * rollup being rebuilt mid-read and combine a pre-rebuild `n` with a
 * post-rebuild `num`, silently publishing a ratio that never existed.
 */
import { withReadSnapshot } from '$lib/db';
import {
	ribbonColumnOf,
	regionLabel,
	type RibbonColumn as RegionsRibbonColumn
} from '$server/regions';
import {
	monthCurve,
	weekCurve,
	bestMonth,
	goodMonths,
	peakWeekPhrase,
	migrationSentence,
	MONTH_NAMES,
	type MonthStat,
	type WeekStat,
	type BestMonth
} from '$server/forecast';
import { WEEKS } from '$server/barchart';

export const BANDS = [80, 70, 60, 50, 40, 30, 20, 10, 0, -10, -20, -30, -40, -50, -60, -70, -80, -90] as const;
export const COLUMNS = ['NAW', 'NAE', 'SA', 'EU', 'AF', 'AS', 'OC', 'AN'] as const;
export type RibbonColumn = (typeof COLUMNS)[number];
export const WORLD_GROUPS: RibbonColumn[][] = [
	['NAW', 'NAE'],
	['SA'],
	['EU'],
	['AF'],
	['AS'],
	['OC'],
	['AN']
];
/** A country's coalesced checklist total below this does not vote under equal
 * weight (owner decision, CODEX1 P2-2, 2026-09-03). */
export const LOW_N = 40;
/** Frequency floor for "the species reaches this region" (0049/0050 `reached`). */
export const PRESENT = 0.005;

export type Weighting = 'equal' | 'checklists';

/**
 * 'thin': at least one coalesced country was surveyed (n > 0) that month but
 * NONE reached LOW_N under equal weight — a real, surveyed cell, never the
 * "nothing loaded" null (CODEX1 P1-1 deploy-gate finding on td-c6b113). Only
 * `equalWeightCell`/`worldEqualCell` ever produce it; `checklistCell` never
 * excludes a country (summed-n rule), so it never returns 'thin'.
 */
export type RibbonCellState = 'reported' | 'zero' | 'thin';
export interface RibbonCell {
	/**
	 * When `state === 'thin'` this is a PLACEHOLDER (always 0) — MUST NOT be
	 * read as a reporting rate. TD-C draws a 'thin' cell as a hatch with no
	 * colour bin ("surveyed, too few checklists to rate"), never a %.
	 */
	f: number;
	/** For 'thin', the summed n of every excluded (surveyed-but-thin) country. */
	n: number;
	state: RibbonCellState;
	/** Hatched: an aggregate with a country excluded (equal weight, includes
	 * every 'thin' cell) or a thin sample under the summed-n rule (checklists). */
	low: boolean;
	/** Countries left out of an equal-weight average for n < LOW_N. */
	excluded: number;
}
/** null = nothing loaded, or no checklists at all that month (the mockup's
 * `empty`) — distinct from 'thin', which IS loaded/surveyed data. */
export type RibbonCellOrNull = RibbonCell | null;

export interface RibbonMode {
	/** [bandIndex][columnIndex][month-1] */
	cols: RibbonCellOrNull[][][];
	/** [bandIndex][month-1] */
	world: RibbonCellOrNull[][];
}

export interface RibbonGrid {
	speciesCode: string;
	modes: Record<Weighting, RibbonMode>;
	/** [bandIndex][columnIndex] — the readout's "N regions". */
	regionCounts: number[][];
	/** Surveyed somewhere, below PRESENT in every loaded region, all year. */
	gapMonths: number[];
	meta: {
		/** band_locs rows (a country-only country counts its country row once). */
		regions: number;
		countries: number;
		columnsLoaded: RibbonColumn[];
		columnsMissing: RibbonColumn[];
		/** Surfaced, never dropped silently (CODEX1 P1). */
		unmappedCountries: string[];
	};
}

export interface RibbonRegionRow {
	locCode: string;
	label: string;
	country: string;
	column: RibbonColumn;
	band: number;
	curve: MonthStat[];
	weeks: WeekStat[];
	/** max curve.freq, no n gate (mockup peakOf). */
	peak: number;
	best: BestMonth | null;
	peakPhrase: string | null;
	good: number[];
	migration: string | null;
}
export interface RibbonRegions {
	rows: RibbonRegionRow[];
	total: number;
	/** rows.length < total */
	capped: boolean;
}

export interface CountryCellInput {
	country: string;
	column: RibbonColumn;
	num: number;
	n: number;
}

const RIBBON_REGION_CAP = 40;

function baseContinentOf(column: RibbonColumn): string {
	return column === 'NAW' || column === 'NAE' ? 'NA' : column;
}

/** Group by country, dropping n<=0 entries — the shared first step of every
 * "count each country once" aggregation below. */
function coalesceByCountry(rows: readonly CountryCellInput[]): Map<string, { num: number; n: number }> {
	const byCountry = new Map<string, { num: number; n: number }>();
	for (const r of rows) {
		if (r.n <= 0) continue;
		let e = byCountry.get(r.country);
		if (!e) byCountry.set(r.country, (e = { num: 0, n: 0 }));
		e.num += r.num;
		e.n += r.n;
	}
	return byCountry;
}

/** zero iff f===0; low = f>0 && n<LOW_N. */
export function classify(f: number, n: number): RibbonCell {
	return { f, n, state: f === 0 ? 'zero' : 'reported', low: f > 0 && n < LOW_N, excluded: 0 };
}

/**
 * One column: mean over countries of num/n (n>0 only). A country whose
 * coalesced n < LOW_N does not vote (owner decision, CODEX1 P2-2); if any
 * country was excluded the cell is hatched (`low: true`). When EVERY
 * coalesced country is thin (surveyed but none reached LOW_N), the cell is
 * 'thin' — never null (CODEX1 P1-1): null is reserved for nothing loaded.
 */
export function equalWeightCell(rows: CountryCellInput[]): RibbonCellOrNull {
	const byCountry = coalesceByCountry(rows);
	if (byCountry.size === 0) return null;
	const fs: number[] = [];
	let n = 0;
	let excluded = 0;
	for (const e of byCountry.values()) {
		if (e.n < LOW_N) {
			excluded++;
			continue;
		}
		fs.push(e.num / e.n);
		n += e.n;
	}
	if (fs.length === 0) {
		let thinN = 0;
		for (const e of byCountry.values()) thinN += e.n;
		return { f: 0, n: thinN, state: 'thin', low: true, excluded };
	}
	const f = fs.reduce((a, b) => a + b, 0) / fs.length;
	return { f, n, state: f === 0 ? 'zero' : 'reported', low: excluded > 0, excluded };
}

/** Σnum/Σn — the summed-n rule; no country is ever excluded. */
export function checklistCell(rows: CountryCellInput[]): RibbonCellOrNull {
	let num = 0;
	let n = 0;
	for (const r of rows) {
		if (r.n <= 0) continue;
		num += r.num;
		n += r.n;
	}
	if (n === 0) return null;
	return classify(num / n, n);
}

/**
 * MERGE (build spec rev 2, CODEX1-verified): NAW+NAE are ONE continent for
 * the world row, so a column layout must never change the world number.
 * Group by base continent, take each country's checklist-weighted mean
 * (countries under LOW_N do not vote), average countries inside a
 * continent, then average continents. When NO continent has a qualifying
 * country (every coalesced country everywhere is thin), the cell is 'thin'
 * — never null (CODEX1 P1-1).
 */
export function worldEqualCell(rows: CountryCellInput[]): RibbonCellOrNull {
	const byBase = new Map<string, Map<string, { num: number; n: number }>>();
	for (const r of rows) {
		if (r.n <= 0) continue;
		const base = baseContinentOf(r.column);
		let bc = byBase.get(base);
		if (!bc) byBase.set(base, (bc = new Map()));
		let e = bc.get(r.country);
		if (!e) bc.set(r.country, (e = { num: 0, n: 0 }));
		e.num += r.num;
		e.n += r.n;
	}
	if (byBase.size === 0) return null;
	const contMeans: number[] = [];
	let n = 0;
	let excluded = 0;
	for (const bc of byBase.values()) {
		const fs: number[] = [];
		for (const e of bc.values()) {
			if (e.n < LOW_N) {
				excluded++;
				continue;
			}
			fs.push(e.num / e.n);
			n += e.n;
		}
		if (fs.length > 0) contMeans.push(fs.reduce((a, b) => a + b, 0) / fs.length);
	}
	if (contMeans.length === 0) {
		let thinN = 0;
		for (const bc of byBase.values()) for (const e of bc.values()) thinN += e.n;
		return { f: 0, n: thinN, state: 'thin', low: true, excluded };
	}
	const f = contMeans.reduce((a, b) => a + b, 0) / contMeans.length;
	return { f, n, state: f === 0 ? 'zero' : 'reported', low: excluded > 0, excluded };
}

/**
 * Month m is a gap iff it was surveyed somewhere (Σ samples.n > 0) and
 * reached nowhere (Σ reached === 0). Region-grain inputs sum the same as
 * pre-aggregated band-grain ones (both are plain sums), so a caller can pass
 * either shape.
 */
export function gapMonthsFrom(
	samples: { month: number; n: number }[],
	reached: { month: number; reached: number }[]
): number[] {
	const nByMonth = new Map<number, number>();
	for (const s of samples) nByMonth.set(s.month, (nByMonth.get(s.month) ?? 0) + s.n);
	const reachedByMonth = new Map<number, number>();
	for (const r of reached) reachedByMonth.set(r.month, (reachedByMonth.get(r.month) ?? 0) + r.reached);
	const gaps: number[] = [];
	for (let m = 1; m <= 12; m++) {
		const n = nByMonth.get(m) ?? 0;
		const rc = reachedByMonth.get(m) ?? 0;
		if (n > 0 && rc === 0) gaps.push(m);
	}
	return gaps;
}

export function bandIndexOf(band: number): number {
	return (BANDS as readonly number[]).indexOf(band);
}

type ColumnOf = (country: string, west: boolean) => RegionsRibbonColumn | null;

interface BandCountryKey {
	band: number;
	country: string;
	west: boolean;
}
function keyOf(k: BandCountryKey): string {
	return `${k.band}|${k.country}|${k.west}`;
}

/**
 * The full (band × column × month) grid for one species under both
 * weightings, plus the world row and the drill's region counts. `null` when
 * nothing has ever loaded (`band_locs` empty) — never a grid of empty cells.
 *
 * Reads exactly three SELECTs, all on the 0050 band tables, on ONE
 * `withReadSnapshot` client (CODEX1 P1-2).
 */
export async function speciesRibbon(
	speciesCode: string,
	deps: { columnOf?: ColumnOf } = {}
): Promise<RibbonGrid | null> {
	const columnOf = deps.columnOf ?? ribbonColumnOf;

	const { samplesRows, freqRows, locRows } = await withReadSnapshot(async (client) => {
		const samples = await client.query<{
			band: number;
			country: string;
			west: boolean;
			month: number;
			n: string | number;
		}>('SELECT band, country, west, month, n FROM band_month_samples');
		const freq = await client.query<{
			band: number;
			country: string;
			west: boolean;
			month: number;
			num: string | number;
			reached: number;
		}>(
			'SELECT band, country, west, month, num, reached FROM species_band_month_freq WHERE species_code = $1',
			[speciesCode]
		);
		const locs = await client.query<{
			band: number;
			country: string;
			west: boolean;
			count: string | number;
		}>('SELECT band, country, west, count(*) FROM band_locs GROUP BY 1, 2, 3');
		return { samplesRows: samples.rows, freqRows: freq.rows, locRows: locs.rows };
	});

	if (locRows.length === 0) return null;

	// n by (band, country, west, month) — the denominator every cell needs,
	// including months this species was never reported (num defaults to 0).
	const nByKeyMonth = new Map<string, Map<number, number>>();
	for (const r of samplesRows) {
		const k = keyOf({ band: Number(r.band), country: r.country, west: r.west });
		let byMonth = nByKeyMonth.get(k);
		if (!byMonth) nByKeyMonth.set(k, (byMonth = new Map()));
		byMonth.set(Number(r.month), (byMonth.get(Number(r.month)) ?? 0) + Number(r.n));
	}
	const numByKeyMonth = new Map<string, Map<number, number>>();
	const reachedByKeyMonth = new Map<string, Map<number, number>>();
	for (const r of freqRows) {
		const k = keyOf({ band: Number(r.band), country: r.country, west: r.west });
		let byMonth = numByKeyMonth.get(k);
		if (!byMonth) numByKeyMonth.set(k, (byMonth = new Map()));
		byMonth.set(Number(r.month), (byMonth.get(Number(r.month)) ?? 0) + Number(r.num));
		let reachedMonth = reachedByKeyMonth.get(k);
		if (!reachedMonth) reachedByKeyMonth.set(k, (reachedMonth = new Map()));
		reachedMonth.set(Number(r.month), (reachedMonth.get(Number(r.month)) ?? 0) + Number(r.reached));
	}

	// One entry per (band, country, west) — the unit both `regionCounts` and
	// the cell inputs are built from.
	interface Group extends BandCountryKey {
		column: RibbonColumn | null;
		regionCount: number;
	}
	const groups: Group[] = locRows.map((r) => ({
		band: Number(r.band),
		country: r.country,
		west: r.west,
		column: columnOf(r.country, r.west),
		regionCount: Number(r.count)
	}));

	const unmapped = new Set<string>();
	for (const g of groups) if (g.column === null) unmapped.add(g.country);
	if (unmapped.size > 0) {
		console.error(
			`[ribbon] countries missing from continents.json: ${[...unmapped].sort().join(', ')}`
		);
	}

	// meta.regions/countries describe overall coverage — independent of
	// whether a country happens to be continent-mapped yet.
	const regions = groups.reduce((sum, g) => sum + g.regionCount, 0);
	const countries = new Set(groups.map((g) => g.country)).size;

	const columnsLoaded = new Set<RibbonColumn>();
	for (const g of groups) if (g.column) columnsLoaded.add(g.column);
	const columnsMissing = COLUMNS.filter((c) => !columnsLoaded.has(c));

	const regionCounts: number[][] = BANDS.map(() => COLUMNS.map(() => 0));
	for (const g of groups) {
		if (!g.column) continue;
		const b = bandIndexOf(g.band);
		const c = COLUMNS.indexOf(g.column);
		if (b < 0 || c < 0) continue;
		regionCounts[b][c] += g.regionCount;
	}

	// gapMonths: global across every loaded region, unmapped countries
	// included — a gap is about coverage, not about the continent map.
	const sampleTotals: { month: number; n: number }[] = [];
	const reachedTotals: { month: number; reached: number }[] = [];
	for (const g of groups) {
		const k = keyOf(g);
		const byMonth = nByKeyMonth.get(k);
		if (byMonth) for (const [month, n] of byMonth) sampleTotals.push({ month, n });
		const reachedMonth = reachedByKeyMonth.get(k);
		if (reachedMonth) for (const [month, reached] of reachedMonth) reachedTotals.push({ month, reached });
	}
	const gapMonths = gapMonthsFrom(sampleTotals, reachedTotals);

	const buildMode = (weighting: Weighting): RibbonMode => {
		const cols: RibbonCellOrNull[][][] = BANDS.map(() => COLUMNS.map(() => Array(12).fill(null)));
		const world: RibbonCellOrNull[][] = BANDS.map(() => Array(12).fill(null));
		for (let b = 0; b < BANDS.length; b++) {
			const band = BANDS[b];
			const bandGroups = groups.filter((g) => g.band === band);
			for (let m = 1; m <= 12; m++) {
				// Per-column cells.
				for (let c = 0; c < COLUMNS.length; c++) {
					const column = COLUMNS[c];
					const rows: CountryCellInput[] = [];
					for (const g of bandGroups) {
						if (g.column !== column) continue;
						const n = nByKeyMonth.get(keyOf(g))?.get(m) ?? 0;
						const num = numByKeyMonth.get(keyOf(g))?.get(m) ?? 0;
						rows.push({ country: g.country, column, num, n });
					}
					cols[b][c][m - 1] = weighting === 'equal' ? equalWeightCell(rows) : checklistCell(rows);
				}
				// World row: every mapped group in this band, regardless of column.
				const worldRows: CountryCellInput[] = [];
				for (const g of bandGroups) {
					if (!g.column) continue;
					const n = nByKeyMonth.get(keyOf(g))?.get(m) ?? 0;
					const num = numByKeyMonth.get(keyOf(g))?.get(m) ?? 0;
					worldRows.push({ country: g.country, column: g.column, num, n });
				}
				world[b][m - 1] = weighting === 'equal' ? worldEqualCell(worldRows) : checklistCell(worldRows);
			}
		}
		return { cols, world };
	};

	return {
		speciesCode,
		modes: { equal: buildMode('equal'), checklists: buildMode('checklists') },
		regionCounts,
		gapMonths,
		meta: {
			regions,
			countries,
			columnsLoaded: COLUMNS.filter((c) => columnsLoaded.has(c)),
			columnsMissing,
			unmappedCountries: [...unmapped].sort()
		}
	};
}

/**
 * The regions inside one band/column cell (or the whole band for 'ALL'),
 * each carrying the same month/week curve shape the Best-time-of-year card
 * uses. The two MUTABLE reads — `band_locs` then the teaser-shaped frequency
 * query restricted to those loc codes — run on ONE `withReadSnapshot` client
 * (CODEX1 P1-2), so a country rebuild can never straddle them. Region LABELS
 * are resolved afterward, outside that snapshot, via `regionLabel()`, which
 * reads the process-wide `regions` cache — static reference data seeded
 * offline and reloaded only on redeploy, not the mutable pair the snapshot
 * protects (CODEX1 P2-2: deliberately not moved inside the transaction).
 */
export async function ribbonRegions(
	speciesCode: string,
	band: number,
	column: RibbonColumn | 'ALL'
): Promise<RibbonRegions> {
	const { locs, freqRows } = await withReadSnapshot(async (client) => {
		const locResult = await client.query<{ loc_code: string; country: string; west: boolean }>(
			'SELECT loc_code, country, west FROM band_locs WHERE band = $1',
			[band]
		);
		const matched = locResult.rows
			.map((r) => ({ ...r, column: ribbonColumnOf(r.country, r.west) }))
			.filter((r) => r.column !== null && (column === 'ALL' || r.column === column)) as {
			loc_code: string;
			country: string;
			west: boolean;
			column: RibbonColumn;
		}[];
		if (matched.length === 0) return { locs: matched, freqRows: [] as never[] };
		const freq = await client.query<{
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
			  WHERE ff.loc_code = ANY($2)`,
			[speciesCode, matched.map((m) => m.loc_code)]
		);
		return { locs: matched, freqRows: freq.rows };
	});

	if (locs.length === 0) return { rows: [], total: 0, capped: false };

	const byLoc = new Map<
		string,
		{ locName: string; sampleSizes: number[]; freqByWeek: Map<number, number> }
	>();
	for (const row of freqRows) {
		let entry = byLoc.get(row.loc_code);
		if (!entry) {
			const sizes = Array.isArray(row.sample_sizes) ? row.sample_sizes.map((n) => Number(n)) : [];
			entry = { locName: row.loc_name, sampleSizes: sizes, freqByWeek: new Map() };
			byLoc.set(row.loc_code, entry);
		}
		if (row.week != null && row.freq != null) {
			const week = Number(row.week);
			if (week >= 1 && week <= WEEKS) entry.freqByWeek.set(week, Number(row.freq));
		}
	}

	const built: RibbonRegionRow[] = [];
	for (const loc of locs) {
		const e = byLoc.get(loc.loc_code);
		if (!e) continue;
		const curve = monthCurve(e.freqByWeek, e.sampleSizes);
		if (curve.every((c) => c.n === 0)) continue;
		const weeks = weekCurve(e.freqByWeek, e.sampleSizes);
		const best = bestMonth(curve);
		const rawPeakPhrase = peakWeekPhrase(e.freqByWeek, e.sampleSizes);
		const peakPhrase =
			best && rawPeakPhrase && rawPeakPhrase.endsWith(MONTH_NAMES[best.month - 1]) ? rawPeakPhrase : null;
		const label = (await regionLabel(loc.loc_code)) ?? e.locName;
		built.push({
			locCode: loc.loc_code,
			label,
			country: loc.country,
			column: loc.column,
			band,
			curve,
			weeks,
			peak: Math.max(...curve.map((c) => c.freq)),
			best,
			peakPhrase,
			good: goodMonths(curve),
			migration: migrationSentence(weeks)
		});
	}

	built.sort((a, b) => b.peak - a.peak || a.locCode.localeCompare(b.locCode));
	const total = built.length;
	const rows = built.slice(0, RIBBON_REGION_CAP);
	return { rows, total, capped: rows.length < total };
}
