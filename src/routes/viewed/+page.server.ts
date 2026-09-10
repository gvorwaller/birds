import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import {
  clearSpeciesViews,
  setSpeciesViewTracking,
  viewedSpecies,
} from "$server/species-views";

export const load: PageServerLoad = async ({ locals, url, depends }) => {
  depends("app:species-views");
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const sort = url.searchParams.get("sort") === "name" ? "name" : "recent";
  return {
    ...(await viewedSpecies(locals.user!.id, q, sort === "name")),
    q,
    sort,
    accountId: locals.user!.id,
  };
};
export const actions: Actions = {
  tracking: async ({ locals, request }) => {
    const data = await request.formData();
    if (data.get("accountId") !== String(locals.user!.id))
      return fail(409, { error: "Account changed; reload this page." });
    const enabled = data.get("enabled");
    if (enabled !== "true" && enabled !== "false")
      return fail(400, { error: "Choose pause or resume." });
    await setSpeciesViewTracking(locals.user!.id, enabled === "true");
    return {
      message:
        enabled === "true"
          ? "Viewing history resumed for future visits."
          : "Viewing history paused.",
    };
  },
  clear: async ({ locals, request }) => {
    const data = await request.formData();
    if (data.get("accountId") !== String(locals.user!.id))
      return fail(409, { error: "Account changed; reload this page." });
    if (data.get("confirm") !== "clear")
      return fail(400, { error: "Confirm clearing your history." });
    await clearSpeciesViews(locals.user!.id);
    return { message: "Your viewing history has been cleared." };
  },
};
