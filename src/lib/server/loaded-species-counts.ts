import type pg from "pg";
import { query, withReadSnapshot } from "$lib/db";
import { GEOGRAPHIC_AREAS } from "$lib/geographic-areas";
import { claimFencedQuery, isStaleClaim } from "$server/job-claim";
import {
  dedupKeys,
  FREQUENCY_JOB_TYPES,
  sanitizeErrorText,
} from "$server/job-policy";

/**
 * Hotspots & data species totals (td-de2150). A page load used to start the
 * database-wide aggregate below (plus a revision hash) itself; every finished
 * load changed the revision, so copies piled up and the page sat on
 * "Counting species…". Now ONE worker job (refresh_species_counts) builds the
 * exact counts and publishes them to `species_count_snapshot`; the page reads
 * that one row and never computes the hash or the aggregate.
 */
export interface SpeciesCounts {
  areas: Record<string, number>;
  regions: Record<string, number>;
  world: number;
}

type Run = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<pg.QueryResult<T>>;

/** Distinct recorded species, not a sum of overlapping location totals.
 * Monthly rollups retain all seasons without scanning the weekly source.
 * Return only counts to the browser; no species lists or hotspot detail. */
export async function aggregateSpeciesCounts(
  run: Run = query,
): Promise<SpeciesCounts> {
  // Region/species codes are identifiers: bytewise collation avoids expensive
  // locale comparisons in the worldwide DISTINCT, without changing membership.
  const areaByCountry = Object.fromEntries(
    GEOGRAPHIC_AREAS.flatMap((area) =>
      area.countryCodes.map((code) => [code, area.id]),
    ),
  );
  const { rows } = await run<{
    kind: "area" | "region" | "world";
    code: string;
    species_count: number;
  }>(
    `WITH locations AS (
       SELECT loc_code,
         CASE WHEN loc_kind = 'region' THEN loc_code ELSE region_code END COLLATE "C" AS geo
       FROM frequency_fetch
     ), presence AS (
       SELECT DISTINCT split_part(l.geo, '-', 1) AS country,
         CASE WHEN strpos(l.geo, '-') > 0
           THEN split_part(l.geo, '-', 1) || '-' || split_part(l.geo, '-', 2)
         END AS region,
         m.species_code COLLATE "C" AS species_code
       FROM locations l
       LEFT JOIN (species_month_freq m
         JOIN taxonomy_cache t ON t.species_code = m.species_code AND t.category = 'species')
         ON m.loc_code = l.loc_code AND m.num > 0
     ), grouped AS (
       SELECT p.*, CASE WHEN country IS NOT NULL THEN COALESCE(a.value, 'other') END COLLATE "C" AS area
       FROM presence p
       LEFT JOIN jsonb_each_text($1::jsonb) a ON a.key = p.country
     )
     SELECT CASE WHEN GROUPING(area, country, region) = 7 THEN 'world'
            WHEN GROUPING(area) = 0 THEN 'area' ELSE 'region' END AS kind,
       CASE WHEN GROUPING(area, country, region) = 7 THEN 'world'
            WHEN GROUPING(area) = 0 THEN area
            WHEN GROUPING(country) = 0 THEN country ELSE region END AS code,
       COUNT(DISTINCT species_code)::int AS species_count
     FROM grouped
     GROUP BY GROUPING SETS ((), (area), (country), (region))
     HAVING GROUPING(area, country, region) = 7
       OR (GROUPING(area) = 0 AND area IS NOT NULL)
       OR (GROUPING(country) = 0 AND country IS NOT NULL)
       OR (GROUPING(region) = 0 AND region IS NOT NULL)`,
    [JSON.stringify(areaByCountry)],
  );
  const areas: Record<string, number> = {};
  const regions: Record<string, number> = {};
  for (const row of rows) {
    if (row.kind === "world") continue;
    (row.kind === "area" ? areas : regions)[row.code] = row.species_count;
  }
  // The grand-total grouping also returns zero for an empty inventory. Keep
  // unassigned hotspots in that total without inventing a country for them.
  const world = rows.find((row) => row.kind === "world");
  if (!world) throw new Error("Missing worldwide species aggregate");
  return { areas, regions, world: world.species_count };
}

