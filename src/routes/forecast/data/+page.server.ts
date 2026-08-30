import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import {
  getEbirdApiKey,
  subregions,
  EbirdError,
} from "$server/ebird";
import {
  countriesList,
  regionCoordsFor,
  regionLabels,
  subnational1Of,
  validateRegionCode,
} from "$server/regions";
import { sweepAreaHotspots } from "$server/hotspot-sweep";
import {
  coverageFromMeta,
  recentFailures,
  sortByProximity,
} from "$server/forecast";
import { attemptMeta, frequencyMeta, lastCompleteYear } from "$server/barchart";
import { enqueueJob } from "$server/jobs";
import { dedupKeys } from "$server/job-policy";
import { countyMapQuery, countySeat } from "$server/county-meta";
import {
  parseRegionCode,
  isCountry,
  childLevel,
  parentOf,
  type RegionLevel,
} from "$lib/region-code";

const DEFAULT_COUNTRY = "US";

interface LoadedRow {
  loc_code: string;
  loc_kind: "region" | "hotspot";
  loc_name: string;
  begin_year: number;
  end_year: number;
  n_species: number;
  n_unmatched: number;
  fetched_at: string;
  current: boolean;
  region_code: string | null;
}

export interface DataRow {
  locCode: string;
  locKind: "region" | "hotspot";
  locName: string;
  beginYear: number;
  endYear: number;
  nSpecies: number;
  /** Barchart rows that matched no taxon — was SELECTed then dropped in the
   * row mapping (hidden-data audit Tier 1); now displayed when > 0. */
  nUnmatched: number;
  fetchedAt: string;
  current: boolean;
}

/** One county's row plus the hotspots nested inside it (GBV 2026-08-14). */
export interface CountyBlock {
  countyCode: string;
  countyName: string;
  /** County seat for orientation (td-01ddb6); null when unknown. */
  seat: string | null;
  /** Maps search text that outlines the county. */
  mapQuery: string;
  /** The county's own frequency row — null when hotspots loaded first. */
  county: DataRow | null;
  hotspots: DataRow[];
}

/** One region's data grouped for the collapsible display (GBV request).
 * "state" is a subnational1 region (a US state, a Norwegian fylke). Field
 * names kept from the US-only original to avoid churning the svelte
 * template; they generalize to "region" throughout.
 *
 * `level` can still be "country" internally — the grouping pass below uses
 * a level:"country" StateGroup as a scratch container while it tallies a
 * country's own countrywide row + child totals — but no such entry is ever
 * returned to the client. It's consumed into a CountrySection's header
 * fields instead (td-f1d6da UX restructure, GBV 2026-08-24: "Countries need
 * to be treated like states; regions in the countries nested under the
 * country."). Every StateGroup that actually reaches the page — top-level
 * (US) or nested inside a CountrySection (everywhere else) — is always
 * level "subnational1". */
export interface StateGroup {
  stateCode: string;
  stateName: string;
  state: DataRow | null;
  /** Counties (with their nested hotspots), sorted by name. */
  countyBlocks: CountyBlock[];
  /** Hotspots whose county isn't recorded (pre-0014 rows never re-cached). */
  stateHotspots: DataRow[];
  countiesLoaded: number;
  hotspotCount: number;
  /** How many child regions the group has in total (null when unknown). */
  countyTotal: number | null;
  /** Child regions still fetchable (not current, not in failure cooldown). */
  countyRemaining: number | null;
  countryCode: string;
  countryName: string;
  level: "country" | "subnational1";
}

/** A non-US country's top-level group (td-f1d6da UX restructure): behaves
 * like a StateGroup one level up — its own "Countrywide" row, its own
 * "Analyze N remaining regions" action — with the country's subnational1
 * StateGroups nested inside rather than rendered as flat siblings. US
 * states stay out of this entirely (returned via `stateGroups`, unchanged). */
