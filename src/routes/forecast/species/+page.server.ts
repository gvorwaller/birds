import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import {
  getEbirdApiKey,
  hotspotsInRegion,
  subregions,
  countries as ebirdCountries,
  EbirdError,
  type EbirdHotspot,
} from "$server/ebird";
import {
  attemptMeta,
  frequencyMeta,
  lastCompleteYear,
} from "$server/barchart";
import { enqueueJob } from "$server/jobs";
import { dedupKeys } from "$server/job-policy";
import { countyMapQuery, countySeat } from "$server/county-meta";
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

  // Countries (world list), for the country picker + country-level region
  // validation. Cache-first with stale fallback (cs.md).
  let countryList: { code: string; name: string }[] = [];
  let statesError: string | null = null;
  if (apiKey) {
    try {
      countryList = (await ebirdCountries(apiKey)).data;
    } catch (err) {
      statesError =
        err instanceof EbirdError
          ? err.message
          : "Could not load the country list.";
    }
  }

  // Country param: explicit ?country=, else the selected region's own
  // country (deep links keep working), else US.
  const countryParamRaw = (url.searchParams.get("country") ?? "").trim().toUpperCase();
  let country = countryParamRaw;
  if (!country) {
    const parsedRegion = regionParam ? parseRegionCode(regionParam) : null;
    country = parsedRegion?.country ?? "US";
  }
  // Keep the picker, hidden GET field, and region list on a real country.
  // When the official list is unavailable, retain the existing syntax-only
  // fallback so cached international forecast data can still render.
  if (
    !isCountry(country) ||
    (countryList.length > 0 && !countryList.some((c) => c.code === country))
  ) {
    country = "US";
  }

  // Subnational1 regions of the selected country (cache-first, 30-day TTL,
  // stale fallback) — drives the region picker.
  let states: { code: string; name: string }[] = [];
  let statesStale = false;
  if (apiKey && !statesError) {
    try {
      const r = await subregions(apiKey, country, "subnational1");
      states = r.data;
      statesStale = r.stale;
    } catch (err) {
      statesError =
        err instanceof EbirdError
          ? err.message
          : "Could not load the region list.";
    }
  }

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

  // Selected region, validated by syntax + membership in the country's
  // region list (subnational1) or the world country list (country-level —
  // a whole-country load, e.g. "IS").
  let region: { code: string; name: string } | null = null;
  let regionError: string | null = null;
  if (regionParam) {
    const parsed = parseRegionCode(regionParam);
    if (!parsed || parsed.level === "subnational2") {
      regionError = "Unrecognized region code.";
    } else if (parsed.level === "country") {
      const match = countryList.find((c) => c.code === parsed.code);
      if (match) region = match;
      else if (countryList.length > 0) regionError = "eBird doesn't list that region.";
      // With no country list (no API key / API down) fall back to
      // syntax-valid: cached forecast data can still render read-only.
      else region = { code: parsed.code, name: parsed.code };
    } else {
      const match = states.find((s) => s.code === parsed.code);
      if (match) region = match;
      else if (states.length > 0) regionError = "eBird doesn't list that region.";
      else region = { code: parsed.code, name: parsed.code };
    }
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

  // US pinned first, then alphabetical by display name (AGY-accepted pin 2).
  const sortedCountries = [...countryList].sort((a, b) => {
    if (a.code === "US") return -1;
    if (b.code === "US") return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    q,
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
    statesStale,
    statesError,
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
  };
};

/** Validate a region against the official eBird list; returns its display
 * name. Country-level codes validate against the world country list;
 * subnational1 codes against their parent country's region list. */
async function validateRegion(
  apiKey: string,
  regionCode: string,
): Promise<string | null> {
  const parsed = parseRegionCode(regionCode);
  if (!parsed || parsed.level === "subnational2") return null;
  if (parsed.level === "country") {
    const r = await ebirdCountries(apiKey);
    return r.data.find((c) => c.code === parsed.code)?.name ?? null;
  }
  const r = await subregions(apiKey, parsed.country, "subnational1");
  return r.data.find((s) => s.code === parsed.code)?.name ?? null;
}

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
    let stateName: string | null = null;
    try {
      stateName = await validateRegion(apiKey, parsed.code);
    } catch (err) {
      return fail(502, {
        error:
          err instanceof EbirdError
            ? err.message
            : "Could not verify the region against eBird.",
      });
    }
    if (!stateName) {
      return fail(400, { error: "eBird doesn't list that region." });
    }

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
    let regionName: string | null = null;
    let counties: { code: string; name: string }[];
    try {
      regionName = await validateRegion(apiKey, parsed.code);
      if (!regionName) {
        return fail(400, { error: "eBird doesn't list that region." });
      }
      // childLvl is never "country" — parsed.level here is country|subnational1.
      counties = (
        await subregions(apiKey, parsed.code, childLvl as "subnational1" | "subnational2")
      ).data;
    } catch (err) {
      return fail(502, {
        error:
          err instanceof EbirdError
            ? err.message
            : "Could not list child regions for that region.",
      });
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

    let selected: EbirdHotspot[];
    try {
      const regionName = await validateRegion(apiKey, parsed.code);
      if (!regionName) {
        return fail(400, { error: "eBird doesn't list that region." });
      }
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
