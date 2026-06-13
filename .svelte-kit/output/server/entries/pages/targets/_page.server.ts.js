import { q as query } from "../../../chunks/db.js";
import { g as getEbirdApiKey, E as EbirdError } from "../../../chunks/ebird.js";
import { r as regionTargets } from "../../../chunks/needs.js";
const DEFAULT_REGION = "US-FL-031";
const REGION_PRESETS = [
  { code: "US-FL-031", label: "Duval County, FL" },
  { code: "US-ME-009", label: "Hancock County, ME" },
  { code: "US-FL", label: "Florida" },
  { code: "US-ME", label: "Maine" }
];
const load = async ({ locals, url }) => {
  const userId = locals.user.id;
  const region = (url.searchParams.get("region") ?? DEFAULT_REGION).trim();
  const back = Math.min(Math.max(Number(url.searchParams.get("back") ?? 7) || 7, 1), 30);
  const userRow = await query(
    "SELECT home_lat, home_lon FROM users WHERE id = $1",
    [userId]
  );
  const home = userRow.rows[0]?.home_lat != null && userRow.rows[0]?.home_lon != null ? { lat: userRow.rows[0].home_lat, lon: userRow.rows[0].home_lon } : null;
  const apiKey = await getEbirdApiKey(userId);
  let view = null;
  let error = null;
  if (!apiKey) {
    error = "Add your eBird API key in Settings to load live targets.";
  } else {
    try {
      view = await regionTargets(userId, apiKey, region, back, home);
    } catch (err) {
      error = err instanceof EbirdError ? err.message : `Could not load data for ${region}.`;
    }
  }
  return { region, back, presets: REGION_PRESETS, view, error };
};
export {
  load
};
