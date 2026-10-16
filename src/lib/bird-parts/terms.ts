/**
 * Links technical bird-part words in species-page text to the part on Parts of a Bird (td-e4c6dd,
 * plan: docs/2026-10-16-part-term-links-plan-CC.md). Owner decisions: technical terms only (never
 * crown, back, breast, wing…); a part the bird's own drawing lacks links to a drawing that has it;
 * each part is linked at its first mention per note or per Description section.
 *
 * Kept free of the drawings (index.ts pulls in every geometry file): each term lists the drawings
 * that have its part, and bird-parts.test.ts checks those lists against the real glossaries.
 */

export type DiagramId = "songbird" | "shorebird" | "duck" | "gull";

/** Fallback order when the bird's own drawing lacks a part: the order of the Parts of a Bird page. */
export const DIAGRAM_ORDER: readonly DiagramId[] = ["songbird", "shorebird", "duck", "gull"];

const SHOREBIRD_FAMILIES = new Set([
  "Scolopacidae",
  "Charadriidae",
  "Recurvirostridae",
  "Haematopodidae",
  "Jacanidae",
  "Burhinidae",
  "Glareolidae",
  "Rostratulidae",
  "Thinocoridae",
  "Chionidae",
  "Dromadidae",
  "Ibidorhynchidae",
  "Pluvianellidae",
  "Pluvianidae",
  "Pedionomidae",
]);

/** The drawing a species' links prefer, by scientific family name. Everything else is the songbird. */
export function diagramForFamily(familySciName: string | null | undefined): DiagramId {
  if (familySciName === "Anatidae") return "duck";
  if (familySciName === "Laridae" || familySciName === "Stercorariidae") return "gull";
  if (familySciName && SHOREBIRD_FAMILIES.has(familySciName)) return "shorebird";
  return "songbird";
}

export interface PartTerm {
  part: string;
  /** Every spelling, as regex source: hyphen, space and closed-up forms, singular and plural. */
  forms: string[];
  /** Drawings whose glossary has this part, in DIAGRAM_ORDER (checked by test). */
  drawnIn: DiagramId[];
  /** Only linked on these birds' pages ("behavior mirrors the…" on a kingfisher is not a gull's mirror). */
  onlyFor?: DiagramId[];
}

const ALL: DiagramId[] = ["songbird", "shorebird", "duck", "gull"];
const COVERTS = "[- ]coverts";

/**
 * Longer phrases come before shorter ones that share their start ("tertial crescent" before
 * "tertial"): at one position the regex takes the first alternative that matches.
 */
