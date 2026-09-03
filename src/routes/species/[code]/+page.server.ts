import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import {
  enrichOneNow,
  enrichOneNowCoalesced,
  getEnrichment,
  getSimilarSpecies,
  getSpeciesMedia,
  inatReadyForAi,
} from "$server/species-enrichment";
import { validSpeciesCode } from "$server/wikidata";
import { isTideTagged } from "$lib/species-tags";
import { tidesNear } from "$server/tides";
import type { TideResult } from "$lib/tide-format";
import { enqueueJob } from "$server/jobs";
import { AI_STAGE_ENABLED, dedupKeys } from "$server/job-policy";
import { query } from "$lib/db";
import {
  getEbirdApiKey,
  notableNearbyObs,
  recentNearbySpeciesObs,
  EbirdError,
} from "$server/ebird";
import { nearestSpeciesReports } from "$server/nearest-ladder";
import { speciesRibbon, type RibbonGrid } from "$server/ribbon";
import { ownerGalleryUrl } from "$server/access";
import { hydrateEbirdLocationPlaceIds } from "$server/location-placeids";
import {
  mergeSpeciesObservations,
  speciesObservationDetails,
  type SpeciesObservationDetail,
} from "$server/observations";
import { verifiedHotspotLocIds } from "$server/hotspots";
import { pickSpeciesTeaserState } from "$server/forecast";
import { streamed } from "$lib/streamed";
import { parseBackDays, SPECIES_DEFAULT_BACK_DAYS } from "$lib/time-windows";
import { returnTrail, safeReturnTo } from "$lib/return-link";
import {
  parseSpeciesLocationContext,
  SPECIES_DEFAULT_DIST_KM,
} from "$lib/species-context";

