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
  /**
   * Verified eBird hotspot. Annotated here rather than derived on the client
   * from `bestPlaces`: that list is built from the pre-enrichment *recent needs*
   * feed only, so it omits notable-only places and places found by per-species
   * enrichment — a client-side derivation would silently drop the badge from
   * valid places.
   */
  isHotspot: boolean;
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
  /**
   * Distance to the species' LAST report (`lastLat`/`lastLng`) — not to its
   * nearest place, which is `nearestDistanceKm()` over `places`. The two are
   * different numbers and the UI must not label this one "nearest".
   */
  distanceKm: number | null;
  photoCount: number;
  /**
   * True once the per-species detail feed has been merged in (td-d561a8 §1d).
   *
   * The base area feed (`/data/obs/geo/recent`) returns the most recent
   * sighting of each species — ONE row per species, verified live 2026-08-31
   * (146 rows / 146 species). So before enrichment `locationCount`,
   * `nReports` and `totalCount` are not this species' activity in range, they
   * are that single row, and rendering them as counts claims something the
   * feed cannot support. The client shows the quantitative summary only for
   * rows where this is true.
   */
  enriched: boolean;
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
  /**
   * At least one per-species detail call failed, so some needs carry only their
   * base locations. Distinct from `stale` (which means cached data was served):
   * this view is *incomplete*, and place-based UI must soften its "not found"
   * copy accordingly rather than asserting a place has no reports.
   */
  enrichPartial: boolean;
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
  hotspotLocIds: Set<string> = new Set(),
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
        enriched: false,
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
        isHotspot: !!o.locId && hotspotLocIds.has(o.locId),
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

/** `aggregate()`'s place identity — `locId || coords`, `||` not `??`. */
function placeKeyOf(pl: SpeciesPlace): string {
  return pl.locId || `${pl.lat},${pl.lng}`;
}

/**
 * Fold a species' detail feed into its base row — a MERGE, never a replace
 * (td-d561a8 §1d, GROK P1-1).
 *
 * `{ ...need, ...detailed }` used to overwrite every field, which was
 * invisible only because enrichment finished before first paint. Streaming
 * makes it visible, and an overwrite can make a precise number *drop* when the
 * detail payload is non-empty but smaller (different cache generation, or a
 * cache-skewed payload) — a shown count correcting downward is exactly the
 * dishonest-claim pattern.
 *
 * Union by place identity, taking the richer record per place, guarantees the
 * three summary numbers are monotonic: the detail feed's places are a superset
 * in practice, and per-place counts take the max. The summary is then derived
 * FROM the merged places, so "5 locations" always describes the same list the
 * "Show all 5 places" toggle opens — the two cannot disagree.
 *
 * The `{ lastObsDt, lastLat, lastLng, googlePlaceId, distanceKm }` tuple moves
 * together, from whichever feed saw the newer observation. Freezing the
 * coordinates at their base values (the plan's first phrasing) would pin a pin
 * to one report while displaying another report's timestamp beside it; map
 * viewport stability is handled where it belongs, by ObsMap's `fitKey`.
 */
function mergeEnrichedNeed<T extends SpeciesActivity>(
  base: T,
  detailed: SpeciesActivity,
  home: { lat: number; lon: number } | null,
): T {
  const byKey = new Map<string, SpeciesPlace>();
  for (const pl of base.places) byKey.set(placeKeyOf(pl), pl);
  for (const pl of detailed.places) {
    const key = placeKeyOf(pl);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, pl);
      continue;
    }
    // Report count alone cannot choose the richer record: two cache
    // generations can carry the same number of reports but different bird
    // totals. Replacing on a tie used to let `totalCount` shrink when the
    // stream landed. Keep the newest place metadata, but take each additive
    // claim independently so every number remains monotonic.
    const newest = pl.lastObsDt > prev.lastObsDt ? pl : prev;
    byKey.set(key, {
      ...newest,
      nReports: Math.max(prev.nReports, pl.nReports),
      totalCount: Math.max(prev.totalCount, pl.totalCount),
      googlePlaceId: pl.googlePlaceId ?? prev?.googlePlaceId ?? null,
      isHotspot: pl.isHotspot || (prev?.isHotspot ?? false),
    });
  }
  const places = [...byKey.values()].sort((a, b) =>
    home
      ? (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)
      : b.lastObsDt.localeCompare(a.lastObsDt),
  );

  const newest = detailed.lastObsDt > base.lastObsDt ? detailed : base;
  const locations = [...base.locations];
  for (const name of detailed.locations) {
    if (locations.length >= 3) break;
    if (name && !locations.includes(name)) locations.push(name);
  }

  return {
    ...base,
    places,
    locationCount: places.length,
    nReports: places.reduce((n, pl) => n + pl.nReports, 0),
    totalCount: places.reduce((n, pl) => n + pl.totalCount, 0),
    lastObsDt: newest.lastObsDt,
    lastLat: newest.lastLat,
    lastLng: newest.lastLng,
    googlePlaceId: newest.googlePlaceId,
    distanceKm: newest.distanceKm,
    locations,
    enriched: true,
  };
}

