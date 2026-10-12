/**
 * Official coordinates for downloaded hotspots (td-c2f2b2, plan:
 * docs/2026-10-11-durable-hotspot-coordinates-plan.md, C2-C4).
 *
 *  - lookupOfficialCoordinates: one hotspot-info request for one hotspot —
 *    run at the end of each hotspot load that has no official coordinate
 *    (map pick, refresh, retry: their jobs carry none), and by the repair.
 *  - repairHotspotCoordinates: the bounded `repair_hotspot_coords` job body —
 *    first every downloaded hotspot still without official coordinates:
 *    cached eBird responses (no calls), one hotspot list per region, hotspot
 *    info (capped); then the WORLD CATALOG (td-79261e: every region in the
 *    regions table, each country's full hotspot list, refreshed every 30 days).
 *
 * eBird calls go through a dedicated pacer that keeps the hourly reserve for
 * the rest of the app; a deferral ends the run (the next daily check resumes).
 */
import { query } from "$lib/db";
import {
  EbirdError,
  ebirdFetchOrNull,
  getEbirdApiKey,
  hotspotListUncached,
  hotspotsInRegion,
  type CachedResult,
} from "$server/ebird";
import { EbirdPacer, PaceDeferred } from "$server/ebird-rate";
import { parseOfficialHotspotInfo } from "$server/hotspot-page";
import {
  coordinateGaps,
  DOWNLOADED_HOTSPOT_IDS,
  acceptedCoordinateRows,
  usable,
  coordinatesFromCache,
  needsOfficialCoordinates,
  recordCoordinateMiss,
  upsertLocationCoordinates,
  type CoordinateRow,
} from "$server/hotspot-coordinates";
import { claimFencedQuery, isStaleClaim } from "$server/job-claim";
import {
  reportSchemaDrift,
  UpstreamSchemaError,
  validateEbirdHotspotInfo,
} from "$server/upstream-schema";

/** At most 2 per second after a burst of 4; never into the hourly reserve. */
const coordinatePacer = new EbirdPacer({ ratePerSec: 2, burst: 4 });
const PACE = { preserveHourlyReserve: true, maxBlockMs: 30_000 } as const;
/** Hotspot-info requests per repair run (lists cover the bulk). */
export const REPAIR_INFO_CAP = 200;
const INFO_DEADLINE_MS = 15_000;

export type LookupOutcome = "stored" | "gone" | "not_hotspot";

/** Test seam: the eBird hotspot-info request (raw JSON, null on 404). */
export type InfoFetcher = (locCode: string, apiKey: string) => Promise<unknown | null>;

const defaultInfoFetcher: InfoFetcher = async (locCode, apiKey) => {
  const path = `/ref/hotspot/info/${encodeURIComponent(locCode)}`;
  const raw = await ebirdFetchOrNull<unknown>(path, apiKey, {
    nullOn: [404],
    deadlineMs: INFO_DEADLINE_MS,
  });
  if (raw != null) {
    try {
      validateEbirdHotspotInfo(raw, path);
    } catch (err) { // stale-safe: reports schema drift and rethrows
      reportSchemaDrift(err, `fetch hotspotInfo:${locCode}`);
      throw err;
    }
  }
  return raw;
};

/**
 * One hotspot-info request → official coordinates or a recorded miss. Paced;
 * throws PaceDeferred / EbirdError / StaleClaimError — and a failed write
 * (CODEX1 review P1: "stored" means stored) — for the caller to judge.
 */
export async function lookupOfficialCoordinates(
  locCode: string,
  apiKey: string,
  fetchInfo: InfoFetcher = defaultInfoFetcher,
): Promise<LookupOutcome> {
  await coordinatePacer.acquire(apiKey, undefined, PACE);
  const startedAt = new Date();
  const raw = await fetchInfo(locCode, apiKey);
  if (raw == null) {
    await recordCoordinateMiss(locCode, "gone");
    return "gone";
  }
  const meta = parseOfficialHotspotInfo(raw, locCode);
  if (!meta) {
    await recordCoordinateMiss(locCode, "not_hotspot");
    return "not_hotspot";
  }
  await upsertLocationCoordinates(
    [{ locId: locCode, locName: meta.locName, lat: meta.lat, lng: meta.lng }],
    "official",
    startedAt,
  );
  return "stored";
}

