import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import {
  getEbirdApiKey,
  hotspotsInRegion,
  subregions,
  EbirdError,
  type EbirdHotspot,
} from "$server/ebird";
import {
  countriesList,
  regionCoordsFor,
  subnational1Of,
  validateRegionCode,
} from "$server/regions";
import {
  attemptMeta,
  frequencyMeta,
  lastCompleteYear,
} from "$server/barchart";
import { enqueueJob } from "$server/jobs";
import { dedupKeys } from "$server/job-policy";
import { countyMapQuery, countySeat } from "$server/county-meta";
import { returnTrail } from "$lib/return-link";
import {
  parseRegionCode,
  isCountry,
  childLevel,
  parentOf,
  regionLevel,
} from "$lib/region-code";
import {
  selectCountyHotspots,
  calendarMonth,
  COUNTY_HOTSPOT_LIMIT,
  coverageFromMeta,
  bestMonthsByLoc,
  rankLocsForSpeciesMonth,
  recentFailures,
  speciesLocForecast,
  sortByProximity,
  type RankedLoc,
} from "$server/forecast";

const SPECIES_CODE_RE = /^[a-z0-9]{4,12}$/;

interface SpeciesMatch {
  species_code: string;
  com_name: string;
  sci_name: string;
}

function parseMonth(raw: string | null): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

/** The county drill can expand its hotspot pool in steps up to this cap. */
const COUNTY_HOTSPOT_MAX = 24;

function parseHotspotLimit(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= COUNTY_HOTSPOT_LIMIT && n <= COUNTY_HOTSPOT_MAX
    ? n
    : COUNTY_HOTSPOT_LIMIT;
}


