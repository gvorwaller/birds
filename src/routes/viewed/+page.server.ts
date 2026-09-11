import { taxonomySummary } from '$server/taxonomy-reference';
import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import {
  clearSpeciesViews,
  setSpeciesViewTracking,
} from "$server/species-views";
import { studyCountries, studySpecies } from "$server/species-study";
import { studyOptions } from "$lib/species-study";

export const load: PageServerLoad = async ({ locals, url, depends }) => {
  depends("app:species-views");
  const options = studyOptions(url.searchParams);
  const result = await studySpecies(
    locals.user!.id,
    options.q,
    options.status,
    options.sort === "taxonomic" ? "taxonomic" : options.sort === "name",
  );
  const taxonomy = await taxonomySummary();
  return {
    taxonomyAvailable: taxonomy.ordered > 0,
    enabled: result.enabled,
    total: result.rows.length,
    rows: options.group === "country" ? [] : result.rows,
    // Stream a large not-yet-viewed count without blocking the controls.
    // A failed query is an explicit retry state, never an empty country list.
    countryGroups:
      options.group === "country"
        ? studyCountries(result.rows.map((row) => row.code))
            .then((countries) => ({ countries, unavailable: false }))
            .catch(() => ({ countries: [], unavailable: true }))
        : Promise.resolve({ countries: [], unavailable: false }),
    ...options,
    openFamily: url.searchParams.get("family") ?? "",
    openCountry: url.searchParams.get("country") ?? "",
    focusCode: url.searchParams.get("focus") ?? "",
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
