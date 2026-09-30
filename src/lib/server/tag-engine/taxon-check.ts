/**
 * Taxon sanity checks for a rule set against the real taxonomy (td-894144;
 * B4 draft check extended for schema 2, plan
 * docs/2026-09-30-open-ocean-rules-v2-plan.md §3a, §3p).
 *
 * Refused:
 *  - a taxon or scope value naming no known order / family / genus of that
 *    rank (a silent no-op, e.g. "Phalaropidae" — phalaropes are Scolopacidae).
 *    "Known" = the whole species taxonomy, not just species with an article;
 *  - taxon rules that admit no species of the tag universe (require_one_of
 *    rules AND together);
 *  - an `assign` that overlaps a `forbid` or an unmet `require_one_of` for any
 *    species of the taxonomy. The scanner's order would let the disqualifier
 *    win silently, so a more specific assign could never take effect.
 *
 * Mirrors the scanner's taxon step; a species with an unknown rank value is
 * never counted as admitted or as overlapping.
 */
import { genusOf } from "./scanner";
import type { Ruleset, TaxonRank, TaxonRule } from "./rules";

export interface TaxonomySpecies {
  code: string;
  order: string | null;
  family: string | null;
  genus: string | null;
  /** In the tag universe (stored article + species taxonomy row). */
  universe: boolean;
}

export interface KnownTaxa {
  order: ReadonlySet<string>;
  family: ReadonlySet<string>;
  genus: ReadonlySet<string>;
}

/** Overlap diagnostics are bounded (plan §3p): the true count + the first 20. */
export const OVERLAP_EXAMPLES = 20;

export function knownTaxaOf(species: readonly TaxonomySpecies[]): KnownTaxa {
  const pick = (f: (s: TaxonomySpecies) => string | null) =>
    new Set(species.map(f).filter((v): v is string => v != null));
  return {
    order: pick((s) => s.order),
    family: pick((s) => s.family),
    genus: pick((s) => s.genus),
  };
}

const valueOf = (s: TaxonomySpecies, rank: TaxonRank): string | null =>
  rank === "order" ? s.order : rank === "family" ? s.family : s.genus;

const cmpC = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function disqualifier(
  s: TaxonomySpecies,
  forbids: readonly TaxonRule[],
  requires: readonly TaxonRule[],
): TaxonRule | null {
  for (const t of forbids) {
    const v = valueOf(s, t.rank);
    if (v != null && t.values.includes(v)) return t;
  }
  for (const t of requires) {
    const v = valueOf(s, t.rank);
    if (v != null && !t.values.includes(v)) return t;
  }
  return null;
}

export interface TaxonCheck {
  /** Universe species passing every forbid/require with all ranks known. */
  admitted: number;
  problems: string[];
  overlap: { count: number; examples: string[] };
}

export function checkTaxonRules(
  ruleset: Pick<Ruleset, "taxon" | "support">,
  species: readonly TaxonomySpecies[],
  known: KnownTaxa = knownTaxaOf(species),
): TaxonCheck {
  const problems: string[] = [];
  const rules = ruleset.taxon;
  for (const r of rules) {
    const unknown = r.values.filter((v) => !known[r.rank].has(v));
    if (unknown.length)
      problems.push(
        `taxon rule ${r.id} names no known ${r.rank}: ${unknown.join(", ")}`,
      );
  }
  for (const s of ruleset.support)
    for (const e of s.taxa ?? []) {
      const unknown = e.values.filter((v) => !known[e.rank].has(v));
      if (unknown.length)
        problems.push(
          `support rule ${s.id} is scoped to no known ${e.rank}: ${unknown.join(", ")}`,
        );
    }

  const forbids = rules.filter((t) => t.action === "forbid");
  const requires = rules.filter((t) => t.action === "require_one_of");
  const assigns = rules.filter((t) => t.action === "assign");
  const gates = [...forbids, ...requires];

  let admitted = 0;
  for (const s of species) {
    if (!s.universe) continue;
    if (gates.some((t) => valueOf(s, t.rank) == null)) continue;
    if (!disqualifier(s, forbids, requires)) admitted++;
  }
  if (gates.length && admitted === 0)
    problems.push(
      "the taxon rules admit no species at all (every require_one_of rule must hold at once; list alternative taxa in ONE rule)",
    );

  const overlaps: string[] = [];
  if (assigns.length)
    for (const s of [...species].sort((a, b) => cmpC(a.code, b.code))) {
      const a = assigns.find((t) => {
        const v = valueOf(s, t.rank);
        return v != null && t.values.includes(v);
      });
      if (!a) continue;
      const d = disqualifier(s, forbids, requires);
      if (d) overlaps.push(`${s.code} (${a.id} vs ${d.id})`);
    }
  if (overlaps.length)
    problems.push(
      `${overlaps.length} species are matched by an assign rule but disqualified by a forbid or require_one_of rule (the disqualifier would win), e.g. ${overlaps
        .slice(0, OVERLAP_EXAMPLES)
        .join(", ")}`,
    );
  return {
    admitted,
    problems,
    overlap: {
      count: overlaps.length,
      examples: overlaps.slice(0, OVERLAP_EXAMPLES),
    },
  };
}

type Exec = <T extends Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<{ rows: T[] }>;

/** Every species-category taxon, flagged by universe membership. Genus via genusOf. */
export async function loadTaxonomyForCheck(
  exec: Exec,
): Promise<TaxonomySpecies[]> {
  const rows = (
    await exec<{
      code: string;
      order_name: string | null;
      family_sci_name: string | null;
      sci_name: string | null;
      universe: boolean;
    }>(
      `SELECT tc.species_code AS code, tc.order_name, tc.family_sci_name, tc.sci_name,
              EXISTS (SELECT 1 FROM species_enrichment se
                       WHERE se.species_code = tc.species_code AND se.wikipedia_extract IS NOT NULL) AS universe
         FROM taxonomy_cache tc WHERE tc.category = 'species'`,
    )
  ).rows;
  return rows.map((r) => ({
    code: r.code,
    order: r.order_name,
    family: r.family_sci_name,
    genus: genusOf(r.sci_name),
    universe: r.universe,
  }));
}
