import { describe, expect, it } from "vitest";
import {
  buildPlaceIndex,
  MAX_PLACE_RESULTS,
  placeKey,
  searchPlaces,
  speciesAtPlace,
  type IndexedPlace,
  type IndexedSpecies,
} from "./place-search";

function place(over: Partial<IndexedPlace> = {}): IndexedPlace {
  return {
    locId: "L1",
    locName: "Huguenot Memorial Park",
    lat: 30.41,
    lng: -81.42,
    googlePlaceId: null,
    isHotspot: false,
    distanceKm: 10,
    lastObsDt: "2026-07-20 08:00",
    nReports: 1,
    totalCount: 1,
    ...over,
  };
}

function species(
  code: string,
  places: IndexedPlace[],
  over: Partial<IndexedSpecies> = {},
): IndexedSpecies {
  return {
    speciesCode: code,
    comName: code.toUpperCase(),
    sciName: `Sci ${code}`,
    places,
    ...over,
  };
}

describe("placeKey", () => {
  it("prefers locId", () => {
    expect(placeKey("L123", 30.41, -81.42)).toBe("L123");
  });

  it("falls back to rounded coordinates", () => {
    expect(placeKey(null, 30.4100001, -81.4200001)).toBe("30.41000,-81.42000");
    // Float noise below the rounding threshold must not split one place.
    expect(placeKey(null, 30.410001, -81.42)).toBe(
      placeKey(null, 30.410002, -81.42),
    );
  });

  it("treats an empty-string locId as absent (|| not ??)", () => {
    // With `??` every empty-id record would key as "" and collapse together.
    expect(placeKey("", 30.41, -81.42)).toBe("30.41000,-81.42000");
    expect(placeKey("", 1, 2)).not.toBe(placeKey("", 3, 4));
  });
});

describe("buildPlaceIndex", () => {
  it("merges notable and needs into one entry per place", () => {
    const p = place();
    const index = buildPlaceIndex(
      [species("rarity", [p])],
      [species("need1", [p]), species("need2", [p])],
    );

    expect(index).toHaveLength(1);
    expect(index[0].locName).toBe("Huguenot Memorial Park");
    expect([...index[0].needCodes]).toEqual(["need1", "need2"]);
    expect([...index[0].notableCodes]).toEqual(["rarity"]);
  });

  it("counts a species that is both notable and needed in both sets", () => {
    const p = place();
    const index = buildPlaceIndex(
      [species("both", [p])],
      [species("both", [p])],
    );
    expect(index[0].needCodes.has("both")).toBe(true);
    expect(index[0].notableCodes.has("both")).toBe(true);
    // Separate sets are what keep this from double-counting as "2 needs".
    expect(index[0].needCodes.size).toBe(1);
  });

  it("keeps distinct places apart and keys locId-less ones by coords", () => {
    const index = buildPlaceIndex(
      [],
      [
        species("a", [place({ locId: "L1" })]),
        species("b", [place({ locId: null, lat: 31, lng: -82 })]),
      ],
    );
    expect(index).toHaveLength(2);
    expect(index.map((p) => p.key).sort()).toEqual([
      "31.00000,-82.00000",
      "L1",
    ]);
  });

  it("folds a coordinate-keyed record into the locId entry for the same place", () => {
    const index = buildPlaceIndex(
      [],
      [
        species("a", [place({ locId: "L1", lat: 30.41, lng: -81.42 })]),
        species("b", [place({ locId: null, lat: 30.41, lng: -81.42 })]),
      ],
    );
    expect(index).toHaveLength(1);
    expect(index[0].key).toBe("L1");
    expect([...index[0].needCodes].sort()).toEqual(["a", "b"]);
  });

  it("refuses to fold when a coordinate record is near TWO locId hosts", () => {
    // Ambiguous: picking a winner would make the summary owner depend on feed
    // iteration order, and membership would disagree with the counts.
    const index = buildPlaceIndex(
      [],
      [
        species("a", [place({ locId: "L1", lat: 30.41, lng: -81.42 })]),
        species("b", [place({ locId: "L2", lat: 30.41005, lng: -81.42 })]),
        species("c", [place({ locId: null, lat: 30.41, lng: -81.42 })]),
      ],
    );
    expect(index).toHaveLength(3);
    // The unfolded record owns its own species and neither host claims it.
    const hosts = index.filter((p) => p.locId);
    for (const h of hosts) expect(h.needCodes.has("c")).toBe(false);
  });

  it("records exact membership so focus can never disagree with the counts", () => {
    const index = buildPlaceIndex(
      [],
      [
        species("a", [place({ locId: "L1", lat: 30.41, lng: -81.42 })]),
        species("b", [place({ locId: null, lat: 30.41, lng: -81.42 })]),
      ],
    );
    expect(index).toHaveLength(1);
    expect([...index[0].memberKeys].sort()).toEqual([
      "30.41000,-81.42000",
      "L1",
    ]);
  });

  it("does not fold coordinates that are genuinely far apart", () => {
    const index = buildPlaceIndex(
      [],
      [
        species("a", [place({ locId: "L1", lat: 30.41, lng: -81.42 })]),
        species("b", [place({ locId: null, lat: 30.5, lng: -81.42 })]),
      ],
    );
    expect(index).toHaveLength(2);
  });

  it("keeps the locId record's name and takes the newest date and nearest distance", () => {
    const index = buildPlaceIndex(
      [],
      [
        species("a", [
          place({
            locId: "L1",
            locName: "Official Name",
            lastObsDt: "2026-07-01 06:00",
            distanceKm: 12,
          }),
        ]),
        species("b", [
          place({
            locId: null,
            locName: "Someone's Backyard",
            lastObsDt: "2026-07-25 06:00",
            distanceKm: 9,
          }),
        ]),
      ],
    );
    expect(index).toHaveLength(1);
    expect(index[0].locName).toBe("Official Name");
    expect(index[0].lastObsDt).toBe("2026-07-25 06:00");
    expect(index[0].distanceKm).toBe(9);
  });

  it("keeps the first name when one locId reports conflicting names", () => {
    const index = buildPlaceIndex(
      [],
      [
        species("a", [place({ locId: "L1", locName: "First Name" })]),
        species("b", [place({ locId: "L1", locName: "Second Name" })]),
      ],
    );
    expect(index).toHaveLength(1);
    expect(index[0].locName).toBe("First Name");
  });

  it("treats a hotspot flag on any record as authoritative", () => {
    const index = buildPlaceIndex(
      [],
      [
        species("a", [place({ isHotspot: false })]),
        species("b", [place({ isHotspot: true })]),
      ],
    );
    expect(index[0].isHotspot).toBe(true);
  });

  it("survives species with no places", () => {
    expect(buildPlaceIndex([], [species("a", [])])).toEqual([]);
  });
});