/**
 * What the counts depend on. Frequency writes replace their rollups and
 * update frequency_fetch in one transaction. Include every row (not just
 * MAX(fetched_at)) so deletions and geography repairs also count as changes.
 * Taxonomy edits can change species status. ~44 ms on the production-sized
 * test snapshot; computed by the worker only, never by a page load.
 */
const REVISION_SQL = `concat(
       (SELECT md5(string_agg(concat_ws(':', loc_code, loc_kind, region_code,
         fetched_at, n_species), ',' ORDER BY loc_code COLLATE "C")) FROM frequency_fetch),
       '/',
       (SELECT md5(string_agg(concat_ws(':', species_code, category), ','
         ORDER BY species_code COLLATE "C")) FROM taxonomy_cache)
     )`;

// ── cadence (CC1 review decision 4) ─────────────────────────────────────────

/** Published counts are current: look again this much later. */
export const SPECIES_COUNT_CHECK_MS = 10 * 60_000;
/** Build once the newest frequency write is at least this old… */
export const SPECIES_COUNT_QUIET_MS = 5 * 60_000;
/** …or once the published counts are this old, so loading never defers forever. */
export const SPECIES_COUNT_MAX_AGE_MS = 60 * 60_000;
/** A deferred refresh looks again within these bounds. */
export const SPECIES_COUNT_DEFER_MIN_MS = 30_000;
export const SPECIES_COUNT_DEFER_MAX_MS = 5 * 60_000;
/** Failed builds back off 5, 10, 20, 40, then every 60 minutes. */
export const SPECIES_COUNT_FAILURE_BASE_MS = 5 * 60_000;
export const SPECIES_COUNT_FAILURE_MAX_MS = 60 * 60_000;
/** A lost or missing chain (and a fresh deploy) runs soon. */
export const SPECIES_COUNT_ENSURE_DELAY_MS = 10_000;
/** One build's database limits: one copy ≈ 5 s on the M4, ≈ 30 s on the droplet. */
export const SPECIES_COUNT_STATEMENT_TIMEOUT = "10min";
export const SPECIES_COUNT_WORK_MEM = "64MB";

export interface RefreshState {
  nowMs: number;
  /** Newest frequency_fetch write; null for an empty inventory. */
  newestWriteMs: number | null;
  revision: string;
  /** A frequency load is waiting to run: user loads go first (until max age). */
  loadsQueued: boolean;
  /** The published counts' revision and build time; null before the first success. */
  published: { revision: string; builtAtMs: number } | null;
}

export type RefreshDecision =
  | { action: "unchanged"; delayMs: number }
  | { action: "build"; reason: "first" | "quiet" | "max_age" }
  | { action: "defer"; delayMs: number };

/** Pure: what one refresh run should do with the state it read. */
export function refreshDecision(s: RefreshState): RefreshDecision {
  if (!s.published) return { action: "build", reason: "first" };
  if (s.published.revision === s.revision) {
    return { action: "unchanged", delayMs: SPECIES_COUNT_CHECK_MS };
  }
  const age = s.nowMs - s.published.builtAtMs;
  if (age >= SPECIES_COUNT_MAX_AGE_MS)
    return { action: "build", reason: "max_age" };
  const quietFor =
    s.newestWriteMs == null ? Infinity : s.nowMs - s.newestWriteMs;
  if (quietFor >= SPECIES_COUNT_QUIET_MS && !s.loadsQueued) {
    return { action: "build", reason: "quiet" };
  }
  // Look again when the quiet period would end (or, with loads queued, after
  // the longest deferral), never past the max age.
  const untilQuiet =
    quietFor >= SPECIES_COUNT_QUIET_MS
      ? SPECIES_COUNT_DEFER_MAX_MS
      : SPECIES_COUNT_QUIET_MS - quietFor;
  const delayMs = Math.min(
    SPECIES_COUNT_DEFER_MAX_MS,
    Math.max(
      SPECIES_COUNT_DEFER_MIN_MS,
      Math.min(untilQuiet, SPECIES_COUNT_MAX_AGE_MS - age),
    ),
  );
  return { action: "defer", delayMs };
}

/** Bounded exponential backoff after `failures` consecutive failed builds (≥ 1). */
export function failureBackoffMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(
    SPECIES_COUNT_FAILURE_MAX_MS,
    SPECIES_COUNT_FAILURE_BASE_MS * 2 ** Math.min(n - 1, 10),
  );
}

