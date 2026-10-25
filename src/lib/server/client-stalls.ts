/**
 * Stuck pages (td-1cb094, under td-c4a58d): stores what browsers report about
 * their own navigations (src/lib/nav-watch.ts) and builds the Admin → Metrics
 * panel. Kept 30 days by the worker's prune job (jobs.ts).
 */
import { queryTimed, withTransaction } from "$lib/db";
import {
  MAX_EVENTS_PER_USER_DAY,
  type StallEvent,
  type StallKind,
} from "$lib/client-stalls";

export const CLIENT_STALLS_RETENTION_DAYS = 30;
const WRITE_TIMEOUT_MS = 3_000;
const REPORT_TIMEOUT_MS = 3_000;
export const STALLS_RECENT_LIMIT = 50;

/**
 * Stores one browser's reports for a signed-in account. A report already
 * stored (same event id) is skipped; past MAX_EVENTS_PER_USER_DAY in the last
 * 24 hours the rest are dropped. The count and the insert run under one
 * per-account lock, so simultaneous posts cannot pass the cap together.
 * Returns how many rows were written.
 */
export async function recordClientStalls(
  userId: number,
  device: string,
  events: StallEvent[],
): Promise<number> {
  if (events.length === 0) return 0;
  return withTransaction(async (db) => {
    await db.query(`SET LOCAL statement_timeout = ${WRITE_TIMEOUT_MS}`);
    await db.query(
      `SELECT pg_advisory_xact_lock(hashtext('client-stalls:' || $1))`,
      [String(userId)],
    );
    const used = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM client_stalls WHERE user_id = $1 AND received_at > NOW() - interval '1 day'`,
      [userId],
    );
    const room = Math.max(0, MAX_EVENTS_PER_USER_DAY - used.rows[0].n);
    const take = events.slice(0, room);
    if (take.length === 0) return 0;
    const r = await db.query(
      `INSERT INTO client_stalls
       (event_id, occurred_at, user_id, kind, from_route, to_route, to_path, nav_type, stage,
        waited_ms, data_ms, alive_ms, hidden_ms, errors, standalone, online, device, version)
     SELECT e.event_id, to_timestamp(e.occurred_ms / 1000.0), $1, e.kind, e.from_route, e.to_route, e.to_path,
            e.nav_type, e.stage, e.waited_ms, e.data_ms, e.alive_ms, e.hidden_ms,
            ARRAY(SELECT jsonb_array_elements_text(e.errors)), e.standalone, e.online, $2, e.version
       FROM jsonb_to_recordset($3::jsonb) AS e(
              event_id uuid, occurred_ms bigint, kind text, from_route text, to_route text, to_path text,
              nav_type text, stage text, waited_ms int, data_ms int, alive_ms int, hidden_ms int,
              errors jsonb, standalone boolean, online boolean, version text)
     ON CONFLICT (event_id) DO NOTHING`,
      [
        userId,
        device.slice(0, 300),
        JSON.stringify(
          take.map((e) => ({
            event_id: e.id,
            occurred_ms: e.occurredAt,
            kind: e.kind,
            from_route: e.fromRoute,
            to_route: e.toRoute,
            to_path: e.toPath,
            nav_type: e.navType,
            stage: e.stage,
            waited_ms: e.waitedMs,
            data_ms: e.dataMs,
            alive_ms: e.aliveMs,
            hidden_ms: e.hiddenMs,
            errors: e.errors,
            standalone: e.standalone,
            online: e.online,
            version: e.version,
          })),
        ),
      ],
    );
    return r.rowCount ?? 0;
  });
}

export interface StallRow {
  occurredAt: string;
  receivedAt: string;
  user: string;
  kind: StallKind;
  fromRoute: string | null;
  toRoute: string | null;
  toPath: string | null;
  navType: string | null;
  stage: string | null;
  waitedMs: number;
  dataMs: number | null;
  aliveMs: number | null;
  hiddenMs: number | null;
  errors: string[];
  standalone: boolean;
  online: boolean;
  device: string;
  version: string;
}

export interface StallRollup {
  /** The page navigated to (route id), or the page that froze. */
  route: string;
  total: number;
  byKind: Record<StallKind, number>;
  worstWaitedMs: number;
}

export interface ClientStallsReport {
  recent: StallRow[];
  routes: StallRollup[];
  retentionDays: number;
}

const iso = (v: Date | string) =>
  (v instanceof Date ? v : new Date(v)).toISOString();

/** The panel: the newest reports with who and on what device, and a 7-day count per page. */
export async function clientStallsReport(): Promise<ClientStallsReport> {
  const [recent, routes] = await Promise.all([
    queryTimed<{
      occurred_at: Date;
      received_at: Date;
      username: string;
      kind: StallKind;
      from_route: string | null;
      to_route: string | null;
      to_path: string | null;
      nav_type: string | null;
      stage: string | null;
      waited_ms: number;
      data_ms: number | null;
      alive_ms: number | null;
      hidden_ms: number | null;
      errors: string[];
      standalone: boolean;
      online: boolean;
      device: string;
      version: string;
    }>(
      `SELECT s.occurred_at, s.received_at, u.username, s.kind, s.from_route, s.to_route, s.to_path, s.nav_type,
              s.stage, s.waited_ms, s.data_ms, s.alive_ms, s.hidden_ms, s.errors, s.standalone, s.online,
              s.device, s.version
         FROM client_stalls s JOIN users u ON u.id = s.user_id
        ORDER BY s.occurred_at DESC, s.id DESC
        LIMIT $1`,
      [STALLS_RECENT_LIMIT],
      REPORT_TIMEOUT_MS,
    ),
    queryTimed<{ route: string; kind: StallKind; n: number; worst: number }>(
      `SELECT COALESCE(to_route, '(unknown)') AS route, kind, COUNT(*)::int AS n, MAX(waited_ms) AS worst
         FROM client_stalls
        WHERE occurred_at > NOW() - interval '7 days'
        GROUP BY 1, 2`,
      [],
      REPORT_TIMEOUT_MS,
    ),
  ]);
  const byRoute = new Map<string, StallRollup>();
  for (const r of routes.rows) {
    let row = byRoute.get(r.route);
    if (!row) {
      row = {
        route: r.route,
        total: 0,
        byKind: {
          slow: 0,
          superseded: 0,
          unfinished: 0,
          reloaded: 0,
          lost: 0,
          freeze: 0,
        },
        worstWaitedMs: 0,
      };
      byRoute.set(r.route, row);
    }
    row.total += r.n;
    row.byKind[r.kind] += r.n;
    row.worstWaitedMs = Math.max(row.worstWaitedMs, r.worst);
  }
  return {
    recent: recent.rows.map((r) => ({
      occurredAt: iso(r.occurred_at),
      receivedAt: iso(r.received_at),
      user: r.username,
      kind: r.kind,
      fromRoute: r.from_route,
      toRoute: r.to_route,
      toPath: r.to_path,
      navType: r.nav_type,
      stage: r.stage,
      waitedMs: r.waited_ms,
      dataMs: r.data_ms,
      aliveMs: r.alive_ms,
      hiddenMs: r.hidden_ms,
      errors: r.errors,
      standalone: r.standalone,
      online: r.online,
      device: r.device,
      version: r.version,
    })),
    routes: [...byRoute.values()].sort(
      (a, b) =>
        b.total - a.total ||
        b.worstWaitedMs - a.worstWaitedMs ||
        a.route.localeCompare(b.route),
    ),
    retentionDays: CLIENT_STALLS_RETENTION_DAYS,
  };
}
