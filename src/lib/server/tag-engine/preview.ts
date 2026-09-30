/**
 * Preview: what a proposed rule set WOULD do to every species, before anyone
 * approves it (td-894144 B5, plan docs/2026-09-30-open-ocean-rules-v2-plan.md
 * §3d/§3j/§3m/§3r/§3y). Pure: the job (tag-preview-job.ts) does the I/O.
 *
 * Descriptive, never pass/fail. It compares the rules with the legacy tags:
 * additions (rules-only) and drops (legacy-only), with counts by order and
 * family and a small deterministic set of example sentences.
 *
 * Determinism is part of the contract: record_tag_preview refuses a second
 * body for the same (proposal, artifact, corpus, design) key, so everything
 * here is ordered by explicit keys, never by iteration accident.
 */
import { createHash } from "node:crypto";
import { foldCase } from "./normalize";
import type { Ruleset } from "./rules";
import {
  collectAcceptedHits,
  evaluateTag,
  firstAcceptedHit,
  isTaxonEvidence,
  type TaxonLexicon,
} from "./scanner";
import { segmentArticle, type ArticleInput } from "./segment";
import { tokenize } from "./tokens";
import { cmpCodePoints, type TagEvalDesign } from "./eval-design";
import type { TaxonCheck } from "./taxon-check";

export const PREVIEW_ALGORITHM = "preview-v1";
/** Examples per stratum and in total (plan §3h/§3d). */
export const PREVIEW_K = 4;
export const PREVIEW_CAP = 60;
/** Full lists are capped (plan §3j); true counts are always kept. */
export const PREVIEW_LIST_CAP = 2000;
export const PREVIEW_OVERLAP_LINES = 50;
export const PREVIEW_BODY_CAP = 1_048_576;
/**
 * The TS-side target for JSON.stringify bytes. PostgreSQL's jsonb text adds a
 * space after every ':' and ',', so aim well under the DB's 1 MB CHECK.
 */
export const PREVIEW_BODY_TARGET = 700_000;

/**
 * sha256 over the raw bytes of the engine sources and this file (plan §3y):
 * normalize, tokens, segment, rules, scanner, taxon-check (its output is in
 * the body), preview — each prefixed by its
 * file name and a newline — with ONLY this constant's own line removed. The
 * guard test recomputes it; any code change to Preview or the engine needs a
 * new value AND a migration re-pinning tag_preview_design, which makes every
 * older Preview non-current.
 */
export const PREVIEW_SOURCE_HASH = 'bb05428d24ee8feb747f7e0d4a317f7da4810721969b522086c866395443aee5';

const sha256 = (s: string) =>
  createHash("sha256").update(s, "utf8").digest("hex");

/**
 * The preview design for a tag (pinned in SQL as tag_preview_design and
 * compared by a test). Covers everything that shapes a Preview body.
 */
export function previewDesignHash(tag: string, design: TagEvalDesign): string {
  return sha256(
    JSON.stringify({
      algorithm: PREVIEW_ALGORITHM,
      tag,
      marineOrders: [...design.marineOrders].sort(cmpCodePoints),
      cueWords: [...design.cueWords].sort(cmpCodePoints),
      namedCases: [...design.namedCases]
        .map((c) => ({ code: c.code, expect: c.expect, gating: c.gating }))
        .sort((a, b) => cmpCodePoints(a.code, b.code)),
      strata: "rules-only|legacy-only × marine|non-marine × order (code point)",
      k: PREVIEW_K,
      cap: PREVIEW_CAP,
      listCap: PREVIEW_LIST_CAP,
      overlapLines: PREVIEW_OVERLAP_LINES,
      sourceHash: PREVIEW_SOURCE_HASH,
    }),
  );
}

export interface PreviewSpecies {
  code: string;
  name: string;
  order: string | null;
  family: string | null;
  genus: string | null;
  legacy: boolean;
  article: ArticleInput;
  exempt: string[];
}

type Side = "rules-only" | "legacy-only";

