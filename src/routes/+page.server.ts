import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { getEbirdApiKey, EbirdError } from "$server/ebird";
import {
  nearbyNeeds,
  type PlaceRanking,
  type SpeciesActivity,
} from "$server/needs";
import { galleryContext } from "$server/access";
import {
  BACK_OPTIONS,
  DEFAULT_BACK_DAYS,
  parseBackDays,
} from "$lib/time-windows";
import {
  NEAR_ME_RADIUS_OPTIONS_KM,
  normalizeNearMeRadiusKm,
  validateNearMeRadiusKm,
} from "$lib/near-me-radius";

export const load: PageServerLoad = async ({ locals, url }) => {
  const userId = locals.scopeId!; // the data owner this account reads
  const backDays = parseBackDays(
    url.searchParams.get("back"),
    DEFAULT_BACK_DAYS,
  );

  const userRow = await query<{
    home_lat: number | null;
    home_lon: number | null;
    near_me_radius_km: number | null;
  }>("SELECT home_lat, home_lon, near_me_radius_km FROM users WHERE id = $1", [
    userId,
  ]);
  const home =
    userRow.rows[0]?.home_lat != null && userRow.rows[0]?.home_lon != null
      ? { lat: userRow.rows[0].home_lat, lon: userRow.rows[0].home_lon }
      : null;
  const distKm = normalizeNearMeRadiusKm(userRow.rows[0]?.near_me_radius_km);

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
        distKm,
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
    distKm,
    radiusOptionsKm: NEAR_ME_RADIUS_OPTIONS_KM,
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

export const actions: Actions = {
  default: async ({ locals, request }) => {
    const userId = locals.user!.id;
    const form = await request.formData();
    const radius = validateNearMeRadiusKm(form.get("near_me_radius_km"));
    if (!radius.ok) return fail(400, { radiusError: radius.error });

    await query("UPDATE users SET near_me_radius_km = $2 WHERE id = $1", [
      userId,
      radius.value,
    ]);
    return { ok: true as const, message: "Near Me radius saved." };
  },
};
