/**
 * Frozen evaluation design artifacts per tag (td-894144 Release B4, plan rev
 * 23 §B4a/B4d/B4h/B4i). These shape sampling and the evaluator text, so each
 * set of them is fingerprinted (SHA-256 of canonical JSON) and the hash is
 * recorded on drafts, simulation reports and eval sets. Changing any value
 * changes the hash and invalidates every frame built with the old one.
 */
import { createHash } from "node:crypto";

export interface TagEvalDesign {
  /** The one blind-labelling question (fixed per tag; part of the design hash). */
  question: string;
  /** Sampling proxy only (not a biological truth set): splits the legacy-only stratum. */
  marineOrders: readonly string[];
  /** Whole-word, case-folded; used for authoring cue sentences and the fixed reading aid. */
  cueWords: readonly string[];
  /** Expected rules results checked before readiness. must-not cases gate; must-have are reported. */
  namedCases: readonly {
    code: string;
    name: string;
    expect: "no" | "yes";
    gating: boolean;
  }[];
}

/** Sections dropped from the evaluator text for EVERY tag and revision (revision-independent). */
/**
 * Bump when masking, section filtering, cue rendering or the family reference
 * rendering changes (single source; eval-text imports it). v2 (td-894144 B5):
 * each page also shows the lead of the species' family's Wikipedia article.
 */
export const EVAL_TEXT_VERSION = "evaltext-v2";

/** How the family reference is sourced and masked (plan §4 option b). */
export const FAMILY_REFERENCE_VERSION = "famref-wikipedia-lead-v1";

/** Locale-independent ordering for anything hashed (CODEX1 rev-26 #5). */
export const cmpCodePoints = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

export const EVAL_TEXT_DENY = [
  "taxonomy",
  "systematic",
  "etymolog",
  "subspecies",
  "in culture",
  "references",
  "further reading",
  "external links",
  "gallery",
  "notes",
] as const;

export const TAG_EVAL_DESIGNS: Readonly<Record<string, TagEvalDesign>> = {
  "habitat:open-ocean": {
    // Owner 2026-10-03: the strict (pelagic) meaning. The earlier "feed or rest
    // at sea, away from shore" wording also admitted terns, gulls, cormorants
    // and sea ducks, which the owner does not mean by open ocean.
    question:
      "From this article and its family's article, is this a bird of the open ocean, one that spends much of its life far out at sea, away from coasts, the way albatrosses and petrels do?",
    marineOrders: [
      "Procellariiformes",
      "Sphenisciformes",
      "Suliformes",
      "Phaethontiformes",
      "Gaviiformes",
      "Charadriiformes",
      "Anseriformes",
    ],
    cueWords: [
      "sea",
      "seas",
      "ocean",
      "oceans",
      "oceanic",
      "marine",
      "pelagic",
      "offshore",
      "seabird",
      "seabirds",
    ],
    namedCases: [
      { code: "amekes", name: "American Kestrel", expect: "no", gating: true },
      { code: "egygoo", name: "Egyptian Goose", expect: "no", gating: true },
      { code: "osprey", name: "Osprey", expect: "no", gating: true },
      {
        code: "lcspet",
        name: "Leach's Storm-Petrel",
        expect: "yes",
        gating: false,
      },
      // Owner 2026-10-01: sea ducks winter on coasts and large lakes — not open ocean.
      { code: "sursco", name: "Surf Scoter", expect: "no", gating: false },
      { code: "atlpuf", name: "Atlantic Puffin", expect: "yes", gating: false },
    ],
  },
};

const testDesigns = new Map<string, TagEvalDesign>();

export function tagEvalDesign(tag: string): TagEvalDesign | null {
  return TAG_EVAL_DESIGNS[tag] ?? testDesigns.get(tag) ?? null;
}

/** Tests only: give a fixture tag an (empty) evaluation design. */
export function __registerEvalDesignForTests(
  tag: string,
  design?: TagEvalDesign,
): void {
  testDesigns.set(
    tag,
    design ?? {
      question: `Does this text support ${tag}?`,
      marineOrders: [],
      cueWords: [],
      namedCases: [],
    },
  );
}

/** Canonical fingerprint of a tag's design plus the global deny list. */
export function designHash(tag: string): string {
  const d = tagEvalDesign(tag);
  if (!d) throw new Error(`no evaluation design for ${tag}`);
  const canonical = JSON.stringify({
    tag,
    marineOrders: [...d.marineOrders].sort(cmpCodePoints),
    cueWords: [...d.cueWords].sort(cmpCodePoints),
    question: d.question,
    namedCases: [...d.namedCases].sort((a, b) => cmpCodePoints(a.code, b.code)),
    evalTextDeny: [...EVAL_TEXT_DENY].sort(cmpCodePoints),
    evalTextVersion: EVAL_TEXT_VERSION,
    familyReference: FAMILY_REFERENCE_VERSION,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The part of a design the LABELLER sees (question, rendering version, deny
 * list, cue words, family-reference source) — bound into every eval_text_hash
 * so a change to any of them makes old labels non-reusable automatically
 * (plan §4 "Label identity"). Sampling proxies (marine orders, named cases)
 * are deliberately not in it: they do not change the page.
 */
export function evaluatorHash(tag: string): string {
  const d = tagEvalDesign(tag);
  if (!d) throw new Error(`no evaluation design for ${tag}`);
  return createHash("sha256")
    .update(
      JSON.stringify({
        question: d.question,
        cueWords: [...d.cueWords].sort(cmpCodePoints),
        evalTextDeny: [...EVAL_TEXT_DENY].sort(cmpCodePoints),
        evalTextVersion: EVAL_TEXT_VERSION,
        familyReference: FAMILY_REFERENCE_VERSION,
      }),
      "utf8",
    )
    .digest("hex");
}
