import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import {
  fieldTipInputsForStops,
  missingFieldTipStopNames,
} from "$lib/trip-field-tips";
import {
  getEbirdApiKey,
  hotspotsNear,
  EbirdError,
  type EbirdHotspot,
} from "$server/ebird";
import { geocodePlace } from "$server/geocode";
import { rankedNeedPlacesNear, type PlaceRanking } from "$server/needs";
import { tidesForStops } from "$server/tides";
import type { TideResult } from "$lib/tide-format";
import { weatherFor, type WeatherResult } from "$server/weather";
import { fieldTipsForTrip, GuidanceError } from "$server/ai-guidance";
import { createShare, getActiveShare, revokeShare } from "$server/trip-shares";
import {
  addStop,
  deleteTrip,
  getStops,
  getTrip,
  moveStop,
  needsCountForStops,
  optimizeStopOrder,
  removeStop,
  setStopOrder,
  updateStopFieldTips,
  updateStopNotes,
  updateTrip,
} from "$server/trips";
import {
  attachGooglePlaceIds,
  googlePlaceIdsForLocIds,
  hydrateEbirdLocationPlaceIds,
} from "$server/location-placeids";

async function homeOf(
  userId: number,
): Promise<{ lat: number; lon: number } | null> {
  const u = await query<{ home_lat: number | null; home_lon: number | null }>(
    "SELECT home_lat, home_lon FROM users WHERE id = $1",
    [userId],
  );
  return u.rows[0]?.home_lat != null && u.rows[0]?.home_lon != null
    ? { lat: u.rows[0].home_lat, lon: u.rows[0].home_lon }
    : null;
}

const HOTSPOT_SEARCH_DIST_KM = 25;
const SUGGESTION_DIST_KM = 16;
const SUGGESTION_BACK_DAYS = 14;
const SUGGESTION_LIMIT = 8;

function tripIdFrom(params: { id: string }): number {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw error(404, "Trip not found");
  return id;
}

function tripCenter(
  stops: Array<{ lat: number | null; lon: number | null }>,
  home: { lat: number; lon: number } | null,
): { lat: number; lng: number; label: string } | null {
  const located = stops.filter(
    (s): s is { lat: number; lon: number } => s.lat != null && s.lon != null,
  );
  if (located.length > 0) {
    return {
      lat: located.reduce((sum, s) => sum + s.lat, 0) / located.length,
      lng: located.reduce((sum, s) => sum + s.lon, 0) / located.length,
      label: located.length === 1 ? "this stop" : "this trip",
    };
  }
  return home ? { lat: home.lat, lng: home.lon, label: "home" } : null;
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const userId = locals.scopeId!; // the data owner this account reads
  const tripId = tripIdFrom(params);

  const trip = await getTrip(userId, tripId);
  if (!trip) throw error(404, "Trip not found");

  const rawStops = await getStops(tripId);
  const savedPlaceIds = await googlePlaceIdsForLocIds(
    rawStops.map((s) => s.hotspot_id),
  );
  const stops = rawStops.map((s) => ({
    ...s,
    google_place_id:
      s.google_place_id ??
      (s.hotspot_id ? savedPlaceIds.get(s.hotspot_id) : null) ??
      null,
  }));
  const apiKey = await getEbirdApiKey(userId);
  const needs = await needsCountForStops(userId, apiKey, stops);
  const home = await homeOf(userId);

  // Weather for the trip area (first located stop) + tides for every located
  // stop (td-6a3d2e). Both are supplementary — never block the page; run in
  // parallel so tides add no wall-clock over weather alone.
  const firstLocated = stops.find((s) => s.lat != null && s.lon != null);
  const [weather, tidesByStop] = await Promise.all([
    firstLocated
      ? weatherFor(firstLocated.lat as number, firstLocated.lon as number)
      : Promise.resolve(null as WeatherResult | null),
    tidesForStops(stops, {
      startDate: trip.start_date,
      endDate: trip.end_date,
    }).catch(() => ({}) as Record<string, TideResult>),
  ]);

  // Optional "find hotspots near <place>" search.
  const hs = (url.searchParams.get("hs") ?? "").trim();
  let hotspots: Array<EbirdHotspot & { googlePlaceId: string | null }> = [];
  let hsCenter: {
    lat: number;
    lng: number;
    label: string;
    googlePlaceId: string | null;
  } | null = null;
  let hsError: string | null = null;

  if (hs) {
    if (!apiKey) {
      hsError = "Add your eBird API key in Settings to search hotspots.";
    } else {
      const geo = await geocodePlace(hs);
      if (!geo) {
        hsError = `Couldn't find "${hs}".`;
      } else {
        hsCenter = {
          lat: geo.lat,
          lng: geo.lng,
          label: geo.name,
          googlePlaceId: geo.place_id,
        };
        try {
          const res = await hotspotsNear(
            apiKey,
            geo.lat,
            geo.lng,
            HOTSPOT_SEARCH_DIST_KM,
          );
          const existing = new Set(
            stops.map((s) => s.hotspot_id).filter(Boolean),
          );
          const shown = res.data
            .filter((h) => !existing.has(h.locId))
            .slice(0, 15);
          const placeIds = await hydrateEbirdLocationPlaceIds(shown);
          hotspots = attachGooglePlaceIds(shown, placeIds);
        } catch (err) {
          hsError =
            err instanceof EbirdError
              ? err.message
              : "Could not load hotspots.";
        }
      }
    }
  }

  const existingHotspots = new Set(
    stops.map((s) => s.hotspot_id).filter(Boolean),
  );
  const suggestionCenter = tripCenter(stops, home);
  let suggestedHotspots: PlaceRanking[] = [];
  let suggestionsStale = false;
  let suggestionsError: string | null = null;
  if (apiKey && suggestionCenter) {
    try {
      const suggested = await rankedNeedPlacesNear(
        userId,
        apiKey,
        suggestionCenter.lat,
        suggestionCenter.lng,
        SUGGESTION_DIST_KM,
        SUGGESTION_BACK_DAYS,
      );
      suggestionsStale = suggested.stale;
      suggestedHotspots = suggested.places
        .filter((p) => p.isHotspot && p.locId && !existingHotspots.has(p.locId))
        .slice(0, SUGGESTION_LIMIT);
    } catch {
      suggestionsError = "Could not load suggested hotspots.";
    }
  }

  return {
    trip,
    stops,
    home,
    canEdit: locals.user!.role !== "viewer",
    // Owners only: viewers neither see nor manage share links (and hooks
    // block them from the non-GET actions regardless).
    share:
      locals.user!.role !== "viewer" ? await getActiveShare(locals.user!.id, tripId) : null,
    needsCounts: Object.fromEntries(needs.counts) as Record<string, number>,
    needsSpecies: Object.fromEntries(needs.species) as Record<
      string,
      { code: string; comName: string }[]
    >,
    needsStale: needs.stale,
    needsError: needs.error,
    hasApiKey: !!apiKey,
    hs,
    hotspots,
    hsCenter,
    hsError,
    suggestionCenter,
    suggestedHotspots,
    suggestionsStale,
    suggestionsError,
    suggestionBackDays: SUGGESTION_BACK_DAYS,
    suggestionDistKm: SUGGESTION_DIST_KM,
    weather,
    tidesByStop,
  };
};

