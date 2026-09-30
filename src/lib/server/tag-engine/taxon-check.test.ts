/**
 * td-894144 B5 (plan §3a/§3p): the taxonomy sanity check shared by the AI
 * draft job, human proposals, approval and Preview. Pure — no database.
 */
import { describe, expect, it } from "vitest";
import type { Ruleset, TaxonRule } from "./rules";
import { genusOf } from "./scanner";
import {
  checkTaxonRules,
  knownTaxaOf,
  OVERLAP_EXAMPLES,
  type TaxonomySpecies,
} from "./taxon-check";

const sp = (
  code: string,
  order: string | null,
  family: string | null,
  genus: string | null,
  universe = true,
): TaxonomySpecies => ({ code, order, family, genus, universe });

const TAXONOMY: TaxonomySpecies[] = [
  sp("sooshe", "Procellariiformes", "Procellariidae", "Ardenna"),
  sp("wanalb", "Procellariiformes", "Diomedeidae", "Diomedea"),
  sp("atlpuf", "Charadriiformes", "Alcidae", "Fratercula"),
  sp("redpha", "Charadriiformes", "Scolopacidae", "Phalaropus"),
  sp("dunlin", "Charadriiformes", "Scolopacidae", "Calidris"),
  sp("amerob", "Passeriformes", "Turdidae", "Turdus"),
  sp("unknow", null, null, null),
  // A real family with no stored article (outside the tag universe).
  sp("kauoo", "Passeriformes", "Mohoidae", "Moho", false),
];

const rule = (
  id: string,
  rank: TaxonRule["rank"],
  action: TaxonRule["action"],
  values: string[],
): TaxonRule => ({ id, rank, action, values, note: "" });

const rs = (
  taxon: TaxonRule[],
  support: Ruleset["support"] = [],
): Pick<Ruleset, "taxon" | "support"> => ({ taxon, support });

describe("genusOf (the one genus parser)", () => {
  it("takes the first token of a binomial or trinomial", () => {
    expect(genusOf("Ardenna grisea")).toBe("Ardenna");
    expect(genusOf("  Larus  argentatus smithsonianus ")).toBe("Larus");
  });
  it("gives null for mononyms, malformed and missing names", () => {
    expect(genusOf("Aves")).toBeNull();
    expect(genusOf("ardenna grisea")).toBeNull();
    expect(genusOf("ARDENNA grisea")).toBeNull();
    expect(genusOf("Ardenna-x grisea")).toBeNull();
    expect(genusOf("")).toBeNull();
    expect(genusOf(null)).toBeNull();
  });
});

describe("checkTaxonRules", () => {
  it("no taxon rules: nothing to refuse", () => {
    expect(checkTaxonRules(rs([]), TAXONOMY).problems).toEqual([]);
  });

  it("ANDed requirements that no species meets are refused (the Haiku draft)", () => {
    const r = checkTaxonRules(
      rs([
        rule("t1", "family", "require_one_of", ["Alcidae"]),
        rule("t2", "order", "require_one_of", ["Procellariiformes"]),
      ]),
      TAXONOMY,
    );
    expect(r.admitted).toBe(0);
    expect(r.problems.join()).toMatch(/admit no species/);
  });

  it("alternatives in one rule are fine; forbids subtract; unknown ranks never count", () => {
    const r = checkTaxonRules(
      rs([
        rule("t1", "order", "require_one_of", [
          "Procellariiformes",
          "Charadriiformes",
        ]),
        rule("t2", "family", "forbid", ["Scolopacidae"]),
      ]),
      TAXONOMY,
    );
    expect(r).toMatchObject({ admitted: 3, problems: [] });
  });

  it("names that match no order, family or genus are refused", () => {
    const r = checkTaxonRules(
      rs([
        rule("t1", "family", "forbid", ["Turdidae", "Phalaropidae"]),
        rule("t2", "order", "forbid", ["Passeriforms"]),
        rule("t3", "genus", "assign", ["Ardena"]),
      ]),
      TAXONOMY,
    );
    expect(r.problems.slice(0, 3)).toEqual([
      "taxon rule t1 names no known family: Phalaropidae",
      "taxon rule t2 names no known order: Passeriforms",
      "taxon rule t3 names no known genus: Ardena",
    ]);
  });

  it("a real family outside the tag universe is not an unknown name (Mohoidae)", () => {
    expect(
      checkTaxonRules(
        rs([rule("t1", "family", "forbid", ["Turdidae", "Mohoidae"])]),
        TAXONOMY,
      ).problems,
    ).toEqual([]);
  });

  it("support scopes are checked against the taxonomy too", () => {
    const r = checkTaxonRules(
      rs(
        [],
        [
          {
            id: "s1",
            group: "g",
            match: { type: "literal", phrase: "at sea" },
            note: "",
            taxa: [
              { rank: "family", values: ["Laridae"] },
              { rank: "genus", values: ["Phalaropus"] },
            ],
          },
        ],
      ),
      TAXONOMY,
    );
    expect(r.problems).toEqual([
      "support rule s1 is scoped to no known family: Laridae",
    ]);
  });

  it("an assign overlapping a forbid or an unmet require is refused, with bounded diagnostics", () => {
    const r = checkTaxonRules(
      rs([
        rule("a_alc", "family", "assign", ["Alcidae"]),
        rule("a_pha", "genus", "assign", ["Phalaropus"]),
        rule("f_sco", "family", "forbid", ["Scolopacidae"]),
        rule("r_ord", "order", "require_one_of", ["Procellariiformes", "Charadriiformes"]),
      ]),
      TAXONOMY,
    );
    expect(r.overlap).toEqual({
      count: 1,
      examples: ["redpha (a_pha vs f_sco)"],
    });
    expect(r.problems.join()).toMatch(/1 species are matched by an assign rule/);
  });

  it("overlap diagnostics keep the true count but only the first 20, in code order", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      sp(`x${String(i).padStart(2, "0")}`, "Charadriiformes", "Scolopacidae", "Calidris"),
    );
    const r = checkTaxonRules(
      rs([
        rule("a", "genus", "assign", ["Calidris"]),
        rule("f", "family", "forbid", ["Scolopacidae"]),
      ]),
      [...TAXONOMY, ...many],
    );
    expect(r.overlap.count).toBe(31); // dunlin + 30
    expect(r.overlap.examples).toHaveLength(OVERLAP_EXAMPLES);
    expect(r.overlap.examples[0]).toBe("dunlin (a vs f)");
    expect(r.overlap.examples[1]).toBe("x00 (a vs f)");
  });

  it("an assign-only rule set with no gates is not 'admitting no species'", () => {
    expect(
      checkTaxonRules(
        rs([rule("a", "family", "assign", ["Procellariidae"])]),
        TAXONOMY,
      ).problems,
    ).toEqual([]);
  });

  it("known taxa come from the whole taxonomy", () => {
    const k = knownTaxaOf(TAXONOMY);
    expect(k.family.has("Mohoidae")).toBe(true);
    expect(k.genus.has("Ardenna")).toBe(true);
    expect(k.order.has("null")).toBe(false);
  });
});
