/**
 * Migration ribbon — pure client logic (td-59c2d0 build spec, TD-C).
 *
 * ALL non-DOM logic for MigrationRibbon.svelte lives here so it stays
 * unit-testable without a component-render harness (this repo has none —
 * see nav-progress-core.ts / job-poll-core.ts for the same split). Nothing
 * here touches `$server` or the DOM: the client types below are structurally
 * equal to `$server/ribbon`'s but duplicated on purpose (FrequencyChart.svelte
 * precedent, `:1-19`) so this component never depends on server code.
 *
 * The algorithms (readout copy, chartAria, scope caption, gap note, geometry,
 * keyboard reducer, pointer picking) are ported from the verified oracle,
 * `docs/mockups/species-migration-ribbon.html`, MINUS its "coverage preview"
 * feature (out of scope here) and WITH the cs.md compliance fix (owner
 * decision, CODEX1 P1-7): 640/1024 breakpoints only, ≥48px tap targets, no
 * `touch-action: pan-x`.
 */

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

export const BANDS = [
	80, 70, 60, 50, 40, 30, 20, 10, 0, -10, -20, -30, -40, -50, -60, -70, -80, -90
] as const;
export const COLUMNS = ['NAW', 'NAE', 'SA', 'EU', 'AF', 'AS', 'OC', 'AN'] as const;
export type RibbonColumn = (typeof COLUMNS)[number];

export const COLUMN_NAMES: Record<RibbonColumn, string> = {
	NAW: 'North America, west of 100°W',
	NAE: 'North America, east of 100°W',
	SA: 'South America',
	EU: 'Europe',
	AF: 'Africa',
	AS: 'Asia',
	OC: 'Oceania',
	AN: 'Antarctica'
};
export const COLUMN_SHORT: Record<RibbonColumn, string> = {
	NAW: 'NA-W',
	NAE: 'NA-E',
	SA: 'SA',
	EU: 'EU',
	AF: 'AF',
	AS: 'AS',
	OC: 'OC',
	AN: 'AN'
};

export const MONTHS = [
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
];
export const MSHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const ML = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

/** A country's coalesced checklist total below this does not vote under equal
 * weight (mirrors $server/ribbon's LOW_N, owner decision, CODEX1 P2-2). */
export const LOW_N = 40;
/** Frequency floor for "the species reaches this region" (0049/0050 `reached`). */
export const PRESENT = 0.005;
/** Home region's column — the default single-continent selection. */
export const HOME_COLUMN: RibbonColumn = 'NAE';
export const PLAY_MS = 750;
/** Row height, world/all-continents view. */
export const ROW_H = 22;
/** Row height, single-continent view on a phone — a 48px tap target
 * (cs.md ≥48px; owner decision, CODEX1 P1-7). */
export const ROW_H_TOUCH = 48;

export const BINS: { max: number; label: string }[] = [
	{ max: 0, label: '0% — surveyed, no reports' },
	{ max: 0.01, label: '<1%' },
	{ max: 0.03, label: '1–3%' },
	{ max: 0.1, label: '3–10%' },
	{ max: 0.25, label: '10–25%' },
	{ max: Infinity, label: '25%+' }
];

/** 0..5. `f === 0` → bin 0; otherwise the first bin whose EXCLUSIVE upper
 * bound exceeds `f` (CODEX1 P2-6: 0.01 prints "1%", so it must land in the
 * 1–3% bin, not "<1%"). */
export function binIndex(f: number): number {
	if (f === 0) return 0;
	for (let i = 1; i < BINS.length; i++) if (f < BINS[i].max) return i;
	return BINS.length - 1;
}

export function pct(f: number): string {
	if (f === 0) return '0%';
	if (f < 0.01) return '<1%';
	return `${Math.round(f * 100)}%`;
}

function fmtN(n: number): string {
	return Math.round(n).toLocaleString('en-US');
}

/** 1.2M | 96K | 1,017 */
export function compact(n: number): string {
	if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
	if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
	return fmtN(n);
}

/** '40–50°N' | '30–40°S' */
export function bandLabel(lo: number): string {
	return lo >= 0 ? `${lo}–${lo + 10}°N` : `${Math.abs(lo + 10)}–${Math.abs(lo)}°S`;
}

// ---------------------------------------------------------------------------
// Geographic landmarks & biological migration summaries (td-476c32)
// ---------------------------------------------------------------------------

