/**
 * Official coordinates for downloaded hotspots (td-c2f2b2, plan:
 * docs/2026-10-11-durable-hotspot-coordinates-plan.md, C2-C4).
 *
 *  - lookupOfficialCoordinates: one hotspot-info request for one hotspot —
 *    run at the end of each hotspot load that has no official coordinate
 *    (map pick, refresh, retry: their jobs carry none), and by the repair.
 *  - repairHotspotCoordinates: the bounded `repair_hotspot_coords` job body —
 *    cached eBird responses first (no calls), then one hotspot list per
 *    region, then hotspot info for what is left (capped).
 *
 * eBird calls go through a dedicated pacer that keeps the hourly reserve for
 * the rest of the app; a deferral ends the run (the next daily check resumes).
 */
import { query } from "$lib/db";
import { EbirdError, ebirdFetchOrNull, getEbirdApiKey, hotspotsInRegion } from "$server/ebird";
import { EbirdPacer, PaceDeferred } from "$server/ebird-rate";
import { parseOfficialHotspotInfo } from "$server/hotspot-page";
import {
  coordinateGaps,
  coordinatesFromCache,
  needsOfficialCoordinates,
  recordCoordinateMiss,
  rememberOfficialHotspots,
} from "$server/hotspot-coordinates";
import { isStaleClaim } from "$server/job-claim";
import { reportSchemaDrift, validateEbirdHotspotInfo } from "$server/upstream-schema";

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
 * throws PaceDeferred / EbirdError / StaleClaimError for the caller to judge.
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
  await rememberOfficialHotspots(
    [{ locId: locCode, locName: meta.locName, lat: meta.lat, lng: meta.lng }],
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

export interface RepairProgress {
  stage: "cache" | "regions" | "info";
  done: number;
  total: number;
}

export interface RepairResult {
  outcome: "complete" | "stopped" | "deferred" | "upstream";
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
  /** Test seam: one hotspot list (stores its coordinates as it arrives). */
  fetchRegion?: (apiKey: string, regionCode: string) => Promise<unknown>;
  infoCap?: number;
  /** Test-only: repair only these downloaded hotspots. */
  onlyLocCodes?: readonly string[];
}

/**
 * One bounded repair run. A 401/403 throws (the job fails, the next daily
 * check re-selects the credential); other eBird trouble ends the run as
 * 'upstream' with what it already stored kept.
 */
export async function repairHotspotCoordinates(
  apiKey: string,
  opts: RepairOptions = {},
): Promise<RepairResult> {
  const onProgress = opts.onProgress ?? (async () => false);
  const fetchRegion =
    opts.fetchRegion ?? ((key: string, region: string) => hotspotsInRegion(key, region));
  const infoCap = opts.infoCap ?? REPAIR_INFO_CAP;
  const gaps = () => coordinateGaps(opts.onlyLocCodes);
  const initial = await gaps();
  const result: RepairResult = {
    outcome: "complete",
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
  if (initial.length === 0) return result;

  // 1. Cached eBird responses — no eBird calls.
  if (await onProgress({ stage: "cache", done: 0, total: 1 })) return finish("stopped");
  result.fromCache = await coordinatesFromCache(initial.map((g) => g.locCode));

  // 2. One hotspot list per region that still has gaps.
  const afterCache = await gaps();
  const regions = [
    ...new Set(afterCache.map((g) => g.regionCode).filter((r): r is string => !!r)),
  ].sort();
  for (let i = 0; i < regions.length; i++) {
    if (await onProgress({ stage: "regions", done: i, total: regions.length }))
      return finish("stopped");
    try {
      await coordinatePacer.acquire(apiKey, undefined, PACE);
      await fetchRegion(apiKey, regions[i]);
      result.regionsFetched++;
    } catch (err) {
      if (isStaleClaim(err)) throw err;
      if (err instanceof PaceDeferred) return finish("deferred");
      if (err instanceof EbirdError && (err.status === 401 || err.status === 403)) throw err;
      // A region eBird no longer lists: its hotspots fall through to info.
      if (err instanceof EbirdError && err.status === 404) continue;
      return finish("upstream", err instanceof Error ? err.message : String(err));
    }
  }

  // 3. Hotspot info for whatever is still missing (renamed, merged, hidden).
  const remaining = (await gaps()).slice(0, infoCap);
  for (let i = 0; i < remaining.length; i++) {
    if (await onProgress({ stage: "info", done: i, total: remaining.length }))
      return finish("stopped");
    try {
      const outcome = await lookupOfficialCoordinates(remaining[i].locCode, apiKey, opts.fetchInfo);
      result.infoLookups++;
      if (outcome !== "stored") result.misses++;
    } catch (err) {
      if (isStaleClaim(err)) throw err;
      if (err instanceof PaceDeferred) return finish("deferred");
      if (err instanceof EbirdError && (err.status === 401 || err.status === 403)) throw err;
      return finish("upstream", err instanceof Error ? err.message : String(err));
    }
  }
  return finish("complete");
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

export interface CoordinateStatus {
  /** Downloaded hotspots without official coordinates (misses included). */
  missing: number;
  downloaded: number;
  misses: Array<{ locCode: string; locName: string | null; reason: string; checkedAt: string }>;
  lastRepair: {
    status: string;
    finishedAt: string | null;
    outcome: string | null;
  } | null;
  repairQueued: boolean;
  hasCredential: boolean;
}

/** Admin's integrity line (C4). */
export async function hotspotCoordinateStatus(): Promise<CoordinateStatus> {
  const [counts, misses, last, queued, credential] = await Promise.all([
    query<{ downloaded: number; missing: number }>(
      `SELECT count(*)::int AS downloaded,
              count(*) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM ebird_locations e
                 WHERE e.loc_id = f.loc_code AND e.coord_source = 'official'))::int AS missing
         FROM frequency_fetch f WHERE f.loc_kind = 'hotspot'`,
    ),
    query<{ locCode: string; locName: string | null; reason: string; checkedAt: Date }>(
      `SELECT m.loc_code AS "locCode", f.loc_name AS "locName", m.reason,
              m.checked_at AS "checkedAt"
         FROM hotspot_coord_misses m JOIN frequency_fetch f ON f.loc_code = m.loc_code
        ORDER BY f.loc_name, m.loc_code LIMIT 100`,
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
  ]);
  const lastRow = last.rows[0];
  return {
    missing: counts.rows[0]?.missing ?? 0,
    downloaded: counts.rows[0]?.downloaded ?? 0,
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
  };
}