describe("searchPlaces", () => {
  const index = buildPlaceIndex(
    [species("rare", [place({ locId: "L2", locName: "Huguenot Beach" })])],
    [
      species("n1", [
        place({ locId: "L1", locName: "Huguenot Memorial Park" }),
      ]),
      species("n2", [
        place({ locId: "L1", locName: "Huguenot Memorial Park" }),
      ]),
      species("n3", [place({ locId: "L3", locName: "Downtown Cafe" })]),
    ],
  );

  it("finds places by misspelled name and excludes unrelated ones", () => {
    const hits = searchPlaces(index, "hugenot");
    expect(hits.map((p) => p.locName)).toEqual([
      "Huguenot Memorial Park",
      "Huguenot Beach",
    ]);
  });

  it("ranks by need count, then rarity, then recency, then distance", () => {
    const ranked = searchPlaces(
      buildPlaceIndex(
        [species("rare", [place({ locId: "R", locName: "Park Rare" })])],
        [
          species("a", [place({ locId: "M", locName: "Park Many" })]),
          species("b", [place({ locId: "M", locName: "Park Many" })]),
          species("c", [place({ locId: "R", locName: "Park Rare" })]),
          species("d", [place({ locId: "N", locName: "Park Near" })]),
        ],
      ),
      "park",
    );
    // Park Many has 2 needs; Rare and Near have 1 each, rarity breaks the tie.
    expect(ranked.map((p) => p.locName)).toEqual([
      "Park Many",
      "Park Rare",
      "Park Near",
    ]);
  });

  it("returns nothing for a query below the minimum length", () => {
    expect(searchPlaces(index, "hu")).toEqual([]);
  });

  it("caps the result list", () => {
    const many = buildPlaceIndex(
      [],
      Array.from({ length: MAX_PLACE_RESULTS + 8 }, (_, i) =>
        species(`s${i}`, [place({ locId: `L${i}`, locName: `Park ${i}` })]),
      ),
    );
    expect(many.length).toBeGreaterThan(MAX_PLACE_RESULTS);
    expect(searchPlaces(many, "park")).toHaveLength(MAX_PLACE_RESULTS);
  });
});

