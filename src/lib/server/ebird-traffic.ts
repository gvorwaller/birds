/**
 * eBird traffic metric (td-009031; plan docs/2026-10-13-admin-observability-
 * epic-plan.md, slice 2). Purpose (owner, 2026-10-09): see how much eBird
 * traffic the app makes, and from where, so it can later be made cheaper.
 * Diagnostic, not per-user.
 *
 * Every eBird network request passes one of three functions: ebirdFetch and
 * ebirdFetchOrNull (api.ebird.org) and fetchWithJar (ebird.org web pages and
 * the Cornell sign-in). Each reports here with its endpoint, outcome, time
 * and size; cachedFetch reports the requests the ebird_cache answered
 * instead. Counts add up in memory per process and are flushed every minute
 * (and on a clean shutdown) into ebird_traffic_daily, one row per day ×
 * endpoint × origin × outcome. A crash loses at most the unflushed minute,
 * so totals are approximate.
 *
 * Privacy: an endpoint is a fixed name from the allow-list below, never a
 * path, query, key, region, location or species; the table's CHECK
 * constraints refuse anything else.
 */
import { queryTimed } from "$lib/db";
import { currentJobType } from "$server/job-claim";
import { displayName } from "$server/job-policy";
import { createNonOverlappingSampler } from "$server/process-health";

export const TRAFFIC_RETENTION_DAYS = 400;
export const FLUSH_INTERVAL_MS = 60_000;
const FLUSH_TIMEOUT_MS = 2_000;
const REPORT_TIMEOUT_MS = 3_000;

export const OUTCOMES = [
  "ok",
  "not_found",
  "http_error",
  "rate_limited",
  "network_error",
  "cache_hit",
  "stale_fallback",
] as const;
export type EbirdOutcome = (typeof OUTCOMES)[number];
/** Outcomes that were real network requests (the rest were cache answers). */
export const NETWORK_OUTCOMES: readonly EbirdOutcome[] = [
  "ok",
  "not_found",
  "http_error",
  "rate_limited",
  "network_error",
];

/** Every endpoint the app calls, with the words Admin shows for it. */
export const ENDPOINT_LABELS: Record<string, string> = {
  "obs/region/recent": "Recent sightings in a region",
  "obs/region/notable": "Notable sightings in a region",
  "obs/region/species": "One species' sightings in a region",
  "obs/hotspot/recent": "Recent sightings at a hotspot",
  "obs/geo/recent": "Recent sightings near a point",
  "obs/geo/notable": "Notable sightings near a point",
  "obs/geo/species": "One species near a point",
  "nearest/species": "Nearest reports of a species",
  "hotspot/region": "Hotspots in a region",
  "hotspot/geo": "Hotspots near a point",
  "hotspot/info": "One hotspot's details",
  "region/list": "Region lists",
  "taxonomy": "Taxonomy",
  "web/barchart": "Bar charts (frequency loads)",
  "web/lifelist": "Life list download",
  "web/checklist": "Checklist pages",
  "web/login": "eBird sign-in",
  "web/other": "Other eBird web pages",
  "other": "Other API calls",
};

/** api.ebird.org/v2 paths, most specific first. */
const API_RULES: [RegExp, string][] = [
  [/^\/data\/obs\/geo\/recent\/notable$/, "obs/geo/notable"],
  [/^\/data\/obs\/geo\/recent\/[^/]+$/, "obs/geo/species"],
  [/^\/data\/obs\/geo\/recent$/, "obs/geo/recent"],
  [/^\/data\/nearest\/geo\/recent\/[^/]+$/, "nearest/species"],
  [/^\/data\/obs\/L\d+\/recent$/, "obs/hotspot/recent"],
  [/^\/data\/obs\/[^/]+\/recent\/notable$/, "obs/region/notable"],
  [/^\/data\/obs\/[^/]+\/recent\/[^/]+$/, "obs/region/species"],
  [/^\/data\/obs\/[^/]+\/recent$/, "obs/region/recent"],
  [/^\/ref\/hotspot\/geo$/, "hotspot/geo"],
  [/^\/ref\/hotspot\/info\/[^/]+$/, "hotspot/info"],
  [/^\/ref\/hotspot\/[^/]+$/, "hotspot/region"],
  [/^\/ref\/region\/list\/[^/]+\/[^/]+$/, "region/list"],
  [/^\/ref\/taxonomy\/ebird$/, "taxonomy"],
];

