/**
 * Tide predictions via NOAA CO-OPS — free, keyless (td-6a3d2e). Two APIs:
 *   - Metadata (MDAPI): station list, `?type=tidepredictions`.
 *   - Data API (datagetter): `product=predictions&interval=hilo` high/low
 *     extremes for a station, fetched in GMT.
 * Same shape as `weather.ts`: TTL-cached in the shared `ebird_cache` table,
 * `AbortSignal`-bounded fetches, a private `*Unavailable` sentinel → null,
 * stale-cache fallback, never blocks or crashes a page.
 *
 * VERIFIED 2026-08-24 (see docs/2026-08-24-tide-predictions-plan-CC.md):
 *   - `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions`
 *     → 3,499 stations (~2 MB). `timezonecorr` is documented by MDAPI only as
 *     a numeric correction, never as a complete IANA/DST timezone.
 *   - `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?...&interval=hilo`
 *     → `{ predictions: [{ t, v, type: "H"|"L" }] }`. Subordinate (`type:"S"`)
 *     stations work identically with `interval=hilo`.
 *   - GOTCHA: CO-OPS returns HTTP 200 with a `{"error":{"message":...}}` body
 *     for bad datum/out-of-range dates (a bad station id gives HTTP 400 +
 *     the same error-object shape). The JSON body must be parsed and checked
 *     for an `error` key BEFORE any `res.ok` check — see `fetchPredictions`.
 *   - GOTCHA: Tampa Bay went diurnal on 2026-08-24 (measured 16h gap between
 *     extremes) — a naive 24h prediction window can miss the next high/low,
 *     so every fetch spans `begin_date = targetDate − 1 day` with `range=72`.
 *
 * TIMEZONE DESIGN (do not re-litigate — see the plan doc):
 * Tide times must show the STATION's wall clock, never the viewer's browser
 * clock. Predictions are fetched in `time_zone=gmt`; all "next extreme"
 * selection is pure UTC epoch math. Each station's IANA zone is derived ONCE
 * at ingest from `(timezonecorr, state)` via `stationTimeZone` below — but
 * ONLY for an explicit US state/territory code in the allowlists documented
 * there. This is a deliberately narrow, display-only app inference (verified
 * against the live 2026-08-24 station distribution), not a provider
 * guarantee: `state:''` or any code outside the allowlists is dropped at
 * ingest rather than guessed from the offset alone (`-5`/`-6`/`-8` all occur
 * outside the US too, and mapping them would silently show the wrong wall
 * clock, including the wrong DST rule).
 *
 * ESCAPE HATCH: if the ~2 MB station-list cold-start fetch ever becomes a
 * problem, swap `loadStations()`'s live-fetch branch for a committed
 * `src/lib/server/data/tide-stations.json` (pre-trimmed, same shape) — one
 * function to change. Precedent: `county-meta.ts` + `data/county-meta.json`.
 */
import { query } from "$lib/db";
import { haversineKm } from "$lib/geo";
import {
  formatTideTime,
  tidePhrase,
  type TideExtreme,
  type TideExtremeCore,
  type TideKind,
  type TideResult,
  type TideStationRef,
} from "$lib/tide-format";

const UA = "birds.gaylon.photos trip planner (gaylon@vorwaller.net)";
const STATIONS_URL =
  "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions";
const PREDICTIONS_URL =
  "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const STATIONS_TTL_MIN = 43_200; // 30 days (matches ebird.ts REGION_TTL_MIN)
const PRED_TTL_MIN = 43_200; // harmonic predictions are deterministic; the cache key is date-scoped
const STATIONS_TIMEOUT_MS = 20_000; // ~2 MB payload
const PRED_TIMEOUT_MS = 10_000; // same as weather.ts
const STATIONS_MEMO_MS = 60 * 60_000; // 1h in-process memo — single process per ecosystem.config.cjs fork mode
const MIN_STATIONS = 1000; // sanity gate vs poisoning a 30-day cache with a truncated/malformed payload
export const TIDE_MAX_STATION_KM = 25;

