import { describe, expect, it } from "vitest";
import { applyComparedRanking } from "./planner-comparison";

const candidate = (
  locId: string | null,
  isVerifiedHotspot: boolean,
  name = locId ?? "Yard",
) => ({
  locId,
  locName: name,
  lat: 30,
  lng: -81,
  googlePlaceId: null,
  distanceKm: 1,
  matchCount: 2,
  triggerSpecies: [],
  lastObsDt: "2026-09-19",
  eligible: true,
  isVerifiedHotspot,
});
const row = (locId: string, count: number, token: string) => ({
  locId,
  locName: locId,
  lat: 30,
  lng: -81,
  googlePlaceId: null,
  distanceKm: 1,
  state: "fresh" as const,
  count,
  species: [],
  latestObsDt: "2026-09-19",
  fetchedAt: "2026-09-19T00:00:00.000Z",
  stale: false,
  error: null,
  token,
});

describe("planner comparison merge", () => {
  it("deduplicates a manually selected unverified location when comparison verifies it and uses its v2 token", () => {
    const yard = candidate("L1", false, "Yard");
    const result = applyComparedRanking({
      rows: [row("L1", 4, "v2")],
      originalCandidates: [yard],
      previousCandidates: [yard],
      selectedKeys: new Set(["L1"]),
      existingTokens: { L1: "v1" },
      minNeeds: 2,
      requestedStops: 1,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      locId: "L1",
      isVerifiedHotspot: true,
      matchCount: 4,
    });
    expect(result.selectedKeys).toEqual(new Set(["L1"]));
    expect(result.tokens.L1).toBe("v2");
  });

  it("replaces a prior compared selection on a second apply while retaining distinct manual places", () => {
    const first = candidate("L1", true);
    const manual = candidate(null, false, "Yard");
    const result = applyComparedRanking({
      rows: [row("L1", 1, "new")],
      originalCandidates: [first, manual],
      previousCandidates: [first, manual],
      selectedKeys: new Set(["L1", "30,-81"]),
      existingTokens: {},
      minNeeds: 2,
      requestedStops: 2,
    });
    expect(result.selectedKeys).toEqual(new Set(["30,-81"]));
    expect(result.candidates.filter((c) => c.locId === "L1")).toHaveLength(1);
  });

  it("replaces an old verified choice on first apply and fills another eligible slot", () => {
    const old = candidate("L1", true);
    const result = applyComparedRanking({
      rows: [
        row("L1", 1, "new-1"),
        row("L2", 4, "new-2"),
        row("L3", 3, "new-3"),
      ],
      originalCandidates: [old],
      previousCandidates: [old],
      selectedKeys: new Set(["L1"]),
      existingTokens: {},
      minNeeds: 2,
      requestedStops: 2,
    });
    expect(result.selectedKeys).toEqual(new Set(["L2", "L3"]));
  });
});

it("adds no automatic stop when retained manual locations already fill requested slots", () => {
  const manual = candidate("L9", false);
  const result = applyComparedRanking({
    rows: [row("L1", 10, "v2")],
    originalCandidates: [manual],
    previousCandidates: [manual],
    selectedKeys: new Set(["L9"]),
    existingTokens: { L9: "v1" },
    minNeeds: 1,
    requestedStops: 1,
  });
  expect(result.selectedKeys).toEqual(new Set(["L9"]));
});
