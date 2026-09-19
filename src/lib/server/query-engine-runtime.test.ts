import { describe, expect, it, beforeEach, vi } from "vitest";

const ebird = vi.hoisted(() => ({
  recentNearbyObs: vi.fn(),
  notableNearbyObs: vi.fn(),
  hotspotsNear: vi.fn(),
}));
const needs = vi.hoisted(() => ({ seenSet: vi.fn() }));
const placeids = vi.hoisted(() => ({ hydrateEbirdLocationPlaceIds: vi.fn() }));
vi.mock("$server/ebird", () => ebird);
vi.mock("$server/needs", () => needs);
vi.mock("$server/location-placeids", () => placeids);

const { runQuery } = await import("./query-engine");

const row = {
  speciesCode: "ospre1",
  comName: "Osprey",
  sciName: "Pandion haliaetus",
  locId: "L35320851",
  locName: "Reported yard",
  obsDt: "2026-09-18 08:00",
  lat: 30.41,
  lng: -81.419,
  obsValid: true,
  obsReviewed: false,
  locationPrivate: false,
};
const filters = {
  anchorLat: 30.41,
  anchorLng: -81.419,
  anchorLabel: "Huguenot",
  radiusKm: 25,
  daysBack: 30,
  seenStatus: "needs" as const,
  rareOnly: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  needs.seenSet.mockResolvedValue(new Set());
  placeids.hydrateEbirdLocationPlaceIds.mockResolvedValue(new Map());
  ebird.recentNearbyObs.mockResolvedValue({
    data: [row],
    stale: false,
    fetchedAt: new Date("2026-09-18T12:00:00Z"),
  });
});

describe("runQuery hotspot verification boundary", () => {
  it("keeps observations and selects nothing automatically when reference fetch fails", async () => {
    ebird.hotspotsNear.mockRejectedValue(new Error("reference unavailable"));
    const result = await runQuery(1, "key", filters, 1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].isVerifiedHotspot).toBe(false);
    expect(result.hotspotVerification).toBe("unavailable");
    expect(ebird.hotspotsNear).toHaveBeenCalledTimes(1);
  });

  it("propagates stale reference state and uses its exact ids as evidence", async () => {
    ebird.hotspotsNear.mockResolvedValue({
      data: [
        {
          locId: "L35320851",
          locName: "Reported yard",
          lat: 30.41,
          lng: -81.419,
        },
      ],
      stale: true,
      fetchedAt: new Date("2026-09-17T12:00:00Z"),
    });
    const result = await runQuery(1, "key", filters, 1);
    expect(result.candidates[0].isVerifiedHotspot).toBe(true);
    expect(result.hotspotVerification).toBe("available");
    expect(result.stale).toBe(true);
  });
});
