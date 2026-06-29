import type { PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { getEbirdApiKey, EbirdError } from "$server/ebird";
import {
  nearbyNeeds,
  type PlaceRanking,
  type SpeciesActivity,
} from "$server/needs";
import { galleryContext } from "$server/access";

const NEARBY_DIST_KM = 40;
const NEARBY_BACK_DAYS = 7;
const BACK_OPTIONS = [7, 14, 30] as const;

export const load: PageServerLoad = async ({ locals, url }) => {
  const userId = locals.scopeId!; // the data owner this account reads
  const requestedBack = Number(
    url.searchParams.get("back") ?? NEARBY_BACK_DAYS,
  );
  const backDays = BACK_OPTIONS.includes(
    requestedBack as (typeof BACK_OPTIONS)[number],
  )
    ? requestedBack
    : NEARBY_BACK_DAYS;

  const userRow = await query<{
    home_lat: number | null;
    home_lon: number | null;
  }>("SELECT home_lat, home_lon FROM users WHERE id = $1", [userId]);
  const home =
    userRow.rows[0]?.home_lat != null && userRow.rows[0]?.home_lon != null
      ? { lat: userRow.rows[0].home_lat, lon: userRow.rows[0].home_lon }
      : null;

  const { hasGallery, photoCounts } = await galleryContext(userId);

  const [seenCount, ebirdState] = await Promise.all([
    query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM seen_species WHERE user_id = $1",
      [userId],
    ),
    query<{
      life_list_synced_at: string | null;
      life_list_status: string | null;
    }>(
      "SELECT life_list_synced_at, life_list_status FROM user_ebird WHERE user_id = $1",
      [userId],
    ),
  ]);
  const photoCount = hasGallery
    ? [...photoCounts.values()].reduce((a, b) => a + b, 0)
    : 0;

  let needs: SpeciesActivity[] = [];
  let bestPlaces: PlaceRanking[] = [];
  let needsError: string | null = null;
  let stale = false;
  const apiKey = await getEbirdApiKey(userId);

  if (apiKey && home) {
    try {
      const result = await nearbyNeeds(
        userId,
        apiKey,
        home,
        NEARBY_DIST_KM,
        backDays,
        photoCounts,
      );
      // Send the full needs list — the page previews the first 20 but the
      // client-side species search filters across all of them.
      needs = result.needs;
      bestPlaces = result.bestPlaces.slice(0, 6);
      stale = result.stale;
    } catch (err) {
      needsError =
        err instanceof EbirdError
          ? err.message
          : "Could not load recent observations.";
    }
  }

  return {
    home,
    hasApiKey: !!apiKey,
    needs,
    bestPlaces,
    needsError,
    stale,
    distKm: NEARBY_DIST_KM,
    backDays,
    backOptions: BACK_OPTIONS,
    returnTo: `/${url.search}`,
    seenCount: Number(seenCount.rows[0]?.n ?? 0),
    hasGallery,
    photoCount,
    lifeListSyncedAt: ebirdState.rows[0]?.life_list_synced_at ?? null,
    lifeListStatus: ebirdState.rows[0]?.life_list_status ?? null,
  };
};
