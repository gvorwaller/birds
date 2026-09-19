import { fail, redirect } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { getEbirdApiKey, EbirdError } from "$server/ebird";
import { geocodePlace } from "$server/geocode";
import { milesToKm } from "$lib/geo";
import { DEFAULT_BACK_DAYS, parseBackDays } from "$lib/time-windows";
import {
  runQuery,
  assembleTripPreview,
  validateTripParams,
  BOUNDS,
  type QueryFilters,
  type PlannedTripPreview,
  type QueryResult,
} from "$server/query-engine";
import { savePlannedTrip, type PlannedTripStopInput } from "$server/trips";
import { issueTripCountToken, verifyTripCountToken, TripCountTokenError } from "$server/trip-count-token";
import { contextMatchesStop, parseAnyTripCountContext, type AnyTripCountContext, type TripCountContext } from "$lib/trip-count-context";

const DEFAULTS = {
  radiusMi: 10,
  back: DEFAULT_BACK_DAYS,
  stops: 3,
  minNeeds: 3,
};

function numParam(v: string | null, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const userId = locals.scopeId!; // the data owner this account reads (save is blocked for viewers)
  const canEdit = locals.user!.role !== "viewer";
  const p = url.searchParams;

  // A pin dropped on the map submits exact lat/lng (option "b": the tapped point
  // is the anchor, not a re-geocoded place name). Coords win over the text box;
  // the text box still carries the reverse-geocoded label for display.
  const rawLat = p.get("lat");
  const rawLng = p.get("lng");
  const latNum = rawLat ? Number(rawLat) : NaN;
  const lngNum = rawLng ? Number(rawLng) : NaN;
  const hasCoord =
    Number.isFinite(latNum) &&
    Number.isFinite(lngNum) &&
    latNum >= -90 &&
    latNum <= 90 &&
    lngNum >= -180 &&
    lngNum <= 180;

  const inputs = {
    place: (p.get("place") ?? "").trim(),
    placeLat: hasCoord ? latNum : null,
    placeLng: hasCoord ? lngNum : null,
    radiusMi: numParam(p.get("radius"), DEFAULTS.radiusMi),
    back: parseBackDays(p.get("back"), DEFAULTS.back),
    stops: numParam(p.get("stops"), DEFAULTS.stops),
    minNeeds: numParam(p.get("minneeds"), DEFAULTS.minNeeds),
    seenStatus: p.get("seen") === "all" ? ("all" as const) : ("needs" as const),
    rareOnly: p.get("rare") === "1",
    includeHistorical: p.get("hist") === "1",
  };

  // Per-hotspot "how birdy / how recent" context, keyed by locId. eBird's
  // ref/hotspot/info has no such stats (admin metadata only); they come from the
  // geo hotspots endpoint, which one cached call covers for the whole radius.
  type HotspotMeta = Record<
    string,
    { numSpeciesAllTime: number | null; latestObsDt: string | null }
  >;
  const base = {
    inputs,
    bounds: BOUNDS,
    canEdit,
    hotspotMeta: {} as HotspotMeta,
    candidateTokens: {} as Record<string, string>,
  };

  // No query yet (first visit) → just render the form.
  if (!p.has("place") && !p.has("radius") && !hasCoord) {
    return {
      ...base,
      anchor: null,
      query: null,
      preview: null,
      errors: [],
      needsLocation: false,
    };
  }

  // Resolve the anchor: searched place → geocode; else the user's home.
  const homeRow = await query<{
    home_lat: number | null;
    home_lon: number | null;
    home_label: string | null;
  }>("SELECT home_lat, home_lon, home_label FROM users WHERE id = $1", [
    userId,
  ]);
  const home = homeRow.rows[0];

  let anchor: { lat: number; lng: number; label: string } | null = null;
  const errors: string[] = [];
  if (inputs.placeLat != null && inputs.placeLng != null) {
    // Exact point from a map pin — no geocode round-trip; keep the precision.
    anchor = {
      lat: inputs.placeLat,
      lng: inputs.placeLng,
      label:
        inputs.place ||
        `${inputs.placeLat.toFixed(4)}, ${inputs.placeLng.toFixed(4)}`,
    };
  } else if (inputs.place) {
    const geo = await geocodePlace(inputs.place);
    if (geo) anchor = { lat: geo.lat, lng: geo.lng, label: geo.name };
    else
      errors.push(
        `Couldn't find "${inputs.place}". Try a city, county, park, or address.`,
      );
  }
  if (!anchor && home?.home_lat != null && home.home_lon != null) {
    anchor = {
      lat: home.home_lat,
      lng: home.home_lon,
      label: home.home_label ?? "Home",
    };
  }
  if (!anchor) {
    return {
      ...base,
      anchor: null,
      query: null,
      preview: null,
      errors,
      needsLocation: errors.length === 0,
    };
  }

  const validated = validateTripParams({
    anchorLat: anchor.lat,
    anchorLng: anchor.lng,
    anchorLabel: anchor.label,
    radiusKm: milesToKm(inputs.radiusMi),
    daysBack: inputs.back,
    numStops: inputs.stops,
    minNeedsPerStop: inputs.minNeeds,
    seenStatus: inputs.seenStatus,
    rareOnly: inputs.rareOnly,
    includeHistoricalStop: inputs.includeHistorical,
  });
  if (!validated.ok) {
    return {
      ...base,
      anchor,
      query: null,
      preview: null,
      errors: [...errors, ...validated.errors],
      needsLocation: false,
    };
  }

  const apiKey = await getEbirdApiKey(userId);
  if (!apiKey) {
    errors.push("Add your eBird API key in Settings to plan a trip.");
    return {
      ...base,
      anchor,
      query: null,
      preview: null,
      errors,
      needsLocation: false,
    };
  }

  const params = validated.value;
  const filters: QueryFilters = params; // TripQueryParams extends QueryFilters
  let queryResult: QueryResult | null = null;
  let preview: PlannedTripPreview | null = null;
  try {
    queryResult = await runQuery(
      userId,
      apiKey,
      filters,
      params.minNeedsPerStop,
    );
    preview = await assembleTripPreview(params, queryResult);
  } catch (err) {
    errors.push(
      err instanceof EbirdError
        ? err.message
        : "Could not load eBird data for this area.",
    );
  }

  return {
    ...base,
    anchor,
    query: queryResult,
    preview,
    errors,
    needsLocation: false,
    hotspotMeta: queryResult?.hotspotMeta ?? {},
    candidateTokens: (() => {
      if (!queryResult) return {} as Record<string, string>;
      const tokens: Record<string, string> = {};
      const plannedAt = new Date().toISOString();
      for (const c of queryResult.candidates) {
        const context: TripCountContext = {
          version: 1,
          source: params.rareOnly ? "area-notable-preview" : "area-recent-preview",
          seenStatus: params.seenStatus,
          daysBack: params.daysBack,
          anchorLat: Number(params.anchorLat.toFixed(2)),
          anchorLng: Number(params.anchorLng.toFixed(2)),
          radiusKm: params.radiusKm,
          anchorLabel: params.anchorLabel,
          locationId: c.locId,
          locationLat: c.lat,
          locationLng: c.lng,
          count: c.matchCount,
          fetchedAt: queryResult.fetchedAt,
          plannedAt,
          stale: queryResult.observationStale,
        };
        try {
          tokens[c.locId ?? `${c.lat},${c.lng}`] = issueTripCountToken(locals.user!.id, userId, context);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : "Trip count snapshot configuration is unavailable.");
          break;
        }
      }
      return tokens;
    })(),
  };
};

