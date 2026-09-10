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

/** Count only species in the account's already-filtered study list. */
export async function studyCountries(
  speciesCodes: string[],
): Promise<StudyCountry[]> {
  if (!speciesCodes.length) return [];
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
        speciesCount: 0,
        wholeArea: false,
        beginYear: null,
        endYear: null,
      } as StudyCountry,
    ]),
  );
  const locCodes: string[] = [];
  const sourcesByCountry = new Map<string, string[]>();
  for (const row of sources.rows) {
    const regionCode =
      row.loc_kind === "region" ? row.loc_code : row.region_code;
    const code = regionCode ? countryOf(regionCode) : null;
    const country = code ? result.get(code) : undefined;
    if (!country) continue; // Unmapped sources cannot establish country membership.
    locCodes.push(row.loc_code);
    const countrySources = sourcesByCountry.get(country.code) ?? [];
    countrySources.push(row.loc_code);
    sourcesByCountry.set(country.code, countrySources);
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
  if (!locCodes.length) return [];
  if (speciesCodes.length > 250) {
    // Large lists use the already-bounded country membership query. A global
    // country/species join over all weekly rows spills into expensive sorts
    // on production. This changes execution strategy, never the result set.
    // Keep concurrency at two so study reads leave room for other app work.
    const selected = new Set(speciesCodes);
    const pending = [...sourcesByCountry];
    let next = 0;
    let stopped = false;
    const countCountries = async () => {
      try {
        while (!stopped && next < pending.length) {
          const [countryCode, locations] = pending[next++];
          const membership = await queryTimed<{ species_code: string }>(
            "SELECT DISTINCT species_code FROM species_frequency WHERE loc_code=ANY($1::text[])",
            [locations],
            15000,
          );
          result.get(countryCode)!.speciesCount = membership.rows.filter(
            (row) => selected.has(row.species_code),
          ).length;
        }
      } catch (error) {
        stopped = true;
        throw error;
      }
    };
    await Promise.all([countCountries(), countCountries()]);
    return [...result.values()].filter((country) => country.speciesCount > 0);
  }
  // Collapse weekly rows before joining geography, then count a species once
  // per country even when several counties/hotspots report it. The species
  // index keeps small viewed lists from scanning the whole distribution table.
  const counts = await queryTimed<{
    country_code: string;
    species_count: number;
  }>(
    `WITH membership AS MATERIALIZED (
       SELECT DISTINCT species_code,loc_code FROM species_frequency
       WHERE species_code=ANY($1::text[])
     )
     SELECT split_part(CASE WHEN f.loc_kind='region' THEN f.loc_code ELSE f.region_code END,'-',1)
              AS country_code,count(DISTINCT m.species_code)::int AS species_count
     FROM membership m JOIN frequency_fetch f USING(loc_code)
     WHERE f.loc_code=ANY($2::text[])
     GROUP BY 1`,
    [speciesCodes, locCodes],
    30000,
  );
  for (const row of counts.rows)
    result.get(row.country_code)!.speciesCount = row.species_count;
  return [...result.values()].filter((country) => country.speciesCount > 0);
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
