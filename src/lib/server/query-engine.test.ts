import { describe, it, expect } from "vitest";
import { buildCandidates, validateTripParams, BOUNDS } from "./query-engine";
import { nearestNeighborOrder } from "$lib/geo";
import type { EbirdObs } from "$server/ebird";

/** Build a minimal EbirdObs with sensible defaults for the fields the engine ignores. */
function obs(p: {
  speciesCode: string;
  comName: string;
  locId: string;
  locName: string;
  lat: number;
  lng: number;
  obsDt: string;
}): EbirdObs {
  return {
    sciName: `${p.comName} sci`,
    howMany: 1,
    obsValid: true,
    obsReviewed: false,
    locationPrivate: false,
    ...p,
  };
}

// Anchor near Blue Hill, ME. Seen list = American Crow + Song Sparrow.
const anchor = { lat: 44.4, lng: -68.6 };
const seen = new Set(["amecro", "sonspa"]);

const fixture: EbirdObs[] = [
  // Marsh (L1): 2 needs (norcar, bkcchi) + 1 seen (amecro, excluded under 'needs')
  obs({
    speciesCode: "norcar",
    comName: "Northern Cardinal",
    locId: "L1",
    locName: "Marsh",
    lat: 44.41,
    lng: -68.61,
    obsDt: "2026-06-12 08:00",
  }),
  obs({
    speciesCode: "norcar",
    comName: "Northern Cardinal",
    locId: "L1",
    locName: "Marsh",
    lat: 44.41,
    lng: -68.61,
    obsDt: "2026-06-10 08:00",
  }),
  obs({
    speciesCode: "bkcchi",
    comName: "Black-capped Chickadee",
    locId: "L1",
    locName: "Marsh",
    lat: 44.41,
    lng: -68.61,
    obsDt: "2026-06-13 08:00",
  }),
  obs({
    speciesCode: "amecro",
    comName: "American Crow",
    locId: "L1",
    locName: "Marsh",
    lat: 44.41,
    lng: -68.61,
    obsDt: "2026-06-13 08:00",
  }),
  // Point (L2): 1 need
  obs({
    speciesCode: "ospre1",
    comName: "Osprey",
    locId: "L2",
    locName: "Point",
    lat: 44.42,
    lng: -68.55,
    obsDt: "2026-06-11 08:00",
  }),
  // Cove (L3): 4 needs
  obs({
    speciesCode: "norcar",
    comName: "Northern Cardinal",
    locId: "L3",
    locName: "Cove",
    lat: 44.38,
    lng: -68.63,
    obsDt: "2026-06-14 08:00",
  }),
  obs({
    speciesCode: "bkcchi",
    comName: "Black-capped Chickadee",
    locId: "L3",
    locName: "Cove",
    lat: 44.38,
    lng: -68.63,
    obsDt: "2026-06-14 08:00",
  }),
  obs({
    speciesCode: "ospre1",
    comName: "Osprey",
    locId: "L3",
    locName: "Cove",
    lat: 44.38,
    lng: -68.63,
    obsDt: "2026-06-14 08:00",
  }),
  obs({
    speciesCode: "htlwoo",
    comName: "Hairy Woodpecker",
    locId: "L3",
    locName: "Cove",
    lat: 44.38,
    lng: -68.63,
    obsDt: "2026-06-09 08:00",
  }),
  // FarAway (L9): outside the 16 km radius — must be excluded
  obs({
    speciesCode: "commer",
    comName: "Common Merganser",
    locId: "L9",
    locName: "FarAway",
    lat: 45.1,
    lng: -68.6,
    obsDt: "2026-06-14 08:00",
  }),
];

const baseFilter = {
  anchorLat: anchor.lat,
  anchorLng: anchor.lng,
  radiusKm: 16,
} as const;

describe("buildCandidates", () => {
  it("ranks by need count, excludes seen species, filters radius, flags eligibility", () => {
    const c = buildCandidates(fixture, seen, {
      ...baseFilter,
      seenStatus: "needs",
      minNeedsPerStop: 2,
    });

    expect(c).toHaveLength(3); // FarAway dropped by radius
    expect(c.some((x) => x.locName === "FarAway")).toBe(false);

    expect(c[0].locName).toBe("Cove"); // highest matchCount first
    expect(c[0].matchCount).toBe(4);

    const marsh = c.find((x) => x.locName === "Marsh")!;
    expect(marsh.matchCount).toBe(2); // seen American Crow excluded
    expect(marsh.eligible).toBe(true);
    expect(marsh.googlePlaceId).toBeNull();

    const point = c.find((x) => x.locName === "Point")!;
    expect(point.matchCount).toBe(1);
    expect(point.eligible).toBe(false); // 1 < minNeedsPerStop 2

    // trigger species are de-duped and carry the most-recent obs date
    expect(c[0].triggerSpecies.map((t) => t.code).sort()).toEqual([
      "bkcchi",
      "htlwoo",
      "norcar",
      "ospre1",
    ]);
  });

  it("carries Google place IDs from the location metadata map", () => {
    const c = buildCandidates(
      fixture,
      seen,
      {
        ...baseFilter,
        seenStatus: "needs",
        minNeedsPerStop: 1,
      },
      new Map([["L3", "ChIJCove"]]),
    );
    expect(c.find((x) => x.locId === "L3")?.googlePlaceId).toBe("ChIJCove");
  });

  it("seenStatus 'all' counts seen species too", () => {
    const c = buildCandidates(fixture, seen, {
      ...baseFilter,
      seenStatus: "all",
      minNeedsPerStop: 1,
    });
    const marsh = c.find((x) => x.locName === "Marsh")!;
    expect(marsh.matchCount).toBe(3); // norcar, bkcchi, amecro
  });
});

describe("nearestNeighborOrder", () => {
  it("orders points greedily from the origin (deterministic)", () => {
    const pts = [
      { lat: 44.38, lng: -68.63, id: "cove" }, // ~3.3 km from anchor
      { lat: 44.41, lng: -68.61, id: "marsh" }, // ~1.4 km from anchor
    ];
    const out = nearestNeighborOrder(anchor, pts);
    expect(out.map((p) => p.id)).toEqual(["marsh", "cove"]);
  });
});

describe("validateTripParams", () => {
  const base = {
    anchorLat: 44.4,
    anchorLng: -68.6,
    anchorLabel: "Blue Hill, ME",
    radiusKm: 16,
    daysBack: 14,
    numStops: 3,
    minNeedsPerStop: 2,
  };

  it("accepts valid params and fills flag defaults", () => {
    const r = validateTripParams(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.seenStatus).toBe("needs");
      expect(r.value.rareOnly).toBe(false);
      expect(r.value.includeHistoricalStop).toBe(false);
    }
  });

  it("rejects out-of-range magnitudes with explicit errors (no silent clamp)", () => {
    const tooWide = validateTripParams({
      ...base,
      radiusKm: BOUNDS.radiusKm.max + 30,
    });
    expect(tooWide.ok).toBe(false);
    if (!tooWide.ok) expect(tooWide.errors.join(" ")).toMatch(/Radius/);

    expect(
      validateTripParams({ ...base, daysBack: BOUNDS.daysBack.max + 15 }).ok,
    ).toBe(false);
    expect(validateTripParams({ ...base, numStops: 0 }).ok).toBe(false);
    expect(
      validateTripParams({
        ...base,
        minNeedsPerStop: BOUNDS.minNeedsPerStop.max + 1,
      }).ok,
    ).toBe(false);
  });
});
