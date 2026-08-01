/**
 * Inverting the Home view's species→places data into places→species, so the
 * in-page search box can find a place by name.
 *
 * Everything here is pure and client-safe: the Home loader already ships a
 * `places[]` for every need and every notable entry, so this adds **zero**
 * eBird calls and no new payload. It is also why a place is findable only when
 * one of the user's needs or a notable report happened there — that is the
 * ticket's rule, and it falls out of the data rather than being enforced.
 *
 * IMPORTANT: the index covers the *loaded* payload, not all occurrences. The
 * server enriches needs with per-species detail calls and swallows individual
 * failures, so a place can be missing here simply because a fetch failed. Copy
 * built on this must say "in the loaded reports", never "no reports".
 *
 * Types are declared structurally rather than imported from `$server/needs`,
 * matching the pattern in `BestPlaces.svelte` — importing server types into
 * client code drags the server module graph along with it.
 */

import { placeQueryMatches } from "$lib/place-name";

export interface IndexedPlace {
  locId: string | null;
  locName: string;
  lat: number;
  lng: number;
  googlePlaceId: string | null;
  isHotspot: boolean;
  distanceKm: number | null;
  lastObsDt: string;
  nReports: number;
  totalCount: number;
}

/**
 * Structural view of a `SpeciesActivity`.
 *
 * The fields after `places` are the whole-area AGGREGATE summary the loader
 * computed across every location. {@link speciesAtPlace} must recompute all of
 * them when it narrows a species to one place — leaving them alone renders
 * "65 locations · 110 birds" on a card that is showing a single place.
 */
export interface IndexedSpecies {
  speciesCode: string;
  comName: string;
  sciName: string;
  places: IndexedPlace[];
  nReports?: number;
  totalCount?: number;
  locationCount?: number;
  locations?: string[];
  lastObsDt?: string;
  lastLat?: number;
  lastLng?: number;
  distanceKm?: number | null;
  googlePlaceId?: string | null;
}

/** One place, with the species that make it worth visiting. */
export interface PlaceMatch {
  key: string;
  locId: string | null;
  locName: string;
  lat: number;
  lng: number;
  googlePlaceId: string | null;
  isHotspot: boolean;
  distanceKm: number | null;
  /** Most recent observation date across every species seen here. */
  lastObsDt: string;
  /** Species codes the user still needs, reported here. */
  needCodes: Set<string>;
  /** Species codes from the notable feed, reported here. */
  notableCodes: Set<string>;
  /**
   * Every raw {@link placeKey} folded into this entry, including its own.
   *
   * Membership is recorded here at build time rather than re-derived later:
   * {@link reconcile} makes a *choice* about which host absorbs a
   * coordinate-only record, and any second implementation of that choice
   * (an epsilon test, say) can disagree with it — attaching a species to a
   * place whose own counts never included it.
   */
  memberKeys: Set<string>;
}

/** Most places to hand back for one query — see {@link searchPlaces}. */
export const MAX_PLACE_RESULTS = 20;

/**
 * Coordinate precision for the fallback key. eBird returns ~5dp for personal
 * locations; rounding here stops float noise from splitting one place in two.
 */
const COORD_PRECISION = 5;

/**
 * How close two coordinates must be for a coordinate-keyed record to be folded
 * into an locId-keyed one. ~11m at 5dp; deliberately tight, since merging two
 * genuinely different places is worse than listing one place twice.
 */
const MERGE_EPSILON_DEG = 0.0001;

/**
 * Canonical identity for a place.
 *
 * `locId || coords` — `||`, NOT `??`, matching `aggregate()` and `rankPlaces()`
 * in `$server/needs`. Under `??` an empty-string `locId` would key every such
 * record as `""` and collapse unrelated places into one.
 */
export function placeKey(
  locId: string | null | undefined,
  lat: number,
  lng: number,
): string {
  return (
    locId || `${lat.toFixed(COORD_PRECISION)},${lng.toFixed(COORD_PRECISION)}`
  );
}

function newer(a: string, b: string): string {
  return a.localeCompare(b) >= 0 ? a : b;
}

