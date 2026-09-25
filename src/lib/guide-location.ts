/**
 * Field Guide geographic selection contract (Phase 8A, td-82fbc1).
 *
 * Client-safe and pure: the server loader, the native GET forms and the
 * map/radius chooser all build and read the same URL through this module, so
 * the browser never declares identity from free-form text. Existence and
 * ancestry against loaded eBird data are verified server-side in
 * `$server/guide-location`; this file only owns SHAPE, mutual exclusion and
 * URL transitions.
 */
import { isHotspotLocId } from "$lib/loc-id";
import { parseRegionCode } from "$lib/region-code";

export const GUIDE_LEVELS = ["country", "region", "county", "hotspot"] as const;
export type GuideLevel = (typeof GUIDE_LEVELS)[number];
export const GUIDE_MAP_PARAMS = ["place", "lat", "lng", "dist"] as const;
/** Every query parameter the Field Guide geography owns. */
export const GUIDE_LOCATION_PARAMS: readonly string[] = [
  ...GUIDE_LEVELS,
  ...GUIDE_MAP_PARAMS,
];

/**
 * Transient "previously applied" values a native filter form submits next to
 * the selects. A plain GET form cannot tell the server which select the person
 * changed, so it also sends what was applied; the server treats the shallowest
 * level that differs as the change and drops everything deeper. They never
 * appear in a final URL (the loader redirects to the canonical one).
 */
export const GUIDE_WAS_PARAMS: readonly string[] = GUIDE_LEVELS.map((l) => `was_${l}`);

export const GUIDE_PLACE_MAX = 200;
export const GUIDE_RADIUS_MIN = 1;
export const GUIDE_RADIUS_MAX = 200;

export type GuideLocationSelection =
  | { kind: "anywhere" }
  | { kind: "country"; country: string }
  | { kind: "region"; country: string; region: string }
  | { kind: "county"; country: string; region: string; county: string }
  | {
      kind: "hotspot";
      country: string;
      region: string;
      county: string;
      hotspot: string;
    }
  | {
      kind: "map";
      place: string;
      lat: number;
      lng: number;
      dist: number;
    };

export type GuideMapSelection = Extract<GuideLocationSelection, { kind: "map" }>;

export type GuideLocationParse =
  | { ok: true; selection: GuideLocationSelection }
  | { ok: false; message: string };

interface ParamReader {
  getAll(name: string): string[];
}

const fail = (message: string): { ok: false; message: string } => ({
  ok: false,
  message,
});

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const WHOLE_RE = /^\d+$/;

/** The levels strictly below `level`, in order. */
export function descendantsOf(level: GuideLevel): GuideLevel[] {
  return GUIDE_LEVELS.slice(GUIDE_LEVELS.indexOf(level) + 1);
}

/** Validates the four map values (already numbers) with the URL rules. */
export function guideMapSelection(input: {
  place: string;
  lat: number;
  lng: number;
  dist: number;
}): GuideLocationParse {
  const place = input.place.trim();
  if (!place) return fail("Choose a map point with a place name.");
  if (place.length > GUIDE_PLACE_MAX)
    return fail(`The place name is limited to ${GUIDE_PLACE_MAX} characters.`);
  if (!Number.isFinite(input.lat) || Math.abs(input.lat) > 90)
    return fail("Latitude must be a number from -90 to 90.");
  if (!Number.isFinite(input.lng) || Math.abs(input.lng) > 180)
    return fail("Longitude must be a number from -180 to 180.");
  if (
    !Number.isInteger(input.dist) ||
    input.dist < GUIDE_RADIUS_MIN ||
    input.dist > GUIDE_RADIUS_MAX
  )
    return fail(
      `Radius must be a whole number of miles from ${GUIDE_RADIUS_MIN} to ${GUIDE_RADIUS_MAX}.`,
    );
  return {
    ok: true,
    selection: {
      kind: "map",
      place,
      lat: input.lat,
      lng: input.lng,
      dist: input.dist,
    },
  };
}

/**
 * Strictly parses the four raw (already trimmed) map values shared by every
 * page that offers map + radius discovery: all four present, plain decimal
 * coordinates, a whole-mile radius. Nothing is defaulted or inferred.
 */
export function parseGuideMapFields(raw: {
  place: string;
  lat: string;
  lng: string;
  dist: string;
}): GuideLocationParse {
  if (!raw.place || !raw.lat || !raw.lng || !raw.dist)
    return fail("A map location needs a place name, latitude, longitude and radius.");
  if (!NUMBER_RE.test(raw.lat)) return fail("Latitude must be a number from -90 to 90.");
  if (!NUMBER_RE.test(raw.lng)) return fail("Longitude must be a number from -180 to 180.");
  if (!WHOLE_RE.test(raw.dist))
    return fail(
      `Radius must be a whole number of miles from ${GUIDE_RADIUS_MIN} to ${GUIDE_RADIUS_MAX}.`,
    );
  return guideMapSelection({
    place: raw.place,
    lat: Number(raw.lat),
    lng: Number(raw.lng),
    dist: Number(raw.dist),
  });
}

