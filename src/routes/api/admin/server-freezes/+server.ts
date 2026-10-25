import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { serverFreezesReport } from "$server/freeze-watch";

// Admin → Metrics, Server freezes (td-b07462). 404 for anyone but an admin.
export const GET: RequestHandler = async ({ locals }) => {
  if (locals.user?.role !== "admin") throw error(404, "Not found");
  return json(await serverFreezesReport(), { headers: { "cache-control": "private, no-store" } });
};
