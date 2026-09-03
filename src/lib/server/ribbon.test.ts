/**
 * Pure unit coverage for the migration ribbon aggregation (td-c6b113, build
 * spec TD-B). `$lib/db` is mocked (forecast.test.ts:19-22 convention) purely
 * so importing `./ribbon` — which imports `$lib/db` for `withReadSnapshot`
 * — never touches a real pool; every test here except the "three SELECTs"
 * behavioral one exercises pure functions with no DB access at all.
 *
 * The numeric vectors are the acceptance oracle (build spec TD-B "Tests"):
 * real eBird curves exported from production 2026-09-02
 * (docs/mockups/ribbon-prod-curves.js), replayed through this file's own
 * `equalWeightCell`/`checklistCell`/`worldEqualCell` to 1e-6.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  withReadSnapshot: vi.fn(),
}));
vi.mock("$lib/db", () => ({
  withReadSnapshot: dbMocks.withReadSnapshot,
  query: vi.fn(),
}));

import {
  BANDS,
  COLUMNS,
  LOW_N,
  PRESENT,
  bandIndexOf,
  checklistCell,
  classify,
  equalWeightCell,
  gapMonthsFrom,
  speciesRibbon,
  worldEqualCell,
  type CountryCellInput,
  type RibbonColumn,
} from "./ribbon";

// ---------------------------------------------------------------------------
// Fixture: real eBird barchart curves exported from production 2026-09-02.
// Loaded via readFileSync + `new Function('window', src)` (build spec) since
// the file assigns to `window.*` rather than exporting ES modules.
// ---------------------------------------------------------------------------
interface FixtureRegion {
  code: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  curves: Record<string, [number, number][]>;
}

function loadFixture(): { regions: FixtureRegion[]; continentOf: Record<string, string> } {
  const src = readFileSync(
    new URL("../../../docs/mockups/ribbon-prod-curves.js", import.meta.url),
    "utf8",
  );
  const fakeWindow: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("window", src)(fakeWindow);
  return {
    regions: fakeWindow.RIBBON_DATA as FixtureRegion[],
    continentOf: fakeWindow.RIBBON_CONTINENT_OF as Record<string, string>,
  };
}
const { regions: FIXTURE_REGIONS, continentOf: FIXTURE_CONTINENT_OF } = loadFixture();

const NA_SPLIT_LON = -100;
/** Mirrors ribbon.ts's own column derivation, using the fixture's base
 * continent map — NA splits on longitude, everything else is its continent. */
function fixtureColumn(country: string, lon: number): RibbonColumn {
  const base = FIXTURE_CONTINENT_OF[country];
  if (base !== "NA") return base as RibbonColumn;
  return lon < NA_SPLIT_LON ? "NAW" : "NAE";
}
function bandOfLat(lat: number): number {
  return Math.max(-90, Math.min(80, Math.floor(lat / 10) * 10));
}

/** CountryCellInput rows for every fixture region in `band`, for `species`
 * at `monthIndex` (0-based, Jan=0). */
function rowsForBand(species: string, band: number, monthIndex: number): CountryCellInput[] {
  const rows: CountryCellInput[] = [];
  for (const r of FIXTURE_REGIONS) {
    if (bandOfLat(r.lat) !== band) continue;
    const cell = r.curves[species]?.[monthIndex];
    if (!cell) continue;
    const [f, n] = cell;
    rows.push({ country: r.country, column: fixtureColumn(r.country, r.lon), num: f * n, n });
  }
  return rows;
}

