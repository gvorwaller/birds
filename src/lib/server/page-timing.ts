/**
 * Performance panel (td-67b481; plan docs/2026-10-13-admin-observability-
 * epic-plan.md, slice 3). The value is regression detection across deploys:
 * "/species/[code] was 300 ms last week, 900 ms now", without anyone having
 * to notice it by hand or read the pm2 log over SSH.
 *
 * hooks.server.ts already writes a stdout perf line when a response body
 * finishes and took longer than PERF_LOG_SLOW_MS. The same moment records a
 * row here, fire-and-forget: the response has already gone out, so a slow or
 * failed write can never delay it. Fast requests are never recorded, so this
 * is CENSORED data: it shows what is slow and whether it is getting worse,
 * not how fast the site usually is, and the panel says so.
 */
import { queryTimed } from "$lib/db";
import type { TimingBag } from "$server/request-timing";

export const PAGE_TIMING_RETENTION_DAYS = 30;
const WRITE_TIMEOUT_MS = 2_000;
const REPORT_TIMEOUT_MS = 3_000;
/** During an incident every request is slow; past this many writes in
 * flight, further rows are skipped (and logged) rather than piling onto a
 * database that is already struggling. */
export const MAX_WRITES_IN_FLIGHT = 4;
export const RECENT_LIMIT = 50;

export interface SlowRequest {
  routeId: string | null;
  method: string;
  status: number;
  shellMs: number;
  totalMs: number;
  bytes: number;
  tags: number | null;
  bag: TimingBag;
  rssBytes: number;
  heapBytes: number;
  version: string;
}

let writesInFlight = 0;

const mb = (b: number) => Math.round(b / (1024 * 1024));