export const LANDMARKS: Record<string, Record<number, string>> = {
	NAE: {
		80: 'High Arctic / Ellesmere',
		70: 'Arctic Archipelago / Baffin',
		60: 'Hudson Bay / Subarctic',
		50: 'Boreal & S. Canada',
		40: 'Great Lakes & New England',
		30: 'Mid-Atlantic & Midwest',
		20: 'Gulf Coast & S. Florida',
		10: 'Central America & Caribbean',
		0: 'Panama & N. South America'
	},
	NAW: {
		80: 'Beaufort Sea / High Arctic',
		70: 'N. Alaska & Yukon',
		60: 'Central Alaska & N. BC',
		50: 'Pacific NW, S. BC & Prairies',
		40: 'N. California & Great Basin',
		30: 'S. California & Desert SW',
		20: 'NW Mexico & Baja',
		10: 'S. Mexico & Central America',
		0: 'Costa Rica & Galapagos'
	},
	EU: {
		70: 'Lapland & Arctic Norway',
		60: 'Scandinavia, Baltic & Scotland',
		50: 'British Isles & Central Europe',
		40: 'Mediterranean & Iberia',
		30: 'N. Africa Coast & Canary Is.',
		20: 'Sahara'
	},
	AF: {
		30: 'Maghreb & N. Sahara',
		20: 'Sahara & Sahel North',
		10: 'Sahel, W. Africa & Horn',
		0: 'Equatorial Africa & Congo Basin',
		[-10]: 'Miombo, Tanzania & Angola',
		[-20]: 'Zambezi, Kalahari & Namibia',
		[-30]: 'South Africa & Cape'
	},
	SA: {
		10: 'Caribbean Coast & Venezuela',
		0: 'Amazonia, Colombia & Ecuador',
		[-10]: 'Central Amazon, Peru & N. Brazil',
		[-20]: 'Pantanal, Bolivia & Highlands',
		[-30]: 'Pampas, Uruguay & S. Brazil',
		[-40]: 'Patagonia (Chile & Argentina)',
		[-50]: 'Tierra del Fuego',
		[-60]: 'Drake Passage'
	},
	AS: {
		70: 'Siberian Arctic Tundra',
		60: 'Siberian Taiga',
		50: 'Mongolia, NE China & S. Siberia',
		40: 'Central Asia, Beijing & Japan',
		30: 'Himalayas, Yangtze & S. Japan',
		20: 'India, Indochina & S. China',
		10: 'SE Asia, Philippines & S. India',
		0: 'Malaysia, Indonesia & Borneo'
	},
	OC: {
		0: 'New Guinea & Micronesia',
		[-10]: 'N. Australia & Coral Sea',
		[-20]: 'Central Australia & Queensland',
		[-30]: 'S. Australia, Sydney & N. NZ',
		[-40]: 'Tasmania & S. Island NZ',
		[-50]: 'Subantarctic Islands',
		[-60]: 'Southern Ocean',
		[-70]: 'Ross Ice Shelf'
	},
	AN: {
		[-60]: 'South Shetland Islands',
		[-70]: 'Antarctic Peninsula & Coast',
		[-80]: 'Transantarctic Mountains',
		[-90]: 'South Pole'
	},
	WORLD: {
		80: 'High Arctic',
		70: 'Arctic Tundra',
		60: 'Subarctic & Boreal',
		50: 'Temperate North',
		40: 'Mid-Latitudes North',
		30: 'Subtropics North',
		20: 'Tropical North',
		10: 'Equatorial North',
		0: 'Equatorial Belt',
		[-10]: 'Equatorial South',
		[-20]: 'Tropical South',
		[-30]: 'Subtropics South',
		[-40]: 'Mid-Latitudes South',
		[-50]: 'Subantarctic',
		[-60]: 'Southern Ocean',
		[-70]: 'Antarctic Coast',
		[-80]: 'Antarctic Interior',
		[-90]: 'South Pole'
	}
};

export function landmarkFor(band: number, col: RibbonColumn | null): string | null {
	if (col && LANDMARKS[col]?.[band]) {
		return LANDMARKS[col][band];
	}
	return LANDMARKS.WORLD[band] ?? null;
}

export interface MigrationSummary {
	hasData: boolean;
	headline: string;
	details: string;
	span: string | null;
}

/**
 * Returns the contiguous latitudinal slice of bands occupied by the species
 * (plus 1 buffer band above and below).
 */
export function occupiedBands(grid: RibbonGridClient, s: RibbonState): number[] {
	const mode = grid.modes[s.weight];
	const cols = drawnColumns(s);
	const reportedBands: number[] = [];

	for (let bi = 0; bi < BANDS.length; bi++) {
		const band = BANDS[bi];
		let hasData = false;
		for (let m = 0; m < 12; m++) {
			if (s.view === 'cont') {
				for (const c of cols) {
					const ci = COLUMNS.indexOf(c);
					const cell = ci >= 0 ? mode.cols[bi]?.[ci]?.[m] : null;
					if (cell && (cell.state === 'reported' || cell.f > 0)) {
						hasData = true;
						break;
					}
				}
				if (hasData) break;
			} else {
				const cell = mode.world[bi]?.[m];
				if (cell && (cell.state === 'reported' || cell.f > 0)) {
					hasData = true;
					break;
				}
			}
		}
		if (hasData) reportedBands.push(band);
	}

	if (reportedBands.length === 0) return [...BANDS];

	const indices = reportedBands
		.map((b) => (BANDS as readonly number[]).indexOf(b as (typeof BANDS)[number]))
		.filter((i) => i >= 0);
	const minIdx = Math.max(0, Math.min(...indices) - 1);
	const maxIdx = Math.min(BANDS.length - 1, Math.max(...indices) + 1);

	return BANDS.slice(minIdx, maxIdx + 1);
}

