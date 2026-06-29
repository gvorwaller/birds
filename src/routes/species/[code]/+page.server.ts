import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { query } from "$lib/db";
import {
  getEbirdApiKey,
  notableNearbyObs,
  recentNearbySpeciesObs,
  EbirdError,
  type EbirdObs,
} from "$server/ebird";
import { haversineKm } from "$lib/geo";
import { ownerGalleryUrl } from "$server/access";
import {
  attachGooglePlaceIds,
  hydrateEbirdLocationPlaceIds,
} from "$server/location-placeids";
import { mergeSpeciesObservations } from "$server/observations";
import { verifiedHotspotLocIds } from "$server/hotspots";

const NEARBY_DIST_KM = 50;
const NEARBY_BACK_DAYS = 14;
const BACK_OPTIONS = [7, 14, 30] as const;

function safeReturnTo(raw: string | null): { href: string; label: string } {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return { href: "/targets", label: "Targets" };
  }
  const label =
    raw === "/" || raw.startsWith("/?")
      ? "Near Me"
      : raw.startsWith("/targets")
        ? "Targets"
        : "Back";
  return { href: raw, label };
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const userId = locals.scopeId!; // the data owner this account reads
  const code = params.code;
  const hasGallery = (await ownerGalleryUrl(userId)) != null;
  const requestedBack = Number(
    url.searchParams.get("back") ?? NEARBY_BACK_DAYS,
  );
  const backDays = BACK_OPTIONS.includes(
    requestedBack as (typeof BACK_OPTIONS)[number],
  )
    ? requestedBack
    : NEARBY_BACK_DAYS;
  const returnLink = safeReturnTo(url.searchParams.get("returnTo"));

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

  let nearby: (EbirdObs & {
    distanceKm: number | null;
    googlePlaceId: string | null;
    isHotspot: boolean;
  })[] = [];
  let nearbyError: string | null = null;
  let stale = false;
  const apiKey = await getEbirdApiKey(userId);
  if (apiKey && home) {
    try {
      const [recentResult, notableResult] = await Promise.allSettled([
        recentNearbySpeciesObs(
          apiKey,
          code,
          home.lat,
          home.lon,
          NEARBY_DIST_KM,
          backDays,
        ),
        notableNearbyObs(apiKey, home.lat, home.lon, NEARBY_DIST_KM, backDays),
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
        home.lat,
        home.lon,
        NEARBY_DIST_KM,
      );
      stale = stale || hotspots.stale;
      const placeIds = await hydrateEbirdLocationPlaceIds(observations);
      nearby = attachGooglePlaceIds(observations, placeIds)
        .map((o) => ({
          ...o,
          isHotspot: o.locId ? hotspots.locIds.has(o.locId) : false,
          distanceKm: home
            ? haversineKm(home.lat, home.lon, o.lat, o.lng)
            : null,
        }))
        .sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9))
        .slice(0, 15);
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
    hasHome: !!home,
    distKm: NEARBY_DIST_KM,
    backDays,
    returnLink,
  };
};
