/**
 * Pure unit coverage for the migration ribbon's client logic (td-59c2d0
 * build spec, TD-C). Every case here is the spec's own numeric/string
 * oracle, copied verbatim where the spec pins exact copy. No DOM, no
 * component render (this repo has no component-render harness) — event
 * wiring is exercised through the pure reducers the component calls
 * (`reduce`, `setMonth`, `pickCell`, `resolveDrillLoad`), never through a
 * simulated DOM event.
 */
import { describe, expect, it } from 'vitest';
import {
	BANDS,
	COLUMNS,
	DRILL_ERROR_MESSAGE,
	DrillGeneration,
	LOW_N,
	applyWide,
	bandLabel,
	binIndex,
	chartAria,
	compact,
	drillHeading,
	fillFor,
	formatWindow,
	gapText,
	geometry,
	initialState,
	pct,
	pickCell,
	readout,
	reduce,
	resolveDrillLoad,
	scopeText,
	setMonth,
	type RibbonCellClient,
	type RibbonGridClient,
	type RibbonRegionsClient,
	type RibbonState
} from './migration-ribbon';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function bandIndex(band: number): number {
	return (BANDS as readonly number[]).indexOf(band);
}
function colIndex(col: (typeof COLUMNS)[number]): number {
	return (COLUMNS as readonly string[]).indexOf(col);
}

function emptyGrid(speciesCode = 'testsp'): RibbonGridClient {
	const cols = () => BANDS.map(() => COLUMNS.map(() => Array(12).fill(null)));
	const world = () => BANDS.map(() => Array(12).fill(null));
	return {
		speciesCode,
		modes: {
			equal: { cols: cols(), world: world() },
			checklists: { cols: cols(), world: world() }
		},
		regionCounts: BANDS.map(() => COLUMNS.map(() => 0)),
		gapMonths: [],
		meta: {
			regions: 0,
			countries: 0,
			columnsLoaded: [],
			columnsMissing: [...COLUMNS],
			unmappedCountries: []
		}
	};
}

function baseState(overrides: Partial<RibbonState> = {}): RibbonState {
	return { ...initialState(false), ...overrides };
}

// ---------------------------------------------------------------------------
// binIndex / pct — exclusive upper bounds pinned with pct labels (P2-6)
// ---------------------------------------------------------------------------

describe('binIndex / pct (exclusive upper bounds, CODEX1 P2-6)', () => {
	const cases: [number, number, string][] = [
		[0, 0, '0%'],
		[0.0099, 1, '<1%'],
		[0.01, 2, '1%'],
		[0.0299, 2, '3%'],
		[0.03, 3, '3%'],
		[0.0999, 3, '10%'],
		[0.1, 4, '10%'],
		[0.2499, 4, '25%'],
		[0.25, 5, '25%']
	];
	for (const [f, expectedBin, expectedPct] of cases) {
		it(`f=${f} -> bin ${expectedBin}, pct ${expectedPct}`, () => {
			expect(binIndex(f)).toBe(expectedBin);
			expect(pct(f)).toBe(expectedPct);
		});
	}
});

describe('compact', () => {
	it('1.2M | 96K | 1,017', () => {
		expect(compact(1_200_000)).toBe('1.2M');
		expect(compact(96_000)).toBe('96K');
		expect(compact(1017)).toBe('1,017');
	});
});

describe('bandLabel', () => {
	it("40–50°N | 30–40°S", () => {
		expect(bandLabel(40)).toBe('40–50°N');
		expect(bandLabel(-40)).toBe('30–40°S');
	});
});

// ---------------------------------------------------------------------------
// fillFor
// ---------------------------------------------------------------------------