describe("equalWeightCell / checklistCell / worldEqualCell (fixture vectors)", () => {
  it("Osprey band 20 Jan — NAE equal weight", () => {
    const rows = rowsForBand("osprey", 20, 0).filter((r) => r.column === "NAE");
    const cell = equalWeightCell(rows)!;
    expect(cell).not.toBeNull();
    expect(cell.f).toBeCloseTo(0.3099, 6);
    expect(cell.n).toBe(332904);
  });

  it("Osprey band 20 Jan — AS equal weight (21 IN regions)", () => {
    const rows = rowsForBand("osprey", 20, 0).filter((r) => r.column === "AS");
    expect(rows).toHaveLength(21);
    const cell = equalWeightCell(rows)!;
    expect(cell).not.toBeNull();
    expect(cell.f).toBeCloseTo(0.033305, 5);
    expect(cell.n).toBe(82979);
  });

  it("Osprey band 20 Jan — checklistCell over every column", () => {
    const rows = rowsForBand("osprey", 20, 0);
    const cell = checklistCell(rows)!;
    expect(cell).not.toBeNull();
    expect(cell.f).toBeCloseTo(0.2408, 6);
    expect(cell.n).toBe(439972);
  });

  it("Osprey band 20 Jan — worldEqualCell MERGEs NAW+NAE as one continent", () => {
    const rows = rowsForBand("osprey", 20, 0);
    const cell = worldEqualCell(rows)!;
    expect(cell).not.toBeNull();
    // Pre-fix mockup half-average was 0.094278 — merge must not reproduce it.
    expect(cell.f).toBeCloseTo(0.161167, 6);
    expect(cell.f).not.toBeCloseTo(0.094278, 3);
  });

  it("Blackpoll band 40 Sep — NAW equal weight (<1%, 7 regions)", () => {
    const rows = rowsForBand("bkpwar", 40, 8).filter((r) => r.column === "NAW");
    expect(rows).toHaveLength(7);
    const cell = equalWeightCell(rows)!;
    expect(cell.f).toBeCloseTo(0.001646, 6);
  });

  it("Blackpoll band 40 Sep — NAE equal weight (19 regions, CA/US split)", () => {
    const rows = rowsForBand("bkpwar", 40, 8).filter((r) => r.column === "NAE");
    expect(rows).toHaveLength(19);
    const byCountry = new Map<string, { num: number; n: number }>();
    for (const r of rows) {
      const e = byCountry.get(r.country) ?? { num: 0, n: 0 };
      e.num += r.num;
      e.n += r.n;
      byCountry.set(r.country, e);
    }
    expect(byCountry.get("CA")!.num / byCountry.get("CA")!.n).toBeCloseTo(0.063628, 6);
    expect(byCountry.get("US")!.num / byCountry.get("US")!.n).toBeCloseTo(0.052514, 6);
    const cell = equalWeightCell(rows)!;
    expect(cell.f).toBeCloseTo(0.058071, 6);
  });

  it("Blackpoll band 40 Sep — worldEqualCell merge vs. checklistCell", () => {
    const rows = rowsForBand("bkpwar", 40, 8);
    const world = worldEqualCell(rows)!;
    expect(world.f).toBeCloseTo(0.052527, 6);
    // Pre-fix mockup half-average was 0.029859.
    expect(world.f).not.toBeCloseTo(0.029859, 3);
    const checklist = checklistCell(rows)!;
    expect(checklist.f).toBeCloseTo(0.044615, 6);
    expect(checklist.n).toBe(1963647);
  });
});

describe("classify", () => {
  it("zero iff f===0; low = f>0 && n<LOW_N", () => {
    expect(classify(0, 500)).toEqual({ f: 0, n: 500, state: "zero", low: false, excluded: 0 });
    expect(classify(0.2, 39)).toEqual({
      f: 0.2,
      n: 39,
      state: "reported",
      low: true,
      excluded: 0,
    });
    expect(classify(0, 39)).toEqual({ f: 0, n: 39, state: "zero", low: false, excluded: 0 });
  });

  it("checklistCell([]) and n=0-only rows are null", () => {
    expect(checklistCell([])).toBeNull();
    expect(
      checklistCell([{ country: "A", column: "EU", num: 0, n: 0 }]),
    ).toBeNull();
  });
});

describe("same country in both west buckets counts once (P1-6)", () => {
  it("equalWeightCell coalesces NZ (west=true, west=false) into one country vote", () => {
    const rows: CountryCellInput[] = [
      { country: "NZ", column: "OC", num: 0.5 * 100, n: 100 },
      { country: "NZ", column: "OC", num: 0.1 * 900, n: 900 },
    ];
    const cell = equalWeightCell(rows)!;
    expect(cell.f).toBeCloseTo(0.14, 6);
    expect(cell.n).toBe(1000);
    expect(cell.excluded).toBe(0);
  });
});

describe("equal weight excludes countries under 40 checklists and hatches (P2-2 default)", () => {
  it("A n=1 f=1.0, B n=10,000 f=0 -> f=0, excluded=1, low=true", () => {
    const rows: CountryCellInput[] = [
      { country: "A", column: "EU", num: 1, n: 1 },
      { country: "B", column: "EU", num: 0, n: 10_000 },
    ];
    const cell = equalWeightCell(rows)!;
    expect(cell.f).toBe(0);
    expect(cell.excluded).toBe(1);
    expect(cell.low).toBe(true);
    expect(cell.n).toBe(10_000);
  });
});

