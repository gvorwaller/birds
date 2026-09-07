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

  it("preserves eBird checklist subId for places and latest observation", () => {
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
          subId: "S100",
        }),
        obs({
          speciesCode: "ospre1",
          comName: "Osprey",
          locId: "L1",
          locName: "Harbor",
          lat: 44.4,
          lng: -68.6,
          obsDt: "2026-06-21 08:00",
          subId: "S200",
        }),
        obs({
          speciesCode: "ospre1",
          comName: "Osprey",
          locId: "L2",
          locName: "Point",
          lat: 44.42,
          lng: -68.62,
          obsDt: "2026-06-22 08:00",
          subId: "S300",
        }),
      ],
      null,
      new Map(),
    );

    const osprey = activity.get("ospre1")!;
    expect(osprey.lastSubId).toBe("S300");
    expect(osprey.places.find((p) => p.locId === "L1")?.subId).toBe("S200");
    expect(osprey.places.find((p) => p.locId === "L2")?.subId).toBe("S300");
  });

  it("keeps checklist ID strictly with latest report and does not backfill older ID (CODEX13 finding 1)", () => {
    // Order 1: Older report has subId, newer report has none
    const rows1 = [
      obs({
        speciesCode: "ospre1",
        comName: "Osprey",
        locId: "L1",
        locName: "Harbor",
        lat: 44.4,
        lng: -68.6,
        obsDt: "2026-06-20 08:00",
        subId: "S100",
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
    ];
    const act1 = aggregate(rows1, null, new Map()).get("ospre1")!;
    expect(act1.lastLat).toBe(44.42);
    expect(act1.lastObsDt).toBe("2026-06-22 08:00");
    expect(act1.lastSubId).toBeNull();
    expect(act1.places.find((p) => p.locId === "L1")?.subId).toBe("S100");
    expect(act1.places.find((p) => p.locId === "L2")?.subId).toBeNull();

    // Order 2: Reverse order in input
    const rows2 = [rows1[1], rows1[0]];
    const act2 = aggregate(rows2, null, new Map()).get("ospre1")!;
    expect(act2.lastLat).toBe(44.42);
    expect(act2.lastObsDt).toBe("2026-06-22 08:00");
    expect(act2.lastSubId).toBeNull();
    expect(act2.places.find((p) => p.locId === "L1")?.subId).toBe("S100");
    expect(act2.places.find((p) => p.locId === "L2")?.subId).toBeNull();

    // Same place: newer report has no subId -> place subId must be null
    const rowsPlace = [
      obs({
        speciesCode: "ospre1",
        comName: "Osprey",
        locId: "L1",
        locName: "Harbor",
        lat: 44.4,
        lng: -68.6,
        obsDt: "2026-06-20 08:00",
        subId: "S100",
      }),
      obs({
        speciesCode: "ospre1",
        comName: "Osprey",
        locId: "L1",
        locName: "Harbor",
        lat: 44.4,
        lng: -68.6,
        obsDt: "2026-06-21 08:00",
      }),
    ];
    const actPlace = aggregate(rowsPlace, null, new Map()).get("ospre1")!;
    expect(actPlace.places.find((p) => p.locId === "L1")?.subId).toBeNull();
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