function absorb(
  target: PlaceMatch,
  place: IndexedPlace,
  speciesCode: string,
  kind: "need" | "notable",
): void {
  if (kind === "need") target.needCodes.add(speciesCode);
  else target.notableCodes.add(speciesCode);

  target.lastObsDt = newer(target.lastObsDt, place.lastObsDt);
  // A verified hotspot flag on any record is authoritative for the place.
  target.isHotspot ||= place.isHotspot;
  // Prefer a real Google id / nearest distance if this record has one and the
  // accumulated entry does not.
  target.googlePlaceId ??= place.googlePlaceId;
  if (
    place.distanceKm !== null &&
    (target.distanceKm === null || place.distanceKm < target.distanceKm)
  ) {
    target.distanceKm = place.distanceKm;
  }
}

/**
 * Fold coordinate-keyed entries into an locId-keyed entry for the same physical
 * place. One feed can carry a `locId` while another has only coordinates (eBird
 * personal locations), which would otherwise list the same park twice.
 *
 * `locId` always wins: its `locName` and `googlePlaceId` are authoritative, and
 * the coordinate entry contributes only its species and dates.
 */
function reconcile(byKey: Map<string, PlaceMatch>): Map<string, PlaceMatch> {
  const identified = [...byKey.values()].filter((p) => p.locId);
  if (identified.length === 0) return byKey;

  for (const [key, entry] of [...byKey]) {
    if (entry.locId) continue;
    const hosts = identified.filter(
      (p) =>
        Math.abs(p.lat - entry.lat) <= MERGE_EPSILON_DEG &&
        Math.abs(p.lng - entry.lng) <= MERGE_EPSILON_DEG,
    );
    // Fold only when the answer is unambiguous. With two hosts in range there
    // is no principled winner, and picking one would make the result depend on
    // feed/species iteration order — a different summary owner on each load.
    // Leaving the record as its own entry is the honest, stable outcome.
    if (hosts.length !== 1) continue;
    const host = hosts[0];

    for (const code of entry.needCodes) host.needCodes.add(code);
    for (const code of entry.notableCodes) host.notableCodes.add(code);
    for (const member of entry.memberKeys) host.memberKeys.add(member);
    host.lastObsDt = newer(host.lastObsDt, entry.lastObsDt);
    host.isHotspot ||= entry.isHotspot;
    host.googlePlaceId ??= entry.googlePlaceId;
    if (
      entry.distanceKm !== null &&
      (host.distanceKm === null || entry.distanceKm < host.distanceKm)
    ) {
      host.distanceKm = entry.distanceKm;
    }
    byKey.delete(key);
  }
  return byKey;
}

/**
 * Invert both feeds into one place index.
 *
 * Both lists are merged deliberately: `view.bestPlaces` is needs-only, so a
 * rarity the user has already seen contributes nothing there and it cannot be
 * the source for this feature.
 */
export function buildPlaceIndex(
  notable: IndexedSpecies[],
  needs: IndexedSpecies[],
): PlaceMatch[] {
  const byKey = new Map<string, PlaceMatch>();

  const ingest = (list: IndexedSpecies[], kind: "need" | "notable") => {
    for (const species of list) {
      for (const place of species.places ?? []) {
        const key = placeKey(place.locId, place.lat, place.lng);
        let entry = byKey.get(key);
        if (!entry) {
          entry = {
            key,
            locId: place.locId,
            locName: place.locName,
            lat: place.lat,
            lng: place.lng,
            googlePlaceId: place.googlePlaceId,
            isHotspot: place.isHotspot,
            distanceKm: place.distanceKm,
            lastObsDt: place.lastObsDt,
            needCodes: new Set(),
            notableCodes: new Set(),
            memberKeys: new Set([key]),
          };
          byKey.set(key, entry);
        }
        absorb(entry, place, species.speciesCode, kind);
      }
    }
  };

  // Notable first so a rarity's record establishes the entry's name; needs then
  // contribute their species without renaming it.
  ingest(notable, "notable");
  ingest(needs, "need");

  return [...reconcile(byKey).values()];
}

/**
 * Rank one place against another. Mirrors `rankPlaces()`'s convention in
 * `$server/needs`: the most needs first, rarities as the tiebreak, then
 * recency, then proximity.
 */
