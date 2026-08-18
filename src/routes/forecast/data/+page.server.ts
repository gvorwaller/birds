import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { getEbirdApiKey, subregions, EbirdError } from "$server/ebird";
import { coverageFromMeta, recentFailures } from "$server/forecast";
import { attemptMeta, frequencyMeta, lastCompleteYear } from "$server/barchart";
import { enqueueJob } from "$server/jobs";
import { dedupKeys } from "$server/job-policy";
import { countyMapQuery, countySeat } from "$server/county-meta";

const STATE_CODE_RE = /^US-[A-Z]{2}$/;

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

/** One state's data grouped for the collapsible display (GBV request). */
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
  /** How many counties the state has in total (null when unknown). */
  countyTotal: number | null;
  /** Counties still fetchable (not current, not in failure cooldown). */
  countyRemaining: number | null;
}

interface FailedRow {
  loc_code: string;
  last_attempt_at: string;
  error: string | null;
  loc_kind: "region" | "hotspot" | null;
  loc_name: string | null;
  region_code: string | null;
}

// Inventory of stored barchart data. Reads Postgres (and the official-API
// region-list cache for state names) — never ebird.org/barchartData.
export const load: PageServerLoad = async ({ locals }) => {
  const userId = locals.scopeId!;
  const isViewer = locals.user?.role === "viewer";

  const [loadedRes, failedRes, apiKey] = await Promise.all([
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
    getEbirdApiKey(userId),
  ]);
  const credsRow = await query<{ login_set: boolean }>(
    `SELECT (login_username_enc IS NOT NULL AND login_password_enc IS NOT NULL) AS login_set
       FROM user_ebird WHERE user_id = $1`,
    [userId],
  );
  const hasLogin = credsRow.rows[0]?.login_set === true;

  // US states: populate the "Load a state" picker and translate region codes
  // (US-ME → Maine) on failed rows. Cache-first with stale fallback.
  let states: { code: string; name: string }[] = [];
  let statesError: string | null = null;
  if (apiKey) {
    try {
      states = (await subregions(apiKey, "US", "subnational1")).data;
    } catch (err) {
      statesError =
        err instanceof EbirdError
          ? err.message
          : "Could not load the state list.";
    }
  }
  const stateName = new Map(states.map((s) => [s.code, s.name]));

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

  // Group by state; within a state, hotspots nest under their county block
  // (GBV 2026-08-14 — region_code holds the county for hotspots since 0014).
  const STATE_RE = /^US-[A-Z]{2}$/;
  const COUNTY_RE = /^US-[A-Z]{2}-\d{3}$/;
  const groups = new Map<string, StateGroup>();
  const blocks = new Map<string, CountyBlock>(); // by county code
  const orphanHotspots: DataRow[] = [];
  const groupFor = (code: string): StateGroup => {
    let g = groups.get(code);
    if (!g) {
      g = {
        stateCode: code,
        stateName: stateName.get(code) ?? code,
        state: null,
        countyBlocks: [],
        stateHotspots: [],
        countiesLoaded: 0,
        hotspotCount: 0,
        countyTotal: null,
        countyRemaining: null,
      };
      groups.set(code, g);
    }
    return g;
  };
  const blockFor = (countyCode: string): CountyBlock => {
    let b = blocks.get(countyCode);
    if (!b) {
      b = {
        countyCode,
        countyName: countyCode,
        seat: countySeat(countyCode),
        mapQuery: "",
        county: null,
        hotspots: [],
      };
      blocks.set(countyCode, b);
      groupFor(countyCode.slice(0, 5)).countyBlocks.push(b);
    }
    return b;
  };
  for (const { row, regionCode } of rows) {
    if (row.locKind === "region" && STATE_RE.test(row.locCode)) {
      groupFor(row.locCode).state = row;
    } else if (row.locKind === "region" && COUNTY_RE.test(row.locCode)) {
      const b = blockFor(row.locCode);
      b.county = row;
      b.countyName = row.locName;
    } else if (row.locKind === "region") {
      orphanHotspots.push(row); // unrecognized region shape — surface, don't hide
    } else if (regionCode && COUNTY_RE.test(regionCode)) {
      blockFor(regionCode).hotspots.push(row);
    } else if (regionCode && STATE_RE.test(regionCode)) {
      groupFor(regionCode).stateHotspots.push(row);
    } else {
      orphanHotspots.push(row);
    }
  }
  for (const g of groups.values()) {
    g.countyBlocks.sort((a, b) => a.countyName.localeCompare(b.countyName));
    for (const b of g.countyBlocks) {
      b.mapQuery = countyMapQuery(b.countyCode, b.countyName, g.stateName);
    }
    g.countiesLoaded = g.countyBlocks.filter((b) => b.county).length;
    g.hotspotCount =
      g.stateHotspots.length +
      g.countyBlocks.reduce((n, b) => n + b.hotspots.length, 0);
  }
  const stateGroups = [...groups.values()].sort((a, b) =>
    a.stateName.localeCompare(b.stateName),
  );
  // County totals per loaded state (cache-first region lists) so each group
  // can say "1 of 16 counties" and offer the analyze action (GBV: Maine had
  // zero counties and no way to populate them from this page).
  const countyNames = new Map<string, string>();
  if (apiKey) {
    await Promise.all(
      stateGroups.map(async (g) => {
        try {
          const list = (await subregions(apiKey, g.stateCode, "subnational2"))
            .data;
          g.countyTotal = list.length;
          for (const c of list) countyNames.set(c.code, c.name);
          // Blocks created from hotspots alone get their county's real name.
          for (const b of g.countyBlocks) {
            if (!b.county) b.countyName = countyNames.get(b.countyCode) ?? b.countyCode;
          }
          g.countyBlocks.sort((a, b) =>
            a.countyName.localeCompare(b.countyName),
          );
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
  const loadedRegionCodes = new Set(
    stateGroups.filter((g) => g.state).map((g) => g.stateCode),
  );

  return {
    stateGroups,
    orphanHotspots,
    failed: failedRes.rows.map((r) => ({
      locCode: r.loc_code,
      lastAttemptAt: r.last_attempt_at,
      error: r.error,
      locName: r.loc_name,
      // "Sears Island · Hancock, Maine" beats "L602509 · US-ME-009".
      regionName: r.region_code
        ? r.region_code.match(/^US-[A-Z]{2}-\d{3}$/)
          ? `${countyNames.get(r.region_code) ?? r.region_code}, ${stateName.get(r.region_code.slice(0, 5)) ?? r.region_code.slice(0, 5)}`
          : (stateName.get(r.region_code) ?? r.region_code)
        : null,
    })),
    states: states.filter((s) => !loadedRegionCodes.has(s.code)),
    statesError,
    hasApiKey: !!apiKey,
    hasLogin,
    isViewer,
  };
};

export const actions: Actions = {
  /**
   * Load a whole state's frequency data (1 eBird request). The code is
   * re-validated against the official state list — form values are never
   * trusted as fetch targets.
   */
  loadRegion: async ({ locals, request }) => {
    const userId = locals.scopeId!;
    const form = await request.formData();
    const regionCode = (form.get("region") ?? "").toString().trim();

    if (!STATE_CODE_RE.test(regionCode)) {
      return fail(400, { error: "Unrecognized region code." });
    }
    const apiKey = await getEbirdApiKey(userId);
    if (!apiKey) {
      return fail(400, {
        error: "An eBird API key is required to list regions — add one in Settings.",
      });
    }
    let name: string | null = null;
    try {
      name =
        (await subregions(apiKey, "US", "subnational1")).data.find(
          (s) => s.code === regionCode,
        )?.name ?? null;
    } catch (err) {
      return fail(502, {
        error:
          err instanceof EbirdError
            ? err.message
            : "Could not verify the region against eBird.",
      });
    }
    if (!name) return fail(400, { error: "That region is not a US state." });

    const { jobId, deduped } = await enqueueJob({
      type: "load_region",
      payload: {
        locs: [{ code: regionCode, kind: "region", name, regionCode }],
      },
      dedupKey: dedupKeys.loadRegion(regionCode),
      requestedBy: userId,
      label: `${name} statewide`,
    });
    return { queued: { jobId, deduped, label: `${name} statewide` } };
  },

  /**
   * Analyze ALL of a state's counties as one background job — county data is
   * species-agnostic, so it can be populated from this page as well as from
   * the species forecast. Enqueue-time resolution (CODEX1 #1): the official
   * county list is snapshotted into the payload here.
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
    let regionName: string | null = null;
    let counties: { code: string; name: string }[];
    try {
      regionName =
        (await subregions(apiKey, "US", "subnational1")).data.find(
          (s) => s.code === regionCode,
        )?.name ?? null;
      if (!regionName) {
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

    const { jobId, deduped } = await enqueueJob({
      type: "analyze_counties",
      payload: { regionCode, regionName, counties },
      dedupKey: dedupKeys.analyzeCounties(regionCode),
      requestedBy: userId,
      label: `${counties.length} ${regionName} counties`,
    });
    return { queued: { jobId, deduped, label: `${counties.length} ${regionName} counties` } };
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