interface StateRow {
  now: Date;
  newest_write: Date | null;
  revision: string;
  loads_queued: boolean;
  source_revision: string | null;
  built_at: Date | null;
  consecutive_failures: number | null;
  source_changed_at: Date | null;
}

async function readRefreshState(): Promise<{
  state: RefreshState;
  sourceChangedNoted: boolean;
  failures: number;
}> {
  const { rows } = await query<StateRow>(
    `SELECT now() AS now,
       (SELECT max(fetched_at) FROM frequency_fetch) AS newest_write,
       ${REVISION_SQL} AS revision,
       EXISTS (SELECT 1 FROM jobs
                WHERE type = ANY($1::text[]) AND status = 'pending' AND NOT cancel_requested
                  AND (next_retry_at IS NULL OR next_retry_at <= now())) AS loads_queued,
       s.source_revision, s.built_at, s.consecutive_failures, s.source_changed_at
     FROM (SELECT 1) one
     LEFT JOIN species_count_snapshot s ON s.id = 1`,
    [[...FREQUENCY_JOB_TYPES]],
  );
  const r = rows[0];
  const ms = (d: Date | null) => (d == null ? null : new Date(d).getTime());
  return {
    state: {
      nowMs: ms(r.now)!,
      newestWriteMs: ms(r.newest_write),
      revision: r.revision,
      loadsQueued: r.loads_queued,
      published:
        r.source_revision != null && r.built_at != null
          ? { revision: r.source_revision, builtAtMs: ms(r.built_at)! }
          : null,
    },
    sourceChangedNoted: r.source_changed_at != null,
    failures: r.consecutive_failures ?? 0,
  };
}

export interface SpeciesCountBuild {
  counts: SpeciesCounts;
  revision: string;
  /** When the build's read snapshot was taken (ISO). */
  builtAt: string;
  buildMs: number;
}

/**
 * Build: the revision and the aggregate from ONE read snapshot (REPEATABLE
 * READ, READ ONLY), so the published revision names exactly the data counted.
 * Deliberately NOT inside withClaimTx: fenced transactions are capped at
 * 120 s (td-b99b6d) and this may take minutes on the droplet. It writes
 * nothing, so it needs no fence; publishing is the fenced step.
 */
export async function buildSpeciesCountSnapshot(): Promise<SpeciesCountBuild> {
  const started = performance.now();
  const built = await withReadSnapshot(async (client) => {
    await client.query(
      `SET LOCAL statement_timeout = '${SPECIES_COUNT_STATEMENT_TIMEOUT}'`,
    );
    await client.query(`SET LOCAL work_mem = '${SPECIES_COUNT_WORK_MEM}'`);
    // clock_timestamp() inside the snapshot's first statement is no earlier
    // than the snapshot: a write stamped later (fetched_at = its NOW()) cannot
    // be in these counts, which is what the page's "newer data" check relies on.
    const head = await client.query<{ built_at: Date; revision: string }>(
      `SELECT clock_timestamp() AS built_at, ${REVISION_SQL} AS revision`,
    );
    const counts = await aggregateSpeciesCounts((text, params) =>
      client.query(text, params as never[]),
    );
    return {
      counts,
      revision: head.rows[0].revision,
      builtAt: new Date(head.rows[0].built_at),
    };
  });
  return {
    counts: built.counts,
    revision: built.revision,
    builtAt: built.builtAt.toISOString(),
    buildMs: Math.round(performance.now() - started),
  };
}

/**
 * Publish one build atomically, fenced to the job's live claim (a stale
 * execution writes nothing). Never replaces a newer build.
 *
 * The same statement recomputes the CURRENT source revision (the cheap hash)
 * and compares it with the build's (CODEX1 P2): a frequency load whose
 * transaction began before the build's snapshot stamps fetched_at with its
 * own start time, so if it commits during the build the page's
 * `fetched_at > built_at` probe cannot see it, and neither can it see a
 * taxonomy-only change. When the revisions differ the newer counts are still
 * published (they beat the old ones) but `source_changed_at` is kept or set,
 * so the page says "Updating…" and the job comes back soon.
 *
 * `current`: the published counts match the source as of this publish.
 */
