/**
 * The streamed-enrichment half of the Home loader (td-d561a8).
 *
 * These cover the contract the design review put the most weight on: that
 * enrichment MERGES into the base row instead of overwriting it, so no number
 * the page has already shown can shrink when the stream lands, and that a
 * failure anywhere in the deferred phase degrades one row rather than the
 * section.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EbirdObs } from "./ebird";

const ebird = vi.hoisted(() => ({
  recentObs: vi.fn(),
  notableObs: vi.fn(),
  recentNearbyObs: vi.fn(),
  notableNearbyObs: vi.fn(),
  recentNearbySpeciesObs: vi.fn(),
  EbirdError: class EbirdError extends Error {},
}));
const placeids = vi.hoisted(() => ({
  hydrateEbirdLocationPlaceIds: vi.fn(),
}));
const hotspots = vi.hoisted(() => ({ verifiedHotspotLocIds: vi.fn() }));

vi.mock("$server/ebird", () => ebird);
vi.mock("$server/location-placeids", () => placeids);
vi.mock("$server/hotspots", () => hotspots);

const { aggregate, enrichNeedsWithSpeciesReports, geoTargetsBase } =
  await import("./needs");

const ORIGIN = { lat: 30.33, lon: -81.66 };

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

/** One need as the BASE area feed produces it: a single observation. */
function baseNeed(rows: EbirdObs[]) {
  return [...aggregate(rows, ORIGIN, new Map()).values()][0];
}

const AREA_ROW = obs({
  speciesCode: "gbbgul",
  comName: "Great Black-backed Gull",
  locId: "L1",
  locName: "Huguenot Park",
  obsDt: "2026-08-30 08:00",
  howMany: 2,
  lat: 30.4,
  lng: -81.4,
});

