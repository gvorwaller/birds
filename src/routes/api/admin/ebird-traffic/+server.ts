import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { ebirdTrafficReport } from "$server/ebird-traffic";

// Admin → Metrics, eBird traffic (td-009031). Like /admin itself: 404 for
// anyone but an admin. Reads the daily totals only; never calls eBird.
export const GET: RequestHandler = async ({ locals }) => {
  if (locals.user?.role !== "admin") throw error(404, "Not found");

  return json(await ebirdTrafficReport(), {
    headers: { "cache-control": "private, no-store" },
  });
};