/**
 * Active bands to display: all 18 if fullGlobe is true, else occupied slice.
 */
export function activeBands(grid: RibbonGridClient, s: RibbonState, fullGlobe?: boolean): number[] {
	if (fullGlobe ?? s.fullGlobe) return [...BANDS];
	return occupiedBands(grid, s);
}

/**
 * Synthesizes a natural-language biological migration profile and seasonal phases
 * from the frequency distribution.
 */
export function migrationSummary(grid: RibbonGridClient, s: RibbonState): MigrationSummary {
	const col = s.view === 'cont' && s.contView !== 'ALL' ? (s.contView ?? s.cont ?? HOME_COLUMN) : null;
	const mode = grid.modes[s.weight];

	// Extract peak band and frequency per month
	const monthlyPeaks: { month: number; band: number; maxF: number; avgLat: number }[] = [];
	let totalObserved = 0;

	for (let m = 0; m < 12; m++) {
		let maxF = 0;
		let peakBand = 40;
		let sumLatF = 0;
		let sumF = 0;

		for (let bi = 0; bi < BANDS.length; bi++) {
			const band = BANDS[bi];
			let cell: RibbonCellClient | null = null;
			if (col != null) {
				const ci = COLUMNS.indexOf(col);
				cell = ci >= 0 ? mode.cols[bi]?.[ci]?.[m] : null;
			} else {
				cell = mode.world[bi]?.[m];
			}
			if (cell && cell.f > 0) {
				totalObserved += cell.f;
				sumF += cell.f;
				sumLatF += cell.f * (band + 5); // centroid of the 10° band
				if (cell.f > maxF) {
					maxF = cell.f;
					peakBand = band;
				}
			}
		}
		const avgLat = sumF > 0 ? sumLatF / sumF : peakBand + 5;
		monthlyPeaks.push({ month: m + 1, band: peakBand, maxF, avgLat });
	}

	if (totalObserved === 0) {
		return {
			hasData: false,
			headline: 'Seasonal Distribution',
			details: 'Survey data in this region is limited or the species has zero recorded sightings.',
			span: null
		};
	}

	const observed = monthlyPeaks.filter((p) => p.maxF > 0);
	if (observed.length === 0) {
		return {
			hasData: false,
			headline: 'Seasonal Distribution',
			details: 'Survey data in this region is limited or the species has zero recorded sightings.',
			span: null
		};
	}

	// Guard against sparse / single-month data making unsupported annual claims (CODEX1 Blocker 2)
	if (observed.length === 1) {
		const p = observed[0];
		const landmark = landmarkFor(p.band, col) ?? bandLabel(p.band);
		return {
			hasData: true,
			headline: 'Sparse Seasonal Data',
			details: `Reported only in ${MONTHS[p.month - 1]}, centered around ${landmark}. Additional survey data needed to determine annual range.`,
			span: 'Recorded in 1 of 12 months'
		};
	}

	if (observed.length < 4) {
		const monthsStr = formatWindow(observed.map((p) => p.month));
		const sorted = [...observed].sort((a, b) => b.avgLat - a.avgLat);
		const northPeak = sorted[0];
		const landmark = landmarkFor(northPeak.band, col) ?? bandLabel(northPeak.band);
		return {
			hasData: true,
			headline: 'Limited Seasonal Data',
			details: `Reported in ${monthsStr}, centered near ${landmark}. Data across other months is currently insufficient to establish an annual migration pattern.`,
			span: `Recorded in ${observed.length} of 12 months`
		};
	}

	const sorted = [...observed].sort((a, b) => b.avgLat - a.avgLat);
	const northPeak = sorted[0];
	const southPeak = sorted[sorted.length - 1];
	const deltaLat = northPeak.avgLat - southPeak.avgLat;

	if (deltaLat < 8) {
		const landmark = landmarkFor(northPeak.band, col) ?? bandLabel(northPeak.band);
		if (observed.length === 12) {
			return {
				hasData: true,
				headline: 'Year-Round Presence',
				details: `Reported with little latitudinal shift through the year, centered around ${landmark}.`,
				span: 'Consistent year-round range'
			};
		}
		return {
			hasData: true,
			headline: 'Stationary Occurrence',
			details: `Reported across ${observed.length} months with little latitudinal shift, centered around ${landmark}.`,
			span: `Recorded in ${observed.length} of 12 months`
		};
	}

	// Group months near northern and southern extremes (within 5 degrees of peak avgLat)
	const northMonths = observed
		.filter((p) => p.avgLat >= northPeak.avgLat - 5)
		.map((p) => p.month);
	const southMonths = observed
		.filter((p) => p.avgLat <= southPeak.avgLat + 5)
		.map((p) => p.month);

	const northStr = formatWindow(northMonths);
	const southStr = formatWindow(southMonths);
	const northLandmark = landmarkFor(northPeak.band, col) ?? bandLabel(northPeak.band);
	const southLandmark = landmarkFor(southPeak.band, col) ?? bandLabel(southPeak.band);
	const span =
		observed.length === 12
			? `${Math.round(deltaLat)}° latitudinal shift across the year`
			: `${Math.round(deltaLat)}° latitudinal shift (${observed.length}/12 months observed)`;

	return {
		hasData: true,
		headline: 'Seasonal Latitudinal Shift',
		details: `Reported furthest north in ${northStr} (${northLandmark}); furthest south in ${southStr} (${southLandmark}).`,
		span
	};
}


