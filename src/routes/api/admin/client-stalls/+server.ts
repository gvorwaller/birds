import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { clientStallsReport } from "$server/client-stalls";

// Admin → Metrics, Stuck pages (td-1cb094). 404 for anyone but an admin.
export const GET: RequestHandler = async ({ locals }) => {
  if (locals.user?.role !== "admin") throw error(404, "Not found");
  return json(await clientStallsReport(), { headers: { "cache-control": "private, no-store" } });
};
