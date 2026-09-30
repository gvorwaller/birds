/**
 * td-894144 Release B, milestone B1 — the pure tag engine. No DB, no AI.
 *
 * The ruleset below is a TEST FIXTURE only, written to exercise every
 * construct. The real open-ocean ruleset is proposed by AI, cross-checked,
 * approved by the owner and blind-tested (B4) — it never lives in code.
 */
import { describe, expect, it } from "vitest";
import { ALL_TAGS } from "$lib/species-tags";
import { foldCase, normalizeDisplay } from "./normalize";
import { compilePhrase, findPhrase, inflections, tokenize } from "./tokens";
import { segmentArticle, scannerRev } from "./segment";
import { parseRuleset, RulesetError } from "./rules";
import {
  buildLexicon,
  evaluateTag,
  type TagResult,
  type TaxonInput,
  type TextEvidence,
} from "./scanner";

const FIXTURE = {
  schema: 1,
  tag: "habitat:open-ocean",
  rev: "test-fixture",
  denySections: [
    "taxonom",
    "systematic",
    "etymolog",
    "similar",
    "culture",
    "subspecies",
    "name",
  ],
  comparisonMarkers: [
    "unlike",
    "as in",
    "like the",
    "like other",
    "similar to",
    "compared with",
  ],
  support: [
    {
      id: "s-pelagic",
      group: "pelagic",
      match: { type: "literal", phrase: "pelagic" },
      note: "lives at sea",
    },
    {
      id: "s-at-sea",
      group: "at-sea",
      match: { type: "literal", phrase: "at sea" },
      note: "feeds or rests at sea",
    },
    {
      id: "s-open-ocean",
      group: "open-ocean",
      match: { type: "stem", phrase: "open ocean" },
      note: "open ocean",
    },
    {
      id: "s-offshore",
      group: "offshore",
      match: { type: "literal", phrase: "far offshore" },
      note: "well away from land",
    },
  ],
  exclude: [
    {
      id: "x-migration",
      binds: ["*"],
      match: { type: "literal", phrase: "migration" },
      scope: { unit: "clause" },
      note: "transit is not habitat",
    },
    {
      id: "x-crosses",
      binds: ["*"],
      match: { type: "stem", phrase: "cross" },
      scope: { unit: "clause" },
      note: "transit",
    },
    {
      id: "x-vagrant",
      binds: ["*"],
      match: { type: "stem", phrase: "vagrant" },
      scope: { unit: "sentence" },
      note: "accidental records",
    },
    {
      id: "x-rarely",
      binds: ["*"],
      match: { type: "literal", phrase: "rarely" },
      scope: { unit: "window", before: 4, after: 0 },
      note: "rarity",
    },
    {
      id: "x-never",
      binds: ["*"],
      match: { type: "literal", phrase: "never" },
      scope: { unit: "window", before: 4, after: 0 },
      note: "negation",
    },
    {
      id: "x-not",
      binds: ["*"],
      match: { type: "literal", phrase: "not" },
      scope: { unit: "window", before: 3, after: 0 },
      note: "negation",
    },
    {
      id: "x-formerly",
      binds: ["*"],
      match: { type: "literal", phrase: "formerly" },
      scope: { unit: "clause" },
      note: "historical",
    },
    {
      id: "x-may",
      binds: ["*"],
      match: { type: "literal", phrase: "may" },
      scope: { unit: "window", before: 4, after: 0 },
      note: "hypothetical",
    },
  ],
  taxon: [
    {
      id: "t-marine",
      rank: "order",
      values: [
        "Procellariiformes",
        "Sphenisciformes",
        "Suliformes",
        "Phaethontiformes",
        "Gaviiformes",
        "Charadriiformes",
        "Anseriformes",
      ],
      action: "require_one_of",
      note: "necessary condition only",
    },
  ],
};

