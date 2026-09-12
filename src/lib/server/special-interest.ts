import { query } from "$lib/db";
import { error } from "@sveltejs/kit";

export async function setSpecialInterest(
  userId: number,
  code: string,
  saved: boolean,
) {
  if (saved) {
    // Validate and insert in one statement. Duplicate requests preserve the date.
    const result = await query<{ current: boolean }>(
      `WITH taxon AS (SELECT species_code FROM taxonomy_cache WHERE species_code=$2 AND category='species'),
       inserted AS (INSERT INTO species_special_interest(user_id,species_code)
         SELECT $1,species_code FROM taxon ON CONFLICT DO NOTHING)
       SELECT EXISTS(SELECT 1 FROM taxon) AS current`,
      [userId, code],
    );
    if (!result.rows[0].current)
      error(404, "Species is not in the current taxonomy");
  } else {
    await query(
      "DELETE FROM species_special_interest WHERE user_id=$1 AND species_code=$2",
      [userId, code],
    );
  }
  return { saved };
}

export async function specialInterestFor(
  userId: number,
  codes: string[],
): Promise<string[]> {
  if (!codes.length) return [];
  const r = await query<{ species_code: string }>(
    "SELECT species_code FROM species_special_interest WHERE user_id=$1 AND species_code=ANY($2::text[])",
    [userId, codes],
  );
  return r.rows.map((r) => r.species_code);
}

export async function specialInterestSpecies(
  userId: number,
  search: string,
  sort: "name" | "recent",
) {
  const escaped = search.replace(/[%_\\]/g, (m) => `\\${m}`);
  const r = await query<{
    species_code: string;
    com_name: string | null;
    sci_name: string | null;
    current: boolean;
    marked_at: Date;
  }>(
    `SELECT s.species_code,t.com_name,t.sci_name,COALESCE(t.category='species',false) AS current,s.marked_at
       FROM species_special_interest s LEFT JOIN taxonomy_cache t USING(species_code)
      WHERE s.user_id=$1 AND ($2='' OR s.species_code ILIKE $3 OR t.com_name ILIKE $3
        OR t.sci_name ILIKE $3 OR t.banding_codes @> ARRAY[upper($2)])
      ORDER BY ${sort === "recent" ? "s.marked_at DESC,s.species_code" : "COALESCE(t.com_name,s.species_code),s.species_code"}`,
    [userId, search, `%${escaped}%`],
  );
  return r.rows.map((r) => ({
    code: r.species_code,
    name: r.com_name,
    scientificName: r.sci_name,
    current: r.current,
    markedAt: r.marked_at.toISOString(),
  }));
}
