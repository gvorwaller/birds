/**
 * The evaluator text a labeller reads (td-894144 Release B4, plan rev 23
 * §B4h). REVISION-INDEPENDENT by construction: it depends only on the stored
 * article, the species' names and the fixed global deny list — never on a
 * rule set — so the evidence shown cannot be tuned by the thing under test,
 * and a label keyed by its hash is reusable across revisions.
 *
 * The species' own names are masked ("[this bird]", "[genus]") so a label
 * answers what the TEXT says, not what the labeller knows about the bird.
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

export interface EvalText {
  sections: EvalSection[];
  /**
   * Label identity (CODEX1 rev-24 P1-2): covers EVERYTHING the labeller sees —
   * the rendering version, the fixed deny list, the underlined cue words and
   * the masked sections — so a label is reused only for an identical page.
   */
  hash: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Longest-first, whole-word, case-insensitive masking. */
export function maskNames(
  text: string,
  names: { common: string | null; scientific: string | null },
): string {
  const replacements: [string, string][] = [];
  const sci = (names.scientific ?? "").trim();
  const [genus, epithet] = sci.split(/\s+/);
  const common = (names.common ?? "").trim();
  if (sci.includes(" ")) replacements.push([sci, "[this bird]"]);
  if (common) {
    replacements.push([common, "[this bird]"]);
    // The group noun ("Kestrel", "Storm-Petrel") — often the whole name in running text.
    const last = common.split(/\s+/).pop()!;
    if (last.length >= 4 && last.toLowerCase() !== common.toLowerCase())
      replacements.push([last, "[this bird]"]);
  }
  if (genus && genus.length >= 3) replacements.push([genus, "[genus]"]);
  if (epithet && epithet.length >= 4)
    replacements.push([epithet, "[this bird]"]);
  let out = text;
  for (const [name, mask] of replacements.sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    // Plurals and possessives of the name are masked too.
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRe(name)}(?:e?s|'s|’s)?(?![\\p{L}\\p{N}])`,
      "giu",
    );
    out = out.replace(re, mask);
  }
  return out;
}

export function buildEvalText(
  article: { extract: string | null; sections: readonly EvalSection[] | null },
  names: { common: string | null; scientific: string | null },
  cueWords: readonly string[],
): EvalText {
  // Built from the SAME normalized sections the input's text_hash covers
  // (segmentArticle's display text), so any change to what the labeller
  // reads also changes input_hash and therefore the frame hash (CODEX1
  // rev-25 P1-1). The species' names are bound separately in the frame.
  const seg = segmentArticle(
    { extract: article.extract, sections: article.sections ?? [] },
    EVAL_TEXT_DENY,
  );
  const raw: EvalSection[] = seg.sections
    .filter((s) => s.allowed && s.display.trim())
    .map((s) => ({ title: normalizeDisplay(s.title), text: s.display }));
  const sections = raw.map((s) => ({
    title: maskNames(s.title, names),
    text: maskNames(s.text, names),
  }));
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        v: EVAL_TEXT_VERSION,
        deny: [...EVAL_TEXT_DENY],
        cues: [...cueWords].map((w) => w.toLowerCase()).sort(cmpCodePoints),
        sections,
      }),
      "utf8",
    )
    .digest("hex");
  return { sections, hash };
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
