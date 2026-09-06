import { query } from "$lib/db";

interface LoadedLocation {
  loc_code: string;
  loc_kind: "region" | "hotspot";
  region_code: string | null;
  begin_year: number;
  end_year: number;
}

/** No external calls: membership comes from recorded eBird geography, never
 * from prose, a bounding box, or country-name text matching. */
export async function guideLocationCoverage(code: string) {
  const { rows } = await query<LoadedLocation>(
    `SELECT loc_code, loc_kind, region_code, begin_year, end_year
		 FROM frequency_fetch
		 WHERE (loc_kind = 'region' AND (loc_code = $1 OR loc_code LIKE $2))
		    OR (loc_kind = 'hotspot' AND (region_code = $1 OR region_code LIKE $2))`,
    [code, `${code}-%`],
  );
  // Include every recorded source: even a statewide export can omit a taxon
  // present in a county or hotspot export covering the same years.
  const sources = rows;
  return {
    locCodes: sources.map((r) => r.loc_code),
    wholeArea: sources.some(
      (r) => r.loc_kind === "region" && r.loc_code === code,
    ),
    beginYear: sources.length
      ? Math.min(...sources.map((r) => r.begin_year))
      : null,
    endYear: sources.length
      ? Math.max(...sources.map((r) => r.end_year))
      : null,
  };
}
