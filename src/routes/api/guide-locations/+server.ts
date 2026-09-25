import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { parseGuideChoicesRequest } from "$lib/guide-location";
import { guideChoicesFor } from "$server/guide-location";

/**
 * Place choices for the Field Guide's draft filters (td-daff98): the states of
 * a country, the loaded counties of a state, or the loaded hotspots of a
 * county, so the next Place field fills in without re-running the search.
 * The same helpers the page loader uses, so the lists are identical. Reads
 * DB/reference data only: no eBird, Google or AI calls.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.scopeId) throw error(401, "Unauthorized");
  const request = parseGuideChoicesRequest(url.searchParams);
  if (!request.ok) throw error(400, request.message);
  const choices = await guideChoicesFor(request.level, request.parent);
  if (choices === null)
    throw error(
      400,
      request.level === "region"
        ? "That country is not recognized."
        : request.level === "county"
          ? "That state or region is not recognized."
          : "That county has no loaded data.",
    );
  return json(
    { level: request.level, parent: request.parent, choices },
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
};