export const load: PageServerLoad = async ({ locals, params, url, request }) => {
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
    category: string;
  }>(
    "SELECT species_code, com_name, sci_name, family, category FROM taxonomy_cache WHERE species_code = $1",
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
  // td-57822b: when the back link points at ANOTHER species page (arrived via
  // a Similar species card), name the bird — "← Great Black-backed Gull" —
  // instead of the generic "Back" safeReturnTo gives a species detail path.
  // Rides the existing parallel block so it costs no extra round trip.
  const backSpeciesCode = returnTrail(url.searchParams.get("returnTo")).find(
    (c) => c.speciesCode,
  )?.speciesCode;

  const [seen, photos, userRow, backSpecies] = await Promise.all([
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
    backSpeciesCode
      ? query<{ com_name: string }>(
          "SELECT com_name FROM taxonomy_cache WHERE species_code = $1",
          [backSpeciesCode],
        )
      : Promise.resolve({ rows: [] as { com_name: string }[] }),
  ]);
  // Unknown code (stale link, retired taxon) keeps the generic label rather
  // than inventing a name.
  if (backSpecies.rows[0]) returnLink.label = backSpecies.rows[0].com_name;

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

  const apiKey = await getEbirdApiKey(userId);
  // Teaser peers (refactor plan Phase 5): closest-vs-best from the regions
  // reference table — pure DB, no eBird calls, works without an API key.
  // Origin rule unchanged: the searched place wins over the saved home.
  const teaserP = pickSpeciesTeaserState(code, { home: origin });

  // Migration ribbon (td-59c2d0 build spec, TD-B): a discriminated result so
  // the page can tell "nothing loaded" (ok, grid: null) from "broken"
  // (ok: false) — never render a load failure as plain absence (CODEX1
  // P2-10). Awaited, not streamed: the ribbon is above the fold.
  const ribbonP: Promise<{ ok: true; grid: RibbonGrid | null } | { ok: false; error: string }> =
    speciesRibbon(code).then(
      (g) => ({ ok: true as const, grid: g }),
      (e) => {
        console.error("[species] ribbon", e);
        return { ok: false as const, error: "ribbon" };
      },
    );

  // Nearby reports — STREAMED (refactor plan Phase 9): the eBird recent +
  // notable + hotspots + Google Places chain is the page's worst offender by
  // wall time, so the shell renders while it fills in. The promise resolves
  // to a discriminated result and never rejects (see $lib/streamed).
  const loadNearby = async (): Promise<{
    rows: SpeciesObservationDetail[];
    stale: boolean;
  }> => {
    if (!apiKey || !origin) return { rows: [], stale: false };
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
    let stale =
      (recentResult.status === "fulfilled" && recentResult.value.stale) ||
      (notableResult.status === "fulfilled" && notableResult.value.stale);
    const observations = mergeSpeciesObservations(code, recentData, notableData);
    const hotspots = await verifiedHotspotLocIds(
      apiKey,
      origin.lat,
      origin.lon,
      distKm,
    );
    stale = stale || hotspots.stale;
    const placeIds = await hydrateEbirdLocationPlaceIds(observations);
    return {
      rows: speciesObservationDetails(
        observations,
        origin,
        placeIds,
        hotspots.locIds,
      ),
      stale,
    };
  };
  const nearby = streamed(loadNearby(), (err) =>
    err instanceof EbirdError
      ? err.message
      : "Could not load nearby observations.",
  );

  // Nearest reports (td-a6c322, GROK pins): ON-DEMAND only — ?nearest=1 —
  // NEED species only, unbounded distance from the SAVED HOME, inheriting
  // the page's back window. The default load never spends this eBird call.
  const isNeed = seen.rows[0] == null;
  const wantNearest = url.searchParams.get("nearest") === "1";
  // STREAMED when requested (Phase 9); null = section not requested at all.
  const loadNearest = async (): Promise<{
    rows: SpeciesObservationDetail[];
    stale: boolean;
    via: "nearest" | "ladder";
    searched: { regions: number; boundKm: number | null };
    capped: boolean;
    partial: boolean;
    proven: boolean;
  }> => {
    // Two strategies raced (td-73e6f9): eBird's direct endpoint, and — if it
    // hasn't answered within the head start — a region-by-region search
    // running alongside it. First real answer wins.
    const res = await nearestSpeciesReports(apiKey!, code, home!, backDays, {
      // A head start, NOT a deadline: nothing is abandoned when it elapses.
      // The direct endpoint answers a rare species well inside it, so those
      // lookups never probe a single region.
      headStartMs: 3_000,
      probeBudget: 40,
      ladderDeadlineMs: 20_000,
      signal: request.signal,
    });
    // DB-only (CODEX1 P1): no Google Places fanout for unbounded rows.
    const placeIds = await hydrateEbirdLocationPlaceIds(res.rows, {
      resolveMissing: false,
    });
    // Sort by OUR haversine (GROK: never trust API order); no hotspot-set
    // lookup — nearest is unbounded, links derive from the L-id shape.
    return {
      rows: speciesObservationDetails(res.rows, home!, placeIds, new Set()).slice(
        0,
        5,
      ),
      stale: res.stale,
      via: res.via,
      searched: res.searched,
      capped: res.capped,
      partial: res.partial,
      proven: res.proven,
    };
  };
  const nearest =
    wantNearest && isNeed && apiKey && home
      ? streamed(loadNearest(), (err) =>
          err instanceof EbirdError
            ? err.message
            : "Could not check nearest reports.",
        )
      : null;

  // Best-time-of-year card: 1-2 peers (closest / best overall), each carrying
  // its own curve so the client switches tabs with no round trip (Phase 5).
  // Rendered only when the default peer has a usable best month.
  const teaserState = await teaserP;
  const ribbon = await ribbonP;
  const forecastTeaser =
    teaserState && teaserState.peers.some((pe) => pe.best != null) ? teaserState : null;

  // DB-only (spec invariant #1): never calls Commons/xeno-canto on GET.
  // Independent reads — run in parallel.
  const [enrichment, sampleMedia, similar] = await Promise.all([
    getEnrichment(code),
    getSpeciesMedia(code),
    getSimilarSpecies(code, userId),
  ]);

  // Tides beside the tide tags (td-6a3d2e): only for species with an actionable
  // tide stage ('tide-independent' does not count) and only with an origin.
  // Gated on field_craft too — matches the "Finding this bird" card's own
  // render guard, so a partial enrichment row never spends a tide lookup for
  // markup the page hides.
  // STREAMED (Phase 9). tidesNear already resolves null on failure — the
  // pre-existing silent-null behavior for this secondary section is kept.
  const tide: Promise<TideResult | null> =
    origin && enrichment?.field_craft && isTideTagged(enrichment.tags ?? [])
      ? tidesNear(origin.lat, origin.lon).catch(() => null)
      : Promise.resolve(null);

  return {
    taxon: t,
    enrichment,
    sampleMedia,
    similar,
    /** Carried into similar-species links: without lat/lng the next species
     * page reports around the SAVED HOME rather than the searched place
     * (see the header comment in $lib/species-context). */
    locationContext,
    isAdmin: locals.user!.role === "admin",
    seen: seen.rows[0] ?? null,
    forecastTeaser,
    ribbon,
    photos: photos.rows,
    hasGallery,
    nearby,
    nearest,
    wantNearest,
    hasApiKey: !!apiKey,
    hasOrigin: !!origin,
    /** Nearest lookups run from the SAVED home only (GROK P2-3) — a searched
     * origin is not a substitute. */
    hasHome: !!home,
    originLabel,
    distKm,
    backDays,
    returnLink,
    tide,
  };
};


