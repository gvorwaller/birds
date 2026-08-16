import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { getEbirdApiKey, hotspotsNear, EbirdError } from "$server/ebird";
import { geocodePlace } from "$server/geocode";
import { enqueueJob } from "$server/jobs";
import { dedupKeys } from "$server/job-policy";
import {
  calendarMonth,
  forecastNeedsNear,
  majorityRegionCode,
  rankCountiesForNeeds,
  validateLocSelection,
  type CountyNeedsRank,
  type ForecastNeedsView,
} from "$server/forecast";
import { seenSet } from "$server/needs";
import {
  normalizeNearMeRadiusKm,
  radiusSelectOptionsKm,
  selectEffectiveRadiusKm,
} from "$lib/near-me-radius";
import { parsePin } from "$lib/pin-params";

function parseMonth(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : fallback;
}

// INVARIANT (see src/routes/+page.server.ts): read query params ONLY via
// url.searchParams.get(key). This loader reads stored barchart data only —
// ebird.org/barchartData is fetched exclusively by the loadData action.
export const load: PageServerLoad = async ({ locals, url }) => {
  const userId = locals.scopeId!;
  const isViewer = locals.user?.role === "viewer";
  const place = (url.searchParams.get("place") ?? "").trim();
  // Defaults to the CURRENT month — a real, visible value, not a hidden one.
  const month = parseMonth(
    url.searchParams.get("month"),
    calendarMonth(),
  );
  // Pinned-coordinate origin ("Forecast my needs here" links, trip stops,
  // the map picker). A typed place always wins over a pin. parsePin treats
  // absent/empty params as NO pin (see its regression test).
  const pin = parsePin(
    url.searchParams.get("lat"),
    url.searchParams.get("lng"),
    url.searchParams.get("loc"),
  );

  const [userRow, apiKey, credsRow, geo] = await Promise.all([
    query<{
      home_lat: number | null;
      home_lon: number | null;
      home_label: string | null;
      near_me_radius_km: number | null;
    }>(
      "SELECT home_lat, home_lon, home_label, near_me_radius_km FROM users WHERE id = $1",
      [userId],
    ),
    getEbirdApiKey(userId),
    query<{ login_set: boolean }>(
      `SELECT (login_username_enc IS NOT NULL AND login_password_enc IS NOT NULL) AS login_set
         FROM user_ebird WHERE user_id = $1`,
      [userId],
    ),
    place ? geocodePlace(place) : Promise.resolve(null),
  ]);

  const u = userRow.rows[0];
  const distKm = selectEffectiveRadiusKm(
    url.searchParams.get("dist"),
    u?.near_me_radius_km,
  );
  const home =
    u?.home_lat != null && u.home_lon != null
      ? { lat: u.home_lat, lng: u.home_lon, label: u.home_label ?? "Home" }
      : null;

  let location: { lat: number; lng: number; label: string } | null = null;
  let originKind: "place" | "pin" | "home" | null = null;
  let error: string | null = null;
  if (place) {
    if (geo) {
      location = { lat: geo.lat, lng: geo.lng, label: geo.name };
      originKind = "place";
    } else {
      error = `Couldn't find "${place}". Try a city, county, park, or address.`;
    }
  }
  // A typed place is authoritative: geocode failure must not silently
  // forecast the leftover pin or saved home under the error banner.
  const placeFailed = !!place && !geo;
  if (!location && !placeFailed && pin) {
    location = pin;
    originKind = "pin";
  }
  if (!location && !placeFailed && home) {
    location = home;
    originKind = "home";
  }

  let view: ForecastNeedsView | null = null;
  let countyNeeds: CountyNeedsRank[] = [];
  if (location && apiKey) {
    try {
      const seen = await seenSet(userId);
      view = await forecastNeedsNear(
        userId,
        apiKey,
        location.lat,
        location.lng,
        distKm,
        month,
        seen,
      );
      if (view.regionCode) {
        countyNeeds = await rankCountiesForNeeds(
          userId,
          view.regionCode,
          month,
          seen,
        );
      }
    } catch (err) {
      error =
        err instanceof EbirdError
          ? err.message
          : `Could not load hotspots for ${location.label}.`;
    }
  }

  return {
    location,
    originKind,
    placeQuery: place,
    month,
    dist: distKm,
    savedRadiusKm: normalizeNearMeRadiusKm(u?.near_me_radius_km),
    radiusOptionsKm: radiusSelectOptionsKm(distKm),
    view,
    countyNeeds,
    error,
    needsLocation: !location,
    hasApiKey: !!apiKey,
    hasLogin: credsRow.rows[0]?.login_set === true,
    isViewer,
  };
};