/** The endpoint name for an api.ebird.org/v2 path (query string ignored). */
export function classifyApiPath(path: string): string {
  const bare = path.split("?")[0];
  for (const [re, name] of API_RULES) if (re.test(bare)) return name;
  return "other";
}

/** The endpoint name for an ebird.org web page or Cornell sign-in URL. */
export function classifyWebUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch { // stale-safe: URL parse only
    return "web/other";
  }
  if (u.host === "secure.birds.cornell.edu") return "web/login";
  if (u.host !== "ebird.org" && u.host !== "www.ebird.org") return "web/other";
  if (u.pathname.startsWith("/login")) return "web/login";
  if (u.pathname === "/barchartData") return "web/barchart";
  if (u.pathname === "/lifelist") return "web/lifelist";
  if (/^\/checklist\/S\d+$/.test(u.pathname)) return "web/checklist";
  return "web/other";
}

/**
 * ebird_cache key prefix → endpoint, for requests the cache answered (the
 * cache sees only its key). One prefix per cachedFetch call site in ebird.ts;
 * ebird-traffic.test.ts fails when a new prefix is not listed here.
 */
export const CACHE_KEY_ENDPOINTS: Record<string, string> = {
  obs: "obs/region/recent",
  notable: "obs/region/notable",
  spReg: "obs/region/species",
  hotspotObs2: "obs/hotspot/recent",
  geo: "obs/geo/recent",
  geonote: "obs/geo/notable",
  geosp2: "obs/geo/species",
  nearestObs: "nearest/species",
  hotspotsRegion: "hotspot/region",
  hotspots: "hotspot/geo",
  regions: "region/list",
};

export function classifyCacheKey(cacheKey: string): string {
  return CACHE_KEY_ENDPOINTS[cacheKey.split(":")[0]] ?? "other";
}

/** The outcome of a network response by its HTTP status. */
export function outcomeForStatus(status: number): EbirdOutcome {
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  return status >= 400 ? "http_error" : "ok";
}

// ── who is asking ──────────────────────────────────────────────────────────

let processRole: "web" | "worker" = "web";
/** The worker entry point calls this once; everything else is the web app. */
export function setTrafficProcess(role: "web" | "worker"): void {
  processRole = role;
}

/** The job type when a worker job is running, otherwise the process. */
export function currentOrigin(): string {
  return currentJobType() ?? processRole;
}

// ── in-memory tally ────────────────────────────────────────────────────────

interface Tally {
  day: string;
  endpoint: string;
  origin: string;
  outcome: EbirdOutcome;
  calls: number;
  ms: number;
  bytes: number;
}
const tally = new Map<string, Tally>();

/** Count one request (or one cache answer). Never throws, never awaits. */
export function recordEbirdTraffic(
  endpoint: string,
  outcome: EbirdOutcome,
  ms = 0,
  bytes = 0,
  at: Date = new Date(),
): void {
  const day = at.toISOString().slice(0, 10);
  const origin = currentOrigin();
  const key = `${day}|${endpoint}|${origin}|${outcome}`;
  const t = tally.get(key);
  const msInt = Math.max(0, Math.round(ms));
  const bytesInt = Math.max(0, Math.round(bytes));
  if (t) {
    t.calls += 1;
    t.ms += msInt;
    t.bytes += bytesInt;
  } else {
    tally.set(key, { day, endpoint, origin, outcome, calls: 1, ms: msInt, bytes: bytesInt });
  }
}

/** Tests only: the unflushed tally. */
export function pendingTrafficForTests(): Tally[] {
  return [...tally.values()];
}

/** Writes started and not yet settled; a shutdown waits for them. */
const inFlight = new Set<Promise<unknown>>();

/**
 * Add the tally into ebird_traffic_daily and clear it. The tally is taken
 * before the write, so requests counted meanwhile wait for the next flush. A
 * failed write is dropped, not retried: a timed-out write may still have
 * committed, and adding it twice would be worse than losing a minute.
 * Overlapping flushes are safe: each adds its own rows.
 */
