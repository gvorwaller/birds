import { error } from "@sveltejs/kit";
import { q as query } from "../../../../chunks/db.js";
import { g as getEbirdApiKey, r as recentNearbySpeciesObs, E as EbirdError } from "../../../../chunks/ebird.js";
import { h as haversineKm } from "../../../../chunks/geo.js";
const NEARBY_DIST_KM = 50;
const NEARBY_BACK_DAYS = 14;
const load = async ({ locals, params }) => {
  const userId = locals.user.id;
  const code = params.code;
  const taxon = await query("SELECT species_code, com_name, sci_name, family FROM taxonomy_cache WHERE species_code = $1", [
    code
  ]);
  if (!taxon.rows[0]) {
    throw error(404, `Species code "${code}" not found — is the taxonomy synced?`);
  }
  const t = taxon.rows[0];
  const [seen, photos, userRow] = await Promise.all([
    query(
      "SELECT first_seen, source FROM seen_species WHERE user_id = $1 AND species_code = $2",
      [userId, code]
    ),
    query(
      `SELECT photo_id, thumbnail, page_url, taken_on FROM photo_links
			  WHERE species_code = $1 ORDER BY taken_on DESC NULLS LAST`,
      [code]
    ),
    query(
      "SELECT home_lat, home_lon FROM users WHERE id = $1",
      [userId]
    )
  ]);
  const home = userRow.rows[0]?.home_lat != null && userRow.rows[0]?.home_lon != null ? { lat: userRow.rows[0].home_lat, lon: userRow.rows[0].home_lon } : null;
  let nearby = [];
  let nearbyError = null;
  let stale = false;
  const apiKey = await getEbirdApiKey(userId);
  if (apiKey && home) {
    try {
      const result = await recentNearbySpeciesObs(
        apiKey,
        code,
        home.lat,
        home.lon,
        NEARBY_DIST_KM,
        NEARBY_BACK_DAYS
      );
      stale = result.stale;
      nearby = result.data.map((o) => ({
        ...o,
        distanceKm: home ? haversineKm(home.lat, home.lon, o.lat, o.lng) : null
      })).sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)).slice(0, 15);
    } catch (err) {
      nearbyError = err instanceof EbirdError ? err.message : "Could not load nearby observations.";
    }
  }
  return {
    taxon: t,
    seen: seen.rows[0] ?? null,
    photos: photos.rows,
    nearby,
    nearbyError,
    stale,
    hasApiKey: !!apiKey,
    hasHome: !!home,
    distKm: NEARBY_DIST_KM,
    backDays: NEARBY_BACK_DAYS
  };
};
export {
  load
};
