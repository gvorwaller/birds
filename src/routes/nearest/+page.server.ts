import type { PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { getEbirdApiKey, validEbirdSpeciesCode, EbirdError } from "$server/ebird";
import {
  createProbeGate,
  nearestSpeciesReports,
  type ProbeGate,
} from "$server/nearest-ladder";
import { forecastNeedsNear } from "$server/forecast";
import { AUTO_RUN_CAP, NEAREST_BACK_DAYS, pickAutoRunTargets } from "$server/nearest";
import { seenSet } from "$server/needs";
import { hydrateEbirdLocationPlaceIds } from "$server/location-placeids";
import { speciesObservationDetails, type SpeciesObservationDetail } from "$server/observations";
import { calendarMonth } from "$lib/forecast-calendar";
import { normalizeNearMeRadiusKm } from "$lib/near-me-radius";
import { error } from "@sveltejs/kit";

const NEAREST_PAGE_WALL_MS = 40_000;

export interface NearestTarget {
  speciesCode: string;
  comName: string;
  /** Area frequency that earned the auto-run slot (likely band). */
  areaFreq: number | null;
  rows: SpeciesObservationDetail[];
  stale: boolean;
  error: string | null;
  /** How the answer was found — 'ladder' means our regions, not all of eBird. */
  via: "nearest" | "ladder";
  searched: { regions: number; boundKm: number | null };
  /** Empty rows do NOT mean "nowhere" when this is true. */
  capped: boolean;
  proven: boolean;
}

/**
 * This page is AWAITED, not streamed, and auto-runs up to six species — so its
 * limits are page-global, not per species: one shared gate that caps both the
 * total probes AND how many run at once, plus a page-wide wall clock. Six
 * independent searches would otherwise open `species × wave` sockets and stack
 * past nginx's 60s proxy timeout.
 */
async function lookupSpecies(
  apiKey: string,
  code: string,
  comName: string,
  areaFreq: number | null,
  home: { lat: number; lon: number },
  gate: ProbeGate,
  signal?: AbortSignal,
): Promise<NearestTarget> {
  try {
    const res = await nearestSpeciesReports(apiKey, code, home, NEAREST_BACK_DAYS, {
      headStartMs: 3_000,
      probeBudget: 8,
      ladderDeadlineMs: 15_000,
      gate,
      signal,
    });
    // DB-only: resolveMissing would fan out live Google Places lookups for
    // every unknown loc — and nearest is UNBOUNDED, so distant locations are
    // always unknown (6 targets × 5 rows = up to 30 lookups per view —
    // CODEX1 P1). Known ids enhance MapLink; unknown fall back to coords.
    const placeIds = await hydrateEbirdLocationPlaceIds(res.rows, {
      resolveMissing: false,
    });
    // Our haversine order, closest 3 (GROK pin) — never API order. The engine
    // returns five for the species page; this page's three is unchanged.
    const rows = speciesObservationDetails(res.rows, home, placeIds, new Set()).slice(0, 3);
    return {
      speciesCode: code,
      comName,
      areaFreq,
      rows,
      stale: res.stale,
      error: null,
      via: res.via,
      searched: res.searched,
      capped: res.capped,
      proven: res.proven,
    };
  } catch (err) {
    // Partial failure keeps the page alive (GROK empty-state pin).
    return {
      speciesCode: code,
      comName,
      areaFreq,
      rows: [],
      stale: false,
      error: err instanceof EbirdError ? err.message : "Lookup failed.",
      via: "nearest",
      searched: { regions: 0, boundKm: null },
      capped: false,
      proven: false,
    };
  }
}

export const load: PageServerLoad = async ({ locals, url, request }) => {
  // One page-wide ceiling, started before any DB/forecast work. Queued ladder
  // probes check this signal before they reach eBird; an already-running probe
  // may finish under its own 8s endpoint deadline and populate the shared
  // cache. That bounds the eBird portion to 40s + one 8s overshoot < nginx 60s.
  const pageSignal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(NEAREST_PAGE_WALL_MS),
  ]);
  // One allowance for the whole page: a single explicit lookup may use it all,
  // while six auto-run targets share it rather than each opening their own.
  const probeGate = createProbeGate(24);
  const scopeId = locals.scopeId!;
  const month = calendarMonth();

  const u = await query<{
    home_lat: number | null;
    home_lon: number | null;
    home_label: string | null;
    near_me_radius_km: number | null;
  }>(
    "SELECT home_lat, home_lon, home_label, near_me_radius_km FROM users WHERE id = $1",
    [scopeId],
  );
  const row = u.rows[0];
  const home =
    row?.home_lat != null && row?.home_lon != null
      ? { lat: row.home_lat, lon: row.home_lon }
      : null;
  const apiKey = await getEbirdApiKey(scopeId);

  // ---- Search: needs-only. A seen species gets a friendly redirect
  // sentence and NO eBird call; unknown codes are a 400 (GROK pins).
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const pickedCode = (url.searchParams.get("code") ?? "").trim();
  let searchMatches: { speciesCode: string; comName: string; seen: boolean }[] = [];
  let searched: NearestTarget | null = null;
  let searchedSeen: { speciesCode: string; comName: string } | null = null;

  const seen = await seenSet(scopeId);

  if (pickedCode) {
    if (!validEbirdSpeciesCode(pickedCode)) throw error(400, "Unrecognized species code");
    const t = await query<{ species_code: string; com_name: string }>(
      `SELECT species_code, com_name FROM taxonomy_cache
        WHERE species_code = $1 AND category = 'species'`,
      [pickedCode],
    );
    const tx = t.rows[0];
    if (!tx) throw error(400, "Unrecognized species code");
    if (seen.has(pickedCode)) {
      searchedSeen = { speciesCode: pickedCode, comName: tx.com_name };
    } else if (apiKey && home) {
      searched = await lookupSpecies(
        apiKey,
        pickedCode,
        tx.com_name,
        null,
        home,
        probeGate,
        pageSignal,
      );
    }
  } else if (q.length >= 2) {
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const t = await query<{ species_code: string; com_name: string }>(
      `SELECT species_code, com_name FROM taxonomy_cache
        WHERE category = 'species' AND com_name ILIKE $1
        ORDER BY com_name LIMIT 12`,
      [like],
    );
    searchMatches = t.rows.map((r) => ({
      speciesCode: r.species_code,
      comName: r.com_name,
      seen: seen.has(r.species_code),
    }));
  }

  // ---- Auto-run: top likely-band needs this month near the SAVED home.
  let targets: NearestTarget[] = [];
  let likelyCount = 0;
  let forecastError: string | null = null;
  if (apiKey && home && !pickedCode && q.length < 2) {
    try {
      const distKm = normalizeNearMeRadiusKm(row?.near_me_radius_km);
      const view = await forecastNeedsNear(
        scopeId,
        apiKey,
        home.lat,
        home.lon,
        distKm,
        month,
        seen,
      );
      const { picks, likelyCount: n } = pickAutoRunTargets(view.species);
      likelyCount = n;
      // Parallel, partial-failure-safe (GROK: allSettled, never a waterfall —
      // lookupSpecies never rejects, so all() has allSettled semantics).
      targets = await Promise.all(
        picks.map((s) =>
          lookupSpecies(
            apiKey,
            s.code,
            s.comName,
            s.areaFreq,
            home,
            probeGate,
            pageSignal,
          ),
        ),
      );
    } catch (err) {
      forecastError =
        err instanceof EbirdError
          ? err.message
          : "Could not compute this month's targets.";
    }
  }

  return {
    hasApiKey: !!apiKey,
    hasHome: !!home,
    homeLabel: row?.home_label ?? null,
    month,
    backDays: NEAREST_BACK_DAYS,
    autoRunCap: AUTO_RUN_CAP,
    likelyCount,
    targets,
    forecastError,
    q,
    searchMatches,
    searched,
    searchedSeen,
    isViewer: locals.user?.role === "viewer",
  };
};