/**
 * The aiOnly enqueue gate (GROK G2, td-460b1c Phase B): a species whose
 * confusion data is still pending or errored must not get a candidate-less AI
 * call now and a second billed call after inat lands. Terminal non-error
 * statuses participate; everything else defers to the scan, which picks the
 * species up via aiDueCodes the moment inat lands.
 */
export const actions: Actions = {
  /**
   * First-time enrichment: any authenticated role (td-0753d0). Uses promise
   * coalescing so concurrent clicks share one Wikimedia operation. Gate:
   * wiki_fetched_at IS NULL (server-side, not just button-hide).
   */
  load_enrichment: async ({ locals, params }) => {
    const code = params.code;
    if (!validSpeciesCode(code)) {
      return fail(400, { error: "Invalid species code." });
    }
    const taxon = await query<{
      category: string;
      com_name: string;
      wiki_fetched_at: string | null;
    }>(
      `SELECT tc.category, tc.com_name, se.wiki_fetched_at::text
         FROM taxonomy_cache tc
         LEFT JOIN species_enrichment se USING (species_code)
        WHERE tc.species_code = $1`,
      [code],
    );
    if (taxon.rows[0]?.category !== "species") {
      return fail(400, { error: "Not an enrichable species." });
    }
    if (taxon.rows[0].wiki_fetched_at != null) {
      return {
        ok: true as const,
        message: "This species already has Wikipedia data.",
      };
    }
    const comName = taxon.rows[0].com_name;
    let now;
    try {
      now = await enrichOneNowCoalesced(code);
    } catch {
      try {
        const r = await enqueueJob({
          type: "enrich_species",
          payload: { codes: [code] },
          dedupKey: dedupKeys.enrichSpeciesOne(code),
          requestedBy: locals.user!.id,
          label: comName,
        });
        return {
          ok: true as const,
          queued: { jobId: r.jobId, deduped: r.deduped, label: "Species data" },
          message: "Queued — refresh the page shortly.",
        };
      } catch {
        return fail(500, {
          error: "Could not load species data. Try again later.",
        });
      }
    }
    if (now.outcome === "ok") {
      // iNat confusion-data sourcing (td-460b1c Phase A, GROK G2): after wiki
      // lands (cross_ids had its chance), fill species_inat_similar in the
      // background. Best-effort — never gates the wiki result.
      try {
        await enqueueJob({
          type: "enrich_species_inat",
          payload: { codes: [code] },
          dedupKey: dedupKeys.enrichInatOne(code),
          requestedBy: locals.user!.id,
          label: comName,
        });
      } catch {
        // Non-fatal: the recurring scan covers it.
      }
      if (now.aiDue && AI_STAGE_ENABLED && (await inatReadyForAi(code))) {
        try {
          const ai = await enqueueJob({
            type: "enrich_species",
            payload: { codes: [code], aiOnly: true },
            dedupKey: dedupKeys.enrichAiChunk([code]),
            requestedBy: locals.user!.id,
            label: comName,
          });
          return {
            ok: true as const,
            queued: {
              jobId: ai.jobId,
              deduped: ai.deduped,
              label: "Field craft",
            },
            message: "Article loaded — field craft is being written.",
          };
        } catch {
          return { ok: true as const, message: "Article loaded." };
        }
      }
      return { ok: true as const, message: "Article loaded." };
    }
    if (now.outcome === "no_article" || now.outcome === "no_mapping") {
      return { ok: true as const, message: "No Wikipedia article found." };
    }
    // Transient: queue for background retry.
    try {
      const r = await enqueueJob({
        type: "enrich_species",
        payload: { codes: [code] },
        dedupKey: dedupKeys.enrichSpeciesOne(code),
        requestedBy: locals.user!.id,
        label: comName,
      });
      return {
        ok: true as const,
        queued: { jobId: r.jobId, deduped: r.deduped, label: "Species data" },
        message: "Queued — refresh the page shortly.",
      };
    } catch {
      return fail(500, {
        error: "Could not load species data. Try again later.",
      });
    }
  },

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
    const taxon = await query<{ category: string; com_name: string }>(
      "SELECT category, com_name FROM taxonomy_cache WHERE species_code = $1",
      [code],
    );
    if (taxon.rows[0]?.category !== "species") {
      return fail(400, { error: "Not an enrichable species." });
    }
    const comName = taxon.rows[0].com_name;

    // Instant path (GROK pin c): wiki stages run INLINE under a 20s budget —
    // the click Gaylon watched spin for five minutes now returns with the
    // article. The AI stage is never inline; on wiki-ok with the annotation
    // due, a narrowed aiOnly chunk is enqueued for the background worker.
    const now = await enrichOneNow(code);

    // Media refresh is always background and never gates the wiki/AI result.
    // Enqueue only AFTER enrichOneNow finishes: on a species' first refresh,
    // that inline transaction may be what creates the QID the media worker
    // requires. Enqueuing first lets a fast worker claim and skip `no-qid`.
    // Capture the job id so the layout chip can track it when it's the only
    // background work (jobsPoll grace-stops when idle — GROK P2-1).
    let mediaQueued: { jobId: number; deduped: boolean } | null = null;
    try {
      mediaQueued = await enqueueJob({
        type: "enrich_species_media",
        payload: { codes: [code], force: true },
        dedupKey: dedupKeys.enrichMediaOne(code),
        requestedBy: locals.user!.id,
        label: comName,
      });
    } catch {
      // Enqueue failure is non-fatal: media is a bonus, not gating.
    }

    // iNat confusion-data refresh (td-460b1c Phase A): background alongside
    // media, after enrichOneNow so the row (and possibly cross_ids) exists.
    try {
      await enqueueJob({
        type: "enrich_species_inat",
        payload: { codes: [code] },
        dedupKey: dedupKeys.enrichInatOne(code),
        requestedBy: locals.user!.id,
        label: comName,
      });
    } catch {
      // Non-fatal: the recurring scan covers it.
    }

    // One shared chip payload — the return shape carries a single queued
    // job, and messages only claim "sample media is updating" when the
    // media job was actually enqueued (the enqueue above is allowed to
    // fail silently).
    const mediaChip = mediaQueued
      ? {
          jobId: mediaQueued.jobId,
          deduped: mediaQueued.deduped,
          label: "Sample media",
        }
      : null;

    if (now.outcome === "ok") {
      if (now.aiDue && AI_STAGE_ENABLED && (await inatReadyForAi(code))) {
        const ai = await enqueueJob({
          type: "enrich_species",
          payload: { codes: [code], aiOnly: true },
          dedupKey: dedupKeys.enrichAiChunk([code]),
          requestedBy: locals.user!.id,
          // displayName composes "Species data — {comName}" (GROK pin d:
          // the label is the NAME alone; the type prefix supplies the rest).
          label: comName,
        });
        return {
          ok: true as const,
          // queued lights the job chip for the background AI stage — with
          // the poller now idling when only scheduled rows exist (pin a),
          // the page's track() is the only thing that wakes it (GROK P2-1).
          queued: {
            jobId: ai.jobId,
            deduped: ai.deduped,
            label: "Field craft",
          },
          message: mediaQueued
            ? "Article loaded — field craft and sample media are updating."
            : "Article loaded — field craft is being written.",
        };
      }
      if (mediaChip) {
        return {
          ok: true as const,
          queued: mediaChip,
          message: "Article loaded — sample media is updating.",
        };
      }
      return { ok: true as const, message: "Article loaded." };
    }
    if (now.outcome === "no_article") {
      // A QID exists (mapping resolved, article missing) — media can run.
      if (mediaChip) {
        return {
          ok: true as const,
          queued: mediaChip,
          message: "No Wikipedia article found. Sample media is updating.",
        };
      }
      return { ok: true as const, message: "No Wikipedia article found." };
    }
    if (now.outcome === "no_mapping") {
      // No QID was written — the media worker will no-qid-skip, so don't
      // claim media is updating (that would be a lie the user waits on).
      return { ok: true as const, message: "No Wikipedia article found." };
    }
    // Transient (timeout/rate limit): nothing was written — fall back to
    // the queue so the refresh still happens without the user re-clicking.
    const r = await enqueueJob({
      type: "enrich_species",
      payload: { codes: [code], force: true },
      dedupKey: dedupKeys.enrichSpeciesOne(code),
      requestedBy: locals.user!.id,
      label: comName,
    });
    return {
      ok: true as const,
      queued: { jobId: r.jobId, deduped: r.deduped, label: "Species refresh" },
      message: "Couldn't refresh now — queued to retry.",
    };
  },
};