/**
 * The end of one successful hotspot load (C2): fetch official coordinates if
 * the hotspot has none. Never fails the load — a deferral, an eBird error or
 * an ordinary DB error leaves the gap to the daily repair; a lost claim
 * propagates and stops the load.
 */
export async function ensureLoadedHotspotCoordinates(
  userId: number,
  locCode: string,
  fetchInfo?: InfoFetcher,
): Promise<LookupOutcome | "present" | "skipped"> {
  try {
    if (!(await needsOfficialCoordinates(locCode))) return "present";
    const apiKey = await getEbirdApiKey(userId);
    if (!apiKey) return "skipped";
    return await lookupOfficialCoordinates(locCode, apiKey, fetchInfo);
  } catch (err) {
    if (isStaleClaim(err)) throw err;
    if (!(err instanceof PaceDeferred))
      console.warn(
        `[hotspot-coordinates] ${locCode}: official coordinates not fetched:`,
        err instanceof Error ? err.message : err,
      );
    return "skipped";
  }
}

// ---------------------------------------------------------------------------
// World hotspot catalog (td-79261e)
// ---------------------------------------------------------------------------

/** An 'ok' catalog unit is re-fetched after this many days… */
export const CATALOG_REFRESH_DAYS = 30;
/** …a failed one after this many hours. */
export const CATALOG_ERROR_RETRY_HOURS = 24;
/** This many failures in a row means eBird is down: end the run. */
const CATALOG_OUTAGE_RUN = 3;

/**
 * Every catalog unit ($1 = CATALOG_REFRESH_DAYS): each country in the
 * regions table, except a country split in the last $1 days, whose
 * first-level regions stand in for it. An older split is tried whole again.
 */
const CATALOG_UNITS = `
  WITH split AS (
    SELECT region_code FROM hotspot_catalog
     WHERE status = 'split' AND fetched_at > NOW() - make_interval(days => $1)
  ), units AS (
    SELECT r.code, r.level FROM regions r
     WHERE r.level = 'country' AND r.code NOT IN (SELECT region_code FROM split)
    UNION ALL
    SELECT s.code, s.level FROM regions s
     WHERE s.level = 'subnational1' AND s.parent_code IN (SELECT region_code FROM split)
  )`;
const CATALOG_DUE = `
  NOT EXISTS (SELECT 1 FROM hotspot_catalog c
               WHERE c.region_code = u.code
                 AND ((c.status = 'ok' AND c.fetched_at > NOW() - make_interval(days => $1))
                   OR (c.status = 'error' AND c.fetched_at > NOW() - make_interval(hours => $2))))`;

export interface CatalogUnit {
  code: string;
  level: "country" | "subnational1";
}

/** Catalog units due a fetch: never fetched, stale, or failed a day ago. */
export async function catalogUnitsDue(): Promise<CatalogUnit[]> {
  return (
    await query<CatalogUnit>(
      `${CATALOG_UNITS}
       SELECT u.code, u.level FROM units u WHERE ${CATALOG_DUE}
        ORDER BY (SELECT c.fetched_at FROM hotspot_catalog c WHERE c.region_code = u.code) NULLS FIRST, u.code`,
      [CATALOG_REFRESH_DAYS, CATALOG_ERROR_RETRY_HOURS],
    )
  ).rows;
}

/** Is any catalog unit due? (The repair scheduler's cheap check.) */
export async function catalogDue(): Promise<boolean> {
  const r = await query<{ due: boolean }>(
    `${CATALOG_UNITS} SELECT EXISTS (SELECT 1 FROM units u WHERE ${CATALOG_DUE}) AS due`,
    [CATALOG_REFRESH_DAYS, CATALOG_ERROR_RETRY_HOURS],
  );
  return r.rows[0]?.due ?? false;
}