export function flushEbirdTraffic(): Promise<number> {
  if (tally.size === 0) return Promise.resolve(0);
  const rows = [...tally.values()];
  tally.clear();
  const write = writeRows(rows);
  const tracked = write.then(
    () => undefined,
    () => undefined,
  );
  inFlight.add(tracked);
  void tracked.finally(() => inFlight.delete(tracked));
  return write;
}

async function writeRows(rows: Tally[]): Promise<number> {
  await queryTimed(
    `INSERT INTO ebird_traffic_daily AS t (day, endpoint, origin, outcome, calls, total_ms, bytes)
     SELECT * FROM unnest($1::date[], $2::text[], $3::text[], $4::text[], $5::int[], $6::bigint[], $7::bigint[])
     ON CONFLICT (day, endpoint, origin, outcome) DO UPDATE
       SET calls = t.calls + EXCLUDED.calls,
           total_ms = t.total_ms + EXCLUDED.total_ms,
           bytes = t.bytes + EXCLUDED.bytes`,
    [
      rows.map((r) => r.day),
      rows.map((r) => r.endpoint),
      rows.map((r) => r.origin),
      rows.map((r) => r.outcome),
      rows.map((r) => r.calls),
      rows.map((r) => r.ms),
      rows.map((r) => r.bytes),
    ],
    FLUSH_TIMEOUT_MS,
  );
  return rows.length;
}

const flusherGlobal = globalThis as typeof globalThis & {
  __birdsEbirdTrafficFlusher?: { timer: ReturnType<typeof setInterval> | null };
};

/** Flush every minute (once per process; survives dev HMR like the memory
 * sampler). Failures are logged, never thrown. */
export function startEbirdTrafficFlusher(): void {
  if (flusherGlobal.__birdsEbirdTrafficFlusher) return;
  const runner = createNonOverlappingSampler(
    async () => {
      await flushEbirdTraffic();
    },
    (err) =>
      console.error("[ebird-traffic] flush failed:", err instanceof Error ? err.message : err),
  );
  const timer = setInterval(() => runner.run(), FLUSH_INTERVAL_MS);
  timer.unref();
  flusherGlobal.__birdsEbirdTrafficFlusher = { timer };
}

/**
 * A clean shutdown's last flush: stop the timer, wait for any write already
 * running (its rows left the tally when it started), then write what is
 * left. Resolves only when every write has settled.
 */
export async function flushEbirdTrafficOnShutdown(): Promise<void> {
  const f = flusherGlobal.__birdsEbirdTrafficFlusher;
  if (f?.timer) {
    clearInterval(f.timer);
    f.timer = null;
  }
  await Promise.all([...inFlight]);
  await flushEbirdTraffic().catch((err) =>
    console.error("[ebird-traffic] final flush failed:", err instanceof Error ? err.message : err),
  );
}

// ── the Admin report ───────────────────────────────────────────────────────

export interface TrafficByEndpoint {
  endpoint: string;
  label: string;
  network7d: number;
  network30d: number;
  cacheHits30d: number;
  stale30d: number;
  rateLimited30d: number;
  errors30d: number;
  /** Mean time of a network request over 30 days; null with none. */
  avgMs: number | null;
  bytes30d: number;
}

export interface TrafficByOrigin {
  origin: string;
  label: string;
  network7d: number;
  network30d: number;
}

export interface TrafficDay {
  day: string;
  network: number;
  cacheHits: number;
}

export interface TrafficReport {
  /** The first day with any record: the metric started then. */
  since: string | null;
  endpoints: TrafficByEndpoint[];
  origins: TrafficByOrigin[];
  days: TrafficDay[];
}

/** "Web app", "Worker (outside a job)" or the job's own Admin name. */
export function originLabel(origin: string): string {
  if (origin === "web") return "Web app (pages people open)";
  if (origin === "worker") return "Worker, outside a job";
  return displayName({ type: origin, label: "" });
}

const NET = `outcome IN ('ok','not_found','http_error','rate_limited','network_error')`;

