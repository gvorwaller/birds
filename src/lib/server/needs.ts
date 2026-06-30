/**
 * Needs/targets computation: recent eBird observations diffed against the
 * user's seen list. "Rare this week" = the notable feed, each entry badged
 * seen/need against the same list.
 */
import { query } from "$lib/db";
import { haversineKm } from "$lib/geo";
import { verifiedHotspotLocIds } from "$server/hotspots";
import { hydrateEbirdLocationPlaceIds } from "$server/location-placeids";
import {
  notableNearbyObs,
  notableObs,
  recentNearbyObs,
  recentNearbySpeciesObs,
  recentObs,
  type CachedResult,
  type EbirdObs,
} from "$server/ebird";

export interface SpeciesPlace {
  locId: string | null;
  locName: string;
  lat: number;
  lng: number;
  lastObsDt: string;
  nReports: number;
  totalCount: number;
  distanceKm: number | null;
  googlePlaceId: string | null;
}

export interface SpeciesActivity {
  speciesCode: string;
  comName: string;
  sciName: string;
  nReports: number;
  totalCount: number;
  /** Distinct reported locations for this species. */
  locationCount: number;
  lastObsDt: string;
  locations: string[];
  /** Every distinct place in range this species was reported, nearest first. */
  places: SpeciesPlace[];
  lastLat: number;
  lastLng: number;
  googlePlaceId: string | null;
  distanceKm: number | null;
  photoCount: number;
}

export interface NotableEntry extends SpeciesActivity {
  seen: boolean;
}

export interface PlaceRanking {
  locId: string | null;
  locName: string;
  lat: number;
  lng: number;
  googlePlaceId: string | null;
  isHotspot: boolean;
  needCount: number;
  needSpecies: { code: string; comName: string }[];
  lastObsDt: string;
  distanceKm: number | null;
}

export interface TargetsView {
  needs: SpeciesActivity[];
  notable: NotableEntry[];
  bestPlaces: PlaceRanking[];
  stale: boolean;
  fetchedAt: Date;
  seenCount: number;
}

/**
 * Rank locations by how many distinct *needs* were reported there. Built from
 * the same recent-obs payload used for the needs list — no extra API calls.
 */
export function rankPlaces(
  obs: EbirdObs[],
  seen: Set<string>,
  origin: { lat: number; lon: number } | null,
  locationPlaceIds: Map<string, string> = new Map(),
  hotspotLocIds: Set<string> = new Set(),
): PlaceRanking[] {
  interface Acc {
    locId: string | null;
    locName: string;
    lat: number;
    lng: number;
    species: Map<string, string>;
    lastObsDt: string;
  }
  const byLoc = new Map<string, Acc>();
  for (const o of obs) {
    if (!o.speciesCode || seen.has(o.speciesCode)) continue;
    const key = o.locId || `${o.lat},${o.lng}`;
    let p = byLoc.get(key);
    if (!p) {
      p = {
        locId: o.locId ?? null,
        locName: o.locName,
        lat: o.lat,
        lng: o.lng,
        species: new Map(),
        lastObsDt: o.obsDt,
      };
      byLoc.set(key, p);
    }
    if (!p.species.has(o.speciesCode)) p.species.set(o.speciesCode, o.comName);
    if (o.obsDt > p.lastObsDt) p.lastObsDt = o.obsDt;
  }
  return [...byLoc.values()]
    .map((p) => ({
      locId: p.locId,
      locName: p.locName,
      lat: p.lat,
      lng: p.lng,
      googlePlaceId: p.locId ? (locationPlaceIds.get(p.locId) ?? null) : null,
      isHotspot: p.locId ? hotspotLocIds.has(p.locId) : false,
      needCount: p.species.size,
      needSpecies: [...p.species.entries()].map(([code, comName]) => ({
        code,
        comName,
      })),
      lastObsDt: p.lastObsDt,
      distanceKm: origin
        ? haversineKm(origin.lat, origin.lon, p.lat, p.lng)
        : null,
    }))
    .sort(
      (a, b) =>
        b.needCount - a.needCount || b.lastObsDt.localeCompare(a.lastObsDt),
    );
}

export async function seenSet(userId: number): Promise<Set<string>> {
  const r = await query<{ species_code: string }>(
    "SELECT species_code FROM seen_species WHERE user_id = $1",
    [userId],
  );
  return new Set(r.rows.map((row) => row.species_code));
}

