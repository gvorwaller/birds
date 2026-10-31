import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { taxonomyLiveStatus } from "$server/taxonomy-refresh";

/** Taxonomy tab (td-6093ae): a run's stage and reload progress, polled while work is under way. */
export const GET: RequestHandler = async ({ locals, url }) => {
  // Match /admin itself: do not disclose this operational surface to non-admin accounts.
  if (locals.user?.role !== "admin") throw error(404, "Not found");
  const runId = Number(url.searchParams.get("run"));
  if (!Number.isSafeInteger(runId) || runId <= 0) throw error(400, "Unknown taxonomy run.");
  const status = await taxonomyLiveStatus(runId);
  if (!status) throw error(404, "Unknown taxonomy run.");
  return json(status, { headers: { "cache-control": "private, no-store" } });
};