export const actions: Actions = {
  /**
   * Queue barchart loads for explicitly selected hotspots near a point.
   * Owner-only (viewer POSTs are 403'd in hooks.server.ts). Every submitted
   * `loc` id must appear in the official eBird in-range list — never a
   * free-form id, and never a server-derived implicit set.
   */
  loadData: async ({ locals, request }) => {
    const userId = locals.scopeId!;
    const form = await request.formData();
    // Same absent-vs-zero guard as the loader: Number(null/"") is 0, and a
    // missing field must fail loudly, never silently mean the Gulf of Guinea.
    const latRaw = (form.get("lat") ?? "").toString().trim();
    const lngRaw = (form.get("lng") ?? "").toString().trim();
    const lat = latRaw === "" ? NaN : Number(latRaw);
    const lng = lngRaw === "" ? NaN : Number(lngRaw);
    const dist = Number(form.get("dist"));
    const force = form.get("force") === "1";

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return fail(400, { error: "A valid location is required." });
    }
    if (!Number.isFinite(dist) || dist < 1 || dist > 50) {
      return fail(400, { error: "Radius must be between 1 and 50 km." });
    }
    const apiKey = await getEbirdApiKey(userId);
    if (!apiKey) {
      return fail(400, {
        error: "An eBird API key is required — add one in Settings.",
      });
    }

    // Hotspot targets (single-row Load OR the multi-select's repeated `loc`
    // fields) are REQUIRED — the pick panel is the only load surface
    // (td-17d291; the old no-loc suggested+outdated derivation had no
    // remaining caller and was removed rather than kept dead — CODEX1
    // Phase-2). Every id must appear in the official in-range list — one
    // unknown id rejects the whole request (td-8a6f97 policy).
    const locParams = form
      .getAll("loc")
      .map((v) => v.toString().trim())
      .filter((v) => v !== "");
    if (locParams.length === 0) {
      return fail(400, { error: "Select at least one hotspot to load." });
    }

    let selected;
    try {
      const hotspots = await hotspotsNear(apiKey, lat, lng, dist);
      const validated = validateLocSelection(hotspots.data, locParams);
      if (!validated.ok) {
        return fail(400, {
          error: `${validated.missing.length} selected hotspot${validated.missing.length === 1 ? " is" : "s are"} not in the current search radius — refresh and reselect.`,
        });
      }
      selected = validated.selected;
    } catch (err) {
      return fail(502, {
        error:
          err instanceof EbirdError
            ? err.message
            : "Could not list hotspots near that location.",
      });
    }

    // Thin enqueuer: the validated, RESOLVED targets go into the job payload;
    // the worker never re-derives them. {queued} replaces the old {ensure}.
    const locs = selected.map((h) => ({
      code: h.locId,
      kind: "hotspot" as const,
      name: h.locName,
      // Most specific containing region: county when eBird provides it, so
      // /forecast/data can nest the hotspot under its county.
      regionCode:
        h.subnational2Code ?? h.subnational1Code ?? majorityRegionCode(selected),
    }));
    const originLabel = (form.get("origin") ?? "").toString().trim().slice(0, 80);
    const label = `${locs.length} hotspot${locs.length === 1 ? "" : "s"}${originLabel ? ` near ${originLabel}` : ""}`;
    const { jobId, deduped } = await enqueueJob({
      type: "load_hotspots",
      payload: { locs, force },
      dedupKey: dedupKeys.loadHotspots(locs.map((l) => l.code)),
      requestedBy: userId,
      label,
    });
    return { queued: { jobId, deduped, label } };
  },
};
