import { describe, expect, it } from "vitest";
import {
  aggregateComparisonObservations,
  chunkIds,
  comparisonComplete,
  comparisonQueryKey,
  comparisonStorageKey,
  comparisonStopMessage,
  parsePersistedComparison,
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
  it("restores only a valid account and filter scoped result", () => {
    const queryKey = comparisonQueryKey({
      lat: 30,
      lng: -81,
      radiusKm: 25,
      daysBack: 7,
      seenStatus: "needs",
      rareOnly: false,
      anchorLabel: "Home",
    });
    const reference = {
      locId: "L1",
      locName: "Marsh",
      lat: 30,
      lng: -81,
      distanceKm: 1,
      googlePlaceId: null,
    };
    const saved = JSON.stringify({
      version: 1,
      queryKey,
      savedAt: "2026-09-28T12:00:00.000Z",
      identity: "account-bound-identity",
      references: [reference],
      rows: [
        {
          ...reference,
          state: "fresh",
          count: 0,
          species: [],
          latestObsDt: null,
          fetchedAt: "2026-09-28T12:00:00.000Z",
          stale: false,
          error: null,
          token: "token",
        },
      ],
      referenceStale: false,
    });

    expect(comparisonStorageKey(7, queryKey)).toContain(`:7:${queryKey}`);
    expect(parsePersistedComparison(saved, queryKey)?.rows[0]?.count).toBe(0);
    expect(parsePersistedComparison(saved, `${queryKey}-other`)).toBeNull();
    expect(parsePersistedComparison("{broken", queryKey)).toBeNull();
    expect(
      parsePersistedComparison(
        saved.replace('"locId":"L1"', '"locId":"L2"'),
        queryKey,
      ),
    ).toBeNull();
  });

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

describe("comparisonStopMessage (td-5003e2)", () => {
  it("tells a bad key apart from being asked to slow down", () => {
    expect(comparisonStopMessage("auth", { unqueried: 297 })).toMatch(
      /authorization failed.*Settings/,
    );
    expect(
      comparisonStopMessage("rate", { unqueried: 297, resumeAfterMs: 600_000 }),
    ).toBe(
      "eBird asked us to slow down for about 10 min. 297 hotspots not checked yet; use Retry incomplete.",
    );
  });
  it("reports the true remaining counts when saving the hourly allowance", () => {
    expect(
      comparisonStopMessage("quota", { unqueried: 1, quotaRemaining: 97 }),
    ).toBe(
      "Stopped to save eBird's hourly request allowance for the rest of the app (97 of 500 left this hour). 1 hotspot not checked yet; use Retry incomplete later.",
    );
  });
});
