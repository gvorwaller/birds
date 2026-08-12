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
  COUNTY_BATCH,
  COUNTY_HOTSPOT_LIMIT,
  coverageFromMeta,
  nextUncachedCounties,
  rankLocsForSpeciesMonth,
  speciesLocForecast,
  type RankedLoc,
} from "$server/forecast";

const STATE_CODE_RE = /^US-[A-Z]{2}$/;
const COUNTY_CODE_RE = /^US-[A-Z]{2}-\d{3}$/;
const SPECIES_CODE_RE = /^[a-z0-9]{4,12}$/;
/** A failed county sits out of the resumable loop for this long. */
const FAILED_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

interface SpeciesMatch {
  species_code: string;
  com_name: string;
  sci_name: string;
}

function parseMonth(raw: string | null): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

/** Failed-and-cooling-down county codes (excluded from the batch loop). */
function recentFailures(
  attempts: Map<string, { status: string; lastAttemptAt: Date }>,
  now: Date,
): Set<string> {
  const out = new Set<string>();
  for (const [code, a] of attempts) {
    if (
      a.status === "error" &&
      now.getTime() - a.lastAttemptAt.getTime() < FAILED_RETRY_COOLDOWN_MS
    ) {
      out.add(code);
    }
  }
  return out;
}

/** Deterministic county drill selection: top hotspots by all-time species. */
function selectCountyHotspots(hotspots: EbirdHotspot[]): EbirdHotspot[] {
  return [...hotspots]
    .sort((a, b) => (b.numSpeciesAllTime ?? 0) - (a.numSpeciesAllTime ?? 0))
    .slice(0, COUNTY_HOTSPOT_LIMIT);
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

  // Species search (server-side, taxonomy cache only).
  let speciesMatches: SpeciesMatch[] = [];
  if (q) {
    const like = `%${q}%`;
    const r = await query<SpeciesMatch>(
      `SELECT species_code, com_name, sci_name FROM taxonomy_cache
        WHERE category = 'species' AND (com_name ILIKE $1 OR sci_name ILIKE $1)
        ORDER BY (com_name ILIKE $2) DESC, com_name
        LIMIT 12`,
      [like, `${q}%`],
    );
    speciesMatches = r.rows;
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

  const forecast =
    taxon && region
      ? await speciesLocForecast(region.code, taxon.species_code)
      : null;
  const attempt = region
    ? ((await attemptMeta([region.code])).get(region.code) ?? null)
    : null;

  // The month the "where" sections use: explicit choice > best month > current.
  const month =
    monthParam ?? forecast?.best?.month ?? new Date().getMonth() + 1;

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
  let countyDataYears: { begin: number; end: number } | null = null;
  if (taxon && region && apiKey) {
    try {
      counties = (await subregions(apiKey, region.code, "subnational2")).data;
    } catch (err) {
      countyError =
        err instanceof EbirdError
          ? err.message
          : "Could not load the county list from eBird — try again shortly.";
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
  } | null = null;
  if (countyParam && COUNTY_CODE_RE.test(countyParam) && region && apiKey) {
    county = counties.find((c) => c.code === countyParam) ?? null;
    if (county && taxon) {
      try {
        const hs = await hotspotsInRegion(apiKey, county.code);
        const selected = selectCountyHotspots(hs.data);
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

    let counties: { code: string; name: string }[];
    try {
      const stateName = await validateState(apiKey, regionCode);
      if (!stateName) {
        return fail(400, { error: "That region is not a US state." });
      }
      counties = (await subregions(apiKey, regionCode, "subnational2")).data;
    } catch (err) {
      return fail(502, {
        error:
          err instanceof EbirdError
            ? err.message
            : "Could not list counties for that state.",
      });
    }
    if (counties.length === 0) {
      return fail(404, { error: "eBird lists no counties for that state." });
    }

    const codes = counties.map((c) => c.code);
    const newestYear = lastCompleteYear();
    const [meta, attempts] = await Promise.all([
      frequencyMeta(codes),
      attemptMeta(codes),
    ]);
    const before = coverageFromMeta(
      codes,
      meta,
      recentFailures(attempts, new Date()),
      newestYear,
    );
    const batch = nextUncachedCounties(
      counties,
      new Set(before.current),
      new Set(before.failed),
      COUNTY_BATCH,
    );

    const ensure: EnsureResult = await ensureFrequencies(
      userId,
      batch.map((c) => ({
        code: c.code,
        kind: "region" as const,
        name: c.name,
        regionCode,
      })),
    );

    // Progress from the DB after the batch, not from arithmetic on the
    // result — restarts, other tabs, and partial batches all stay truthful.
    // Same annual-window coverage semantics as the loader (CODEX8 P1).
    const [metaAfter, attemptsAfter] = await Promise.all([
      frequencyMeta(codes),
      attemptMeta(codes),
    ]);
    const after = coverageFromMeta(
      codes,
      metaAfter,
      recentFailures(attemptsAfter, new Date()),
      newestYear,
    );
    return {
      ensure,
      progress: {
        total: counties.length,
        current: after.current.length,
        stale: after.stale.length,
        failed: after.failed.length,
        remaining: after.remaining,
      },
    };
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
        regionCode: h.subnational1Code ?? regionCode,
      })),
    );
    return { ensure };
  },
};
