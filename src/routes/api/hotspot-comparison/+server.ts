import { json, type RequestHandler } from "@sveltejs/kit";
import { EbirdError, getEbirdApiKey } from "$server/ebird";
import {
  ComparisonError,
  MAX_INLINE_WAIT_MS,
  compareHotspotBatch,
  emptyRows,
  resolveComparison,
} from "$server/hotspot-comparison";
import type { ComparisonFilters } from "$lib/hotspot-comparison";
import {
  belowHourlyReserve,
  comparisonPacer,
  ebirdRateState,
  PaceDeferred,
} from "$server/ebird-rate";

function response(body: unknown, status = 200): Response {
  return json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function parseFilters(url: URL): ComparisonFilters {
  const number = (name: string): number => {
    const raw = url.searchParams.get(name);
    if (raw == null || raw.trim() === "")
      throw new ComparisonError(`Missing comparison parameter: ${name}.`);
    const n = Number(raw);
    if (!Number.isFinite(n))
      throw new ComparisonError(`Invalid comparison parameter: ${name}.`);
    return n;
  };
  const lat = number("lat");
  const lng = number("lng");
  const radiusKm = number("radiusKm");
  const daysBack = number("daysBack");
  const seenStatus = url.searchParams.get("seenStatus");
  const rare = url.searchParams.get("rareOnly");
  const anchorLabel = url.searchParams.get("anchorLabel");
  if (seenStatus !== "all" && seenStatus !== "needs")
    throw new ComparisonError("Invalid comparison scope.");
  if (rare !== "0" && rare !== "1")
    throw new ComparisonError("Invalid comparison report mode.");
  if (anchorLabel == null || !anchorLabel.trim() || anchorLabel.length > 200)
    throw new ComparisonError("Invalid comparison location label.");
  if (!Number.isInteger(daysBack))
    throw new ComparisonError("Invalid comparison window.");
  return {
    lat,
    lng,
    radiusKm,
    daysBack,
    seenStatus,
    rareOnly: rare === "1",
    anchorLabel,
  };
}

function parsedIds(url: URL): string[] | null {
  const raw = url.searchParams.get("ids");
  if (raw == null || raw.trim() === "") return null;
  const ids = raw.split(",").map((x) => x.trim());
  if (
    ids.length < 1 ||
    ids.length > 4 ||
    ids.some((id) => !/^L\d+$/.test(id)) ||
    new Set(ids).size !== ids.length
  )
    throw new ComparisonError("Choose one to four unique valid hotspot ids.");
  return ids;
}

export const GET: RequestHandler = async ({ locals, url, request }) => {
  if (!locals.user || !locals.scopeId)
    return response(
      { status: "unauthorized", message: "Sign in to compare hotspots." },
      401,
    );
  let filters: ComparisonFilters;
  let ids: string[] | null;
  try {
    filters = parseFilters(url);
    ids = parsedIds(url);
  } catch (err) {
    return response(
      {
        status: "invalid",
        message:
          err instanceof Error ? err.message : "Invalid comparison request.",
      },
      400,
    );
  }
  const apiKey = await getEbirdApiKey(locals.scopeId);
  if (!apiKey)
    return response({
      status: "unavailable",
      message: "Add your eBird API key in Settings to compare hotspots.",
    });
  const account = { accountId: locals.user.id, scopeOwnerId: locals.scopeId };
  try {
    if (!ids) {
      const paceSignal = request.signal;
      const inlineWaitUntil = Date.now() + MAX_INLINE_WAIT_MS;
      const init = await resolveComparison(apiKey, filters, account, {
        pace: () =>
          comparisonPacer.acquire(apiKey, paceSignal, {
            maxBlockMs: Math.max(0, inlineWaitUntil - Date.now()),
            preserveHourlyReserve: true,
          }),
        paceSignal,
      });
      const refStatus = init.referenceRefreshErrorStatus;
      const quotaRemaining =
        refStatus === 429 ? belowHourlyReserve(apiKey) : null;
      const stopReason =
        refStatus === 401 || refStatus === 403
          ? "auth"
          : refStatus === 429
            ? quotaRemaining != null
              ? "quota"
              : "rate"
            : null;
      const retryWait = Math.max(
        0,
        ebirdRateState(apiKey).blockedUntil - Date.now(),
      );
      return response({
        status: "ready",
        identity: init.value,
        references: init.references,
        referenceFetchedAt: init.referenceFetchedAt,
        referenceStale: init.referenceStale,
        stopScheduling: !!refStatus,
        stopReason,
        resumeAfterMs:
          stopReason === "rate" ? Math.max(retryWait, 1000) : undefined,
        quotaRemaining:
          stopReason === "quota" ? quotaRemaining : undefined,
        rows: emptyRows(init.references),
      });
    }
    const identity = url.searchParams.get("identity");
    if (!identity)
      return response(
        {
          status: "invalid",
          message: "Restart the comparison before checking hotspots.",
        },
        400,
      );
    const batch = await compareHotspotBatch(
      apiKey,
      filters,
      account,
      ids,
      identity,
      request.signal,
    );
    return response({
      status: "ready",
      identity: batch.identity.value,
      references: batch.identity.references,
      referenceFetchedAt: batch.identity.referenceFetchedAt,
      referenceStale: batch.identity.referenceStale,
      rows: batch.rows,
      stopScheduling: batch.stopScheduling,
      stopReason: batch.stopReason,
      resumeAfterMs: batch.resumeAfterMs,
      quotaRemaining: batch.quotaRemaining,
    });
  } catch (err) {
    if (err instanceof PaceDeferred)
      return response({
        status: "ready",
        references: ids ? undefined : [],
        rows: [],
        stopScheduling: true,
        stopReason: err.reason,
        resumeAfterMs:
          err.reason === "rate" ? Math.max(err.retryAfterMs ?? 0, 1000) : undefined,
        quotaRemaining:
          err.reason === "quota" ? err.quotaRemaining : undefined,
      });
    if (err instanceof ComparisonError)
      return response(
        {
          status:
            err.status === 409
              ? "restart-required"
              : err.status >= 500
                ? "unavailable"
                : "invalid",
          message: err.message,
          stopScheduling: err.stopScheduling,
        },
        err.status,
      );
    // A live eBird refusal with nothing cached to fall back on (a cold
    // hotspot list): say which one it was, never "temporarily unavailable"
    // (td-5003e2 — GROK hit this with an invalid key).
    if (err instanceof EbirdError && (err.status === 401 || err.status === 403))
      return response({
        status: "unavailable",
        stopReason: "auth",
        message:
          "eBird authorization failed — check your eBird API key in Settings.",
      });
    if (err instanceof EbirdError && err.status === 429) {
      const quotaRemaining = belowHourlyReserve(apiKey);
      const wait = ebirdRateState(apiKey).blockedUntil - Date.now();
      return response({
        status: "ready",
        references: ids ? undefined : [],
        rows: [],
        stopScheduling: true,
        stopReason: quotaRemaining != null ? "quota" : "rate",
        resumeAfterMs:
          quotaRemaining != null ? undefined : Math.max(wait, err.retryAfterMs ?? 0, 1000),
        quotaRemaining: quotaRemaining ?? undefined,
      });
    }
    return response(
      {
        status: "unavailable",
        message: "Hotspot comparison is temporarily unavailable.",
      },
      503,
    );
  }
};
