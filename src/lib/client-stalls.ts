/**
 * Stuck pages (td-1cb094, under td-c4a58d): what the browser reports about its
 * own navigations, shared by the reporter (nav-watch.ts), the endpoint and the
 * Admin panel. The server can only time its own answers; on 2026-10-25 the
 * phone hung after every answer had gone out, so the browser has to say where
 * it was stuck.
 *
 * - `slow`: shown, but only after SLOW_NAV_MS or more.
 * - `superseded`: still not shown after SLOW_NAV_MS when another navigation
 *   started (a second tap on a page that did not move).
 * - `unfinished`: not finished when its page was gone (killed, crashed or
 *   frozen for good, by nav-watch.ts's rules); reported by the next page.
 * - `reloaded`: not finished when its page unloaded (a reload, or SvelteKit's
 *   full-page fallback landing somewhere else); reported by the next page.
 * - `lost`: nothing in progress, but the page's heartbeat stopped while it
 *   was on screen and it never exited cleanly; reported by the next page.
 * - `freeze`: the page stopped answering for FREEZE_MS or more while visible,
 *   then recovered.
 */
export const STALL_KINDS = ["slow", "superseded", "unfinished", "reloaded", "lost", "freeze"] as const;
export type StallKind = (typeof STALL_KINDS)[number];
export const NAV_TYPES = ["link", "goto", "popstate", "form"] as const;
export type NavType = (typeof NAV_TYPES)[number];
export const STAGES = ["started", "data", "shown"] as const;
export type Stage = (typeof STAGES)[number];

export const SLOW_NAV_MS = 3_000;
export const FREEZE_MS = 2_000;
export const MAX_EVENTS_PER_POST = 20;
export const MAX_ERRORS = 3;
export const MAX_ERROR_CHARS = 200;
/**
 * Raw error text is cut to this before any pattern runs on it, so a huge
 * message cannot make the sanitizer slow (its credential scan is quadratic
 * on long runs of word characters: about 1 ms at this length).
 */
export const MAX_RAW_ERROR_CHARS = 1_000;
/** A day's reports from one account past this are dropped (a loop cannot flood the table). */
export const MAX_EVENTS_PER_USER_DAY = 300;

export interface StallEvent {
  /** The browser's id for this report (a UUID), so a resend is stored once. */
  id: string;
  kind: StallKind;
  /** When it happened, by the browser's clock (epoch ms). */
  occurredAt: number;
  fromRoute: string | null;
  toRoute: string | null;
  /** Pathname only, never the query string. */
  toPath: string | null;
  navType: NavType | null;
  /** How far the navigation got: started → data (its data was ready) → shown. Null for a freeze outside one. */
  stage: Stage | null;
  /** slow/superseded/unfinished: tap to shown, to the next tap, or to the last sign of life; freeze: how long. */
  waitedMs: number;
  /** Time on screen from the start to ready to draw, when it got that far (the same clock as slow/superseded waitedMs). */
  dataMs: number | null;
  /** unfinished/lost: tap (or last report) to the page's last heartbeat; tells a frozen page from a waiting one. */
  aliveMs: number | null;
  /** Tap to the page going into the background, if it did while waiting. */
  hiddenMs: number | null;
  errors: string[];
  /** Running as the installed app (home-screen), not a browser tab. */
  standalone: boolean;
  online: boolean;
  /** The client build's deploy version. */
  version: string;
}

/** The report endpoint: viewers may write it too (hooks.server.ts). */
export function isClientStallsRequest(path: string, method: string): boolean {
  return method === "POST" && path === "/api/client-stalls";
}

const ROUTE_ID = /^\/[A-Za-z0-9_[\]()/.=-]*$/;
const PATH = /^\/[A-Za-z0-9_%./~-]*$/;
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MS = 7 * 24 * 60 * 60 * 1000;

const isMs = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_MS;
const msOrNull = (v: unknown): number | null | undefined => (v === null ? null : isMs(v) ? v : undefined);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** Route ids and pathnames as the browser has them, or null when they do not fit the stored shape. */
export function routeOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length <= 200 && ROUTE_ID.test(v) ? v : null;
}
export function pathOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length <= 200 && PATH.test(v) ? v : null;
}

