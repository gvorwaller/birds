import { q as query } from "../../chunks/db.js";
import { g as getEbirdApiKey, E as EbirdError } from "../../chunks/ebird.js";
import { n as nearbyNeeds } from "../../chunks/needs.js";
const NEARBY_DIST_KM = 40;
const NEARBY_BACK_DAYS = 7;
const load = async ({ locals }) => {
  const userId = locals.user.id;
  const userRow = await query(
    "SELECT home_lat, home_lon FROM users WHERE id = $1",
    [userId]
  );
  const home = userRow.rows[0]?.home_lat != null && userRow.rows[0]?.home_lon != null ? { lat: userRow.rows[0].home_lat, lon: userRow.rows[0].home_lon } : null;
  const [seenCount, photoCount, ebirdState] = await Promise.all([
    query("SELECT COUNT(*) AS n FROM seen_species WHERE user_id = $1", [userId]),
    query("SELECT COUNT(*) AS n FROM photo_links"),
    query(
      "SELECT life_list_synced_at, life_list_status FROM user_ebird WHERE user_id = $1",
      [userId]
    )
  ]);
  let needs = [];
  let needsError = null;
  let stale = false;
  const apiKey = await getEbirdApiKey(userId);
  if (apiKey && home) {
    try {
      const result = await nearbyNeeds(userId, apiKey, home, NEARBY_DIST_KM, NEARBY_BACK_DAYS);
      needs = result.needs.slice(0, 20);
      stale = result.stale;
    } catch (err) {
      needsError = err instanceof EbirdError ? err.message : "Could not load recent observations.";
    }
  }
  return {
    home,
    hasApiKey: !!apiKey,
    needs,
    needsError,
    stale,
    distKm: NEARBY_DIST_KM,
    backDays: NEARBY_BACK_DAYS,
    seenCount: Number(seenCount.rows[0]?.n ?? 0),
    photoCount: Number(photoCount.rows[0]?.n ?? 0),
    lifeListSyncedAt: ebirdState.rows[0]?.life_list_synced_at ?? null,
    lifeListStatus: ebirdState.rows[0]?.life_list_status ?? null
  };
};
export {
  load
};
