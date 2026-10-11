import type pg from "pg";
import { query, withReadSnapshot } from "$lib/db";
import { GEOGRAPHIC_AREAS } from "$lib/geographic-areas";

/**
 * Hotspots & data species totals (td-7162f6), read from the species-presence
 * layer the database maintains at write time (0053-0055 + 0083): per-location
 * species arrays, plus (region, species) and (country, species) tables whose
 * rows exist while at least one loaded location has that species. A load
 * changes them in its own transaction and bumps species_presence_state.version.
 *
 * So the page never reads the 13.9 M-row frequency tables: a view reads the
 * version (one row) and returns the totals cached for it; the first view after
 * a change recomputes them from the small tables in one read snapshot.
 *
 * "Present" = effective presence: freq > 0 in a week with checklists
 * (= species_month_freq.num > 0), the definition the Field Guide and the
 * forecasts use. Only taxonomy category 'species' counts.
 */
export interface SpeciesCounts {
  areas: Record<string, number>;
  /** Countries AND first-level regions, keyed by code ('NO', 'NO-18'). */
  regions: Record<string, number>;
  world: number;
}

export interface SpeciesTotalsView {
  /** null: the totals could not be read at all ("Counts unavailable"). */
  counts: SpeciesCounts | null;
  /**
   * Places with loaded data but no presence-ledger rows: the count is
   * unknown, never 0 (a broken ledger — logged). Country/region codes, area
   * ids and 'world'.
   */
  unavailable: string[];
}

type Run = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<pg.QueryResult<T>>;

const areaByCountry = (): Record<string, string> =>
  Object.fromEntries(
    GEOGRAPHIC_AREAS.flatMap((area) =>
      area.countryCodes.map((code) => [code, area.id]),
    ),
  );

/**
 * All totals from the presence tables. Regions and countries are row counts
 * of their (code, species) tables; areas and the world deduplicate across
 * countries; the world also includes species at locations with no recorded
 * country (none today), exactly like the old whole-table aggregate.
 */
export async function presenceCounts(run: Run): Promise<SpeciesCounts> {
  const { rows } = await run<{ kind: "area" | "region" | "world" | "loaded"; code: string; n: number }>(
    `WITH sp AS (SELECT species_code COLLATE "C" AS species_code FROM taxonomy_cache WHERE category = 'species'),
     country_species AS (
       SELECT m.country_code COLLATE "C" AS country, m.species_code COLLATE "C" AS species_code
         FROM species_country_membership m JOIN sp ON sp.species_code = m.species_code COLLATE "C"
     ),
     unassigned AS (
       SELECT DISTINCT s COLLATE "C" AS species_code
         FROM species_location_membership l CROSS JOIN LATERAL unnest(l.species_codes) s
        WHERE l.country_code IS NULL AND s IN (SELECT species_code FROM sp)
     )
     SELECT 'region' AS kind, m.region_code AS code, count(*)::int AS n
       FROM species_region_membership m JOIN sp ON sp.species_code = m.species_code COLLATE "C"
      GROUP BY m.region_code
     UNION ALL
     SELECT 'region', country, count(*)::int FROM country_species GROUP BY country
     UNION ALL
     SELECT 'area', COALESCE(a.value, 'other'), count(DISTINCT c.species_code)::int
       FROM country_species c LEFT JOIN jsonb_each_text($1::jsonb) a ON a.key = c.country
      GROUP BY COALESCE(a.value, 'other')
     UNION ALL
     SELECT 'world', 'world', count(*)::int
       FROM (SELECT species_code FROM country_species UNION SELECT species_code FROM unassigned) w
     UNION ALL
     -- Every place with loaded locations, so a loaded place with no species
     -- reads 0 and a place with nothing loaded has no entry at all.
     SELECT DISTINCT 'loaded', country_code, 0 FROM species_location_membership WHERE country_code IS NOT NULL
     UNION ALL
     SELECT DISTINCT 'loaded', region_code, 0 FROM species_location_membership WHERE region_code IS NOT NULL`,
    [JSON.stringify(areaByCountry())],
  );
  const areas: Record<string, number> = {};
  const regions: Record<string, number> = {};
  const byCountry = areaByCountry();
  let world = 0;
  for (const row of rows) {
    if (row.kind === "world") world = row.n;
    else if (row.kind === "area") areas[row.code] = row.n;
    else if (row.kind === "region") regions[row.code] = row.n;
  }
  for (const row of rows) {
    if (row.kind !== "loaded") continue;
    regions[row.code] ??= 0;
    if (!row.code.includes("-")) areas[byCountry[row.code] ?? "other"] ??= 0;
  }
  return { areas, regions, world };
}

/**
 * Loaded places whose locations have no ledger row. Every frequency_fetch row
 * gets one in the same transaction (0083), so this is empty unless the ledger
 * is broken; a non-empty answer turns those places' totals into "unavailable".
 */