/**
 * Error text as stored: control characters out, web addresses cut to their
 * path, query strings and credential-like values blanked, trimmed and cut to
 * MAX_ERROR_CHARS. Never throws (an object without a usable toString is "").
 */
export function cleanError(v: unknown): string {
  let text: string;
  try {
    text = String(v);
  } catch {
    return "";
  }
  return text
    .slice(0, MAX_RAW_ERROR_CHARS)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#]*([^\s?#]*)[^\s]*/gi, "$1")
    .replace(/\?[^\s]*/g, "?…")
    // label=value, label: value, "label": "value" — any label containing a credential word
    // (api_key, access_token, Authorization…), quoted or not; the value goes, the label stays.
    .replace(
      // A label is tried only where a word starts (the leading group), not at every character.
      /(^|[^A-Za-z0-9_.-])(["']?)([A-Za-z0-9_.-]*(?:token|key|passw(?:or)?d|pwd|secret|auth|session|cookie|credential|signature)[A-Za-z0-9_.-]*)\2(\s*[=:]\s*)(?:(?:bearer|basic)\s+)?("(?:[^"\\]|\\.)*(?:"|\\?$)|'(?:[^'\\]|\\.)*(?:'|\\?$)|[^\s,;&}\]]+)/gi,
      "$1$2$3$2$4…",
    )
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 …")
    .trim()
    .slice(0, MAX_ERROR_CHARS);
}

/**
 * One event from a POST body, checked field by field; null when anything is
 * missing or the wrong shape (the endpoint skips it). `now` bounds the
 * browser's clock: older than the 30-day retention or more than 5 minutes
 * ahead is taken as now.
 */
export function parseStallEvent(raw: unknown, now: number): StallEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string" || !UUID.test(e.id)) return null;
  if (!oneOf(STALL_KINDS, e.kind)) return null;
  if (typeof e.occurredAt !== "number" || !Number.isFinite(e.occurredAt)) return null;
  const occurredAt = e.occurredAt < now - 30 * 86_400_000 || e.occurredAt > now + 300_000 ? now : Math.round(e.occurredAt);
  const navType = e.navType === null ? null : oneOf(NAV_TYPES, e.navType) ? e.navType : undefined;
  const stage = e.stage === null ? null : oneOf(STAGES, e.stage) ? e.stage : undefined;
  const dataMs = msOrNull(e.dataMs);
  const aliveMs = msOrNull(e.aliveMs);
  const hiddenMs = msOrNull(e.hiddenMs);
  if (navType === undefined || stage === undefined || dataMs === undefined || aliveMs === undefined || hiddenMs === undefined) return null;
  if (!isMs(e.waitedMs)) return null;
  if (typeof e.standalone !== "boolean" || typeof e.online !== "boolean") return null;
  if (typeof e.version !== "string" || !VERSION.test(e.version)) return null;
  // The browser sends errors already cleaned and cut to MAX_ERROR_CHARS; anything longer is not from it.
  if (!Array.isArray(e.errors) || e.errors.length > MAX_ERRORS || !e.errors.every((x) => typeof x === "string" && x.length <= MAX_ERROR_CHARS)) {
    return null;
  }
  for (const k of ["fromRoute", "toRoute", "toPath"] as const) if (e[k] !== null && typeof e[k] !== "string") return null;
  return {
    id: e.id.toLowerCase(),
    kind: e.kind,
    occurredAt,
    fromRoute: routeOrNull(e.fromRoute),
    toRoute: routeOrNull(e.toRoute),
    toPath: pathOrNull(e.toPath),
    navType,
    stage,
    waitedMs: e.waitedMs,
    dataMs,
    aliveMs,
    hiddenMs,
    errors: e.errors.map(cleanError).filter((s) => s.length > 0),
    standalone: e.standalone,
    online: e.online,
    version: e.version,
  };
}

/** "iPhone · Safari 27.0.1 · installed app" from a stored User-Agent. */
export function deviceLabel(ua: string, standalone: boolean): string {
  const platform = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "Unknown device";
  const m =
    /CriOS\/(\d+)/.exec(ua) ?? /FxiOS\/(\d+)/.exec(ua) ?? /Edg\/(\d+)/.exec(ua) ?? /Firefox\/(\d+)/.exec(ua) ?? /Chrome\/(\d+)/.exec(ua);
  const name = m
    ? /CriOS|Chrome/.test(m[0])
      ? "Chrome"
      : /FxiOS|Firefox/.test(m[0])
        ? "Firefox"
        : "Edge"
    : null;
  const safari = !m && /Safari\//.test(ua) ? /Version\/([\d.]+)/.exec(ua) : null;
  const browser = name ? `${name} ${m![1]}` : safari ? `Safari ${safari[1]}` : /Safari\//.test(ua) ? "Safari" : null;
  return [platform, browser, standalone ? "installed app" : null].filter(Boolean).join(" · ");
}

/** "450 ms", "4.1 s". */
export function fmtStallMs(ms: number): string {
  return ms < 1000 ? `${ms.toLocaleString("en-US")} ms` : `${(ms / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })} s`;
}

export const STALL_KIND_LABEL: Record<StallKind, string> = {
  slow: "Slow to finish",
  superseded: "Replaced before finishing",
  unfinished: "Never finished",
  reloaded: "Reloaded before finishing",
  lost: "Stopped on screen",
  freeze: "Froze",
};

/** What the Admin panel needs of a stored report. */
export interface StallText {
  kind: StallKind;
  stage: string | null;
  waitedMs: number;
  dataMs: number | null;
  aliveMs: number | null;
  hiddenMs: number | null;
}

/**
 * How far the navigation got, by SvelteKit's milestones: "ready to draw" is
 * onNavigate (its data and code had loaded), "finished" is afterNavigate.
 * dataMs is time on screen.
 */
function reached(r: StallText): string {
  return r.dataMs != null
    ? `it was ready to draw after ${fmtStallMs(r.dataMs)} on screen, but never finished`
    : "it never got as far as ready to draw (its data or code had not loaded)";
}

/**
 * One plain sentence per report for Admin → Metrics: what was recorded, never
 * a guessed cause. Times "on screen" leave out any time in the background; a
 * slow report's total and its ready-to-draw time are both on screen, so their
 * difference is meaningful.
 */
export function describeStall(r: StallText): string {
  switch (r.kind) {
    case "slow":
      return r.dataMs != null
        ? `Finished after ${fmtStallMs(r.waitedMs)} on screen: ready to draw after ${fmtStallMs(r.dataMs)}, then ${fmtStallMs(Math.max(0, r.waitedMs - r.dataMs))} more to finish.`
        : `Finished after ${fmtStallMs(r.waitedMs)} on screen.`;
    case "superseded":
      return `Another page was opened after ${fmtStallMs(r.waitedMs)} on screen; ${reached(r)}.`;
    case "unfinished": {
      const parts = [`The app closed with this page still loading; ${reached(r)}.`];
      // A page that went to the background (app switcher) was running until then. One that never
      // did saved its last heartbeat while on screen, then stopped: the cause is unknown.
      if (r.hiddenMs != null) parts.push(`It was still running when the app went to the background ${fmtStallMs(r.hiddenMs)} after it started.`);
      else if (r.aliveMs != null) parts.push(`Its last saved heartbeat was ${fmtStallMs(r.aliveMs)} after it started, while still on screen; nothing after that.`);
      return parts.join(" ");
    }
    case "reloaded":
      return `The page reloaded ${fmtStallMs(r.waitedMs)} after this one started; ${reached(r)}.`;
    case "lost":
      return "Nothing was loading, but the page’s heartbeat stopped while it was on screen and it never closed normally. The time is its last saved heartbeat; the cause is unknown.";
    case "freeze":
      return r.stage
        ? `No heartbeat for about ${fmtStallMs(r.waitedMs)} while on screen and opening this page, then it resumed.`
        : `No heartbeat for about ${fmtStallMs(r.waitedMs)} while on screen, then it resumed.`;
    default:
      return "";
  }
}