export function aggregate(
  obs: EbirdObs[],
  home: { lat: number; lon: number } | null,
  photoCounts: Map<string, number>,
  locationPlaceIds: Map<string, string> = new Map(),
): Map<string, SpeciesActivity> {
  const bySpecies = new Map<string, SpeciesActivity>();
  // Per-species accumulator of distinct places, keyed by speciesCode → locKey.
  const placesBySpecies = new Map<string, Map<string, SpeciesPlace>>();
  for (const o of obs) {
    if (!o.speciesCode) continue;
    let agg = bySpecies.get(o.speciesCode);
    if (!agg) {
      agg = {
        speciesCode: o.speciesCode,
        comName: o.comName,
        sciName: o.sciName,
        nReports: 0,
        totalCount: 0,
        locationCount: 0,
        lastObsDt: o.obsDt,
        locations: [],
        places: [],
        lastLat: o.lat,
        lastLng: o.lng,
        googlePlaceId: o.locId ? (locationPlaceIds.get(o.locId) ?? null) : null,
        distanceKm: null,
        photoCount: photoCounts.get(o.speciesCode) ?? 0,
      };
      bySpecies.set(o.speciesCode, agg);
      placesBySpecies.set(o.speciesCode, new Map());
    }
    agg.nReports++;
    agg.totalCount += o.howMany ?? 1;
    if (o.obsDt > agg.lastObsDt) {
      agg.lastObsDt = o.obsDt;
      agg.lastLat = o.lat;
      agg.lastLng = o.lng;
      agg.googlePlaceId = o.locId
        ? (locationPlaceIds.get(o.locId) ?? null)
        : null;
    }
    if (
      o.locName &&
      !agg.locations.includes(o.locName) &&
      agg.locations.length < 3
    ) {
      agg.locations.push(o.locName);
    }
    // Track every distinct place (full list powers the inline "all places" view).
    const pmap = placesBySpecies.get(o.speciesCode)!;
    const key = o.locId || `${o.lat},${o.lng}`;
    let pl = pmap.get(key);
    if (!pl) {
      pl = {
        locId: o.locId ?? null,
        locName: o.locName,
        lat: o.lat,
        lng: o.lng,
        lastObsDt: o.obsDt,
        nReports: 0,
        totalCount: 0,
        distanceKm: null,
        googlePlaceId: null,
      };
      pmap.set(key, pl);
    }
    pl.nReports++;
    pl.totalCount += o.howMany ?? 1;
    if (o.obsDt > pl.lastObsDt) pl.lastObsDt = o.obsDt;
    if (o.locId && locationPlaceIds.has(o.locId)) {
      pl.googlePlaceId = locationPlaceIds.get(o.locId)!;
    }
  }
  // Finalize per-species place lists + distances (nearest first when we have an origin).
  for (const [code, agg] of bySpecies) {
    const places = [...placesBySpecies.get(code)!.values()];
    if (home) {
      for (const pl of places)
        pl.distanceKm = haversineKm(home.lat, home.lon, pl.lat, pl.lng);
      agg.distanceKm = haversineKm(
        home.lat,
        home.lon,
        agg.lastLat,
        agg.lastLng,
      );
    }
    places.sort((a, b) =>
      home
        ? (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)
        : b.lastObsDt.localeCompare(a.lastObsDt),
    );
    agg.locationCount = places.length;
    agg.places = places;
  }
  return bySpecies;
}

const SPECIES_DETAIL_CONCURRENCY = 4;

