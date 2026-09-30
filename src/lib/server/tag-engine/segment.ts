/**
 * Article → sections → sentences → clauses, with offsets (plan rev 10 §B7).
 *
 * Sentences come from Intl.Segmenter('en', {granularity: 'sentence'}). Its
 * boundaries depend on the ICU version, so `scannerRev()` records Node, ICU
 * and Unicode versions with every result, and golden snapshots pin them.
 *
 * A clause is a sentence split at ; : — ( ) and before the words but,
 * whereas, while, although, though, however, except. Rules scoped to a
 * clause cannot see across those boundaries — which is what keeps "it feeds
 * inland, but crosses the open ocean on migration" from supporting a tag
 * with its second half.
 */
import { foldCase, normalizeDisplay, sha256Json } from "./normalize";
import { tokenize, type Token } from "./tokens";

export interface ArticleInput {
  extract: string | null;
  sections: readonly { title: string; text: string }[];
}

export interface Clause {
  start: number;
  end: number;
  tokens: Token[];
}

export interface Sentence {
  start: number;
  end: number;
  clauses: Clause[];
  tokens: Token[];
}

export interface Section {
  /** '' for the article extract (lead). */
  title: string;
  allowed: boolean;
  /** Why a section is not scanned, e.g. "deny:taxonomy". */
  skipReason: string | null;
  display: string;
  folded: string;
  sentences: Sentence[];
}

export interface Segmented {
  sections: Section[];
  /** SHA-256 of the whole normalized article — the state row's text_hash. */
  textHash: string;
}

/** Heading keywords whose sections talk about OTHER taxa. Deny wins on a
 * mixed heading ("Description and taxonomy" is not scanned). */
export const DEFAULT_DENY_KEYWORDS = [
  "taxonom",
  "systematic",
  "etymolog",
  "similar",
  "culture",
  "subspecies",
  "name",
] as const;

const CLAUSE_WORDS = [
  "but",
  "whereas",
  "while",
  "although",
  "though",
  "however",
  "except",
];

/**
 * SHA-256 over the engine's semantic sources (normalize, tokens, segment,
 * rules, scanner — comments, blank lines and this constant's own line
 * excluded). The guard test recomputes it and FAILS when the sources change
 * without this constant being updated, so a semantic engine change always
 * produces a new scanner_rev → new input_hash → full re-materialization
 * (plan rev 14, CODEX1 P2).
 */
export const ENGINE_SOURCE_HASH = 'abca3e809fed490199c1505531d74203ba72874277eac25228f52a8a3af0a05f';

export function scannerRev(): string {
	const v = process.versions as Record<string, string | undefined>;
	return `engine-1+${ENGINE_SOURCE_HASH.slice(0, 12)}|node-${v.node}|icu-${v.icu ?? 'none'}|unicode-${v.unicode ?? 'none'}`;
}

/**
 * ICU's default sentence rules end a sentence after "Dr.", "St." or an
 * initial. A span ending in one of these (or a single letter + ".") is joined
 * to the next span — deterministic, and independent of ICU's own
 * abbreviation data.
 */
