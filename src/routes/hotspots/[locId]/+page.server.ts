import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { getEbirdApiKey, recentHotspotObs, EbirdError } from "$server/ebird";
import { frequencyMeta, lastCompleteYear } from "$server/barchart";
import { guidePlaceListHref } from "$lib/guide-location";
import { seenSet } from "$server/needs";
import { enqueueJob } from "$server/jobs";
import { dedupKeys } from "$server/job-policy";
import { sweepAreaHotspots } from "$server/hotspot-sweep";
import { haversineKm } from "$lib/geo";
import {
  groupRecent,
  hotspotFromCache,
  officialHotspotCacheEntry,
  resolveOfficialHotspot,
  hotspotMonthly,
  hotspotPlace,
  regionNames,
  validLocId,
  type HotspotMonthly,
  type RecentDay,
} from "$server/hotspot-page";
import { safeReturnTo } from "$lib/return-link";

/** GROK pin: the Recent window is whitelisted, never free-form. */
const BACK_CHOICES = [7, 14, 30] as const;

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const locId = params.locId;
  // 404, never 500, on malformed ids (GROK pin).
  if (!validLocId(locId)) throw error(404, "Not a hotspot id");
  const scopeId = locals.scopeId!;

  const backRaw = Number(url.searchParams.get("back") ?? 7);
  const back = (BACK_CHOICES as readonly number[]).includes(backRaw) ? backRaw : 7;
  const tab = url.searchParams.get("tab") === "monthly" ? "monthly" : "recent";
  const monthRaw = Number(url.searchParams.get("month"));
  const month =
    Number.isInteger(monthRaw) && monthRaw >= 1 && monthRaw <= 12
      ? monthRaw
      : new Date().getMonth() + 1;
  const returnLink = safeReturnTo(url.searchParams.get("returnTo"), url.searchParams.get("returnLabel"));

  const [listMeta, officialCache, place, freqMap, seen, home, lastLoad, guideCountyRes] = await Promise.all([
    hotspotFromCache(locId),
    officialHotspotCacheEntry(locId),
    hotspotPlace(locId),
    frequencyMeta([locId]),
    seenSet(scopeId),
    query<{ home_lat: number | null; home_lon: number | null }>(
      "SELECT home_lat, home_lon FROM users WHERE id = $1",
      [scopeId],
    ),
    // Terminal jobs drop out of the poll's active set, so a failed load
    // would silently vanish; surface it durably from the queue (GROK pin:
    // failed-job empty state, one sentence + the existing retry button).
    query<{ status: string; error: string | null }>(
      `SELECT status, error FROM jobs
        WHERE type = 'load_hotspots'
          AND status IN ('succeeded', 'failed', 'cancelled')
          AND payload->'locs' @> jsonb_build_array(jsonb_build_object('code', $1::text))
        ORDER BY finished_at DESC NULLS LAST
        LIMIT 1`,
      [locId],
    ),
    // td-c52c37: the Field Guide opens a hotspot only inside its LOADED county,
    // so the species-list link exists only when both rows are stored.
    query<{ county: string }>(
      `SELECT f.region_code AS county
         FROM frequency_fetch f
         JOIN frequency_fetch c ON c.loc_code = f.region_code AND c.loc_kind = 'region'
        WHERE f.loc_code = $1 AND f.loc_kind = 'hotspot'`,
      [locId],
    ),
  ]);
  const officialMeta = officialCache.meta;
  const meta = listMeta ?? officialMeta;
  const freq = freqMap.get(locId) ?? null;

  const locName = meta?.locName ?? freq?.locName ?? place.locName ?? null;
  // Well-formed but unknown everywhere → explicit empty state, not a spinner.
  const known = locName != null;

  const regions = await regionNames(
    [meta?.countyCode, meta?.stateCode].filter((c): c is string => !!c),
  );

  const h = home.rows[0];
  const distanceKm =
    known && meta?.lat != null && meta?.lng != null && h?.home_lat != null && h?.home_lon != null
      ? haversineKm(h.home_lat, h.home_lon, meta.lat, meta.lng)
      : null;

  // Recent tab is the only eBird consumer; Monthly is pure DB (GROK pin).
  let days: RecentDay[] = [];
  let recentError: string | null = null;
  let recentStale = false;
  const apiKey = await getEbirdApiKey(scopeId);
  let hasApiKey = !!apiKey;
  // Live observations are only shown for a VERIFIED hotspot (the page renders
  // a plain unverified state otherwise), so an unverified location never
  // triggers an eBird request just by being opened.
  if (tab === "recent" && known && meta?.isHotspot === true) {
    if (apiKey) {
      try {
        const res = await recentHotspotObs(apiKey, locId, back);
        recentStale = res.stale;
        days = groupRecent(res.data, seen);
      } catch (err) {
        recentError =
          err instanceof EbirdError ? err.message : "Could not load recent reports.";
      }
    }
  }

  let monthly: HotspotMonthly | null = null;
  if (tab === "monthly" && freq) {
    monthly = await hotspotMonthly(locId, month, seen, freq.sampleSizes);
  }

  return {
    locId,
    known,
    verified: meta?.isHotspot === true,
    verificationStale: officialMeta != null && listMeta == null && !officialCache.fresh,
    locName,
    isHotspot: meta?.isHotspot ?? false,
    lat: meta?.lat ?? null,
    lng: meta?.lng ?? null,
    countyName: meta?.countyCode ? (regions.get(meta.countyCode) ?? null) : null,
    // The area this hotspot sits in, for the "load every hotspot here" sweep
    // (td-372d2a) — county when eBird records one, else the region.
    sweepArea: meta?.countyCode
      ? { code: meta.countyCode, name: regions.get(meta.countyCode) ?? meta.countyCode }
      : meta?.stateCode
        ? { code: meta.stateCode, name: regions.get(meta.stateCode) ?? meta.stateCode }
        : null,
    stateName: meta?.stateCode ? (regions.get(meta.stateCode) ?? null) : null,
    venueTypes: place.venueTypes,
    googlePlaceId: place.googlePlaceId,
    numSpeciesAllTime: meta?.numSpeciesAllTime ?? null,
    latestObsDt: meta?.latestObsDt ?? null,
    distanceKm,
    speciesListHref: freq ? guidePlaceListHref(locId, guideCountyRes.rows[0]?.county ?? null) : null,
    freq: freq
      ? {
          beginYear: freq.beginYear,
          endYear: freq.endYear,
          nSpecies: freq.nSpecies,
          current: freq.endYear >= lastCompleteYear(new Date()),
          totalChecklists: freq.sampleSizes.reduce((a, b) => a + b, 0),
        }
      : null,
    lastLoadFailed: lastLoad.rows[0]?.status === "failed",
    tab,
    back,
    month,
    days,
    recentError,
    recentStale,
    hasApiKey,
    monthly,
    returnLink,
    isViewer: locals.user?.role === "viewer",
  };
};