// IMPORTANT (loader invariant, see src/routes/+page.server.ts): read query
// params ONLY via url.searchParams.get(key). This loader reads cached data
// only — barchartData fetching happens exclusively in the actions below.
export const load: PageServerLoad = async ({ locals, url }) => {
  const userId = locals.scopeId!;
  const isViewer = locals.user?.role === "viewer";

  const q = (url.searchParams.get("q") ?? "").trim();
  const speciesParam = (url.searchParams.get("species") ?? "").trim();
  const regionParam = (url.searchParams.get("region") ?? "").trim();
  const monthParam = parseMonth(url.searchParams.get("month"));
  const countyParam = (url.searchParams.get("county") ?? "").trim();
  const hotspotLimit = parseHotspotLimit(url.searchParams.get("hs"));

  const apiKey = await getEbirdApiKey(userId);
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

  // Countries (world list), for the country picker + country-level region
  // validation — local reference data (regions table, refactor plan Phase 3).
  // No eBird call, no API key needed: the picker works for key-less users
  // and viewers, who previously got an empty picker and a regionError.
  const countryList: { code: string; name: string }[] = (await countriesList()).map(
    (r) => ({ code: r.code, name: r.name }),
  );

  // Country param: explicit ?country=, else the selected region's own
  // country (deep links keep working), else US.
  const countryParamRaw = (url.searchParams.get("country") ?? "").trim().toUpperCase();
  let country = countryParamRaw;
  if (!country) {
    const parsedRegion = regionParam ? parseRegionCode(regionParam) : null;
    country = parsedRegion?.country ?? "US";
  }
  // Keep the picker, hidden GET field, and region list on a real country.
  // The reference set is always complete, so the old "list unavailable —
  // fall back to syntax-valid" ladder no longer has a state to cover.
  if (!isCountry(country) || !countryList.some((c) => c.code === country)) {
    country = "US";
  }

  // Subnational1 regions of the selected country — local reference data.
  let states: { code: string; name: string }[] = (await subnational1Of(country)).map(
    (r) => ({ code: r.code, name: r.name }),
  );
  // Nearest-first within the selected country (Gaylon 2026-08-29): a country
  // the size of Norway or Australia is a scroll otherwise. Coordinates come
  // from the regions table — no live lookups, no per-page fetch budget.
  const stateCentroids = await regionCoordsFor(states.map((s) => s.code));
  states = sortByProximity(states, home, stateCentroids);
  const countryCentroids = await regionCoordsFor(countryList.map((c) => c.code));

  // Selected species (validated against the taxonomy — never echoed blindly).
  let taxon: SpeciesMatch | null = null;
  let speciesError: string | null = null;
  if (speciesParam) {
    if (!SPECIES_CODE_RE.test(speciesParam)) {
      speciesError = "Unrecognized species code.";
    } else {
      const r = await query<SpeciesMatch>(
        `SELECT species_code, com_name, sci_name FROM taxonomy_cache
          WHERE species_code = $1 AND category = 'species'`,
        [speciesParam],
      );
      taxon = r.rows[0] ?? null;
      if (!taxon)
        speciesError = `Species code "${speciesParam}" not found — is the taxonomy synced?`;
    }
  }

  // Selected region, validated by syntax + membership in the reference set
  // (country-level or subnational1 — a whole-country load like "IS" works).
  let region: { code: string; name: string } | null = null;
  let regionError: string | null = null;
  if (regionParam) {
    const validated = await validateRegionCode(regionParam);
    if (validated) region = { code: validated.code, name: validated.name };
    else regionError = "Unrecognized region code.";
  }

  // Species search (server-side, taxonomy cache only). Word gaps become
  // wildcards so "storm petrel" finds "Wilson's Storm-Petrel", "screech owl"
  // finds "Eastern Screech-Owl", etc. When the selected region's data is
  // loaded, results are BOUNDED to species actually reported there, ordered
  // by how frequently they occur — "which storm-petrel?" answers itself.
  // Falls back to the full taxonomy (flagged) when nothing matches in-region.
  let speciesMatches: SpeciesMatch[] = [];
  let searchScope: "state" | "all" = "all";
  let searchFellBack = false;
  if (q) {
    const fuzzy = q
      .replace(/[\\%_]/g, "\\$&")
      .replace(/[^a-zA-Z0-9\\%_]+/g, "%");
    const stateWithData = region
      ? ((await frequencyMeta([region.code])).has(region.code) ? region.code : null)
      : null;
    if (stateWithData) {
      const r = await query<SpeciesMatch>(
        `SELECT tc.species_code, tc.com_name, tc.sci_name
           FROM taxonomy_cache tc
          WHERE tc.category = 'species'
            AND (tc.com_name ILIKE $1 OR tc.sci_name ILIKE $1)
            AND EXISTS (SELECT 1 FROM species_frequency sf
                         WHERE sf.loc_code = $2 AND sf.species_code = tc.species_code)
          ORDER BY (
            SELECT SUM(COALESCE(sf.freq, 0) * ss.n) / NULLIF(SUM(ss.n), 0)
              FROM frequency_fetch ff
              JOIN LATERAL unnest(ff.sample_sizes) WITH ORDINALITY AS ss(n, week)
                ON TRUE
              LEFT JOIN species_frequency sf
                ON sf.loc_code = ff.loc_code
               AND sf.species_code = tc.species_code
               AND sf.week = ss.week
             WHERE ff.loc_code = $2
          ) DESC NULLS LAST,
                   tc.com_name
          LIMIT 12`,
        [`%${fuzzy}%`, stateWithData],
      );
      speciesMatches = r.rows;
      searchScope = "state";
    }
    if (speciesMatches.length === 0) {
      const r = await query<SpeciesMatch>(
        `SELECT species_code, com_name, sci_name FROM taxonomy_cache
          WHERE category = 'species' AND (com_name ILIKE $1 OR sci_name ILIKE $1)
          ORDER BY (com_name ILIKE $2) DESC, com_name
          LIMIT 12`,
        [`%${fuzzy}%`, `${fuzzy}%`],
      );
      searchFellBack = searchScope === "state" && r.rows.length > 0;
      speciesMatches = r.rows;
      searchScope = "all";
    }
  }

  const forecast =
    taxon && region
      ? await speciesLocForecast(region.code, taxon.species_code)
      : null;
  const attempt = region
    ? ((await attemptMeta([region.code])).get(region.code) ?? null)
    : null;

  // The month the "where" sections use: explicit choice > best month > current.
  const month =
    monthParam ?? forecast?.best?.month ?? calendarMonth();

  // ---- County analysis (cached reads only) ------------------------------
  // "County" here means the region's direct children: subnational2 counties
  // under a subnational1 region (unchanged US behavior), or subnational1
  // regions under a whole-country region (td-f1d6da — e.g. Norway's fylker
  // under a countrywide "NO" load).
  const newestYear = lastCompleteYear();
  const regionChildLevel = region ? childLevel(regionLevel(region.code)!) : null;
  let counties: { code: string; name: string }[] = [];
  let countyError: string | null = null;
  let countyCoverage: {
    total: number;
    current: number;
    stale: number;
    failed: number;
    remaining: number;
  } | null = null;
  let countyRanking: (RankedLoc & {
    seat: string | null;
    mapQuery: string;
  })[] = [];
  let countyPeaks: Record<string, { month: number; freq: number }> = {};
  let countyDataYears: { begin: number; end: number } | null = null;
  if (taxon && region && regionChildLevel) {
    if (apiKey) {
      try {
        // regionChildLevel is never "country" — it is childLevel() of a
        // country|subnational1 region, i.e. always subnational1|subnational2.
        counties = (
          await subregions(apiKey, region.code, regionChildLevel as "subnational1" | "subnational2")
        ).data;
      } catch (err) {
        countyError =
          err instanceof EbirdError
            ? err.message
            : "Could not load the region list from eBird — try again shortly.";
      }
    }
    if (counties.length === 0) {
      const stored = await query<{ loc_code: string; loc_name: string }>(
        `SELECT loc_code, loc_name FROM frequency_fetch
          WHERE loc_kind = 'region' AND loc_code LIKE $1
          ORDER BY loc_name`,
        [`${region.code}-%`],
      );
      // LIKE alone also matches grandchildren under a country-level region
      // (e.g. 'US-FL-057' under 'US') — keep only direct children.
      counties = stored.rows
        .filter((r) => parentOf(r.loc_code) === region!.code)
        .map((r) => ({
          code: r.loc_code,
          name: r.loc_name,
        }));
    }
    if (counties.length > 0) {
      const codes = counties.map((c) => c.code);
      const [meta, attempts] = await Promise.all([
        frequencyMeta(codes),
        attemptMeta(codes),
      ]);
      // Annual-window semantics: stale rows still rank (fail-soft, labeled)
      // but count toward `remaining`, so the analyze action reappears after a
      // year rollover instead of reporting a stale state as complete.
      const cov = coverageFromMeta(
        codes,
        meta,
        recentFailures(attempts, new Date()),
        newestYear,
      );
      countyCoverage = {
        total: counties.length,
        current: cov.current.length,
        stale: cov.stale.length,
        failed: cov.failed.length,
        remaining: cov.remaining,
      };
      const usable = [...cov.current, ...cov.stale];
      // Each county carries its seat + a Maps query that outlines the county
      // (td-01ddb6 — "I don't know Florida much by counties").
      countyRanking = (
        await rankLocsForSpeciesMonth(usable, taxon.species_code, month)
      ).map((c) => ({
        ...c,
        seat: countySeat(c.code),
        mapQuery: countyMapQuery(c.code, c.name, region.name),
      }));
      const peaks = await bestMonthsByLoc(usable, taxon.species_code);
      countyPeaks = Object.fromEntries(
        [...peaks.entries()].map(([code, b]) => [
          code,
          { month: b.month, freq: b.freq },
        ]),
      );
      const usedMetas = usable.map((c) => meta.get(c)!);
      countyDataYears = usedMetas.length
        ? {
            begin: Math.min(...usedMetas.map((m) => m.beginYear)),
            end: Math.max(...usedMetas.map((m) => m.endYear)),
          }
        : null;
    }
  }

  // ---- Hotspot drill-down for one county (cached reads only) ------------
  let county: {
    code: string;
    name: string;
    seat: string | null;
    mapQuery: string;
  } | null = null;
  let hotspotError: string | null = null;
  let countyHotspots: {
    selected: {
      locId: string;
      locName: string;
      lat: number;
      lng: number;
      hasData: boolean;
      current: boolean;
    }[];
    ranking: RankedLoc[];
    hotspotListStale: boolean;
    dataYears: { begin: number; end: number } | null;
    limit: number;
    maxLimit: number;
    totalInCounty: number;
  } | null = null;
  if (
    countyParam &&
    region &&
    regionChildLevel &&
    regionLevel(countyParam) === regionChildLevel &&
    countyParam.startsWith(`${region.code}-`)
  ) {
    const found = counties.find((c) => c.code === countyParam) ?? null;
    county = found
      ? {
          ...found,
          seat: countySeat(found.code),
          mapQuery: countyMapQuery(found.code, found.name, region.name),
        }
      : null;
    if (county && taxon) {
      try {
        // Cache-first: a fresh ebird_cache hit does not use the key.
        const hs = await hotspotsInRegion(apiKey ?? "", county.code);
        const selected = selectCountyHotspots(hs.data, hotspotLimit);
        const meta = await frequencyMeta(selected.map((h) => h.locId));
        const stored = selected.filter((h) => meta.has(h.locId));
        const storedMetas = stored.map((h) => meta.get(h.locId)!);
        countyHotspots = {
          selected: selected.map((h) => ({
            locId: h.locId,
            locName: h.locName,
            lat: h.lat,
            lng: h.lng,
            hasData: meta.has(h.locId),
            current: (meta.get(h.locId)?.endYear ?? 0) >= newestYear,
          })),
          ranking: await rankLocsForSpeciesMonth(
            stored.map((h) => h.locId),
            taxon.species_code,
            month,
          ),
          hotspotListStale: hs.stale,
          dataYears: storedMetas.length
            ? {
                begin: Math.min(...storedMetas.map((m) => m.beginYear)),
                end: Math.max(...storedMetas.map((m) => m.endYear)),
              }
            : null,
          limit: hotspotLimit,
          maxLimit: COUNTY_HOTSPOT_MAX,
          totalInCounty: hs.data.length,
        };
      } catch (err) {
        countyHotspots = null;
        hotspotError =
          err instanceof EbirdError
            ? err.message
            : "Could not load the hotspot list for that county — try again shortly.";
      }
    }
  }

  // US pinned first (AGY-accepted pin 2 — the template also pulls US into
  // its own optgroup regardless of array position, so this only orders
  // "All countries"); everything else nearest-home-first when home is known
  // (Gaylon 2026-08-29), else the original alphabetical fallback.
  const sortedCountries = sortByProximity(countryList, home, countryCentroids, "US");

  return {
    q,
    hasHome: home != null,
    speciesMatches,
    searchScope,
    searchFellBack,
    taxon,
    speciesError,
    region,
    regionError,
    countries: sortedCountries,
    country,
    states,
    forecast,
    attempt,
    month,
    countyError,
    countyCoverage,
    countyRanking,
    countyPeaks,
    countyDataYears,
    county,
    hotspotError,
    countyHotspots,
    hasApiKey: !!apiKey,
    hasLogin,
    isViewer,
    // Breadcrumb back to wherever this drill started — the species page's
    // "Where should I go?" link, and the field guide behind it (Gaylon
    // 2026-08-29). Absent when the page was opened straight from the nav.
    crumbs: returnTrail(url.searchParams.get("returnTo")).map((c) =>
      c.speciesCode && c.speciesCode === taxon?.species_code
        ? { href: c.href, label: taxon.com_name }
        : { href: c.href, label: c.label },
    ),
  };
};

