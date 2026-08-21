import { query } from "$lib/db";
import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export interface LiferRow {
  species_code: string;
  com_name: string;
  first_seen: string | null;
  csv_row_num: number | null;
  obs_count: number | null;
  location_name: string | null;
  loc_id: string | null;
  region_code: string | null;
  sub_id: string | null;
  exotic: string | null;
  countable: boolean | null;
  lat: number | null;
  lng: number | null;
}

/**
 * JOIN-ONLY loader (GROK td-b5986c pin 1): seen_species → taxonomy_cache
 * (names) → ebird_locations + lifer_loc_coords (coordinates). No eBird API,
 * no Google Places — unresolved locations render in the timeline and are
 * disclosed, never fetched inline. Viewers read the account owner's data
 * via scopeId (nearest precedent; no redaction).
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(303, "/login");
  const uid = locals.scopeId!;

  const lifers = await query<LiferRow>(
    `SELECT ss.species_code,
            COALESCE(tc.com_name, ss.species_code) AS com_name,
            ss.first_seen::text, ss.csv_row_num, ss.obs_count,
            ss.location_name, ss.loc_id, ss.region_code, ss.sub_id,
            ss.exotic, ss.countable,
            COALESCE(el.lat, llc.lat) AS lat,
            COALESCE(el.lng, llc.lng) AS lng
       FROM seen_species ss
       LEFT JOIN taxonomy_cache tc ON tc.species_code = ss.species_code
       LEFT JOIN ebird_locations el ON el.loc_id = ss.loc_id
       LEFT JOIN lifer_loc_coords llc
              ON llc.user_id = $1 AND llc.source_loc_id = ss.loc_id
      WHERE ss.user_id = $1
      ORDER BY ss.first_seen DESC NULLS LAST, ss.csv_row_num ASC`,
    [uid],
  );

  const sync = await query<{
    life_list_synced_at: string | null;
    life_list_status: string | null;
    life_list_error: string | null;
    has_creds: boolean;
    loc_resolution_status: string | null;
    loc_resolution_error: string | null;
  }>(
    `SELECT life_list_synced_at::text, life_list_status, life_list_error,
            (login_username_enc IS NOT NULL AND login_password_enc IS NOT NULL) AS has_creds,
            loc_resolution_status, loc_resolution_error
       FROM user_ebird WHERE user_id = $1`,
    [uid],
  );

  // Four-count disclosure (td-2fbfc1 §6): pending, negative, noLoc, each
  // computed from the appropriate source — never a single join-null.
  const pendingRes = await query<{ n: string }>(
    `SELECT COUNT(DISTINCT ss.loc_id) AS n
       FROM seen_species ss
      WHERE ss.user_id = $1
        AND ss.loc_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ebird_locations el WHERE el.loc_id = ss.loc_id)
        AND NOT EXISTS (SELECT 1 FROM lifer_loc_coords llc
                         WHERE llc.user_id = ss.user_id AND llc.source_loc_id = ss.loc_id)
        AND NOT EXISTS (SELECT 1 FROM lifer_loc_attempts la
                         WHERE la.user_id = ss.user_id AND la.loc_id = ss.loc_id
                           AND la.reason IN ('no_coords', 'gone'))`,
    [uid],
  );

  const negativeRes = await query<{ n: string }>(
    `SELECT COUNT(DISTINCT la.loc_id) AS n
       FROM lifer_loc_attempts la
      WHERE la.user_id = $1
        AND la.reason IN ('no_coords', 'gone')
        AND EXISTS (SELECT 1 FROM seen_species ss
                     WHERE ss.user_id = la.user_id AND ss.loc_id = la.loc_id)
        AND NOT EXISTS (SELECT 1 FROM ebird_locations el WHERE el.loc_id = la.loc_id)
        AND NOT EXISTS (SELECT 1 FROM lifer_loc_coords llc
                         WHERE llc.user_id = la.user_id AND llc.source_loc_id = la.loc_id)`,
    [uid],
  );

  const noLocRes = await query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM seen_species
      WHERE user_id = $1 AND loc_id IS NULL`,
    [uid],
  );

  const s = sync.rows[0];
  return {
    lifers: lifers.rows,
    syncedAt: s?.life_list_synced_at ?? null,
    syncStatus: s?.life_list_status ?? null,
    syncError: s?.life_list_error ?? null,
    hasCreds: s?.has_creds ?? false,
    locResolutionStatus: s?.loc_resolution_status ?? null,
    locResolutionError: s?.loc_resolution_error ?? null,
    pendingUnattempted: Number(pendingRes.rows[0]?.n ?? 0),
    negatives: Number(negativeRes.rows[0]?.n ?? 0),
    noLoc: Number(noLocRes.rows[0]?.n ?? 0),
    isViewer: locals.user.role === "viewer",
  };
};