// ---------------------------------------------------------------------------
// Client-duplicated data shapes (structurally equal to $server/ribbon's;
// never imported from there — FrequencyChart.svelte precedent).
// ---------------------------------------------------------------------------

export type Weighting = 'equal' | 'checklists';

export interface RibbonCellClient {
	/** For `state: 'thin'` this is a placeholder 0, NEVER a real rate — no
	 * country reached LOW_N under equal weight, so nothing voted (server
	 * contract change, TD-B deploy gate). */
	f: number;
	/** Σ checklists surveyed, even for a 'thin' cell. */
	n: number;
	/** 'thin': surveyed (some country had checklists) but under equal weight
	 * no country reached LOW_N, so no country voted. Distinct from `null`
	 * ("nothing loaded here") — a thin cell IS data, just not a rate. */
	state: 'reported' | 'zero' | 'thin';
	low: boolean;
	excluded: number;
}
export type RibbonCellOrNullClient = RibbonCellClient | null;

export interface RibbonModeClient {
	/** [bandIndex][columnIndex][month-1] */
	cols: RibbonCellOrNullClient[][][];
	/** [bandIndex][month-1] */
	world: RibbonCellOrNullClient[][];
}

export interface RibbonGridClient {
	speciesCode: string;
	modes: Record<Weighting, RibbonModeClient>;
	/** [bandIndex][columnIndex] — the readout's "N regions" (CC1 post-review:
	 * this drives the count, never the drill's fetched row list). */
	regionCounts: number[][];
	gapMonths: number[];
	meta: {
		regions: number;
		countries: number;
		columnsLoaded: RibbonColumn[];
		columnsMissing: RibbonColumn[];
		unmappedCountries: string[];
	};
}

export interface RibbonMonthStat {
	month: number;
	freq: number;
	n: number;
}
export interface RibbonWeekStat {
	week: number;
	freq: number;
	n: number;
}
export interface RibbonBestMonth {
	month: number;
	freq: number;
	n: number;
	lowSample: boolean;
}

export interface RibbonRegionRowClient {
	locCode: string;
	label: string;
	country: string;
	column: RibbonColumn;
	band: number;
	curve: RibbonMonthStat[];
	weeks: RibbonWeekStat[];
	peak: number;
	best: RibbonBestMonth | null;
	peakPhrase: string | null;
	good: number[];
	migration: string | null;
}
export interface RibbonRegionsClient {
	rows: RibbonRegionRowClient[];
	total: number;
	capped: boolean;
}

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

export interface RibbonState {
	view: 'world' | 'cont';
	/** The continent PICKER: 'ALL' draws every column, a key draws one
	 * full-width grid. */
	contView: 'ALL' | RibbonColumn;
	/** The continent of the SELECTED cell (readout/drill). */
	cont: RibbonColumn | null;
	weight: Weighting;
	band: number;
	month: number;
	playing: boolean;
	/** Once true, `applyWide` stops overriding the user's own view choice. */
	viewTouched: boolean;
	drillExpanded: boolean;
	drillOpen: boolean;
	fullGlobe?: boolean;
}

/** wide: cont/ALL/NAE (By continent, All continents, home column selected).
 * phone: world/NAE/null (World view; NAE stays queued as the continent
 * picker's remembered value in case the user switches). Band 40, month 7
 * (owner decision C, mockup `state`). */
export function initialState(wide: boolean): RibbonState {
	return {
		view: wide ? 'cont' : 'world',
		contView: wide ? 'ALL' : HOME_COLUMN,
		cont: wide ? HOME_COLUMN : null,
		weight: 'equal',
		band: 40,
		month: 7,
		playing: false,
		viewTouched: false,
		drillExpanded: false,
		drillOpen: true,
		fullGlobe: false
	};
}

/** No-op once the user has touched the view toggle (mockup `applyWide`). */
export function applyWide(s: RibbonState, wide: boolean): RibbonState {
	if (s.viewTouched) return s;
	return {
		...s,
		view: wide ? 'cont' : 'world',
		contView: wide ? 'ALL' : HOME_COLUMN,
		cont: wide ? (s.cont ?? HOME_COLUMN) : null
	};
}

/** Continents currently drawn: none in World view, all or one in By continent. */
export function drawnColumns(s: RibbonState): RibbonColumn[] {
	if (s.view !== 'cont') return [];
	return s.contView === 'ALL' ? [...COLUMNS] : [s.contView];
}

export interface RibbonGeometry {
	cont: boolean;
	single: boolean;
	cols: number;
	cellW: number;
	rowH: number;
	headH: number;
	w: number;
	h: number;
}

