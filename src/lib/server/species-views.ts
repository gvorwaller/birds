import { query, withTransaction } from "$lib/db";
import { error } from "@sveltejs/kit";
import type { SpeciesView, SpeciesViewResult } from "$lib/species-views";

type HistoryRow = { first_viewed_at: Date; last_viewed_at: Date };
const toView = (r: HistoryRow): SpeciesView => ({
  firstViewedAt: r.first_viewed_at.toISOString(),
  lastViewedAt: r.last_viewed_at.toISOString(),
});

export async function recordSpeciesView(
  userId: number,
  code: string,
  visitId: string,
): Promise<SpeciesViewResult> {
  return withTransaction(async (c) => {
    // Serialize recording, pause and clear for this account. Never lock/write
    // the user's shared data owner, and never derive identity from the body.
    const user = await c.query<{ record_species_views: boolean }>(
      "SELECT record_species_views FROM users WHERE id=$1 FOR UPDATE",
      [userId],
    );
    if (!user.rows[0]) error(401, "Account unavailable");
    const existing = await c.query<HistoryRow>(
      "SELECT first_viewed_at,last_viewed_at FROM species_view_history WHERE user_id=$1 AND species_code=$2",
      [userId, code],
    );
    if (!user.rows[0].record_species_views)
      return {
        enabled: false,
        view: existing.rows[0] ? toView(existing.rows[0]) : null,
      };
    const receipt = await c.query<{ species_code: string }>(
      "SELECT species_code FROM species_view_receipts WHERE user_id=$1 AND visit_id=$2",
      [userId, visitId],
    );
    if (receipt.rows[0]) {
      if (receipt.rows[0].species_code !== code)
        error(409, "Visit already belongs to another species");
      return { enabled: true, view: toView(existing.rows[0]) };
    }
    const taxon = await c.query(
      "SELECT 1 FROM taxonomy_cache WHERE species_code=$1 AND category='species'",
      [code],
    );
    if (!taxon.rowCount) error(404, "Species is not in the current taxonomy");
    const saved = await c.query<HistoryRow>(
      `INSERT INTO species_view_history(user_id,species_code,first_viewed_at,last_viewed_at)
       VALUES($1,$2,clock_timestamp(),clock_timestamp())
       ON CONFLICT(user_id,species_code) DO UPDATE SET
         last_viewed_at=GREATEST(species_view_history.last_viewed_at,EXCLUDED.last_viewed_at)
       RETURNING first_viewed_at,last_viewed_at`,
      [userId, code],
    );
    await c.query(
      "INSERT INTO species_view_receipts(user_id,visit_id,species_code) VALUES($1,$2,$3)",
      [userId, visitId, code],
    );
    return { enabled: true, view: toView(saved.rows[0]) };
  });
}

export async function setSpeciesViewTracking(
  userId: number,
  enabled: boolean,
): Promise<void> {
  await query("UPDATE users SET record_species_views=$2 WHERE id=$1", [
    userId,
    enabled,
  ]);
}
export async function clearSpeciesViews(userId: number): Promise<void> {
  await withTransaction(async (c) => {
    await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
    await c.query("DELETE FROM species_view_history WHERE user_id=$1", [
      userId,
    ]);
  });
}

export async function speciesViewsFor(
  userId: number,
  codes: string[],
): Promise<Record<string, SpeciesView>> {
  if (!codes.length) return {};
  const r = await query<HistoryRow & { species_code: string }>(
    `SELECT species_code,first_viewed_at,last_viewed_at FROM species_view_history
     WHERE user_id=$1 AND species_code=ANY($2::text[])`,
    [userId, codes],
  );
  return Object.fromEntries(r.rows.map((r) => [r.species_code, toView(r)]));
}

export interface ViewedSpecies extends SpeciesView {
  code: string;
  name: string | null;
  scientificName: string | null;
  current: boolean;
  family: string | null;
}
export async function viewedSpecies(
  userId: number,
  search: string,
  alphabetical: boolean,
) {
  const user = await query<{ record_species_views: boolean }>(
    "SELECT record_species_views FROM users WHERE id=$1",
    [userId],
  );
  if (!user.rows[0]) error(401, "Account unavailable");
  const escaped = search.replace(/[%_\\]/g, (m) => `\\${m}`);
  // No hidden cap. This collection retains retired codes, with an explicit
  // unavailable-taxonomy label instead of fabricating or losing their names.
  const r = await query<
    HistoryRow & {
      species_code: string;
      com_name: string | null;
      sci_name: string | null;
      current: boolean;
      family: string | null;
    }
  >(
    `SELECT h.species_code,h.first_viewed_at,h.last_viewed_at,t.com_name,t.sci_name,t.family,
            COALESCE(t.category='species',false) AS current
       FROM species_view_history h LEFT JOIN taxonomy_cache t USING(species_code)
      WHERE h.user_id=$1 AND ($2='' OR h.species_code ILIKE $3 OR t.com_name ILIKE $3 OR t.sci_name ILIKE $3)
      ORDER BY ${alphabetical ? "COALESCE(t.com_name,h.species_code),h.species_code" : "h.last_viewed_at DESC,h.species_code"}`,
    [userId, search, `%${escaped}%`],
  );
  return {
    enabled: user.rows[0].record_species_views,
    rows: r.rows.map((r) => ({
      code: r.species_code,
      name: r.com_name,
      scientificName: r.sci_name,
      current: r.current,
      family: r.family,
      ...toView(r),
    })),
  };
}