const STATIONS_CACHE_KEY = "tideStations:v1";
const STATION_ID_RE = /^[A-Za-z0-9]+$/;
const COOPS_TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Internal marker: a CO-OPS response carried an `error` body (bad datum,
 * bad station id, out-of-range date). Never cached, never shown as stale. */
class TideUnavailable extends Error {}

export interface TideStation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  state: string | null;
  tz: string;
}

export interface TideFetchOpts {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  now?: Date;
}

/** One high/low extreme as parsed from the provider, before day/label decoration. */
export interface RawTideExtreme {
  type: TideKind;
  /** ISO UTC timestamp. */
  at: string;
  feetMllw: number;
}

interface TidePredictionsPayload {
  extremes: RawTideExtreme[];
}

// ---------------------------------------------------------------------------
// Pure helpers (the testable core) — no fetch, no DB.
// ---------------------------------------------------------------------------

/** "2026-08-24 14:01" (GMT, per `time_zone=gmt`) → ISO UTC. Throws on any
 * malformed or out-of-range (e.g. month 13) timestamp. */
export function parseCoopsTime(t: string): string {
  const m = COOPS_TIME_RE.exec(t);
  if (!m) throw new Error(`malformed CO-OPS timestamp: ${t}`);
  const [, y, mo, d, h, mi] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:00Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`malformed CO-OPS timestamp: ${t}`);
  // Reject calendar overflow (Date.parse silently rolls "02-30" into March).
  const parsed = new Date(ms);
  if (
    parsed.getUTCFullYear() !== Number(y) ||
    parsed.getUTCMonth() !== Number(mo) - 1 ||
    parsed.getUTCDate() !== Number(d) ||
    parsed.getUTCHours() !== Number(h) ||
    parsed.getUTCMinutes() !== Number(mi)
  ) {
    throw new Error(`malformed CO-OPS timestamp: ${t}`);
  }
  return iso;
}

const TZ_NY_STATES = new Set([
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "IN",
  "KY",
  "ME",
  "MD",
  "MA",
  "MI",
  "NH",
  "NJ",
  "NY",
  "NC",
  "OH",
  "PA",
  "RI",
  "SC",
  "TN",
  "VA",
  "VT",
  "WV",
]);
const TZ_CHI_STATES = new Set([
  "AL",
  "AR",
  "FL",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "MI",
  "MN",
  "MS",
  "MO",
  "NE",
  "ND",
  "OK",
  "SD",
  "TN",
  "TX",
  "WI",
]);
const TZ_LA_STATES = new Set(["CA", "ID", "NV", "OR", "WA"]);

/**
 * `(timezonecorr, state)` → IANA zone, per the allowlists in the module doc.
 * Trim/uppercase happens here; an unresolvable pair (including `state: ''`
 * or any non-US/foreign code) returns null — the station is dropped at
 * ingest rather than guessing a US DST rule from the offset alone.
 */