export const actions: Actions = {
  /**
   * Fetch/refresh the region-level barchart (1 eBird request). Owner-only
   * (viewers are blocked from POSTs in hooks.server.ts). The region is
   * re-validated server-side against the official eBird list — form values
   * are never trusted as fetch targets.
   */
  loadState: async ({ locals, request }) => {
    const userId = locals.scopeId!;
    const form = await request.formData();
    const regionCode = (form.get("region") ?? "").toString();
    const force = form.get("force") === "1";

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
    // Local reference-set validation (Phase 3) — no network failure mode,
    // so the old "could not verify against eBird" 502 branch is gone.
    const validated = await validateRegionCode(parsed.code);
    if (!validated) {
      return fail(400, { error: "eBird doesn't list that region." });
    }
    const stateName = validated.name;

    const label =
      parsed.level === "country" ? `${stateName} — countrywide` : `${stateName} statewide`;
    const { jobId, deduped } = await enqueueJob({
      type: "load_region",
      payload: {
        locs: [{ code: parsed.code, kind: "region", name: stateName, regionCode: parsed.code }],
        force,
      },
      dedupKey: dedupKeys.loadRegion(parsed.code),
      requestedBy: userId,
      label,
    });
    return { queued: { jobId, deduped, label } };
  },

  /**
   * Analyze ALL of a region's children as ONE job. Enqueue-time resolution
   * (CODEX1 #1): the official region is validated and the full child list is
   * resolved HERE and written into the payload — the worker consumes that
   * snapshot and never re-derives or re-authorizes targets.
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
    let counties: { code: string; name: string }[];
    if (childLvl === "subnational1") {
      // Country parent: the child snapshot comes from the LOCAL reference set
      // (Phase 3 worker guard, filter-at-enqueue) — the payload can therefore
      // never name a subnational1 code the regions seed doesn't cover, which
      // is what makes the 0045 FK safe on this path.
      counties = (await subnational1Of(parsed.code)).map((r) => ({
        code: r.code,
        name: r.name,
      }));
    } else {
      // Subnational1 parent: county (sub2) lists stay live-from-eBird by
      // design (plan decision 2 — counties are outside the seed).
      try {
        counties = (await subregions(apiKey, parsed.code, "subnational2")).data;
      } catch (err) {
        return fail(502, {
          error:
            err instanceof EbirdError
              ? err.message
              : "Could not list child regions for that region.",
        });
      }
    }
    if (counties.length === 0) {
      return fail(404, { error: "eBird lists no child regions for that region." });
    }

    // "Counties" wording only for US states — every other case (non-US
    // subnational1 regions, or any country-level load) says "regions".
    const noun = parsed.level === "subnational1" && parsed.country === "US" ? "counties" : "regions";
    const label = `${counties.length} ${regionName} ${noun}`;
    const { jobId, deduped } = await enqueueJob({
      type: "analyze_counties",
      payload: { regionCode: parsed.code, regionName, counties },
      dedupKey: dedupKeys.analyzeCounties(parsed.code),
      requestedBy: userId,
      label,
    });
    return { queued: { jobId, deduped, label } };
  },

  /**
   * Load barchart data for one county's top hotspots (≤ COUNTY_HOTSPOT_LIMIT
   * eBird requests). The SELECTED REGION is validated as an official eBird
   * region and the county must belong to it (CODEX8 #2: a forged county from
   * another region must be rejected, not validated against its own forged
   * region).
   */
  loadHotspots: async ({ locals, request }) => {
    const userId = locals.scopeId!;
    const form = await request.formData();
    const regionCode = (form.get("region") ?? "").toString();
    const countyCode = (form.get("county") ?? "").toString().trim();
    const limit = parseHotspotLimit((form.get("limit") ?? "").toString());

    const parsed = parseRegionCode(regionCode);
    if (!parsed || parsed.level === "subnational2") {
      return fail(400, { error: "Unrecognized region code." });
    }
    const childLvl = childLevel(parsed.level);
    if (
      !childLvl ||
      !parseRegionCode(countyCode) ||
      !countyCode.startsWith(`${parsed.code}-`)
    ) {
      return fail(400, { error: "That county is not in the selected region." });
    }
    const apiKey = await getEbirdApiKey(userId);
    if (!apiKey) {
      return fail(400, {
        error: "An eBird API key is required to list hotspots — add one in Settings.",
      });
    }

    if (!(await validateRegionCode(parsed.code))) {
      return fail(400, { error: "eBird doesn't list that region." });
    }
    let selected: EbirdHotspot[];
    try {
      // childLvl is never "country" — parsed.level here is country|subnational1.
      const counties = (
        await subregions(apiKey, parsed.code, childLvl as "subnational1" | "subnational2")
      ).data;
      if (!counties.some((c) => c.code === countyCode)) {
        return fail(400, { error: "That county is not in the selected region." });
      }
      selected = selectCountyHotspots(
        (await hotspotsInRegion(apiKey, countyCode)).data,
        limit,
      );
    } catch (err) {
      return fail(502, {
        error:
          err instanceof EbirdError
            ? err.message
            : "Could not list hotspots for that county.",
      });
    }
    if (selected.length === 0) {
      return fail(404, { error: "eBird lists no hotspots in that county." });
    }

    const locs = selected.map((h) => ({
      code: h.locId,
      kind: "hotspot" as const,
      name: h.locName,
      // Most specific containing region: the drilled county (all these
      // hotspots belong to it) so /forecast/data nests them under it.
      regionCode: h.subnational2Code ?? countyCode,
    }));
    const label = `${locs.length} hotspot${locs.length === 1 ? "" : "s"} in ${countyCode}`;
    const { jobId, deduped } = await enqueueJob({
      type: "load_hotspots",
      payload: { locs },
      dedupKey: dedupKeys.loadHotspots(locs.map((l) => l.code)),
      requestedBy: userId,
      label,
    });
    return { queued: { jobId, deduped, label } };
  },
};
