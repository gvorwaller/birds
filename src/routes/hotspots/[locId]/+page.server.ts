import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { getEbirdApiKey, recentHotspotObs, EbirdError, type EbirdObs } from "$server/ebird";
import { frequencyMeta, lastCompleteYear } from "$server/barchart";
import { seenSet } from "$server/needs";
import { enqueueJob } from "$server/jobs";
import { dedupKeys } from "$server/job-policy";
import { haversineKm } from "$lib/geo";
import {
  hotspotFromCache,
  hotspotMonthly,
  hotspotPlace,
  regionNames,
  validLocId,
  type HotspotMonthly,
} from "$server/hotspot-page";
import { safeReturnTo } from "$lib/return-link";

/** GROK pin: the Recent window is whitelisted, never free-form. */
const BACK_CHOICES = [7, 14, 30] as const;

export interface ChecklistGroup {
  subId: string | null;
  time: string | null;
  species: {
    speciesCode: string;
    comName: string;
    howMany: number | null;
    need: boolean;
    unconfirmed: boolean;
  }[];
}

export interface DayGroup {
  date: string;
  checklists: ChecklistGroup[];
}

function groupObs(obs: readonly EbirdObs[], seen: ReadonlySet<string>): DayGroup[] {
  const days = new Map<string, Map<string, ChecklistGroup>>();
  for (const o of obs) {
    const [date, time] = (o.obsDt ?? "").split(" ");
    const subKey = o.subId ?? `${date} ${time ?? ""}`;
    let day = days.get(date);
    if (!day) {
      day = new Map();
      days.set(date, day);
    }
    let cl = day.get(subKey);
    if (!cl) {
      cl = { subId: o.subId ?? null, time: time ?? null, species: [] };
      day.set(subKey, cl);
    }
    cl.species.push({
      speciesCode: o.speciesCode,
      comName: o.comName,
      howMany: o.howMany ?? null,
      need: !seen.has(o.speciesCode),
      unconfirmed: !o.obsValid || !o.obsReviewed,
    });
  }
  // Newest day first; within a day keep eBird's order (already recency-ish).
  return [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, cls]) => ({ date, checklists: [...cls.values()] }));
}

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
  const returnLink = safeReturnTo(url.searchParams.get("returnTo"));

  const [meta, place, freqMap, seen, home] = await Promise.all([
    hotspotFromCache(locId),
    hotspotPlace(locId),
    frequencyMeta([locId]),
    seenSet(scopeId),
    query<{ home_lat: number | null; home_lon: number | null }>(
      "SELECT home_lat, home_lon FROM users WHERE id = $1",
      [scopeId],
    ),
  ]);
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
  let days: DayGroup[] = [];
  let recentError: string | null = null;
  let recentStale = false;
  let hasApiKey = false;
  if (tab === "recent" && known) {
    const apiKey = await getEbirdApiKey(scopeId);
    hasApiKey = !!apiKey;
    if (apiKey) {
      try {
        const res = await recentHotspotObs(apiKey, locId, back);
        recentStale = res.stale;
        days = groupObs(res.data, seen);
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
    locName,
    isHotspot: meta?.isHotspot ?? false,
    lat: meta?.lat ?? null,
    lng: meta?.lng ?? null,
    countyName: meta?.countyCode ? (regions.get(meta.countyCode) ?? null) : null,
    stateName: meta?.stateCode ? (regions.get(meta.stateCode) ?? null) : null,
    venueTypes: place.venueTypes,
    googlePlaceId: place.googlePlaceId,
    numSpeciesAllTime: meta?.numSpeciesAllTime ?? null,
    latestObsDt: meta?.latestObsDt ?? null,
    distanceKm,
    freq: freq
      ? {
          beginYear: freq.beginYear,
          endYear: freq.endYear,
          nSpecies: freq.nSpecies,
          current: freq.endYear >= lastCompleteYear(new Date()),
          totalChecklists: freq.sampleSizes.reduce((a, b) => a + b, 0),
        }
      : null,
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
    const form = await request.formData();
    const force = form.get("force") === "1";

    const apiKey = await getEbirdApiKey(userId);
    if (!apiKey) {
      return fail(400, { error: "An eBird API key is required — add one in Settings." });
    }
    const meta = await hotspotFromCache(locId);
    const freq = (await frequencyMeta([locId])).get(locId);
    const name = meta?.locName ?? freq?.locName;
    if (!name) {
      return fail(400, { error: "This location is not in our hotspot cache yet." });
    }
    const { jobId, deduped } = await enqueueJob({
      type: "load_hotspots",
      payload: {
        locs: [
          {
            code: locId,
            kind: "hotspot" as const,
            name,
            regionCode: meta?.countyCode ?? meta?.stateCode ?? null,
          },
        ],
        force,
      },
      dedupKey: dedupKeys.loadHotspots([locId]),
      requestedBy: userId,
      label: `1 hotspot — ${name}`,
    });
    return { queued: { jobId, deduped, label: name } };
  },
};
