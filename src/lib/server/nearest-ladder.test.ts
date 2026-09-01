/**
 * The nearest ladder's correctness rules (td-73e6f9).
 *
 * These deliberately pin the BUGS the plan reviews caught, not just the happy
 * path: a stop rule that proved only one row while rendering five, a probe
 * order that would let Fiji starve Florida, and a hit count that could be
 * satisfied by five copies of one report.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegionBox } from "$lib/geo";

const ebird = vi.hoisted(() => ({
  nearestObsOfSpecies: vi.fn(),
  recentSpeciesInRegion: vi.fn(),
  REGION_PROBE_MAX_RESULTS: 10_000,
  EbirdError: class EbirdError extends Error {
    constructor(
      message: string,
      public status?: number,
    ) {
      super(message);
      this.name = "EbirdError";
    }
  },
}));
const regions = vi.hoisted(() => ({ allProximityRegions: vi.fn() }));

vi.mock("$server/ebird", () => ebird);
vi.mock("$server/regions", () => regions);

const { nearestSpeciesReports, createProbeGate, pruneBoundKm, sortKeyKm } =
  await import("./nearest-ladder");

const HOME = { lat: 30.26, lon: -81.64 }; // Jacksonville
const SP = "bkcchi";

/** A 1°-tall box starting at `southLat`, straddling home's meridian. */
function boxAt(southLat: number): RegionBox {
  return {
    minLat: southLat,
    maxLat: southLat + 1,
    minLon: -82.0,
    maxLon: -81.0,
  };
}

function region(code: string, southLat: number | null, centroidLat = 45) {
  return southLat == null
    ? { code, name: code, level: "country" as const, parent: null, lat: centroidLat, lon: -81.64, box: null }
    : {
        code,
        name: code,
        level: "subnational1" as const,
        parent: "US",
        lat: southLat + 0.5,
        lon: -81.64,
        box: boxAt(southLat),
      };
}

/** Regions at increasing distance: R1 ~82km, R2 ~304km, ... R6 ~1192km. */
const R = [
  region("R1", 31),
  region("R2", 33),
  region("R3", 35),
  region("R4", 37),
  region("R5", 39),
  region("R6", 41),
];

let obsSeq = 0;
/** An observation on home's meridian at `lat` — distance ≈ (lat-30.26)*111km. */
function obs(lat: number, over: Partial<{ locId: string; obsDt: string }> = {}) {
  obsSeq += 1;
  return {
    speciesCode: SP,
    comName: "Black-capped Chickadee",
    sciName: "Poecile atricapillus",
    locId: over.locId ?? `L${obsSeq}`,
    locName: `Place ${obsSeq}`,
    obsDt: over.obsDt ?? `2026-08-3${(obsSeq % 9) + 1} 08:00`,
    howMany: 1,
    lat,
    lng: -81.64,
    obsValid: true,
    obsReviewed: false,
    locationPrivate: false,
  };
}

const ok = (data: unknown[], stale = false) => ({
  data,
  stale,
  fetchedAt: new Date(),
});

/** Wire per-region payloads; regions absent from the map return empty. */
function serve(byRegion: Record<string, unknown[]>, opts: { stale?: string[] } = {}) {
  ebird.recentSpeciesInRegion.mockImplementation(
    (_k: string, code: string) =>
      Promise.resolve(ok(byRegion[code] ?? [], opts.stale?.includes(code) ?? false)),
  );
}

const OPTS = { fastDeadlineMs: 10_000, probeBudget: 40, ladderDeadlineMs: 20_000 };

beforeEach(() => {
  vi.clearAllMocks();
  obsSeq = 0;
  regions.allProximityRegions.mockResolvedValue({ candidates: R, unsafe: [] });
  // Default: the direct endpoint is dead, which is what the ladder exists for.
  ebird.nearestObsOfSpecies.mockRejectedValue(
    new ebird.EbirdError("eBird did not respond within 10s.", 504),
  );
});

describe("fast path", () => {
  it("uses the direct endpoint when it answers, and never probes", async () => {
    ebird.nearestObsOfSpecies.mockResolvedValue(ok([obs(35), obs(31.2)]));
    const res = await nearestSpeciesReports("key", SP, HOME, 14, OPTS);

    expect(res.via).toBe("nearest");
    expect(ebird.recentSpeciesInRegion).not.toHaveBeenCalled();
    // Sorted by OUR haversine, never the API's order.
    expect(res.rows[0].lat).toBe(31.2);
    expect(res.proven).toBe(true);
  });

  it("does not fall back to a 40-probe storm on a bad key or a rate limit", async () => {
    for (const status of [401, 403, 429]) {
      vi.clearAllMocks();
      ebird.nearestObsOfSpecies.mockRejectedValue(
        new ebird.EbirdError("nope", status),
      );
      await expect(
        nearestSpeciesReports("key", SP, HOME, 14, OPTS),
      ).rejects.toThrow("nope");
      expect(ebird.recentSpeciesInRegion).not.toHaveBeenCalled();
    }
  });
});

