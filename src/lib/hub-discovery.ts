/**
 * Hotspots & data geographic discovery contract (Phase 8B, td-687b1c).
 *
 * Client-safe and pure: the server loader, the JSON API, the native GET forms
 * and the map/radius chooser all build and read the same URL through this
 * module. It owns SHAPE, mutual exclusion and URL transitions; identity and
 * evidence live in `$server/hub-discovery`.
 */
import {
  GUIDE_LEVELS,
  GUIDE_PLACE_MAX,
  parseGuideLocation,
  parseGuideMapFields,
  type GuideLevel,
  type GuideLocationSelection,
} from "$lib/guide-location";

export const HUB_PATH = "/forecast/data";
export const HUB_PAGE_SIZE = 50;
/** Shorter searches match too much to be a useful, honest answer. */
export const HUB_FIND_MIN = 2;
export const HUB_FIND_MAX = 100;
/** Fragment id of the server-rendered results block (return paths target it). */
export const HUB_RESULTS_ID = "discovery-results";

export const HUB_TYPED_PARAMS = ["find", "findPage"] as const;
export const HUB_MAP_PARAMS = ["place", "lat", "lng", "dist", "mapPage"] as const;
/**
 * The location a search is limited to (td-a6f8a1): the Field Guide's country,
 * state/region, county and hotspot levels under their own names, because
 * `country` and `region` already preselect the Load form on this page. A
 * typed search keeps them; a map point replaces them.
 */
export const HUB_WITHIN_PARAM: Readonly<Record<GuideLevel, string>> = {
  country: "inCountry",
  region: "inRegion",
  county: "inCounty",
  hotspot: "inHotspot",
};
export const HUB_WITHIN_PARAMS: readonly string[] = GUIDE_LEVELS.map((l) => HUB_WITHIN_PARAM[l]);
/** Every query parameter the discovery state owns. */
export const HUB_DISCOVERY_PARAMS: readonly string[] = [
  ...HUB_TYPED_PARAMS,
  ...HUB_MAP_PARAMS,
  ...HUB_WITHIN_PARAMS,
];
/**
 * Selection state: which existing section to open (`show`) and which region the
 * Load form preselects (`region`). Starting a new discovery clears them so a
 * stale target is never re-opened; they are not discovery state.
 */
export const HUB_SELECTION_PARAMS = ["show", "region"] as const;

/** A chosen country, state or region, county, or hotspot. */
export type HubWithin = Extract<GuideLocationSelection, { kind: "country" | "region" | "county" | "hotspot" }>;

export type HubDiscoveryState =
  | { mode: "none" }
  | { mode: "typed"; find: string; page: number; submitted?: string; within?: HubWithin | null }
  // A location with no typed text: that one place (td-a6f8a1).
  | { mode: "place"; within: HubWithin }
  | { mode: "map"; place: string; lat: number; lng: number; dist: number; page: number };

export type HubDiscoveryParse =
  | { ok: true; state: HubDiscoveryState }
  | { ok: false; message: string };

