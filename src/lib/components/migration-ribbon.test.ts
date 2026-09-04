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
	activeBands,
	applyWide,
	bandLabel,
	beginDrill,
	binIndex,
	chartAria,
	compact,
	drillCacheKey,
	drillHeading,
	fillFor,
	formatWindow,
	gapText,
	geometry,
	initialState,
	landmarkFor,
	migrationSummary,
	occupiedBands,
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

	it('checklists low (server `low`, small n) -> "20% reporting rate · small sample"', () => {
		const grid = emptyGrid();
		grid.modes.checklists.world[b][0] = { f: 0.2, n: 20, state: 'reported', low: true, excluded: 0 };
		const r = readout(grid, { ...state, weight: 'checklists' });
		expect(r.line2).toBe('20% reporting rate · small sample');
	});

	it('zero -> "0% — surveyed, no reports"', () => {
		const grid = emptyGrid();
		grid.modes.equal.world[b][0] = { f: 0, n: 500, state: 'zero', low: false, excluded: 0 };
		const r = readout(grid, state);
		expect(r.line2).toBe('0% — surveyed, no reports');
	});

	// CC1 P2-2: readout() used to branch on raw `n < LOW_N` BEFORE checking
	// `f === 0`, so a surveyed zero with a thin sample (n=39) wrongly read
	// "0% reporting rate · small sample" even though classify() (ribbon.ts,
	// server-pinned) guarantees a zero cell's `low` is ALWAYS false. Branch
	// on the server's `low`, never on `n`, so this reads as a plain zero
	// under either weighting.
	it("a surveyed zero with n<40 is a plain zero under BOTH weightings (server's `low` is always false for zero — CC1 P2-2)", () => {
		const grid = emptyGrid();
		const cell = { f: 0, n: 39, state: 'zero' as const, low: false, excluded: 0 };
		grid.modes.equal.world[b][0] = cell;
		grid.modes.checklists.world[b][0] = cell;
		expect(readout(grid, state).line2).toBe('0% — surveyed, no reports');
		expect(readout(grid, { ...state, weight: 'checklists' }).line2).toBe('0% — surveyed, no reports');
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

	// Spec rev 3.3 TD-C, P1-1: below 640px cells are not tap targets — the
	// scrubber owns the month, a 48px band row owns the band.
	describe('bandOnly (phone contract)', () => {
		it('never returns a different month — `s.month` passes through unchanged', () => {
			const s = baseState({ view: 'world', cont: null, month: 9, playing: true });
			const geom = { cont: false, rowH: 48, cellW: 25, headH: 20, cols: 12 };
			// x lands in month-column 3 in full-picking terms, but bandOnly must
			// ignore that entirely.
			const res = pickCell(s, geom, 2 * 25 + 1, 20 + 2 * 48 + 1, true)!;
			expect(res.month).toBe(9);
			expect(res.band).toBe(BANDS[2]);
			expect(res.playing).toBe(false);
		});
		it('World view: cont stays null regardless of x', () => {
			const s = baseState({ view: 'world', cont: null });
			const geom = { cont: false, rowH: 48, cellW: 25, headH: 20, cols: 12 };
			const res = pickCell(s, geom, 200, 20 + 48 + 1, true)!;
			expect(res.cont).toBeNull();
		});
		it('All-continents view: cont is the continent under x (12-cell blocks)', () => {
			const s = baseState({ view: 'cont', contView: 'ALL', cont: 'NAE' });
			const geom = { cont: true, rowH: 48, cellW: 6, headH: 34, cols: 96 };
			// Column block 2 (SA) spans cells [24,36) -> x in [144,216).
			const res = pickCell(s, geom, 150, 34 + 48 + 1, true)!;
			expect(res.cont).toBe('SA');
		});
		it('single-continent view: cont is that one continent regardless of x', () => {
			const s = baseState({ view: 'cont', contView: 'NAE', cont: 'NAE' });
			const geom = { cont: true, rowH: 48, cellW: 25, headH: 34, cols: 12 };
			const res = pickCell(s, geom, 5, 34 + 48 + 1, true)!;
			expect(res.cont).toBe('NAE');
		});
		it('still resolves the band from y and clears drillExpanded', () => {
			const s = baseState({ view: 'world', cont: null, drillExpanded: true });
			const geom = { cont: false, rowH: 48, cellW: 25, headH: 20, cols: 12 };
			const res = pickCell(s, geom, 0, 20 + 3 * 48 + 1, true)!;
			expect(res.band).toBe(BANDS[3]);
			expect(res.drillExpanded).toBe(false);
		});
		it('outside the band grid vertically is still null', () => {
			const s = baseState({ view: 'world', cont: null });
			const geom = { cont: false, rowH: 48, cellW: 25, headH: 20, cols: 12 };
			expect(pickCell(s, geom, 10, 5, true)).toBeNull();
		});
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
		const g = geometry(s, 300, true, false);
		expect(g.cellW).toBe(25);
		expect(g.w).toBe(300);
		expect(g.headH).toBe(20);
	});
	it('All continents at avail 300 -> cellW 6, w 576', () => {
		const s = baseState({ view: 'cont', contView: 'ALL', cont: 'NAE' });
		const g = geometry(s, 300, true, false);
		expect(g.cellW).toBe(6);
		expect(g.w).toBe(576);
		expect(g.headH).toBe(34);
	});
	// cs.md >= 48px; the build spec's OWN rev-3 test line said 44 (a stale
	// artifact CC1 confirmed and fixed in the spec after this report flagged
	// it) — 48 was always right, and is now the pinned, spec-agreed number.
	it('phone (< 640px): EVERY view gets the 48px touch row, sampled ' +
		'independently of `wide` (spec rev 3.3 TD-C, P1-1)', () => {
		const world = geometry(baseState({ view: 'world', cont: null }), 300, false, true);
		expect(world.rowH).toBe(48);
		const all = geometry(baseState({ view: 'cont', contView: 'ALL', cont: 'NAE' }), 300, false, true);
		expect(all.rowH).toBe(48);
		const single = geometry(baseState({ view: 'cont', contView: 'NAE', cont: 'NAE' }), 300, false, true);
		expect(single.single).toBe(true);
		expect(single.rowH).toBe(48);
	});
	it('tablet (640-1023px: not phone, not wide) keeps the compact 22px ' +
		'row AND full cell picking in every view (P1-1, GROK) — this used ' +
		'to wrongly get 48px band-only rows in single-continent mode because ' +
		'rowH (and, via the component, bandOnly) was derived from `!wide`, ' +
		'never a real phone check; tablet is neither `phone` nor `wide`', () => {
		const world = geometry(baseState({ view: 'world', cont: null }), 300, false, false);
		expect(world.rowH).toBe(22);
		const all = geometry(baseState({ view: 'cont', contView: 'ALL', cont: 'NAE' }), 300, false, false);
		expect(all.rowH).toBe(22);
		const single = geometry(baseState({ view: 'cont', contView: 'NAE', cont: 'NAE' }), 300, false, false);
		expect(single.rowH).toBe(22);
		// Cell picking on tablet: the component passes `bandOnly: phone`, so
		// tablet (phone=false) always gets FULL picking — a tap resolves
		// both band and month, never band-only.
		const s = baseState({ view: 'world', cont: null, month: 7 });
		const geom = { cont: false, rowH: 22, cellW: 25, headH: 20, cols: 12 };
		const picked = pickCell(s, geom, 2 * 25 + 1, 20 + 2 * 22 + 1, false)!;
		expect(picked.month).toBe(3); // resolved from x, not left at 7 — proves full picking
	});
	it('desktop (wide, not phone): compact 22px row, single continent included', () => {
		const s = baseState({ view: 'cont', contView: 'NAE', cont: 'NAE' });
		const g = geometry(s, 300, true, false);
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

describe('beginDrill (CODEX1 P1-2: generation bumps BEFORE the cache check)', () => {
	const someRegions: RibbonRegionsClient = { rows: [], total: 0, capped: false };

	it('a cache hit still bumps the generation', () => {
		const g = new DrillGeneration();
		const cache = new Map<string, RibbonRegionsClient>();
		cache.set(drillCacheKey(40, 'NAE'), someRegions);
		const before = g.start(); // simulate a prior in-flight request
		const begin = beginDrill(drillCacheKey(40, 'NAE'), cache, g);
		expect(begin.kind).toBe('cached');
		expect(g.isCurrent(before)).toBe(false); // bumped even though cached
	});
	it('a cache miss returns the freshly bumped generation', () => {
		const g = new DrillGeneration();
		const cache = new Map<string, RibbonRegionsClient>();
		const begin = beginDrill(drillCacheKey(40, 'ALL'), cache, g);
		expect(begin.kind).toBe('fetch');
		if (begin.kind === 'fetch') expect(g.isCurrent(begin.gen)).toBe(true);
	});

	it('in-flight fetch for cell A settling AFTER cell B was served from cache is ignored (the exact P1-2 race)', () => {
		const g = new DrillGeneration();
		const cache = new Map<string, RibbonRegionsClient>();
		// A is a cache miss: a real fetch begins for it.
		const beginA = beginDrill(drillCacheKey(40, 'ALL'), cache, g);
		expect(beginA.kind).toBe('fetch');
		const genA = beginA.kind === 'fetch' ? beginA.gen : -1;
		// The user moves on to B before A's fetch resolves. B is already
		// cached (e.g. from an earlier visit) — the OLD bug returned early
		// from the cache branch without bumping the generation, so A's late
		// response could still pass `isCurrent` and clobber B's rows.
		cache.set(drillCacheKey(40, 'NAE'), someRegions);
		const beginB = beginDrill(drillCacheKey(40, 'NAE'), cache, g);
		expect(beginB.kind).toBe('cached');
		// A's fetch finally settles: it must be ignored, not applied over B.
		const resultA = resolveDrillLoad({
			gen: genA,
			generation: g,
			aborted: false,
			ok: true,
			regions: { rows: [], total: 99, capped: false }
		});
		expect(resultA).toEqual({ kind: 'ignore' });
	});
});

describe('landmarkFor', () => {
	it('resolves specific continent landmarks', () => {
		expect(landmarkFor(40, 'NAE')).toBe('Great Lakes & New England');
		expect(landmarkFor(30, 'NAW')).toBe('S. California & Desert SW');
		expect(landmarkFor(50, 'EU')).toBe('British Isles & Central Europe');
		expect(landmarkFor(0, 'SA')).toBe('Amazonia, Colombia & Ecuador');
	});

	it('falls back to WORLD landmarks when continent has no override', () => {
		expect(landmarkFor(40, null)).toBe('Mid-Latitudes North');
		expect(landmarkFor(-40, 'EU')).toBe('Mid-Latitudes South');
	});
});

describe('occupiedBands & activeBands', () => {
	function populatedGrid(bands: number[]): RibbonGridClient {
		const grid = emptyGrid('testsp');
		for (const b of bands) {
			const bi = bandIndex(b);
			for (let m = 0; m < 12; m++) {
				grid.modes.equal.world[bi][m] = {
					f: 0.1,
					n: 500,
					state: 'reported',
					low: false,
					excluded: 0
				};
			}
		}
		return grid;
	}

	it('empty grid returns full BANDS', () => {
		const grid = emptyGrid();
		const s = baseState({ view: 'world' });
		expect(occupiedBands(grid, s)).toEqual([...BANDS]);
	});

	it('crops to occupied bands plus 1 row padding on each side', () => {
		// Occupied at 40 and 30 -> indices 4 and 5 in BANDS (80, 70, 60, 50, 40, 30, 20...)
		// Padded indices: 3 (50) to 6 (20) -> [50, 40, 30, 20]
		const grid = populatedGrid([40, 30]);
		const s = baseState({ view: 'world' });
		const bands = occupiedBands(grid, s);
		expect(bands).toEqual([50, 40, 30, 20]);
	});

	it('aggregates every drawn column in All continents mode across disjoint hemispheres (CODEX1 P1)', () => {
		const grid = emptyGrid();
		const b40 = bandIndex(40);
		const bMinus30 = bandIndex(-30);
		const ciNAE = COLUMNS.indexOf('NAE');
		const ciSA = COLUMNS.indexOf('SA');

		// NAE at 40° in June
		grid.modes.equal.cols[b40][ciNAE][5] = { f: 0.3, n: 500, state: 'reported', low: false, excluded: 0 };
		// SA at -30° in December
		grid.modes.equal.cols[bMinus30][ciSA][11] = { f: 0.3, n: 500, state: 'reported', low: false, excluded: 0 };

		// In All continents mode, s.cont is typically non-null ('NAE'), but contView is 'ALL'
		const s = baseState({ view: 'cont', contView: 'ALL', cont: 'NAE' });
		const bands = occupiedBands(grid, s);
		// Span covers 40° down to -30°, plus 1 buffer band above (50°) and below (-40°)
		expect(bands).toEqual([50, 40, 30, 20, 10, 0, -10, -20, -30, -40]);
	});

	it('activeBands respects fullGlobe flag', () => {
		const grid = populatedGrid([40, 30]);
		const s = baseState({ view: 'world' });
		expect(activeBands(grid, s, true)).toEqual([...BANDS]);
		expect(activeBands(grid, s, false)).toEqual([50, 40, 30, 20]);
	});
});

describe('migrationSummary', () => {
	it('returns hasData: false for empty grid', () => {
		const grid = emptyGrid();
		const s = baseState({ view: 'world' });
		const summary = migrationSummary(grid, s);
		expect(summary.hasData).toBe(false);
		expect(summary.span).toBeNull();
		expect(summary.headline).toBe('Seasonal Distribution');
	});

	it('identifies seasonal latitudinal shift when latitudes change between seasons', () => {
		const grid = emptyGrid();
		// North at band 50 (June/July)
		const b50 = bandIndex(50);
		grid.modes.equal.world[b50][5] = { f: 0.4, n: 1000, state: 'reported', low: false, excluded: 0 };
		grid.modes.equal.world[b50][6] = { f: 0.4, n: 1000, state: 'reported', low: false, excluded: 0 };

		// South at band 10 (Jan/Dec)
		const b10 = bandIndex(10);
		grid.modes.equal.world[b10][0] = { f: 0.3, n: 1000, state: 'reported', low: false, excluded: 0 };
		grid.modes.equal.world[b10][11] = { f: 0.3, n: 1000, state: 'reported', low: false, excluded: 0 };

		const s = baseState({ view: 'world' });
		const summary = migrationSummary(grid, s);
		expect(summary.hasData).toBe(true);
		expect(summary.headline).toBe('Seasonal Latitudinal Shift');
		expect(summary.span).toContain('40° latitudinal shift');
		expect(summary.details).toContain('Jun–Jul');
		expect(summary.details).toContain('Dec–Jan');
	});

	it('identifies resident pattern when latitude does not shift across all 12 months', () => {
		const grid = emptyGrid();
		const b40 = bandIndex(40);
		for (let m = 0; m < 12; m++) {
			grid.modes.equal.world[b40][m] = { f: 0.25, n: 1000, state: 'reported', low: false, excluded: 0 };
		}
		const s = baseState({ view: 'world' });
		const summary = migrationSummary(grid, s);
		expect(summary.hasData).toBe(true);
		expect(summary.headline).toBe('Year-Round Presence');
		expect(summary.span).toBe('Consistent year-round range');
		expect(summary.details).toContain('Mid-Latitudes North');
	});

	it('handles single-month observation without claiming year-round presence (CODEX1 P1)', () => {
		const grid = emptyGrid();
		const b40 = bandIndex(40);
		// Single June observation
		grid.modes.equal.world[b40][5] = { f: 0.25, n: 1000, state: 'reported', low: false, excluded: 0 };

		const s = baseState({ view: 'world' });
		const summary = migrationSummary(grid, s);
		expect(summary.hasData).toBe(true);
		expect(summary.headline).toBe('Sparse Seasonal Data');
		expect(summary.span).toBe('Recorded in 1 of 12 months');
		expect(summary.details).toContain('June');
		expect(summary.headline).not.toContain('Year-Round');
		expect(summary.span).not.toContain('Consistent year-round range');
	});

	it('handles partial-year observation without claiming full annual cycle (CODEX1 P1)', () => {
		const grid = emptyGrid();
		const b40 = bandIndex(40);
		// May, June, July only
		for (let m = 4; m <= 6; m++) {
			grid.modes.equal.world[b40][m] = { f: 0.25, n: 1000, state: 'reported', low: false, excluded: 0 };
		}

		const s = baseState({ view: 'world' });
		const summary = migrationSummary(grid, s);
		expect(summary.hasData).toBe(true);
		expect(summary.headline).toBe('Limited Seasonal Data');
		expect(summary.span).toBe('Recorded in 3 of 12 months');
		expect(summary.details).toContain('May–Jul');
		expect(summary.headline).not.toContain('Year-Round');
	});
});

