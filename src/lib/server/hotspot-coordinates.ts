/**
 * Durable location coordinates (td-c2f2b2, plan:
 * docs/2026-10-11-durable-hotspot-coordinates-plan.md).
 *
 * The ONE writer of ebird_locations coordinates. eBird's hotspot lists and
 * hotspot info carry every hotspot's coordinates; they used to live only in
 * ebird_cache (pruned after 48 h), so the map searches lost most downloaded
 * hotspots. Every official response is now stored here as it arrives.
 *
 * Provenance (0084): `official` = an eBird hotspot list or hotspot info,
 * ordered by when its request STARTED (`coord_fetched_at`); `observation` =
 * an observation feed or a life-list checklist. Official replaces observation
 * always, and official only when its request started later; observation never
 * replaces official (it still marks the row seen). `updated_at` is moved by
 * Google results too, so it never orders coordinates (CODEX1 P1-1).
 *
 * Claims (CODEX1 P1-2): under a worker claim every write is fenced
 * (claimFencedQuery: assert-held first, atomic with the write) and a lost
 * claim throws StaleClaimError; outside a claim it is a plain write.
 */
import { query } from "$lib/db";
import { claimFencedQuery, heldClaim, isStaleClaim } from "$server/job-claim";

export type CoordinateSource = "official" | "observation";

export interface CoordinateRow {
  locId?: string | null;
  /** Rows missing a name or a finite in-range coordinate are skipped. */
  locName: string | null;
  lat: number | null;
  lng: number | null;
  /** Start of the request that supplied this row; else the call's startedAt. */
  fetchedAt?: Date;
}

/** Rows per statement: 5 arrays, well under the 65,535-parameter limit. */
export const COORDINATE_CHUNK = 2_000;
const OFFICIAL_ID = /^L[0-9]+$/;

/** A row the writer can store: a valid id for its source, a name, in-range coordinates. */
export function usable(row: CoordinateRow, source: CoordinateSource): boolean {
  const id = typeof row.locId === "string" ? row.locId.trim() : "";
  if (!id || (source === "official" && !OFFICIAL_ID.test(id))) return false;
  return (
    typeof row.locName === "string" &&
    row.locName.trim().length > 0 &&
    typeof row.lat === "number" &&
    typeof row.lng === "number" &&
    Number.isFinite(row.lat) &&
    Number.isFinite(row.lng) &&
    row.lat >= -90 &&
    row.lat <= 90 &&
    row.lng >= -180 &&
    row.lng <= 180
  );
}

// A newer official answer always records its request time (CODEX1 review
// P2-2: an identical T30 answer left at T10 would let a delayed, different
// T20 answer win). Everything else — including last_seen_at, which the
// google-place partial index covers — moves only when the values changed, so
// an unchanged refresh (the world catalog's 30-day re-fetch) touches one
// unindexed column and can be a HOT update. `n` counts inserted or changed
// rows, read against the pre-statement snapshot (`old`).
const OFFICIAL_SQL = `
  WITH old AS MATERIALIZED (
    SELECT loc_id, loc_name, lat, lng, coord_source
      FROM ebird_locations WHERE loc_id = ANY($1::text[])
  ), up AS (
    INSERT INTO ebird_locations AS e (loc_id, loc_name, lat, lng, coord_source, coord_fetched_at)
    SELECT t.loc_id, t.loc_name, t.lat, t.lng, 'official', t.fetched_at
      FROM unnest($1::text[], $2::text[], $3::float8[], $4::float8[], $5::timestamptz[])
           AS t(loc_id, loc_name, lat, lng, fetched_at)
    ON CONFLICT (loc_id) DO UPDATE
       SET loc_name = EXCLUDED.loc_name, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
           coord_source = 'official', coord_fetched_at = EXCLUDED.coord_fetched_at,
           last_seen_at = CASE
             WHEN (e.loc_name, e.lat, e.lng, e.coord_source)
                  IS DISTINCT FROM (EXCLUDED.loc_name, EXCLUDED.lat, EXCLUDED.lng, 'official')
             THEN NOW() ELSE e.last_seen_at END,
           updated_at = CASE
             WHEN (e.loc_name, e.lat, e.lng, e.coord_source)
                  IS DISTINCT FROM (EXCLUDED.loc_name, EXCLUDED.lat, EXCLUDED.lng, 'official')
             THEN NOW() ELSE e.updated_at END
     WHERE e.coord_source = 'observation' OR EXCLUDED.coord_fetched_at > e.coord_fetched_at
    RETURNING e.loc_id, e.loc_name, e.lat, e.lng
  ), found AS (
    DELETE FROM hotspot_coord_misses m WHERE m.loc_code = ANY($1::text[])
  )
  SELECT count(*)::int AS n
    FROM up LEFT JOIN old ON old.loc_id = up.loc_id
   WHERE old.loc_id IS NULL
      OR (old.loc_name, old.lat, old.lng, old.coord_source)
         IS DISTINCT FROM (up.loc_name, up.lat, up.lng, 'official')`;

