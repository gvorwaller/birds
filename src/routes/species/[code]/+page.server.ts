import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { query } from "$lib/db";
import {
  getEbirdApiKey,
  notableNearbyObs,
  recentNearbySpeciesObs,
  EbirdError,
} from "$server/ebird";
import { ownerGalleryUrl } from "$server/access";
import { hydrateEbirdLocationPlaceIds } from "$server/location-placeids";
import {
  mergeSpeciesObservations,
  speciesObservationDetails,
  type SpeciesObservationDetail,
} from "$server/observations";
import { verifiedHotspotLocIds } from "$server/hotspots";
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

  return {
    taxon: t,
    seen: seen.rows[0] ?? null,
    photos: photos.rows,
    hasGallery,
    nearby,
    nearbyError,
    stale,
    hasApiKey: !!apiKey,
    hasOrigin: !!origin,
    originLabel,
    distKm,
    backDays,
    returnLink,
  };
};