async function hasSubregions(country: string): Promise<boolean> {
  const r = await query<{ any: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM regions WHERE parent_code = $1 AND level = 'subnational1') AS any`,
    [country],
  );
  return r.rows[0]?.any ?? false;
}

/** One catalog unit's outcome; fenced under the repair's claim. */
async function recordCatalogUnit(
  code: string,
  status: "ok" | "split" | "error",
  hotspots: number,
  at: Date,
  error: string | null,
): Promise<void> {
  await claimFencedQuery(
    `INSERT INTO hotspot_catalog (region_code, status, hotspots, fetched_at, error)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (region_code) DO UPDATE
        SET status = EXCLUDED.status, hotspots = EXCLUDED.hotspots,
            fetched_at = EXCLUDED.fetched_at, error = EXCLUDED.error`,
    [code, status, hotspots, at, error ? error.slice(0, 300) : null],
    "hotspot catalog",
  );
}

/**
 * Evidence that eBird could not serve a whole country's list in one response:
 * its deadline (504 — ours or eBird's gateway) or a body that was not whole
 * JSON. A plain 5xx is an outage, not size (CODEX1 review): it is an error,
 * retried after a day. A split is re-tested whole after CATALOG_REFRESH_DAYS.
 */
const tooBigForOneList = (err: unknown) =>
  (err instanceof EbirdError && err.status === 504) || err instanceof SyntaxError;

export interface RepairProgress {
  stage: "catalog" | "cache" | "regions" | "info";
  done: number;
  total: number;
}

export interface RepairResult {
  /** capped: the info cap left gaps; deferred: the hourly reserve was
   * reached; upstream: eBird failed. The scheduler re-runs those three
   * within the hour (CODEX1 review P2-6). */
  outcome: "complete" | "capped" | "stopped" | "deferred" | "upstream";
  /** World catalog: units stored, hotspots in them, countries split, failures. */
  catalogUnits: number;
  catalogHotspots: number;
  catalogSplit: number;
  catalogErrors: number;
  gapsBefore: number;
  fromCache: number;
  regionsFetched: number;
  infoLookups: number;
  misses: number;
  gapsAfter: number;
  error?: string;
}

export interface RepairOptions {
  /** Progress write + cancel check; true = stop now. */
  onProgress?: (p: RepairProgress) => Promise<boolean>;
  fetchInfo?: InfoFetcher;
  /** Test seam: one hotspot list, as hotspotsInRegion returns it. */
  fetchRegion?: (
    apiKey: string,
    regionCode: string,
  ) => Promise<Pick<CachedResult<CoordinateRow[]>, "data" | "fetchedAt" | "stale" | "live" | "refreshErrorStatus">>;
  infoCap?: number;
  /** Test-only: repair only these downloaded hotspots. */
  onlyLocCodes?: readonly string[];
  /** Test seams for the catalog stage (default: the regions table, eBird). */
  catalogUnits?: () => Promise<CatalogUnit[]>;
  fetchCatalog?: (apiKey: string, regionCode: string) => Promise<{ data: CoordinateRow[]; startedAt: Date }>;
  hasSubregions?: (country: string) => Promise<boolean>;
}

/** eBird or its payload failed — not the database, not our code. */
const isUpstream = (err: unknown) => err instanceof EbirdError || err instanceof UpstreamSchemaError;

type Stage = "complete" | "stopped" | "deferred" | "upstream";
type Stop = { stop: Exclude<Stage, "complete">; error?: string };

/**
 * One bounded repair run: the downloaded-hotspot gaps FIRST, then the world
 * catalog (CODEX1 review: a deferred or failing catalog must never hold back
 * the gap repair). A 401/403 throws (the job fails, the next daily check
 * re-selects the credential); other eBird trouble ends the run as 'upstream'
 * with what it already stored kept. A failed database write throws: the run
 * must not report coordinates it did not store.
 */
export async function repairHotspotCoordinates(
  apiKey: string,
  opts: RepairOptions = {},
): Promise<RepairResult> {
  const onProgress = opts.onProgress ?? (async () => false);
  const gaps = () => coordinateGaps(opts.onlyLocCodes);
  const initial = await gaps();
  const result: RepairResult = {
    outcome: "complete",
    catalogUnits: 0,
    catalogHotspots: 0,
    catalogSplit: 0,
    catalogErrors: 0,
    gapsBefore: initial.length,
    fromCache: 0,
    regionsFetched: 0,
    infoLookups: 0,
    misses: 0,
    gapsAfter: initial.length,
  };
  const finish = async (outcome: RepairResult["outcome"], error?: string) => {
    result.outcome = outcome;
    if (error) result.error = error;
    result.gapsAfter = (await gaps()).length;
    return result;
  };

  const gapStop = initial.length > 0 ? await repairGaps(apiKey, opts, onProgress, gaps, result) : null;
  if (gapStop) return finish(gapStop.stop, gapStop.error);
  const catalogStop = await loadCatalog(apiKey, opts, onProgress, result);
  if (catalogStop) return finish(catalogStop.stop, catalogStop.error);
  // Every gap within the info cap is stored or a miss; what is left is the cap's.
  const left = (await gaps()).length;
  return finish(left > 0 ? "capped" : "complete");
}

/** Stages 1–3: downloaded hotspots without official coordinates. */
async function repairGaps(
  apiKey: string,
  opts: RepairOptions,
  onProgress: (p: RepairProgress) => Promise<boolean>,
  gaps: () => ReturnType<typeof coordinateGaps>,
  result: RepairResult,
): Promise<Stop | null> {
  const fetchRegion =
    opts.fetchRegion ??
    ((key: string, region: string) => hotspotsInRegion(key, region, { remember: false }));
  const infoCap = opts.infoCap ?? REPAIR_INFO_CAP;

  // 1. Cached eBird responses — no eBird calls.
  if (await onProgress({ stage: "cache", done: 0, total: 1 })) return { stop: "stopped" };
  result.fromCache = await coordinatesFromCache((await gaps()).map((g) => g.locCode));

  // 2. One hotspot list per region that still has gaps.
  const afterCache = await gaps();
  const regions = [
    ...new Set(afterCache.map((g) => g.regionCode).filter((r): r is string => !!r)),
  ].sort();
  for (let i = 0; i < regions.length; i++) {
    if (await onProgress({ stage: "regions", done: i, total: regions.length })) return { stop: "stopped" };
    let list: Awaited<ReturnType<typeof fetchRegion>>;
    try {
      await coordinatePacer.acquire(apiKey, undefined, PACE);
      list = await fetchRegion(apiKey, regions[i]);
    } catch (err) {
      if (isStaleClaim(err)) throw err;
      if (err instanceof PaceDeferred) return { stop: "deferred" };
      if (err instanceof EbirdError && (err.status === 401 || err.status === 403)) throw err;
      // A region eBird no longer lists: its hotspots fall through to info.
      if (err instanceof EbirdError && err.status === 404) continue;
      if (isUpstream(err)) return { stop: "upstream", error: err instanceof Error ? err.message : String(err) };
      throw err;
    }
    // A failed refresh served from an old cached copy (CODEX1 review P2-4):
    // that copy was already read in stage 1; the failure decides the run.
    if (list.stale) {
      const status = list.refreshErrorStatus;
      if (status === 401 || status === 403)
        throw new EbirdError("eBird API key is missing or invalid — check Settings.", status);
      if (status === 429) return { stop: "deferred" };
      if (status === 404) continue;
      return {
        stop: "upstream",
        error: `eBird hotspot list for ${regions[i]} could not be refreshed (${status ?? "error"}).`,
      };
    }
    await upsertLocationCoordinates(list.data, "official", list.live?.startedAt ?? list.fetchedAt);
    result.regionsFetched++;
  }

  // 3. Hotspot info for whatever is still missing (renamed, merged, hidden).
  const remaining = (await gaps()).slice(0, infoCap);
  for (let i = 0; i < remaining.length; i++) {
    if (await onProgress({ stage: "info", done: i, total: remaining.length })) return { stop: "stopped" };
    try {
      const outcome = await lookupOfficialCoordinates(remaining[i].locCode, apiKey, opts.fetchInfo);
      result.infoLookups++;
      if (outcome !== "stored") result.misses++;
    } catch (err) {
      if (isStaleClaim(err)) throw err;
      if (err instanceof PaceDeferred) return { stop: "deferred" };
      if (err instanceof EbirdError && (err.status === 401 || err.status === 403)) throw err;
      if (isUpstream(err)) return { stop: "upstream", error: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }
  return null;
}

/**
 * Stage 4: the world catalog — every due unit's full hotspot list. A second
 * pass picks up the first-level regions of a country split in the first.
 */
async function loadCatalog(
  apiKey: string,
  opts: RepairOptions,
  onProgress: (p: RepairProgress) => Promise<boolean>,
  result: RepairResult,
): Promise<Stop | null> {
  const listUnits = opts.catalogUnits ?? catalogUnitsDue;
  const fetchCatalog = opts.fetchCatalog ?? hotspotListUncached;
  const splittable = opts.hasSubregions ?? hasSubregions;
  let failuresInARow = 0;
  for (let pass = 0; pass < 2; pass++) {
    const units = await listUnits();
    const splitBefore = result.catalogSplit;
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (await onProgress({ stage: "catalog", done: i, total: units.length })) return { stop: "stopped" };
      let list: { data: CoordinateRow[]; startedAt: Date };
      try {
        await coordinatePacer.acquire(apiKey, undefined, PACE);
        list = await fetchCatalog(apiKey, unit.code);
      } catch (err) {
        if (isStaleClaim(err)) throw err;
        if (err instanceof PaceDeferred) return { stop: "deferred" };
        if (err instanceof EbirdError && (err.status === 401 || err.status === 403)) throw err;
        if (err instanceof EbirdError && err.status === 429) return { stop: "deferred" };
        // eBird has no list for this region: nothing to store until the refresh.
        if (err instanceof EbirdError && err.status === 404) {
          await recordCatalogUnit(unit.code, "ok", 0, new Date(), null);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (unit.level === "country" && tooBigForOneList(err) && (await splittable(unit.code))) {
          await recordCatalogUnit(unit.code, "split", 0, new Date(), null);
          result.catalogSplit++;
          // A provider that stalls every request looks like a run of splits.
          if (++failuresInARow >= CATALOG_OUTAGE_RUN) return { stop: "upstream", error: message };
          continue;
        }
        if (isUpstream(err) || err instanceof SyntaxError) {
          await recordCatalogUnit(unit.code, "error", 0, new Date(), message);
          result.catalogErrors++;
          if (++failuresInARow >= CATALOG_OUTAGE_RUN) return { stop: "upstream", error: message };
          continue;
        }
        throw err;
      }
      failuresInARow = 0;
      const accepted = acceptedCoordinateRows(list.data, "official");
      await upsertLocationCoordinates(accepted, "official", list.startedAt);
      // A repeated id is stored once, not "unusable" (CODEX1 re-review).
      const rejected = list.data.filter((r) => !usable(r, "official")).length;
      // Rows eBird listed that cannot be stored (CODEX1 review): kept visible
      // and retried after a day instead of a clean 30-day 'ok'.
      if (rejected > 0) {
        await recordCatalogUnit(
          unit.code,
          "error",
          accepted.length,
          list.startedAt,
          `${rejected} of ${list.data.length} listed hotspots had an unusable id, name or coordinates.`,
        );
        result.catalogErrors++;
      } else {
        await recordCatalogUnit(unit.code, "ok", accepted.length, list.startedAt, null);
      }
      result.catalogUnits++;
      result.catalogHotspots += accepted.length;
    }
    if (result.catalogSplit === splitBefore) break;
  }
  return null;
}

/**
 * The account whose eBird key the repair uses: the first admin (by id) with
 * a stored key that decrypts to something usable. Never put in a payload.
 */
export async function repairCredentialUser(): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT u.id FROM users u JOIN user_ebird ue ON ue.user_id = u.id
      WHERE u.role = 'admin' AND ue.api_key_enc IS NOT NULL
      ORDER BY u.id`,
  );
  for (const { id } of r.rows) {
    try {
      const key = await getEbirdApiKey(id);
      if (key && key.trim()) return id;
    } catch { // stale-safe: a key read, no fenced write inside
      // An undecryptable key is not usable; try the next admin.
    }
  }
  return null;
}

