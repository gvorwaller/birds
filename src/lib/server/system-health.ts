/**
 * Server health tab, system cards (td-a47c0d; plan
 * docs/2026-10-13-admin-observability-epic-plan.md, slice 1a).
 *
 * Each card is read on its own with its own deadline, so one slow or failed
 * card shows "unavailable" with its reason while the others still render.
 * Local database and filesystem reads only: nothing here calls eBird, Google
 * or Anthropic.
 */
import { statfs } from "node:fs/promises";
import { queryTimed } from "$lib/db";
import { adminWorker, type AdminWorker } from "$server/admin-status";
import { RECURRING_TYPES, workerHealth } from "$server/jobs";
import { displayName, sanitizeErrorText } from "$server/job-policy";
import {
  enrichmentCoverage,
  type EnrichmentCoverage,
} from "$server/species-enrichment";

/** The Server health precedent (process-health.ts HEALTH_READ_TIMEOUT_MS). */
export const CARD_TIMEOUT_MS = 3_000;
/**
 * Backstop for a whole card, past its queries' own deadlines: a read with no
 * deadline of its own (statfs) or a pool that never answers must still let
 * the response, and every other card, through.
 */
export const CARD_DEADLINE_MS = CARD_TIMEOUT_MS + 500;
/** pruneHistory deletes finished jobs after this many days. */
export const JOB_RETENTION_DAYS = 90;
/**
 * The droplet has one filesystem: `/`, which holds the Postgres data
 * directory (/var/lib/postgresql/17/birds) and /opt/birds alike (findmnt on
 * prod, 2026-10-17). The web process cannot read the data directory itself,
 * but statfs on `/` reports the same device.
 */
export const DISK_PATH = "/";

/** The madonnahist rule: a nightly backup older than this is stale. */
export const BACKUP_STALE_HOURS = 26;

export type HealthCard<T> = { ok: true; data: T } | { ok: false; reason: string };

export interface QueueRow {
  type: string;
  /** enrich_species chunks that only write AI notes (displayName's split). */
  aiOnly: boolean;
  name: string;
  recurring: boolean;
  /** Pending work that can run now or is retrying: what the Status tab
   * counts as queued. */
  pending: number;
  /** Recurring checks parked until their next run (isScheduledSingleton). */
  scheduled: number;
  running: number;
  failed24h: number;
  failed7d: number;
  cancelled7d: number;
  /** Cancelled rows from before cancelling recorded a finish time; they
   * have no date, so no window can count them. */
  cancelledUndated: number;
  succeeded7d: number;
  lastSucceededAt: string | null;
  /** Recurring types only: the parked row's next scheduled run. */
  nextRunAt: string | null;
  medianMs: number | null;
  worstMs: number | null;
}

export interface QueueSummary {
  rows: QueueRow[];
  retentionDays: number;
}

export interface PostgresSummary {
  databaseBytes: number;
  settings: { name: string; value: string }[];
  heapHitPct: number | null;
  indexHitPct: number | null;
  /** null: the statistics have never been reset. */
  statsResetAt: string | null;
}

export interface DiskSpace {
  path: string;
  totalBytes: number;
  freeBytes: number;
}

export interface TableStat {
  name: string;
  /** Planner estimate (pg_class.reltuples); null before the first ANALYZE. */
  rowsEstimate: number | null;
  tableBytes: number;
  indexBytes: number;
  totalBytes: number;
  heapHitPct: number | null;
}

export interface CoverageSummary {
  countries: number;
  states: number;
  counties: number;
  hotspots: number;
  /** Distinct species recorded at any loaded location. */
  species: number;
  enrichment: EnrichmentCoverage;
}

export interface BackupStatus {
  /** When the owner's Mac last pulled and verified a prod dump; null when
   * none has been recorded (backup-pg.sh writes it, migration 0089). */
  at: string | null;
  bytes: number | null;
  stale: boolean;
  staleAfterHours: number;
}

export interface SystemHealth {
  now: string;
  worker: HealthCard<AdminWorker>;
  queue: HealthCard<QueueSummary>;
  postgres: HealthCard<PostgresSummary>;
  disk: HealthCard<DiskSpace>;
  tables: HealthCard<TableStat[]>;
  coverage: HealthCard<CoverageSummary>;
  backup: HealthCard<BackupStatus>;
}

