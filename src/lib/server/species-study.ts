import { error } from "@sveltejs/kit";
import { query, queryTimed } from "$lib/db";
import { viewedSpecies } from "$server/species-views";
import { countriesList } from "$server/regions";
import { guideLocationCoverage } from "$server/guide-location";
import { countryOf } from "$lib/region-code";
import type {
  StudySpecies,
  StudyCountry,
  StudyStatus,
} from "$lib/species-study";

export async function studySpecies(
  userId: number,
  search: string,
  status: StudyStatus,
  alphabetical: boolean,
) {
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
  }>(
    `SELECT t.species_code,t.com_name,t.sci_name,t.family FROM taxonomy_cache t
     WHERE t.category='species'
       AND NOT EXISTS (SELECT 1 FROM species_view_history h WHERE h.user_id=$1 AND h.species_code=t.species_code)
       AND ($2='' OR t.species_code ILIKE $3 OR t.com_name ILIKE $3 OR t.sci_name ILIKE $3)
     ORDER BY t.com_name,t.species_code`,
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
          current: true,
          view: null,
        }) satisfies StudySpecies,
    ),
  };
}

/** Coverage metadata only: never scan the weekly frequency table to open the page. */
export async function studyCountries(): Promise<StudyCountry[]> {
  const [countries, sources] = await Promise.all([
    countriesList(),
    query<{
      loc_code: string;
      loc_kind: string;
      region_code: string | null;
      begin_year: number;
      end_year: number;
    }>(
      "SELECT loc_code,loc_kind,region_code,begin_year,end_year FROM frequency_fetch",
    ),
  ]);
  const result = new Map(
    countries.map((c) => [
      c.code,
      {
        code: c.code,
        name: c.name,
        sourceCount: 0,
        wholeArea: false,
        beginYear: null,
        endYear: null,
      } as StudyCountry,
    ]),
  );
  for (const row of sources.rows) {
    const regionCode =
      row.loc_kind === "region" ? row.loc_code : row.region_code;
    const code = regionCode ? countryOf(regionCode) : null;
    const country = code ? result.get(code) : undefined;
    if (!country) continue; // Unmapped sources cannot establish country membership.
    country.sourceCount++;
    country.wholeArea ||= row.loc_kind === "region" && row.loc_code === code;
    country.beginYear =
      country.beginYear === null
        ? row.begin_year
        : Math.min(country.beginYear, row.begin_year);
    country.endYear =
      country.endYear === null
        ? row.end_year
        : Math.max(country.endYear, row.end_year);
  }
  return [...result.values()];
}

export async function studyCountrySpecies(
  userId: number,
  search: string,
  status: StudyStatus,
  alphabetical: boolean,
  country: string,
) {
  const coverage = await guideLocationCoverage(country);
  const result = await studySpecies(userId, search, status, alphabetical);
  if (!coverage.locCodes.length || !result.rows.length)
    return { ...coverage, rows: [] as StudySpecies[] };
  // Scan the selected locations once, not one broad EXISTS per taxonomy row.
  // Fetch on opening a country; never a global page-load scan.
  const membership = await queryTimed<{ species_code: string }>(
    "SELECT DISTINCT species_code FROM species_frequency WHERE loc_code=ANY($1::text[])",
    [coverage.locCodes],
    15000,
  );
  const codes = new Set(membership.rows.map((r) => r.species_code));
  return { ...coverage, rows: result.rows.filter((r) => codes.has(r.code)) };
}