/**
 * `availWidth` is the already-padding-adjusted width available to the SVG
 * (the caller passes `rscroll.clientWidth - 12`, matching the mockup's
 * `geom()`); this stays a pure function of that number so it is unit
 * testable with no DOM.
 *
 * `phone` (below 640px, sampled independently from `wide` — spec rev 3.3
 * TD-C, P1-1) drives row height on its own: below 640px every view gets the
 * 48px touch row (cs.md, owner decision, CODEX1 P1-7), and everything
 * 640px and up — tablet (`wide` false) or desktop (`wide` true) — gets the
 * compact 22px row with full cell picking. `wide` still separately governs
 * layout (cell width, header height) via `drawnColumns`/`cont`.
 */
export function geometry(
	s: RibbonState,
	availWidth: number,
	wide: boolean,
	phone: boolean,
	bands: readonly number[] = BANDS
): RibbonGeometry {
	const avail = Math.max(120, availWidth);
	const cont = s.view === 'cont';
	const conts = drawnColumns(s);
	const single = cont && conts.length === 1;
	const cols = cont ? conts.length * 12 : 12;
	const cellW = cont && !single ? Math.max(6, avail / cols) : Math.max(11, Math.min(avail / cols, 44));
	const rowH = phone ? ROW_H_TOUCH : ROW_H;
	const headH = cont ? 34 : 20;
	const w = cols * cellW;
	const h = headH + bands.length * rowH;
	return { cont, single, cols, cellW, rowH, headH, w, h };
}

/** The cell the current selection resolves to, or null when nothing is
 * loaded there. Reads the precomputed grid — never recomputes an average. */
export function cellAt(grid: RibbonGridClient, s: RibbonState): RibbonCellOrNullClient {
	const b = BANDS.indexOf(s.band as (typeof BANDS)[number]);
	if (b < 0) return null;
	const mode = grid.modes[s.weight];
	if (s.view === 'cont' && s.cont) {
		const c = COLUMNS.indexOf(s.cont);
		if (c < 0) return null;
		return mode.cols[b]?.[c]?.[s.month - 1] ?? null;
	}
	return mode.world[b]?.[s.month - 1] ?? null;
}

/** Region count for the readout — from `regionCounts`, never the drill's
 * fetched rows (CC1 post-review check). */
function regionCountFor(grid: RibbonGridClient, s: RibbonState): number {
	const b = BANDS.indexOf(s.band as (typeof BANDS)[number]);
	if (b < 0) return 0;
	if (s.view === 'cont' && s.cont) {
		const c = COLUMNS.indexOf(s.cont);
		return c < 0 ? 0 : (grid.regionCounts[b]?.[c] ?? 0);
	}
	return (grid.regionCounts[b] ?? []).reduce((a, x) => a + x, 0);
}

// ---------------------------------------------------------------------------
// Keyboard reducer (mockup `document.getElementById('ribbon').addEventListener`)
// ---------------------------------------------------------------------------

export type Key =
	| 'ArrowLeft'
	| 'ArrowRight'
	| 'ArrowUp'
	| 'ArrowDown'
	| 'PageUp'
	| 'PageDown'
	| 'Home'
	| 'End'
	| 'Enter'
	| ' ';

function pageContinent(s: RibbonState, dir: 1 | -1): RibbonState {
	if (s.view !== 'cont') return s;
	const ci = s.cont ? COLUMNS.indexOf(s.cont) : 0;
	const ni = Math.max(0, Math.min(COLUMNS.length - 1, ci + dir));
	const cont = COLUMNS[ni];
	// One-continent mode: paging also moves the picker (mockup comment).
	const contView = s.contView !== 'ALL' ? cont : s.contView;
	return { ...s, cont, contView };
}

/**
 * Pure keyboard reducer. `null` for an unrecognized key (the caller does not
 * call `preventDefault`); an `action: 'openDrill'` result additionally asks
 * the caller to open the drill `<details>` and scroll to it.
 */
export function reduce(
	s: RibbonState,
	key: Key,
	bands: readonly number[] = BANDS
): { state: RibbonState; action?: 'openDrill' } | null {
	const bi = Math.max(0, bands.indexOf(s.band as (typeof BANDS)[number]));
	switch (key) {
		case 'ArrowLeft':
			return { state: { ...s, month: s.month === 1 ? 12 : s.month - 1, playing: false } };
		case 'ArrowRight':
			return { state: { ...s, month: (s.month % 12) + 1, playing: false } };
		case 'ArrowUp':
			return { state: { ...s, band: bands[Math.max(0, bi - 1)] } };
		case 'ArrowDown':
			return { state: { ...s, band: bands[Math.min(bands.length - 1, bi + 1)] } };
		case 'PageUp':
			return { state: pageContinent(s, -1) };
		case 'PageDown':
			return { state: pageContinent(s, 1) };
		case 'Home':
			return { state: { ...s, month: 1, playing: false } };
		case 'End':
			return { state: { ...s, month: 12, playing: false } };
		case 'Enter':
			return { state: { ...s, drillOpen: true }, action: 'openDrill' };
		case ' ':
			return { state: { ...s, playing: !s.playing } };
		default:
			return null;
	}
}

/** The slider / ◀ / ▶ controls set an arbitrary month directly (mockup
 * `setMonth`) and always stop Play, same as a keyboard month change. */