/**
 * Strictly parses the geography part of a Field Guide URL. Empty values count
 * as absent (a native form submits empty selects); anything else that is
 * repeated, malformed, incomplete or mixed is rejected rather than guessed at.
 * Missing ancestors are derived from the code shape, conflicting ones fail.
 */
export function parseGuideLocation(params: ParamReader): GuideLocationParse {
  const raw: Record<string, string> = {};
  for (const name of GUIDE_LOCATION_PARAMS) {
    const all = params.getAll(name);
    if (all.length > 1) return fail(`Use only one ${name} value.`);
    raw[name] = (all[0] ?? "").trim();
  }
  const hasHierarchy = GUIDE_LEVELS.some((l) => raw[l]);
  const hasMap = GUIDE_MAP_PARAMS.some((p) => raw[p]);
  if (hasHierarchy && hasMap)
    return fail(
      "Choose either a country, state, county or hotspot, or a map point with a radius, not both.",
    );
  if (hasMap)
    return parseGuideMapFields({ place: raw.place, lat: raw.lat, lng: raw.lng, dist: raw.dist });
  if (!hasHierarchy) return { ok: true, selection: { kind: "anywhere" } };

  let country = raw.country.toUpperCase();
  let region = raw.region.toUpperCase();
  let county = raw.county.toUpperCase();
  const hotspot = raw.hotspot.toUpperCase();

  if (country && parseRegionCode(country)?.level !== "country")
    return fail("Choose a recognized country.");
  if (region) {
    const parsed = parseRegionCode(region);
    if (parsed?.level !== "subnational1")
      return fail("Choose a recognized state or region.");
    if (country && country !== parsed.parent)
      return fail("That region is not in the selected country.");
    country = parsed.parent!;
  }
  if (county) {
    const parsed = parseRegionCode(county);
    if (parsed?.level !== "subnational2")
      return fail("Choose a recognized county.");
    if (region && region !== parsed.parent)
      return fail("That county is not in the selected state or region.");
    if (country && country !== parsed.country)
      return fail("That county is not in the selected country.");
    region = parsed.parent!;
    country = parsed.country;
  }
  if (hotspot) {
    if (!isHotspotLocId(hotspot)) return fail("Choose a recognized eBird hotspot.");
    if (!county) return fail("Choose the county before choosing a hotspot.");
    return {
      ok: true,
      selection: { kind: "hotspot", country, region, county, hotspot },
    };
  }
  if (county)
    return { ok: true, selection: { kind: "county", country, region, county } };
  if (region) return { ok: true, selection: { kind: "region", country, region } };
  return { ok: true, selection: { kind: "country", country } };
}

/** Canonical query pairs for a selection (six decimals for coordinates). */
export function guideLocationPairs(
  selection: GuideLocationSelection,
): [string, string][] {
  switch (selection.kind) {
    case "anywhere":
      return [];
    case "country":
      return [["country", selection.country]];
    case "region":
      return [
        ["country", selection.country],
        ["region", selection.region],
      ];
    case "county":
      return [
        ["country", selection.country],
        ["region", selection.region],
        ["county", selection.county],
      ];
    case "hotspot":
      return [
        ["country", selection.country],
        ["region", selection.region],
        ["county", selection.county],
        ["hotspot", selection.hotspot],
      ];
    case "map":
      return [
        ["place", selection.place],
        ["lat", selection.lat.toFixed(6)],
        ["lng", selection.lng.toFixed(6)],
        ["dist", String(selection.dist)],
      ];
  }
}

/** The hidden "was" pairs for the applied selection (empty strings when a
 * level is not selected), one per level, in level order. */
export function guideWasPairs(selection: GuideLocationSelection): [string, string][] {
  const applied: Record<GuideLevel, string> = { country: "", region: "", county: "", hotspot: "" };
  for (const [key, value] of guideLocationPairs(selection))
    if ((GUIDE_LEVELS as readonly string[]).includes(key)) applied[key as GuideLevel] = value;
  return GUIDE_LEVELS.map((level) => [`was_${level}`, applied[level]]);
}

export type GuideLevelChange =
  | { ok: true; params: URLSearchParams }
  | { ok: false; message: string };

/**
 * Turns a native filter-form submission into its canonical parameters.
 * Returns null when the URL carries no "was" intent at all (a copied link:
 * strict validation then applies unchanged). A real form submits every "was"
 * field exactly once and every hierarchy parameter at most once; anything else
 * that mentions a "was" field is rejected, never tidied into something valid.
 * The shallowest hierarchy level whose submitted value differs from its "was"
 * value is the level the person changed; every deeper level is cleared, `page`
 * resets, the transient "was" values disappear, and every other parameter
 * survives untouched.
 */