interface Example {
  code: string;
  name: string;
  side: Side | "named";
  order: string | null;
  family: string | null;
  marine: boolean;
  /** For named cases: what the design expects and whether it gates. */
  expect?: "yes" | "no";
  gating?: boolean;
  rulesStatus: string;
  rulesReason: string | null;
  legacy: boolean;
  /** Why the rules tag it (additions): a taxon listing or the first accepted sentence. */
  evidence:
    | { kind: "taxon"; rules: { ruleId: string; rank: string; value: string }[] }
    | { kind: "text"; ruleId: string; section: string; sentence: string }
    | null;
  /** Drops: the first scanned sentence with a cue word, or null. */
  cueSentence?: { section: string; sentence: string } | null;
}

export interface PreviewBody {
  algorithm: string;
  tag: string;
  artifactSha256: string;
  scannerRev: string;
  counts: {
    universe: number;
    assigned: number;
    notAssigned: number;
    unevaluated: number;
    assignedByTaxon: number;
    assignedByPhrase: number;
    legacy: number;
    both: number;
    rulesOnly: number;
    legacyOnly: number;
    byReason: Record<string, number>;
  };
  byOrder: { order: string; both: number; rulesOnly: number; legacyOnly: number }[];
  byFamily: { family: string; order: string; both: number; rulesOnly: number; legacyOnly: number }[];
  additions: { total: number; truncated: boolean; codes: string[] };
  drops: { total: number; truncated: boolean; codes: string[] };
  examples: Example[];
  taxonCheck: { problems: string[]; overlapCount: number; truncated: boolean };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** First scanned sentence containing a cue word (whole word after foldCase), plan §3m. */
function cueSentence(
  article: ArticleInput,
  denySections: readonly string[],
  cues: ReadonlySet<string>,
): { section: string; sentence: string } | null {
  if (cues.size === 0) return null;
  const seg = segmentArticle(article, denySections);
  for (const s of seg.sections) {
    if (!s.allowed) continue;
    for (const sen of s.sentences) {
      const text = s.display.slice(sen.start, sen.end);
      if (tokenize(foldCase(text)).some((t) => cues.has(t.text)))
        return { section: s.title, sentence: text };
    }
  }
  return null;
}

interface Summary {
  code: string;
  name: string;
  order: string | null;
  family: string | null;
  genus: string | null;
  legacy: boolean;
  status: string;
  reason: string | null;
  taxonRules: { ruleId: string; rank: string; value: string }[] | null;
}

export interface PreviewSetup {
  tag: string;
  ruleset: Ruleset;
  artifactSha256: string;
  scannerRev: string;
  design: TagEvalDesign;
  lexicon: TaxonLexicon;
}

/**
 * Pass 1 (bounded memory): species are added in batches — each is scored and
 * reduced to a small summary, its article dropped. Pass 2: exampleCodes()
 * names the ≤ PREVIEW_CAP species to show; the caller re-reads just those
 * articles (same snapshot) and finish() builds the body.
 */
export class PreviewAccumulator {
  private readonly marine: ReadonlySet<string>;
  private readonly summaries = new Map<string, Summary>();

  constructor(private readonly setup: PreviewSetup) {
    this.marine = new Set(setup.design.marineOrders);
  }

  add(sp: PreviewSpecies): void {
    if (this.summaries.has(sp.code)) throw new Error(`preview: ${sp.code} added twice`);
    const res = evaluateTag(
      {
        article: sp.article,
        taxon: { order: sp.order, family: sp.family, genus: sp.genus },
        lexicon: this.setup.lexicon,
        exempt: sp.exempt,
      },
      this.setup.ruleset,
    );
    const taxon = res.evidence.find(isTaxonEvidence);
    this.summaries.set(sp.code, {
      code: sp.code,
      name: sp.name,
      order: sp.order,
      family: sp.family,
      genus: sp.genus,
      legacy: sp.legacy,
      status: res.status,
      reason: res.reason,
      taxonRules: taxon ? taxon.matchedRules : null,
    });
  }

  private rank(code: string): string {
    return sha256(`${PREVIEW_ALGORITHM}|${this.setup.artifactSha256}|${code}`);
  }

