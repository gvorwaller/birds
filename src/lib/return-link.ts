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
/** Known origin pages get a real name on the back link instead of "Back". */
const LABELED_PATHS: [path: string, label: string][] = [
  ["/life", "Life list"],
  ["/forecast/species", "Species forecast"],
  ["/forecast/data", "Hotspots & data"],
  ["/forecast", "Forecast"],
  ["/trips", "Trips"],
  ["/photos", "Photos"],
];

export function safeReturnTo(raw: string | null | undefined): ReturnLink {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return { href: HOME_PATH, label: HOME_LABEL };
  }
  const isHome =
    raw === HOME_PATH ||
    raw.startsWith("/?") ||
    raw === LEGACY_HOME_PATH ||
    raw.startsWith(`${LEGACY_HOME_PATH}?`);
  if (isHome) return { href: raw, label: HOME_LABEL };
  // The Field guide is exact-or-query only — "/species/..." is a species
  // DETAIL page and must fall through to "Back", not read as the guide.
  if (raw === "/species" || raw.startsWith("/species?")) {
    return { href: raw, label: "Field guide" };
  }
  // Most-specific prefix first (the list is ordered that way).
  for (const [path, label] of LABELED_PATHS) {
    if (raw === path || raw.startsWith(`${path}?`) || raw.startsWith(`${path}/`)) {
      return { href: raw, label };
    }
  }
  return { href: raw, label: "Back" };
}

/** A species DETAIL page: `/species/<code>`, never the guide index itself. */
const SPECIES_DETAIL_RE = /^\/species\/([a-z0-9]{4,12})(?:[?#]|$)/;

export interface Crumb extends ReturnLink {
  /**
   * Set when the crumb is a species detail page. Callers that know the
   * taxonomy (the forecast pages do) swap in the bird's common name; the
   * generic "Species" label is the fallback when they don't.
   */
  speciesCode?: string;
}

/**
 * Expand a `returnTo` into a breadcrumb trail, oldest ancestor first.
 *
 * The species page links onward to the species forecast carrying its own URL
 * — which itself carries the `returnTo` that brought the user to the species
 * page. Following that one extra level turns a dead-end "← Back" into a real
 * trail (Field guide › Great Black-backed Gull), so the forecast page can
 * offer both the bird and the list it came from in one click
 * (Gaylon 2026-08-29).
 *
 * Only ONE level of nesting is followed: deeper chains are rare, and each
 * level doubles the URL length that has to survive every navigation.
 */
export function returnTrail(raw: string | null | undefined): Crumb[] {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return [];
  const self = safeReturnTo(raw);
  const detail = SPECIES_DETAIL_RE.exec(raw);
  if (!detail) return [self];
  const crumb: Crumb = { ...self, label: "Species", speciesCode: detail[1] };
  // The species page's own back link — same open-redirect rule, since it
  // arrived here as untrusted query text either way.
  const nestedRaw = new URLSearchParams(raw.slice(raw.indexOf("?") + 1)).get(
    "returnTo",
  );
  const parent =
    raw.includes("?") && nestedRaw && nestedRaw.startsWith("/") && !nestedRaw.startsWith("//")
      ? safeReturnTo(nestedRaw)
      : null;
  return parent ? [parent, crumb] : [crumb];
}