export function setMonth(s: RibbonState, month: number): RibbonState {
	return { ...s, month, playing: false };
}

// ---------------------------------------------------------------------------
// Pointer picking (mockup `pick()`)
// ---------------------------------------------------------------------------

/**
 * Resolve an (x, y) point inside the chart to a new selection, or `null`
 * outside the grid. Selection fires on `pointerup` only after < 8px of
 * pointer travel (cs.md + CODEX1 P1-7) — that threshold check happens in the
 * component; this function is the pure hit-test.
 *
 * `bandOnly` (spec rev 3.3 TD-C, P1-1 — the phone contract): below 640px
 * cells are not tap targets. The scrubber owns the month, so `y` resolves
 * the band and `s.month` passes through UNCHANGED; `x` resolves a continent
 * only in All-continents mode (12-cell column groups, ≥72px each — an
 * acceptable target), stays `null` in World, and is the single continent in
 * single-continent mode. A 48px band row (`geometry(..., phone=true)`) is
 * what makes "tap anywhere in the row" viable.
 */
export function pickCell(
	s: RibbonState,
	geom: Pick<RibbonGeometry, 'cont' | 'rowH' | 'cellW' | 'headH' | 'cols'>,
	x: number,
	y: number,
	bandOnly = false,
	bands: readonly number[] = BANDS
): RibbonState | null {
	const bi = Math.floor((y - geom.headH) / geom.rowH);
	if (bi < 0 || bi >= bands.length) return null;
	const band = bands[bi];
	const conts = drawnColumns(s);

	if (bandOnly) {
		let cont: RibbonColumn | null = null;
		if (geom.cont) {
			if (conts.length === 1) {
				cont = conts[0];
			} else {
				const col = Math.max(0, Math.min(geom.cols - 1, Math.floor(x / geom.cellW)));
				const ci = Math.floor(col / 12);
				cont = conts[ci] ?? conts[conts.length - 1] ?? null;
			}
		}
		return { ...s, band, cont, playing: false, drillExpanded: false };
	}

	const col = Math.floor(x / geom.cellW);
	if (col < 0 || col >= geom.cols) return null;
	const cont = geom.cont ? (conts[Math.floor(col / 12)] ?? null) : null;
	const month = (col % 12) + 1;
	return { ...s, band, cont, month, playing: false, drillExpanded: false };
}

// ---------------------------------------------------------------------------
// Readout (mockup `renderReadout`, minus preview; P2-2's excluded-countries
// branch; copy verbatim from the mockup)
// ---------------------------------------------------------------------------

export interface Readout {
	line1: string;
	line2: string;
	line3: string;
	title3?: string;
	nreg: number;
	empty: boolean;
	landmark?: string | null;
}

export function readout(grid: RibbonGridClient, s: RibbonState): Readout {
	const cell = cellAt(grid, s);
	const nreg = regionCountFor(grid, s);
	const line1 = `${bandLabel(s.band)} · ${s.cont ? COLUMN_NAMES[s.cont] : 'All continents'} · ${
		MSHORT[s.month - 1]
	}`;
	const regs = `${nreg} region${nreg === 1 ? '' : 's'}`;
	const landmark = landmarkFor(s.band, s.cont);

	if (!cell) {
		return { line1, line2: 'No data — nothing loaded here', line3: '', nreg, empty: true, landmark };
	}
	if (cell.state === 'thin') {
		// Surveyed, but no country reached LOW_N under equal weight, so `f` is a
		// placeholder and must never be printed as a rate (TD-B deploy gate).
		return {
			line1,
			line2: 'Surveyed — too few checklists to rate',
			line3: `${cell.excluded} countr${cell.excluded === 1 ? 'y' : 'ies'} under ${LOW_N} checklists · ${regs} · ${compact(cell.n)} checklists`,
			title3: `${fmtN(cell.n)} checklists`,
			nreg,
			empty: false,
			landmark
		};
	}
	// Branch on the SERVER's `low`, never on raw `n` (CC1 P2-2): under
	// 'checklists', classify() sets `low` only when `f > 0 && n < LOW_N`, so
	// a genuinely zero cell (`low` always false there) falls through to the
	// "0% — surveyed" branch below instead of being misreported as a small
	// sample. No `state !== 'thin'` guard needed here — TS already knows
	// `cell.state` excludes 'thin' after the early return above (thin only
	// ever occurs under 'equal' weighting anyway).
	if (s.weight === 'checklists' && cell.low) {
		return {
			line1,
			line2: `${pct(cell.f)} reporting rate · small sample`,
			line3: `${regs} · ${compact(cell.n)} checklists`,
			title3: `${fmtN(cell.n)} checklists`,
			nreg,
			empty: false,
			landmark
		};
	}
	if (s.weight === 'equal' && cell.excluded > 0) {
		return {
			line1,
			line2: `${pct(cell.f)} average reporting rate · small sample`,
			line3: `${cell.excluded} countr${cell.excluded === 1 ? 'y' : 'ies'} under ${LOW_N} checklists left out · ${regs} · ${compact(cell.n)} checklists`,
			title3: `${fmtN(cell.n)} checklists`,
			nreg,
			empty: false,
			landmark
		};
	}
	if (cell.f === 0) {
		return {
			line1,
			line2: '0% — surveyed, no reports',
			line3: `${regs} · ${compact(cell.n)} checklists`,
			title3: `${fmtN(cell.n)} checklists`,
			nreg,
			empty: false,
			landmark
		};
	}
	if (s.weight === 'equal') {
		return {
			line1,
			line2: `${pct(cell.f)} average reporting rate`,
			line3: `equal weight · ${regs} · ${compact(cell.n)} checklists`,
			title3: `${fmtN(cell.n)} checklists`,
			nreg,
			empty: false,
			landmark
		};
	}
	return {
		line1,
		line2: `${pct(cell.f)} of checklists reported it`,
		line3: `${regs} · ${compact(cell.n)} checklists`,
		title3: `${fmtN(cell.n)} checklists`,
		nreg,
		empty: false,
		landmark
	};
}

