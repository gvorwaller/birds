/**
 * Home's remembered search area (td-9304cd). A bare `/` — the Home tab, the
 * logo — reopens the signed-in account's last Home search instead of the saved
 * home, until "Reset home defaults". Keyed on the ACCOUNT (`locals.user.id`),
 * not `locals.scopeId`: a viewer's searches are their own and never move the
 * owner's Home.
 *
 * Each part is stored only when it differs from the default, so a later change
 * to the saved home or saved radius in Settings still shows through wherever
 * the last search used the default.
 */
import { query } from "$lib/db";

export interface HomeSearch {
  /** A searched place or map point, resolved to exact coordinates. */
  place: { lat: number; lng: number; label: string } | null;
  distKm: number | null;
  backDays: number | null;
}

/** The record to keep for a submitted Home search, or null when every part
 * is the default (nothing to remember). */
export function homeSearchToSave(
  searched: { lat: number; lng: number; label: string } | null,
  distKm: number,
  savedRadiusKm: number,
  backDays: number,
  defaultBackDays: number,
): HomeSearch | null {
  const record: HomeSearch = {
    place: searched
      ? { lat: searched.lat, lng: searched.lng, label: searched.label }
      : null,
    distKm: distKm !== savedRadiusKm ? distKm : null,
    backDays: backDays !== defaultBackDays ? backDays : null,
  };
  return record.place || record.distKm != null || record.backDays != null
    ? record
    : null;
}

export async function loadHomeSearch(
  accountId: number,
): Promise<HomeSearch | null> {
  const r = await query<{
    place_label: string | null;
    lat: number | null;
    lng: number | null;
    dist_km: number | null;
    back_days: number | null;
  }>(
    "SELECT place_label, lat, lng, dist_km, back_days FROM home_search WHERE user_id = $1",
    [accountId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    place:
      row.place_label != null && row.lat != null && row.lng != null
        ? { lat: row.lat, lng: row.lng, label: row.place_label }
        : null,
    distKm: row.dist_km,
    backDays: row.back_days,
  };
}

/** Remember `search` for the account, or forget it when null. */
export async function saveHomeSearch(
  accountId: number,
  search: HomeSearch | null,
): Promise<void> {
  if (!search) {
    await query("DELETE FROM home_search WHERE user_id = $1", [accountId]);
    return;
  }
  await query(
    `INSERT INTO home_search (user_id, place_label, lat, lng, dist_km, back_days, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (user_id) DO UPDATE
       SET place_label = EXCLUDED.place_label, lat = EXCLUDED.lat,
           lng = EXCLUDED.lng, dist_km = EXCLUDED.dist_km,
           back_days = EXCLUDED.back_days, updated_at = now()`,
    [
      accountId,
      search.place?.label ?? null,
      search.place?.lat ?? null,
      search.place?.lng ?? null,
      search.distKm,
      search.backDays,
    ],
  );
}