describe('fillFor', () => {
	it('a low-sample cell fills with the hatch pattern', () => {
		const cell: RibbonCellClient = { f: 0.2, n: 39, state: 'reported', low: true, excluded: 0 };
		expect(fillFor(cell, 'h1')).toBe('url(#h1)');
	});
	it('a normal cell fills with its bin token', () => {
		const cell: RibbonCellClient = { f: 0, n: 39, state: 'zero', low: false, excluded: 0 };
		expect(fillFor(cell, 'h1')).toBe('var(--rb-0)');
	});
	it('null (nothing loaded) is the slash sentinel', () => {
		expect(fillFor(null, 'h1')).toBe('slash');
	});
	it("a 'thin' cell hatches too, and never touches binIndex (TD-B deploy gate)", () => {
		const cell: RibbonCellClient = { f: 0, n: 200, state: 'thin', low: true, excluded: 2 };
		expect(fillFor(cell, 'h1')).toBe('url(#h1)');
		expect(fillFor(cell, 'h1')).not.toContain('--rb-');
	});
});

// ---------------------------------------------------------------------------
// readout — branches, copied verbatim from the mockup
// ---------------------------------------------------------------------------

describe('readout', () => {
	const b = bandIndex(40);
	const state = baseState({ view: 'world', cont: null, band: 40, month: 1, weight: 'equal' });

	it('null -> "No data — nothing loaded here"', () => {
		const grid = emptyGrid();
		const r = readout(grid, state);
		expect(r.empty).toBe(true);
		expect(r.line2).toBe('No data — nothing loaded here');
		expect(r.line3).toBe('');
	});

	it('low (n<40) -> "20% reporting rate · small sample"', () => {
		const grid = emptyGrid();
		grid.modes.equal.world[b][0] = { f: 0.2, n: 20, state: 'reported', low: true, excluded: 0 };
		const r = readout(grid, state);
		expect(r.line2).toBe('20% reporting rate · small sample');
	});

	it('zero -> "0% — surveyed, no reports"', () => {
		const grid = emptyGrid();
		grid.modes.equal.world[b][0] = { f: 0, n: 500, state: 'zero', low: false, excluded: 0 };
		const r = readout(grid, state);
		expect(r.line2).toBe('0% — surveyed, no reports');
	});

	it('equal -> "16% average reporting rate", never "of checklists"', () => {
		const grid = emptyGrid();
		grid.modes.equal.world[b][0] = {
			f: 0.161167,
			n: 439972,
			state: 'reported',
			low: false,
			excluded: 0
		};
		grid.regionCounts[b] = COLUMNS.map((c) => (c === 'NAW' || c === 'NAE' ? 1 : 0));
		const r = readout(grid, state);
		expect(r.line2).toBe('16% average reporting rate');
		expect(r.line3).toBe('equal weight · 2 regions · 440K checklists');
		expect(r.title3).toBe('439,972 checklists');
		expect(r.line2).not.toContain('of checklists');
	});

	it('checklists -> "24% of checklists reported it"', () => {
		const grid = emptyGrid();
		grid.modes.checklists.world[b][0] = {
			f: 0.2408,
			n: 439972,
			state: 'reported',
			low: false,
			excluded: 0
		};
		const r = readout(grid, { ...state, weight: 'checklists' });
		expect(r.line2).toBe('24% of checklists reported it');
	});

	it("equal + excluded>0 -> the small-sample-with-exclusions line (P2-2)", () => {
		const grid = emptyGrid();
		grid.modes.equal.world[b][0] = { f: 0.15, n: 300, state: 'reported', low: true, excluded: 1 };
		grid.regionCounts[b] = COLUMNS.map((c) => (c === 'NAE' ? 3 : 0));
		const r = readout(grid, state);
		expect(r.line2).toBe('15% average reporting rate · small sample');
		expect(r.line3).toBe('1 country under 40 checklists left out · 3 regions · 300 checklists');
	});

	it("'thin' -> surveyed-but-unratable copy, f is never printed as a rate (TD-B deploy gate)", () => {
		const grid = emptyGrid();
		grid.modes.equal.world[b][0] = { f: 0, n: 200, state: 'thin', low: true, excluded: 2 };
		grid.regionCounts[b] = COLUMNS.map((c) => (c === 'NAE' ? 5 : 0));
		const r = readout(grid, state);
		expect(r.line2).toBe('Surveyed — too few checklists to rate');
		expect(r.line3).toBe('2 countries under 40 checklists · 5 regions · 200 checklists');
		expect(r.line2).not.toContain('%');
	});
});