const RS = parseRuleset(FIXTURE, ALL_TAGS);
const PETREL: TaxonInput = {
  order: "Procellariiformes",
  family: "Hydrobatidae",
  genus: "Hydrobates",
};
const FALCON: TaxonInput = {
  order: "Falconiformes",
  family: "Falconidae",
  genus: "Falco",
};
const LEX = buildLexicon([
  "Northern Gannet",
  "gannets",
  "Great Skua",
  "skuas",
  "Wilson's Storm-Petrel",
  "storm petrels",
  "Oceanites",
  "shearwaters",
]);
const OWN = ["Wilson's Storm-Petrel", "storm petrels", "Oceanites"]; // the focal species' own names
const art = (
  extract: string,
  sections: { title: string; text: string }[] = [],
) => ({ extract, sections });
/** Schema-1 runs only ever produce text evidence. */
const run = (
  text: string,
  taxon = PETREL,
  sections: { title: string; text: string }[] = [],
) =>
  evaluateTag(
    { article: art(text, sections), taxon, lexicon: LEX, exempt: OWN },
    RS,
  ) as TagResult & { evidence: TextEvidence[] };

describe("normalize", () => {
  it("unifies dashes, quotes and spaces; keeps hyphenated words and offsets", () => {
    expect(normalizeDisplay("sea‐going  birds – at sea ‘often’")).toBe(
      "sea-going birds — at sea 'often'",
    );
    const d = normalizeDisplay("The İstanbul Petrel");
    expect(foldCase(d)).toHaveLength(d.length);
  });
});

describe("tokens", () => {
  it("keeps hyphens/apostrophes inside words and records offsets", () => {
    expect(
      tokenize("wilson's sea-going bird").map((t) => [t.text, t.start]),
    ).toEqual([
      ["wilson's", 0],
      ["sea-going", 9],
      ["bird", 19],
    ]);
  });
  it("stem matching covers regular inflections only", () => {
    expect([...inflections("dive")]).toEqual(
      expect.arrayContaining(["dives", "diving", "dived"]),
    );
    expect(inflections("ocean").has("oceans")).toBe(true);
    expect(inflections("fly").has("flies")).toBe(true);
    expect(inflections("stop").has("stopping")).toBe(true);
    expect(inflections("sea").has("seas")).toBe(true);
    const toks = tokenize("crossing the open oceans");
    expect(findPhrase(toks, compilePhrase("open ocean", "stem"))).toEqual([2]);
    expect(findPhrase(toks, compilePhrase("open ocean", "literal"))).toEqual(
      [],
    );
  });
  it("normalizes rule punctuation the same way as article text", () => {
    const tokens = tokenize(
      foldCase(normalizeDisplay("Wilson’s sea‐going bird")),
    );
    expect(
      findPhrase(tokens, compilePhrase("wilson's sea-going", "literal")),
    ).toEqual([0]);
  });
});

describe("segment", () => {
  it("splits sentences and clauses and denies taxonomy-type sections (deny wins)", () => {
    const s = segmentArticle(
      art("It feeds at sea; it nests on islands. Dr. Smith described it.", [
        {
          title: "Description and taxonomy",
          text: "Unlike gannets it feeds at sea.",
        },
        { title: "Distribution and habitat", text: "It is pelagic." },
      ]),
    );
    expect(s.sections.map((x) => [x.title, x.allowed])).toEqual([
      ["", true],
      ["Description and taxonomy", false],
      ["Distribution and habitat", true],
    ]);
    const lead = s.sections[0];
    expect(lead.sentences.length).toBe(2); // "Dr." does not split
    expect(lead.sentences[0].clauses.length).toBe(2); // split at ';'
    expect(s.textHash).toMatch(/^[0-9a-f]{64}$/);
    expect(scannerRev()).toMatch(/^engine-1\+[0-9a-f]{12}\|node-.*\|icu-.*\|unicode-/);
  });
  it("text hash is stable for identical text and changes with it", () => {
    const a = segmentArticle(art("It is pelagic.")).textHash;
    expect(segmentArticle(art("It  is  pelagic.")).textHash).toBe(a); // same normalized text
    expect(segmentArticle(art("It is coastal.")).textHash).not.toBe(a);
  });
  it("does not merge a true sentence boundary after an ambiguous abbreviation", () => {
    const s = segmentArticle(art("It is a vagrant, etc. It is pelagic."));
    expect(
      s.sections[0].sentences.map((x) =>
        s.sections[0].display.slice(x.start, x.end),
      ),
    ).toEqual(["It is a vagrant, etc.", "It is pelagic."]);
  });
});

