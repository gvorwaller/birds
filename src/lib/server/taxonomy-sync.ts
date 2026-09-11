import type { PoolClient } from "pg";
import { withTransaction } from "$lib/db";

export interface TaxonomyEntry {
  speciesCode: string;
  comName: string;
  sciName: string;
  category: string;
  familyComName: string | null;
  taxonOrder: number | null;
  order: string | null;
  familyCode: string | null;
  familySciName: string | null;
  bandingCodes: string[] | null;
  reportAs: string | null;
  extinct: boolean | null;
}
// eBird includes the real spuh code bird-o1.
const identifier = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Validate before starting replacement. Error messages never contain payloads. */
export function parseTaxonomy(value: unknown): TaxonomyEntry[] {
  if (!Array.isArray(value) || !value.length)
    throw Error("Taxonomy response is empty or invalid.");
  const codes = new Set<string>();
  const families = new Map<string, string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw Error("Invalid taxonomy row.");
    const v = item as Record<string, unknown>;
    function text(key: string, required = false): string | null {
      const x = v[key];
      if (x == null && !required) return null;
      if (typeof x !== "string" || !x.trim())
        throw Error(`Invalid taxonomy ${key}.`);
      return x.trim();
    }
    const speciesCode = text("speciesCode", true)!;
    if (!identifier.test(speciesCode) || codes.has(speciesCode))
      throw Error("Invalid or duplicate taxonomy species code.");
    codes.add(speciesCode);
    const familyCode = text("familyCode"),
      reportAs = text("reportAs");
    if ([familyCode, reportAs].some((x) => x !== null && !identifier.test(x)))
      throw Error("Invalid taxonomy relationship code.");
    const order = text("order");
    if (familyCode && order) {
      if (families.has(familyCode) && families.get(familyCode) !== order)
        throw Error("Inconsistent taxonomy family/order relationship.");
      families.set(familyCode, order);
    }
    const taxonOrder = v.taxonOrder ?? null;
    if (
      taxonOrder !== null &&
      (typeof taxonOrder !== "number" ||
        !Number.isFinite(taxonOrder) ||
        taxonOrder < 0)
    )
      throw Error("Invalid taxonomy ordering.");
    const banding = v.bandingCodes ?? null;
    if (
      banding !== null &&
      (!Array.isArray(banding) ||
        banding.some((x) => typeof x !== "string" || !/^[A-Z0-9]+$/i.test(x)))
    )
      throw Error("Invalid taxonomy banding codes.");
    const extinct = v.extinct ?? null;
    if (extinct !== null && typeof extinct !== "boolean")
      throw Error("Invalid taxonomy extinct status.");
    return {
      speciesCode,
      comName: text("comName", true)!,
      sciName: text("sciName", true)!,
      category: text("category", true)!,
      familyComName: text("familyComName"),
      familyCode,
      reportAs,
      order,
      taxonOrder: taxonOrder as number | null,
      familySciName: text("familySciName"),
      bandingCodes:
        banding === null
          ? null
          : [...new Set((banding as string[]).map((x) => x.toUpperCase()))],
      extinct: extinct as boolean | null,
    };
  });
}
export async function replaceTaxonomy(payload: unknown): Promise<number> {
  const taxa = parseTaxonomy(payload);
  await withTransaction((c) => writeTaxonomy(c, taxa));
  return taxa.length;
}
/** Caller owns the transaction, including deferred override constraints. */
export async function writeTaxonomy(
  c: PoolClient,
  taxa: TaxonomyEntry[],
): Promise<void> {
  await c.query("DELETE FROM taxonomy_cache");
  for (let i = 0; i < taxa.length; i += 500) {
    const params: unknown[] = [];
    const values = taxa.slice(i, i + 500).map((t, j) => {
      params.push(
        t.speciesCode,
        t.comName,
        t.sciName,
        t.category,
        t.familyComName,
        t.taxonOrder,
        t.order,
        t.familyCode,
        t.familySciName,
        t.bandingCodes,
        t.reportAs,
        t.extinct,
      );
      return (
        "(" +
        Array.from({ length: 12 }, (_, k) => `$${j * 12 + k + 1}`).join(",") +
        ")"
      );
    });
    await c.query(
      `INSERT INTO taxonomy_cache(species_code,com_name,sci_name,category,family,taxon_order,order_name,family_code,family_sci_name,banding_codes,report_as,extinct) VALUES ${values.join(",")}`,
      params,
    );
  }
}
