import { query } from "$lib/db";
import { GEOGRAPHIC_AREAS } from "$lib/geographic-areas";

/** Distinct recorded species, not a sum of overlapping location totals.
 * Monthly rollups retain all seasons without scanning the weekly source.
 * Return only counts to the browser; no species lists or hotspot detail. */
async function aggregateSpeciesCounts() {
  // Region/species codes are identifiers: bytewise collation avoids expensive
  // locale comparisons in the worldwide DISTINCT, without changing membership.
  const areaByCountry = Object.fromEntries(
    GEOGRAPHIC_AREAS.flatMap((area) =>
      area.countryCodes.map((code) => [code, area.id]),
    ),
  );
  const { rows } = await query<{
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

let cached:
  | {
      revision: string;
      result: ReturnType<typeof aggregateSpeciesCounts>;
    }
  | undefined;

export async function loadedSpeciesCounts() {
  // Frequency writes replace their rollups and update frequency_fetch in one
  // transaction. Include every row (not just MAX(fetched_at)) so deletions and
  // geography repairs also invalidate. Taxonomy edits can change species status.
  // Recheck on every request/Reload; only the expensive aggregate is reused.
  const { rows } = await query<{ revision: string }>(
    `SELECT concat(
       (SELECT md5(string_agg(concat_ws(':', loc_code, loc_kind, region_code,
         fetched_at, n_species), ',' ORDER BY loc_code COLLATE "C")) FROM frequency_fetch),
       '/',
       (SELECT md5(string_agg(concat_ws(':', species_code, category), ','
         ORDER BY species_code COLLATE "C")) FROM taxonomy_cache)
     ) AS revision`,
  );
  const revision = rows[0].revision;
  if (cached?.revision === revision) return cached.result;
  const result = aggregateSpeciesCounts();
  cached = { revision, result };
  result.catch(() => {
    if (cached?.result === result) cached = undefined;
  });
  return result;
}
