/**
 * The tag scanner: one approved ruleset × one species' stored article →
 * assigned / not_assigned / unevaluated, with evidence (td-894144 Release B).
 *
 * Pure and synchronous. No AI, no network, no database. The same inputs
 * always give the same result; `scannerRev` records the runtime whose
 * sentence segmentation produced it.
 */
import { foldCase, normalizeDisplay } from "./normalize";
import type { ExcludeRule, Ruleset, SupportRule } from "./rules";
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

export interface Evidence {
  section: string;
  /** The whole sentence, quoted from the normalized display text. */
  sentence: string;
  /** UTF-16 offsets of the matched phrase within that section's text. */
  matchStart: number;
  matchEnd: number;
  ruleId: string;
}

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

function taxonValue(t: TaxonInput, rank: "order" | "family"): string | null {
  return rank === "order" ? t.order : t.family;
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

  // 1. Taxon rules: every forbid first, then every requirement.
  const forbids = ruleset.taxon.filter((x) => x.action === "forbid");
  const requirements = ruleset.taxon.filter(
    (x) => x.action === "require_one_of",
  );
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
  if (
    [...forbids, ...requirements].some(
      (t) => taxonValue(input.taxon, t.rank) == null,
    )
  )
    return { ...withHash, status: "unevaluated", reason: "taxon_unknown" };

  // 2. Support phrases, focal-subject check, bound exclusions.
  const markers = ruleset.comparisonMarkers.map((m) =>
    tokenize(m).map((t) => t.text),
  );
  const supports = ruleset.support.map((rule) => ({
    rule,
    compiled: compilePhrase(rule.match.phrase, rule.match.type),
  }));
  const excludes = ruleset.exclude.map((rule) => ({
    rule,
    compiled: compilePhrase(rule.match.phrase, rule.match.type),
  }));
  const evidence: Evidence[] = [];
  const discarded: { ruleId: string; why: string }[] = [];
  const discard = (ruleId: string, why: string) => {
    if (discarded.length < MAX_DISCARDED) discarded.push({ ruleId, why });
  };

  for (const section of seg.sections) {
    if (!section.allowed) continue;
    for (const sentence of section.sentences) {
      for (const clause of sentence.clauses) {
        for (const { rule, compiled } of supports) {
          for (const hit of findPhrase(clause.tokens, compiled)) {
            const hitTokens = clause.tokens.slice(hit, hit + compiled.length);
            if (startsWithMarker(clause, markers)) {
              discard(rule.id, "comparison");
              continue;
            }
            const other = otherTaxonBefore(
              clause.tokens,
              hit,
              input.lexicon,
              exempt,
            );
            if (other) {
              discard(rule.id, `other_taxon:${other}`);
              continue;
            }
            const x = excluded(rule, hitTokens, clause, sentence, excludes);
            if (x) {
              discard(rule.id, `excluded:${x}`);
              continue;
            }
            if (evidence.length < MAX_EVIDENCE)
              evidence.push({
                section: section.title,
                sentence: section.display.slice(sentence.start, sentence.end),
                matchStart: hitTokens[0].start,
                matchEnd: hitTokens[hitTokens.length - 1].end,
                ruleId: rule.id,
              });
          }
        }
      }
    }
  }

  if (evidence.length > 0)
    return {
      ...withHash,
      status: "assigned",
      reason: null,
      evidence,
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