async function ledgerGaps(run: Run): Promise<string[]> {
  const { rows } = await run<{ country: string | null; region: string | null }>(
    `SELECT DISTINCT study_country_code(f.loc_kind, f.loc_code, f.region_code) AS country,
            study_region_code(f.loc_kind, f.loc_code, f.region_code) AS region
       FROM frequency_fetch f
      WHERE NOT EXISTS (SELECT 1 FROM species_location_membership l WHERE l.loc_code = f.loc_code)`,
  );
  if (rows.length === 0) return [];
  const byCountry = areaByCountry();
  const out = new Set<string>(["world"]);
  for (const r of rows) {
    if (r.country) {
      out.add(r.country);
      out.add(byCountry[r.country] ?? "other");
    }
    if (r.region) out.add(r.region);
  }
  return [...out];
}

interface Snapshot {
  version: bigint;
  view: SpeciesTotalsView;
}

let cache: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;

/** Version and totals from ONE read snapshot, so the version names exactly what was counted. */
async function computeSnapshot(): Promise<Snapshot> {
  return withReadSnapshot(async (client) => {
    const run: Run = (text, params) => client.query(text, params as never[]);
    const v = await run<{ version: string }>(
      "SELECT version::text AS version FROM species_presence_state WHERE id = 1",
    );
    if (!v.rows[0]) throw new Error("species_presence_state row missing");
    const counts = await presenceCounts(run);
    const unavailable = await ledgerGaps(run);
    if (unavailable.length > 0)
      console.error("[species-presence] loaded places without ledger rows:", unavailable.join(" "));
    return { version: BigInt(v.rows[0].version), view: { counts, unavailable } };
  });
}

/** One computation at a time; a result only ever replaces an OLDER cached version. */
function startCompute(): Promise<Snapshot> {
  const p: Promise<Snapshot> = computeSnapshot()
    .then((s) => {
      if (!cache || s.version > cache.version) cache = s;
      return s;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

/**
 * Totals at least as new as `version`. A computation already in flight may
 * have started before `version` committed: if its snapshot is older, start
 * (or join) a newer one rather than accept it.
 */
async function snapshotAtLeast(version: bigint): Promise<Snapshot> {
  if (cache && cache.version >= version) return cache;
  let s = await (inflight ?? startCompute());
  if (s.version < version) s = await (inflight ?? startCompute());
  return cache && cache.version > s.version ? cache : s;
}

/** The page's read: one 1-row query when nothing changed since the last view. */
export async function readSpeciesTotals(): Promise<SpeciesTotalsView> {
  try {
    const { rows } = await query<{ version: string }>(
      "SELECT version::text AS version FROM species_presence_state WHERE id = 1",
    );
    if (!rows[0]) throw new Error("species_presence_state row missing");
    return (await snapshotAtLeast(BigInt(rows[0].version))).view;
  } catch (err) { // stale-safe: page read only, never under a job claim; a failure means unavailable
    console.error(
      "[species-presence] totals unavailable:",
      err instanceof Error ? err.message : err,
    );
    return { counts: null, unavailable: [] };
  }
}

export function __resetSpeciesTotalsCacheForTests(): void {
  cache = null;
  inflight = null;
}

/**
 * VERIFICATION ONLY — never on a request or job path. The pre-0083 exact
 * aggregate over the whole frequency tables (~38 s on the droplet), kept so
 * scripts/verify-species-presence.ts can prove the presence tables give
 * identical totals. Missing keys in either result mean 0.
 */
export async function referenceCountsFromFrequency(run: Run): Promise<SpeciesCounts> {
  const { rows } = await run<{ kind: "area" | "region" | "world"; code: string; n: number }>(
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
       COUNT(DISTINCT species_code)::int AS n
     FROM grouped
     GROUP BY GROUPING SETS ((), (area), (country), (region))
     HAVING GROUPING(area, country, region) = 7
       OR (GROUPING(area) = 0 AND area IS NOT NULL)
       OR (GROUPING(country) = 0 AND country IS NOT NULL)
       OR (GROUPING(region) = 0 AND region IS NOT NULL)`,
    [JSON.stringify(areaByCountry())],
  );
  const areas: Record<string, number> = {};
  const regions: Record<string, number> = {};
  let world = 0;
  for (const row of rows) {
    if (row.kind === "world") world = row.n;
    else (row.kind === "area" ? areas : regions)[row.code] = row.n;
  }
  return { areas, regions, world };
}

/** Keys whose values differ between two totals (missing = 0). */
export function diffCounts(a: SpeciesCounts, b: SpeciesCounts): string[] {
  const out: string[] = [];
  for (const kind of ["areas", "regions"] as const) {
    for (const k of new Set([...Object.keys(a[kind]), ...Object.keys(b[kind])])) {
      const x = a[kind][k] ?? 0;
      const y = b[kind][k] ?? 0;
      if (x !== y) out.push(`${kind}.${k}: ${x} vs ${y}`);
    }
  }
  if (a.world !== b.world) out.push(`world: ${a.world} vs ${b.world}`);
  return out;
}
