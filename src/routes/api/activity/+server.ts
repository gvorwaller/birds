import type { RequestHandler } from "./$types";
import { recordActivity } from "$server/user-activity";
import { usageFeatureFor } from "$lib/usage-features";

/**
 * POST { routeId } — the browser reports a page it finished showing without
 * an error (td-c8e6a3; src/lib/usage-report.ts). Counting here instead of in
 * the request hook means preloads, failed or redirected loads and download
 * endpoints never count. Personal to the signed-in account (viewers too).
 * Unknown or uncounted routes are accepted and ignored.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  let routeId: unknown = null;
  try {
    routeId = ((await request.json()) as { routeId?: unknown })?.routeId;
  } catch {
    return new Response(null, { status: 400 });
  }
  const feature = typeof routeId === "string" ? usageFeatureFor(routeId) : null;
  if (feature) await recordActivity(locals.user.id, feature);
  return new Response(null, { status: 204 });
};
