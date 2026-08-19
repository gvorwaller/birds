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
 * (names) → ebird_locations (coordinates). No eBird API, no Google Places —
 * unresolved locations render in the timeline and are disclosed, never
 * fetched inline. Viewers read the account owner's data via scopeId
 * (nearest precedent; no redaction).
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
            el.lat, el.lng
       FROM seen_species ss
       LEFT JOIN taxonomy_cache tc ON tc.species_code = ss.species_code
       LEFT JOIN ebird_locations el ON el.loc_id = ss.loc_id
      WHERE ss.user_id = $1
      ORDER BY ss.first_seen DESC NULLS LAST, ss.csv_row_num ASC`,
    [uid],
  );

  const sync = await query<{ life_list_synced_at: string | null; has_creds: boolean }>(
    `SELECT life_list_synced_at::text,
            (login_username_enc IS NOT NULL AND login_password_enc IS NOT NULL) AS has_creds
       FROM user_ebird WHERE user_id = $1`,
    [uid],
  );

  return {
    lifers: lifers.rows,
    syncedAt: sync.rows[0]?.life_list_synced_at ?? null,
    hasCreds: sync.rows[0]?.has_creds ?? false,
    isViewer: locals.user.role === "viewer",
  };
};
