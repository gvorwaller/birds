import { describe, expect, it } from "vitest";
import {
  COUNTY_BATCH,
  FORECAST_HOTSPOT_LIMIT,
  MIN_MONTH_N,
  bestMonth,
  buildForecastSpecies,
  coverageFromMeta,
  monthCurve,
  monthWeeks,
  monthlyStat,
  nextUncachedCounties,
  selectForecastHotspots,
  type MonthStat,
} from "./forecast";

const WEEKS = 48;

/** sampleSizes helper: n for every week of one month, 0 elsewhere. */
function monthOnlySamples(month: number, perWeek: number[]): number[] {
  const sizes = Array(WEEKS).fill(0);
  const from = (month - 1) * 4;
  perWeek.forEach((n, i) => (sizes[from + i] = n));
  return sizes;
}

describe("monthWeeks", () => {
  it("maps months to their 4 pseudo-weeks", () => {
    expect(monthWeeks(1)).toEqual({ from: 1, to: 4 });
    expect(monthWeeks(6)).toEqual({ from: 21, to: 24 });
    expect(monthWeeks(12)).toEqual({ from: 45, to: 48 });
  });

  it("rejects out-of-range months", () => {
    expect(() => monthWeeks(0)).toThrow(/out of range/i);
    expect(() => monthWeeks(13)).toThrow(/out of range/i);
    expect(() => monthWeeks(1.5)).toThrow(/out of range/i);
  });
});

describe("monthlyStat (checklist-weighted)", () => {
  it("weights weeks by checklist count, not equally", () => {
    // Week 1: freq 1.0 on 10 checklists; week 2: freq 0.3 on 1000 checklists.
    // An unweighted mean of the 4 weeks would be (1 + 0.3 + 0 + 0)/4 = 0.325;
    // the weighted answer is (1*10 + 0.3*1000) / 1010.
    const sizes = monthOnlySamples(1, [10, 1000, 0, 0]);
    const freqs = new Map([
      [1, 1.0],
      [2, 0.3],
    ]);
    const stat = monthlyStat(freqs, sizes, 1);
    expect(stat.freq).toBeCloseTo((1 * 10 + 0.3 * 1000) / 1010, 6);
    expect(stat.n).toBe(1010);
  });

  it("counts checklists of absent sparse weeks in the denominator", () => {
    // Species reported only in week 1; weeks 2-4 have checklists but no row.
    const sizes = monthOnlySamples(2, [100, 100, 100, 100]);
    const freqs = new Map([[5, 0.4]]); // week 5 = first week of February
    const stat = monthlyStat(freqs, sizes, 2);
    expect(stat.freq).toBeCloseTo(0.1, 6); // 0.4*100 / 400
    expect(stat.n).toBe(400);
  });

  it("returns freq 0, n 0 for a month with zero checklists", () => {
    const stat = monthlyStat(new Map(), Array(WEEKS).fill(0), 7);
    expect(stat).toEqual({ month: 7, freq: 0, n: 0 });
  });

  it("uneven small-vs-large: 1/1 does not dominate 300/1000", () => {
    // Week 1: 100% of 1 checklist. Week 2: 30% of 1000.
    const sizes = monthOnlySamples(3, [1, 1000, 0, 0]);
    const freqs = new Map([
      [9, 1.0],
      [10, 0.3],
    ]);
    const stat = monthlyStat(freqs, sizes, 3);
    expect(stat.freq).toBeCloseTo(301 / 1001, 6);
  });
});