describe("speciesAtPlace", () => {
  it("narrows each species to the focused place without mutating input", () => {
    const here = place({ locId: "L1" });
    const elsewhere = place({ locId: "L9", locName: "Elsewhere" });
    const needs = [
      species("a", [here, elsewhere]),
      species("b", [elsewhere]),
      species("c", [here]),
    ];
    const index = buildPlaceIndex([], needs);
    const match = index.find((p) => p.key === "L1")!;

    const got = speciesAtPlace(match, needs);
    expect(got.map((s) => s.speciesCode)).toEqual(["a", "c"]);
    expect(got[0].places).toHaveLength(1);
    expect(got[0].places[0].locId).toBe("L1");

    // The loader's data is untouched.
    expect(needs[0].places).toHaveLength(2);
  });

  it("recomputes every aggregate field from the focused place", () => {
    // The loader's fields describe the WHOLE search area. Carrying them onto a
    // focused card claimed things like "65 locations · 110 birds" while showing
    // one place — contradicting the focused heading.
    const here = place({
      locId: "L1",
      locName: "Focused Place",
      nReports: 2,
      totalCount: 7,
      lastObsDt: "2026-07-10 06:00",
      distanceKm: 4,
      lat: 30.1,
      lng: -81.1,
    });
    const elsewhere = place({
      locId: "L9",
      locName: "Elsewhere",
      nReports: 63,
      totalCount: 103,
      lastObsDt: "2026-07-28 06:00",
      distanceKm: 1,
      lat: 31.9,
      lng: -82.9,
    });
    const needs = [
      {
        ...species("loon", [here, elsewhere]),
        // Whole-area aggregate, as the loader would ship it.
        nReports: 65,
        totalCount: 110,
        locationCount: 65,
        locations: ["Elsewhere", "Focused Place"],
        lastObsDt: "2026-07-28 06:00",
        lastLat: 31.9,
        lastLng: -82.9,
        distanceKm: 1,
      },
    ];
    const index = buildPlaceIndex([], needs);
    const match = index.find((p) => p.key === "L1")!;

    const [got] = speciesAtPlace(match, needs);
    expect(got.nReports).toBe(2);
    expect(got.totalCount).toBe(7);
    expect(got.locationCount).toBe(1);
    expect(got.locations).toEqual(["Focused Place"]);
    expect(got.lastObsDt).toBe("2026-07-10 06:00");
    expect(got.lastLat).toBe(30.1);
    expect(got.lastLng).toBe(-81.1);
    expect(got.distanceKm).toBe(4);

    // Input untouched.
    expect(needs[0].nReports).toBe(65);
    expect(needs[0].locationCount).toBe(65);
  });

  it("never carries a whole-area googlePlaceId onto a focused card", () => {
    // `mapsPlaceUrl` prefers a place id over coordinates, so a stale id would
    // open a DIFFERENT place in Google Maps than the card is showing.
    const needs = [
      {
        ...species("loon", [
          place({ locId: "L1", locName: "Focused", googlePlaceId: "GP-here" }),
          place({
            locId: "L9",
            locName: "Elsewhere",
            googlePlaceId: "GP-away",
          }),
        ]),
        googlePlaceId: "GP-away",
      },
    ];
    const index = buildPlaceIndex([], needs);
    const match = index.find((p) => p.key === "L1")!;

    const [got] = speciesAtPlace(match, needs);
    expect(got.googlePlaceId).toBe("GP-here");
    expect(got.places[0].googlePlaceId).toBe("GP-here");
  });

  it("collapses folded records into ONE canonical place", () => {
    // An locId record plus a coordinate-only record for the same physical
    // place must not render as two rows or claim locationCount 2.
    const needs = [
      species("a", [
        place({
          locId: "L1",
          locName: "Real Name",
          lat: 30.41,
          lng: -81.42,
          nReports: 2,
          totalCount: 5,
        }),
        place({
          locId: null,
          locName: "Personal Spot",
          lat: 30.41,
          lng: -81.42,
          nReports: 1,
          totalCount: 3,
        }),
      ]),
    ];
    const index = buildPlaceIndex([], needs);
    expect(index).toHaveLength(1);

    const [got] = speciesAtPlace(index[0], needs);
    expect(got.places).toHaveLength(1);
    expect(got.locationCount).toBe(1);
    expect(got.locations).toEqual(["Real Name"]);
    expect(got.places[0].locName).toBe("Real Name");
    // Counts from both raw records survive the collapse.
    expect(got.nReports).toBe(3);
    expect(got.totalCount).toBe(8);
  });

  it("includes records folded in by coordinate reconciliation", () => {
    // `b`'s record has no locId, so its own key is coordinate-based — but the
    // index folded it into L1. Filtering by key equality alone would drop it.
    const needs = [
      species("a", [place({ locId: "L1", lat: 30.41, lng: -81.42 })]),
      species("b", [place({ locId: null, lat: 30.41, lng: -81.42 })]),
    ];
    const index = buildPlaceIndex([], needs);
    expect(index).toHaveLength(1);

    const got = speciesAtPlace(index[0], needs);
    expect(got.map((s) => s.speciesCode)).toEqual(["a", "b"]);
  });
});