/** Today as a UTC date: the same clock recordEbirdTraffic files rows by. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The report, every window anchored to one UTC `today` (never the database
 * session's CURRENT_DATE, which follows its time zone). */
export async function ebirdTrafficReport(today: string = utcToday()): Promise<TrafficReport> {
  const [byEndpoint, byOrigin, byDay, first] = await Promise.all([
    queryTimed<{
      endpoint: string;
      network_7d: number;
      network_30d: number;
      cache_hits: number;
      stale: number;
      rate_limited: number;
      errors: number;
      net_ms: string;
      bytes: string;
    }>(
      `SELECT endpoint,
              COALESCE(SUM(calls) FILTER (WHERE ${NET} AND day > $1::date - 7), 0)::int AS network_7d,
              COALESCE(SUM(calls) FILTER (WHERE ${NET}), 0)::int AS network_30d,
              COALESCE(SUM(calls) FILTER (WHERE outcome = 'cache_hit'), 0)::int AS cache_hits,
              COALESCE(SUM(calls) FILTER (WHERE outcome = 'stale_fallback'), 0)::int AS stale,
              COALESCE(SUM(calls) FILTER (WHERE outcome = 'rate_limited'), 0)::int AS rate_limited,
              COALESCE(SUM(calls) FILTER (WHERE outcome IN ('http_error','network_error')), 0)::int AS errors,
              COALESCE(SUM(total_ms) FILTER (WHERE ${NET}), 0)::text AS net_ms,
              COALESCE(SUM(bytes), 0)::text AS bytes
         FROM ebird_traffic_daily
        WHERE day > $1::date - 30 AND day <= $1::date
        GROUP BY endpoint`,
      [today],
      REPORT_TIMEOUT_MS,
    ),
    queryTimed<{ origin: string; network_7d: number; network_30d: number }>(
      `SELECT origin,
              COALESCE(SUM(calls) FILTER (WHERE day > $1::date - 7), 0)::int AS network_7d,
              SUM(calls)::int AS network_30d
         FROM ebird_traffic_daily
        WHERE day > $1::date - 30 AND day <= $1::date AND ${NET}
        GROUP BY origin`,
      [today],
      REPORT_TIMEOUT_MS,
    ),
    queryTimed<{ day: string; network: number; cache_hits: number }>(
      `SELECT d::date::text AS day,
              COALESCE(SUM(t.calls) FILTER (WHERE t.${NET}), 0)::int AS network,
              COALESCE(SUM(t.calls) FILTER (WHERE t.outcome = 'cache_hit'), 0)::int AS cache_hits
         FROM generate_series($1::date - 29, $1::date, interval '1 day') d
         LEFT JOIN ebird_traffic_daily t ON t.day = d::date
        GROUP BY d
        ORDER BY d`,
      [today],
      REPORT_TIMEOUT_MS,
    ),
    queryTimed<{ since: string | null }>(
      `SELECT MIN(day)::text AS since FROM ebird_traffic_daily`,
      [],
      REPORT_TIMEOUT_MS,
    ),
  ]);
  return {
    since: first.rows[0]?.since ?? null,
    endpoints: byEndpoint.rows
      .map((r) => ({
        endpoint: r.endpoint,
        label: ENDPOINT_LABELS[r.endpoint] ?? r.endpoint,
        network7d: r.network_7d,
        network30d: r.network_30d,
        cacheHits30d: r.cache_hits,
        stale30d: r.stale,
        rateLimited30d: r.rate_limited,
        errors30d: r.errors,
        avgMs: r.network_30d > 0 ? Math.round(Number(r.net_ms) / r.network_30d) : null,
        bytes30d: Number(r.bytes),
      }))
      .sort((a, b) => b.network30d - a.network30d || b.cacheHits30d - a.cacheHits30d || a.endpoint.localeCompare(b.endpoint)),
    origins: byOrigin.rows.sort((a, b) => b.network_30d - a.network_30d || a.origin.localeCompare(b.origin)).map((r) => ({
      origin: r.origin,
      label: originLabel(r.origin),
      network7d: r.network_7d,
      network30d: r.network_30d,
    })),
    days: byDay.rows.map((r) => ({ day: r.day, network: r.network, cacheHits: r.cache_hits })),
  };
}
