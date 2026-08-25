import { getEbirdApiKey, subregions, hotspotsInRegion, EbirdError } from "$server/ebird";
import { attemptMeta, frequencyMeta, lastCompleteYear } from "$server/barchart";
import { recentFailures } from "$server/forecast";
import { enqueueJob } from "$server/jobs";
import { dedupKeys } from "$server/job-policy";
import { parseRegionCode, parentOf } from "$lib/region-code";

/** Per-child-area hotspot tally for the "229 of 312 loaded · 83 to load"
 * line on each county row (GBV 2026-08-24 — the sweep button gave no sense of
 * its own size). */
export interface AreaHotspotCounts {
  /** Every hotspot eBird lists in the child area. */
  total: number;
  /** Of those, ones with current stored frequency data. */
  loaded: number;
  /** What a sweep would actually queue right now (excludes cooldowns). */
  pending: number;
}

/**
 * Tally hotspots per child area of `regionCode`, keyed by child code.
 *
 * One eBird call for the WHOLE parent region (its hotspot list carries each
 * hotspot's subnational2Code) instead of one per county — a 67-county state
 * costs a single cached request. Called lazily when a group is expanded, not
 * on page load, so a page listing 20 states doesn't fan out into 20 fetches.
 */
export async function areaHotspotCounts(
  userId: number,
  regionCode: string,
): Promise<Map<string, AreaHotspotCounts> | null> {
  const parsed = parseRegionCode(regionCode);
  if (!parsed || parsed.level === "subnational2") return null;
  const apiKey = await getEbirdApiKey(userId);
  if (!apiKey) return null;

  let hotspots: Awaited<ReturnType<typeof hotspotsInRegion>>["data"];
  try {
    hotspots = (await hotspotsInRegion(apiKey, parsed.code)).data;
  } catch {
    return null; // counts are decoration — never break the page for them
  }

  const [meta, attempts] = await Promise.all([
    frequencyMeta(hotspots.map((h) => h.locId)),
    attemptMeta(hotspots.map((h) => h.locId)),
  ]);
  const cooling = recentFailures(attempts, new Date());
  const cutoff = lastCompleteYear();
  const out = new Map<string, AreaHotspotCounts>();
  for (const h of hotspots) {
    // Hotspots with no county on record belong to the region itself — the
    // same bucket the region-level sweep would cover.
    const key = h.subnational2Code ?? parsed.code;
    const c = out.get(key) ?? { total: 0, loaded: 0, pending: 0 };
    c.total += 1;
    const m = meta.get(h.locId);
    const current = !!m && m.endYear >= cutoff;
    if (current) c.loaded += 1;
    else if (!cooling.has(h.locId)) c.pending += 1;
    out.set(key, c);
  }
  return out;
}

export interface SweepFailure {
  ok: false;
  status: 400 | 404 | 502;
  error: string;
}

export interface SweepSuccess {
  ok: true;
  jobId: number;
  deduped: boolean;
  label: string;
}

/**
 * Queue every eBird hotspot in one area that isn't already loaded (td-372d2a).
 *
 * The other hotspot entry points are piecemeal — the species drill takes a
 * ranked top-N, the hotspot page loads one at a time — which leaves coverage
 * patchy and hard to reason about. A whole county (or, for countries with no
 * subnational2, a whole subnational1 region) is the systematic unit: once it
 * finishes, "this county is done" is a fact rather than a guess.
 *
 * Shared by /forecast/data and the hotspot page so both offer the identical
 * sweep. Already-current hotspots and ones in failure cooldown are dropped, so
 * re-running only picks up what's actually missing. Fetch pacing is the job
 * queue's (barchart.ts); a sweep can be cancelled from the Background loads
 * card like any other job.
 */
export async function sweepAreaHotspots(
  userId: number,
  areaCode: string,
): Promise<SweepSuccess | SweepFailure> {
  const parsed = parseRegionCode(areaCode);
  if (!parsed || parsed.level === "country") {
    return { ok: false, status: 400, error: "Unrecognized region code." };
  }
  const apiKey = await getEbirdApiKey(userId);
  if (!apiKey) {
    return {
      ok: false,
      status: 400,
      error: "An eBird API key is required to list hotspots — add one in Settings.",
    };
  }

  let hotspots: Awaited<ReturnType<typeof hotspotsInRegion>>["data"];
  let areaName = areaCode;
  try {
    // Membership check against the official child list of the area's parent —
    // the same validation loadRegion/analyzeCounties use.
    const siblings = (
      await subregions(
        apiKey,
        parentOf(parsed.code)!,
        parsed.level === "subnational2" ? "subnational2" : "subnational1",
      )
    ).data;
    const match = siblings.find((c) => c.code === parsed.code);
    if (!match) {
      return { ok: false, status: 400, error: "eBird doesn't list that region." };
    }
    areaName = match.name;
    hotspots = (await hotspotsInRegion(apiKey, parsed.code)).data;
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error:
        err instanceof EbirdError
          ? err.message
          : "Could not list hotspots for that region.",
    };
  }
  if (hotspots.length === 0) {
    return { ok: false, status: 404, error: `eBird lists no hotspots in ${areaName}.` };
  }

  const codes = hotspots.map((h) => h.locId);
  const [meta, attempts] = await Promise.all([frequencyMeta(codes), attemptMeta(codes)]);
  const cooling = recentFailures(attempts, new Date());
  const cutoff = lastCompleteYear();
  const pending = hotspots.filter((h) => {
    const m = meta.get(h.locId);
    return !(m && m.endYear >= cutoff) && !cooling.has(h.locId);
  });
  if (pending.length === 0) {
    return {
      ok: false,
      status: 400,
      error: `All ${hotspots.length} hotspots in ${areaName} are already loaded.`,
    };
  }

  const locs = pending.map((h) => ({
    code: h.locId,
    kind: "hotspot" as const,
    name: h.locName,
    // Most specific containing region so /forecast/data nests them under the
    // right county block.
    regionCode: h.subnational2Code ?? parsed.code,
  }));
  const label = `${locs.length} hotspot${locs.length === 1 ? "" : "s"} in ${areaName}`;
  const { jobId, deduped } = await enqueueJob({
    type: "load_hotspots",
    // areaCode identifies the sweep to the UI (jobTarget) so the county row
    // that launched it can show live progress. Single-hotspot loads omit it
    // and keep answering null, as before.
    payload: { locs, areaCode: parsed.code },
    dedupKey: dedupKeys.loadHotspots(locs.map((l) => l.code)),
    requestedBy: userId,
    label,
  });
  return { ok: true, jobId, deduped, label };
}
