import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { adminLiveStatus } from "$server/admin-status";

export const GET: RequestHandler = async ({ locals }) => {
  // Match /admin itself: do not disclose this operational surface to
  // non-admin accounts.
  if (locals.user?.role !== "admin") throw error(404, "Not found");

  return json(await adminLiveStatus(), {
    headers: { "cache-control": "private, no-store" },
  });
};