export const actions: Actions = {
  save: async ({ locals, request }) => {
    if (locals.user?.role === "viewer") return fail(403, { error: "Viewers cannot save trips." });
    const form = await request.formData();
    const name = (form.get("name") ?? "").toString().trim();
    const stopsJson = (form.get("stops") ?? "").toString();
    if (!name) return fail(400, { error: "Give the trip a name." });

    let parsed: unknown;
    try {
      parsed = JSON.parse(stopsJson);
    } catch {
      return fail(400, {
        error: "Trip preview was malformed — re-run the plan and try again.",
      });
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return fail(400, { error: "No stops to save — re-run the plan." });
    }

    const stops: PlannedTripStopInput[] = [];
    const identities = new Set<string>();
    for (const raw of parsed) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return fail(400, { error: "A stop was malformed — re-run the plan." });
      }
      const s = raw as Record<string, unknown>;
      const lat = typeof s.lat === "number" ? s.lat : NaN;
      const lon = typeof s.lon === "number" ? s.lon : NaN;
      const nm = typeof s.name === "string" ? s.name.trim() : "";
      if (!nm || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        return fail(400, {
          error: "A stop was missing a name or coordinates — re-run the plan.",
        });
      }
      const hotspotId = typeof s.hotspot_id === "string" && s.hotspot_id ? s.hotspot_id : null;
      const countRaw = s.target_count_at_save;
      const count = countRaw === null || countRaw === undefined ? null : typeof countRaw === "number" ? countRaw : NaN;
      if (count !== null && (!Number.isSafeInteger(count) || count < 0)) {
        return fail(400, { error: "A stop had an invalid count — re-run the plan." });
      }
      const token = s.count_context_token;
      const identity = hotspotId ?? `${lat},${lon}`;
      if (identities.has(identity)) return fail(400, { error: "The preview contained a duplicate stop — re-run the plan." });
      identities.add(identity);
      const historical = hotspotId === null && count === null && token == null;
      let context: AnyTripCountContext | null = null;
      if (!historical) {
        if (typeof token !== "string" || !token || count === null) {
          return fail(400, { error: "This trip preview is missing its signed count snapshot — re-run the plan." });
        }
        try {
          const verified = verifyTripCountToken(token, locals.user!.id, locals.scopeId!);
          if (!contextMatchesStop(verified.context, { hotspot_id: hotspotId, lat, lon, target_count_at_save: count })) {
            return fail(400, { error: "This trip preview changed location or count — re-run the plan." });
          }
          context = parseAnyTripCountContext(verified.context);
        } catch (err) {
          return fail(400, { error: err instanceof TripCountTokenError ? err.message : "Trip count snapshot configuration is unavailable." });
        }
      }
      stops.push({
        hotspot_id: hotspotId,
        name: nm.slice(0, 200),
        lat,
        lon,
        google_place_id:
          typeof s.google_place_id === "string" && s.google_place_id
            ? s.google_place_id.slice(0, 300)
            : null,
        notes: typeof s.notes === "string" ? s.notes.slice(0, 500) : null,
        target_count_at_save: count as number | null,
        planned_count_context: historical ? null : context,
      });
    }
    if (stops.length > BOUNDS.numStops.max + 1) {
      return fail(400, { error: "Too many stops to save." });
    }

    const tripId = await savePlannedTrip(
      locals.user!.id,
      {
        name,
        startDate: null,
        endDate: null,
        notes: "Generated by the trip planner.",
      },
      stops,
    );
    throw redirect(303, `/trips/${tripId}`);
  },
};
