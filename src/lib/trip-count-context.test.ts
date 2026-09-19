import { describe, expect, it } from "vitest";
import {
  formatLegacyCountSnapshot,
  formatPlannedCountSnapshot,
  parseAnyTripCountContext,
  parseTripCountContext,
} from "./trip-count-context";

const valid = {
  version: 1,
  source: "area-recent-preview",
  seenStatus: "needs",
  daysBack: 30,
  anchorLat: 44.4,
  anchorLng: -68.6,
  radiusKm: 40,
  anchorLabel: "Huguenot",
  locationId: "L1",
  locationLat: 44.41,
  locationLng: -68.61,
  count: 1,
  fetchedAt: "2026-09-18T12:00:00.000Z",
  plannedAt: "2026-09-18T12:01:00.000Z",
  stale: false,
} as const;

describe("trip count context", () => {
  it("strictly validates and canonicalizes the v1 shape", () => {
    expect(parseTripCountContext(valid)).toEqual(valid);
    expect(parseTripCountContext({ ...valid, fetchedAt: "2026" })).toBeNull();
    expect(parseTripCountContext({ ...valid, count: 1.5 })).toBeNull();
    expect(parseTripCountContext({ ...valid, extra: true })).toBeNull();
  });

  it("formats mode-aware snapshots and unknown legacy counts", () => {
    const text = formatPlannedCountSnapshot(valid, "25 mi");
    expect(text).toContain("When planned: 1 need");
    expect(text).toContain("last 30 days");
    expect(
      formatPlannedCountSnapshot(
        { ...valid, seenStatus: "all", count: 4 },
        "25 mi",
      ),
    ).toContain("4 species");
    expect(formatLegacyCountSnapshot(7)).toBe(
      "When planned: 7 matches; original scope and window were not recorded.",
    );
  });

  it("strictly parses and formats the v2 per-hotspot source", () => {
    const v2 = {
      ...valid,
      version: 2 as const,
      source: "hotspot-notable" as const,
      reportPolicy: "including-unconfirmed" as const,
      locationId: "L1",
    };
    expect(parseAnyTripCountContext({ ...v2, extra: true })).toBeNull();
    const parsed = parseAnyTripCountContext(v2);
    expect(parsed).toEqual(v2);
    expect(formatPlannedCountSnapshot(v2, "25 mi")).toContain(
      "notable/rare reports",
    );
    expect(formatPlannedCountSnapshot(v2, "25 mi")).toContain(
      "includes unconfirmed reports",
    );
  });
});
