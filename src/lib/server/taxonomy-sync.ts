import type { PoolClient } from "pg";
import { withTagWriteTx, type TagWriteTx } from "$server/tag-engine/runtime";
import { lexiconFor, materializeMany } from "$server/tag-engine/materialize";
import { beginTagRepair } from "$server/tag-engine/repair";

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
/**
 * td-894144 Release B: a tag-engine ENTRY POINT, run under the EXCLUSIVE
 * engine lock (withTagWriteTx) so no wiki write can commit an input derived
 * from the old taxonomy after this commits. `requesterId` is the sync job's
 * requester; it owns any repair job this change opens (plan rev 21).
 */
export async function replaceTaxonomy(payload: unknown, requesterId: number): Promise<number> {
  const taxa = parseTaxonomy(payload);
  await withTagWriteTx("exclusive", "global:replaceTaxonomy", "replaceTaxonomy", async (tx) => {
    const before = await beginTaxonomyChange(tx);
    await writeTaxonomy(tx.client, taxa);
    await finishTaxonomyChange(tx, before, requesterId);
  });
  return taxa.length;
}

export interface TaxonomyBefore {
  snapshot: Map<string, string>;
  lexiconHash: string | null;
}

/** Before writing: what the tag inputs were derived from. */
export async function beginTaxonomyChange(tx: TagWriteTx): Promise<TaxonomyBefore> {
  const lexiconHash =
    (
      await tx.exec<{ lexicon_hash: string }>(
        "SELECT lexicon_hash FROM tag_lexicon_state WHERE id = 1",
      )
    ).rows[0]?.lexicon_hash ?? null;
  return { snapshot: await snapshotTaxonomy(tx), lexiconHash };
}

export type TaxonomyRederive =
  | { mode: "changed"; changed: number }
  | { mode: "repair"; changed: number; generation: string; jobId: number | null };

/**
 * After writing, same transaction.
 *  - Unchanged lexicon → re-derive only the species whose own taxon row
 *    changed, here. Usually few, but unbounded (td-fbd304).
 *  - Changed LEXICON → every input is stale: open a repair generation + its
 *    job (batched, off-lock), whether or not a tag is owned. Nothing is
 *    re-derived inline — the workset's lexicon-mismatch class already holds
 *    every changed species. td-861855: on the droplet the old inline paths
 *    cost ~25 s (whole universe, no owned tag) and ~4.4 ms per changed
 *    species of the 30 s exclusive cap.
 */
export async function finishTaxonomyChange(
  tx: TagWriteTx,
  before: TaxonomyBefore,
  requesterId: number,
): Promise<TaxonomyRederive> {
  const lex = await lexiconFor(tx, { rebuild: true });
  const after = await snapshotTaxonomy(tx);
  const changed = new Set<string>();
  for (const [code, v] of before.snapshot) if (after.get(code) !== v) changed.add(code);
  for (const [code, v] of after) if (before.snapshot.get(code) !== v) changed.add(code);
  if (lex.hash === before.lexiconHash) {
    if (changed.size > 0) await materializeMany(tx, [...changed]);
    return { mode: "changed", changed: changed.size };
  }
  const r = await beginTagRepair(tx, lex.hash, requesterId);
  return { mode: "repair", changed: changed.size, generation: r.generation.toString(), jobId: r.jobId };
}

/** code → the taxonomy fields a tag decision depends on. */
async function snapshotTaxonomy(tx: TagWriteTx): Promise<Map<string, string>> {
  const rows = (
    await tx.exec<{ species_code: string; k: string }>(
      `SELECT species_code,
              jsonb_build_array(category, order_name, family_sci_name, com_name, sci_name, family)::text AS k
         FROM taxonomy_cache`,
    )
  ).rows;
  return new Map(rows.map((r) => [r.species_code, r.k]));
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
