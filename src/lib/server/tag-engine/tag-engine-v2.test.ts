/**
 * td-894144 B5 — schema-2 rules in the pure engine (plan
 * docs/2026-09-30-open-ocean-rules-v2-plan.md §3a truth table, §3b/§3l scope
 * algebra, §3e bounded evidence, §3r example hits). No DB, no AI.
 *
 * Schema-1 byte identity is covered by tag-engine.test.ts plus a one-off
 * full-corpus comparison (32,658 evaluations, 0 differences) recorded in the
 * B5 devlog.
 */
import { describe, expect, it } from "vitest";
import { ALL_TAGS } from "$lib/species-tags";
import { parseRuleset, RulesetError, type Ruleset } from "./rules";
import {
  buildLexicon,
  collectAcceptedHits,
  evaluateTag,
  firstAcceptedHit,
  MAX_MATCHED_RULES,
  type TaxonInput,
} from "./scanner";

const TAG = "habitat:open-ocean";
const base = {
  schema: 2,
  tag: TAG,
  rev: "v2-fixture",
  denySections: ["taxonomy"],
  comparisonMarkers: ["unlike"],
  exclude: [] as unknown[],
};
const parse = (raw: Record<string, unknown>) =>
  parseRuleset({ ...base, support: [], taxon: [], ...raw }, ALL_TAGS);

const LEX = buildLexicon(["gulls", "Wilson's Storm-Petrel"]);
const art = (text: string) => ({ extract: text, sections: [] });
const PETREL: TaxonInput = {
  order: "Procellariiformes",
  family: "Procellariidae",
  genus: "Ardenna",
};
const TERN: TaxonInput = {
  order: "Charadriiformes",
  family: "Laridae",
  genus: "Sterna",
};
const DUCK: TaxonInput = {
  order: "Anseriformes",
  family: "Anatidae",
  genus: "Melanitta",
};
const FALCON: TaxonInput = {
  order: "Falconiformes",
  family: "Falconidae",
  genus: "Falco",
};
const run = (rs: Ruleset, taxon: TaxonInput, text = "It nests on cliffs.") =>
  evaluateTag({ article: art(text), taxon, lexicon: LEX, exempt: [] }, rs);

const AT_SEA = {
  id: "s_at_sea",
  group: "sea",
  match: { type: "literal", phrase: "at sea" },
  note: "rests at sea",
};

describe("schema-2 loader", () => {
  it("accepts assign, genus and scoped support; schema 1 still refuses them", () => {
    const raw = {
      taxon: [
        {
          id: "a_proc",
          rank: "family",
          action: "assign",
          values: ["Procellariidae"],
          note: "petrels and shearwaters",
        },
        {
          id: "a_mel",
          rank: "genus",
          action: "assign",
          values: ["Melanitta"],
          note: "scoters",
        },
      ],
      support: [
        { ...AT_SEA, taxa: [{ rank: "family", values: ["Laridae"] }] },
      ],
    };
    expect(parse(raw).schema).toBe(2);
    expect(() =>
      parseRuleset({ ...base, ...raw, schema: 1 }, ALL_TAGS),
    ).toThrow(RulesetError);
  });

  it("allows an assign-only rule set (no phrases) in schema 2 only", () => {
    const taxon = [
      {
        id: "a",
        rank: "family",
        action: "assign",
        values: ["Procellariidae"],
        note: "n",
      },
    ];
    expect(parse({ taxon }).support).toEqual([]);
    expect(() => parse({ taxon: [] })).toThrow(/support or assign/);
  });

  it("refuses duplicate scope ranks, empty values, duplicate values and > 3 entries", () => {
    const scoped = (taxa: unknown) => parse({ support: [{ ...AT_SEA, taxa }] });
    expect(() =>
      scoped([
        { rank: "family", values: ["Laridae"] },
        { rank: "family", values: ["Alcidae"] },
      ]),
    ).toThrow(/duplicate rank/);
    expect(() => scoped([{ rank: "family", values: [] }])).toThrow(/no values/);
    expect(() =>
      scoped([{ rank: "family", values: ["Laridae", "Laridae"] }]),
    ).toThrow(/duplicate value/);
    expect(() =>
      scoped([
        { rank: "order", values: ["A"] },
        { rank: "family", values: ["B"] },
        { rank: "genus", values: ["C"] },
        { rank: "genus", values: ["D"] },
      ]),
    ).toThrow(/1–3 scope entries/);
    expect(() => scoped([])).toThrow(/1–3 scope entries/);
    expect(() => scoped([{ rank: "species", values: ["x"] }])).toThrow(
      /rank must be/,
    );
  });
});