// ---------------------------------------------------------------------------
// Chart aria-label (mockup `chartAria`, fixed to read over the DRAWN view —
// CODEX1 P2-3 — instead of always the world row)
// ---------------------------------------------------------------------------

export function chartAria(grid: RibbonGridClient, s: RibbonState, speciesName: string): string {
	const mode = grid.modes[s.weight];
	const cols = drawnColumns(s);
	const cellsIn = (b: number, m: number): RibbonCellClient[] => {
		if (s.view === 'cont') {
			return cols
				.map((c) => mode.cols[b]?.[COLUMNS.indexOf(c)]?.[m] ?? null)
				.filter((c): c is RibbonCellClient => c != null);
		}
		const c = mode.world[b]?.[m] ?? null;
		return c ? [c] : [];
	};
	let peak: { f: number; band: number | null; month: number } = { f: 0, band: null, month: 0 };
	let occupied = 0;
	// A 'thin' cell is surveyed but has no ratable `f` — it counts as neither
	// reported nor absent (TD-B deploy gate contract change) and never sets
	// the peak.
	let thinOnly = 0;
	for (let b = 0; b < BANDS.length; b++) {
		let hit = false;
		let sawThin = false;
		for (let m = 0; m < 12; m++) {
			for (const c of cellsIn(b, m)) {
				if (c.state === 'thin') {
					sawThin = true;
					continue;
				}
				if (c.f >= PRESENT) hit = true;
				if (c.f > peak.f) peak = { f: c.f, band: BANDS[b], month: m };
			}
		}
		if (hit) occupied++;
		else if (sawThin) thinOnly++;
	}
	let out = `${speciesName}, latitude bands${s.view === 'cont' ? ' by continent' : ''}: reported in ${occupied} of ${BANDS.length} bands`;
	if (thinOnly > 0) out += `, ${thinOnly} surveyed but too thin to rate`;
	if (peak.band !== null) out += `, strongest ${bandLabel(peak.band)} in ${MONTHS[peak.month]} at ${pct(peak.f)}`;
	return `${out}.`;
}

// ---------------------------------------------------------------------------
// Scope caption, gap note (mockup `renderScope` / `renderGap`, minus preview)
// ---------------------------------------------------------------------------

export function scopeText(meta: RibbonGridClient['meta'], weight: Weighting): string {
	const loadedNames = meta.columnsLoaded.map((c) => COLUMN_NAMES[c]).join(', ');
	const missingNames = meta.columnsMissing.map((c) => COLUMN_NAMES[c]);
	let s = `Loaded: ${meta.regions} regions in ${meta.countries} countries across ${meta.columnsLoaded.length} continents (${loadedNames}). `;
	if (missingNames.length > 0) {
		s += `Nothing loaded yet for ${missingNames.join(' or ')}, so those columns read "no data", not "absent". `;
	}
	s +=
		'North America is drawn as two columns, west and east of 100°W, because one column blurred the Atlantic coast with the empty interior. ';
	s +=
		'Each region counts in the band of its centre point, so a very tall region sits in one band only — Nunavut spans 32 degrees of latitude. ';
	s +=
		'Colour follows how often birders report a species, which also rises and falls with how easy it is to see and hear, so a band can dim without the bird going anywhere. ';
	s +=
		weight === 'equal'
			? 'Equal weight: each country counts once inside its continent, and each continent counts once in the world rows. Regions inside one country are still weighted by checklists, so where a continent has only one country loaded its busiest region still dominates that column.'
			: 'By checklists: every checklist counts equally, so the figures follow where people bird. Florida alone is about 72% of all checklists in the 20–30°N band.';
	return s;
}

/** Same run-detection algorithm as FrequencyChart's `formatMonthWindow`
 * (`:115-128`), extended to a single month (a one-month gap still needs a
 * label) — `gapText` handles the full 12-month case separately. */
export function formatWindow(ms: number[]): string {
	if (ms.length === 0) return '';
	if (ms.length === 1) return MSHORT[ms[0] - 1];
	const set = new Set(ms);
	const starts = ms.filter((m) => !set.has(m === 1 ? 12 : m - 1));
	if (starts.length !== 1) return ms.map((m) => MSHORT[m - 1]).join(', ');
	const start = starts[0];
	let end = start;
	for (let i = 0; i < 11; i++) {
		const next = end === 12 ? 1 : end + 1;
		if (!set.has(next)) break;
		end = next;
	}
	return `${MSHORT[start - 1]}–${MSHORT[end - 1]}`;
}

