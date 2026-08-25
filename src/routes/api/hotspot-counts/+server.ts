import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { areaHotspotCounts } from "$server/hotspot-sweep";

/**
 * Hotspot tallies per child area of `?region=`, for the "229 of 312 loaded ·
 * 83 to load" line on /forecast/data's county rows (td-372d2a follow-up).
 *
 * Lazy on purpose: the data page fetches this only when a group is expanded,
 * so listing 20 states costs nothing until you look at one. The underlying
 * eBird hotspot list is one cached request per region (1-day TTL).
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  const userId = locals.scopeId;
  if (!userId) throw error(401, "Unauthorized");
  const region = (url.searchParams.get("region") ?? "").trim();
  if (!region) throw error(400, "region is required");

  const counts = await areaHotspotCounts(userId, region);
  // No API key, an eBird hiccup, or a code with no child level — the caller
  // just renders no counts.
  if (!counts) return json({ region, counts: {} });
  return json({ region, counts: Object.fromEntries(counts) });
};
