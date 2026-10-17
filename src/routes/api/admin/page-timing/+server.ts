import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { pageTimingReport } from "$server/page-timing";
import { PERF_LOG_SLOW_MS } from "$server/request-timing";

/** A deploy version as /api/health reports it: a git SHA, or "dev". */
const VERSION_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

// Admin → Metrics, Slow pages (td-67b481). 404 for anyone but an admin.
// ?version=<sha> narrows the panel to one deploy; anything else is a 400.
export const GET: RequestHandler = async ({ locals, url }) => {
  if (locals.user?.role !== "admin") throw error(404, "Not found");
  const versions = url.searchParams.getAll("version");
  if (versions.length > 1) throw error(400, "Use only one version.");
  const version = versions[0] || null;
  if (version != null && !VERSION_SHAPE.test(version)) throw error(400, "Unknown version.");

  return json(await pageTimingReport(PERF_LOG_SLOW_MS, version), {
    headers: { "cache-control": "private, no-store" },
  });
};
