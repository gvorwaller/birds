import { query } from "$lib/db";
export interface TaxonomyFamily {
  code: string;
  name: string | null;
  scientificName: string | null;
  order: string | null;
  count: number;
  taxonOrder: number | null;
}
export async function taxonomySummary() {
  const r =
    await query<TaxonomyFamily>(`SELECT family_code AS code, min(family) AS name,
    min(family_sci_name) AS "scientificName", min(order_name) AS "order",
    count(*)::int AS count, min(taxon_order)::float8 AS "taxonOrder"
    FROM taxonomy_cache WHERE category='species' AND family_code IS NOT NULL
    GROUP BY family_code ORDER BY min(taxon_order) NULLS LAST, min(family), family_code`);
  const meta = await query<{
    total: number;
    missing: number;
    ordered: number;
    banding: number;
    refreshed: string | null;
  }>(`SELECT count(*)::int AS total,
    count(*) FILTER(WHERE family_code IS NULL)::int AS missing,
    count(*) FILTER(WHERE taxon_order IS NOT NULL)::int AS ordered,
    count(*) FILTER(WHERE cardinality(banding_codes)>0)::int AS banding,
    max(fetched_at)::text AS refreshed FROM taxonomy_cache WHERE category='species'`);
  return { families: r.rows, ...meta.rows[0] };
}