/** A card's failure as the admin reads it: plain words, never a fake 0. */
export function cardFailure(card: string, err: unknown): { ok: false; reason: string } {
  // Sanitized once, before either sink: the server log and the response.
  const message = sanitizeErrorText(err instanceof Error ? err.message : String(err));
  console.error(`[system-health] ${card} card failed:`, message);
  return {
    ok: false,
    reason: /timeout|exceeded/i.test(message)
      ? `Timed out after ${CARD_TIMEOUT_MS / 1000} s.`
      : `Could not be read: ${message.slice(0, 160)}`,
  };
}

/** One card: its result, its failure, or a timeout once `deadlineMs` passes
 * whether or not the read ever settles. */
export async function card<T>(
  name: string,
  read: () => Promise<T>,
  deadlineMs = CARD_DEADLINE_MS,
): Promise<HealthCard<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`card deadline exceeded ${deadlineMs}ms`)), deadlineMs);
  });
  try {
    return { ok: true, data: await Promise.race([read(), deadline]) };
  } catch (err) { // stale-safe: admin web request, never under a job claim; a failure is the card's answer
    return cardFailure(name, err);
  } finally {
    clearTimeout(timer);
  }
}

const iso = (v: Date | string | null): string | null =>
  v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString();
const pct = (hit: number, read: number): number | null =>
  hit + read > 0 ? (hit / (hit + read)) * 100 : null;

export interface QueueSqlRow {
  type: string;
  ai_only: boolean;
  pending: number;
  scheduled: number;
  running: number;
  failed_24h: number;
  failed_7d: number;
  cancelled_7d: number;
  cancelled_undated: number;
  succeeded_7d: number;
  last_succeeded_at: Date | string | null;
  next_run_at: Date | string | null;
  median_ms: number | null;
  worst_ms: number | null;
}

/** Name, order and next-run rule for the queue rows (pure; tested alone). */
export function queueRows(rows: QueueSqlRow[]): QueueRow[] {
  return rows
    .map((r) => {
      const recurring = RECURRING_TYPES.has(r.type);
      return {
        type: r.type,
        aiOnly: r.ai_only,
        name: displayName({ type: r.type, label: "", payload: { aiOnly: r.ai_only } }),
        recurring,
        pending: r.pending,
        scheduled: r.scheduled,
        running: r.running,
        failed24h: r.failed_24h,
        failed7d: r.failed_7d,
        cancelled7d: r.cancelled_7d,
        cancelledUndated: r.cancelled_undated,
        succeeded7d: r.succeeded_7d,
        lastSucceededAt: iso(r.last_succeeded_at),
        nextRunAt: recurring ? iso(r.next_run_at) : null,
        medianMs: r.median_ms == null ? null : Math.round(r.median_ms),
        worstMs: r.worst_ms == null ? null : Math.round(r.worst_ms),
      };
    })
    .sort(
      // Work in progress first, then trouble, then by name.
      (a, b) =>
        b.running + b.pending - (a.running + a.pending) ||
        b.failed7d - a.failed7d ||
        a.name.localeCompare(b.name),
    );
}

/**
 * A recurring check parked until its next run: the SQL form of
 * isScheduledSingleton (job-policy.ts). A due, overdue, unscheduled or
 * retrying recurring row is real waiting work, as on the Status tab. The
 * COALESCE matters: a NULL next_retry_at would otherwise make both this and
 * its NOT unknown, dropping the row from every count.
 */
const PARKED_SQL = `COALESCE(type = ANY($1::text[]) AND status = 'pending'
   AND next_retry_at > NOW()
   AND COALESCE(progress->>'phase', '') <> 'waiting_retry', false)`;

/** Exact counts by job type × status: one GROUP BY over `jobs`, which the
 * prune job keeps to 90 days of finished rows (7,496 rows on prod,
 * 2026-10-17). */
