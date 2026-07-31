/**
 * Canonical-route helpers shared by the unified Home, the `/targets`
 * compatibility redirect, and the species drilldown's back link.
 *
 * Home used to be split across `/` ("Near Me") and `/targets`. `/` is now the
 * single canonical route; `/targets` survives only as a query-preserving
 * redirect, so links minted before the consolidation keep working.
 */

export const HOME_PATH = "/";
export const HOME_LABEL = "Home";

/** Legacy route that now redirects to {@link HOME_PATH}. */
export const LEGACY_HOME_PATH = "/targets";

/**
 * `/` carrying an existing query string. Used both for the `/targets` redirect
 * and for minting species return links, so the two can never drift.
 */
export function homeUrlWithQuery(search: string | null | undefined): string {
  if (!search) return HOME_PATH;
  const q = search.startsWith("?") ? search.slice(1) : search;
  return q ? `${HOME_PATH}?${q}` : HOME_PATH;
}

export interface ReturnLink {
  href: string;
  label: string;
}

/**
 * Normalize a `returnTo` value into a safe local link.
 *
 * Open-redirect protection is deliberately identical to the pre-consolidation
 * rule: local absolute paths only, never protocol-relative. What changed is the
 * fallback (`/`, not `/targets`) and the labels — a legacy `/targets…` value is
 * still honored verbatim so old links land where the user expects, but it is
 * presented as "Home" because that is what the route is now called.
 */
export function safeReturnTo(raw: string | null | undefined): ReturnLink {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return { href: HOME_PATH, label: HOME_LABEL };
  }
  const isHome =
    raw === HOME_PATH ||
    raw.startsWith("/?") ||
    raw === LEGACY_HOME_PATH ||
    raw.startsWith(`${LEGACY_HOME_PATH}?`);
  return { href: raw, label: isHome ? HOME_LABEL : "Back" };
}
