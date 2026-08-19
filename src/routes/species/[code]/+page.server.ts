import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { getEnrichment } from "$server/species-enrichment";
import { validSpeciesCode } from "$server/wikidata";
import { enqueueJob } from "$server/jobs";
import { dedupKeys } from "$server/job-policy";
import { query } from "$lib/db";
import {
  getEbirdApiKey,
  notableNearbyObs,
  recentNearbySpeciesObs,
  EbirdError,
  nearestObsOfSpecies,
} from "$server/ebird";
import { ownerGalleryUrl } from "$server/access";
import { hydrateEbirdLocationPlaceIds } from "$server/location-placeids";
import {
  mergeSpeciesObservations,
  speciesObservationDetails,
  type SpeciesObservationDetail,
} from "$server/observations";
import { verifiedHotspotLocIds } from "$server/hotspots";
import { goodMonths, pickSpeciesTeaserState } from "$server/forecast";
import { parseBackDays, SPECIES_DEFAULT_BACK_DAYS } from "$lib/time-windows";
import { safeReturnTo } from "$lib/return-link";
import {
  parseSpeciesLocationContext,
  SPECIES_DEFAULT_DIST_KM,
} from "$lib/species-context";

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const userId = locals.scopeId!; // the data owner this account reads
  const code = params.code;
  const hasGallery = (await ownerGalleryUrl(userId)) != null;
  const backDays = parseBackDays(
    url.searchParams.get("back"),
    SPECIES_DEFAULT_BACK_DAYS,
  );
  const returnLink = safeReturnTo(url.searchParams.get("returnTo"));
  // Home can be centered on a searched place; when it is, the link carries that
  // origin so this page reports on the same area the user was just looking at.
  const locationContext = parseSpeciesLocationContext(url.searchParams);

  const taxon = await query<{
    species_code: string;
    com_name: string;
    sci_name: string;
    family: string | null;
  }>(
    "SELECT species_code, com_name, sci_name, family FROM taxonomy_cache WHERE species_code = $1",
    [code],
  );
  if (!taxon.rows[0]) {
    throw error(
      404,
      `Species code "${code}" not found — is the taxonomy synced?`,
    );
  }
  const t = taxon.rows[0];

  type PhotoRow = {
    photo_id: string;
    thumbnail: string;
    page_url: string;
    taken_on: string | null;
  };
  const [seen, photos, userRow] = await Promise.all([
    query<{ first_seen: string | null; source: string }>(
      "SELECT first_seen, source FROM seen_species WHERE user_id = $1 AND species_code = $2",
      [userId, code],
    ),
    // Gallery is owner-scoped: only the gallery owner (and their viewer) see photos.
    hasGallery
      ? query<PhotoRow>(
          `SELECT photo_id, thumbnail, page_url, taken_on FROM photo_links
				  WHERE species_code = $1 ORDER BY taken_on DESC NULLS LAST`,
          [code],
        )
      : Promise.resolve({ rows: [] as PhotoRow[] }),
    query<{ home_lat: number | null; home_lon: number | null }>(
      "SELECT home_lat, home_lon FROM users WHERE id = $1",
      [userId],
    ),
  ]);

  const home =
    userRow.rows[0]?.home_lat != null && userRow.rows[0]?.home_lon != null
      ? { lat: userRow.rows[0].home_lat, lon: userRow.rows[0].home_lon }
      : null;

  // A validated searched origin wins; otherwise fall back to the saved home.
  const origin = locationContext
    ? { lat: locationContext.lat, lon: locationContext.lng }
    : home;
  const distKm = locationContext?.distKm ?? SPECIES_DEFAULT_DIST_KM;
  const originLabel = locationContext?.label ?? null;

  let nearby: SpeciesObservationDetail[] = [];
  let nearbyError: string | null = null;
  let stale = false;
  const apiKey = await getEbirdApiKey(userId);
  const teaserP = pickSpeciesTeaserState(code);
  if (apiKey && origin) {
    try {
      const [recentResult, notableResult] = await Promise.allSettled([
        recentNearbySpeciesObs(
          apiKey,
          code,
          origin.lat,
          origin.lon,
          distKm,
          backDays,
        ),
        notableNearbyObs(apiKey, origin.lat, origin.lon, distKm, backDays),
      ]);
      if (
        recentResult.status === "rejected" &&
        notableResult.status === "rejected"
      ) {
        throw recentResult.reason;
      }
      const recentData =
        recentResult.status === "fulfilled" ? recentResult.value.data : [];
      const notableData =
        notableResult.status === "fulfilled" ? notableResult.value.data : [];
      stale =
        (recentResult.status === "fulfilled" && recentResult.value.stale) ||
        (notableResult.status === "fulfilled" && notableResult.value.stale);
      const observations = mergeSpeciesObservations(
        code,
        recentData,
        notableData,
      );
      const hotspots = await verifiedHotspotLocIds(
        apiKey,
        origin.lat,
        origin.lon,
        distKm,
      );
      stale = stale || hotspots.stale;
      const placeIds = await hydrateEbirdLocationPlaceIds(observations);
      nearby = speciesObservationDetails(
        observations,
        origin,
        placeIds,
        hotspots.locIds,
      );
    } catch (err) {
      nearbyError =
        err instanceof EbirdError
          ? err.message
          : "Could not load nearby observations.";
    }
  }

  // Nearest reports (td-a6c322, GROK pins): ON-DEMAND only — ?nearest=1 —
  // NEED species only, unbounded distance from the SAVED HOME, inheriting
  // the page's back window. The default load never spends this eBird call.
  const isNeed = seen.rows[0] == null;
  const wantNearest = url.searchParams.get("nearest") === "1";
  let nearest: {
    rows: SpeciesObservationDetail[];
    stale: boolean;
    error: string | null;
  } | null = null;
  if (wantNearest && isNeed && apiKey && home) {
    try {
      const res = await nearestObsOfSpecies(
        apiKey,
        code,
        home.lat,
        home.lon,
        backDays,
      );
      // DB-only (CODEX1 P1): no Google Places fanout for unbounded rows.
      const placeIds = await hydrateEbirdLocationPlaceIds(res.data, {
        resolveMissing: false,
      });
      // Sort by OUR haversine (GROK: never trust API order); no hotspot-set
      // lookup — nearest is unbounded, links derive from the L-id shape.
      nearest = {
        rows: speciesObservationDetails(res.data, home, placeIds, new Set())
          .slice(0, 5),
        stale: res.stale,
        error: null,
      };
    } catch (err) {
      nearest = {
        rows: [],
        stale: false,
        error:
          err instanceof EbirdError
            ? err.message
            : "Could not check nearest reports.",
      };
    }
  }

  // Forecast teaser: the loaded state where this species is most findable
  // (highest peak month), not the state with the most checklists overall.
  let forecastTeaser: {
    regionCode: string;
    regionName: string;
    curve: { month: number; freq: number; n: number }[];
    /** 48-week resolution for the chart's Week toggle (td-af8393). */
    weeks: { week: number; freq: number; n: number }[];
    migration: string | null;
    best: { month: number; freq: number; lowSample: boolean } | null;
    peakPhrase: string | null;
    /** Months within 80% of the peak — the "good window". */
    good: number[];
  } | null = null;
  const teaserState = await teaserP;
  if (teaserState && teaserState.best) {
    forecastTeaser = {
      regionCode: teaserState.locCode,
      regionName: teaserState.locName,
      curve: teaserState.curve,
      weeks: teaserState.weeks,
      migration: teaserState.migration,
      best: teaserState.best,
      peakPhrase: teaserState.peakPhrase,
      good: goodMonths(teaserState.curve),
    };
  }

  const enrichment = await getEnrichment(code);

  return {
    taxon: t,
    enrichment,
    isAdmin: locals.user!.role === "admin",
    seen: seen.rows[0] ?? null,
    forecastTeaser,
    photos: photos.rows,
    hasGallery,
    nearby,
    nearest,
    wantNearest,
    nearbyError,
    stale,
    hasApiKey: !!apiKey,
    hasOrigin: !!origin,
    /** Nearest lookups run from the SAVED home only (GROK P2-3) — a searched
     * origin is not a substitute. */
    hasHome: !!home,
    originLabel,
    distKm,
    backDays,
    returnLink,
  };
};