describe("ruleset loader rejects anything malformed", () => {
  const bad = (patch: (r: Record<string, unknown>) => void) => {
    const r = structuredClone(FIXTURE) as Record<string, unknown>;
    patch(r);
    return () => parseRuleset(r, ALL_TAGS);
  };
  it("unknown fields, duplicate ids, unknown tag, bad matcher, oversize phrase, dangling binds", () => {
    expect(bad((r) => (r.extra = 1))).toThrow(RulesetError);
    expect(
      bad((r) => ((r.support as { id: string }[])[1].id = "s-pelagic")),
    ).toThrow(/duplicate id/);
    for (const id of ["taxon marine", "taxon:marine"])
      expect(
        bad((r) => ((r.taxon as { id: string }[])[0].id = id)),
      ).toThrow(/bad rule id/);
    expect(bad((r) => (r.tag = "habitat:moon"))).toThrow(/unknown tag/);
    expect(
      bad(
        (r) =>
          ((r.support as { match: { type: string } }[])[0].match.type =
            "regex"),
      ),
    ).toThrow(/literal or stem/);
    expect(
      bad(
        (r) =>
          ((r.support as { match: { phrase: string } }[])[0].match.phrase =
            "a b c d e f g"),
      ),
    ).toThrow(/longer than/);
    expect(
      bad((r) => ((r.exclude as { binds: string[] }[])[0].binds = ["nope"])),
    ).toThrow(/unknown group/);
    expect(
      bad((r) => ((r.exclude as { binds: string[] }[])[0].binds = [])),
    ).toThrow(/binds no support/);
    expect(
      bad(
        (r) =>
          ((r.support as { match: { phrase: string } }[])[0].match.phrase =
            "---"),
      ),
    ).toThrow(/no tokens/);
    expect(bad((r) => (r.comparisonMarkers = ["..."]))).toThrow(/no tokens/);
    expect(
      bad(
        (r) =>
          ((r.exclude as { scope: unknown }[])[3].scope = {
            unit: "window",
            before: 99,
            after: 0,
          }),
      ),
    ).toThrow(/window/);
    expect(bad((r) => (r.support = []))).toThrow(/at least one/);
  });
  it("rejects an oversized ruleset before it can execute", () => {
    const raw = structuredClone(FIXTURE) as Record<string, unknown>;
    raw.taxon = Array.from({ length: 16 }, (_, i) => ({
      id: `taxon-${i}`,
      rank: "family",
      values: Array.from(
        { length: 200 },
        (_, j) => `${i}-${j}-${"x".repeat(190)}`,
      ),
      action: "forbid",
      note: "bounded input",
    }));
    expect(() => parseRuleset(raw, ALL_TAGS)).toThrow(/larger than/);
  });
});