/** The per-species feed: the same place plus two more, with real counts. */
const DETAIL_ROWS = [
  AREA_ROW,
  obs({ ...AREA_ROW, obsDt: "2026-08-29 07:00", howMany: 3 }),
  obs({
    speciesCode: "gbbgul",
    comName: "Great Black-backed Gull",
    locId: "L2",
    locName: "Big Talbot",
    obsDt: "2026-08-28 09:00",
    howMany: 4,
    lat: 30.5,
    lng: -81.45,
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  placeids.hydrateEbirdLocationPlaceIds.mockResolvedValue(new Map());
});

describe("enrichNeedsWithSpeciesReports", () => {
  it("merges the detail feed into the base row: places union, counts derived from it", async () => {
    const base = baseNeed([AREA_ROW]);
    expect(base.enriched).toBe(false);
    expect(base.locationCount).toBe(1); // the area feed's one row

    ebird.recentNearbySpeciesObs.mockResolvedValue({
      data: DETAIL_ROWS,
      stale: false,
      fetchedAt: new Date(),
    });

    const { needs, partial } = await enrichNeedsWithSpeciesReports(
      [base],
      "key",
      ORIGIN,
      40,
      7,
      new Map(),
    );

    expect(partial).toBe(false);
    const n = needs[0];
    expect(n.enriched).toBe(true);
    expect(n.locationCount).toBe(2);
    // Summary is derived FROM the merged places, so the two cannot disagree.
    expect(n.nReports).toBe(n.places.reduce((a, p) => a + p.nReports, 0));
    expect(n.totalCount).toBe(n.places.reduce((a, p) => a + p.totalCount, 0));
    expect(n.totalCount).toBe(9);
    expect(n.places.map((p) => p.locId).sort()).toEqual(["L1", "L2"]);
  });

  it("never lets a shown number shrink when the detail payload is smaller", async () => {
    // A base row the detail feed does not know about (a different cache
    // generation, or a place the species feed no longer returns). Overwriting
    // would drop "1 location" to "0" — a precise number correcting downward.
    const base = baseNeed([AREA_ROW]);
    ebird.recentNearbySpeciesObs.mockResolvedValue({
      data: [
        obs({
          speciesCode: "gbbgul",
          comName: "Great Black-backed Gull",
          locId: "L9",
          locName: "Somewhere else",
          obsDt: "2026-08-20 06:00",
          howMany: 1,
          lat: 30.6,
          lng: -81.5,
        }),
      ],
      stale: false,
      fetchedAt: new Date(),
    });

    const { needs } = await enrichNeedsWithSpeciesReports(
      [base],
      "key",
      ORIGIN,
      40,
      7,
      new Map(),
    );

    expect(needs[0].locationCount).toBeGreaterThanOrEqual(base.locationCount);
    expect(needs[0].totalCount).toBeGreaterThanOrEqual(base.totalCount);
    expect(needs[0].nReports).toBeGreaterThanOrEqual(base.nReports);
    // The base place survives rather than being replaced.
    expect(needs[0].places.map((p) => p.locId).sort()).toEqual(["L1", "L9"]);
  });

  it("keeps the newer report as the row's last-report anchor", async () => {
    const base = baseNeed([AREA_ROW]);
    ebird.recentNearbySpeciesObs.mockResolvedValue({
      data: [obs({ ...AREA_ROW, obsDt: "2026-08-20 06:00" })],
      stale: false,
      fetchedAt: new Date(),
    });
    const { needs } = await enrichNeedsWithSpeciesReports(
      [base],
      "key",
      ORIGIN,
      40,
      7,
      new Map(),
    );
    // The area feed's row is the newer one; enrichment must not walk it back.
    expect(needs[0].lastObsDt).toBe("2026-08-30 08:00");
    expect(needs[0].lastLat).toBe(AREA_ROW.lat);
  });

  it("hydrates ONCE for the whole fan-out, not once per species", async () => {
    const needs = [
      baseNeed([AREA_ROW]),
      baseNeed([obs({ ...AREA_ROW, speciesCode: "laugul", comName: "Laughing Gull" })]),
      baseNeed([obs({ ...AREA_ROW, speciesCode: "ribgul", comName: "Ring-billed Gull" })]),
    ];
    ebird.recentNearbySpeciesObs.mockImplementation((_k: string, code: string) =>
      Promise.resolve({
        data: [obs({ ...AREA_ROW, speciesCode: code })],
        stale: false,
        fetchedAt: new Date(),
      }),
    );

    await enrichNeedsWithSpeciesReports(needs, "key", ORIGIN, 40, 7, new Map());

    // One batched hydrate for the merge; the second call is the detached
    // Google resolution, which no request waits on.
    const blocking = placeids.hydrateEbirdLocationPlaceIds.mock.calls.filter(
      (c) => c[1]?.resolveMissing === false,
    );
    expect(blocking).toHaveLength(1);
  });

  it("keeps Google resolution off the streamed path", async () => {
    ebird.recentNearbySpeciesObs.mockResolvedValue({
      data: DETAIL_ROWS,
      stale: false,
      fetchedAt: new Date(),
    });
    await enrichNeedsWithSpeciesReports(
      [baseNeed([AREA_ROW])],
      "key",
      ORIGIN,
      40,
      7,
      new Map(),
    );
    // Serial Google lookups (5 s deadline each) must never gate the promise
    // that decides when place details appear.
    const [, opts] = placeids.hydrateEbirdLocationPlaceIds.mock.calls[0];
    expect(opts).toEqual({ resolveMissing: false });
  });

  it("degrades one species when its call fails, not the section", async () => {
    const ok = baseNeed([AREA_ROW]);
    const bad = baseNeed([
      obs({ ...AREA_ROW, speciesCode: "laugul", comName: "Laughing Gull" }),
    ]);
    ebird.recentNearbySpeciesObs.mockImplementation((_k: string, code: string) =>
      code === "laugul"
        ? Promise.reject(new Error("429"))
        : Promise.resolve({
            data: DETAIL_ROWS,
            stale: false,
            fetchedAt: new Date(),
          }),
    );

    const { needs, partial } = await enrichNeedsWithSpeciesReports(
      [ok, bad],
      "key",
      ORIGIN,
      40,
      7,
      new Map(),
    );

    expect(partial).toBe(true);
    expect(needs[0].enriched).toBe(true);
    expect(needs[1].enriched).toBe(false); // keeps its base row, untouched
    expect(needs[1].locationCount).toBe(bad.locationCount);
  });

  it("survives a failed batch hydrate with lat/lng links intact", async () => {
    placeids.hydrateEbirdLocationPlaceIds.mockRejectedValue(new Error("db down"));
    ebird.recentNearbySpeciesObs.mockResolvedValue({
      data: DETAIL_ROWS,
      stale: false,
      fetchedAt: new Date(),
    });

    const { needs, partial } = await enrichNeedsWithSpeciesReports(
      [baseNeed([AREA_ROW])],
      "key",
      ORIGIN,
      40,
      7,
      new Map(),
    );

    // Resolves rather than rejecting the whole streamed section: the
    // observations were already fetched, and only the Google deep links go.
    expect(partial).toBe(true);
    expect(needs[0].enriched).toBe(true);
    expect(needs[0].places.length).toBe(2);
    expect(needs[0].places.every((p) => p.googlePlaceId === null)).toBe(true);
    expect(needs[0].places.every((p) => Number.isFinite(p.lat))).toBe(true);
  });

  it("stops scheduling species calls once the request is aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const needs = [
      baseNeed([AREA_ROW]),
      baseNeed([obs({ ...AREA_ROW, speciesCode: "laugul", comName: "Laughing Gull" })]),
    ];

    const res = await enrichNeedsWithSpeciesReports(
      needs,
      "key",
      ORIGIN,
      40,
      7,
      new Map(),
      new Set(),
      { signal: ctrl.signal },
    );

    expect(ebird.recentNearbySpeciesObs).not.toHaveBeenCalled();
    expect(res.partial).toBe(true);
    expect(res.needs.every((n) => !n.enriched)).toBe(true);
  });
});