interface ParamReader {
  getAll(name: string): string[];
}

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** Trim and collapse whitespace; the submitted text is otherwise preserved. */
export function normalizeHubFind(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function parsePage(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n <= 21474836 ? n : null;
}

/**
 * Strictly parses the discovery part of a /forecast/data URL. Empty values
 * count as absent (a native form submits blank fields); anything repeated,
 * malformed, incomplete or mixed is rejected rather than guessed at.
 */
export function parseHubDiscovery(params: ParamReader): HubDiscoveryParse {
  // The location levels follow the Field Guide's rules exactly (shape, one
  // value each, ancestors derived from the code, a hotspot needs its region).
  const levelParam = new Map<string, string>(GUIDE_LEVELS.map((l) => [l, HUB_WITHIN_PARAM[l]]));
  const location = parseGuideLocation({
    getAll: (name) => {
      const mapped = levelParam.get(name);
      return mapped ? params.getAll(mapped) : [];
    },
  });
  if (!location.ok) return location;
  const within =
    location.selection.kind === "anywhere" || location.selection.kind === "map" ? null : location.selection;
  const raw: Record<string, string> = {};
  for (const name of [...HUB_TYPED_PARAMS, ...HUB_MAP_PARAMS]) {
    const all = params.getAll(name);
    if (all.length > 1) return fail(`Use only one ${name} value.`);
    raw[name] = name === "find" ? normalizeHubFind(all[0] ?? "") : (all[0] ?? "").trim();
  }
  const hasTyped = HUB_TYPED_PARAMS.some((p) => raw[p]);
  const hasMap = HUB_MAP_PARAMS.some((p) => raw[p]);
  if (hasTyped && hasMap)
    return fail("Search by name or choose a map point with a radius, not both.");
  if (within && hasMap)
    return fail("Choose a country, state, county or hotspot, or a map point with a radius, not both.");
  if (hasTyped) {
    if (!raw.find) return fail("A results page needs a search.");
    if (raw.find.length > HUB_FIND_MAX)
      return fail(`The search is limited to ${HUB_FIND_MAX} characters.`);
    let page = 1;
    if (raw.findPage) {
      const parsed = parsePage(raw.findPage);
      if (parsed == null) return fail("Invalid results page.");
      page = parsed;
    }
    // `find` (normalized) drives search and URLs; `submitted` keeps what the
    // person typed, for display (bounded so it can never bloat a page).
    const submitted = (params.getAll("find")[0] ?? "").slice(0, HUB_FIND_MAX * 3);
    return { ok: true, state: { mode: "typed", find: raw.find, page, submitted, within } };
  }
  if (hasMap) {
    const mapOnly = { place: raw.place, lat: raw.lat, lng: raw.lng, dist: raw.dist };
    if (!raw.place && !raw.lat && !raw.lng && !raw.dist)
      return fail("A results page needs a map point.");
    const parsed = parseGuideMapFields(mapOnly);
    if (!parsed.ok) return parsed;
    if (parsed.selection.kind !== "map") return fail("Invalid map location.");
    let page = 1;
    if (raw.mapPage) {
      const n = parsePage(raw.mapPage);
      if (n == null) return fail("Invalid results page.");
      page = n;
    }
    const { place, lat, lng, dist } = parsed.selection;
    return { ok: true, state: { mode: "map", place, lat, lng, dist, page } };
  }
  if (within) return { ok: true, state: { mode: "place", within } };
  return { ok: true, state: { mode: "none" } };
}

function cleaned(base: URLSearchParams, names: readonly string[]): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const name of names) next.delete(name);
  return next;
}

/** A new typed search: clears map state and continuation, and any stale
 * selection. The chosen location stays: the text searches inside it. */
export function withHubTyped(base: URLSearchParams, text: string): URLSearchParams {
  const next = cleaned(base, [...HUB_TYPED_PARAMS, ...HUB_MAP_PARAMS, ...HUB_SELECTION_PARAMS]);
  const find = normalizeHubFind(text);
  if (find) next.set("find", find);
  return next;
}

/** A new map point: clears typed state and continuation, and any stale selection. */
export function withHubMap(
  base: URLSearchParams,
  input: { place: string; lat: number; lng: number; dist: number },
): { ok: true; params: URLSearchParams } | { ok: false; message: string } {
  const place = input.place.trim().slice(0, GUIDE_PLACE_MAX).trim();
  const checked = parseGuideMapFields({
    place,
    // Validate the exact six-decimal form the URL will carry.
    lat: Number.isFinite(input.lat) ? input.lat.toFixed(6) : "",
    lng: Number.isFinite(input.lng) ? input.lng.toFixed(6) : "",
    dist: Number.isInteger(input.dist) ? String(input.dist) : "",
  });
  if (!checked.ok) return checked;
  const next = cleaned(base, [...HUB_DISCOVERY_PARAMS, ...HUB_SELECTION_PARAMS]);
  next.set("place", place);
  next.set("lat", input.lat.toFixed(6));
  next.set("lng", input.lng.toFixed(6));
  next.set("dist", String(input.dist));
  return { ok: true, params: next };
}

