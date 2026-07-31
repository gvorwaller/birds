import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { homeUrlWithQuery } from "$lib/return-link";

/**
 * Compatibility redirect. Targets and Near Me were consolidated into a single
 * Home at `/`; this keeps bookmarks and pre-consolidation species `returnTo`
 * values working, query string intact.
 *
 * 303 rather than a permanent redirect: real bookmarks and legacy `returnTo`
 * values make this path long-lived, and a sticky browser/CDN cache buys little.
 */
export const load: PageServerLoad = ({ url }) => {
  throw redirect(303, homeUrlWithQuery(url.search));
};