describe("gapMonthsFrom", () => {
  it("Blackpoll region grain -> [1,2,3,12]; NJ November counts as reached", () => {
    const samples: { month: number; n: number }[] = [];
    const reached: { month: number; reached: number }[] = [];
    for (const r of FIXTURE_REGIONS) {
      const curve = r.curves.bkpwar;
      if (!curve) continue;
      curve.forEach(([f, n], i) => {
        samples.push({ month: i + 1, n });
        reached.push({ month: i + 1, reached: f >= PRESENT ? 1 : 0 });
      });
    }
    expect(gapMonthsFrom(samples, reached)).toEqual([1, 2, 3, 12]);

    const nj = FIXTURE_REGIONS.find((r) => r.code === "US-NJ")!;
    const [novF, novN] = nj.curves.bkpwar[10];
    expect(novF).toBe(0.006);
    expect(novN).toBe(76684);
    expect(novF).toBeGreaterThanOrEqual(PRESENT);
  });
});

describe("bandIndexOf", () => {
  it("indexes BANDS in declared order", () => {
    expect(bandIndexOf(80)).toBe(0);
    expect(bandIndexOf(20)).toBe(BANDS.indexOf(20));
    expect(bandIndexOf(-90)).toBe(BANDS.length - 1);
    expect(bandIndexOf(5)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// speciesRibbon: behavioral test against a mocked withReadSnapshot client —
// exactly three SELECTs, all against the 0050 tables, none against the
// per-week source tables (CODEX1 acceptance).
// ---------------------------------------------------------------------------
describe("speciesRibbon", () => {
  beforeEach(() => {
    dbMocks.withReadSnapshot.mockReset();
  });

  function mockClient(rows: {
    samples: { band: number; country: string; west: boolean; month: number; n: number }[];
    freq: {
      band: number;
      country: string;
      west: boolean;
      month: number;
      num: number;
      reached: number;
    }[];
    locs: { band: number; country: string; west: boolean; count: string }[];
  }) {
    const calls: { text: string; params?: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (text: string, params?: unknown[]) => {
        calls.push({ text, params });
        if (text.includes("band_month_samples")) return { rows: rows.samples };
        if (text.includes("species_band_month_freq")) return { rows: rows.freq };
        if (text.includes("band_locs")) return { rows: rows.locs };
        throw new Error(`unexpected query: ${text}`);
      }),
    };
    dbMocks.withReadSnapshot.mockImplementation(async (fn: (c: unknown) => unknown) => fn(client));
    return calls;
  }

  it("issues exactly three SELECTs on the 0050 tables, none on the source tables", async () => {
    const calls = mockClient({
      samples: [{ band: 40, country: "US", west: false, month: 1, n: 1017 }],
      freq: [{ band: 40, country: "US", west: false, month: 1, num: 313.5, reached: 1 }],
      locs: [{ band: 40, country: "US", west: false, count: "1" }],
    });
    const grid = await speciesRibbon("testsp");
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.text).not.toMatch(/species_frequency|species_month_freq|loc_month_samples/);
    }
    expect(grid).not.toBeNull();
    expect(grid!.meta.regions).toBe(1);
    expect(grid!.meta.countries).toBe(1);
    const b = bandIndexOf(40);
    const c = COLUMNS.indexOf("NAE");
    expect(grid!.modes.checklists.cols[b][c][0]).toEqual({
      f: 313.5 / 1017,
      n: 1017,
      state: "reported",
      low: false,
      excluded: 0,
    });
  });

  it("returns null when band_locs is empty", async () => {
    mockClient({ samples: [], freq: [], locs: [] });
    expect(await speciesRibbon("testsp")).toBeNull();
  });

  it("surfaces an unmapped country instead of silently dropping it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockClient({
      samples: [{ band: 0, country: "ZZ", west: false, month: 1, n: 100 }],
      freq: [],
      locs: [{ band: 0, country: "ZZ", west: false, count: "1" }],
    });
    const grid = await speciesRibbon("testsp", { columnOf: () => null });
    expect(grid!.meta.unmappedCountries).toEqual(["ZZ"]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