export interface CountrySection {
  countryCode: string;
  countryName: string;
  /** The country-level frequency row ("Entire Norway"), or null when only
   * subnational1 regions have been loaded — the section still exists so
   * the "Analyze remaining regions" action has somewhere to live. */
  countrywide: DataRow | null;
  /** Hotspots recorded directly under the country (no subnational1 on
   * record) — parallels a StateGroup's stateHotspots. */
  countryHotspots: DataRow[];
  /** Nested subnational1 groups, sorted by name — same StateGroup shape
   * (and same CountyBlock nesting for countries with subnational2, e.g.
   * Germany's Landkreise) a US state group uses. */
  groups: StateGroup[];
  /** countryHotspots + every nested group's own hotspotCount. */
  hotspotCount: number;
  /** Total subnational1 regions eBird lists for this country (null when
   * unknown, e.g. no API key). */
  regionTotal: number | null;
  regionsLoaded: number;
  /** Subnational1 regions still fetchable (not current, not in cooldown). */
  regionRemaining: number | null;
}

interface FailedRow {
  loc_code: string;
  last_attempt_at: string;
  error: string | null;
  loc_kind: "region" | "hotspot" | null;
  loc_name: string | null;
  region_code: string | null;
}

interface CorrectionRow {
  loc_code: string;
  loc_name: string;
  species_code: string;
  com_name: string | null;
  week: number;
  original_freq: number;
  stored_freq: number;
  sample_size: number;
  detected_at: string;
}