describe("scanner: decision order and named cases", () => {
  it("a petrel that feeds far out at sea is assigned, with quotable evidence", () => {
    const r = run(
      "Wilson's storm petrel spends most of its life at sea, feeding over the open ocean.",
    );
    expect(r.status).toBe("assigned");
    expect(r.evidence[0].sentence).toContain("at sea");
    const lead = segmentArticle(
      art(
        "Wilson's storm petrel spends most of its life at sea, feeding over the open ocean.",
      ),
    ).sections[0];
    expect(
      lead.display.slice(r.evidence[0].matchStart, r.evidence[0].matchEnd),
    ).toBe("at sea");
  });
  it("keeps UTF-16 evidence offsets exact after astral and decomposed characters", () => {
    const text = "🐦 Pe\u0301trel — it is pelagic.";
    const r = run(text);
    const lead = segmentArticle(art(text)).sections[0];
    expect(r.status).toBe("assigned");
    expect(
      lead.display.slice(r.evidence[0].matchStart, r.evidence[0].matchEnd),
    ).toBe("pelagic");
    expect(r.evidence[0].matchStart).toBe(lead.display.indexOf("pelagic"));
  });
  it("American Kestrel: land-bird order fails the requirement before any text is read", () => {
    const r = run(
      "It hunts over open country and sometimes at sea on migration.",
      FALCON,
    );
    expect(r).toMatchObject({
      status: "not_assigned",
      reason: "requires_unmet:t-marine",
    });
  });
  it("unknown order is unevaluated(taxon_unknown), never a covered zero", () => {
    expect(run("It is pelagic.", { order: null, family: null, genus: null })).toMatchObject({
      status: "unevaluated",
      reason: "taxon_unknown",
    });
  });
  it("makes taxon decisions order-independent and never assigns through an unknown forbid", () => {
    const raw = structuredClone(FIXTURE);
    raw.taxon = [
      {
        id: "t-family",
        rank: "family" as const,
        values: ["Hydrobatidae"],
        action: "require_one_of" as const,
        note: "family gate",
      },
      ...raw.taxon,
    ];
    const familyFirst = parseRuleset(raw, ALL_TAGS);
    const orderFirst = parseRuleset(
      { ...raw, taxon: [...raw.taxon].reverse() },
      ALL_TAGS,
    );
    const input = {
      article: art("It is pelagic."),
      taxon: { order: "Falconiformes", family: null, genus: null },
      lexicon: LEX,
    };
    expect(evaluateTag(input, familyFirst)).toMatchObject({
      status: "not_assigned",
      reason: "requires_unmet:t-marine",
    });
    expect(evaluateTag(input, orderFirst)).toMatchObject({
      status: "not_assigned",
      reason: "requires_unmet:t-marine",
    });

    const forbidUnknown = parseRuleset(
      {
        ...FIXTURE,
        taxon: [
          {
            id: "t-forbid-family",
            rank: "family",
            values: ["Falconidae"],
            action: "forbid",
            note: "family exclusion",
          },
        ],
      },
      ALL_TAGS,
    );
    expect(evaluateTag(input, forbidUnknown)).toMatchObject({
      status: "unevaluated",
      reason: "taxon_unknown",
    });
  });
  it("no article is unevaluated(no_article)", () => {
    expect(
      evaluateTag({ article: null, taxon: PETREL, lexicon: LEX }, RS),
    ).toMatchObject({
      status: "unevaluated",
      reason: "no_article",
      textHash: null,
    });
  });
  it("a marine-order bird with no supporting text is not assigned (no_support)", () => {
    expect(
      run("It breeds on sandy beaches and feeds in estuaries."),
    ).toMatchObject({
      status: "not_assigned",
      reason: "no_support",
    });
  });
});