export function canonicalizeGuideLevelChange(params: URLSearchParams): GuideLevelChange | null {
  if (!GUIDE_WAS_PARAMS.some((name) => params.has(name))) return null;
  if (GUIDE_WAS_PARAMS.some((name) => params.getAll(name).length !== 1))
    return { ok: false, message: "The location form values are incomplete or repeated." };
  for (const level of GUIDE_LEVELS)
    if (params.getAll(level).length > 1) return { ok: false, message: `Use only one ${level} value.` };
  const read = (name: string) => (params.get(name) ?? "").trim().toUpperCase();
  const changed = GUIDE_LEVELS.findIndex((level) => read(level) !== read(`was_${level}`));
  const keepThrough = changed === -1 ? GUIDE_LEVELS.length - 1 : changed;
  const next = new URLSearchParams(params);
  for (const name of GUIDE_WAS_PARAMS) next.delete(name);
  next.delete("page");
  GUIDE_LEVELS.forEach((level, index) => {
    const value = read(level);
    next.delete(level);
    if (index <= keepThrough && value) next.append(level, value);
  });
  return { ok: true, params: next };
}

function cleared(base: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const name of GUIDE_LOCATION_PARAMS) next.delete(name);
  next.delete("page");
  return next;
}

/** Removes every geographic parameter; every other parameter survives. */
export function clearGuideLocation(base: URLSearchParams): URLSearchParams {
  return cleared(base);
}

/** Replaces the whole geography with `selection`; resets `page`. */
export function withGuideLocation(
  base: URLSearchParams,
  selection: GuideLocationSelection,
): URLSearchParams {
  const next = cleared(base);
  for (const [key, value] of guideLocationPairs(selection))
    next.append(key, value);
  return next;
}

/**
 * Changes one hierarchy level. The new value clears every deeper level and any
 * map selection, keeps the shallower ancestors, and resets `page`. An empty
 * value clears the level itself. Missing ancestors that the code shape
 * implies are filled in.
 */
export function withGuideLevel(
  base: URLSearchParams,
  level: GuideLevel,
  value: string,
): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const name of GUIDE_MAP_PARAMS) next.delete(name);
  next.delete("page");
  for (const lower of descendantsOf(level)) next.delete(lower);
  const code = value.trim().toUpperCase();
  next.delete(level);
  if (!code) return next;
  next.set(level, code);
  const parsed = level === "hotspot" ? null : parseRegionCode(code);
  if (level === "region" && parsed?.parent) next.set("country", parsed.parent);
  if (level === "county" && parsed?.parent) {
    next.set("region", parsed.parent);
    next.set("country", parsed.country);
  }
  return next;
}

/** `/species?…#results` for a parameter set. */
export function guideResultsHref(params: URLSearchParams): string {
  const text = params.toString();
  return `${text ? `/species?${text}` : "/species"}#results`;
}

/** A URL for a map/radius selection; place is capped at the URL limit. */
export function guideMapHref(
  base: URLSearchParams,
  input: { place: string; lat: number; lng: number; dist: number },
): { ok: true; href: string } | { ok: false; message: string } {
  const place = input.place.trim().slice(0, GUIDE_PLACE_MAX).trim();
  const checked = guideMapSelection({ ...input, place });
  if (!checked.ok) return checked;
  return {
    ok: true,
    href: guideResultsHref(withGuideLocation(base, checked.selection)),
  };
}

export interface GuideLocationView {
  kind: Exclude<GuideLocationSelection["kind"], "anywhere">;
  label: string;
  /** True when the label comes from the official county-equivalent table and
   * so already carries its own suffix (County, Parish, Borough…). */
  officialCountyName?: boolean;
  sourceCount: number;
  wholeArea: boolean;
  beginYear: number | null;
  endYear: number | null;
  map: {
    place: string;
    dist: number;
    coordinateMissing: number;
  } | null;
}

const KIND_NOUN: Record<GuideLocationView["kind"], string> = {
  country: "country",
  region: "state or region",
  county: "county or equivalent",
  hotspot: "verified eBird hotspot",
  map: "map point",
};

export type GuideCoverageStatus =
  | "unavailable"
  | "whole-area"
  | "component-only"
  | "hotspot"
  | "radius";

/**
 * The coverage sentence for a selection. Complete, component-only and
 * unavailable coverage read differently, and zero sources is never phrased as
 * zero birds.
 */
