/**
 * eBird region-code shape utility (td-f1d6da "Support international region
 * loads"). Codes are dash-delimited — 1 segment = country ("US", "IS"), 2 =
 * subnational1 ("US-FL", "NO-03", "GB-ENG"), 3 = subnational2 ("US-FL-057",
 * "GB-ENG-102"). Segment widths vary by country; never assume 2-letter
 * states or 3-digit counties. Client-safe pure module, pattern: loc-id.ts.
 */

export type RegionLevel = "country" | "subnational1" | "subnational2";

export interface ParsedRegion {
  /** Normalized (trimmed, uppercased) code — never the raw input. */
  code: string;
  /** The 2-letter country segment, e.g. "US" for "US-FL-057". */
  country: string;
  level: RegionLevel;
  /** The immediate parent code, or null for a country-level code. */
  parent: string | null;
}

// 2-letter country, then up to two non-empty alphanumeric segments.
const REGION_RE = /^[A-Z]{2}(-[A-Z0-9]+){0,2}$/;

/** Parses + validates an eBird region code. Normalizes via trim().toUpperCase()
 * before validation, so callers can pass raw query params or form values
 * directly — a non-region shape (hotspot ids like "L602509", empty strings,
 * lowercase junk) returns null rather than throwing. */
export function parseRegionCode(raw: string | null | undefined): ParsedRegion | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  if (!REGION_RE.test(code)) return null;
  const segments = code.split("-");
  const level: RegionLevel =
    segments.length === 1
      ? "country"
      : segments.length === 2
        ? "subnational1"
        : "subnational2";
  const parent = segments.length === 1 ? null : segments.slice(0, -1).join("-");
  return { code, country: segments[0], level, parent };
}

export function regionLevel(code: string): RegionLevel | null {
  return parseRegionCode(code)?.level ?? null;
}

/** "US-FL-057" -> "US-FL"; "US-FL" -> "US"; "US" -> null. */
export function parentOf(code: string): string | null {
  return parseRegionCode(code)?.parent ?? null;
}

/** "GB-ENG-102" -> "GB"; "US-FL" -> "US"; "US" -> "US". */
export function countryOf(code: string): string | null {
  return parseRegionCode(code)?.country ?? null;
}

export function isCountry(code: string): boolean {
  return parseRegionCode(code)?.level === "country";
}

export function isSubnational1(code: string): boolean {
  return parseRegionCode(code)?.level === "subnational1";
}

export function isSubnational2(code: string): boolean {
  return parseRegionCode(code)?.level === "subnational2";
}

/** The level one step down (country -> subnational1 -> subnational2 -> null). */
export function childLevel(level: RegionLevel): RegionLevel | null {
  if (level === "country") return "subnational1";
  if (level === "subnational1") return "subnational2";
  return null;
}
