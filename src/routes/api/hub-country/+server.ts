import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { isCountry } from "$lib/region-code";
import { _hubCountryGroups } from "../../forecast/data/+page.server";

/**
 * One country's state/region groups for Hotspots & data, fetched when that
 * country is opened (td-b6be76). The page ships only each country's summary;
 * shipping all ~3,000 folded groups made it a 1.5 MB page. Built by the same
 * loader as the page, so the groups are identical; reads local data only.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.scopeId) throw error(401, "Unauthorized");
  const all = url.searchParams.getAll("country");
  if (all.length !== 1) throw error(400, "Give exactly one country.");
  const country = all[0].trim().toUpperCase();
  if (!isCountry(country)) throw error(400, "Choose a recognized country.");
  const groups = await _hubCountryGroups({ locals, url: new URL("/forecast/data", url) }, country);
  if (!groups) throw error(404, "That country has no loaded data.");
  return json(
    { country, groups },
    { headers: { "Cache-Control": "private, no-store" } },
  );
};