export async function enrichNeedsWithSpeciesReports<T extends SpeciesActivity>(
  needs: T[],
  apiKey: string,
  origin: { lat: number; lon: number },
  distKm: number,
  back: number,
  photoCounts: Map<string, number>,
  hotspotLocIds: Set<string> = new Set(),
  opts: { signal?: AbortSignal } = {},
): Promise<{ needs: T[]; partial: boolean; stale: boolean }> {
  if (needs.length === 0) return { needs, partial: false, stale: false };

  const dist = Math.min(Math.max(distKm, 1), 50);
  // A per-species detail call that fails (or is skipped after an abort) leaves
  // that need with only its base locations. The view is then incomplete in a
  // way `stale` does not capture, so it is reported separately — UI built on
  // `places[]` must not claim a place is absent when the request for it simply
  // never happened.
  let partial = false;
  let stale = false;

  // Phase 1 — fetch. `signal` is checked before each call rather than passed
  // into it: a superseded navigation should stop SCHEDULING the remaining
  // species (the expensive part), while a request already in flight may finish
  // and populate the cache for whoever asks next.
  const fetched = await mapWithConcurrency(
    needs,
    SPECIES_DETAIL_CONCURRENCY,
    async (need) => {
      if (opts.signal?.aborted) {
        partial = true;
        return null;
      }
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
        return result.data;
      } catch {
        partial = true;
        return null;
      }
    },
  );

  // Phase 2 — ONE hydrate for the union instead of one per species (54 queries
  // → 2). Keyed by locId, so a single union pass is equivalent to the
  // per-species passes it replaces. `resolveMissing: false`: Google lookups are
  // serial with a 5 s deadline each, and letting up to five of them gate this
  // promise would decide when place details appear — they run detached below.
  //
  // Isolated: a failed batch must not reject the whole streamed section. The
  // observations were already fetched, and aggregating them with an empty
  // placeIds map keeps every lat/lng MapLink working — only the Google deep
  // links degrade.
  const allObs = fetched.flatMap((rows) => rows ?? []);
  let placeIds = new Map<string, string>();
  try {
    placeIds = await hydrateEbirdLocationPlaceIds(allObs, {
      resolveMissing: false,
    });
  } catch {
    partial = true;
  }

  const enriched = needs.map((need, i) => {
    const rows = fetched[i];
    if (!rows) return need;
    const detailed = aggregate(
      rows,
      origin,
      photoCounts,
      placeIds,
      hotspotLocIds,
    ).get(need.speciesCode);
    if (!detailed) {
      // The call succeeded but returned nothing for this species (empty or
      // cache-skewed payload). The need keeps only its base locations, so the
      // view is just as incomplete as on a thrown failure.
      partial = true;
      return need;
    }
    return mergeEnrichedNeed(need, detailed, origin);
  });

  // Detached follow-up (td-d561a8 §1b): resolve Google place IDs for locations
  // seen here so the NEXT load has them, without any request waiting on it.
  // Bounded by RUNTIME_LOOKUP_LIMIT and by the per-locId retry policy in
  // location-placeids.ts, so repeat loads do not re-attempt the same misses.
  if (allObs.length > 0 && !opts.signal?.aborted) {
    void hydrateEbirdLocationPlaceIds(allObs, { resolveMissing: true }).catch(
      () => {},
    );
  }

  return { needs: enriched, partial, stale };
}

