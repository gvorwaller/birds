import { withReadSnapshot } from "$lib/db";
import { error, redirect } from "@sveltejs/kit";
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
 * disclosed, never fetched inline. The picker grants access only here, never
 * changes scopeId, and requires opt-in on every shared-list request. Policy
 * and data share one read snapshot. Sync diagnostics are owner-only.
 */
export const load = (async ({ locals, url }) => {
  if (!locals.user) throw redirect(303, "/login");
  const user = locals.user;
  const defaultUserId = locals.scopeId ?? user.id;
  const requested = url.searchParams.get("user");
  if (
    url.searchParams.getAll("user").length > 1 ||
    (requested !== null &&
      (!/^[1-9][0-9]*$/.test(requested) ||
        !Number.isSafeInteger(Number(requested)) ||
        Number(requested) > 2147483647))
  )
    error(400, "Choose a valid life list.");
  const uid = requested === null ? defaultUserId : Number(requested);
  return withReadSnapshot(async (client) => {
    // Include only the existing own/family list and explicitly shared owners.
    // Hidden or deleted IDs produce the same response without disclosing names.
    const owners = await client.query<{ id: number; display_name: string }>(
      `SELECT id,display_name FROM users
       WHERE id=$1 OR (share_life_list AND role IN ('admin','user'))
       ORDER BY (id=$1) DESC,lower(display_name),id`,
      [defaultUserId],
    );
    const selected = owners.rows.find((owner) => owner.id === uid);
    if (!selected) error(404, "This life list is not available to you.");
    const canManage = uid === user.id && user.role !== "viewer";

    const lifers = await client.query<LiferRow>(
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

    const sync = canManage
      ? await client.query<{
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
        )
      : await client.query<{
          life_list_synced_at: string | null;
          life_list_status?: null;
          life_list_error?: null;
          has_creds?: false;
          loc_resolution_status?: null;
          loc_resolution_error?: null;
        }>(
          "SELECT life_list_synced_at::text FROM user_ebird WHERE user_id=$1",
          [uid],
        );

    // Four-count disclosure (td-2fbfc1 §6): pending, negative, noLoc, each
    // computed from the appropriate source — never a single join-null.
    const pendingRes = await client.query<{ n: string }>(
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

    const negativeRes = await client.query<{ n: string }>(
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

    const noLocRes = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM seen_species
      WHERE user_id = $1 AND loc_id IS NULL`,
      [uid],
    );

    const s = sync.rows[0];
    return {
      selectedUser: { id: selected.id, name: selected.display_name },
      listChoices: owners.rows.map((owner) => ({
        id: owner.id,
        label:
          owner.id === defaultUserId
            ? defaultUserId === user.id
              ? "My life list"
              : `${owner.display_name} (family list)`
            : owner.display_name,
      })),
      defaultUserId,
      canManage,
      isOtherList: uid !== user.id,
      listHref: uid === defaultUserId ? "/life" : `/life?user=${uid}`,
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
      isViewer: user.role === "viewer",
    };
  });
}) satisfies PageServerLoad;