describe("schema-2 truth table (plan §3a)", () => {
  const RS = parse({
    taxon: [
      {
        id: "f_land",
        rank: "order",
        action: "forbid",
        values: ["Falconiformes"],
        note: "n",
      },
      {
        id: "a_proc",
        rank: "family",
        action: "assign",
        values: ["Procellariidae"],
        note: "n",
      },
      {
        id: "a_mel",
        rank: "genus",
        action: "assign",
        values: ["Melanitta"],
        note: "n",
      },
    ],
    support: [{ ...AT_SEA, taxa: [{ rank: "family", values: ["Laridae"] }] }],
  });

  it("1. a known forbid wins before anything else", () => {
    expect(run(RS, FALCON, "It feeds at sea.")).toMatchObject({
      status: "not_assigned",
      reason: "taxon_forbid:f_land",
      evidence: [],
    });
  });

  it("2. an unknown forbid/require rank is unevaluated", () => {
    expect(
      run(RS, { order: null, family: "Procellariidae", genus: "Ardenna" }),
    ).toMatchObject({ status: "unevaluated", reason: "taxon_unknown" });
  });

  it("3. assign: one taxon evidence item, no text needed", () => {
    const r = run(RS, PETREL);
    expect(r).toMatchObject({ status: "assigned", reason: null });
    expect(r.evidence).toEqual([
      {
        kind: "taxon",
        matchedCount: 1,
        matchedRules: [
          { ruleId: "a_proc", rank: "family", value: "Procellariidae" },
        ],
      },
    ]);
    expect(run(RS, DUCK).evidence).toEqual([
      {
        kind: "taxon",
        matchedCount: 1,
        matchedRules: [{ ruleId: "a_mel", rank: "genus", value: "Melanitta" }],
      },
    ]);
  });

  it("4. phrases: a scoped rule counts only in its scope, with the scope on the evidence", () => {
    const r = run(RS, TERN, "Outside the breeding season it rests at sea.");
    expect(r.status).toBe("assigned");
    expect(r.evidence).toEqual([
      expect.objectContaining({
        ruleId: "s_at_sea",
        scopes: [{ rank: "family", value: "Laridae" }],
      }),
    ]);
    expect(
      run(
        RS,
        { order: "Charadriiformes", family: "Alcidae", genus: "Uria" },
        "It rests at sea.",
      ),
    ).toMatchObject({ status: "not_assigned", reason: "no_support" });
  });

  it("5. no surviving support + an unknown assign rank → unevaluated; else not_assigned", () => {
    expect(
      run(RS, { order: "Charadriiformes", family: "Laridae", genus: null }),
    ).toMatchObject({ status: "unevaluated", reason: "taxon_unknown" });
    expect(run(RS, TERN)).toMatchObject({
      status: "not_assigned",
      reason: "no_support",
    });
  });

  it("5. a scoped phrase that would have matched but whose scope rank is unknown → unevaluated", () => {
    const rs = parse({
      support: [{ ...AT_SEA, taxa: [{ rank: "genus", values: ["Sterna"] }] }],
    });
    const noGenus = { ...TERN, genus: null };
    expect(run(rs, noGenus, "It rests at sea.")).toMatchObject({
      status: "unevaluated",
      reason: "taxon_unknown",
    });
    // ...but with no such phrase in the text, it is simply not assigned.
    expect(run(rs, noGenus, "It nests on cliffs.")).toMatchObject({
      status: "not_assigned",
      reason: "no_support",
    });
  });

  it("gives the same result for every order of the taxon and support rules", () => {
    const perms = <T>(xs: T[]): T[][] =>
      xs.length <= 1
        ? [xs]
        : xs.flatMap((x, i) =>
            perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
          );
    const inputs = [
      [PETREL, ""],
      [DUCK, ""],
      [FALCON, "It feeds at sea."],
      [TERN, "It rests at sea."],
      [{ ...TERN, genus: null }, "It rests at sea."],
      [{ order: null, family: null, genus: null }, "It rests at sea."],
    ] as const;
    const baseline = inputs.map(([t, x]) => run(RS, t, x || undefined));
    for (const taxon of perms(RS.taxon))
      inputs.forEach(([t, x], i) =>
        expect(run({ ...RS, taxon }, t, x || undefined)).toEqual(baseline[i]),
      );
  });

  it("orders matched rules by rank then id and caps them at 5, keeping the true count", () => {
    const taxon = [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `z_fam_${i}`,
        rank: "family",
        action: "assign",
        values: ["Procellariidae"],
        note: "n",
      })),
      {
        id: "a_order",
        rank: "order",
        action: "assign",
        values: ["Procellariiformes"],
        note: "n",
      },
      {
        id: "b_genus",
        rank: "genus",
        action: "assign",
        values: ["Ardenna"],
        note: "n",
      },
    ];
    const r = run(parse({ taxon }), PETREL);
    const ev = r.evidence[0] as { matchedCount: number; matchedRules: { ruleId: string }[] };
    expect(r.evidence).toHaveLength(1);
    expect(ev.matchedCount).toBe(8);
    expect(ev.matchedRules).toHaveLength(MAX_MATCHED_RULES);
    expect(ev.matchedRules.map((m) => m.ruleId)).toEqual([
      "a_order",
      "z_fam_0",
      "z_fam_1",
      "z_fam_2",
      "z_fam_3",
    ]);
  });
});