// ---------------------------------------------------------------------------
// reduce — keyboard state machine
// ---------------------------------------------------------------------------

describe('reduce', () => {
	it('ArrowLeft at month 1 wraps to 12 and stops Play', () => {
		const s = baseState({ month: 1, playing: true });
		const res = reduce(s, 'ArrowLeft')!;
		expect(res.state.month).toBe(12);
		expect(res.state.playing).toBe(false);
	});
	it('ArrowRight at month 12 wraps to 1', () => {
		const s = baseState({ month: 12 });
		expect(reduce(s, 'ArrowRight')!.state.month).toBe(1);
	});
	it('ArrowUp at the top band (80) stays', () => {
		const s = baseState({ band: 80 });
		expect(reduce(s, 'ArrowUp')!.state.band).toBe(80);
	});
	it('ArrowDown at the bottom band (-90) stays', () => {
		const s = baseState({ band: -90 });
		expect(reduce(s, 'ArrowDown')!.state.band).toBe(-90);
	});
	it('PageDown in World view is a no-op (state unchanged)', () => {
		const s = baseState({ view: 'world', cont: null });
		expect(reduce(s, 'PageDown')!.state).toEqual(s);
	});
	it('PageDown in single-continent mode moves cont AND contView', () => {
		const s = baseState({ view: 'cont', contView: 'NAE', cont: 'NAE' });
		const res = reduce(s, 'PageDown')!.state;
		expect(res.cont).toBe('SA');
		expect(res.contView).toBe('SA');
	});
	it('Home / End jump to Jan / Dec and stop Play', () => {
		const s = baseState({ month: 6, playing: true });
		expect(reduce(s, 'Home')!.state).toMatchObject({ month: 1, playing: false });
		expect(reduce(s, 'End')!.state).toMatchObject({ month: 12, playing: false });
	});
	it('Space toggles playing', () => {
		const s = baseState({ playing: false });
		expect(reduce(s, ' ')!.state.playing).toBe(true);
	});
	it('Enter opens the drill', () => {
		const s = baseState({ drillOpen: false });
		const res = reduce(s, 'Enter')!;
		expect(res.state.drillOpen).toBe(true);
		expect(res.action).toBe('openDrill');
	});
	it('an unrecognized key is null', () => {
		expect(reduce(baseState(), 'Tab' as never)).toBeNull();
	});
});

describe('setMonth (slider / ◀ / ▶) — always stops Play', () => {
	it('sets an arbitrary month and clears playing', () => {
		const s = baseState({ month: 1, playing: true });
		const res = setMonth(s, 9);
		expect(res.month).toBe(9);
		expect(res.playing).toBe(false);
	});
});