/** Record one slow request. Never throws, never blocks the caller. */
export function recordSlowRequest(r: SlowRequest): Promise<void> {
  if (writesInFlight >= MAX_WRITES_IN_FLIGHT) {
    console.warn(`[page-timing] skipped a row: ${writesInFlight} writes already in flight`);
    return Promise.resolve();
  }
  writesInFlight += 1;
  const b = r.bag.buckets;
  return queryTimed(
    `INSERT INTO page_timing
       (route, method, status, shell_ms, total_ms, bytes, tags,
        db_n, db_ms, ebird_n, ebird_ms, google_n, google_ms, ai_n, ai_ms,
        rss_mb, heap_mb, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      r.routeId ?? "(none)",
      r.method,
      r.status,
      Math.round(r.shellMs),
      Math.round(r.totalMs),
      Math.round(r.bytes),
      r.tags,
      b.db.n,
      Math.round(b.db.ms),
      b.ebird.n,
      Math.round(b.ebird.ms),
      b.google.n,
      Math.round(b.google.ms),
      b.ai.n,
      Math.round(b.ai.ms),
      mb(r.rssBytes),
      mb(r.heapBytes),
      r.version,
    ],
    WRITE_TIMEOUT_MS,
  )
    .then(() => undefined)
    .catch((err) => {
      console.error("[page-timing] write failed:", err instanceof Error ? err.message : err);
    })
    .finally(() => {
      writesInFlight -= 1;
    });
}

export interface RecentSlow {
  at: string;
  route: string;
  method: string;
  status: number;
  shellMs: number;
  totalMs: number;
  bytes: number;
  db: { n: number; ms: number };
  ebird: { n: number; ms: number };
  google: { n: number; ms: number };
  ai: { n: number; ms: number };
  version: string;
}

export interface RouteRollup {
  route: string;
  count: number;
  medianTotalMs: number;
  worstTotalMs: number;
  medianShellMs: number;
  worstBytes: number;
  /** The same route's slow requests in the 7 days before this window: the
   * row to compare against, so a climbing route stands out. */
  previousCount: number;
  previousMedianTotalMs: number | null;
}

export interface DeployVersion {
  version: string;
  firstSeen: string;
  count: number;
}

export interface PageTimingReport {
  thresholdMs: number;
  /** null = all versions. */
  version: string | null;
  recent: RecentSlow[];
  routes: RouteRollup[];
  versions: DeployVersion[];
  retentionDays: number;
}

const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();

/** The panel: the newest slow requests, a 7-day per-route rollup with the
 * previous 7 days beside it, and the deploy versions seen in 30 days. A
 * `version` narrows the recent list and the current window to one deploy. */
export async function pageTimingReport(thresholdMs: number, version: string | null): Promise<PageTimingReport> {
  const [recent, routes, versions] = await Promise.all([
    queryTimed<{
      at: Date;
      route: string;
      method: string;
      status: number;
      shell_ms: number;
      total_ms: number;
      bytes: number;
      db_n: number;
      db_ms: number;
      ebird_n: number;
      ebird_ms: number;
      google_n: number;
      google_ms: number;
      ai_n: number;
      ai_ms: number;
      version: string;
    }>(
      `SELECT at, route, method, status, shell_ms, total_ms, bytes, db_n, db_ms,
              ebird_n, ebird_ms, google_n, google_ms, ai_n, ai_ms, version
         FROM page_timing
        WHERE ($1::text IS NULL OR version = $1)
        ORDER BY at DESC, id DESC
        LIMIT $2`,
      [version, RECENT_LIMIT],
      REPORT_TIMEOUT_MS,
    ),
    queryTimed<{
      route: string;
      count: number;
      median_total: number;
      worst_total: number;
      median_shell: number;
      worst_bytes: number;
      prev_count: number;
      prev_median_total: number | null;
    }>(
      `WITH cur AS (
         SELECT route, COUNT(*)::int AS count,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms)::float8 AS median_total,
                MAX(total_ms) AS worst_total,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY shell_ms)::float8 AS median_shell,
                MAX(bytes) AS worst_bytes
           FROM page_timing
          WHERE at > NOW() - interval '7 days' AND ($1::text IS NULL OR version = $1)
          GROUP BY route
       ), prev AS (
         SELECT route, COUNT(*)::int AS count,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms)::float8 AS median_total
           FROM page_timing
          WHERE at > NOW() - interval '14 days' AND at <= NOW() - interval '7 days'
          GROUP BY route
       )
       SELECT cur.route, cur.count, cur.median_total, cur.worst_total, cur.median_shell,
              cur.worst_bytes, COALESCE(prev.count, 0) AS prev_count,
              prev.median_total AS prev_median_total
         FROM cur LEFT JOIN prev USING (route)
        ORDER BY cur.count DESC, cur.median_total DESC, cur.route`,
      [version],
      REPORT_TIMEOUT_MS,
    ),
    queryTimed<{ version: string; first_seen: Date; count: number }>(
      `SELECT version, MIN(at) AS first_seen, COUNT(*)::int AS count
         FROM page_timing
        GROUP BY version
        ORDER BY MIN(at) DESC`,
      [],
      REPORT_TIMEOUT_MS,
    ),
  ]);
  return {
    thresholdMs,
    version,
    retentionDays: PAGE_TIMING_RETENTION_DAYS,
    recent: recent.rows.map((r) => ({
      at: iso(r.at),
      route: r.route,
      method: r.method,
      status: r.status,
      shellMs: r.shell_ms,
      totalMs: r.total_ms,
      bytes: r.bytes,
      db: { n: r.db_n, ms: r.db_ms },
      ebird: { n: r.ebird_n, ms: r.ebird_ms },
      google: { n: r.google_n, ms: r.google_ms },
      ai: { n: r.ai_n, ms: r.ai_ms },
      version: r.version,
    })),
    routes: routes.rows.map((r) => ({
      route: r.route,
      count: r.count,
      medianTotalMs: Math.round(r.median_total),
      worstTotalMs: r.worst_total,
      medianShellMs: Math.round(r.median_shell),
      worstBytes: r.worst_bytes,
      previousCount: r.prev_count,
      previousMedianTotalMs: r.prev_median_total == null ? null : Math.round(r.prev_median_total),
    })),
    versions: versions.rows.map((v) => ({ version: v.version, firstSeen: iso(v.first_seen), count: v.count })),
  };
}