export const TERMS: PartTerm[] = [
  { part: "supercilium", forms: ["supercilium", "supercilia", "superciliums", "superciliary", "eyebrows?"], drawnIn: ["songbird", "shorebird"] },
  { part: "lores", forms: ["lores", "loral"], drawnIn: ["songbird", "shorebird", "gull"] },
  { part: "eye-ring", forms: ["eye[- ]?rings?"], drawnIn: ["songbird", "shorebird"] },
  { part: "eye-line", forms: ["eye[- ]?lines?", "eye[- ]?stripes?"], drawnIn: ["songbird"] },
  { part: "ear-coverts", forms: [`ear${COVERTS}`, "auriculars?"], drawnIn: ["songbird", "shorebird", "gull"] },
  { part: "submoustachial", forms: ["submoustachial(?: stripes?)?"], drawnIn: ["songbird"] },
  { part: "malar", forms: ["malar(?: stripes?)?"], drawnIn: ["songbird"] },
  { part: "orbital-ring", forms: ["orbital[- ]rings?"], drawnIn: ["gull"] },
  { part: "gonydeal-spot", forms: ["gonydeal spots?"], drawnIn: ["gull"] },
  { part: "gonys", forms: ["gonys"], drawnIn: ["gull"] },
  { part: "scapulars", forms: ["scapulars?"], drawnIn: ALL },
  { part: "lesser-coverts", forms: [`lesser(?: upper)?(?:[- ]?wing)?${COVERTS}`], drawnIn: ALL },
  { part: "median-coverts", forms: [`median(?: upper)?(?:[- ]?wing)?${COVERTS}`], drawnIn: ["songbird", "shorebird", "duck", "gull"] },
  { part: "greater-coverts", forms: [`greater(?: upper)?(?:[- ]?wing)?${COVERTS}`], drawnIn: ["songbird", "shorebird", "duck", "gull"] },
  { part: "primary-coverts", forms: [`primary${COVERTS}`], drawnIn: ALL },
  { part: "primary-projection", forms: ["primary projections?"], drawnIn: ["shorebird"] },
  { part: "underwing-coverts", forms: [`under[- ]?wing${COVERTS}`, "wing[- ]linings?"], drawnIn: ALL },
  { part: "wing-coverts", forms: [`upper[- ]?wing${COVERTS}`, `wing${COVERTS}`], drawnIn: ["shorebird", "duck"] },
  { part: "alula", forms: ["alulae?"], drawnIn: ALL },
  { part: "tertial-crescent", forms: ["tertial crescents?"], drawnIn: ["gull"] },
  { part: "tertials", forms: ["tertials?"], drawnIn: ALL },
  { part: "secondaries", forms: ["secondaries"], drawnIn: ALL },
  { part: "primaries", forms: ["primaries"], drawnIn: ALL },
  { part: "wing-bars", forms: ["wing[- ]?bars?"], drawnIn: ["songbird"] },
  { part: "axillaries", forms: ["axillaries", "axillars", "axillary"], drawnIn: ALL },
  { part: "speculum", forms: ["speculum", "speculums", "specula"], drawnIn: ["duck"] },
  { part: "apical-spots", forms: ["apical spots?"], drawnIn: ["gull"] },
  { part: "mirrors", forms: ["mirrors?"], drawnIn: ["gull"], onlyFor: ["gull"] },
  { part: "undertail-coverts", forms: [`under[- ]?tail${COVERTS}`], drawnIn: ALL },
  { part: "uppertail-coverts", forms: [`upper[- ]?tail${COVERTS}`], drawnIn: ["songbird", "shorebird", "gull"] },
  { part: "rectrices", forms: ["rectrices", "rectrix"], drawnIn: ["songbird"] },
];

/**
 * Whole words only: never part of a longer word or a hyphenated one ("White-browed", "eye-ringed").
 * The end is a lookahead; the start is checked by hand (no lookbehind, for older Safari).
 */
const TERM_RE = new RegExp(`(?:${TERMS.map((t, i) => `(?<t${i}>${t.forms.join("|")})`).join("|")})(?![\\p{L}\\p{N}_-])`, "giu");
const WORD_CHAR = /[\p{L}\p{N}_-]/u;

/** The bird's own drawing if it has the part, else the first drawing that does. */
export function partDiagram(term: PartTerm, own: DiagramId): DiagramId {
  return term.drawnIn.includes(own) ? own : term.drawnIn[0];
}

export type PartTermSegment = { text: string; diagram?: undefined; part?: undefined } | { text: string; diagram: DiagramId; part: string };

/**
 * Splits text blocks into plain and linked segments. A part is linked only at its first mention
 * across all the blocks of one call (one call = one note, or one Description section).
 */
export function linkPartTerms(blocks: string[], own: DiagramId): PartTermSegment[][] {
  const seen = new Set<string>();
  return blocks.map((text) => {
    const out: PartTermSegment[] = [];
    let last = 0;
    TERM_RE.lastIndex = 0;
    for (let m = TERM_RE.exec(text); m; m = TERM_RE.exec(text)) {
      if (m.index > 0 && WORD_CHAR.test(text[m.index - 1])) {
        TERM_RE.lastIndex = m.index + 1;
        continue;
      }
      const key = Object.keys(m.groups!).find((k) => m!.groups![k] !== undefined)!;
      const term = TERMS[Number(key.slice(1))];
      if ((term.onlyFor && !term.onlyFor.includes(own)) || seen.has(term.part)) continue;
      seen.add(term.part);
      if (m.index > last) out.push({ text: text.slice(last, m.index) });
      out.push({ text: m[0], diagram: partDiagram(term, own), part: term.part });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  });
}

export function partHref(diagram: DiagramId, part: string): string {
  return `/parts-of-a-bird#${diagram}-${part}`;
}
