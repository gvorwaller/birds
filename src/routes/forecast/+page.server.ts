import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { getEbirdApiKey, hotspotsNear, EbirdError } from "$server/ebird";
import { geocodePlace } from "$server/geocode";
import { ensureFrequencies, type EnsureResult } from "$server/barchart";
import {
  forecastNeedsNear,
  selectForecastHotspots,
  type ForecastNeedsView,
} from "$server/forecast";
import {
  normalizeNearMeRadiusKm,
  radiusSelectOptionsKm,
  selectEffectiveRadiusKm,
} from "$lib/near-me-radius";

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
    new Date().getMonth() + 1,
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
  let error: string | null = null;
  if (place) {
    if (geo) location = { lat: geo.lat, lng: geo.lng, label: geo.name };
    else
      error = `Couldn't find "${place}". Try a city, county, park, or address.`;
  }
  if (!location && home) location = home;

  let view: ForecastNeedsView | null = null;
  if (location && apiKey) {
    try {
      view = await forecastNeedsNear(
        userId,
        apiKey,
        location.lat,
        location.lng,
        distKm,
        month,
      );
    } catch (err) {
      error =
        err instanceof EbirdError
          ? err.message
          : `Could not load hotspots for ${location.label}.`;
    }
  }

  return {
    location,
    placeQuery: place,
    month,
    dist: distKm,
    savedRadiusKm: normalizeNearMeRadiusKm(u?.near_me_radius_km),
    radiusOptionsKm: radiusSelectOptionsKm(distKm),
    view,
    error,
    needsLocation: !location,
    hasApiKey: !!apiKey,
    hasLogin: credsRow.rows[0]?.login_set === true,
    isViewer,
  };
};

export const actions: Actions = {
  /**
   * Fetch/refresh barchart data for the analyzed hotspots near a point.
   * Owner-only (viewer POSTs are 403'd in hooks.server.ts). The hotspot list
   * is re-derived server-side from the official eBird API — the form supplies
   * only coordinates, never fetch targets.
   */
  loadData: async ({ locals, request }) => {
    const userId = locals.scopeId!;
    const form = await request.formData();
    const lat = Number(form.get("lat"));
    const lng = Number(form.get("lng"));
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

    let selected;
    try {
      const hotspots = await hotspotsNear(apiKey, lat, lng, dist);
      selected = selectForecastHotspots(hotspots.data, { lat, lng });
    } catch (err) {
      return fail(502, {
        error:
          err instanceof EbirdError
            ? err.message
            : "Could not list hotspots near that location.",
      });
    }
    if (selected.length === 0) {
      return fail(404, { error: "No eBird hotspots found in that radius." });
    }

    const ensure: EnsureResult = await ensureFrequencies(
      userId,
      selected.map((h) => ({
        code: h.locId,
        kind: "hotspot" as const,
        name: h.locName,
        regionCode: h.subnational1Code ?? null,
      })),
      { force },
    );
    return { ensure };
  },
};
