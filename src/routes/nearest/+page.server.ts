import type { PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { getEbirdApiKey, validEbirdSpeciesCode, EbirdError } from "$server/ebird";
import {
  createProbeGate,
  type ProbeGate,
} from "$server/nearest-ladder";
import { forecastNeedsNear } from "$server/forecast";
import { AUTO_RUN_CAP, pickAutoRunTargets } from "$server/nearest";
import { seenSet } from "$server/needs";
import { notableNearbyObs, type CachedResult, type EbirdObs } from "$server/ebird";
import {
  nearestWithEvidence,
  parseNearestControls,
  type NearestDistance,
} from "$server/nearest-evidence";
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
  partial: boolean;
  notableFailed: boolean;
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
  controls: { backDays: number; nearestKm: NearestDistance },
  sharedNotable: Promise<CachedResult<EbirdObs[]>> | null,
  signal?: AbortSignal,
): Promise<NearestTarget> {
  try {
    const { engine, evidence } = await nearestWithEvidence(apiKey, code, home, controls, {
      gate,
      signal,
      notablePromise: sharedNotable ?? undefined,
    });
    // DB-only: resolveMissing would fan out live Google Places lookups for
    // every unknown loc — and nearest is UNBOUNDED, so distant locations are
    // always unknown (6 targets × 5 rows = up to 30 lookups per view —
    // CODEX1 P1). Known ids enhance MapLink; unknown fall back to coords.
    const placeIds = await hydrateEbirdLocationPlaceIds(evidence.rows, {
      resolveMissing: false,
    });
    const rows = speciesObservationDetails(evidence.rows, home, placeIds, new Set());
    return {
      speciesCode: code,
      comName,
      areaFreq,
      rows,
      stale: evidence.stale,
      error: null,
      via: engine?.via ?? "nearest",
      searched: engine?.searched ?? { regions: 0, boundKm: null },
      capped: engine?.capped ?? false,
      proven: engine?.proven ?? false,
      partial: evidence.partial || !!engine?.partial,
      notableFailed: evidence.notableFailed,
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
      partial: true,
      notableFailed: true,
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
  const parsedControls = parseNearestControls(
    url.searchParams.get("back"),
    url.searchParams.get("nearestKm"),
  );
  if (!parsedControls.ok) throw error(400, parsedControls.message);
  const controls = parsedControls.value;

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

  let sharedNotable: Promise<CachedResult<EbirdObs[]>> | null = null;

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
    } else if (apiKey && home && !pageSignal.aborted) {
      // Start exactly once, after code validation and only for a real lookup.
      sharedNotable = notableNearbyObs(
        apiKey, home.lat, home.lon,
        controls.nearestKm === "any" ? 50 : Math.min(controls.nearestKm, 50),
        controls.backDays,
        { deadlineMs: 8_000 },
      );
      searched = await lookupSpecies(
        apiKey,
        pickedCode,
        tx.com_name,
        null,
        home,
        probeGate,
        controls,
        sharedNotable,
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
      if (picks.length > 0 && !pageSignal.aborted) {
        sharedNotable = notableNearbyObs(
          apiKey, home.lat, home.lon,
          controls.nearestKm === "any" ? 50 : Math.min(controls.nearestKm, 50),
          controls.backDays,
          { deadlineMs: 8_000 },
        );
      }
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
            controls,
            sharedNotable,
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
    backDays: controls.backDays,
    nearestKm: controls.nearestKm,
    autoRunCap: AUTO_RUN_CAP,
    likelyCount,
    targets,
    forecastError,
    q,
    selectedCode: pickedCode || searchedSeen?.speciesCode || searched?.speciesCode || null,
    searchMatches,
    searched,
    searchedSeen,
    isViewer: locals.user?.role === "viewer",
  };
};
