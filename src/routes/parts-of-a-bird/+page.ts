import { safeReturnTo } from "$lib/return-link";
import type { PageLoad } from "./$types";

// A part link from a species page (td-e4c6dd) carries that page as returnTo, so the back link
// names the bird even without a navigation trail (no JS, a new tab, a shared link).
export const load: PageLoad = ({ url }) => {
  const raw = url.searchParams.get("returnTo");
  const link = raw ? safeReturnTo(raw, url.searchParams.get("returnLabel")) : null;
  return { returnLink: link && link.href !== "/" ? link : null };
};