export async function publishSpeciesCountSnapshot(
  build: SpeciesCountBuild,
): Promise<{ written: boolean; current: boolean }> {
  const r = await claimFencedQuery<{ current: boolean }>(
    `WITH src AS (SELECT ${REVISION_SQL} = $2 AS current)
     INSERT INTO species_count_snapshot
       (id, counts, source_revision, built_at, build_ms, last_attempt_at, last_error,
        consecutive_failures, source_changed_at)
     SELECT 1, $1::jsonb, $2, $3, $4, now(), NULL, 0,
            CASE WHEN src.current THEN NULL ELSE now() END
       FROM src
     ON CONFLICT (id) DO UPDATE SET
       counts = EXCLUDED.counts, source_revision = EXCLUDED.source_revision,
       built_at = EXCLUDED.built_at, build_ms = EXCLUDED.build_ms,
       last_attempt_at = EXCLUDED.last_attempt_at, last_error = NULL,
       consecutive_failures = 0,
       source_changed_at = CASE WHEN EXCLUDED.source_changed_at IS NULL THEN NULL
         ELSE COALESCE(species_count_snapshot.source_changed_at, EXCLUDED.source_changed_at) END
     WHERE species_count_snapshot.built_at IS NULL
        OR species_count_snapshot.built_at <= EXCLUDED.built_at
     RETURNING (source_changed_at IS NULL) AS current`,
    [
      JSON.stringify(build.counts),
      build.revision,
      build.builtAt,
      build.buildMs,
    ],
    "species count publish",
  );
  const row = r.rows[0];
  return { written: row != null, current: row?.current === true };
}

/** Newer source data than the published counts: the page says "Updating…". */
async function noteSourceChanged(): Promise<void> {
  await claimFencedQuery(
    `INSERT INTO species_count_snapshot (id, source_changed_at) VALUES (1, now())
     ON CONFLICT (id) DO UPDATE
       SET source_changed_at = COALESCE(species_count_snapshot.source_changed_at, now())`,
    [],
    "species count source changed",
  );
}

/** The published counts match the source again: clear the change and failure flags. */
async function noteCurrent(): Promise<void> {
  await claimFencedQuery(
    `UPDATE species_count_snapshot SET source_changed_at = NULL, consecutive_failures = 0
      WHERE id = 1 AND (source_changed_at IS NOT NULL OR consecutive_failures > 0)`,
    [],
    "species count current",
  );
}

/** Record a failed build; the last good counts stay published. Returns the failure streak. */
async function recordFailure(message: string): Promise<number> {
  const r = await claimFencedQuery<{ consecutive_failures: number }>(
    `INSERT INTO species_count_snapshot (id, last_attempt_at, last_error, consecutive_failures)
     VALUES (1, now(), $1, 1)
     ON CONFLICT (id) DO UPDATE SET
       last_attempt_at = now(), last_error = $1,
       consecutive_failures = species_count_snapshot.consecutive_failures + 1
     RETURNING consecutive_failures`,
    [message],
    "species count failure",
  );
  return r.rows[0].consecutive_failures;
}

export type RefreshOutcome =
  | { outcome: "unchanged"; revision: string; delayMs: number }
  | {
      outcome: "deferred";
      revision: string;
      delayMs: number;
      loadsQueued: boolean;
    }
  | {
      outcome: "published";
      reason: "first" | "quiet" | "max_age";
      revision: string;
      builtAt: string;
      buildMs: number;
      /** false: the source changed during the build; a rebuild follows soon. */
      current: boolean;
      delayMs: number;
    }
  | {
      outcome: "failed";
      error: string;
      consecutiveFailures: number;
      delayMs: number;
    };

/**
 * One worker refresh: read the state (revision hash ≈ 44 ms), decide, and
 * build + publish only when the source changed and is quiet (or the counts
 * are too old). A source change committed during the build leaves the
 * published revision behind the next run's hash, so that run rebuilds; old
 * counts are never labelled current. Every write is fenced to the claim.
 */