export const ABBREVIATIONS = [
  "dr",
  "mr",
  "mrs",
  "ms",
  "st",
  "mt",
  "ft",
  "no",
  "vs",
  "cf",
  "ca",
  "c",
  "approx",
  "fig",
  "e.g",
  "i.e",
  "sp",
  "spp",
  "ssp",
  "subsp",
  "var",
  "prof",
  "rev",
  "gen",
  "col",
];
const ABBREV_END = new RegExp(
  `(?:^|[\\s(])(?:${ABBREVIATIONS.map((a) => a.replace(".", "\\.")).join("|")}|\\p{L})\\.$`,
  "iu",
);
const CONTEXTUAL_ABBREV_END = /(?:^|[\s(])(?:etc|jr|sr)\.$/iu;

function shouldMergeSentence(prev: string, next: string): boolean {
  if (ABBREV_END.test(prev)) return true;
  // These can legitimately end a sentence. Merge only when the following
  // span starts like a continuation, not a new capitalized sentence.
  return CONTEXTUAL_ABBREV_END.test(prev) && /^\s*[\p{Ll}\p{N}]/u.test(next);
}

function sentencesOf(display: string, folded: string): Sentence[] {
  const seg = new Intl.Segmenter("en", { granularity: "sentence" });
  const spans: [number, number][] = [];
  for (const s of seg.segment(display)) {
    const raw = s.segment;
    const lead = raw.length - raw.trimStart().length;
    const start = s.index + lead;
    const end = s.index + raw.trimEnd().length;
    if (end <= start) continue;
    const prev = spans[spans.length - 1];
    if (
      prev &&
      shouldMergeSentence(
        display.slice(prev[0], prev[1]),
        display.slice(start, end),
      )
    )
      prev[1] = end;
    else spans.push([start, end]);
  }
  return spans.map(([start, end]) => ({
    start,
    end,
    clauses: clausesOf(folded, start, end),
    tokens: tokenize(folded.slice(start, end), start),
  }));
}

function clausesOf(folded: string, start: number, end: number): Clause[] {
  const cuts = new Set<number>([start, end]);
  for (let i = start; i < end; i++) {
    if (";:—()".includes(folded[i])) {
      cuts.add(i);
      cuts.add(i + 1);
    }
  }
  const words = new RegExp(`\\b(?:${CLAUSE_WORDS.join("|")})\\b`, "gu");
  for (const m of folded.slice(start, end).matchAll(words))
    cuts.add(start + (m.index ?? 0));
  const points = [...cuts].sort((a, b) => a - b);
  const out: Clause[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const tokens = tokenize(folded.slice(points[i], points[i + 1]), points[i]);
    if (tokens.length > 0)
      out.push({ start: points[i], end: points[i + 1], tokens });
  }
  return out;
}

/**
 * Stored section text still carries MediaWiki sub-headings ("=== Feeding ===").
 * Each becomes its own subsection titled "Parent / Sub", so the deny policy
 * applies to a "Taxonomy" subsection hiding inside an allowed section, and
 * the marker text itself is never scanned.
 */
function splitSubsections(
  title: string,
  text: string,
): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  const re = /^[ \t]*(={2,6})[ \t]*(.+?)[ \t]*\1[ \t]*$/gm;
  let cursor = 0;
  let current = title;
  for (const m of text.matchAll(re)) {
    out.push({ title: current, text: text.slice(cursor, m.index) });
    current = title ? `${title} / ${m[2]}` : m[2];
    cursor = (m.index ?? 0) + m[0].length;
  }
  out.push({ title: current, text: text.slice(cursor) });
  return out.filter((s) => s.text.trim() !== "");
}

export function segmentArticle(
  article: ArticleInput,
  denyKeywords: readonly string[] = DEFAULT_DENY_KEYWORDS,
): Segmented {
  const raw: { title: string; text: string }[] = [];
  if (article.extract && article.extract.trim())
    raw.push(...splitSubsections("", article.extract));
  for (const s of article.sections)
    raw.push(...splitSubsections(s.title, s.text ?? ""));

  const sections: Section[] = raw.map(({ title, text }) => {
    const display = normalizeDisplay(text);
    const folded = foldCase(display);
    const t = title.toLowerCase();
    const deny = denyKeywords.find((k) => t.includes(k)) ?? null;
    return {
      title,
      allowed: deny === null,
      skipReason: deny === null ? null : `deny:${deny}`,
      display,
      folded,
      sentences: deny === null ? sentencesOf(display, folded) : [],
    };
  });
  return {
    sections,
    textHash: sha256Json(
      sections.map((s) => [normalizeDisplay(s.title), s.display]),
    ),
  };
}