describe('pickCell (pointer hit-test) — a cell/row tap stops Play', () => {
	it('resolves a world-view tap to its band/month and clears playing', () => {
		const s = baseState({ view: 'world', cont: null, playing: true });
		const geom = { cont: false, rowH: 22, cellW: 25, headH: 20, cols: 12 };
		// Row 2 (band index 2 -> BANDS[2] = 60), month column 3 (index 2 -> month 3).
		const res = pickCell(s, geom, 2 * 25 + 1, 20 + 2 * 22 + 1)!;
		expect(res.band).toBe(BANDS[2]);
		expect(res.month).toBe(3);
		expect(res.playing).toBe(false);
		expect(res.drillExpanded).toBe(false);
	});
	it('outside the grid is null', () => {
		const s = baseState();
		const geom = { cont: false, rowH: 22, cellW: 25, headH: 20, cols: 12 };
		expect(pickCell(s, geom, -5, 30)).toBeNull();
		expect(pickCell(s, geom, 10, 5)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// initialState / applyWide
// ---------------------------------------------------------------------------

describe('initialState / applyWide', () => {
	it('wide: cont/ALL/NAE', () => {
		const s = initialState(true);
		expect(s.view).toBe('cont');
		expect(s.contView).toBe('ALL');
		expect(s.cont).toBe('NAE');
	});
	it('phone: world/NAE/null', () => {
		const s = initialState(false);
		expect(s.view).toBe('world');
		expect(s.contView).toBe('NAE');
		expect(s.cont).toBeNull();
	});
	it('applyWide is a no-op once the user has touched the view toggle', () => {
		const s = baseState({ view: 'world', cont: null, viewTouched: true });
		expect(applyWide(s, true)).toEqual(s);
	});
	it('applyWide flips the view when untouched', () => {
		const s = baseState({ view: 'world', cont: null, viewTouched: false });
		const wide = applyWide(s, true);
		expect(wide.view).toBe('cont');
		expect(wide.contView).toBe('ALL');
	});
});

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

describe('geometry', () => {
	it('world at avail 300 -> cellW 25, w 300', () => {
		const s = baseState({ view: 'world', cont: null });
		const g = geometry(s, 300, true);
		expect(g.cellW).toBe(25);
		expect(g.w).toBe(300);
		expect(g.headH).toBe(20);
	});
	it('All continents at avail 300 -> cellW 6, w 576', () => {
		const s = baseState({ view: 'cont', contView: 'ALL', cont: 'NAE' });
		const g = geometry(s, 300, true);
		expect(g.cellW).toBe(6);
		expect(g.w).toBe(576);
		expect(g.headH).toBe(34);
	});
	it('single continent on a phone -> a 48px tap row (cs.md >= 48px; ' +
		'the build spec\'s own test line says 44, contradicting its own ' +
		'ROW_H_TOUCH=48 constant and the oracle mockup\'s executable code, ' +
		'both of which use 48 — see the implementation report)', () => {
		const s = baseState({ view: 'cont', contView: 'NAE', cont: 'NAE' });
		const g = geometry(s, 300, false);
		expect(g.single).toBe(true);
		expect(g.rowH).toBe(48);
	});
	it('single continent, wide -> the compact 22px row', () => {
		const s = baseState({ view: 'cont', contView: 'NAE', cont: 'NAE' });
		const g = geometry(s, 300, true);
		expect(g.rowH).toBe(22);
	});
});

// ---------------------------------------------------------------------------
// formatWindow / gapText
// ---------------------------------------------------------------------------

describe('formatWindow', () => {
	it('[12,1,2,3] -> "Dec–Mar"', () => {
		expect(formatWindow([12, 1, 2, 3])).toBe('Dec–Mar');
	});
	it('[1,3] -> "Jan, Mar" (no single run)', () => {
		expect(formatWindow([1, 3])).toBe('Jan, Mar');
	});
});

describe('gapText', () => {
	it('no gap -> null', () => {
		expect(gapText([])).toBeNull();
	});
	it('all 12 months -> "Year-round" (CODEX1 P2-9), not a 12-name list', () => {
		const g = gapText([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])!;
		expect(g.window).toBe('Year-round');
		expect(g.text).toBe('below 0.5% of checklists in every loaded region all year');
	});
	it('a partial gap keeps the run/list format', () => {
		const g = gapText([12, 1, 2])!;
		expect(g.window).toBe('Dec–Feb');
		expect(g.text).toBe('below 0.5% of checklists in every loaded region.');
	});
});

// ---------------------------------------------------------------------------
// chartAria
// ---------------------------------------------------------------------------

describe('chartAria', () => {
	it('one reported cell -> "reported in 1 of 18 bands, strongest 40–50°N in September at 6%"', () => {
		const grid = emptyGrid();
		grid.modes.equal.world[bandIndex(40)][8] = {
			f: 0.06,
			n: 500,
			state: 'reported',
			low: false,
			excluded: 0
		};
		const s = baseState({ view: 'world', cont: null, weight: 'equal' });
		const aria = chartAria(grid, s, 'Osprey');
		expect(aria).toContain('reported in 1 of 18 bands, strongest 40–50°N in September at 6%');
	});
	it("a 'thin' cell counts as neither reported nor absent and never sets the peak", () => {
		const grid = emptyGrid();
		grid.modes.equal.world[bandIndex(40)][0] = {
			f: 0,
			n: 200,
			state: 'thin',
			low: true,
			excluded: 1
		};
		const s = baseState({ view: 'world', cont: null, weight: 'equal' });
		const aria = chartAria(grid, s, 'Osprey');
		expect(aria).toContain('reported in 0 of 18 bands');
		expect(aria).toContain('surveyed but too thin to rate');
		expect(aria).not.toContain('strongest');
	});
});

// ---------------------------------------------------------------------------
// scopeText / drillHeading
// ---------------------------------------------------------------------------

describe('scopeText', () => {
	it('names loaded and missing columns, and the weighting-specific paragraph', () => {
		const grid = emptyGrid();
		grid.meta = {
			regions: 10,
			countries: 4,
			columnsLoaded: ['NAE', 'NAW'],
			columnsMissing: COLUMNS.filter((c) => c !== 'NAE' && c !== 'NAW'),
			unmappedCountries: []
		};
		const equalText = scopeText(grid.meta, 'equal');
		expect(equalText).toContain('Loaded: 10 regions in 4 countries across 2 continents');
		expect(equalText).toContain('Equal weight:');
		expect(equalText).not.toContain('By checklists:');
		const checklistsText = scopeText(grid.meta, 'checklists');
		expect(checklistsText).toContain('By checklists:');
	});
});

describe('drillHeading', () => {
	it("'Inside 40–50°N, North America, east of 100°W'", () => {
		const s = baseState({ band: 40, cont: 'NAE' });
		expect(drillHeading(s)).toBe('Inside 40–50°N, North America, east of 100°W');
	});
	it('drops the continent qualifier in World view', () => {
		const s = baseState({ band: 40, cont: null });
		expect(drillHeading(s)).toBe('Inside 40–50°N');
	});
});

// ---------------------------------------------------------------------------
// Drill fetch wiring (P2-11 / P2-4): generation guard, abort, !ok
// ---------------------------------------------------------------------------

describe('resolveDrillLoad / DrillGeneration', () => {
	const someRegions: RibbonRegionsClient = { rows: [], total: 0, capped: false };

	it('!res.ok -> the inline error message', () => {
		const g = new DrillGeneration();
		const gen = g.start();
		const result = resolveDrillLoad({ gen, generation: g, aborted: false, ok: false });
		expect(result).toEqual({ kind: 'error', message: DRILL_ERROR_MESSAGE });
	});

	it('an AbortError -> ignore (renders nothing)', () => {
		const g = new DrillGeneration();
		const gen = g.start();
		const result = resolveDrillLoad({ gen, generation: g, aborted: true, ok: false });
		expect(result).toEqual({ kind: 'ignore' });
	});

	it('a late response for a superseded (stale) generation is discarded', () => {
		const g = new DrillGeneration();
		const staleGen = g.start();
		g.start(); // a newer selection fires before the stale one resolves
		const result = resolveDrillLoad({
			gen: staleGen,
			generation: g,
			aborted: false,
			ok: true,
			regions: someRegions
		});
		expect(result).toEqual({ kind: 'ignore' });
	});

	it('the current generation with ok:true applies the data', () => {
		const g = new DrillGeneration();
		const gen = g.start();
		const result = resolveDrillLoad({ gen, generation: g, aborted: false, ok: true, regions: someRegions });
		expect(result).toEqual({ kind: 'data', regions: someRegions });
	});
});