function buildView(
  seen: Set<string>,
  recent: CachedResult<EbirdObs[]>,
  notable: CachedResult<EbirdObs[]>,
  home: { lat: number; lon: number } | null,
  photoCounts: Map<string, number>,
  locationPlaceIds: Map<string, string> = new Map(),
  hotspotLocIds: Set<string> = new Set(),
): TargetsView {
  const recentAgg = aggregate(
    recent.data,
    home,
    photoCounts,
    locationPlaceIds,
    hotspotLocIds,
  );
  const needs = [...recentAgg.values()]
    .filter((a) => !seen.has(a.speciesCode))
    .sort(sortNeedsByActivity);

  const notableAgg = aggregate(
    notable.data,
    home,
    photoCounts,
    locationPlaceIds,
    hotspotLocIds,
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
    // The base view runs no per-species detail calls, so nothing can be
    // partially enriched yet; `geoTargets` overrides this after enrichment.
    enrichPartial: false,
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
  const [recent, notable, seen] = await Promise.all([
    recentObs(apiKey, regionCode, back),
    notableObs(apiKey, regionCode, back),
    seenSet(userId),
  ]);
  const locationPlaceIds = await hydrateEbirdLocationPlaceIds([
    ...recent.data,
    ...notable.data,
  ]);
  return buildView(seen, recent, notable, home, photoCounts, locationPlaceIds);
}

/** The enriched half of a geo view — resolved behind a streamed boundary. */
export interface GeoEnrichment {
  needs: SpeciesActivity[];
  /** Some needs carry only their base locations. See `TargetsView.enrichPartial`. */
  partial: boolean;
  /** At least one per-species detail result came from stale cache. */
  stale: boolean;
  /** Enrichment was deliberately not attempted (never-synced life list). */
  skipped: boolean;
}

export interface GeoBase {
  /** Complete and renderable on its own — every above-the-fold section. */
  view: TargetsView;
  /**
   * The per-species fan-out, deferred. 27 eBird calls and ~108 queries in the
   * measured case, feeding `places[]` and the place-search index — none of
   * which renders at first paint.
   */
  enrich: (opts?: { signal?: AbortSignal }) => Promise<GeoEnrichment>;
}

/**
 * Targets for an arbitrary location (geo endpoints — no region code needed),
 * split at the enrichment seam (td-d561a8 §1).
 *
 * The awaited half is the three area calls that buy data currency; the
 * returned `enrich()` is the per-species fan-out that used to run inline and
 * hold the whole page for ~2 s. Distances are measured from the search center.
 * eBird caps geo dist at 50 km.
 */
export async function geoTargetsBase(
  seen: Set<string>,
  apiKey: string,
  lat: number,
  lng: number,
  distKm: number,
  back: number,
  photoCounts: Map<string, number> = new Map(),
): Promise<GeoBase> {
  const dist = Math.min(Math.max(distKm, 1), 50);
  const origin = { lat, lon: lng };
  const [recent, notable, hotspots] = await Promise.all([
    recentNearbyObs(apiKey, lat, lng, dist, back),
    notableNearbyObs(apiKey, lat, lng, dist, back),
    verifiedHotspotLocIds(apiKey, lat, lng, dist),
  ]);
  // `resolveMissing: false` — the base hydrate used to run up to five SERIAL
  // Google Text Search lookups at a 5 s deadline each (~25 s worst case) on
  // the critical path. Resolution now happens detached, inside enrich().
  const locationPlaceIds = await hydrateEbirdLocationPlaceIds(
    [...recent.data, ...notable.data],
    { resolveMissing: false },
  );
  const view = buildView(
    seen,
    recent,
    notable,
    origin,
    photoCounts,
    locationPlaceIds,
    hotspots.locIds,
  );
  return {
    // Hotspot staleness is part of what this shell shows, so it must reach the
    // badge at FIRST paint — it used to be ORed in only after enrichment.
    view: { ...view, stale: view.stale || hotspots.stale },
    enrich: async (opts = {}) => {
      const enriched = await enrichNeedsWithSpeciesReports(
        view.needs,
        apiKey,
        origin,
        dist,
        back,
        photoCounts,
        hotspots.locIds,
        opts,
      );
      return {
        // Option (a), owner's call 2026-08-31: the enriched activity rank is
        // the meaningful one, so the list re-sorts once when it lands. Base
        // order cannot substitute — the area feed is one row per species, so
        // sorting it by "activity" ranks on a single observation.
        needs: enriched.needs.sort(sortNeedsByActivity),
        partial: enriched.partial,
        stale: enriched.stale,
        skipped: false,
      };
    },
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