export function guideCoverage(view: GuideLocationView): {
  status: GuideCoverageStatus;
  text: string;
} {
  const noun =
    view.kind === "county" && view.officialCountyName
      ? "county"
      : KIND_NOUN[view.kind];
  const years =
    view.beginYear != null && view.endYear != null
      ? `${view.beginYear}–${view.endYear}`
      : "";
  const sources = `${view.sourceCount} loaded ${view.sourceCount === 1 ? "source" : "sources"}`;
  if (view.kind === "map" && view.map) {
    const missing = view.map.coordinateMissing
      ? ` ${view.map.coordinateMissing} loaded ${view.map.coordinateMissing === 1 ? "hotspot has" : "hotspots have"} no recorded coordinates and could not be evaluated.`
      : "";
    if (view.sourceCount === 0)
      return {
        status: "unavailable",
        text: `Historical coverage for the ${view.map.dist}-mile circle around ${view.map.place} is unavailable: no loaded eBird hotspot with recorded coordinates falls inside it. This does not mean there are no birds here.${missing}`,
      };
    return {
      status: "radius",
      text: `Reported at ${view.sourceCount} loaded eBird ${view.sourceCount === 1 ? "hotspot" : "hotspots"} within ${view.map.dist} ${view.map.dist === 1 ? "mile" : "miles"} of ${view.map.place} · any month · ${years}. Only hotspots with recorded coordinates are counted; region-wide data is not used, and the map view is not a boundary.${missing} This shows recorded presence, not a complete list of birds that could occur here.`,
    };
  }
  if (view.sourceCount === 0)
    return {
      status: "unavailable",
      text: `No historical data is loaded for ${view.label} (${noun}) yet. This does not mean there are no birds here.`,
    };
  if (view.kind === "hotspot")
    return {
      status: "hotspot",
      text: `Reported at ${view.label}, ${KIND_NOUN.hotspot} · any month · ${years}. Only this hotspot's own loaded data is used. This shows recorded presence, not a complete list of birds that could occur here.`,
    };
  const lead = `Reported in ${view.label} (${noun}) · any month · ${years} · ${sources}`;
  return view.wholeArea
    ? {
        status: "whole-area",
        text: `${lead}, including the whole-area source. This shows recorded presence, not a complete list of birds that could occur here.`,
      }
    : {
        status: "component-only",
        text: `${lead}; no whole-area source is loaded, so places without loaded data are not covered. This shows recorded presence, not a complete list of birds that could occur here.`,
      };
}

/** The short scope-summary chip for a selection. */
export function guideScopeText(
  view: Pick<GuideLocationView, "kind" | "label" | "map"> & {
    officialCountyName?: boolean;
  },
): string {
  switch (view.kind) {
    case "hotspot":
      return `${view.label} · verified eBird hotspot`;
    case "county":
      return view.officialCountyName
        ? view.label
        : `${view.label} · county or equivalent`;
    case "map":
      return view.map
        ? `Within ${view.map.dist} ${view.map.dist === 1 ? "mile" : "miles"} of ${view.map.place}`
        : view.label;
    default:
      return view.label;
  }
}

/** The Place levels whose choices the page loads beneath a chosen parent. */
export const GUIDE_CHOICES_LEVELS = ["region", "county", "hotspot"] as const;
export type GuideChoicesLevel = (typeof GUIDE_CHOICES_LEVELS)[number];

/** The region-code level a parent must have for each choices level. */
const CHOICES_PARENT_LEVEL = {
  region: "country",
  county: "subnational1",
  hotspot: "subnational2",
} as const;

export type GuideChoicesRequest =
  | { ok: true; level: GuideChoicesLevel; parent: string }
  | { ok: false; message: string };

/**
 * Syntax and cardinality for `/api/guide-locations` (td-daff98): exactly one
 * non-blank `level` and `parent`, no other keys, and a parent whose code shape
 * fits the level. Whether the parent EXISTS is a server question
 * (`guideChoicesFor`), not answered here.
 */
export function parseGuideChoicesRequest(params: URLSearchParams): GuideChoicesRequest {
  for (const key of new Set(params.keys()))
    if (key !== "level" && key !== "parent") return fail(`Unexpected parameter: ${key}.`);
  const levels = params.getAll("level");
  const parents = params.getAll("parent");
  if (levels.length !== 1 || parents.length !== 1)
    return fail("Give exactly one level and one parent.");
  const level = levels[0].trim();
  const parent = parents[0].trim().toUpperCase();
  if (!level || !parent) return fail("Give exactly one level and one parent.");
  if (!(GUIDE_CHOICES_LEVELS as readonly string[]).includes(level))
    return fail("Choose region, county or hotspot choices.");
  const typed = level as GuideChoicesLevel;
  if (parseRegionCode(parent)?.level !== CHOICES_PARENT_LEVEL[typed])
    return fail(
      typed === "region"
        ? "Choose a recognized country."
        : typed === "county"
          ? "Choose a recognized state or region."
          : "Choose a recognized county.",
    );
  return { ok: true, level: typed, parent };
}
