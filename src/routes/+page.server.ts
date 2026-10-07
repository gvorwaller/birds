import { redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { decodeEbirdApiKey, EbirdError } from "$server/ebird";
import {
  geoTargetsBase,
  seenSet,
  type GeoEnrichment,
  type TargetsView,
} from "$server/needs";
import { geocodePlace } from "$server/geocode";
import { parsePlacePin } from "$lib/pin-params";
import {
  homeSearchToSave,
  loadHomeSearch,
  saveHomeSearch,
} from "$server/home-search";
import { galleryContextFrom } from "$server/access";
import { streamed, type Streamed } from "$lib/streamed";
import { recordedDateBounds, recordedSightingsForHome, type RecordedSighting } from "$server/recorded-sightings";
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

/** The params that make up a Home search. With none of them, `/` reopens the
 * account's remembered search (td-9304cd). `loc` and `list` are deliberately
 * not here: they are untracked view state, not a search.
 *
 * Loading a search URL never changes what is remembered — browser Back, an
 * old shared link or a second tab only display. Only the `search` and
 * `reset` actions below (the Search form, Search near …, Reset) write. */
const SEARCH_PARAMS = ["place", "dist", "back", "lat", "lng", "pin"] as const;

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
  // The signed-in account, which owns the remembered search — a viewer's
  // searches are their own.
  const accountId = locals.user!.id;
  const explicitSearch = SEARCH_PARAMS.some((k) => url.searchParams.has(k));
  const place = (url.searchParams.get("place") ?? "").trim();
  // A point chosen on the map: exact coordinates for the label in the place
  // box, so the label is never re-geocoded (a reverse-geocoded name can land
  // somewhere else). Typing a different place drops it — see parsePlacePin.
  const pin = parsePlacePin(
    place,
    url.searchParams.get("lat"),
    url.searchParams.get("lng"),
    url.searchParams.get("pin"),
  );

  // Independent work: the user row, the eBird row, the life list and the
  // geocode all run together. Only the eBird calls below depend on them.
  //
  // One SELECT per table (td-d561a8 §5): `gallery_url` rides the users row
  // instead of `galleryContext` re-reading it, and `api_key_enc` rides the
  // user_ebird row instead of `getEbirdApiKey` re-reading that. The life list
  // is loaded as a Set, not a COUNT — `seen.size` answers the at-a-glance
  // number in EVERY state, and the same Set is what the needs diff needs, so
  // the two can never disagree.
  const [userRow, ebirdState, seen, geo, remembered] = await Promise.all([
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
    place && !pin ? geocodePlace(place) : Promise.resolve(null),
    explicitSearch ? Promise.resolve(null) : loadHomeSearch(accountId),
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
    url.searchParams.get("dist") ??
      (remembered?.distKm != null ? remembered.distKm : null),
    u?.near_me_radius_km,
  );
  const back = parseBackDays(
    url.searchParams.get("back") ??
      (remembered?.backDays != null ? remembered.backDays : null),
    DEFAULT_BACK_DAYS,
  );
  // A remembered place reopens as the exact point it resolved to — never
  // re-geocoded — and resubmits as one (see `pin` in the return value).
  const reopened = remembered?.place ?? null;

  const home =
    u?.home_lat != null && u.home_lon != null
      ? { lat: u.home_lat, lng: u.home_lon, label: u.home_label ?? "Home" }
      : null;

  // DB-only personal evidence. Scope is locals.scopeId, never a URL-selected
  // account; the explicit Life picker remains the cross-owner surface.
  const recorded = await query<RecordedSighting & {
    first_seen: string | null;
    species_code: string;
    com_name: string;
    location_name: string | null;
    loc_id: string | null;
    sub_id: string | null;
    obs_count: number | null;
  }>(
    `SELECT ss.species_code AS "speciesCode",
            COALESCE(tc.com_name, ss.species_code) AS "comName",
            ss.first_seen::text AS "firstSeen", ss.location_name AS "locationName",
            ss.loc_id AS "locId", ss.sub_id AS "subId", ss.obs_count AS "obsCount",
            COALESCE(el.lat, llc.lat) AS lat, COALESCE(el.lng, llc.lng) AS lng
       FROM seen_species ss
       LEFT JOIN taxonomy_cache tc ON tc.species_code = ss.species_code
       LEFT JOIN ebird_locations el ON el.loc_id = ss.loc_id
       LEFT JOIN lifer_loc_coords llc
              ON llc.user_id = ss.user_id AND llc.source_loc_id = ss.loc_id
      WHERE ss.user_id = $1
      ORDER BY ss.first_seen DESC NULLS LAST, ss.csv_row_num ASC`,
    [userId],
  );

  // Resolve the location: a map point as chosen; else (bare `/`) the
  // remembered search; else a typed place, geocoded; else the saved home.
  let location: { lat: number; lng: number; label: string } | null = null;
  let error: string | null = null;
  if (pin) {
    location = pin;
  } else if (reopened) {
    location = reopened;
  } else if (place) {
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

  // No searched or reopened place, and the saved radius.
  const atSavedDefaults = !place && !reopened && distKm === savedRadiusKm;

  return {
    location,
    home,
    hasHome: !!home,
    // True only on the canonical saved-home view, which is what the
    // "Reset home defaults" action returns to. Derived from the URL rather than
    // from coordinates so that an explicit `dist` also counts as having
    // navigated away from it.
    usingSavedHome: atSavedDefaults,
    // The saved home is what is shown (no searched place). The place box then
    // stays empty — the home's name is only its placeholder — so changing just
    // Within or Window never submits the home's label as a typed place.
    showingHome: !!home && location === home,
    // Whether the Reset / Clear control shows. Away from the saved defaults
    // always; and without a saved home, whenever anything at all is
    // remembered — even only a Window — since Clear is then the only way to
    // forget it.
    canReset:
      !atSavedDefaults || (!home && remembered != null),
    placeQuery: place || reopened?.label || "",
    // Echoed so the Search form resubmits the same point when only Within or
    // Window changes.
    pin: pin ?? reopened,
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
    recordedSightings: recordedSightingsForHome(
      recorded.rows,
      location ? { lat: location.lat, lng: location.lng } : null,
      distKm,
      back,
    ),
    recordedDateStart: recordedDateBounds(back).start,
    recordedDateEnd: recordedDateBounds(back).end,
    photoCount: hasGallery
      ? [...photoCounts.values()].reduce((a, b) => a + b, 0)
      : 0,
    lifeListSyncedAt,
    lifeListStatus: ebirdState.rows[0]?.life_list_status ?? null,
  };
};

/** `FormData` text, trimmed; absent → "". */
const field = (form: FormData, key: string) =>
  (form.get(key) ?? "").toString().trim();

export const actions: Actions = {
  /**
   * The Search form (and Search near …): remember the search for this
   * account, then show it at its ordinary shareable GET URL. A typed place is
   * resolved here and carried as an exact point, so the page does not geocode
   * it again; one that cannot be found is not remembered and the page shows
   * the usual "Couldn't find" message.
   */
  search: async ({ locals, request }) => {
    const accountId = locals.user!.id;
    const form = await request.formData();
    const place = field(form, "place");
    const userRow = await query<{ near_me_radius_km: number | null }>(
      "SELECT near_me_radius_km FROM users WHERE id = $1",
      [locals.scopeId!],
    );
    const savedRadiusKm = normalizeNearMeRadiusKm(
      userRow.rows[0]?.near_me_radius_km,
    );
    const distKm = selectEffectiveRadiusKm(
      field(form, "dist"),
      userRow.rows[0]?.near_me_radius_km,
    );
    const back = parseBackDays(field(form, "back"), DEFAULT_BACK_DAYS);
    let resolved = parsePlacePin(
      place,
      field(form, "lat"),
      field(form, "lng"),
      field(form, "pin"),
    );
    if (!resolved && place) {
      const geo = await geocodePlace(place);
      if (geo) resolved = { lat: geo.lat, lng: geo.lng, label: geo.name };
    }

    const next = new URLSearchParams();
    if (resolved) {
      next.set("place", resolved.label);
      next.set("lat", resolved.lat.toFixed(5));
      next.set("lng", resolved.lng.toFixed(5));
      next.set("pin", resolved.label);
    } else if (place) {
      next.set("place", place);
    }
    next.set("dist", String(distKm));
    next.set("back", String(back));

    if (!place || resolved) {
      await saveHomeSearch(
        accountId,
        homeSearchToSave(
          resolved,
          distKm,
          savedRadiusKm,
          back,
          DEFAULT_BACK_DAYS,
        ),
      );
    }
    redirect(303, `/?${next}`);
  },

  /**
   * Reset home defaults: forget the place and radius, keep the Window (as
   * Reset always has). With no saved home there are no defaults to return
   * to, so it is "Clear this search" and forgets everything. Decided from
   * the stored home, never from the form.
   */
  reset: async ({ locals, request }) => {
    const form = await request.formData();
    const back = parseBackDays(field(form, "back"), DEFAULT_BACK_DAYS);
    const homeRow = await query<{ has_home: boolean }>(
      "SELECT (home_lat IS NOT NULL AND home_lon IS NOT NULL) AS has_home FROM users WHERE id = $1",
      [locals.scopeId!],
    );
    const keepWindow = !!homeRow.rows[0]?.has_home && back !== DEFAULT_BACK_DAYS;
    await saveHomeSearch(
      locals.user!.id,
      keepWindow ? { place: null, distKm: null, backDays: back } : null,
    );
    redirect(303, "/");
  },
};
