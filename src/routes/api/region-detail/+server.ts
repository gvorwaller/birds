import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { regionDetail } from "$server/region-detail";

/**
 * County blocks + nested hotspots for ONE region group on /forecast/data,
 * fetched when the group is expanded (td-3bf3a2).
 *
 * The page used to ship all of it — ~1.2 MB across 3,459 county and 4,731
 * hotspot rows — on every visit, which is what blocked the country search
 * box for ~10 s while the client parsed and hydrated it.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.scopeId) throw error(401, "Unauthorized");
  const region = (url.searchParams.get("region") ?? "").trim();
  if (!region) throw error(400, "region is required");
  // Display name only reaches the county Maps query string; the client
  // already has it, and it is never trusted as an identifier.
  const stateName = (url.searchParams.get("name") ?? region).slice(0, 120);
  return json(await regionDetail(region, stateName));
};