describe("scope algebra (plan §3l)", () => {
  const scoped = (taxa: unknown) =>
    parse({ support: [{ ...AT_SEA, taxa }] });
  const text = "It rests at sea.";

  it("entries AND, values within an entry OR", () => {
    const rs = scoped([
      { rank: "order", values: ["Charadriiformes", "Anseriformes"] },
      { rank: "family", values: ["Laridae"] },
    ]);
    expect(run(rs, TERN, text).status).toBe("assigned");
    expect(run(rs, DUCK, text).status).toBe("not_assigned");
    const ev = run(rs, TERN, text).evidence[0] as { scopes: unknown };
    expect(ev.scopes).toEqual([
      { rank: "order", value: "Charadriiformes" },
      { rank: "family", value: "Laridae" },
    ]);
  });

  it("a known failing entry makes the rule ineligible even when another rank is unknown", () => {
    const rs = scoped([
      { rank: "family", values: ["Laridae"] },
      { rank: "genus", values: ["Sterna"] },
    ]);
    expect(
      run(rs, { order: "Anseriformes", family: "Anatidae", genus: null }, text),
    ).toMatchObject({ status: "not_assigned", reason: "no_support" });
  });

  it("scoped phrases still go through excludes, comparisons and other-taxon checks", () => {
    const rs = parseRuleset(
      {
        ...base,
        taxon: [],
        support: [
          {
            id: "s_pel",
            group: "pel",
            match: { type: "literal", phrase: "pelagic" },
            note: "n",
            taxa: [{ rank: "family", values: ["Laridae"] }],
          },
          { ...AT_SEA, taxa: [{ rank: "family", values: ["Laridae"] }] },
        ],
        exclude: [
          {
            id: "x_fish",
            binds: ["pel"],
            match: { type: "literal", phrase: "fishes" },
            scope: { unit: "window", before: 0, after: 2 },
            note: "prey",
          },
          {
            id: "x_avoid",
            binds: ["*"],
            match: { type: "literal", phrase: "avoids" },
            scope: { unit: "clause" },
            note: "avoidance",
          },
        ],
      },
      ALL_TAGS,
    );
    expect(run(rs, TERN, "Its diet is pelagic schooling fishes.")).toMatchObject(
      { status: "not_assigned", reason: "excluded:x_fish" },
    );
    expect(run(rs, TERN, "It avoids resting at sea.")).toMatchObject({
      status: "not_assigned",
    });
    expect(run(rs, TERN, "Unlike this bird, gulls rest at sea.")).toMatchObject({
      status: "not_assigned",
      reason: "no_focal_support",
    });
  });
});

describe("collectAcceptedHits / firstAcceptedHit (plan §3r)", () => {
  it("picks the earliest text, even when a later-listed rule matched it", () => {
    const rs = parseRuleset(
      {
        ...base,
        taxon: [],
        support: [
          {
            id: "a_first_listed",
            group: "g1",
            match: { type: "literal", phrase: "open ocean" },
            note: "n",
          },
          {
            id: "b_second_listed",
            group: "g2",
            match: { type: "literal", phrase: "at sea" },
            note: "n",
          },
        ],
      },
      ALL_TAGS,
    );
    const text = "It rests at sea and forages over the open ocean.";
    const input = { article: art(text), taxon: PETREL, lexicon: LEX, exempt: [] };
    const hits = collectAcceptedHits(input, rs);
    expect(hits.map((h) => h.ruleId)).toEqual([
      "a_first_listed",
      "b_second_listed",
    ]);
    expect(firstAcceptedHit(hits)?.ruleId).toBe("b_second_listed");
    // evaluateTag's own evidence keeps the scanner's rule order (unchanged).
    expect(
      evaluateTag(input, rs).evidence.map((e) => (e as { ruleId: string }).ruleId),
    ).toEqual(["a_first_listed", "b_second_listed"]);
  });

  it("collects only eligible scoped rules, uncapped", () => {
    const rs = parse({
      support: [{ ...AT_SEA, taxa: [{ rank: "family", values: ["Laridae"] }] }],
    });
    const many = Array.from({ length: 5 }, () => "It rests at sea.").join(" ");
    expect(
      collectAcceptedHits(
        { article: art(many), taxon: TERN, lexicon: LEX, exempt: [] },
        rs,
      ),
    ).toHaveLength(5);
    expect(
      collectAcceptedHits(
        { article: art(many), taxon: DUCK, lexicon: LEX, exempt: [] },
        rs,
      ),
    ).toEqual([]);
    expect(firstAcceptedHit([])).toBeNull();
  });
});
