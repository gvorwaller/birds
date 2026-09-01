import type { PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { decodeEbirdApiKey, EbirdError } from "$server/ebird";
import {
  geoTargetsBase,
  seenSet,
  type GeoEnrichment,
  type TargetsView,
} from "$server/needs";
import { geocodePlace } from "$server/geocode";
import { galleryContextFrom } from "$server/access";
import { streamed, type Streamed } from "$lib/streamed";
import {
  BACK_OPTIONS,
  DEFAULT_BACK_DAYS,
  parseBackDays,
} from "$lib/time-windows";
import {
  normalizeNearMeRadiusKm,
  radiusSelectOptionsKm,
  selectEffectiveRadiusKm,
} from "$lib/near-me-radius";

const PLACE_SUGGESTIONS = [
  "Jacksonville, FL",
  "Hancock County, ME",
  "Bar Harbor, ME",
  "Merritt Island NWR, FL",
];

/**
 * The unified Home loader — the former Targets view merged with the old Near Me
 * page's at-a-glance summary.
 *
 * Every state (no home, no API key, geocode failure, eBird error, stale cache,
 * empty results) returns the *same* shape. There is deliberately no early
 * return: a brand-new user with neither a home nor a key still gets the
 * at-a-glance card and the setup guidance.
 *
 * INVARIANT — read the query ONLY via `url.searchParams.get(...)`, one key at a
 * time. SvelteKit tracks `searchParams.get/has/getAll` per key, but any read of
 * `url.search`/`href`/`pathname` marks the *whole* URL as a dependency, so this
 * loader would then re-run — eBird fan-out and all — on any param change,
 * including ones it does not use. `?loc=` (the Home place-focus param) is
 * deliberately untracked so focusing a place is a client-side navigation that
 * reuses this data. The species `returnTo` is minted in `+page.svelte` from
 * `page.url` for exactly this reason; it used to be built here from
 * `url.search`, which is what forced the re-run.
 */
export const load: PageServerLoad = async ({ locals, url, request }) => {
  const userId = locals.scopeId!; // the data owner this account reads
  const place = (url.searchParams.get("place") ?? "").trim();
  const back = parseBackDays(url.searchParams.get("back"), DEFAULT_BACK_DAYS);

  // Independent work: the user row, the eBird row, the life list and the
  // geocode all run together. Only the eBird calls below depend on them.
  //
  // One SELECT per table (td-d561a8 §5): `gallery_url` rides the users row
  // instead of `galleryContext` re-reading it, and `api_key_enc` rides the
  // user_ebird row instead of `getEbirdApiKey` re-reading that. The life list
  // is loaded as a Set, not a COUNT — `seen.size` answers the at-a-glance
  // number in EVERY state, and the same Set is what the needs diff needs, so
  // the two can never disagree.
  const [userRow, ebirdState, seen, geo] = await Promise.all([
    query<{
      home_lat: number | null;
      home_lon: number | null;
      home_label: string | null;
      near_me_radius_km: number | null;
      gallery_url: string | null;
    }>(
      "SELECT home_lat, home_lon, home_label, near_me_radius_km, gallery_url FROM users WHERE id = $1",
      [userId],
    ),
    query<{
      api_key_enc: string | null;
      life_list_synced_at: string | null;
      life_list_status: string | null;
    }>(
      "SELECT api_key_enc, life_list_synced_at, life_list_status FROM user_ebird WHERE user_id = $1",
      [userId],
    ),
    seenSet(userId),
    place ? geocodePlace(place) : Promise.resolve(null),
  ]);

  const u = userRow.rows[0];
  const apiKey = decodeEbirdApiKey(ebirdState.rows[0]?.api_key_enc ?? null);
  const lifeListSyncedAt = ebirdState.rows[0]?.life_list_synced_at ?? null;
  const { hasGallery, photoCounts } = await galleryContextFrom(
    u?.gallery_url ?? null,
  );
  const savedRadiusKm = normalizeNearMeRadiusKm(u?.near_me_radius_km);
  // Absent or invalid `dist` falls back to the saved radius — never to a
  // hard-coded 50 km, which is what the old Targets route did.
  const distKm = selectEffectiveRadiusKm(
    url.searchParams.get("dist"),
    u?.near_me_radius_km,
  );

  const home =
    u?.home_lat != null && u.home_lon != null
      ? { lat: u.home_lat, lng: u.home_lon, label: u.home_label ?? "Home" }
      : null;

  // Resolve the location: searched place → geocode; else fall back to home.
  let location: { lat: number; lng: number; label: string } | null = null;
  let error: string | null = null;
  if (place) {
    if (geo) {
      location = { lat: geo.lat, lng: geo.lng, label: geo.name };
    } else {
      error = `Couldn't find "${place}". Try a city, county, park, or address.`;
    }
  }
  // Typed place is authoritative — don't silently show saved-home birds
  // under a "Couldn't find …" banner.
  if (!location && !place && home) location = home;

  // The awaited base view is the whole page above the fold. `enrichment` is
  // the per-species fan-out, streamed: it fills in `places[]` (the place
  // search, the per-species place lists) and re-ranks the needs list, and
  // nothing rendered at first paint waits on it.
  let view: TargetsView | null = null;
  let enrichment: Promise<Streamed<GeoEnrichment>> | null = null;
  if (location && apiKey) {
    try {
      const base = await geoTargetsBase(
        seen,
        apiKey,
        location.lat,
        location.lng,
        distKm,
        back,
        photoCounts,
      );
      view = base.view;
      const label = location.label;
      enrichment = streamed(
        // A life list that has NEVER synced makes every species in the feed a
        // "need" — ~150 eBird calls and ~600 queries for a place breakdown
        // that describes an unfiltered feed. Keyed on `life_list_synced_at IS
        // NULL` rather than an empty seen set, because a successful import can
        // legitimately match zero species.
        lifeListSyncedAt == null
          ? Promise.resolve<GeoEnrichment>({
              needs: base.view.needs,
              partial: true,
              stale: false,
              skipped: true,
            })
          : base.enrich({ signal: request.signal }),
        (err) =>
          err instanceof EbirdError
            ? err.message
            : `Could not load place details for ${label}.`,
      );
    } catch (err) {
      error =
        err instanceof EbirdError
          ? err.message
          : `Could not load data for ${location.label}.`;
    }
  }

  return {
    location,
    home,
    hasHome: !!home,
    // True only on the canonical saved-home view, which is what the
    // "Reset home defaults" action returns to. Derived from the URL rather than
    // from coordinates so that an explicit `dist` also counts as having
    // navigated away from it.
    usingSavedHome: !place && distKm === savedRadiusKm,
    placeQuery: place,
    dist: distKm,
    savedRadiusKm,
    radiusOptionsKm: radiusSelectOptionsKm(distKm),
    back,
    backOptions: BACK_OPTIONS,
    suggestions: PLACE_SUGGESTIONS,
    view,
    enrichment,
    error,
    needsLocation: !location,
    hasApiKey: !!apiKey,
    hasGallery,
    // One authoritative life-list count for every state. `view.seenCount` is
    // deliberately not surfaced separately so the two cannot disagree.
    seenCount: seen.size,
    photoCount: hasGallery
      ? [...photoCounts.values()].reduce((a, b) => a + b, 0)
      : 0,
    lifeListSyncedAt,
    lifeListStatus: ebirdState.rows[0]?.life_list_status ?? null,
  };
};