  private sides(): { rulesOnly: Summary[]; legacyOnly: Summary[] } {
    const all = [...this.summaries.values()].sort((a, b) => cmp(a.code, b.code));
    const byRank = (a: Summary, b: Summary) =>
      cmp(this.rank(a.code), this.rank(b.code)) || cmp(a.code, b.code);
    return {
      rulesOnly: all.filter((x) => x.status === "assigned" && !x.legacy).sort(byRank),
      legacyOnly: all.filter((x) => x.status !== "assigned" && x.legacy).sort(byRank),
    };
  }

  /** The examples, in order: named cases first, then the round-robin strata (plan §3d). */
  private chosen(): { s: Summary; side: Side | "named" }[] {
    const { rulesOnly, legacyOnly } = this.sides();
    const out: { s: Summary; side: Side | "named" }[] = [];
    const taken = new Set<string>();
    for (const nc of [...this.setup.design.namedCases].sort((a, b) => cmp(a.code, b.code))) {
      const s = this.summaries.get(nc.code);
      if (!s || out.length >= PREVIEW_CAP) continue;
      out.push({ s, side: "named" });
      taken.add(s.code);
    }
    // Strata: rules-only before legacy-only, marine before non-marine, then
    // orders by code point; round-robin, each stratum giving its next
    // not-yet-taken member (rank order), for up to K rounds.
    const strata: { side: Side; members: Summary[] }[] = [];
    for (const [side, list] of [
      ["rules-only", rulesOnly],
      ["legacy-only", legacyOnly],
    ] as const)
      for (const isMarine of [true, false]) {
        const byOrd = new Map<string, Summary[]>();
        for (const x of list)
          if ((!!x.order && this.marine.has(x.order)) === isMarine) {
            const k = x.order ?? "";
            byOrd.set(k, [...(byOrd.get(k) ?? []), x]);
          }
        for (const k of [...byOrd.keys()].sort(cmpCodePoints))
          strata.push({ side, members: byOrd.get(k)! });
      }
    const cursors = strata.map(() => 0);
    for (let r = 0; r < PREVIEW_K && out.length < PREVIEW_CAP; r++)
      strata.forEach((st, i) => {
        if (out.length >= PREVIEW_CAP) return;
        while (cursors[i] < st.members.length && taken.has(st.members[cursors[i]].code))
          cursors[i]++;
        const x = st.members[cursors[i]];
        if (!x) return;
        cursors[i]++;
        taken.add(x.code);
        out.push({ s: x, side: st.side });
      });
    return out;
  }

  exampleCodes(): string[] {
    return this.chosen().map((c) => c.s.code);
  }