export async function jobQueueSummary(): Promise<QueueSummary> {
  const r = await queryTimed<QueueSqlRow>(
    `SELECT type,
            -- COALESCE: a payload without aiOnly is ordinary species data,
            -- the same group as aiOnly:false (displayName's rule).
            COALESCE(type = 'enrich_species' AND payload->>'aiOnly' = 'true', false) AS ai_only,
            COUNT(*) FILTER (WHERE status = 'pending' AND NOT ${PARKED_SQL})::int AS pending,
            COUNT(*) FILTER (WHERE ${PARKED_SQL})::int AS scheduled,
            COUNT(*) FILTER (WHERE status = 'running')::int AS running,
            COUNT(*) FILTER (WHERE status = 'failed' AND finished_at > NOW() - interval '24 hours')::int AS failed_24h,
            COUNT(*) FILTER (WHERE status = 'failed' AND finished_at > NOW() - interval '7 days')::int AS failed_7d,
            COUNT(*) FILTER (WHERE status = 'cancelled' AND finished_at > NOW() - interval '7 days')::int AS cancelled_7d,
            COUNT(*) FILTER (WHERE status = 'cancelled' AND finished_at IS NULL)::int AS cancelled_undated,
            COUNT(*) FILTER (WHERE status = 'succeeded' AND finished_at > NOW() - interval '7 days')::int AS succeeded_7d,
            MAX(finished_at) FILTER (WHERE status = 'succeeded') AS last_succeeded_at,
            MIN(next_retry_at) FILTER (WHERE ${PARKED_SQL}) AS next_run_at,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM finished_at - started_at) * 1000)
              FILTER (WHERE status = 'succeeded' AND started_at IS NOT NULL
                        AND finished_at > NOW() - interval '7 days'))::float8 AS median_ms,
            (MAX(EXTRACT(EPOCH FROM finished_at - started_at) * 1000)
              FILTER (WHERE status = 'succeeded' AND started_at IS NOT NULL
                        AND finished_at > NOW() - interval '7 days'))::float8 AS worst_ms
       FROM jobs
      GROUP BY 1, 2`,
    [[...RECURRING_TYPES]],
    CARD_TIMEOUT_MS,
  );
  return { rows: queueRows(r.rows), retentionDays: JOB_RETENTION_DAYS };
}

const POSTGRES_SETTINGS = [
  "shared_buffers",
  "work_mem",
  "effective_cache_size",
  "max_parallel_workers_per_gather",
] as const;

export async function postgresSummary(): Promise<PostgresSummary> {
  const r = await queryTimed<{
    database_bytes: string;
    settings: { name: string; value: string }[];
    heap_hit: string;
    heap_read: string;
    idx_hit: string;
    idx_read: string;
    stats_reset: Date | string | null;
  }>(
    `SELECT pg_database_size(current_database())::text AS database_bytes,
            (SELECT json_agg(json_build_object('name', n, 'value', current_setting(n)) ORDER BY o)
               FROM unnest($1::text[]) WITH ORDINALITY AS s(n, o)) AS settings,
            COALESCE(SUM(heap_blks_hit), 0)::text AS heap_hit,
            COALESCE(SUM(heap_blks_read), 0)::text AS heap_read,
            COALESCE(SUM(idx_blks_hit), 0)::text AS idx_hit,
            COALESCE(SUM(idx_blks_read), 0)::text AS idx_read,
            (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset
       FROM pg_statio_user_tables`,
    [[...POSTGRES_SETTINGS]],
    CARD_TIMEOUT_MS,
  );
  const row = r.rows[0];
  return {
    databaseBytes: Number(row.database_bytes),
    settings: row.settings,
    heapHitPct: pct(Number(row.heap_hit), Number(row.heap_read)),
    indexHitPct: pct(Number(row.idx_hit), Number(row.idx_read)),
    statsResetAt: iso(row.stats_reset),
  };
}

export async function diskSpace(path = DISK_PATH): Promise<DiskSpace> {
  const s = await statfs(path);
  return {
    path,
    totalBytes: s.blocks * s.bsize,
    // bavail, not bfree: what a non-root process can actually use.
    freeBytes: s.bavail * s.bsize,
  };
}

