import { describe, expect, it } from "vitest";
import {
  aggregateComparisonObservations,
  chunkIds,
  comparisonComplete,
  progressForRows,
  sortedComparisonRows,
} from "./hotspot-comparison";

const row = (code: string, locId = "L1", obsDt = "2026-09-19 12:00") => ({
  speciesCode: code,
  comName: code,
  sciName: `${code} scientific`,
  locId,
  obsDt,
  lat: 30,
  lng: -81,
  obsValid: false,
});

describe("hotspot comparison", () => {
  it("counts distinct species only at the requested location and applies needs", () => {
    const all = aggregateComparisonObservations(
      [row("a"), row("a", "L1", "2026-09-19 13:00"), row("b"), row("c", "L2")],
      "L1",
      new Set(["b"]),
      "all",
    );
    expect(all).toMatchObject({ ok: true, count: 2 });
    const needs = aggregateComparisonObservations(
      [row("a"), row("b")],
      "L1",
      new Set(["b"]),
      "needs",
    );
    expect(needs).toMatchObject({ ok: true, count: 1 });
  });

  it("distinguishes reported zero from malformed responses", () => {
    expect(
      aggregateComparisonObservations([], "L1", new Set(), "all"),
    ).toMatchObject({ ok: true, count: 0, latestObsDt: null });
    expect(
      aggregateComparisonObservations({}, "L1", new Set(), "all"),
    ).toMatchObject({ ok: false });
    expect(
      aggregateComparisonObservations(
        [{ speciesCode: "a" }],
        "L1",
        new Set(),
        "all",
      ),
    ).toMatchObject({ ok: false });
  });

  it("sorts successful rows before unknown rows with stable ties and reports all work", () => {
    const base = {
      locName: "x",
      lat: 30,
      lng: -81,
      distanceKm: 1,
      googlePlaceId: null,
      state: "fresh" as const,
      count: 2,
      species: [],
      latestObsDt: "2026-09-19",
      fetchedAt: "2026-09-19T00:00:00.000Z",
      stale: false,
      error: null,
      token: "t",
    };
    const rows = [
      { ...base, locId: "L2" },
      { ...base, locId: "L1", count: 3 },
      {
        ...base,
        locId: "L3",
        state: "unqueried" as const,
        count: null,
        token: null,
      },
    ];
    expect(sortedComparisonRows(rows).map((r) => r.locId)).toEqual([
      "L1",
      "L2",
      "L3",
    ]);
    expect(progressForRows(rows)).toMatchObject({
      total: 3,
      checked: 2,
      fresh: 2,
      unqueried: 1,
    });
    expect(comparisonComplete(rows, false)).toBe(false);
    expect(comparisonComplete(rows.slice(0, 2), false)).toBe(true);
  });

  it("keeps every reference across batches of four", () => {
    expect(chunkIds(["1", "2", "3", "4", "5", "6"], 4)).toEqual([
      ["1", "2", "3", "4"],
      ["5", "6"],
    ]);
  });
});
