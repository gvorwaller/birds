import { error, fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import {
  getEbirdApiKey,
  hotspotsNear,
  EbirdError,
  type EbirdHotspot,
} from "$server/ebird";
import { geocodePlace } from "$server/geocode";
import { weatherFor, type WeatherResult } from "$server/weather";
import { generateFieldTips, GuidanceError } from "$server/ai-guidance";
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
  updateStopNotes,
  updateTrip,
} from "$server/trips";

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

function tripIdFrom(params: { id: string }): number {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw error(404, "Trip not found");
  return id;
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const userId = locals.scopeId!; // the data owner this account reads
  const tripId = tripIdFrom(params);

  const trip = await getTrip(userId, tripId);
  if (!trip) throw error(404, "Trip not found");

  const stops = await getStops(tripId);
  const apiKey = await getEbirdApiKey(userId);
  const needs = await needsCountForStops(userId, apiKey, stops);

  // Weather for the trip area (first located stop). Supplementary — never blocks
  // the page; null when there's no stop, no US coverage, or the provider fails.
  const firstLocated = stops.find((s) => s.lat != null && s.lon != null);
  let weather: WeatherResult | null = null;
  if (firstLocated) {
    weather = await weatherFor(
      firstLocated.lat as number,
      firstLocated.lon as number,
    );
  }

  // Optional "find hotspots near <place>" search.
  const hs = (url.searchParams.get("hs") ?? "").trim();
  let hotspots: EbirdHotspot[] = [];
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
          hotspots = res.data
            .filter((h) => !existing.has(h.locId))
            .slice(0, 15);
        } catch (err) {
          hsError =
            err instanceof EbirdError
              ? err.message
              : "Could not load hotspots.";
        }
      }
    }
  }

  return {
    trip,
    stops,
    home: await homeOf(userId),
    canEdit: locals.user!.role !== "viewer",
    needsCounts: Object.fromEntries(needs.counts) as Record<string, number>,
    needsStale: needs.stale,
    needsError: needs.error,
    hasApiKey: !!apiKey,
    hs,
    hotspots,
    hsCenter,
    hsError,
    weather,
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

    try {
      const tips = await generateFieldTips({
        tripName: trip.name,
        stops: stops.map((s) => ({
          id: s.id,
          name: s.custom_name ?? "Stop",
          notes: s.notes,
        })),
        weather,
        now: new Date(),
      });
      return { ok: true as const, tips };
    } catch (err) {
      return fail(400, {
        error:
          err instanceof GuidanceError
            ? err.message
            : "Could not generate field tips.",
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
};