export async function refreshSpeciesCountSnapshot(): Promise<RefreshOutcome> {
  const { state, sourceChangedNoted, failures } = await readRefreshState();
  const decision = refreshDecision(state);
  if (decision.action === "unchanged") {
    if (sourceChangedNoted || failures > 0) await noteCurrent();
    return {
      outcome: "unchanged",
      revision: state.revision,
      delayMs: decision.delayMs,
    };
  }
  if (!sourceChangedNoted) await noteSourceChanged();
  if (decision.action === "defer") {
    return {
      outcome: "deferred",
      revision: state.revision,
      delayMs: decision.delayMs,
      loadsQueued: state.loadsQueued,
    };
  }
  let build: SpeciesCountBuild;
  let current: boolean;
  try {
    build = await buildSpeciesCountSnapshot();
    ({ current } = await publishSpeciesCountSnapshot(build));
  } catch (err) {
    if (isStaleClaim(err)) throw err;
    const message = sanitizeErrorText(
      err instanceof Error ? err.message : String(err),
    ).slice(0, 300);
    const streak = await recordFailure(message);
    return {
      outcome: "failed",
      error: message,
      consecutiveFailures: streak,
      delayMs: failureBackoffMs(streak),
    };
  }
  return {
    outcome: "published",
    reason: decision.reason,
    revision: build.revision,
    builtAt: build.builtAt,
    buildMs: build.buildMs,
    current,
    // Changed during the build: come back after one quiet period, where the
    // usual rules apply (rebuild if quiet or too old, else defer) — not the
    // 10-minute unchanged cadence.
    delayMs: current ? SPECIES_COUNT_CHECK_MS : SPECIES_COUNT_QUIET_MS,
  };
}

// ── page read ───────────────────────────────────────────────────────────────

export interface SpeciesCountSnapshotView {
  /** null: no build has succeeded yet ("Counts being prepared"). */
  counts: SpeciesCounts | null;
  builtAt: string | null;
  /** The latest refresh attempt failed; `counts` are the last good ones. */
  failing: boolean;
  /** Newer source data than `counts` exists (worker-noted, or a load since the build). */
  sourceChanged: boolean;
  /** The refresh job is queued or running. */
  refreshActive: boolean;
  /** Server time of this read, so relative wording renders identically on both sides. */
  readAt: string;
}

function isCountMap(v: unknown): v is Record<string, number> {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v).every(
      (n) => typeof n === "number" && Number.isInteger(n) && n >= 0,
    )
  );
}

/** JSONB arrives as an object; accept only the shape the worker publishes. */
export function parseSpeciesCounts(raw: unknown): SpeciesCounts | null {
  const v = raw as Partial<SpeciesCounts> | null;
  if (!v || typeof v !== "object" || typeof v.world !== "number") return null;
  if (!isCountMap(v.areas) || !isCountMap(v.regions)) return null;
  return { areas: v.areas, regions: v.regions, world: v.world };
}

/**
 * The page's ONE small read: the published row, a cheap "loaded since the
 * build" probe, and whether the refresh job is queued or running. Never the
 * revision hash, never the aggregate, never an enqueue.
 */
export async function readSpeciesCountSnapshot(): Promise<SpeciesCountSnapshotView> {
  const { rows } = await query<{
    read_at: Date;
    counts: unknown;
    built_at: Date | null;
    consecutive_failures: number | null;
    source_changed: boolean;
    refresh_active: boolean;
  }>(
    `SELECT now() AS read_at, s.counts, s.built_at, s.consecutive_failures,
       (s.source_changed_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM frequency_fetch f WHERE f.fetched_at > s.built_at)) AS source_changed,
       EXISTS (SELECT 1 FROM jobs WHERE dedup_key = $1 AND status IN ('pending', 'running')) AS refresh_active
     FROM (SELECT 1) one
     LEFT JOIN species_count_snapshot s ON s.id = 1`,
    [dedupKeys.refreshSpeciesCounts()],
  );
  const r = rows[0];
  const counts = r.counts == null ? null : parseSpeciesCounts(r.counts);
  if (r.counts != null && !counts)
    console.error("[species-counts] malformed published snapshot ignored");
  return {
    counts,
    builtAt: counts && r.built_at ? new Date(r.built_at).toISOString() : null,
    failing: (r.consecutive_failures ?? 0) > 0,
    sourceChanged: r.source_changed === true,
    refreshActive: r.refresh_active === true,
    readAt: new Date(r.read_at).toISOString(),
  };
}