/** The Admin miss list shows this many; the total is always shown. */
export const STATUS_MISS_LIMIT = 100;

export interface CoordinateStatus {
  downloaded: number;
  /** Downloaded hotspots without OFFICIAL eBird coordinates (misses included). */
  missing: number;
  /** Of those, how many have no coordinates at all — the map searches can't place them. */
  noCoordinates: number;
  missesTotal: number;
  /** The first STATUS_MISS_LIMIT misses by name. */
  misses: Array<{ locCode: string; locName: string | null; reason: string; checkedAt: string }>;
  lastRepair: {
    status: string;
    finishedAt: string | null;
    outcome: string | null;
  } | null;
  repairQueued: boolean;
  hasCredential: boolean;
  /** td-79261e: the world catalog's progress. */
  catalog: {
    units: number;
    loaded: number;
    errors: number;
    split: number;
    /** Hotspots in the loaded units' last lists. */
    hotspots: number;
    oldestLoadedAt: string | null;
  };
  /** Every hotspot with official coordinates stored (downloaded or not). */
  officialStored: number;
}

/** Admin's integrity line (C4). */
export async function hotspotCoordinateStatus(): Promise<CoordinateStatus> {
  const [counts, misses, last, queued, credential, catalog, official] = await Promise.all([
    query<{ downloaded: number; missing: number; no_coordinates: number; misses: number }>(
      `SELECT count(*)::int AS downloaded,
              count(*) FILTER (WHERE e.coord_source IS DISTINCT FROM 'official')::int AS missing,
              count(*) FILTER (WHERE e.loc_id IS NULL)::int AS no_coordinates,
              (SELECT count(*)::int FROM hotspot_coord_misses) AS misses
         FROM frequency_fetch f
         LEFT JOIN (SELECT loc_id, coord_source FROM ebird_locations
                     WHERE loc_id = ANY (${DOWNLOADED_HOTSPOT_IDS})) e ON e.loc_id = f.loc_code
        WHERE f.loc_kind = 'hotspot'`,
    ),
    query<{ locCode: string; locName: string | null; reason: string; checkedAt: Date }>(
      `SELECT m.loc_code AS "locCode", f.loc_name AS "locName", m.reason,
              m.checked_at AS "checkedAt"
         FROM hotspot_coord_misses m JOIN frequency_fetch f ON f.loc_code = m.loc_code
        ORDER BY f.loc_name, m.loc_code LIMIT $1`,
      [STATUS_MISS_LIMIT],
    ),
    query<{ status: string; finished_at: Date | null; outcome: string | null }>(
      `SELECT status, finished_at, result ->> 'outcome' AS outcome
         FROM jobs WHERE type = 'repair_hotspot_coords' AND finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1`,
    ),
    query<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs
        WHERE type = 'repair_hotspot_coords' AND status IN ('pending', 'running')`,
    ),
    repairCredentialUser(),
    query<{ units: number; loaded: number; errors: number; split: number; hotspots: number; oldest: Date | null }>(
      `${CATALOG_UNITS}
       SELECT count(*)::int AS units,
              count(*) FILTER (WHERE c.status = 'ok')::int AS loaded,
              count(*) FILTER (WHERE c.status = 'error')::int AS errors,
              (SELECT count(*)::int FROM split) AS split,
              coalesce(sum(c.hotspots) FILTER (WHERE c.status = 'ok'), 0)::int AS hotspots,
              min(c.fetched_at) FILTER (WHERE c.status = 'ok') AS oldest
         FROM units u LEFT JOIN hotspot_catalog c ON c.region_code = u.code`,
      [CATALOG_REFRESH_DAYS],
    ),
    query<{ n: number }>(`SELECT count(*)::int AS n FROM ebird_locations WHERE coord_source = 'official'`),
  ]);
  const cat = catalog.rows[0];
  const lastRow = last.rows[0];
  return {
    downloaded: counts.rows[0]?.downloaded ?? 0,
    missing: counts.rows[0]?.missing ?? 0,
    noCoordinates: counts.rows[0]?.no_coordinates ?? 0,
    missesTotal: counts.rows[0]?.misses ?? 0,
    misses: misses.rows.map((m) => ({ ...m, checkedAt: new Date(m.checkedAt).toISOString() })),
    lastRepair: lastRow
      ? {
          status: lastRow.status,
          finishedAt: lastRow.finished_at ? new Date(lastRow.finished_at).toISOString() : null,
          outcome: lastRow.outcome,
        }
      : null,
    repairQueued: (queued.rows[0]?.n ?? 0) > 0,
    hasCredential: credential != null,
    catalog: {
      units: cat?.units ?? 0,
      loaded: cat?.loaded ?? 0,
      errors: cat?.errors ?? 0,
      split: cat?.split ?? 0,
      hotspots: cat?.hotspots ?? 0,
      oldestLoadedAt: cat?.oldest ? new Date(cat.oldest).toISOString() : null,
    },
    officialStored: official.rows[0]?.n ?? 0,
  };
}
