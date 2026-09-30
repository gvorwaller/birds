/**
 * The tag scanner: one approved ruleset × one species' stored article →
 * assigned / not_assigned / unevaluated, with evidence (td-894144 Release B).
 *
 * Pure and synchronous. No AI, no network, no database. The same inputs
 * always give the same result; `scannerRev` records the runtime whose
 * sentence segmentation produced it.
 */
import { foldCase, normalizeDisplay } from "./normalize";
import {
  RANK_ORDER,
  type ExcludeRule,
  type Ruleset,
  type SupportRule,
  type TaxonRank,
  type TaxonRule,
} from "./rules";
import {
  segmentArticle,
  scannerRev,
  type ArticleInput,
  type Clause,
  type Sentence,
} from "./segment";
import { compilePhrase, findPhrase, tokenize, type Token } from "./tokens";

export interface TaxonInput {
  order: string | null;
  family: string | null;
  /** From the scientific name (genusOf); only schema-2 rules read it. */
  genus: string | null;
}

/**
 * The genus of a scientific name: its first token when the name has at least
 * two tokens and that token looks like a genus (capital + lowercase letters).
 * Mononyms and malformed names give null (the rank is then unknown).
 * The ONE parser for genus everywhere (plan §3a).
 */
export function genusOf(sciName: string | null | undefined): string | null {
  const parts = (sciName ?? "").trim().split(/\s+/);
  if (parts.length < 2) return null;
  return /^[A-Z][a-z]+$/.test(parts[0]) ? parts[0] : null;
}

/**
 * Names of OTHER taxa. A support phrase that follows one of these in its
 * clause is about that other bird ("…unlike the gannets, which feed at
 * sea"), so it is discarded. Built ONCE from taxonomy_cache (common
 * names, genera, family names and their plurals). The focal species' own
 * names, genus and family are passed per species as `exempt`, so "Storm
 * petrels feed at sea" still counts on a storm petrel's page.
 */
export interface TaxonLexicon {
  /** first folded token → candidate token sequences starting with it */
  byFirst: Map<string, string[][]>;
}

export function lexiconKey(name: string): string {
  return tokenize(foldCase(normalizeDisplay(name)))
    .map((t) => t.text)
    .join(" ");
}