/** Every table in the app's schema, largest first. */
export async function tableStats(): Promise<TableStat[]> {
  const r = await queryTimed<{
    name: string;
    reltuples: number;
    table_bytes: string;
    index_bytes: string;
    total_bytes: string;
    heap_hit: string | null;
    heap_read: string | null;
  }>(
    `SELECT c.relname AS name, c.reltuples::float8 AS reltuples,
            pg_table_size(c.oid)::text AS table_bytes,
            pg_indexes_size(c.oid)::text AS index_bytes,
            pg_total_relation_size(c.oid)::text AS total_bytes,
            s.heap_blks_hit::text AS heap_hit, s.heap_blks_read::text AS heap_read
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_statio_user_tables s ON s.relid = c.oid
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY pg_total_relation_size(c.oid) DESC, c.relname`,
    [],
    CARD_TIMEOUT_MS,
  );
  return r.rows.map((t) => ({
    name: t.name,
    // -1 means "never analyzed" (PG14+); that is unknown, not zero.
    rowsEstimate: t.reltuples < 0 ? null : Math.round(t.reltuples),
    tableBytes: Number(t.table_bytes),
    indexBytes: Number(t.index_bytes),
    totalBytes: Number(t.total_bytes),
    heapHitPct: pct(Number(t.heap_hit ?? 0), Number(t.heap_read ?? 0)),
  }));
}

/**
 * Loaded frequency data, counted from `frequency_fetch` by the region-code
 * shape its CHECK constraint enforces (0045): CC = country, CC-S = state or
 * province, CC-S-C = county. Species come from the presence layer the
 * database maintains at write time (0053/0083), never from the ~39 M weekly
 * rows. Enrichment uses the scanner's own coverage count.
 */
export async function coverageSummary(): Promise<CoverageSummary> {
  const [loaded, enrichment] = await Promise.all([
    queryTimed<{
      countries: number;
      states: number;
      counties: number;
      hotspots: number;
      species: number;
    }>(
      `SELECT COUNT(*) FILTER (WHERE loc_kind = 'region' AND loc_code ~ '^[A-Z]{2}$')::int AS countries,
              COUNT(*) FILTER (WHERE loc_kind = 'region' AND loc_code ~ '^[A-Z]{2}-[A-Z0-9]+$')::int AS states,
              COUNT(*) FILTER (WHERE loc_kind = 'region' AND loc_code ~ '^[A-Z]{2}(-[A-Z0-9]+){2}$')::int AS counties,
              COUNT(*) FILTER (WHERE loc_kind = 'hotspot')::int AS hotspots,
              (SELECT COUNT(*)::int FROM (
                 SELECT species_code FROM species_country_membership
                 UNION
                 SELECT unnest(species_codes) FROM species_location_membership
                  WHERE country_code IS NULL) s) AS species
         FROM frequency_fetch`,
      [],
      CARD_TIMEOUT_MS,
    ),
    enrichmentCoverage(CARD_TIMEOUT_MS),
  ]);
  return { ...loaded.rows[0], enrichment };
}

/** The stale rule, apart from the read (pure; tested alone). No record is
 * stale too: prod cannot tell "never backed up" from "not recorded". */
export function backupStatus(
  row: { at: Date | string; bytes: string | number | null } | undefined,
  now: Date,
): BackupStatus {
  const at = row ? iso(row.at) : null;
  return {
    at,
    bytes: row?.bytes == null ? null : Number(row.bytes),
    stale: at == null || now.getTime() - Date.parse(at) > BACKUP_STALE_HOURS * 3600_000,
    staleAfterHours: BACKUP_STALE_HOURS,
  };
}

export async function lastBackup(): Promise<BackupStatus> {
  const r = await queryTimed<{ at: Date; bytes: string | null }>(
    `SELECT at, bytes::text AS bytes FROM ops_markers WHERE name = 'backup'`,
    [],
    CARD_TIMEOUT_MS,
  );
  return backupStatus(r.rows[0], new Date());
}

/** Everything the system cards show, each card independent of the others. */
export async function systemHealth(): Promise<SystemHealth> {
  const [worker, queue, postgres, disk, tables, coverage, backup] = await Promise.all([
    card("worker", async () => adminWorker(await workerHealth(CARD_TIMEOUT_MS))),
    card("queue", jobQueueSummary),
    card("postgres", postgresSummary),
    card("disk", () => diskSpace()),
    card("tables", tableStats),
    card("coverage", coverageSummary),
    card("backup", lastBackup),
  ]);
  return { now: new Date().toISOString(), worker, queue, postgres, disk, tables, coverage, backup };
}