describe("scanner: adversarial fixtures", () => {
  const cases: [string, string, "assigned" | "not_assigned"][] = [
    [
      "migration transit",
      "It crosses the open ocean on migration.",
      "not_assigned",
    ],
    [
      "transit verb",
      "Flocks cross the open ocean each autumn.",
      "not_assigned",
    ],
    [
      "vagrancy",
      "Vagrants have been recorded at sea off Chile.",
      "not_assigned",
    ],
    ["rarity", "It is rarely seen at sea.", "not_assigned"],
    ["negation", "It is never found far offshore.", "not_assigned"],
    ['negation "not"', "It is not pelagic.", "not_assigned"],
    ["historical", "It was formerly common at sea.", "not_assigned"],
    ["hypothetical", "It may forage at sea in winter.", "not_assigned"],
    ["comparison marker", "Unlike the gannets, it is pelagic.", "not_assigned"],
    [
      '"like other" marker',
      "Like other shearwaters it feeds at sea.",
      "not_assigned",
    ],
    [
      "other taxon before match",
      "Great Skuas chase it and feed at sea.",
      "not_assigned",
    ],
    [
      "clause boundary keeps the good half",
      "It nests inland, but it feeds far offshore.",
      "assigned",
    ],
    [
      "exclusion in the OTHER clause does not cancel",
      "It is pelagic; vagrant inland birds are recorded rarely.",
      "not_assigned",
    ],
    [
      'own group name is not "another taxon"',
      "Storm petrels feed at sea.",
      "assigned",
    ],
    [
      'own genus is not "another taxon"',
      "Oceanites species feed at sea.",
      "assigned",
    ],
    [
      "parenthesis splits clauses",
      "It is coastal (seabirds nearby are pelagic) in summer.",
      "assigned",
    ],
    [
      "abbreviation does not split",
      "Found by Dr. Smith at sea in 1840.",
      "assigned",
    ],
    ["decimal does not split", "It feeds 2.5 km out at sea.", "assigned"],
    [
      "unicode punctuation",
      "It feeds at sea — far from land — all winter.",
      "assigned",
    ],
    [
      "quoted claim",
      'Sailors called it "the bird that lives at sea".',
      "assigned",
    ],
  ];
  for (const [name, text, want] of cases) {
    it(name, () => {
      expect(run(text).status, `${name}: ${text}`).toBe(want);
    });
  }

  it('the "vagrant" sentence-scope exclusion cancels support anywhere in its sentence', () => {
    const r = run("It is pelagic, though a vagrant was once found inland.");
    expect(r.status).toBe("not_assigned");
    expect(r.reason).toBe("excluded:x-vagrant");
  });

  it("clause and token-window exclusions do not cross a clause boundary", () => {
    expect(run("It is pelagic; flocks cross the land.").status).toBe(
      "assigned",
    );
    expect(run("It may rest; it is pelagic.").status).toBe("assigned");
    expect(run("It may be pelagic.").status).toBe("not_assigned");
  });

  it("a denied SUB-heading inside an allowed section is not read, and markers are not text", () => {
    const r = run("It nests on cliffs.", PETREL, [
      {
        title: "Description",
        text: "A dark bird.\n=== Taxonomy ===\nIts relatives are pelagic.",
      },
    ]);
    expect(r.status).toBe("not_assigned");
    const seg = segmentArticle(
      art("x", [
        {
          title: "Behaviour",
          text: "Walks.\n=== Feeding ===\nIt feeds at sea.",
        },
      ]),
    );
    expect(seg.sections.map((s) => s.title)).toEqual([
      "",
      "Behaviour",
      "Behaviour / Feeding",
    ]);
    expect(seg.sections.some((s) => s.display.includes("==="))).toBe(false);
  });

  it("reports evidence offsets relative to the matching subsection", () => {
    const sections = [
      {
        title: "Behaviour",
        text: "Walks on land.\n=== Feeding ===\n🐟 It feeds at sea.",
      },
    ];
    const r = run("It nests on cliffs.", PETREL, sections);
    const seg = segmentArticle(art("It nests on cliffs.", sections));
    const feeding = seg.sections.find(
      (s) => s.title === "Behaviour / Feeding",
    )!;
    expect(r.evidence[0].section).toBe("Behaviour / Feeding");
    expect(
      feeding.display.slice(r.evidence[0].matchStart, r.evidence[0].matchEnd),
    ).toBe("at sea");
  });

  it("denied sections are never read, even when they contain support", () => {
    const r = run("It nests on cliffs.", PETREL, [
      { title: "Taxonomy", text: "Its relatives are pelagic." },
    ]);
    expect(r.status).toBe("not_assigned");
  });

  it("is deterministic", () => {
    const t = "Wilson's storm petrel is pelagic; it feeds at sea.";
    expect(run(t)).toEqual(run(t));
  });

  it("builds deterministic longest-first taxon candidates", () => {
    const a = buildLexicon(["Great Skua", "Great Skua complex"]);
    const b = buildLexicon(["Great Skua complex", "Great Skua"]);
    expect(a.byFirst.get("great")).toEqual(b.byFirst.get("great"));
    expect(a.byFirst.get("great")?.map((x) => x.join(" "))).toEqual([
      "great skua complex",
      "great skua",
    ]);
  });
});