export function buildLexicon(
  names: readonly string[],
  exempt: readonly string[] = [],
): TaxonLexicon {
  const skip = new Set(exempt.map(lexiconKey));
  const byFirst = new Map<string, string[][]>();
  const seen = new Set<string>();
  for (const n of names) {
    const key = lexiconKey(n);
    if (!key || skip.has(key) || seen.has(key)) continue;
    seen.add(key);
    const toks = key.split(" ");
    const list = byFirst.get(toks[0]) ?? [];
    list.push(toks);
    byFirst.set(toks[0], list);
  }
  for (const list of byFirst.values()) {
    list.sort((a, b) => {
      if (a.length !== b.length) return b.length - a.length;
      const ak = a.join(" ");
      const bk = b.join(" ");
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
  }
  return { byFirst };
}

/** A phrase match. Schema-1 items are byte-identical to B1–B4 (no `kind`, no `scopes`). */
export interface TextEvidence {
  section: string;
  /** The whole sentence, quoted from the normalized display text. */
  sentence: string;
  /** UTF-16 offsets of the matched phrase within that section's text. */
  matchStart: number;
  matchEnd: number;
  ruleId: string;
  /** Schema 2, scoped rules only: the taxon scopes that admitted this phrase. */
  scopes?: { rank: TaxonRank; value: string }[];
}

/** Schema 2: the species is in a listed taxon (always the ONLY evidence item). */
export interface TaxonEvidence {
  kind: "taxon";
  /** True number of matching assign rules; matchedRules is capped. */
  matchedCount: number;
  matchedRules: { ruleId: string; rank: TaxonRank; value: string }[];
}

export type Evidence = TextEvidence | TaxonEvidence;

export const isTaxonEvidence = (e: Evidence): e is TaxonEvidence =>
  (e as TaxonEvidence).kind === "taxon";

export type TagStatus = "assigned" | "not_assigned" | "unevaluated";

export interface TagResult {
  tag: string;
  status: TagStatus;
  /** Bounded reason code; null when assigned. */
  reason: string | null;
  evidence: Evidence[];
  textHash: string | null;
  scannerRev: string;
  /** Diagnostics for reports: why candidate matches were discarded. */
  discarded: { ruleId: string; why: string }[];
}

const MAX_EVIDENCE = 3;
const MAX_DISCARDED = 10;
/** Cap on matchedRules in a taxon evidence item (plan §3e). */
export const MAX_MATCHED_RULES = 5;

function taxonValue(t: TaxonInput, rank: TaxonRank): string | null {
  return rank === "order" ? t.order : rank === "family" ? t.family : t.genus;
}

const byRankThen = <T extends { rank: TaxonRank }>(
  a: T,
  b: T,
  tie: (a: T, b: T) => number,
) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank] || tie(a, b);
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Eligibility = "eligible" | "ineligible" | "unknown";

/**
 * Scope algebra (plan §3l): entries AND, values within an entry OR; a known
 * disqualifier wins over an unknown rank.
 */
function scopeEligibility(rule: SupportRule, taxon: TaxonInput): Eligibility {
  if (!rule.taxa) return "eligible";
  let unknown = false;
  for (const e of rule.taxa) {
    const v = taxonValue(taxon, e.rank);
    if (v == null) unknown = true;
    else if (!e.values.includes(v)) return "ineligible";
  }
  return unknown ? "unknown" : "eligible";
}

function startsWithMarker(
  clause: Clause,
  markers: readonly string[][],
): boolean {
  return markers.some(
    (m) =>
      m.length > 0 &&
      m.length <= clause.tokens.length &&
      m.every((w, i) => clause.tokens[i].text === w),
  );
}

function otherTaxonBefore(
  tokens: readonly Token[],
  end: number,
  lex: TaxonLexicon,
  exempt: ReadonlySet<string>,
): string | null {
  for (let i = 0; i < end; i++) {
    for (const seq of lex.byFirst.get(tokens[i].text) ?? []) {
      if (i + seq.length > end) continue;
      if (!seq.every((w, j) => tokens[i + j].text === w)) continue;
      const name = seq.join(" ");
      if (!exempt.has(name)) return name;
    }
  }
  return null;
}

interface CompiledExclude {
  rule: ExcludeRule;
  compiled: Set<string>[];
}

function excluded(
  support: SupportRule,
  hitTokens: readonly Token[],
  clause: Clause,
  sentence: Sentence,
  excludes: readonly CompiledExclude[],
): string | null {
  const first = hitTokens[0];
  const last = hitTokens[hitTokens.length - 1];
  for (const { rule, compiled } of excludes) {
    if (!rule.binds.includes("*") && !rule.binds.includes(support.group))
      continue;
    if (rule.scope.unit === "clause") {
      if (findPhrase(clause.tokens, compiled).length > 0) return rule.id;
    } else if (rule.scope.unit === "sentence") {
      if (findPhrase(sentence.tokens, compiled).length > 0) return rule.id;
    } else {
      // Keep token windows inside their clause. Strong punctuation and
      // contrast markers separate subjects; sentence scope is available
      // when crossing that boundary is intentional.
      const s = clause.tokens;
      const a = s.findIndex((t) => t.start === first.start);
      const b = s.findIndex((t) => t.start === last.start);
      if (a < 0 || b < 0) continue;
      const lo = Math.max(0, a - rule.scope.before);
      const hi = Math.min(s.length, b + 1 + rule.scope.after);
      for (const h of findPhrase(s, compiled)) {
        if (
          h >= lo &&
          h + compiled.length <= hi &&
          (h + compiled.length <= a || h > b)
        )
          return rule.id;
      }
    }
  }
  return null;
}

interface Walk {
  sectionIndex: number;
  sentenceIndex: number;
  section: string;
  sentence: string;
  matchStart: number;
  matchEnd: number;
  rule: SupportRule;
}

/**
 * The phrase pipeline, in the scanner's fixed order: section → sentence →
 * clause → support rule (listed order) → hit. `onAccept` sees every hit that
 * survives comparison markers, other-taxon discard and bound excludes;
 * `onDiscard` sees every discarded one. Scope eligibility is the caller's.
 */
function walkSupport(
  seg: ReturnType<typeof segmentArticle>,
  ruleset: Ruleset,
  rules: readonly SupportRule[],
  lexicon: TaxonLexicon,
  exempt: ReadonlySet<string>,
  onAccept: (w: Walk) => void,
  onDiscard: (ruleId: string, why: string) => void,
): void {
  const markers = ruleset.comparisonMarkers.map((m) =>
    tokenize(m).map((t) => t.text),
  );
  const supports = rules.map((rule) => ({
    rule,
    compiled: compilePhrase(rule.match.phrase, rule.match.type),
  }));
  const excludes = ruleset.exclude.map((rule) => ({
    rule,
    compiled: compilePhrase(rule.match.phrase, rule.match.type),
  }));
  seg.sections.forEach((section, sectionIndex) => {
    if (!section.allowed) return;
    section.sentences.forEach((sentence, sentenceIndex) => {
      for (const clause of sentence.clauses) {
        for (const { rule, compiled } of supports) {
          for (const hit of findPhrase(clause.tokens, compiled)) {
            const hitTokens = clause.tokens.slice(hit, hit + compiled.length);
            if (startsWithMarker(clause, markers)) {
              onDiscard(rule.id, "comparison");
              continue;
            }
            const other = otherTaxonBefore(clause.tokens, hit, lexicon, exempt);
            if (other) {
              onDiscard(rule.id, `other_taxon:${other}`);
              continue;
            }
            const x = excluded(rule, hitTokens, clause, sentence, excludes);
            if (x) {
              onDiscard(rule.id, `excluded:${x}`);
              continue;
            }
            onAccept({
              sectionIndex,
              sentenceIndex,
              section: section.title,
              sentence: section.display.slice(sentence.start, sentence.end),
              matchStart: hitTokens[0].start,
              matchEnd: hitTokens[hitTokens.length - 1].end,
              rule,
            });
          }
        }
      }
    });
  });
}

/** Matched (rank, value) of every entry of an eligible scoped rule, sorted (plan §3e). */
function scopesOf(
  rule: SupportRule,
  taxon: TaxonInput,
): { rank: TaxonRank; value: string }[] {
  return (rule.taxa ?? [])
    .map((e) => ({ rank: e.rank, value: taxonValue(taxon, e.rank)! }))
    .sort((a, b) => byRankThen(a, b, (x, y) => cmpStr(x.value, y.value)));
}

export function evaluateTag(
  input: {
    article: ArticleInput | null;
    taxon: TaxonInput;
    lexicon: TaxonLexicon;
    /** The focal species' own names (common, genus, family…): never "another taxon". */
    exempt?: readonly string[];
  },
  ruleset: Ruleset,
): TagResult {
  const exempt = new Set((input.exempt ?? []).map(lexiconKey));
  const base = {
    tag: ruleset.tag,
    evidence: [] as Evidence[],
    scannerRev: scannerRev(),
    discarded: [],
  };
  const hasText =
    input.article != null &&
    ((input.article.extract ?? "").trim() !== "" ||
      input.article.sections.some((s) => s.text?.trim()));
  if (!hasText)
    return {
      ...base,
      status: "unevaluated",
      reason: "no_article",
      textHash: null,
    };

  const seg = segmentArticle(input.article!, ruleset.denySections);
  const withHash = { ...base, textHash: seg.textHash };

  // 1. Known disqualifiers: every forbid first, then every requirement.
  const forbids = ruleset.taxon.filter((x) => x.action === "forbid");
  const requirements = ruleset.taxon.filter(
    (x) => x.action === "require_one_of",
  );
  const assigns = ruleset.taxon.filter((x) => x.action === "assign");
  for (const t of forbids) {
    const v = taxonValue(input.taxon, t.rank);
    if (v != null && t.values.includes(v))
      return {
        ...withHash,
        status: "not_assigned",
        reason: `taxon_forbid:${t.id}`,
      };
  }
  // A known disqualifier is conclusive even if another requested rank is
  // missing. Check every known value before allowing unknown data to win;
  // otherwise reordering equivalent rules changes the result.
  for (const t of requirements) {
    const v = taxonValue(input.taxon, t.rank);
    if (v != null && !t.values.includes(v))
      return {
        ...withHash,
        status: "not_assigned",
        reason: `requires_unmet:${t.id}`,
      };
  }
  // 2. Unknowns among forbid/require.
  if (
    [...forbids, ...requirements].some(
      (t) => taxonValue(input.taxon, t.rank) == null,
    )
  )
    return { ...withHash, status: "unevaluated", reason: "taxon_unknown" };

  // 3. Assign (schema 2): OR over rules; one bounded taxon evidence item.
  const matched: TaxonRule[] = assigns.filter((t) => {
    const v = taxonValue(input.taxon, t.rank);
    return v != null && t.values.includes(v);
  });
  if (matched.length > 0) {
    const rules = matched
      .map((t) => ({
        ruleId: t.id,
        rank: t.rank,
        value: taxonValue(input.taxon, t.rank)!,
      }))
      .sort((a, b) => byRankThen(a, b, (x, y) => cmpStr(x.ruleId, y.ruleId)));
    return {
      ...withHash,
      status: "assigned",
      reason: null,
      evidence: [
        {
          kind: "taxon",
          matchedCount: rules.length,
          matchedRules: rules.slice(0, MAX_MATCHED_RULES),
        },
      ],
    };
  }
  const assignUnknown = assigns.some(
    (t) => taxonValue(input.taxon, t.rank) == null,
  );

  // 4. Support phrases (scoped rules only where eligible), focal-subject
  //    check, bound exclusions.
  const eligibility = new Map(
    ruleset.support.map((r) => [r.id, scopeEligibility(r, input.taxon)]),
  );
  const evidence: Evidence[] = [];
  const discarded: { ruleId: string; why: string }[] = [];
  let scopeUnknownHit = false;
  walkSupport(
    seg,
    ruleset,
    ruleset.support.filter((r) => eligibility.get(r.id) !== "ineligible"),
    input.lexicon,
    exempt,
    (w) => {
      if (eligibility.get(w.rule.id) === "unknown") {
        // Would have counted, but the scope rank is unknown (plan §3a step 5).
        scopeUnknownHit = true;
        return;
      }
      if (evidence.length < MAX_EVIDENCE) {
        const item: TextEvidence = {
          section: w.section,
          sentence: w.sentence,
          matchStart: w.matchStart,
          matchEnd: w.matchEnd,
          ruleId: w.rule.id,
        };
        if (w.rule.taxa) item.scopes = scopesOf(w.rule, input.taxon);
        evidence.push(item);
      }
    },
    (ruleId, why) => {
      if (discarded.length < MAX_DISCARDED) discarded.push({ ruleId, why });
    },
  );

  if (evidence.length > 0)
    return {
      ...withHash,
      status: "assigned",
      reason: null,
      evidence,
      discarded,
    };
  // 5. No surviving support: an unknown assign or scope rank is "unknown".
  if (assignUnknown || scopeUnknownHit)
    return {
      ...withHash,
      status: "unevaluated",
      reason: "taxon_unknown",
      discarded,
    };
  const firstExclude = discarded.find((d) => d.why.startsWith("excluded:"));
  return {
    ...withHash,
    status: "not_assigned",
    reason: firstExclude
      ? firstExclude.why
      : discarded.length > 0
        ? "no_focal_support"
        : "no_support",
    discarded,
  };
}

/** One accepted phrase hit, for Preview examples (plan §3r). */
export interface AcceptedHit {
  sectionIndex: number;
  sentenceIndex: number;
  section: string;
  sentence: string;
  matchStart: number;
  matchEnd: number;
  ruleId: string;
  scopes?: { rank: TaxonRank; value: string }[];
}

/**
 * Every accepted support hit, uncapped, for ELIGIBLE rules only — the same
 * pipeline as evaluateTag. evaluateTag's own evidence is unaffected.
 */
export function collectAcceptedHits(
  input: {
    article: ArticleInput | null;
    taxon: TaxonInput;
    lexicon: TaxonLexicon;
    exempt?: readonly string[];
  },
  ruleset: Ruleset,
): AcceptedHit[] {
  if (input.article == null) return [];
  const exempt = new Set((input.exempt ?? []).map(lexiconKey));
  const seg = segmentArticle(input.article, ruleset.denySections);
  const out: AcceptedHit[] = [];
  walkSupport(
    seg,
    ruleset,
    ruleset.support.filter(
      (r) => scopeEligibility(r, input.taxon) === "eligible",
    ),
    input.lexicon,
    exempt,
    (w) => {
      const hit: AcceptedHit = {
        sectionIndex: w.sectionIndex,
        sentenceIndex: w.sentenceIndex,
        section: w.section,
        sentence: w.sentence,
        matchStart: w.matchStart,
        matchEnd: w.matchEnd,
        ruleId: w.rule.id,
      };
      if (w.rule.taxa) hit.scopes = scopesOf(w.rule, input.taxon);
      out.push(hit);
    },
    () => {},
  );
  return out;
}

/** Preview example order: (section, sentence, matchStart, ruleId in C order). */
export function compareHits(a: AcceptedHit, b: AcceptedHit): number {
  return (
    a.sectionIndex - b.sectionIndex ||
    a.sentenceIndex - b.sentenceIndex ||
    a.matchStart - b.matchStart ||
    cmpStr(a.ruleId, b.ruleId)
  );
}

/** The Preview example: the minimum accepted hit by compareHits (plan §3r). */
export function firstAcceptedHit(
  hits: readonly AcceptedHit[],
): AcceptedHit | null {
  let best: AcceptedHit | null = null;
  for (const h of hits) if (!best || compareHits(h, best) < 0) best = h;
  return best;
}