describe("monthCurve", () => {
  it("produces 12 months covering all 48 weeks", () => {
    const sizes = Array(WEEKS).fill(50);
    const freqs = new Map(
      Array.from({ length: WEEKS }, (_, i) => [i + 1, 0.5] as [number, number]),
    );
    const curve = monthCurve(freqs, sizes);
    expect(curve).toHaveLength(12);
    expect(curve.map((s) => s.month)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    for (const s of curve) {
      expect(s.freq).toBeCloseTo(0.5, 6);
      expect(s.n).toBe(200);
    }
  });
});

describe("bestMonth", () => {
  const stat = (month: number, freq: number, n: number): MonthStat => ({
    month,
    freq,
    n,
  });

  it("prefers adequately-sampled months over a high-freq low-n outlier", () => {
    // 100% with n=1 must NOT beat 30% with n=2000 (CODEX1 #8).
    const curve = [
      stat(1, 1.0, 1),
      stat(2, 0.3, 2000),
      ...Array.from({ length: 10 }, (_, i) => stat(i + 3, 0, 500)),
    ];
    const best = bestMonth(curve);
    expect(best?.month).toBe(2);
    expect(best?.lowSample).toBe(false);
  });

  it("falls back to low-n months, flagged, when nothing is well sampled", () => {
    const curve = [
      stat(1, 0.2, 5),
      stat(2, 0.6, 8),
      ...Array.from({ length: 10 }, (_, i) => stat(i + 3, 0, 0)),
    ];
    const best = bestMonth(curve);
    expect(best?.month).toBe(2);
    expect(best?.lowSample).toBe(true);
  });

  it("returns null when the species was never reported", () => {
    const curve = Array.from({ length: 12 }, (_, i) => stat(i + 1, 0, 1000));
    expect(bestMonth(curve)).toBeNull();
  });

  it("threshold boundary: n exactly MIN_MONTH_N qualifies", () => {
    const curve = [
      stat(1, 0.9, MIN_MONTH_N - 1),
      stat(2, 0.1, MIN_MONTH_N),
      ...Array.from({ length: 10 }, (_, i) => stat(i + 3, 0, 0)),
    ];
    const best = bestMonth(curve);
    expect(best?.month).toBe(2);
    expect(best?.lowSample).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mode A (Phase 2)
// ---------------------------------------------------------------------------

interface HotspotLike {
  locId: string;
  locName: string;
  lat: number;
  lng: number;
  numSpeciesAllTime?: number;
}

// ~1km per 0.009 degrees latitude; origin at (27, -82).
function hs(
  locId: string,
  kmNorth: number,
  numSpeciesAllTime?: number,
): HotspotLike {
  return {
    locId,
    locName: `Hotspot ${locId}`,
    lat: 27 + kmNorth * 0.009,
    lng: -82,
    numSpeciesAllTime,
  };
}
const ORIGIN = { lat: 27, lng: -82 };

describe("selectForecastHotspots", () => {
  it("mixes nearest and most-active, deduped, nearest-first order", () => {
    // 12 hotspots: A0..A11 by increasing distance; activity is inverted so the
    // most active are the farthest.
    const hotspots = Array.from({ length: 12 }, (_, i) =>
      hs(`A${i}`, i, 100 + (11 - i) * 0), // activity assigned below
    ).map((h, i) => ({ ...h, numSpeciesAllTime: i * 10 })); // farthest = most active
    const picked = selectForecastHotspots(hotspots, ORIGIN);
    expect(picked).toHaveLength(FORECAST_HOTSPOT_LIMIT);
    const ids = picked.map((h) => h.locId);
    // 4 nearest…
    for (const id of ["A0", "A1", "A2", "A3"]) expect(ids).toContain(id);
    // …and 4 most active (farthest).
    for (const id of ["A11", "A10", "A9", "A8"]) expect(ids).toContain(id);
    // Output is nearest-first regardless of why a hotspot was chosen.
    expect(ids).toEqual(["A0", "A1", "A2", "A3", "A8", "A9", "A10", "A11"]);
  });

  it("dedupes when the nearest are also the most active", () => {
    const hotspots = Array.from({ length: 6 }, (_, i) =>
      hs(`B${i}`, i, 1000 - i * 10),
    );
    const picked = selectForecastHotspots(hotspots, ORIGIN);
    expect(picked.map((h) => h.locId)).toEqual([
      "B0",
      "B1",
      "B2",
      "B3",
      "B4",
      "B5",
    ]);
  });

  it("treats missing numSpeciesAllTime as zero activity", () => {
    const hotspots = [hs("C0", 0), hs("C1", 1, 500), hs("C2", 2)];
    const picked = selectForecastHotspots(hotspots, ORIGIN, 2);
    expect(picked.map((h) => h.locId)).toEqual(["C0", "C1"]);
  });
});

describe("buildForecastSpecies", () => {
  const locNames = new Map([
    ["L1", "Fort De Soto Park"],
    ["L2", "Sawgrass Lake Park"],
  ]);
  const agg = (
    code: string,
    locId: string,
    num: number,
    name = code.toUpperCase(),
  ) => ({ code, comName: name, sciName: `Sci ${name}`, locId, num });

  it("computes area-weighted frequency across hotspots and ranks by it", () => {
    // L1: 1000 checklists, L2: 500. Species x: 30% at L1, 10% at L2.
    // Area freq = (300 + 50) / 1500 ≈ 0.2333. Species y: 10% at L1 only.
    const denom = new Map([
      ["L1", 1000],
      ["L2", 500],
    ]);
    const rows = [
      agg("xspec", "L1", 300),
      agg("xspec", "L2", 50),
      agg("yspec", "L1", 100),
    ];
    const out = buildForecastSpecies(rows, denom, locNames, new Set());
    expect(out.map((s) => s.code)).toEqual(["xspec", "yspec"]);
    expect(out[0].areaFreq).toBeCloseTo(350 / 1500, 6);
    expect(out[0].areaN).toBe(1500);
    expect(out[1].areaFreq).toBeCloseTo(100 / 1500, 6);
    // Per-hotspot bests sorted by hotspot frequency.
    expect(out[0].topHotspots[0].locName).toBe("Fort De Soto Park");
    expect(out[0].topHotspots[0].freq).toBeCloseTo(0.3, 6);
    expect(out[0].topHotspots[1].freq).toBeCloseTo(0.1, 6);
  });

  it("excludes seen species", () => {
    const denom = new Map([["L1", 1000]]);
    const rows = [agg("seenone", "L1", 500), agg("needed", "L1", 100)];
    const out = buildForecastSpecies(
      rows,
      denom,
      locNames,
      new Set(["seenone"]),
    );
    expect(out.map((s) => s.code)).toEqual(["needed"]);
  });

  it("flags low-sample areas and sorts them after well-sampled species", () => {
    // Well-sampled hotspot vs a separate run with tiny n.
    const denom = new Map([["L1", MIN_MONTH_N - 1]]);
    const out = buildForecastSpecies(
      [agg("rare1", "L1", MIN_MONTH_N - 1)], // 100% of 39 checklists
      denom,
      locNames,
      new Set(),
    );
    expect(out[0].lowSample).toBe(true);
    expect(out[0].topHotspots[0].lowSample).toBe(true);
  });

  it("annual rollover: stale rows count as remaining, never as complete", () => {
    // CODEX8 P1: after a year rollover every stored row is stale — coverage
    // must re-enable the refresh path, and a stale-plus-failed code must not
    // be double counted (current + failed can never exceed total).
    const codes = ["A", "B", "C", "D"];
    const meta = new Map([
      ["A", { endYear: 2025 }], // current
      ["B", { endYear: 2024 }], // stale
      ["C", { endYear: 2024 }], // stale AND recently failed refresh
    ]); // D: missing
    const cov = coverageFromMeta(codes, meta, new Set(["C", "D"]), 2025);
    expect(cov.current).toEqual(["A"]);
    expect(cov.stale).toEqual(["B", "C"]);
    expect(cov.missing).toEqual(["D"]);
    expect(cov.failed).toEqual(["C", "D"]);
    // B is the only refreshable code not sitting out a cooldown.
    expect(cov.remaining).toBe(1);
    expect(cov.current.length + cov.failed.length).toBeLessThanOrEqual(
      codes.length,
    );
    // All-stale world (the rollover moment): everything is remaining.
    const allStale = coverageFromMeta(
      ["A", "B"],
      new Map([
        ["A", { endYear: 2024 }],
        ["B", { endYear: 2024 }],
      ]),
      new Set(),
      2025,
    );
    expect(allStale.current).toEqual([]);
    expect(allStale.remaining).toBe(2);
  });

  it("resumable county batching excludes cached AND failed, so the loop terminates", () => {
    const counties = Array.from({ length: 30 }, (_, i) => ({
      code: `US-FL-${String(i).padStart(3, "0")}`,
      name: `County ${i}`,
    }));
    const cached = new Set(counties.slice(0, 10).map((c) => c.code));
    const failed = new Set(counties.slice(10, 14).map((c) => c.code));
    const batch = nextUncachedCounties(counties, cached, failed, COUNTY_BATCH);
    expect(batch).toHaveLength(COUNTY_BATCH);
    for (const c of batch) {
      expect(cached.has(c.code)).toBe(false);
      expect(failed.has(c.code)).toBe(false);
    }
    // All covered or failed → empty batch, i.e. the loop's terminal state.
    const allDone = new Set(counties.map((c) => c.code));
    expect(nextUncachedCounties(counties, allDone, new Set(), 12)).toEqual([]);
    const allButFailed = new Set(counties.slice(0, 26).map((c) => c.code));
    expect(
      nextUncachedCounties(counties, allButFailed, failed, 12),
    ).toEqual(counties.slice(26));
  });

  it("drops species with zero area frequency and handles empty input", () => {
    expect(
      buildForecastSpecies([], new Map([["L1", 100]]), locNames, new Set()),
    ).toEqual([]);
    const out = buildForecastSpecies(
      [agg("ghost", "L1", 0)],
      new Map([["L1", 100]]),
      locNames,
      new Set(),
    );
    expect(out).toEqual([]);
  });
});
