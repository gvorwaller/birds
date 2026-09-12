import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { specialInterestSpecies } from "$server/special-interest";

export const load: PageServerLoad = async ({ locals, url, depends }) => {
  depends("app:special-interest");
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const sort = url.searchParams.get("sort") === "recent" ? "recent" : "name";
  // A failed read is an error page with retry/reload, never a false empty list.
  try {
    return {
      q,
      sort,
      rows: await specialInterestSpecies(locals.user!.id, q, sort),
      accountId: locals.user!.id,
    };
  } catch {
    error(
      503,
      "Could not load Special interest. Reload this page to try again.",
    );
  }
};
