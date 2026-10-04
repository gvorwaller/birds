/**
 * The evaluator text a labeller reads (td-894144 Release B4, plan rev 23
 * §B4h). REVISION-INDEPENDENT by construction: it depends only on the stored
 * article and the fixed global deny list — never on a rule set — so the
 * evidence shown cannot be tuned by the thing under test, and a label keyed by
 * its hash is reusable across revisions.
 *
 * v2 (td-894144 B5, plan §4 option b): the page also shows the lead of the
 * species' family's Wikipedia article — a fixed, independent reference (never
 * AI-written), pinned by revision.
 *
 * v3 (owner 2026-10-03): nothing is masked. The page names the bird; "blind"
 * hides only what the system wants the answer to be (the rules' and the old
 * AI's results, the matched rules and evidence, the stratum).
 */
import { createHash } from "node:crypto";
import {
  EVAL_TEXT_DENY,
  EVAL_TEXT_VERSION,
  cmpCodePoints,
} from "./eval-design";
import { normalizeDisplay } from "./normalize";
import { segmentArticle } from "./segment";

export interface EvalSection {
  title: string;
  text: string;
}

/** The frozen family reference shown on a page (tag_eval_item.family_reference). */
export interface FamilyReferenceSnapshot {
  familyCode: string;
  title: string;
  revId: number;
  /** Exactly as stored (its hash is the frame's reference_sha). */
  lead: string;
  /** What the page shows: the normalized lead (v2 sets froze it with the bird's names masked). */
  displayLead: string;
}

export interface EvalText {
  sections: EvalSection[];
  reference: FamilyReferenceSnapshot | null;
  /**
   * Label identity (CODEX1 rev-24 P1-2): covers EVERYTHING the labeller sees —
   * the rendering version, the fixed deny list, the underlined cue words and
   * the sections — so a label is reused only for an identical page.
   */
  hash: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The sections a page shows, from the stored article: the SAME normalized
 * sections the input's text_hash covers (segmentArticle's display text), so
 * any change to what the labeller reads also changes input_hash and therefore
 * the frame hash (CODEX1 rev-25 P1-1).
 */
export function evalSections(article: {
  extract: string | null;
  sections: readonly EvalSection[] | null;
}): EvalSection[] {
  const seg = segmentArticle(
    { extract: article.extract, sections: article.sections ?? [] },
    EVAL_TEXT_DENY,
  );
  return seg.sections
    .filter((s) => s.allowed && s.display.trim())
    .map((s) => ({ title: normalizeDisplay(s.title), text: s.display }));
}

export function buildEvalText(
  article: { extract: string | null; sections: readonly EvalSection[] | null },
  cueWords: readonly string[],
  page: {
    /** eval-design evaluatorHash(tag): question, version, deny, cues, reference source. */
    evaluatorHash: string;
    reference: {
      familyCode: string;
      title: string;
      revId: number;
      lead: string;
    } | null;
  },
): EvalText {
  const sections = evalSections(article);
  const reference: FamilyReferenceSnapshot | null = page.reference
    ? {
        ...page.reference,
        displayLead: normalizeDisplay(page.reference.lead),
      }
    : null;
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        v: EVAL_TEXT_VERSION,
        evaluator: page.evaluatorHash,
        deny: [...EVAL_TEXT_DENY],
        cues: [...cueWords].map((w) => w.toLowerCase()).sort(cmpCodePoints),
        sections,
        reference: reference
          ? {
              familyCode: reference.familyCode,
              title: reference.title,
              revId: reference.revId,
              leadSha256: createHash("sha256")
                .update(reference.lead, "utf8")
                .digest("hex"),
              displayLead: reference.displayLead,
            }
          : null,
      }),
      "utf8",
    )
    .digest("hex");
  return { sections, reference, hash };
}

/** [start, end) ranges of the fixed cue words — a reading aid, the same for every system. */
export function cueRanges(
  text: string,
  cueWords: readonly string[],
): [number, number][] {
  if (!cueWords.length) return [];
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${cueWords.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`,
    "giu",
  );
  const out: [number, number][] = [];
  for (const m of text.matchAll(re))
    out.push([m.index!, m.index! + m[0].length]);
  return out;
}