  finish(
    articles: ReadonlyMap<string, { article: ArticleInput; exempt: string[] }>,
    taxonCheck: TaxonCheck,
  ): PreviewBody {
    const { ruleset, design, lexicon } = this.setup;
    const cues = new Set(design.cueWords.map((w) => foldCase(w)));
    const counts: PreviewBody["counts"] = {
      universe: this.summaries.size,
      assigned: 0,
      notAssigned: 0,
      unevaluated: 0,
      assignedByTaxon: 0,
      assignedByPhrase: 0,
      legacy: 0,
      both: 0,
      rulesOnly: 0,
      legacyOnly: 0,
      byReason: {},
    };
    const byOrder = new Map<string, { both: number; rulesOnly: number; legacyOnly: number }>();
    const byFamily = new Map<string, { order: string; both: number; rulesOnly: number; legacyOnly: number }>();
    for (const x of [...this.summaries.values()].sort((a, b) => cmp(a.code, b.code))) {
      const assigned = x.status === "assigned";
      if (assigned) {
        counts.assigned++;
        if (x.taxonRules) counts.assignedByTaxon++;
        else counts.assignedByPhrase++;
      } else if (x.status === "not_assigned") counts.notAssigned++;
      else counts.unevaluated++;
      if (x.reason) {
        // Reason codes carry rule ids; bucket by their kind.
        const k = x.reason.split(":")[0];
        counts.byReason[k] = (counts.byReason[k] ?? 0) + 1;
      }
      if (x.legacy) counts.legacy++;
      const cell = assigned && x.legacy ? "both" : assigned ? "rulesOnly" : x.legacy ? "legacyOnly" : null;
      if (!cell) continue;
      counts[cell]++;
      const o = x.order ?? "(unknown)";
      const f = x.family ?? "(unknown)";
      const ob = byOrder.get(o) ?? { both: 0, rulesOnly: 0, legacyOnly: 0 };
      ob[cell]++;
      byOrder.set(o, ob);
      const fb = byFamily.get(f) ?? { order: o, both: 0, rulesOnly: 0, legacyOnly: 0 };
      fb[cell]++;
      byFamily.set(f, fb);
    }
    const examples: Example[] = this.chosen().map(({ s: x, side }) => {
      const ex: Example = {
        code: x.code,
        name: x.name,
        side,
        order: x.order,
        family: x.family,
        marine: !!x.order && this.marine.has(x.order),
        rulesStatus: x.status,
        rulesReason: x.reason,
        legacy: x.legacy,
        evidence: null,
      };
      if (side === "named") {
        const nc = design.namedCases.find((c) => c.code === x.code)!;
        ex.expect = nc.expect;
        ex.gating = nc.gating;
      }
      const a = articles.get(x.code);
      if (x.status === "assigned") {
        if (x.taxonRules) ex.evidence = { kind: "taxon", rules: x.taxonRules };
        else if (a) {
          const hit = firstAcceptedHit(
            collectAcceptedHits(
              {
                article: a.article,
                taxon: { order: x.order, family: x.family, genus: x.genus },
                lexicon,
                exempt: a.exempt,
              },
              ruleset,
            ),
          );
          if (hit)
            ex.evidence = {
              kind: "text",
              ruleId: hit.ruleId,
              section: hit.section,
              sentence: hit.sentence,
            };
        }
      } else if (x.legacy)
        ex.cueSentence = a ? cueSentence(a.article, ruleset.denySections, cues) : null;
      return ex;
    });
    const { rulesOnly, legacyOnly } = this.sides();
    const list = (xs: Summary[]) => ({
      total: xs.length,
      truncated: xs.length > PREVIEW_LIST_CAP,
      codes: xs.slice(0, PREVIEW_LIST_CAP).map((x) => x.code),
    });
    const body: PreviewBody = {
      algorithm: PREVIEW_ALGORITHM,
      tag: this.setup.tag,
      artifactSha256: this.setup.artifactSha256,
      scannerRev: this.setup.scannerRev,
      counts,
      byOrder: [...byOrder.entries()]
        .map(([order, v]) => ({ order, ...v }))
        .sort((a, b) => cmpCodePoints(a.order, b.order)),
      byFamily: [...byFamily.entries()]
        .map(([family, v]) => ({ family, ...v }))
        .sort((a, b) => cmpCodePoints(a.family, b.family)),
      additions: list(rulesOnly),
      drops: list(legacyOnly),
      examples,
      taxonCheck: {
        problems: taxonCheck.problems.slice(0, PREVIEW_OVERLAP_LINES),
        overlapCount: taxonCheck.overlap.count,
        truncated: taxonCheck.problems.length > PREVIEW_OVERLAP_LINES,
      },
    };
    // The 1 MB cap: halve the list caps (additions first, then drops) until
    // the JSON is under the target. True counts and flags stay.
    for (let guard = 0; bodyBytes(body) > PREVIEW_BODY_TARGET && guard < 40; guard++) {
      const target =
        body.additions.codes.length >= body.drops.codes.length ? body.additions : body.drops;
      if (target.codes.length === 0) break;
      target.codes = target.codes.slice(0, Math.floor(target.codes.length / 2));
      target.truncated = true;
    }
    return body;
  }
}

/** All-in-memory convenience (tests): the same body the batched job builds. */
export function buildPreview(
  input: PreviewSetup & { species: readonly PreviewSpecies[]; taxonCheck: TaxonCheck },
): PreviewBody {
  const acc = new PreviewAccumulator(input);
  for (const sp of input.species) acc.add(sp);
  const wanted = new Set(acc.exampleCodes());
  const articles = new Map(
    input.species
      .filter((sp) => wanted.has(sp.code))
      .map((sp) => [sp.code, { article: sp.article, exempt: sp.exempt }]),
  );
  return acc.finish(articles, input.taxonCheck);
}

/** UTF-8 size of the body as JSON (the DB's jsonb text is within a few bytes). */
export function bodyBytes(body: unknown): number {
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}