// Inventory of stored barchart data. Reads Postgres (and the official-API
// region-list cache for country/region names) — never ebird.org/barchartData.
export const load: PageServerLoad = async ({ locals, url }) => {
  const userId = locals.scopeId!;
  const isViewer = locals.user?.role === "viewer";

  const [loadedRes, failedRes, correctionsRes, apiKey] = await Promise.all([
    query<LoadedRow>(
      `SELECT loc_code, loc_kind, loc_name, begin_year, end_year, n_species,
              n_unmatched, fetched_at, region_code,
              (end_year >= $1) AS current
         FROM frequency_fetch
        ORDER BY loc_kind, loc_name`,
      [lastCompleteYear()],
    ),
    // Locations whose LAST attempt failed and that have no stored data at all.
    query<FailedRow>(
      `SELECT a.loc_code, a.last_attempt_at, a.error, a.loc_kind, a.loc_name, a.region_code
         FROM frequency_fetch_attempts a
        WHERE a.status = 'error'
          AND NOT EXISTS (SELECT 1 FROM frequency_fetch f WHERE f.loc_code = a.loc_code)
        ORDER BY a.last_attempt_at DESC`,
    ),
    query<CorrectionRow>(
      `SELECT a.loc_code, f.loc_name, a.species_code, t.com_name, a.week,
              a.original_freq, a.stored_freq, a.sample_size, a.detected_at
         FROM frequency_anomalies a
         JOIN frequency_fetch f ON f.loc_code = a.loc_code
         LEFT JOIN taxonomy_cache t ON t.species_code = a.species_code
        ORDER BY a.detected_at DESC, f.loc_name, t.com_name NULLS LAST, a.species_code, a.week`,
    ),
    getEbirdApiKey(userId),
  ]);
  // Next scheduled enrichment scan (td-b7d021): the parked singleton no
  // longer renders as "queued" anywhere — this SSR value feeds the hub's
  // dedicated line instead.
  const nextScan = await query<{ next_retry_at: string | null }>(
    `SELECT next_retry_at::text
       FROM jobs
      WHERE type = 'scan_enrichment' AND status = 'pending'
        AND next_retry_at > NOW()
        AND (progress ->> 'phase') IS DISTINCT FROM 'waiting_retry'
      ORDER BY next_retry_at LIMIT 1`,
  );

  const credsRow = await query<{ login_set: boolean }>(
    `SELECT (login_username_enc IS NOT NULL AND login_password_enc IS NOT NULL) AS login_set
       FROM user_ebird WHERE user_id = $1`,
    [userId],
  );
  const hasLogin = credsRow.rows[0]?.login_set === true;

  // Home location, for nearest-first picker ordering (Gaylon 2026-08-29 —
  // "save some clicks changing country and region"). Soft: null just means
  // both pickers fall back to their prior alphabetical order.
  const homeRow = await query<{ home_lat: number | null; home_lon: number | null }>(
    "SELECT home_lat, home_lon FROM users WHERE id = $1",
    [userId],
  );
  const home =
    homeRow.rows[0]?.home_lat != null && homeRow.rows[0]?.home_lon != null
      ? { lat: homeRow.rows[0].home_lat, lon: homeRow.rows[0].home_lon }
      : null;

  // Countries: drives the picker + display names for country-level groups
  // and non-US region labels — local reference data (regions table, Phase 3).
  // Works without an eBird API key.
  const countryList: { code: string; name: string }[] = (await countriesList()).map(
    (r) => ({ code: r.code, name: r.name }),
  );
  const countryName = new Map(countryList.map((c) => [c.code, c.name]));

  const countryParam = (url.searchParams.get("country") ?? "").trim().toUpperCase();
  let selectedCountry = DEFAULT_COUNTRY;
  if (
    isCountry(countryParam) &&
    (countryList.length === 0 || countryName.has(countryParam))
  ) {
    selectedCountry = countryParam;
  }

  const rows = loadedRes.rows.map((r) => ({
    row: {
      locCode: r.loc_code,
      locKind: r.loc_kind,
      locName: r.loc_name,
      beginYear: Number(r.begin_year),
      endYear: Number(r.end_year),
      nSpecies: Number(r.n_species),
      nUnmatched: Number(r.n_unmatched),
      fetchedAt: r.fetched_at,
      current: r.current,
    } as DataRow,
    regionCode: r.region_code,
  }));

  // Group by region; within a subnational1 region, hotspots nest under their
  // subnational2 block (GBV 2026-08-14 — region_code holds it since 0014).
  // A country-level load ("Entire Iceland") keys a level:"country" scratch
  // group by the country code, same Map as everything else — but it's a
  // container, not a sibling: the partition step below folds it (plus any
  // subnational1 groups sharing its countryCode) into one CountrySection,
  // nested one level in from the US state groups (td-f1d6da UX restructure,
  // GBV 2026-08-24 — supersedes the original flat-sibling-groups design
  // after seeing it live with Norway's 19 fylker as noisy top-level peers).
  const groups = new Map<string, StateGroup>();
  const blocks = new Map<string, CountyBlock>(); // by subnational2 code
  const orphanHotspots: DataRow[] = [];
  // Countries whose subnational1 name list we need to resolve display names
  // for groups found below — always includes the selected country (picker).
  const neededCountries = new Set<string>([selectedCountry]);

  const groupFor = (
    code: string,
    level: RegionLevel,
    countryCode: string,
  ): StateGroup => {
    let g = groups.get(code);
    if (!g) {
      g = {
        stateCode: code,
        stateName: level === "country" ? (countryName.get(code) ?? code) : code,
        state: null,
        countyBlocks: [],
        stateHotspots: [],
        countiesLoaded: 0,
        hotspotCount: 0,
        countyTotal: null,
        countyRemaining: null,
        countryCode,
        countryName: countryName.get(countryCode) ?? countryCode,
        level: level === "country" ? "country" : "subnational1",
      };
      groups.set(code, g);
    }
    return g;
  };
  const blockFor = (code: string, country: string): CountyBlock => {
    let b = blocks.get(code);
    if (!b) {
      b = {
        countyCode: code,
        countyName: code,
        seat: countySeat(code),
        mapQuery: "",
        county: null,
        hotspots: [],
      };
      blocks.set(code, b);
      const parentCode = parentOf(code)!; // subnational2 always has a subnational1 parent
      groupFor(parentCode, "subnational1", country).countyBlocks.push(b);
    }
    return b;
  };
  // A non-US country needs its level:"country" scratch container even when
  // ONLY subnational1 (or deeper) rows are loaded for it — otherwise a
  // country with just "Oslo · Norway" loaded would have nowhere for the
  // CountrySection partition below to hang its child-region total /
  // "Analyze remaining regions" data on (td-f1d6da edge case: country
  // loaded via subnational1 only, no countrywide row). US never gets one —
  // US states stay flat, no country wrapper.
  const ensureCountryContainer = (country: string) => {
    if (country !== "US") groupFor(country, "country", country);
  };
  for (const { row, regionCode } of rows) {
    if (row.locKind === "region") {
      const parsed = parseRegionCode(row.locCode);
      if (parsed?.level === "subnational1") {
        neededCountries.add(parsed.country);
        ensureCountryContainer(parsed.country);
        groupFor(parsed.code, "subnational1", parsed.country).state = row;
      } else if (parsed?.level === "subnational2") {
        neededCountries.add(parsed.country);
        ensureCountryContainer(parsed.country);
        const b = blockFor(parsed.code, parsed.country);
        b.county = row;
        b.countyName = row.locName;
      } else if (parsed?.level === "country") {
        groupFor(parsed.code, "country", parsed.country).state = row;
      } else {
        orphanHotspots.push(row); // unrecognized region shape — surface, don't hide
      }
    } else {
      const parsed = regionCode ? parseRegionCode(regionCode) : null;
      if (parsed?.level === "subnational2") {
        neededCountries.add(parsed.country);
        ensureCountryContainer(parsed.country);
        blockFor(parsed.code, parsed.country).hotspots.push(row);
      } else if (parsed?.level === "subnational1") {
        neededCountries.add(parsed.country);
        ensureCountryContainer(parsed.country);
        groupFor(parsed.code, "subnational1", parsed.country).stateHotspots.push(row);
      } else if (parsed?.level === "country") {
        groupFor(parsed.code, "country", parsed.country).stateHotspots.push(row);
      } else {
        orphanHotspots.push(row);
      }
    }
  }
  // Failed loads also need their country's subnational1 list resolved so the
  // "Failed loads" section can show real region names, not raw codes, even
  // when nothing in that country ever loaded successfully (GROK UX review
  // #5 — cache-first, same call the successful-row path already makes).
  for (const f of failedRes.rows) {
    const parsed = f.region_code ? parseRegionCode(f.region_code) : null;
    if (parsed) neededCountries.add(parsed.country);
  }

  // Resolve real subnational1 display names from the local reference set —
  // the old one-cached-eBird-fetch-per-country fan-out (and its per-country
  // error channel) is gone (Phase 3).
  const subnat1ByCountry = await Promise.all(
    [...neededCountries].map(async (country) => ({
      country,
      list: (await subnational1Of(country)).map((r) => ({ code: r.code, name: r.name })),
    })),
  );
  const regionDisplayName = new Map<string, string>();
  for (const { list } of subnat1ByCountry) {
    for (const r of list) regionDisplayName.set(r.code, r.name);
  }
  // Fallback chain (GROK UX review #5): the real eBird list name wins; when
  // it's unavailable (list fetch failed, or the country wasn't in
  // neededCountries) fall back to the loaded row's own stored loc_name
  // ("Alaska", "Ontario") before ever showing the raw code.
  for (const g of groups.values()) {
    if (g.level === "subnational1") {
      g.stateName = regionDisplayName.get(g.stateCode) ?? g.state?.locName ?? g.stateCode;
    } else if (g.level === "country") {
      g.stateName = countryName.get(g.stateCode) ?? g.state?.locName ?? g.stateCode;
    }
  }
  const selectedCountryRegionsRaw =
    subnat1ByCountry.find((s) => s.country === selectedCountry)?.list ??
    (await subnational1Of(selectedCountry)).map((r) => ({ code: r.code, name: r.name }));
  // Nearest-first (Gaylon 2026-08-29). Coordinates come from the regions
  // table — no live lookups, no per-page fetch budget.
  const selectedCountryRegions = sortByProximity(
    selectedCountryRegionsRaw,
    home,
    await regionCoordsFor(selectedCountryRegionsRaw.map((s) => s.code)),
  );
  const countryCentroids = await regionCoordsFor(countryList.map((c) => c.code));

  for (const g of groups.values()) {
    g.countyBlocks.sort((a, b) => a.countyName.localeCompare(b.countyName));
    for (const b of g.countyBlocks) {
      b.mapQuery = countyMapQuery(b.countyCode, b.countyName, g.stateName);
    }
    g.hotspotCount =
      g.stateHotspots.length +
      g.countyBlocks.reduce((n, b) => n + b.hotspots.length, 0);
  }
  // Ungrouped/unsorted for now — final ordering happens after the US /
  // country-section partition below, since a level:"country" scratch entry
  // never itself appears in the sorted output.
  const allGroups = [...groups.values()];
  // Child-region totals per loaded group (cache-first region lists) so each
  // group can say "1 of 16 counties" and offer the analyze action (GBV:
  // Maine had zero counties and no way to populate them from this page).
  // Subnational1 groups' children are subnational2 (unchanged); a
  // country-level (scratch) group's children are subnational1 — those are
  // their own StateGroup entries in `groups` (nested into the CountrySection
  // below once loaded), so "loaded" is counted by checking whether each
  // child code already has a group with a stored row, not via countyBlocks
  // (which only ever nests subnational2).
  const countyNames = new Map<string, string>(); // subnational2 (or, for a
  // country group's children, subnational1) code -> display name.
  {
    await Promise.all(
      allGroups.map(async (g) => {
        const childLvl = childLevel(g.level);
        if (!childLvl || (childLvl === "subnational2" && !apiKey)) {
          g.countyTotal = null;
          g.countyRemaining = null;
          return;
        }
        try {
          // A country group's children come from the LOCAL reference set
          // (works without an eBird key); subnational2 county lists stay
          // live-from-eBird by design (plan decision 2).
          const list =
            childLvl === "subnational1"
              ? (await subnational1Of(g.stateCode)).map((r) => ({ code: r.code, name: r.name }))
              : (await subregions(apiKey!, g.stateCode, "subnational2")).data;
          g.countyTotal = list.length;
          for (const c of list) countyNames.set(c.code, c.name);
          // Blocks created from hotspots alone get their county's real name.
          for (const b of g.countyBlocks) {
            if (!b.county) b.countyName = countyNames.get(b.countyCode) ?? b.countyCode;
          }
          g.countyBlocks.sort((a, b) =>
            a.countyName.localeCompare(b.countyName),
          );
          g.countiesLoaded =
            g.level === "country"
              ? list.filter((c) => groups.get(c.code)?.state != null).length
              : g.countyBlocks.filter((b) => b.county).length;
          const codes = list.map((c) => c.code);
          const [meta, attempts] = await Promise.all([
            frequencyMeta(codes),
            attemptMeta(codes),
          ]);
          g.countyRemaining = coverageFromMeta(
            codes,
            meta,
            recentFailures(attempts, new Date()),
            lastCompleteYear(),
          ).remaining;
        } catch {
          g.countyTotal = null;
          g.countyRemaining = null;
        }
      }),
    );
  }
  // Subnational1 groups compute countiesLoaded from their blocks even when
  // the fetch above failed or the API key is absent (unchanged behavior).
  for (const g of allGroups) {
    if (g.level === "subnational1" && g.countyTotal == null) {
      g.countiesLoaded = g.countyBlocks.filter((b) => b.county).length;
    }
  }
  const loadedRegionCodes = new Set(
    allGroups.filter((g) => g.state).map((g) => g.stateCode),
  );
  const wholeCountryLoaded =
    groups.get(selectedCountry)?.level === "country" &&
    groups.get(selectedCountry)?.state != null;

  // Partition: US state groups stay top-level exactly as before (design
  // decision "US: UNCHANGED"). Every non-US group — whether it's the
  // country's own level:"country" scratch container or one of its
  // subnational1 children — folds into that country's single CountrySection,
  // the country's children nested inside rather than flat siblings
  // (td-f1d6da UX restructure).
  const stateGroups: StateGroup[] = [];
  const countrySections = new Map<string, CountrySection>();
  const sectionFor = (code: string, name: string): CountrySection => {
    let s = countrySections.get(code);
    if (!s) {
      s = {
        countryCode: code,
        countryName: name,
        countrywide: null,
        countryHotspots: [],
        groups: [],
        hotspotCount: 0,
        regionTotal: null,
        regionsLoaded: 0,
        regionRemaining: null,
      };
      countrySections.set(code, s);
    }
    return s;
  };
  for (const g of allGroups) {
    if (g.countryCode === "US") {
      stateGroups.push(g);
      continue;
    }
    const s = sectionFor(g.countryCode, g.countryName);
    if (g.level === "country") {
      s.countrywide = g.state;
      s.countryHotspots = g.stateHotspots;
      s.regionTotal = g.countyTotal;
      s.regionsLoaded = g.countiesLoaded;
      s.regionRemaining = g.countyRemaining;
    } else {
      s.groups.push(g);
    }
  }
  stateGroups.sort((a, b) => a.stateName.localeCompare(b.stateName));
  for (const s of countrySections.values()) {
    s.groups.sort((a, b) => a.stateName.localeCompare(b.stateName));
    s.hotspotCount =
      s.countryHotspots.length +
      s.groups.reduce((n, g) => n + g.hotspotCount, 0);
  }
  const sortedCountrySections = [...countrySections.values()].sort((a, b) =>
    a.countryName.localeCompare(b.countryName),
  );

  // US pinned first (AGY-accepted pin 2 — the template also pulls US into
  // its own optgroup regardless of array position, so this only orders
  // "All countries"); everything else nearest-home-first when home is known
  // (Gaylon 2026-08-29), else the original alphabetical fallback.
  const sortedCountries = sortByProximity(
    countryList,
    home,
    countryCentroids,
    DEFAULT_COUNTRY,
  );

  // Country-qualified labels for the failed-loads list (rev 3: it mixes
  // countries, so bare "Bornholm" would be ambiguous there).
  const failedRegionLabels = await regionLabels(
    failedRes.rows
      .map((r) => (r.region_code ? parseRegionCode(r.region_code) : null))
      .filter((x): x is NonNullable<typeof x> => x?.level === "subnational1")
      .map((x) => x.code),
  );

  return {
    hasHome: home != null,
    stateGroups,
    countrySections: sortedCountrySections,
    orphanHotspots,
    failed: failedRes.rows.map((r) => {
      const parsed = r.region_code ? parseRegionCode(r.region_code) : null;
      let regionName: string | null = null;
      if (parsed?.level === "subnational2") {
        const parent = parentOf(parsed.code)!;
        // "Sears Island · Hancock, Maine" beats "L602509 · US-ME-009".
        regionName = `${countyNames.get(parsed.code) ?? parsed.code}, ${regionDisplayName.get(parent) ?? countryName.get(parent) ?? parent}`;
      } else if (parsed?.level === "subnational1") {
        // Qualified ("Bornholm, Denmark") — this list mixes countries (rev 3).
        regionName =
          failedRegionLabels.get(parsed.code) ??
          regionDisplayName.get(parsed.code) ??
          parsed.code;
      } else if (parsed?.level === "country") {
        regionName = countryName.get(parsed.code) ?? parsed.code;
      } else if (r.region_code) {
        regionName = r.region_code;
      }
      return {
        locCode: r.loc_code,
        lastAttemptAt: r.last_attempt_at,
        error: r.error,
        locName: r.loc_name,
        regionName,
      };
    }),
    frequencyCorrections: correctionsRes.rows.map((r) => ({
      locCode: r.loc_code,
      locName: r.loc_name,
      speciesCode: r.species_code,
      speciesName: r.com_name,
      week: Number(r.week),
      originalFreq: Number(r.original_freq),
      storedFreq: Number(r.stored_freq),
      sampleSize: Number(r.sample_size),
      detectedAt: r.detected_at,
    })),
    countries: sortedCountries,
    selectedCountry,
    states: selectedCountryRegions.filter((s) => !loadedRegionCodes.has(s.code)),
    wholeCountryLoaded,
    hasApiKey: !!apiKey,
    hasLogin,
    isViewer,
    nextEnrichmentScanAt: nextScan.rows[0]?.next_retry_at ?? null,
  };
};