export const actions: Actions = {
  update_trip: async ({ locals, params, request }) => {
    const tripId = tripIdFrom(params);
    const form = await request.formData();
    const name = (form.get("name") ?? "").toString().trim();
    const start = (form.get("start_date") ?? "").toString().trim() || null;
    const end = (form.get("end_date") ?? "").toString().trim() || null;
    const notes = (form.get("notes") ?? "").toString().trim() || null;
    if (!name) return fail(400, { error: "Trip name is required." });
    if (start && end && end < start)
      return fail(400, { error: "End date is before start date." });
    await updateTrip(locals.user!.id, tripId, {
      name,
      start_date: start,
      end_date: end,
      notes,
    });
    return { ok: true as const, message: "Trip updated." };
  },

  delete_trip: async ({ locals, params }) => {
    const tripId = tripIdFrom(params);
    await deleteTrip(locals.user!.id, tripId);
    throw redirect(303, "/trips");
  },

  add_place: async ({ locals, params, request }) => {
    const tripId = tripIdFrom(params);
    const form = await request.formData();
    const name = (form.get("name") ?? "").toString().trim();
    const googlePlaceId =
      (form.get("google_place_id") ?? "").toString().trim() || null;
    const lat = Number(form.get("lat"));
    const lon = Number(form.get("lon"));
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return fail(400, { error: "Search a place first, then add it." });
    }
    await addStop(locals.user!.id, tripId, {
      name,
      lat,
      lon,
      google_place_id: googlePlaceId,
    });
    return { ok: true as const, message: `Added "${name}".` };
  },

  add_hotspot: async ({ locals, params, request }) => {
    const tripId = tripIdFrom(params);
    const form = await request.formData();
    const locId = (form.get("loc_id") ?? "").toString().trim();
    const name = (form.get("name") ?? "").toString().trim();
    const googlePlaceId =
      (form.get("google_place_id") ?? "").toString().trim() || null;
    const notes = (form.get("notes") ?? "").toString().trim() || null;
    const lat = Number(form.get("lat"));
    const lon = Number(form.get("lon"));
    if (!locId || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return fail(400, { error: "Hotspot data was incomplete." });
    }
    await addStop(locals.user!.id, tripId, {
      hotspot_id: locId,
      name,
      lat,
      lon,
      google_place_id: googlePlaceId,
      notes,
    });
    return { ok: true as const, message: `Added "${name}".` };
  },

  remove_stop: async ({ locals, params, request }) => {
    const tripId = tripIdFrom(params);
    const form = await request.formData();
    const stopId = Number(form.get("stop_id"));
    if (!Number.isInteger(stopId)) return fail(400, { error: "Bad stop id." });
    await removeStop(locals.user!.id, tripId, stopId);
    return { ok: true as const };
  },

  // Client-computed driving-distance order (Google DirectionsService). The
  // browser posts the optimized stop-id sequence here to persist it.
  set_order: async ({ locals, params, request }) => {
    const tripId = tripIdFrom(params);
    const form = await request.formData();
    const ids = (form.get("order") ?? "")
      .toString()
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    const ok = await setStopOrder(locals.user!.id, tripId, ids);
    if (!ok)
      return fail(400, { error: "Could not apply the optimized order." });
    return {
      ok: true as const,
      message: "Stops reordered by real driving distance.",
    };
  },

  // Fallback: straight-line nearest-neighbor (no Directions API needed). Used
  // when the browser can't reach the Directions service.
  optimize: async ({ locals, params }) => {
    const tripId = tripIdFrom(params);
    const userId = locals.user!.id;
    const res = await optimizeStopOrder(userId, tripId, await homeOf(userId));
    if (!res.changed) {
      return fail(400, {
        error: "Add at least 3 located stops to optimize the route.",
      });
    }
    return {
      ok: true as const,
      message:
        "Stops reordered by straight-line distance (driving routing was unavailable).",
    };
  },

  move_stop: async ({ locals, params, request }) => {
    const tripId = tripIdFrom(params);
    const form = await request.formData();
    const stopId = Number(form.get("stop_id"));
    const direction = (form.get("direction") ?? "").toString();
    if (
      !Number.isInteger(stopId) ||
      (direction !== "up" && direction !== "down")
    ) {
      return fail(400, { error: "Bad move request." });
    }
    await moveStop(locals.user!.id, tripId, stopId, direction);
    return { ok: true as const };
  },

  // Opt-in LLM field-guidance: one batched call → a hedged tip per stop.
  field_tips: async ({ locals, params }) => {
    const tripId = tripIdFrom(params);
    const userId = locals.user!.id;
    const trip = await getTrip(userId, tripId);
    if (!trip) return fail(404, { error: "Trip not found." });
    const stops = await getStops(tripId);
    if (stops.length === 0) return fail(400, { error: "Add a stop first." });

    const firstLocated = stops.find((s) => s.lat != null && s.lon != null);
    const weather = firstLocated
      ? await weatherFor(firstLocated.lat as number, firstLocated.lon as number)
      : null;
    const tipStops = fieldTipInputsForStops(stops);

    try {
      const tips = await fieldTipsForTrip({
        tripName: trip.name,
        stops: tipStops,
        weather,
        now: new Date(),
      });
      const missingNames = missingFieldTipStopNames(tipStops, tips);
      if (missingNames.length > 0) {
        return fail(400, {
          error: `AI did not return field tips for ${missingNames.join(", ")} — try again.`,
        });
      }
      await updateStopFieldTips(userId, tripId, tips);
      const n = Object.keys(tips).length;
      return {
        ok: true as const,
        message: `Refreshed ${n} field ${n === 1 ? "tip" : "tips"}.`,
      };
    } catch (err) {
      return fail(400, {
        error:
          err instanceof GuidanceError
            ? err.message
            : "Could not refresh field tips.",
      });
    }
  },

  save_notes: async ({ locals, params, request }) => {
    const tripId = tripIdFrom(params);
    const form = await request.formData();
    const stopId = Number(form.get("stop_id"));
    const notes = (form.get("notes") ?? "").toString().trim() || null;
    if (!Number.isInteger(stopId)) return fail(400, { error: "Bad stop id." });
    await updateStopNotes(locals.user!.id, tripId, stopId, notes);
    return { ok: true as const, message: "Note saved." };
  },

  /** Create (or regenerate) the public share link. Ownership is re-checked
   * inside createShare; viewers never reach non-GET actions (hooks). */
  create_share: async ({ locals, params }) => {
    const tripId = tripIdFrom(params);
    const token = await createShare(locals.user!.id, tripId);
    if (!token) return fail(404, { error: "Trip not found." });
    return {
      ok: true as const,
      message: "Share link created — anyone with the link can view this trip's field sheet.",
    };
  },

  revoke_share: async ({ locals, params }) => {
    const tripId = tripIdFrom(params);
    const revoked = await revokeShare(locals.user!.id, tripId);
    if (!revoked) return fail(400, { error: "No active share link." });
    return {
      ok: true as const,
      message: "Share link revoked — the old URL no longer works.",
    };
  },
};
