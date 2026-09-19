import { json, type RequestHandler } from "@sveltejs/kit";
import { getEbirdApiKey } from "$server/ebird";
import {
  ComparisonError,
  compareHotspotBatch,
  emptyRows,
  resolveComparison,
} from "$server/hotspot-comparison";
import type { ComparisonFilters } from "$lib/hotspot-comparison";

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
      const init = await resolveComparison(apiKey, filters, account);
      return response({
        status: "ready",
        identity: init.value,
        references: init.references,
        referenceFetchedAt: init.referenceFetchedAt,
        referenceStale: init.referenceStale,
        stopScheduling: !!init.referenceRefreshErrorStatus,
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
    });
  } catch (err) {
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
    return response(
      {
        status: "unavailable",
        message: "Hotspot comparison is temporarily unavailable.",
      },
      503,
    );
  }
};