export const actions: Actions = {
  /**
   * Load a whole region's frequency data (1 eBird request) — a subnational1
   * region (a US state, a Norwegian fylke) or, for countries with no/coarse
   * subnational1, the whole country ("Entire Iceland"). The code is
   * re-validated against the official eBird list — form values are never
   * trusted as fetch targets.
   */
  loadRegion: async ({ locals, request }) => {
    const userId = locals.scopeId!;
    const form = await request.formData();
    const regionCode = (form.get("region") ?? "").toString();
    const parsed = parseRegionCode(regionCode);

    if (!parsed || parsed.level === "subnational2") {
      return fail(400, { error: "Unrecognized region code." });
    }
    const apiKey = await getEbirdApiKey(userId);
    if (!apiKey) {
      return fail(400, {
        error: "An eBird API key is required to list regions — add one in Settings.",
      });
    }
    // Local reference-set validation (Phase 3) — no network failure mode.
    const validated = await validateRegionCode(parsed.code);
    if (!validated) return fail(400, { error: "eBird doesn't list that region." });
    const name = validated.name;

    const label =
      parsed.level === "country" ? `${name} — countrywide` : `${name} statewide`;
    const { jobId, deduped } = await enqueueJob({
      type: "load_region",
      payload: {
        locs: [{ code: parsed.code, kind: "region", name, regionCode: parsed.code }],
      },
      dedupKey: dedupKeys.loadRegion(parsed.code),
      requestedBy: userId,
      label,
    });
    return { queued: { jobId, deduped, label } };
  },

  /**
   * Analyze ALL of a region's children as one background job — child data is
   * species-agnostic, so it can be populated from this page as well as from
   * the species forecast. Enqueue-time resolution (CODEX1 #1): the official
   * child list is snapshotted into the payload here. For a subnational1
   * region the children are subnational2 counties; for a country they're
   * subnational1 regions.
   */
  analyzeCounties: async ({ locals, request }) => {
    const userId = locals.scopeId!;
    const form = await request.formData();
    const regionCode = (form.get("region") ?? "").toString();
    const parsed = parseRegionCode(regionCode);
    if (!parsed || parsed.level === "subnational2") {
      return fail(400, { error: "Unrecognized region code." });
    }
    const childLvl = childLevel(parsed.level);
    if (!childLvl) {
      return fail(400, { error: "That region has no child regions to analyze." });
    }
    const apiKey = await getEbirdApiKey(userId);
    if (!apiKey) {
      return fail(400, {
        error: "An eBird API key is required to list counties — add one in Settings.",
      });
    }
    const validated = await validateRegionCode(parsed.code);
    if (!validated) {
      return fail(400, { error: "eBird doesn't list that region." });
    }
    const regionName = validated.name;
    let children: { code: string; name: string }[];
    if (childLvl === "subnational1") {
      // Country parent: the child snapshot comes from the LOCAL reference set
      // (Phase 3 worker guard, filter-at-enqueue) — the payload can never
      // name a subnational1 code the regions seed doesn't cover, which is
      // what makes the 0045 FK safe on this path.
      children = (await subnational1Of(parsed.code)).map((r) => ({
        code: r.code,
        name: r.name,
      }));
    } else {
      // Subnational1 parent: county (sub2) lists stay live-from-eBird by
      // design (plan decision 2 — counties are outside the seed).
      try {
        children = (await subregions(apiKey, parsed.code, "subnational2")).data;
      } catch (err) {
        return fail(502, {
          error:
            err instanceof EbirdError
              ? err.message
              : "Could not list child regions for that region.",
        });
      }
    }
    if (children.length === 0) {
      return fail(404, { error: "eBird lists no child regions for that region." });
    }

    // "Counties" wording only for US states — every other case (non-US
    // subnational1 regions, or any country-level load) says "regions".
    const noun = parsed.level === "subnational1" && parsed.country === "US" ? "counties" : "regions";
    const label = `${children.length} ${regionName} ${noun}`;
    const { jobId, deduped } = await enqueueJob({
      type: "analyze_counties",
      payload: { regionCode: parsed.code, regionName, counties: children },
      dedupKey: dedupKeys.analyzeCounties(parsed.code),
      requestedBy: userId,
      label,
    });
    return { queued: { jobId, deduped, label } };
  },

  /**
   * Load EVERY eBird hotspot in one county (or, for countries without
   * subnational2, one region) — td-372d2a. Shared with the hotspot page via
   * sweepAreaHotspots so both offer the identical sweep.
   */
  loadCountyHotspots: async ({ locals, request }) => {
    const userId = locals.scopeId!;
    const form = await request.formData();
    const areaCode = (form.get("county") ?? "").toString().trim();
    const res = await sweepAreaHotspots(userId, areaCode);
    if (!res.ok) return fail(res.status, { error: res.error });
    return {
      queued: { jobId: res.jobId, deduped: res.deduped, label: res.label },
    };
  },

  /**
   * Force-refresh one stored location. Target validated against
   * frequency_fetch itself — only previously loaded (and therefore previously
   * validated) locations qualify.
   */
  refresh: async ({ locals, request }) => {
    const userId = locals.scopeId!;
    const form = await request.formData();
    const locCode = (form.get("loc") ?? "").toString().trim();

    const stored = await query<{
      loc_code: string;
      loc_kind: "region" | "hotspot";
      loc_name: string;
      region_code: string | null;
    }>(
      `SELECT loc_code, loc_kind, loc_name, region_code
         FROM frequency_fetch WHERE loc_code = $1`,
      [locCode],
    );
    const row = stored.rows[0];
    if (!row) {
      return fail(400, { error: "That location has no stored data." });
    }

    const { jobId, deduped } = await enqueueJob({
      type: "refresh_loc",
      payload: {
        locs: [
          {
            code: row.loc_code,
            kind: row.loc_kind,
            name: row.loc_name,
            regionCode: row.region_code,
          },
        ],
        force: true,
      },
      dedupKey: dedupKeys.refreshLoc(row.loc_code),
      requestedBy: userId,
      label: `Refresh ${row.loc_name}`,
    });
    return { queued: { jobId, deduped, label: `Refresh ${row.loc_name}` } };
  },

  /**
   * Retry a failed load. Target validated against the recorded attempt —
   * only locations a validated action already tried to fetch qualify.
   */
  retry: async ({ locals, request }) => {
    const userId = locals.scopeId!;
    const form = await request.formData();
    const locCode = (form.get("loc") ?? "").toString().trim();

    const attempt = await query<{
      loc_code: string;
      loc_kind: "region" | "hotspot" | null;
      loc_name: string | null;
      region_code: string | null;
    }>(
      `SELECT loc_code, loc_kind, loc_name, region_code
         FROM frequency_fetch_attempts WHERE loc_code = $1 AND status = 'error'`,
      [locCode],
    );
    const row = attempt.rows[0];
    if (!row) {
      return fail(400, { error: "No failed attempt recorded for that location." });
    }

    // Attempts recorded before migration 0012 lack context: infer the kind
    // from the code shape and try the ebird_locations metadata for a real name.
    let name = row.loc_name;
    if (!name) {
      const known = await query<{ loc_name: string }>(
        "SELECT loc_name FROM ebird_locations WHERE loc_id = $1",
        [row.loc_code],
      );
      name = known.rows[0]?.loc_name ?? row.loc_code;
    }

    const { jobId, deduped } = await enqueueJob({
      type: "retry_loc",
      payload: {
        locs: [
          {
            code: row.loc_code,
            kind:
              row.loc_kind ?? (row.loc_code.startsWith("L") ? "hotspot" : "region"),
            name,
            regionCode: row.region_code,
          },
        ],
        force: true,
      },
      dedupKey: dedupKeys.retryLoc(row.loc_code),
      requestedBy: userId,
      label: `Retry ${name}`,
    });
    return { queued: { jobId, deduped, label: `Retry ${name}` } };
  },
};