export const actions: Actions = {
  /**
   * Force-refresh this species' enrichment via the queue. ADMIN-gated
   * server-side (CODEX1 plan #5): it spends communal Wikimedia/Anthropic
   * quota and mutates a global row — "owner" is not a role in this app and
   * the viewer hook is not an authorization system.
   */
  refresh_enrichment: async ({ locals, params }) => {
    if (locals.user!.role !== "admin") {
      return fail(403, { error: "Admins only." });
    }
    const code = params.code;
    if (!validSpeciesCode(code)) {
      return fail(400, { error: "Invalid species code." });
    }
    const taxon = await query<{ category: string }>(
      "SELECT category FROM taxonomy_cache WHERE species_code = $1",
      [code],
    );
    if (taxon.rows[0]?.category !== "species") {
      return fail(400, { error: "Not an enrichable species." });
    }
    const r = await enqueueJob({
      type: "enrich_species",
      payload: { codes: [code], force: true },
      dedupKey: dedupKeys.enrichSpeciesOne(code),
      requestedBy: locals.user!.id,
      label: "1 species (manual refresh)",
    });
    return {
      ok: true as const,
      queued: { jobId: r.jobId, deduped: r.deduped, label: "Species refresh" },
      message: r.deduped
        ? "A refresh for this species is already queued."
        : "Refresh queued — new data appears when the background job finishes.",
    };
  },
};