export const actions: Actions = {
  /** One-click load/refresh for THIS hotspot — thin enqueuer, existing job. */
  load_hotspot: async ({ locals, params, request }) => {
    const userId = locals.scopeId!;
    const locId = params.locId;
    if (!validLocId(locId)) return fail(400, { error: "Not a hotspot id." });
    if (locals.user?.role === "viewer") {
      return fail(403, { error: "Viewers can review hotspot data but cannot load historical data." });
    }
    const form = await request.formData();
    const force = form.get("force") === "1";

    const apiKey = await getEbirdApiKey(userId);
    if (!apiKey) {
      return fail(400, { error: "An eBird API key is required — add one in Settings." });
    }
    const listMeta = await hotspotFromCache(locId);
    const officialCache = await officialHotspotCacheEntry(locId);
    const meta = listMeta ?? (officialCache.fresh ? officialCache.meta : null);
    const freq = (await frequencyMeta([locId])).get(locId);
    let verified = meta;
    let staleVerification = false;
    if (!verified) {
      try {
        const resolved = await resolveOfficialHotspot(locId, apiKey);
        verified = resolved.meta;
        staleVerification = resolved.stale;
      } catch (err) {
        if (err instanceof EbirdError) {
          const message =
            err.status === 401 || err.status === 403
              ? "eBird could not verify this hotspot because the API key is missing or invalid — check Settings."
              : err.status === 429
                ? "eBird is rate-limiting verification. Please retry shortly."
                : err.message;
          return fail(err.status === 429 ? 429 : 502, { error: message, verificationRequired: true });
        }
        return fail(502, {
          error: "Could not verify this hotspot right now. Please retry verification.",
          verificationRequired: true,
        });
      }
    }
    if (!verified) {
      return fail(422, {
        error:
          "eBird did not provide verified hotspot details for this ID. Try the eBird page or a Forecast search, then retry verification.",
        verificationRequired: true,
      });
    }
    const name = verified.locName!;
    const { jobId, deduped } = await enqueueJob({
      type: "load_hotspots",
      payload: {
        locs: [
          {
            code: locId,
            kind: "hotspot" as const,
            name,
            regionCode: verified.countyCode ?? verified.stateCode ?? null,
          },
        ],
        force,
      },
      dedupKey: dedupKeys.loadHotspots([locId]),
      requestedBy: userId,
      label: `1 hotspot — ${name}`,
    });
    return { queued: { jobId, deduped, label: name, staleVerification } };
  },

  /** Sweep every hotspot in this one's county — same helper /forecast/data
   * uses, so the two entry points can't drift (td-372d2a). */
  load_area_hotspots: async ({ locals, request }) => {
    const userId = locals.scopeId!;
    const form = await request.formData();
    const areaCode = (form.get("area") ?? "").toString().trim();
    const res = await sweepAreaHotspots(userId, areaCode);
    if (!res.ok) return fail(res.status, { error: res.error });
    return { queued: { jobId: res.jobId, deduped: res.deduped, label: res.label } };
  },
};
