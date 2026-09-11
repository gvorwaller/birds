import { error } from "@sveltejs/kit";
import { query, queryTimed } from "$lib/db";
import { viewedSpecies } from "$server/species-views";
import { countriesList } from "$server/regions";
import type {
  StudySpecies,
  StudyCountry,
  StudyStatus,
} from "$lib/species-study";

export async function studySpecies(
  userId: number,
  search: string,
  status: StudyStatus,
  alphabetical: boolean | "taxonomic",
): Promise<{enabled:boolean;rows:StudySpecies[]}> {
  if (status === "viewed") {
    const result = await viewedSpecies(userId, search, alphabetical);
    return {
      enabled: result.enabled,
      rows: result.rows.map(
        (row) =>
          ({
            code: row.code,
            name: row.name,
            scientificName: row.scientificName,
            family: row.family,
            taxonOrder: row.taxonOrder,
            matchedBandingCode: row.matchedBandingCode,
            current: row.current,
            view: {
              firstViewedAt: row.firstViewedAt,
              lastViewedAt: row.lastViewedAt,
            },
          }) satisfies StudySpecies,
      ),
    };
  }
  const account = await query<{ record_species_views: boolean }>(
    "SELECT record_species_views FROM users WHERE id=$1",
    [userId],
  );
  if (!account.rows[0]) error(401, "Account unavailable");
  const escaped = search.replace(/[%_\\]/g, (m) => `\\${m}`);
  const result = await query<{
    species_code: string;
    com_name: string;
    sci_name: string;
    family: string | null;
    taxon_order: number | null;
    matched_banding_code: string | null;
  }>(
    `SELECT t.species_code,t.com_name,t.sci_name,t.family,t.taxon_order::float8 AS taxon_order,
 CASE WHEN t.banding_codes @> ARRAY[upper($2)] THEN upper($2) END AS matched_banding_code FROM taxonomy_cache t
     WHERE t.category='species'
       AND NOT EXISTS (SELECT 1 FROM species_view_history h WHERE h.user_id=$1 AND h.species_code=t.species_code)
       AND ($2='' OR t.species_code ILIKE $3 OR t.com_name ILIKE $3 OR t.sci_name ILIKE $3 OR t.banding_codes @> ARRAY[upper($2)])
     ORDER BY ${alphabetical === "taxonomic" ? "t.taxon_order NULLS LAST," : ""}t.com_name,t.species_code`,
    [userId, search, `%${escaped}%`],
  );
  return {
    enabled: account.rows[0].record_species_views,
    rows: result.rows.map(
      (row) =>
        ({
          code: row.species_code,
          name: row.com_name,
          scientificName: row.sci_name,
          family: row.family,
          taxonOrder: row.taxon_order,
          matchedBandingCode: row.matched_banding_code,
          current: true,
          view: null,
        }) satisfies StudySpecies,
    ),
  };
}

/** Count only species in the account's already-filtered study list. */
export async function studyCountries(
  speciesCodes: string[],
): Promise<StudyCountry[]> {
  if (!speciesCodes.length) return [];
  // Counts and coverage share one SQL snapshot, including during a report
  // import or country remap. Only public geography is summarized; account
  // history and search stay request-local.
  const [countries, counts] = await Promise.all([
    countriesList(),
    queryTimed<{
      country_code: string;
      species_count: number;
      source_count: number;
      whole_area: boolean;
      begin_year: number;
      end_year: number;
    }>(
      `WITH counts AS (
         SELECT country_code,count(*)::int AS species_count
         FROM species_country_membership
         WHERE species_code=ANY($1::text[]) GROUP BY country_code
       )
       SELECT c.country_code,c.species_count,count(*)::int AS source_count,
              bool_or(f.loc_kind='region' AND f.loc_code=c.country_code) AS whole_area,
              min(f.begin_year)::int AS begin_year,max(f.end_year)::int AS end_year
       FROM counts c JOIN frequency_fetch f
         ON study_country_code(f.loc_kind,f.loc_code,f.region_code)=c.country_code
       GROUP BY c.country_code,c.species_count`,
      [speciesCodes],
      15000,
    ),
  ]);
  const byCountry = new Map(counts.rows.map((row) => [row.country_code, row]));
  // Seeded country labels/order only; unknown geography never becomes a guess.
  return countries.flatMap((country) => {
    const row = byCountry.get(country.code);
    return row
      ? [
          {
            code: country.code,
            name: country.name,
            speciesCount: row.species_count,
            sourceCount: row.source_count,
            wholeArea: row.whole_area,
            beginYear: row.begin_year,
            endYear: row.end_year,
          },
        ]
      : [];
  });
}

export async function studyCountrySpecies(
  userId: number,
  search: string,
  status: StudyStatus,
  alphabetical: boolean | "taxonomic",
  country: string,
) {
  const [result, membership] = await Promise.all([
    studySpecies(userId, search, status, alphabetical),
    queryTimed<{
      loc_codes: string[] | null;
      whole_area: boolean | null;
      begin_year: number | null;
      end_year: number | null;
      species_codes: string[];
    }>(
      `SELECT array_agg(loc_code ORDER BY loc_code) AS loc_codes,
              bool_or(loc_kind='region' AND loc_code=$1) AS whole_area,
              min(begin_year)::int AS begin_year,max(end_year)::int AS end_year,
              ARRAY(SELECT species_code FROM species_country_membership
                    WHERE country_code=$1) AS species_codes
       FROM frequency_fetch
       WHERE study_country_code(loc_kind,loc_code,region_code)=$1`,
      [country],
      15000,
    ),
  ]);
  const row = membership.rows[0];
  const codes = new Set(row.species_codes);
  return {
    // SQL aggregates return null for genuinely empty coverage.
    locCodes: row.loc_codes ?? [],
    wholeArea: row.whole_area ?? false,
    beginYear: row.begin_year,
    endYear: row.end_year,
    rows: result.rows.filter((species) => codes.has(species.code)),
  };
}
