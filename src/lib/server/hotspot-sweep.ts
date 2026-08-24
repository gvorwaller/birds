import { getEbirdApiKey, subregions, hotspotsInRegion, EbirdError } from "$server/ebird";
import { attemptMeta, frequencyMeta, lastCompleteYear } from "$server/barchart";
import { recentFailures } from "$server/forecast";
import { enqueueJob } from "$server/jobs";
import { dedupKeys } from "$server/job-policy";
import { parseRegionCode, parentOf } from "$lib/region-code";

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
    payload: { locs },
    dedupKey: dedupKeys.loadHotspots(locs.map((l) => l.code)),
    requestedBy: userId,
    label,
  });
  return { ok: true, jobId, deduped, label };
}
