/**
 * Plain-language status for the Hotspots & data species totals (td-de2150).
 * The totals come from a snapshot the background worker publishes; this says
 * how recent it is. Times are in the app's calendar zone and relative wording
 * is measured from the server's read time, so server and browser render the
 * same text.
 */
import { FORECAST_CALENDAR_TZ as APP_TZ } from "./forecast-calendar";

export interface SpeciesCountStatusInput {
  /** Any published counts at all (null = no build has succeeded yet). */
  hasCounts: boolean;
  builtAt: string | null;
  failing: boolean;
  sourceChanged: boolean;
  refreshActive: boolean;
  readAt: string;
}

export type SpeciesCountState =
  | "preparing"
  | "unavailable"
  | "failed"
  | "updating"
  | "pending"
  | "current";

export interface SpeciesCountStatus {
  state: SpeciesCountState;
  /** Leading words, shown in bold. */
  lead: string;
  /** The rest of the sentence. */
  detail: string;
  /** What a geography row says when it has no number. */
  rowText: string;
}

const dayIn = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: APP_TZ }); // YYYY-MM-DD

/** "today 3:42 PM ET" / "yesterday 9:05 AM ET" / "Oct 8, 9:05 AM ET" (year when not this year). */
export function fmtCountsTime(iso: string, now: Date): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", {
    timeZone: APP_TZ,
    hour: "numeric",
    minute: "2-digit",
  });
  const today = dayIn(now);
  // Yesterday is the previous CALENDAR date in the zone (never now-24h, which
  // misses across a DST change). Noon UTC formats to the same US date.
  const [y, m, dd] = today.split("-").map(Number);
  const yesterday = dayIn(new Date(Date.UTC(y, m - 1, dd - 1, 12)));
  const day = dayIn(d);
  if (day === today) return `today ${time} ET`;
  if (day === yesterday) return `yesterday ${time} ET`;
  const date = d.toLocaleDateString("en-US", {
    timeZone: APP_TZ,
    month: "short",
    day: "numeric",
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  });
  return `${date}, ${time} ET`;
}

/** "just now" / "12 min ago" / "3 h ago" / "2 days ago". */
export function fmtAgo(iso: string, now: Date): string {
  const minutes = Math.floor(
    (now.getTime() - new Date(iso).getTime()) / 60_000,
  );
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function speciesCountStatus(
  v: SpeciesCountStatusInput,
): SpeciesCountStatus {
  if (!v.hasCounts || !v.builtAt) {
    return v.failing
      ? {
          state: "unavailable",
          lead: "Species counts unavailable",
          detail: "— the first count failed and will be retried automatically.",
          rowText: "Counts unavailable",
        }
      : {
          state: "preparing",
          lead: "Counts being prepared",
          detail:
            "— species totals are counted in the background. Use Reload in a minute or two to see them.",
          rowText: "Counts being prepared",
        };
  }
  const now = new Date(v.readAt);
  const when = `${fmtAgo(v.builtAt, now)} (${fmtCountsTime(v.builtAt, now)})`;
  // A geography loaded after the build has no number yet: never "0 species".
  const rowText = "Not yet counted";
  if (v.failing) {
    return {
      state: "failed",
      lead: "Last refresh failed",
      detail: `— showing counts from ${when}. It will be retried automatically.`,
      rowText,
    };
  }
  if (v.sourceChanged && v.refreshActive) {
    return {
      state: "updating",
      lead: "Updating…",
      detail: `Showing counts from ${when}; newly loaded data is counted shortly.`,
      rowText,
    };
  }
  if (v.sourceChanged) {
    return {
      state: "pending",
      lead: `Counts from ${when}`,
      detail: "— newer loaded data isn't counted yet.",
      rowText,
    };
  }
  return { state: "current", lead: `Updated ${when}`, detail: "", rowText };
}