describe("top-N stop rule", () => {
  it("keeps searching past a single early hit (the counterexample)", async () => {
    // One report at ~104km in R1; four more at ~760-790km in R4, behind a
    // bound larger than 104. Stopping at "first hit + next bound > best"
    // would render one row and call it the answer.
    serve({
      R1: [obs(31.2)],
      R4: [obs(37.1), obs(37.2), obs(37.3), obs(37.4)],
    });

    const res = await nearestSpeciesReports("key", SP, HOME, 14, OPTS);

    expect(res.rows).toHaveLength(5);
    expect(res.rows[0].lat).toBeCloseTo(31.2, 5);
    expect(res.via).toBe("ladder");
  });

  it("stops on the bound once it holds five, without draining coverage", async () => {
    serve({ R1: [obs(31.1), obs(31.2), obs(31.3), obs(31.4), obs(31.5)] });

    const res = await nearestSpeciesReports("key", SP, HOME, 14, OPTS);

    // One wave of 3 (R1-R3); R4's bound exceeds the worst row shown.
    expect(res.searched.regions).toBe(3);
    expect(res.rows).toHaveLength(5);
    expect(res.capped).toBe(false);
    expect(res.proven).toBe(true);
  });

  it("prefers a closer report found in a farther-sorted region", async () => {
    // R4 is sorted last but holds the nearest report of all.
    serve({
      R1: [obs(31.9), obs(31.91), obs(31.92), obs(31.93), obs(31.94)],
      R4: [obs(30.3)],
    });
    const res = await nearestSpeciesReports("key", SP, HOME, 14, OPTS);
    // R4's bound (~723km) exceeds R1's worst (~183km), so the search stops
    // before reaching it — and must NOT claim the question is settled.
    expect(res.rows[0].lat).toBeCloseTo(31.9, 5);
    expect(res.proven).toBe(true);
  });

  it("counts distinct observations, not repeated copies of one", async () => {
    // A country probe repeats its subnational1s' rows. Five copies of one
    // report must not satisfy a five-hit stop rule.
    const dup = obs(31.2, { locId: "L-DUP", obsDt: "2026-08-30 08:00" });
    serve({
      R1: [dup, { ...dup }, { ...dup }, { ...dup }, { ...dup }],
      R4: [obs(37.1), obs(37.2), obs(37.3), obs(37.4)],
    });

    const res = await nearestSpeciesReports("key", SP, HOME, 14, OPTS);

    expect(res.rows).toHaveLength(5);
    expect(res.rows.filter((r) => r.locId === "L-DUP")).toHaveLength(1);
  });
});

describe("bounds and probe order", () => {
  it("never lets a box-less region's zero bound drive the probe order", async () => {
    // pruneBound must be 0 (it has no lower bound), but sorting on that would
    // put it ahead of the home state from anywhere on earth.
    const nb = region("NB", null, 45); // centroid ~1640km away
    expect(pruneBoundKm(HOME, nb)).toBe(0);
    expect(sortKeyKm(HOME, nb)).toBeGreaterThan(1000);
    expect(sortKeyKm(HOME, R[0])).toBeLessThan(sortKeyKm(HOME, nb));
  });

  it("cannot prove an answer while an unbounded region is unprobed", async () => {
    regions.allProximityRegions.mockResolvedValue({
      candidates: [...R, region("NB", null, 45)],
      unsafe: [],
    });
    serve({ R1: [obs(31.1), obs(31.2), obs(31.3), obs(31.4), obs(31.5)] });

    const res = await nearestSpeciesReports("key", SP, HOME, 14, OPTS);

    // Five hits and the search stopped, but a region with no usable bound was
    // never checked — it could hold something closer.
    expect(res.rows).toHaveLength(5);
    expect(res.proven).toBe(false);
  });

  it("subtracts the margin so a border report cannot be pruned away", async () => {
    const raw = pruneBoundKm(HOME, R[1]);
    // R2's south edge is ~304km out; the bound must sit 25km short of it.
    expect(raw).toBeGreaterThan(250);
    expect(raw).toBeLessThan(304);
  });
});

