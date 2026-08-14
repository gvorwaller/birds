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
  attemptMeta,
  ensureFrequencies,
  frequencyMeta,
  lastCompleteYear,
  type EnsureResult,
} from "$server/barchart";
import {
  analyzeCountyBatch,
  calendarMonth,
  COUNTY_HOTSPOT_LIMIT,
  coverageFromMeta,
  bestMonthsByLoc,
  rankLocsForSpeciesMonth,
  recentFailures,
  speciesLocForecast,
  type RankedLoc,
} from "$server/forecast";

const STATE_CODE_RE = /^US-[A-Z]{2}$/;
const COUNTY_CODE_RE = /^US-[A-Z]{2}-\d{3}$/;
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

/**
 * Deterministic county drill selection: half by all-time species count, half
 * by most recent activity, deduped, remainder by species count. Pure species
 * count alone favors famous biodiversity hotspots and misses habitat
 * specialists' sites (UX doc #4); recent activity pulls in currently-birded
 * spots regardless of their all-time list length.
 */
function selectCountyHotspots(
  hotspots: EbirdHotspot[],
  limit = COUNTY_HOTSPOT_LIMIT,
): EbirdHotspot[] {
  const bySpecies = [...hotspots].sort(
    (a, b) => (b.numSpeciesAllTime ?? 0) - (a.numSpeciesAllTime ?? 0),
  );
  const byRecency = [...hotspots].sort((a, b) =>
    (b.latestObsDt ?? "").localeCompare(a.latestObsDt ?? ""),
  );
  const chosen = new Map<string, EbirdHotspot>();
  for (const h of bySpecies.slice(0, Math.ceil(limit / 2)))
    chosen.set(h.locId, h);
  for (const h of byRecency) {
    if (chosen.size >= limit) break;
    chosen.set(h.locId, h);
  }
  for (const h of bySpecies) {
    if (chosen.size >= limit) break;
    chosen.set(h.locId, h);
  }
  return bySpecies.filter((h) => chosen.has(h.locId));
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

  // US states via the official API (cache-first, 30-day TTL, stale fallback).
  let states: { code: string; name: string }[] = [];
  let statesStale = false;
  let statesError: string | null = null;
  if (apiKey) {
    try {
      const r = await subregions(apiKey, "US", "subnational1");
      states = r.data;
      statesStale = r.stale;
    } catch (err) {
      statesError =
        err instanceof EbirdError
          ? err.message
          : "Could not load the state list.";
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

  // Selected region, validated by syntax + membership in the state list.
  let region: { code: string; name: string } | null = null;
  let regionError: string | null = null;
  if (regionParam) {
    if (!STATE_CODE_RE.test(regionParam)) {
      regionError = "Unrecognized region code.";
    } else {
      const match = states.find((s) => s.code === regionParam);
      if (match) region = match;
      else if (states.length > 0) regionError = "That region is not a US state.";
      // With no state list (no API key / API down) fall back to syntax-valid:
      // cached forecast data can still render read-only.
      else region = { code: regionParam, name: regionParam };
    }
  }

  // Species search (server-side, taxonomy cache only). Word gaps become
  // wildcards so "storm petrel" finds "Wilson's Storm-Petrel", "screech owl"
  // finds "Eastern Screech-Owl", etc. When the selected state's data is
  // loaded, results are BOUNDED to species actually reported there, ordered
  // by how frequently they occur — "which storm-petrel?" answers itself.
  // Falls back to the full taxonomy (flagged) when nothing matches in-state.
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
  const newestYear = lastCompleteYear();
  let counties: { code: string; name: string }[] = [];
  let countyError: string | null = null;
  let countyCoverage: {
    total: number;
    current: number;
    stale: number;
    failed: number;
    remaining: number;
  } | null = null;
  let countyRanking: RankedLoc[] = [];
  let countyPeaks: Record<string, { month: number; freq: number }> = {};
  let countyDataYears: { begin: number; end: number } | null = null;
  if (taxon && region) {
    if (apiKey) {
      try {
        counties = (await subregions(apiKey, region.code, "subnational2")).data;
      } catch (err) {
        countyError =
          err instanceof EbirdError
            ? err.message
            : "Could not load the county list from eBird — try again shortly.";
      }
    }
    if (counties.length === 0) {
      const stored = await query<{ loc_code: string; loc_name: string }>(
        `SELECT loc_code, loc_name FROM frequency_fetch
          WHERE loc_kind = 'region' AND loc_code LIKE $1
          ORDER BY loc_name`,
        [`${region.code}-___`],
      );
      counties = stored.rows.map((r) => ({
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
      countyRanking = await rankLocsForSpeciesMonth(
        usable,
        taxon.species_code,
        month,
      );
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
  let county: { code: string; name: string } | null = null;
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
  if (countyParam && COUNTY_CODE_RE.test(countyParam) && region) {
    county = counties.find((c) => c.code === countyParam) ?? null;
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

  return {
    q,
    speciesMatches,
    searchScope,
    searchFellBack,
    taxon,
    speciesError,
    region,
    regionError,
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

/** Validate a state against the official list; returns its display name. */
async function validateState(
  apiKey: string,
  regionCode: string,
): Promise<string | null> {
  const r = await subregions(apiKey, "US", "subnational1");
  return r.data.find((s) => s.code === regionCode)?.name ?? null;
}

export const actions: Actions = {
  /**
   * Fetch/refresh the state-level barchart (1 eBird request). Owner-only
   * (viewers are blocked from POSTs in hooks.server.ts). The region is
   * re-validated server-side against the official state list — form values
   * are never trusted as fetch targets.
   */
  loadState: async ({ locals, request }) => {
    const userId = locals.scopeId!;
    const form = await request.formData();
    const regionCode = (form.get("region") ?? "").toString().trim();
    const force = form.get("force") === "1";

    if (!STATE_CODE_RE.test(regionCode)) {
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
      stateName = await validateState(apiKey, regionCode);
    } catch (err) {
      return fail(502, {
        error:
          err instanceof EbirdError
            ? err.message
            : "Could not verify the region against eBird.",
      });
    }
    if (!stateName) {
      return fail(400, { error: "That region is not a US state." });
    }

    const ensure: EnsureResult = await ensureFrequencies(
      userId,
      [{ code: regionCode, kind: "region", name: stateName, regionCode }],
      { force },
    );
    return { ensure };
  },

  /**
   * Analyze the next batch of counties for a state (≤ COUNTY_BATCH eBird
   * requests). Resumable: the client loops this action until remaining
   * reaches 0; recently failed counties sit out so the loop terminates.
   * County targets derive from the official region list, never the form.
   */
  analyzeCounties: async ({ locals, request }) => {
    const userId = locals.scopeId!;
    const form = await request.formData();
    const regionCode = (form.get("region") ?? "").toString().trim();

    if (!STATE_CODE_RE.test(regionCode)) {
      return fail(400, { error: "Unrecognized region code." });
    }
    const apiKey = await getEbirdApiKey(userId);
    if (!apiKey) {
      return fail(400, {
        error: "An eBird API key is required to list counties — add one in Settings.",
      });
    }

    const outcome = await analyzeCountyBatch(userId, apiKey, regionCode);
    if (!outcome.ok) {
      return fail(outcome.status, { error: outcome.message });
    }
    return { ensure: outcome.ensure, progress: outcome.progress };
  },

  /**
   * Load barchart data for one county's top hotspots (≤ COUNTY_HOTSPOT_LIMIT
   * eBird requests). The SELECTED STATE is validated as an official state and
   * the county must belong to it (CODEX8 #2: a forged county from another
   * state must be rejected, not validated against its own forged state).
   */
  loadHotspots: async ({ locals, request }) => {
    const userId = locals.scopeId!;
    const form = await request.formData();
    const regionCode = (form.get("region") ?? "").toString().trim();
    const countyCode = (form.get("county") ?? "").toString().trim();
    const limit = parseHotspotLimit((form.get("limit") ?? "").toString());

    if (!STATE_CODE_RE.test(regionCode)) {
      return fail(400, { error: "Unrecognized region code." });
    }
    if (!COUNTY_CODE_RE.test(countyCode) || !countyCode.startsWith(`${regionCode}-`)) {
      return fail(400, { error: "That county is not in the selected state." });
    }
    const apiKey = await getEbirdApiKey(userId);
    if (!apiKey) {
      return fail(400, {
        error: "An eBird API key is required to list hotspots — add one in Settings.",
      });
    }

    let selected: EbirdHotspot[];
    try {
      const stateName = await validateState(apiKey, regionCode);
      if (!stateName) {
        return fail(400, { error: "That region is not a US state." });
      }
      const counties = (await subregions(apiKey, regionCode, "subnational2"))
        .data;
      if (!counties.some((c) => c.code === countyCode)) {
        return fail(400, { error: "That county is not in the selected state." });
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

    const ensure: EnsureResult = await ensureFrequencies(
      userId,
      selected.map((h) => ({
        code: h.locId,
        kind: "hotspot" as const,
        name: h.locName,
        // Most specific containing region: the drilled county (all these
        // hotspots belong to it) so /forecast/data nests them under it.
        regionCode: h.subnational2Code ?? countyCode,
      })),
    );
    return { ensure };
  },
};