describe("geoTargetsBase", () => {
  const cached = (data: EbirdObs[], stale = false) => ({
    data,
    stale,
    fetchedAt: new Date("2026-08-31T12:00:00Z"),
  });

  beforeEach(() => {
    ebird.recentNearbyObs.mockResolvedValue(cached([AREA_ROW]));
    ebird.notableNearbyObs.mockResolvedValue(cached([]));
    hotspots.verifiedHotspotLocIds.mockResolvedValue({
      locIds: new Set<string>(),
      stale: false,
    });
  });

  it("returns a complete, un-enriched view without touching the fan-out", async () => {
    const { view } = await geoTargetsBase(
      new Set(),
      "key",
      ORIGIN.lat,
      ORIGIN.lon,
      40,
      7,
    );

    expect(ebird.recentNearbySpeciesObs).not.toHaveBeenCalled();
    expect(view.needs).toHaveLength(1);
    expect(view.needs[0].enriched).toBe(false);
    // bestPlaces comes from the base recent feed, so it is complete at first
    // paint and must not be advertised as pending.
    expect(view.bestPlaces).toHaveLength(1);
  });

  it("carries hotspot staleness into the badge at FIRST paint", async () => {
    hotspots.verifiedHotspotLocIds.mockResolvedValue({
      locIds: new Set<string>(),
      stale: true,
    });
    const { view } = await geoTargetsBase(
      new Set(),
      "key",
      ORIGIN.lat,
      ORIGIN.lon,
      40,
      7,
    );
    // Used to be ORed in only after enrichment, which post-split would leave
    // the shell claiming fresh data for ~2 s.
    expect(view.stale).toBe(true);
  });

  it("keeps serial Google lookups off the critical path", async () => {
    await geoTargetsBase(new Set(), "key", ORIGIN.lat, ORIGIN.lon, 40, 7);
    const [, opts] = placeids.hydrateEbirdLocationPlaceIds.mock.calls[0];
    expect(opts).toEqual({ resolveMissing: false });
  });

  it("excludes seen species from needs", async () => {
    const { view } = await geoTargetsBase(
      new Set(["gbbgul"]),
      "key",
      ORIGIN.lat,
      ORIGIN.lon,
      40,
      7,
    );
    expect(view.needs).toHaveLength(0);
    expect(view.seenCount).toBe(1);
  });
});