/** `null` when there is no gap. The all-year case gets its own copy (CODEX1
 * P2-9) instead of a 12-name list. */
export function gapText(gapMonths: number[]): { window: string; text: string } | null {
	if (gapMonths.length === 0) return null;
	if (gapMonths.length === 12) {
		return { window: 'Year-round', text: 'below 0.5% of checklists in every loaded region all year' };
	}
	return { window: formatWindow(gapMonths), text: 'below 0.5% of checklists in every loaded region.' };
}

/** 'Inside 40–50°N, North America, east of 100°W' */
export function drillHeading(s: RibbonState): string {
	const where = bandLabel(s.band) + (s.cont ? `, ${COLUMN_NAMES[s.cont]}` : '');
	return `Inside ${where}`;
}

/** 'url(#…)' for a hatched cell — low-sample, excluded countries, or a
 * 'thin' cell (surveyed but nothing voted; `f` is a placeholder there and
 * MUST NOT reach `binIndex` — TD-B deploy gate) — a `--rb-N` token for a
 * normal one, or the sentinel `'slash'` for nothing-loaded (rendered as a
 * white cell with a diagonal slash, never a color — CODEX1 P1). */
export function fillFor(cell: RibbonCellOrNullClient, hatchId: string): string {
	if (!cell) return 'slash';
	if (cell.low || cell.state === 'thin') return `url(#${hatchId})`;
	return `var(--rb-${binIndex(cell.f)})`;
}

// ---------------------------------------------------------------------------
// Drill fetch coordination — pure, so the generation-guard / abort / !ok
// wiring (CODEX1 P2-4, P2-11) is unit-testable without a real fetch or DOM.
// ---------------------------------------------------------------------------

/** Monotonic request generation so a late response for a superseded
 * selection can never overwrite a newer one (CODEX1 P2-4). */
export class DrillGeneration {
	#current = 0;
	start(): number {
		this.#current += 1;
		return this.#current;
	}
	isCurrent(gen: number): boolean {
		return gen === this.#current;
	}
}

export type DrillLoadResult =
	| { kind: 'data'; regions: RibbonRegionsClient }
	| { kind: 'error'; message: string }
	/** Aborted, or superseded by a newer selection before it resolved —
	 * either way the caller does nothing (CODEX1 P2-4/P2-11). */
	| { kind: 'ignore' };

/** The inline error copy shown when the drill fetch's response is not ok. */
export const DRILL_ERROR_MESSAGE = 'Could not load the regions for this cell.';

/**
 * Decide what a settled drill fetch means, given the request's generation at
 * the time it fired. `aborted` covers both an explicit `AbortError` and a
 * fetch the caller chose not to await further.
 */
export function resolveDrillLoad(params: {
	gen: number;
	generation: DrillGeneration;
	aborted: boolean;
	ok: boolean;
	regions?: RibbonRegionsClient;
}): DrillLoadResult {
	if (params.aborted) return { kind: 'ignore' };
	if (!params.generation.isCurrent(params.gen)) return { kind: 'ignore' };
	if (!params.ok) return { kind: 'error', message: DRILL_ERROR_MESSAGE };
	return { kind: 'data', regions: params.regions as RibbonRegionsClient };
}

/** `band|cont` cache key (mockup precedent: one key per drill cell). */
export function drillCacheKey(band: number, cont: RibbonColumn | 'ALL'): string {
	return `${band}|${cont}`;
}

export type DrillBeginResult =
	| { kind: 'cached'; regions: RibbonRegionsClient }
	| { kind: 'fetch'; gen: number };

/**
 * The one entry point for "the selected drill cell changed" (CODEX1 P1-2).
 * ALWAYS bumps the generation FIRST, even on a cache hit — a cache hit
 * still means the selection changed, so any fetch still in flight for the
 * PREVIOUS cell must become stale immediately. Without this, returning
 * early from a cache branch before bumping let an in-flight fetch for cell
 * A settle (its `resolveDrillLoad` still seeing its own gen as "current")
 * after cell B had already been served from cache, overwriting B's rows
 * under B's heading.
 */
export function beginDrill(
	key: string,
	cache: ReadonlyMap<string, RibbonRegionsClient>,
	generation: DrillGeneration
): DrillBeginResult {
	const gen = generation.start();
	const cached = cache.get(key);
	if (cached) return { kind: 'cached', regions: cached };
	return { kind: 'fetch', gen };
}

/** Insert into a Map, evicting the oldest entry first once `maxSize` would be
 * exceeded (CODEX1 P2-4: the regions cache must be bounded). Map iteration
 * order is insertion order, so the first key is the oldest. */
export function boundedCacheSet<K, V>(cache: Map<K, V>, key: K, value: V, maxSize = 32): void {
	if (!cache.has(key) && cache.size >= maxSize) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, value);
}