export function stationTimeZone(
  timezonecorr: number,
  state: string | null | undefined,
): string | null {
  const s = (state ?? "").trim().toUpperCase();
  if (!s) return null;
  if (timezonecorr === -5 && TZ_NY_STATES.has(s)) return "America/New_York";
  if (timezonecorr === -6 && TZ_CHI_STATES.has(s)) return "America/Chicago";
  if (timezonecorr === -8 && TZ_LA_STATES.has(s)) return "America/Los_Angeles";
  if (timezonecorr === -9 && s === "AK") return "America/Anchorage";
  if (timezonecorr === -10 && s === "AK") return "America/Adak";
  if (timezonecorr === -10 && s === "HI") return "Pacific/Honolulu";
  if (timezonecorr === -4 && (s === "PR" || s === "VI"))
    return "America/Puerto_Rico";
  return null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Trim + validate the raw MDAPI station list. Normalizes `state: ''` → null,
 * drops any station whose `(timezonecorr, state)` doesn't resolve to a zone,
 * and throws if the survivors fall under `minStations` — the poison-cache
 * guard. Production always uses the default; tests pass an explicit small
 * threshold so the ~10-station fixture can exercise a successful parse.
 */
export function parseStationList(
  json: unknown,
  minStations = MIN_STATIONS,
): TideStation[] {
  const raw = (json as any)?.stations;
  if (!Array.isArray(raw))
    throw new Error("malformed station list: no stations array");
  const out: TideStation[] = [];
  for (const s of raw) {
    if (typeof s?.id !== "string" || typeof s?.name !== "string") continue;
    const lat = Number(s.lat);
    const lng = Number(s.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const stateRaw =
      typeof s.state === "string" ? s.state.trim().toUpperCase() : "";
    const state = stateRaw || null;
    const timezonecorr = Number(s.timezonecorr);
    if (!Number.isFinite(timezonecorr)) continue;
    const tz = stationTimeZone(timezonecorr, state);
    if (!tz) continue; // unresolvable tz (incl. blank/foreign state) — drop
    out.push({
      id: s.id,
      name: s.name,
      lat: Number(lat.toFixed(4)),
      lng: Number(lng.toFixed(4)),
      state,
      tz,
    });
  }
  if (out.length < minStations) {
    throw new Error(
      `station list implausibly small (${out.length} < ${minStations}) — refusing to cache`,
    );
  }
  return out;
}

/**
 * Parse a `datagetter` response. Throws `TideUnavailable` on the documented
 * `{error:{...}}` body (covers both the HTTP 200 and HTTP 400 forms) or when
 * no valid extremes remain after filtering. Non-H/L rows, non-finite `v`,
 * and individually malformed timestamps are dropped WITHOUT discarding the
 * rest of the batch.
 */
export function parsePredictions(json: unknown): TidePredictionsPayload {
  const body = (json && typeof json === "object" ? json : {}) as {
    error?: unknown;
    predictions?: unknown;
  };
  if (body.error) throw new TideUnavailable();
  const rawPredictions = Array.isArray(body.predictions)
    ? body.predictions
    : [];
  const extremes: RawTideExtreme[] = [];
  for (const p of rawPredictions as any[]) {
    if (p?.type !== "H" && p?.type !== "L") continue;
    const v = Number(p?.v);
    if (!Number.isFinite(v)) continue;
    let at: string;
    try {
      at = parseCoopsTime(String(p?.t ?? ""));
    } catch {
      continue; // individually malformed timestamp — skip, don't fail the batch
    }
    extremes.push({ type: p.type, at, feetMllw: v });
  }
  if (extremes.length === 0) throw new TideUnavailable();
  return { extremes };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Nearest station within `maxKm` (haversine). Ties resolve to the first
 * match in input order — deterministic without a secondary sort key. */
export function nearestStation(
  stations: readonly TideStation[],
  lat: number,
  lon: number,
  maxKm: number = TIDE_MAX_STATION_KM,
): { station: TideStation; distanceKm: number } | null {
  let best: { station: TideStation; distanceKm: number } | null = null;
  for (const s of stations) {
    const d = haversineKm(lat, lon, s.lat, s.lng);
    if (d <= maxKm && (!best || d < best.distanceKm)) {
      best = { station: s, distanceKm: d };
    }
  }
  return best;
}

/** The next H and next L at/after `nowMs`, scanned independently (chronological input assumed). */
export function pickNext(
  extremes: readonly RawTideExtreme[],
  nowMs: number,
): { nextHigh: RawTideExtreme | null; nextLow: RawTideExtreme | null } {
  const sorted = [...extremes].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  );
  let nextHigh: RawTideExtreme | null = null;
  let nextLow: RawTideExtreme | null = null;
  for (const e of sorted) {
    if (Date.parse(e.at) < nowMs) continue;
    if (e.type === "H" && !nextHigh) nextHigh = e;
    if (e.type === "L" && !nextLow) nextLow = e;
    if (nextHigh && nextLow) break;
  }
  return { nextHigh, nextLow };
}

/** `YYYY-MM-DD` (station-local, via `formatToParts` — never `toLocaleDateString`,
 * whose locale output shape is not an API contract; see `next-scan.ts`). */
export function localDate(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Extremes whose STATION-LOCAL calendar date equals `date`, chronological. */
export function extremesOnLocalDate(
  extremes: readonly RawTideExtreme[],
  date: string,
  tz: string,
): RawTideExtreme[] {
  return extremes
    .filter((e) => localDate(new Date(e.at), tz) === date)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Station-local calendar-day diff between `isoUtc` and `now`, both in `tz`.
 * Anchored at UTC noon so the subtraction never trips a DST edge. */
export function localDayOffset(isoUtc: string, tz: string, now: Date): number {
  const [y1, m1, d1] = localDate(new Date(isoUtc), tz).split("-").map(Number);
  const [y2, m2, d2] = localDate(now, tz).split("-").map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1, 12);
  const t2 = Date.UTC(y2, m2 - 1, d2, 12);
  return Math.round((t1 - t2) / 86_400_000);
}

/**
 * Which station-local date + mode to fetch for a trip stop (`today` =
 * station-local; `end = end_date ?? start_date`):
 *   start == null          → today, 'next'
 *   today < start          → start, 'day'
 *   start <= today <= end  → today, 'next'
 *   today > end            → null (finished trip — zero fetches, archive)
 */
export function targetTripDate(
  todayLocal: string,
  start: string | null,
  end: string | null,
): { date: string; mode: "next" | "day" } | null {
  if (start == null) return { date: todayLocal, mode: "next" };
  const effectiveEnd = end ?? start;
  if (todayLocal < start) return { date: start, mode: "day" };
  if (todayLocal <= effectiveEnd) return { date: todayLocal, mode: "next" };
  return null;
}

let stationMemo: { stations: TideStation[]; loadedAt: number } | null = null;

/** Test-only: clear the in-process station-list memo between cases. */
export function _resetStationMemo(): void {
  stationMemo = null;
}

// ---------------------------------------------------------------------------
// Fetch + cache layer.
// ---------------------------------------------------------------------------

function composeSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

function validCoord(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

function validDateStr(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/** `YYYY-MM-DD` one calendar day earlier (pure date arithmetic, UTC-noon anchored). */
function dayBefore(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1, 12));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function validateCachedStations(payload: unknown): TideStation[] | null {
  const arr = (payload as any)?.stations;
  if (!Array.isArray(arr) || arr.length < MIN_STATIONS) return null;
  for (const s of arr) {
    if (
      typeof s?.id !== "string" ||
      typeof s?.name !== "string" ||
      typeof s?.lat !== "number" ||
      typeof s?.lng !== "number" ||
      typeof s?.tz !== "string" ||
      (s.state !== null && typeof s.state !== "string")
    ) {
      return null;
    }
  }
  return arr as TideStation[];
}

function validateCachedPredictions(
  payload: unknown,
): TidePredictionsPayload | null {
  const arr = (payload as any)?.extremes;
  if (!Array.isArray(arr)) return null;
  for (const e of arr) {
    if (
      (e?.type !== "H" && e?.type !== "L") ||
      typeof e?.at !== "string" ||
      typeof e?.feetMllw !== "number" ||
      !Number.isFinite(e.feetMllw)
    ) {
      return null;
    }
  }
  return { extremes: arr as RawTideExtreme[] };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function fetchStationList(opts: TideFetchOpts): Promise<TideStation[]> {
  const doFetch = opts.fetcher ?? fetch;
  const signal = composeSignal(opts.signal, STATIONS_TIMEOUT_MS);
  const res = await doFetch(STATIONS_URL, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`NOAA MDAPI ${res.status}`);
  const json = await res.json();
  return parseStationList(json);
}

/**
 * Module memo (1h) → `ebird_cache` fresh row → live fetch → upsert +
 * memoize; on error, fall back to a (shape-validated) stale row, else
 * rethrow. Callers convert a throw to null — this never surfaces to a page.
 */
async function loadStations(opts: TideFetchOpts): Promise<TideStation[]> {
  const now = opts.now ?? new Date();
  if (stationMemo && now.getTime() - stationMemo.loadedAt < STATIONS_MEMO_MS) {
    return stationMemo.stations;
  }
  const cached = await query<{ payload: unknown; fetched_at: string }>(
    "SELECT payload, fetched_at FROM ebird_cache WHERE cache_key = $1",
    [STATIONS_CACHE_KEY],
  );
  const row = cached.rows[0];
  const fresh =
    row &&
    now.getTime() - new Date(row.fetched_at).getTime() <
      STATIONS_TTL_MIN * 60_000;
  if (row && fresh) {
    const stations = validateCachedStations(row.payload);
    if (stations) {
      stationMemo = { stations, loadedAt: now.getTime() };
      return stations;
    }
    // malformed fresh row — treat as a cache miss, fall through to live fetch
  }
  try {
    const stations = await fetchStationList(opts);
    await query(
      `INSERT INTO ebird_cache (cache_key, payload, fetched_at)
			 VALUES ($1, $2, NOW())
			 ON CONFLICT (cache_key) DO UPDATE SET payload = $2, fetched_at = NOW()`,
      [STATIONS_CACHE_KEY, JSON.stringify({ stations })],
    );
    stationMemo = { stations, loadedAt: now.getTime() };
    return stations;
  } catch (err) {
    if (row) {
      const stations = validateCachedStations(row.payload);
      if (stations) {
        stationMemo = { stations, loadedAt: now.getTime() };
        return stations;
      }
    }
    throw err;
  }
}

/**
 * `station`+`begin_date` (already `targetDate − 1 day`) → hilo extremes.
 * Response order is load-bearing: text → JSON.parse (non-JSON → generic
 * error) → `parsePredictions` (throws `TideUnavailable` on an `error` key —
 * covers both the HTTP 200 and HTTP 400 error-body forms) → only THEN a
 * `!res.ok` throw, so a legitimate error body is never masked by the status
 * check running first.
 */
async function fetchPredictions(
  stationId: string,
  beginYYYYMMDD: string,
  opts: TideFetchOpts,
): Promise<TidePredictionsPayload> {
  if (!STATION_ID_RE.test(stationId))
    throw new Error(`invalid station id: ${stationId}`);
  const doFetch = opts.fetcher ?? fetch;
  const signal = composeSignal(opts.signal, PRED_TIMEOUT_MS);
  const url = new URL(PREDICTIONS_URL);
  url.searchParams.set("station", stationId);
  url.searchParams.set("product", "predictions");
  url.searchParams.set("datum", "MLLW");
  url.searchParams.set("time_zone", "gmt");
  url.searchParams.set("interval", "hilo");
  url.searchParams.set("units", "english");
  url.searchParams.set("format", "json");
  url.searchParams.set("begin_date", beginYYYYMMDD);
  url.searchParams.set("range", "72");
  url.searchParams.set("application", "birds.gaylon.photos");
  const res = await doFetch(url.toString(), {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("predictions: non-JSON response");
  }
  const parsed = parsePredictions(json); // throws TideUnavailable on {error} first
  if (!res.ok) throw new Error(`NOAA CO-OPS ${res.status}`);
  return parsed;
}

function predCacheKey(stationId: string, date: string): string {
  return `tidePred:${stationId}:${date}`;
}

/**
 * Cache-then-fetch predictions for one station+date. A `TideUnavailable`
 * (the 200/400 error-body cases — bad params, not a transient outage) never
 * writes to the cache and never falls back to a stale row: it means the
 * request itself is wrong, so stale data would be misleading, not helpful.
 */
async function predictionsForStationDate(
  station: TideStation,
  date: string,
  opts: TideFetchOpts,
): Promise<{ extremes: RawTideExtreme[]; stale: boolean } | null> {
  const now = opts.now ?? new Date();
  const key = predCacheKey(station.id, date);
  const cached = await query<{ payload: unknown; fetched_at: string }>(
    "SELECT payload, fetched_at FROM ebird_cache WHERE cache_key = $1",
    [key],
  );
  const row = cached.rows[0];
  const fresh =
    row &&
    now.getTime() - new Date(row.fetched_at).getTime() < PRED_TTL_MIN * 60_000;
  if (row && fresh) {
    const parsed = validateCachedPredictions(row.payload);
    if (parsed) return { extremes: parsed.extremes, stale: false };
    // malformed fresh row — treat as a cache miss, fall through to live fetch
  }
  try {
    const begin = dayBefore(date).replaceAll("-", "");
    const parsed = await fetchPredictions(station.id, begin, opts);
    await query(
      `INSERT INTO ebird_cache (cache_key, payload, fetched_at)
			 VALUES ($1, $2, NOW())
			 ON CONFLICT (cache_key) DO UPDATE SET payload = $2, fetched_at = NOW()`,
      [key, JSON.stringify(parsed)],
    );
    return { extremes: parsed.extremes, stale: false };
  } catch (err) {
    if (err instanceof TideUnavailable) return null; // never cache, never stale-fallback
    if (row) {
      const parsed = validateCachedPredictions(row.payload);
      if (parsed) return { extremes: parsed.extremes, stale: true };
    }
    return null;
  }
}

function decorate(e: RawTideExtreme, tz: string, now: Date): TideExtreme {
  const core: TideExtremeCore = {
    type: e.type,
    at: e.at,
    feetMllw: e.feetMllw,
    dayOffset: localDayOffset(e.at, tz, now),
  };
  return {
    ...core,
    timeLabel: formatTideTime(e.at, tz),
    phrase: tidePhrase(core, tz),
  };
}

/** Builds the serialized `TideResult` for ONE stop from shared prediction
 * data, cloning the station ref so `distanceKm` stays that stop's own
 * distance — one stop's distance must never leak into a sibling sharing the
 * same station. Returns null when derivation leaves nothing to show. */
function buildTideResult(
  station: TideStation,
  distanceKm: number,
  date: string,
  mode: "next" | "day",
  data: { extremes: RawTideExtreme[]; stale: boolean },
  now: Date,
): TideResult | null {
  const stationRef: TideStationRef = {
    id: station.id,
    name: station.name,
    distanceKm,
    tz: station.tz,
  };
  if (mode === "next") {
    const { nextHigh, nextLow } = pickNext(data.extremes, now.getTime());
    if (!nextHigh && !nextLow) return null;
    return {
      station: stationRef,
      mode,
      date,
      nextHigh: nextHigh ? decorate(nextHigh, station.tz, now) : null,
      nextLow: nextLow ? decorate(nextLow, station.tz, now) : null,
      day: [],
      stale: data.stale,
    };
  }
  const day = extremesOnLocalDate(data.extremes, date, station.tz);
  if (day.length === 0) return null;
  return {
    station: stationRef,
    mode,
    date,
    nextHigh: null,
    nextLow: null,
    day: day.map((e) => decorate(e, station.tz, now)),
    stale: data.stale,
  };
}

// ---------------------------------------------------------------------------
// Exported API.
// ---------------------------------------------------------------------------

export async function nearestTideStation(
  lat: number,
  lon: number,
  opts: TideFetchOpts = {},
): Promise<{ station: TideStation; distanceKm: number } | null> {
  if (!validCoord(lat, lon)) return null;
  let stations: TideStation[];
  try {
    stations = await loadStations(opts);
  } catch {
    return null;
  }
  return nearestStation(stations, lat, lon);
}

/**
 * Tide predictions nearest a coordinate. `targetDate` (station-local
 * `YYYY-MM-DD`) selects the day: omitted/today → 'next' mode (the upcoming
 * high/low after `now`); a future date → 'day' mode (that date's full
 * high/low set); a past date returns null (nothing to show). Never throws.
 */
export async function tidesNear(
  lat: number,
  lon: number,
  opts: TideFetchOpts & { targetDate?: string | null } = {},
): Promise<TideResult | null> {
  if (!validCoord(lat, lon)) return null;
  if (opts.targetDate != null && !validDateStr(opts.targetDate)) return null;
  const now = opts.now ?? new Date();

  let stations: TideStation[];
  try {
    stations = await loadStations(opts);
  } catch {
    return null;
  }
  const nearest = nearestStation(stations, lat, lon);
  if (!nearest) return null; // out of range — no predictions fetch
  const { station, distanceKm } = nearest;

  const today = localDate(now, station.tz);
  const date = opts.targetDate ?? today;
  if (date < today) return null; // a past explicit target — nothing to show
  const mode: "next" | "day" = date === today ? "next" : "day";

  const data = await predictionsForStationDate(station, date, { ...opts, now });
  if (!data) return null;
  return buildTideResult(station, distanceKm, date, mode, data, now);
}

/**
 * Tide predictions for every located trip stop, keyed by `String(stop.id)`.
 * Loads the station list once, resolves each stop's nearest station, groups
 * by `(station.id, targetDate, mode)` — see `targetTripDate` — and issues
 * one prediction/cache lookup per group, deduping same-beach stops onto a
 * single CO-OPS request while cloning the station ref per stop.
 */
export async function tidesForStops(
  stops: ReadonlyArray<{ id: number; lat: number | null; lon: number | null }>,
  opts: TideFetchOpts & {
    startDate?: string | null;
    endDate?: string | null;
  } = {},
): Promise<Record<string, TideResult>> {
  if (opts.startDate != null && !validDateStr(opts.startDate)) return {};
  if (opts.endDate != null && !validDateStr(opts.endDate)) return {};
  const now = opts.now ?? new Date();

  const located = stops.filter(
    (s): s is { id: number; lat: number; lon: number } =>
      s.lat != null && s.lon != null && validCoord(s.lat, s.lon),
  );
  if (located.length === 0) return {};

  let stations: TideStation[];
  try {
    stations = await loadStations(opts);
  } catch {
    return {};
  }

  const resolved: Array<{
    stopId: number;
    station: TideStation;
    distanceKm: number;
  }> = [];
  for (const s of located) {
    const nearest = nearestStation(stations, s.lat, s.lon);
    if (nearest) {
      resolved.push({
        stopId: s.id,
        station: nearest.station,
        distanceKm: nearest.distanceKm,
      });
    }
  }
  if (resolved.length === 0) return {};

  interface Group {
    station: TideStation;
    date: string;
    mode: "next" | "day";
    members: Array<{ stopId: number; distanceKm: number }>;
  }
  const groups = new Map<string, Group>();
  for (const r of resolved) {
    const todayLocal = localDate(now, r.station.tz);
    const target = targetTripDate(
      todayLocal,
      opts.startDate ?? null,
      opts.endDate ?? null,
    );
    if (!target) continue; // finished trip — zero fetches for this stop
    const key = `${r.station.id}:${target.date}:${target.mode}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        station: r.station,
        date: target.date,
        mode: target.mode,
        members: [],
      };
      groups.set(key, group);
    }
    group.members.push({ stopId: r.stopId, distanceKm: r.distanceKm });
  }
  if (groups.size === 0) return {};

  const fetched = await Promise.all(
    [...groups.values()].map(async (g) => ({
      g,
      data: await predictionsForStationDate(g.station, g.date, {
        ...opts,
        now,
      }),
    })),
  );

  const out: Record<string, TideResult> = {};
  for (const { g, data } of fetched) {
    if (!data) continue;
    for (const m of g.members) {
      const result = buildTideResult(
        g.station,
        m.distanceKm,
        g.date,
        g.mode,
        data,
        now,
      );
      if (result) out[String(m.stopId)] = result;
    }
  }
  return out;
}
