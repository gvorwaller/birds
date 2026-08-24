/**
 * Client-safe tide types + pure formatting helpers (td-6a3d2e). Types live
 * here rather than `$server/tides.ts` so Svelte components can import them
 * without tripping SvelteKit's illegal-server-import check (same split as
 * `species-tags.ts`).
 *
 * Times are always formatted in the STATION's wall-clock zone, never the
 * viewer's browser zone — see the timezone design note in
 * `$server/tides.ts`. These helpers run on the server at serialization time;
 * the resulting `timeLabel`/`phrase` strings are what components render, so
 * SSR and hydration stay byte-identical (no `Intl` in the component).
 */

export type TideKind = "H" | "L";

export interface TideExtremeCore {
  type: TideKind;
  /** ISO UTC timestamp. */
  at: string;
  feetMllw: number;
  /** Station-local calendar-day offset from "now"/the target date: 0 = today, 1 = tomorrow, etc. */
  dayOffset: number;
}

export interface TideExtreme extends TideExtremeCore {
  /** Server-produced, e.g. "2:41 PM EDT". */
  timeLabel: string;
  /** Server-produced, e.g. "Low tomorrow 6:12 AM EDT (−0.1 ft)". */
  phrase: string;
}

export interface TideStationRef {
  id: string;
  name: string;
  distanceKm: number;
  tz: string;
}

export interface TideResult {
  station: TideStationRef;
  /** 'next' = the upcoming high/low after now; 'day' = every extreme on `date`. */
  mode: "next" | "day";
  /** Station-local YYYY-MM-DD the payload describes. */
  date: string;
  nextHigh: TideExtreme | null;
  nextLow: TideExtreme | null;
  /** Chronological; only populated in 'day' mode. */
  day: TideExtreme[];
  stale: boolean;
}

export const TIDE_ATTRIBUTION_URL = "https://tidesandcurrents.noaa.gov/";

/** "2:41 PM EDT" in the station's zone. The short zone name is the honesty
 * mechanism (ICU handles DST) and must always render. */
export function formatTideTime(isoUtc: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
    timeZoneName: "short",
  }).format(new Date(isoUtc));
}

/** "" for today, "tomorrow " for tomorrow, "Wed " otherwise (trailing space baked in). */
export function dayPrefix(e: TideExtremeCore, tz: string): string {
  if (e.dayOffset === 0) return "";
  if (e.dayOffset === 1) return "tomorrow ";
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: tz,
  }).format(new Date(e.at));
  return `${weekday} `;
}

export function tideWord(t: TideKind): string {
  return t === "H" ? "High" : "Low";
}

/** "2.1 ft" / "−0.1 ft" (U+2212 minus, never a plain hyphen). */
export function formatFeet(feetMllw: number): string {
  const rounded = Math.round(feetMllw * 10) / 10;
  const sign = rounded < 0 ? "−" : "";
  return `${sign}${Math.abs(rounded).toFixed(1)} ft`;
}

/** "Low tomorrow 6:12 AM EDT (−0.1 ft)" — non-breaking space before the
 * height so "(−0.1 ft)" never wraps onto its own line at narrow widths. */
export function tidePhrase(e: TideExtremeCore, tz: string): string {
  return `${tideWord(e.type)} ${dayPrefix(e, tz)}${formatTideTime(e.at, tz)}\u00A0(${formatFeet(e.feetMllw)})`;
}

/** "Tue, Sep 15" from a station-local YYYY-MM-DD (calendar math only — no
 * timezone involved, so the named weekday always matches the given date). */
export function formatTideDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const utc = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(utc);
}