function compare(a: PlaceMatch, b: PlaceMatch): number {
  if (a.needCodes.size !== b.needCodes.size) {
    return b.needCodes.size - a.needCodes.size;
  }
  const aRare = a.notableCodes.size > 0 ? 1 : 0;
  const bRare = b.notableCodes.size > 0 ? 1 : 0;
  if (aRare !== bRare) return bRare - aRare;

  const byDate = b.lastObsDt.localeCompare(a.lastObsDt);
  if (byDate !== 0) return byDate;

  if (a.distanceKm === null) return b.distanceKm === null ? 0 : 1;
  if (b.distanceKm === null) return -1;
  return a.distanceKm - b.distanceKm;
}

/**
 * Places whose name plausibly matches `query`, best first.
 *
 * Capped at {@link MAX_PLACE_RESULTS}: a short query is permissive by design
 * (see `placeQueryMatches`) and can otherwise match most of the index.
 */
export function searchPlaces(index: PlaceMatch[], query: string): PlaceMatch[] {
  const hits = index.filter((p) => placeQueryMatches(query, p.locName));
  return hits.sort(compare).slice(0, MAX_PLACE_RESULTS);
}

/**
 * Does this raw place record belong to the given indexed place?
 *
 * Key equality is not sufficient on its own: {@link buildPlaceIndex} folds
 * coordinate-keyed records into an `locId`-keyed entry for the same physical
 * place, so a record can belong to a match whose key it does not equal. This
 * repeats reconciliation's rule so the two can never disagree.
 */
export function placeRecordBelongsTo(
  place: Pick<IndexedPlace, "locId" | "lat" | "lng">,
  match: PlaceMatch,
): boolean {
  return match.memberKeys.has(placeKey(place.locId, place.lat, place.lng));
}

/**
 * The species of one feed reported at a focused place, each narrowed to just
 * that place. Returns new objects — never mutates the loader's data.
 *
 * Every aggregate summary field is RECOMPUTED from the surviving places, not
 * carried over. The loader's `nReports`/`totalCount`/`locationCount`/
 * `locations`/`lastObsDt`/`lastLat`/`lastLng`/`distanceKm` describe the whole
 * search area; copying them onto a focused card would claim "65 locations"
 * while displaying one, directly contradicting "showing birds reported at X".
 */
export function speciesAtPlace<T extends IndexedSpecies>(
  match: PlaceMatch,
  species: T[],
): T[] {
  const out: T[] = [];
  for (const s of species) {
    const here = (s.places ?? []).filter((p) => placeRecordBelongsTo(p, match));
    if (here.length === 0) continue;

    const nearest = here.reduce((best, p) =>
      (p.distanceKm ?? Infinity) < (best.distanceKm ?? Infinity) ? p : best,
    );
    const latest = here.reduce((best, p) =>
      p.lastObsDt.localeCompare(best.lastObsDt) > 0 ? p : best,
    );

    // Collapse to ONE canonical record. `here` can hold several raw records
    // that reconciliation folded into a single physical place (an locId record
    // plus a coordinate-only one), and keeping them apart would render
    // duplicate rows and claim locationCount 2 for one place. Identity fields
    // come from the match, never from the raw records — in particular
    // `googlePlaceId`, which on the species aggregate follows the whole-area
    // latest observation and would otherwise point Google Maps at a place the
    // user is not looking at (`mapsPlaceUrl` prefers the id over coordinates).
    const canonical: IndexedPlace = {
      locId: match.locId,
      locName: match.locName,
      lat: match.lat,
      lng: match.lng,
      googlePlaceId: match.googlePlaceId,
      isHotspot: match.isHotspot,
      distanceKm: nearest.distanceKm,
      lastObsDt: latest.lastObsDt,
      nReports: here.reduce((n, p) => n + p.nReports, 0),
      totalCount: here.reduce((n, p) => n + p.totalCount, 0),
    };

    out.push({
      ...s,
      places: [canonical],
      nReports: canonical.nReports,
      totalCount: canonical.totalCount,
      locationCount: 1,
      locations: [match.locName],
      lastObsDt: canonical.lastObsDt,
      lastLat: match.lat,
      lastLng: match.lng,
      distanceKm: canonical.distanceKm,
      googlePlaceId: match.googlePlaceId,
    });
  }
  return out;
}