const OBSERVATION_SQL = `
  WITH up AS (
    INSERT INTO ebird_locations AS e (loc_id, loc_name, lat, lng)
    SELECT t.loc_id, t.loc_name, t.lat, t.lng
      FROM unnest($1::text[], $2::text[], $3::float8[], $4::float8[]) AS t(loc_id, loc_name, lat, lng)
    ON CONFLICT (loc_id) DO UPDATE
       SET loc_name = CASE WHEN e.coord_source = 'observation' THEN EXCLUDED.loc_name ELSE e.loc_name END,
           lat = CASE WHEN e.coord_source = 'observation' THEN EXCLUDED.lat ELSE e.lat END,
           lng = CASE WHEN e.coord_source = 'observation' THEN EXCLUDED.lng ELSE e.lng END,
           last_seen_at = NOW(), updated_at = NOW()
    RETURNING 1
  )
  SELECT count(*)::int AS n FROM up`;

/**
 * Store coordinates under the precedence rules. Under a held claim the write
 * is fenced and a lost claim throws; every error propagates (callers that
 * must not fail use rememberOfficialHotspots). Returns rows inserted or
 * changed (a newer identical official answer only records its time).
 */
/** The rows the writer would store: usable, one per id (first wins). */
export function acceptedCoordinateRows(
  rows: readonly CoordinateRow[],
  source: CoordinateSource,
): CoordinateRow[] {
  const byId = new Map<string, CoordinateRow>();
  for (const row of rows) {
    if (!usable(row, source)) continue;
    const id = row.locId!.trim();
    if (!byId.has(id)) byId.set(id, { ...row, locId: id });
  }
  return [...byId.values()];
}

export async function upsertLocationCoordinates(
  rows: readonly CoordinateRow[],
  source: CoordinateSource,
  startedAt: Date | null,
): Promise<number> {
  if (source === "official" && !startedAt && rows.some((r) => !r.fetchedAt))
    throw new Error("official coordinates need the request start time");
  const unique = acceptedCoordinateRows(rows, source).map((r) => [r.locId!, r] as const);
  let written = 0;
  for (let i = 0; i < unique.length; i += COORDINATE_CHUNK) {
    const chunk = unique.slice(i, i + COORDINATE_CHUNK);
    const params: unknown[] = [
      chunk.map(([id]) => id),
      chunk.map(([, r]) => r.locName!.trim()),
      chunk.map(([, r]) => r.lat),
      chunk.map(([, r]) => r.lng),
    ];
    if (source === "official")
      params.push(chunk.map(([, r]) => (r.fetchedAt ?? startedAt!).toISOString()));
    const sql = source === "official" ? OFFICIAL_SQL : OBSERVATION_SQL;
    const r = heldClaim()
      ? await claimFencedQuery<{ n: number }>(sql, params, "hotspot coordinates")
      : await query<{ n: number }>(sql, params);
    written += r.rows[0]?.n ?? 0;
  }
  return written;
}

/**
 * Best-effort store of an official eBird response that the caller has
 * already received: an ordinary failure is logged and never fails the
 * caller (the next fetch or the repair job stores it); a lost claim always
 * propagates.
 */