function sortNeedsByActivity(a: SpeciesActivity, b: SpeciesActivity): number {
  return (
    b.locationCount - a.locationCount ||
    b.totalCount - a.totalCount ||
    b.nReports - a.nReports ||
    a.comName.localeCompare(b.comName)
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

async function enrichNeedsWithSpeciesReports<T extends SpeciesActivity>(
  needs: T[],
  apiKey: string,
  origin: { lat: number; lon: number },
  distKm: number,
  back: number,
  photoCounts: Map<string, number>,
): Promise<{ needs: T[]; stale: boolean }> {
  if (needs.length === 0) return { needs, stale: false };

  const dist = Math.min(Math.max(distKm, 1), 50);
  let stale = false;
  const enriched = await mapWithConcurrency(
    needs,
    SPECIES_DETAIL_CONCURRENCY,
    async (need) => {
      try {
        const result = await recentNearbySpeciesObs(
          apiKey,
          need.speciesCode,
          origin.lat,
          origin.lon,
          dist,
          back,
        );
        stale = stale || result.stale;
        const detailedPlaceIds = await hydrateEbirdLocationPlaceIds(
          result.data,
          { resolveMissing: false },
        );
        const detailed = aggregate(
          result.data,
          origin,
          photoCounts,
          detailedPlaceIds,
        ).get(need.speciesCode);
        return detailed ? ({ ...need, ...detailed } as T) : need;
      } catch {
        return need;
      }
    },
  );

  return { needs: enriched, stale };
}

async function buildView(
  userId: number,
  recent: CachedResult<EbirdObs[]>,
  notable: CachedResult<EbirdObs[]>,
  home: { lat: number; lon: number } | null,
  photoCounts: Map<string, number>,
  locationPlaceIds: Map<string, string> = new Map(),
  hotspotLocIds: Set<string> = new Set(),
): Promise<TargetsView> {
  const seen = await seenSet(userId);

  const recentAgg = aggregate(recent.data, home, photoCounts, locationPlaceIds);
  const needs = [...recentAgg.values()]
    .filter((a) => !seen.has(a.speciesCode))
    .sort(sortNeedsByActivity);

  const notableAgg = aggregate(
    notable.data,
    home,
    photoCounts,
    locationPlaceIds,
  );
  const notableList = [...notableAgg.values()]
    .map((a) => ({ ...a, seen: seen.has(a.speciesCode) }))
    .sort((a, b) => b.lastObsDt.localeCompare(a.lastObsDt));

  return {
    needs,
    notable: notableList,
    bestPlaces: rankPlaces(
      recent.data,
      seen,
      home,
      locationPlaceIds,
      hotspotLocIds,
    ),
    stale: recent.stale || notable.stale,
    fetchedAt: recent.fetchedAt,
    seenCount: seen.size,
  };
}

export async function regionTargets(
  userId: number,
  apiKey: string,
  regionCode: string,
  back: number,
  home: { lat: number; lon: number } | null,
  photoCounts: Map<string, number> = new Map(),
): Promise<TargetsView> {
  const [recent, notable] = await Promise.all([
    recentObs(apiKey, regionCode, back),
    notableObs(apiKey, regionCode, back),
  ]);
  const locationPlaceIds = await hydrateEbirdLocationPlaceIds([
    ...recent.data,
    ...notable.data,
  ]);
  return buildView(
    userId,
    recent,
    notable,
    home,
    photoCounts,
    locationPlaceIds,
  );
}

/**
 * Targets for an arbitrary location (geo endpoints — no region code needed).
 * Distances are measured from the search center. eBird caps geo dist at 50 km.
 */
export async function geoTargets(
  userId: number,
  apiKey: string,
  lat: number,
  lng: number,
  distKm: number,
  back: number,
  photoCounts: Map<string, number> = new Map(),
): Promise<TargetsView> {
  const dist = Math.min(Math.max(distKm, 1), 50);
  const origin = { lat, lon: lng };
  const [recent, notable] = await Promise.all([
    recentNearbyObs(apiKey, lat, lng, dist, back),
    notableNearbyObs(apiKey, lat, lng, dist, back),
  ]);
  const hotspots = await verifiedHotspotLocIds(apiKey, lat, lng, dist);
  const locationPlaceIds = await hydrateEbirdLocationPlaceIds([
    ...recent.data,
    ...notable.data,
  ]);
  const view = await buildView(
    userId,
    recent,
    notable,
    origin,
    photoCounts,
    locationPlaceIds,
    hotspots.locIds,
  );
  const enriched = await enrichNeedsWithSpeciesReports(
    view.needs,
    apiKey,
    origin,
    dist,
    back,
    photoCounts,
  );
  return {
    ...view,
    needs: enriched.needs.sort(sortNeedsByActivity),
    stale: view.stale || enriched.stale || hotspots.stale,
  };
}

export async function rankedNeedPlacesNear(
  userId: number,
  apiKey: string,
  lat: number,
  lng: number,
  distKm: number,
  back: number,
): Promise<{ places: PlaceRanking[]; stale: boolean; fetchedAt: Date }> {
  const dist = Math.min(Math.max(distKm, 1), 50);
  const origin = { lat, lon: lng };
  const [recent, hotspots, seen] = await Promise.all([
    recentNearbyObs(apiKey, lat, lng, dist, back),
    verifiedHotspotLocIds(apiKey, lat, lng, dist),
    seenSet(userId),
  ]);
  const locationPlaceIds = await hydrateEbirdLocationPlaceIds(recent.data);
  return {
    places: rankPlaces(
      recent.data,
      seen,
      origin,
      locationPlaceIds,
      hotspots.locIds,
    ),
    stale: recent.stale || hotspots.stale,
    fetchedAt: recent.fetchedAt,
  };
}

export async function nearbyNeeds(
  userId: number,
  apiKey: string,
  home: { lat: number; lon: number },
  distKm: number,
  back: number,
  photoCounts: Map<string, number> = new Map(),
): Promise<{
  needs: SpeciesActivity[];
  bestPlaces: PlaceRanking[];
  stale: boolean;
  fetchedAt: Date;
}> {
  const [recent, hotspots] = await Promise.all([
    recentNearbyObs(apiKey, home.lat, home.lon, distKm, back),
    verifiedHotspotLocIds(apiKey, home.lat, home.lon, distKm),
  ]);
  const seen = await seenSet(userId);
  const locationPlaceIds = await hydrateEbirdLocationPlaceIds(recent.data);
  const agg = aggregate(recent.data, home, photoCounts, locationPlaceIds);
  const needs = [...agg.values()]
    .filter((a) => !seen.has(a.speciesCode))
    .sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  const enriched = await enrichNeedsWithSpeciesReports(
    needs,
    apiKey,
    home,
    distKm,
    back,
    photoCounts,
  );
  return {
    needs: enriched.needs.sort(
      (a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9),
    ),
    bestPlaces: rankPlaces(
      recent.data,
      seen,
      home,
      locationPlaceIds,
      hotspots.locIds,
    ),
    stale: recent.stale || enriched.stale || hotspots.stale,
    fetchedAt: recent.fetchedAt,
  };
}
