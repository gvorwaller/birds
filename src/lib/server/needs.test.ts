import { describe, expect, it } from "vitest";
import { aggregate, rankPlaces } from "./needs";
import type { EbirdObs } from "./ebird";

function obs(
  p: Partial<EbirdObs> &
    Pick<
      EbirdObs,
      "speciesCode" | "comName" | "locId" | "locName" | "obsDt" | "lat" | "lng"
    >,
): EbirdObs {
  return {
    sciName: `${p.comName} sci`,
    howMany: 1,
    obsValid: true,
    obsReviewed: false,
    locationPrivate: false,
    ...p,
  };
}

describe("aggregate", () => {
  it("totals report count and bird count per species and place", () => {
    const activity = aggregate(
      [
        obs({
          speciesCode: "ospre1",
          comName: "Osprey",
          locId: "L1",
          locName: "Harbor",
          lat: 44.4,
          lng: -68.6,
          obsDt: "2026-06-20 08:00",
          howMany: 3,
        }),
        obs({
          speciesCode: "ospre1",
          comName: "Osprey",
          locId: "L1",
          locName: "Harbor",
          lat: 44.4,
          lng: -68.6,
          obsDt: "2026-06-21 08:00",
          howMany: 2,
        }),
        obs({
          speciesCode: "ospre1",
          comName: "Osprey",
          locId: "L2",
          locName: "Point",
          lat: 44.42,
          lng: -68.62,
          obsDt: "2026-06-22 08:00",
        }),
      ],
      null,
      new Map(),
    );

    const osprey = activity.get("ospre1")!;
    expect(osprey.nReports).toBe(3);
    expect(osprey.totalCount).toBe(6);
    expect(osprey.locationCount).toBe(2);
    expect(osprey.places).toHaveLength(2);
    expect(osprey.places.find((p) => p.locId === "L1")).toMatchObject({
      nReports: 2,
      totalCount: 5,
    });
    expect(osprey.places.find((p) => p.locId === "L2")).toMatchObject({
      nReports: 1,
      totalCount: 1,
    });
  });
});

describe("rankPlaces", () => {
  it("ranks places by distinct current needs and marks verified hotspots", () => {
    const places = rankPlaces(
      [
        obs({
          speciesCode: "ospre1",
          comName: "Osprey",
          locId: "L1",
          locName: "Harbor",
          lat: 44.4,
          lng: -68.6,
          obsDt: "2026-06-20 08:00",
        }),
        obs({
          speciesCode: "bkcchi",
          comName: "Black-capped Chickadee",
          locId: "L1",
          locName: "Harbor",
          lat: 44.4,
          lng: -68.6,
          obsDt: "2026-06-21 08:00",
        }),
        obs({
          speciesCode: "amecro",
          comName: "American Crow",
          locId: "L2",
          locName: "Point",
          lat: 44.42,
          lng: -68.62,
          obsDt: "2026-06-22 08:00",
        }),
      ],
      new Set(["amecro"]),
      { lat: 44.4, lon: -68.6 },
      new Map([["L1", "ChIJHarbor"]]),
      new Set(["L1"]),
    );

    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({
      locId: "L1",
      locName: "Harbor",
      googlePlaceId: "ChIJHarbor",
      isHotspot: true,
      needCount: 2,
    });
    expect(places[0].needSpecies.map((s) => s.code).sort()).toEqual([
      "bkcchi",
      "ospre1",
    ]);
  });
});
