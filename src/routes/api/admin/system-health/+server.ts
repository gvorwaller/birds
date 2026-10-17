import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { systemHealth } from "$server/system-health";

// Server health tab's system cards (td-a47c0d), polled every 30 s while the
// tab is open. Like /admin itself: 404 for anyone but an admin.
export const GET: RequestHandler = async ({ locals }) => {
  if (locals.user?.role !== "admin") throw error(404, "Not found");

  return json(await systemHealth(), {
    headers: { "cache-control": "private, no-store" },
  });
};
