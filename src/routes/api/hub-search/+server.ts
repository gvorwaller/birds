import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { parseHubDiscovery } from "$lib/hub-discovery";
import { hubDiscover } from "$server/hub-discovery";

/**
 * Hotspots & data discovery as JSON (Phase 8B). The page loader renders the
 * same result model without JavaScript; this endpoint only serves the debounced
 * enhancement, under the identical strict contract: typed `find`/`findPage` or
 * map `place`/`lat`/`lng`/`dist`/`mapPage`, 50 results per page with an exact
 * total. It is never an uncapped dump, reads local state only, and writes
 * nothing.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.scopeId) throw error(401, "Unauthorized");
  const parsed = parseHubDiscovery(url.searchParams);
  if (!parsed.ok) throw error(400, parsed.message);
  if (parsed.state.mode === "none") return json({ discovery: null });
  return json({ discovery: await hubDiscover(parsed.state) });
};