export async function rememberOfficialHotspots(
  rows: readonly CoordinateRow[],
  startedAt: Date,
): Promise<void> {
  try {
    await upsertLocationCoordinates(rows, "official", startedAt);
  } catch (err) {
    if (isStaleClaim(err)) throw err;
    console.error(
      "[hotspot-coordinates] could not store official hotspot coordinates:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Downloaded hotspots without official coordinates and no recent miss ($1 = retry days). */
const GAPS_FROM = `
    FROM frequency_fetch f
   WHERE f.loc_kind = 'hotspot' AND f.loc_code ~ '^L[0-9]+$'
     AND NOT EXISTS (SELECT 1 FROM ebird_locations e
                      WHERE e.loc_id = f.loc_code AND e.coord_source = 'official')
     AND NOT EXISTS (SELECT 1 FROM hotspot_coord_misses m
                      WHERE m.loc_code = f.loc_code
                        AND m.checked_at > NOW() - make_interval(days => $1))`;
const GAPS_SQL = `SELECT f.loc_code AS "locCode", f.region_code AS "regionCode" ${GAPS_FROM} ORDER BY f.loc_code`;

/** A miss is re-checked after this many days (eBird can re-list a hotspot). */
export const COORD_MISS_RETRY_DAYS = 30;

/** `onlyLocCodes` is test-only: limits the gaps to rows a test owns. */
export async function coordinateGaps(
  onlyLocCodes?: readonly string[],
): Promise<Array<{ locCode: string; regionCode: string | null }>> {
  const all = (
    await query<{ locCode: string; regionCode: string | null }>(GAPS_SQL, [COORD_MISS_RETRY_DAYS])
  ).rows;
  if (!onlyLocCodes) return all;
  const only = new Set(onlyLocCodes);
  return all.filter((g) => only.has(g.locCode));
}

/** Is there any gap at all? (The repair scheduler's cheap check.) */
export async function hasCoordinateGaps(): Promise<boolean> {
  const r = await query<{ any: boolean }>(
    `SELECT EXISTS (SELECT 1 ${GAPS_FROM}) AS any`,
    [COORD_MISS_RETRY_DAYS],
  );
  return r.rows[0]?.any ?? false;
}

/** Does this downloaded hotspot still need official coordinates? */
export async function needsOfficialCoordinates(locCode: string): Promise<boolean> {
  const r = await query<{ needed: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM ebird_locations e
                         WHERE e.loc_id = $1 AND e.coord_source = 'official')
        AND NOT EXISTS (SELECT 1 FROM hotspot_coord_misses m
                         WHERE m.loc_code = $1
                           AND m.checked_at > NOW() - make_interval(days => $2)) AS needed`,
    [locCode, COORD_MISS_RETRY_DAYS],
  );
  return r.rows[0]?.needed ?? false;
}

export type MissReason = "gone" | "not_hotspot";

/** eBird no longer describes this downloaded hotspot; fenced under a claim. */
export async function recordCoordinateMiss(locCode: string, reason: MissReason): Promise<void> {
  await claimFencedQuery(
    `INSERT INTO hotspot_coord_misses (loc_code, reason, checked_at)
     SELECT $1, $2, NOW() WHERE EXISTS (SELECT 1 FROM frequency_fetch WHERE loc_code = $1)
     ON CONFLICT (loc_code) DO UPDATE SET reason = EXCLUDED.reason, checked_at = NOW()`,
    [locCode, reason],
    "hotspot coordinate miss",
  );
}

/**
 * Copy official coordinates for `locCodes` out of whatever eBird responses
 * are still cached (hotspot lists and hotspot info) — no eBird calls. Each
 * row is ordered by its cache row's fetch time.
 */
export async function coordinatesFromCache(locCodes: readonly string[]): Promise<number> {
  if (locCodes.length === 0) return 0;
  const r = await query<{
    loc_id: string;
    loc_name: string | null;
    lat: number;
    lng: number;
    fetched_at: Date;
  }>(
    `SELECT DISTINCT ON (x.loc_id) x.loc_id, x.loc_name, x.lat, x.lng, x.fetched_at
       FROM (
         SELECT h->>'locId' AS loc_id, h->>'locName' AS loc_name,
                (h->>'lat')::float8 AS lat, (h->>'lng')::float8 AS lng, c.fetched_at
           FROM ebird_cache c
          CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(c.payload) = 'array' THEN c.payload ELSE '[]'::jsonb END) h
          WHERE (c.cache_key LIKE 'hotspots:%' OR c.cache_key LIKE 'hotspotsRegion:%')
            AND jsonb_typeof(h) = 'object'
            AND jsonb_typeof(h->'lat') = 'number' AND jsonb_typeof(h->'lng') = 'number'
            AND h->>'locId' = ANY($1::text[])
         UNION ALL
         SELECT substr(c.cache_key, length('hotspotInfo:') + 1), c.payload->>'locName',
                (c.payload->>'lat')::float8, (c.payload->>'lng')::float8, c.fetched_at
           FROM ebird_cache c
          WHERE c.cache_key = ANY(SELECT 'hotspotInfo:' || id FROM unnest($1::text[]) AS id)
            AND jsonb_typeof(c.payload) = 'object'
            AND jsonb_typeof(c.payload->'lat') = 'number' AND jsonb_typeof(c.payload->'lng') = 'number'
       ) x
      ORDER BY x.loc_id, x.fetched_at DESC`,
    [locCodes],
  );
  return upsertLocationCoordinates(
    r.rows.map((row) => ({
      locId: row.loc_id,
      locName: row.loc_name,
      lat: row.lat,
      lng: row.lng,
      fetchedAt: new Date(row.fetched_at),
    })),
    "official",
    null,
  );
}
