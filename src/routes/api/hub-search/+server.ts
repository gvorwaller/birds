import { json, error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { hubSearch } from "$server/region-detail";

/**
 * Server-side search over loaded locations for /forecast/data (td-3bf3a2).
 * Replaces a client-side filter that required the whole page payload to be
 * shipped just so it could be searched locally.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.scopeId) throw error(401, "Unauthorized");
  const q = (url.searchParams.get("q") ?? "").slice(0, 100);
  return json(await hubSearch(q));
};
