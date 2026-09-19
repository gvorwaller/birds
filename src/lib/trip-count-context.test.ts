import { describe, expect, it } from "vitest";
import { formatLegacyCountSnapshot, formatPlannedCountSnapshot, parseTripCountContext } from "./trip-count-context";

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
    expect(formatPlannedCountSnapshot({ ...valid, seenStatus: "all", count: 4 }, "25 mi")).toContain("4 species");
    expect(formatLegacyCountSnapshot(7)).toBe("When planned: 7 matches; original scope and window were not recorded.");
  });
});