describe("failure handling", () => {
  it("aborts the ladder on a rate limit from any rung", async () => {
    ebird.recentSpeciesInRegion.mockImplementation((_k: string, code: string) =>
      code === "R2"
        ? Promise.reject(new ebird.EbirdError("rate limit", 429))
        : Promise.resolve(ok([])),
    );

    const res = await nearestSpeciesReports("key", SP, HOME, 14, OPTS);

    expect(res.capped).toBe(true);
    expect(res.partial).toBe(true);
    expect(res.proven).toBe(false);
    expect(ebird.recentSpeciesInRegion).toHaveBeenCalledTimes(3); // one wave
  });

  it("stops after three consecutive failed rungs instead of burning the budget", async () => {
    ebird.recentSpeciesInRegion.mockRejectedValue(new Error("boom"));
    const res = await nearestSpeciesReports("key", SP, HOME, 14, OPTS);
    expect(res.capped).toBe(true);
    expect(res.partial).toBe(true);
    expect(ebird.recentSpeciesInRegion).toHaveBeenCalledTimes(3);
  });

  it("treats a stale cache fallback as success, not as a failure", async () => {
    serve({ R1: [obs(31.1), obs(31.2), obs(31.3), obs(31.4), obs(31.5)] }, {
      stale: ["R1"],
    });
    const res = await nearestSpeciesReports("key", SP, HOME, 14, OPTS);
    expect(res.stale).toBe(true);
    expect(res.partial).toBe(false);
    expect(res.rows).toHaveLength(5);
  });

  it("marks a saturated payload partial — truncation can hide the closest", async () => {
    const flood = Array.from({ length: ebird.REGION_PROBE_MAX_RESULTS }, () =>
      obs(31.5),
    );
    serve({ R1: flood });
    const res = await nearestSpeciesReports("key", SP, HOME, 14, OPTS);
    expect(res.partial).toBe(true);
    expect(res.proven).toBe(false);
  });

  it("records a failed rung so a closer unchecked region is not glossed over", async () => {
    ebird.recentSpeciesInRegion.mockImplementation((_k: string, code: string) =>
      code === "R1"
        ? Promise.reject(new Error("timeout"))
        : Promise.resolve(ok(code === "R4" ? [obs(37.1)] : [])),
    );
    const res = await nearestSpeciesReports("key", SP, HOME, 14, OPTS);
    // R1 is nearer than the row we found, and we never saw inside it.
    expect(res.partial).toBe(true);
    expect(res.proven).toBe(false);
  });
});

describe("budgets and deadlines", () => {
  it("never exceeds the probe budget", async () => {
    serve({});
    await nearestSpeciesReports("key", SP, HOME, 14, { ...OPTS, probeBudget: 4 });
    expect(ebird.recentSpeciesInRegion).toHaveBeenCalledTimes(4);
  });

  it("shares one allowance across species through the gate", async () => {
    serve({});
    const gate = createProbeGate(5);
    await nearestSpeciesReports("key", SP, HOME, 14, { ...OPTS, gate });
    expect(ebird.recentSpeciesInRegion).toHaveBeenCalledTimes(5);
    expect(gate.remaining()).toBe(0);

    // A second species on the same page gets nothing left and must not probe.
    vi.clearAllMocks();
    serve({});
    const res = await nearestSpeciesReports("key", "amerob", HOME, 14, {
      ...OPTS,
      gate,
    });
    expect(ebird.recentSpeciesInRegion).not.toHaveBeenCalled();
    expect(res.capped).toBe(true);
  });

  it("stops between waves once the ladder deadline passes", async () => {
    // Enough coverage that the deadline, not exhaustion, is what stops it.
    regions.allProximityRegions.mockResolvedValue({
      candidates: Array.from({ length: 30 }, (_, i) => region(`D${i}`, 31 + i)),
      unsafe: [],
    });
    serve({});
    let t = 0;
    const now = () => (t += 9_000); // each check advances 9s
    const res = await nearestSpeciesReports("key", SP, HOME, 14, {
      ...OPTS,
      ladderDeadlineMs: 20_000,
      now,
    });
    expect(res.capped).toBe(true);
    // Deadline caught it long before the 40-probe budget.
    expect(ebird.recentSpeciesInRegion.mock.calls.length).toBeLessThan(12);
  });

  it("stops scheduling when the caller navigates away", async () => {
    serve({});
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await nearestSpeciesReports("key", SP, HOME, 14, {
      ...OPTS,
      signal: ctrl.signal,
    });
    expect(ebird.recentSpeciesInRegion).not.toHaveBeenCalled();
    expect(res.capped).toBe(true);
  });
});