/** The location levels of a selection, "" where a level is not chosen. */
export function hubWithinLevels(within: HubWithin | null | undefined): Record<GuideLevel, string> {
  return {
    country: within?.country ?? "",
    region: within && within.kind !== "country" ? within.region : "",
    county: within && (within.kind === "county" || within.kind === "hotspot") ? (within.county ?? "") : "",
    hotspot: within?.kind === "hotspot" ? within.hotspot : "",
  };
}

/**
 * A new location (td-a6f8a1): replaces the location levels, keeps the typed
 * text, and clears map state, continuation and any stale selection. Null
 * removes the location.
 */
export function withHubWithin(base: URLSearchParams, within: HubWithin | null): URLSearchParams {
  const next = cleaned(base, [
    "findPage",
    ...HUB_MAP_PARAMS,
    ...HUB_WITHIN_PARAMS,
    ...HUB_SELECTION_PARAMS,
  ]);
  const levels = hubWithinLevels(within);
  for (const level of GUIDE_LEVELS) if (levels[level]) next.set(HUB_WITHIN_PARAM[level], levels[level]);
  return next;
}

/** Sets the continuation page of the current mode; page 1 is the canonical absence. */
export function withHubPage(
  base: URLSearchParams,
  mode: "typed" | "map",
  page: number,
): URLSearchParams {
  const next = new URLSearchParams(base);
  const key = mode === "typed" ? "findPage" : "mapPage";
  next.delete(key);
  if (page > 1) next.set(key, String(page));
  return next;
}

/** Removes only the owned discovery parameters; everything else survives. */
export function clearHubDiscovery(base: URLSearchParams): URLSearchParams {
  return cleaned(base, HUB_DISCOVERY_PARAMS);
}

/** `/forecast/data?…#fragment` for a parameter set. */
export function hubHref(params: URLSearchParams, fragment: string = HUB_RESULTS_ID): string {
  const text = params.toString();
  return `${HUB_PATH}${text ? `?${text}` : ""}${fragment ? `#${fragment}` : ""}`;
}

/** What selecting a result does. Data only: navigation/preselection, never an action. */
export type HubTarget =
  | { kind: "hotspot"; id: string }
  | { kind: "section"; code: string }
  | { kind: "load"; country: string; region: string | null }
  | { kind: "failed"; code: string }
  | { kind: "none" };

/** Element ids the destination page focuses. */
export const hubNodeId = (code: string) => `hub-node-${code}`;
export const HUB_LOAD_ID = "load-region";
export const hubFailedId = (code: string) => `hub-failed-${code}`;

/**
 * `/hotspots/[locId]` for a verified or reported location. Selection is
 * navigation only and must never call eBird, so it opens the workspace's
 * local-only Monthly tab; the default Recent tab reads live observations from
 * eBird for an account with an API key.
 */
export function hubHotspotPath(id: string): string {
  return `/hotspots/${encodeURIComponent(id)}?tab=monthly`;
}

/**
 * The destination of a non-hotspot selection on this page. Unrelated
 * parameters survive; discovery and stale selection state do not (the return
 * path restores them). Returns null for targets that are not on this page.
 */
export function hubSelectHref(base: URLSearchParams, target: HubTarget): string | null {
  const next = cleaned(base, [...HUB_DISCOVERY_PARAMS, ...HUB_SELECTION_PARAMS]);
  switch (target.kind) {
    case "section":
      next.set("show", target.code);
      return hubHref(next, hubNodeId(target.code));
    case "load":
      next.set("country", target.country);
      if (target.region) next.set("region", target.region);
      return hubHref(next, HUB_LOAD_ID);
    case "failed":
      next.set("show", target.code);
      return hubHref(next, hubFailedId(target.code));
    default:
      return null;
  }
}
