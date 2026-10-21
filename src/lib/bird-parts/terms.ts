/**
 * Links technical bird-part words in species-page text to the part on Parts of a Bird (td-e4c6dd,
 * plan: docs/2026-10-16-part-term-links-plan-CC.md). Owner decisions: technical terms only (never
 * crown, back, breast, wing…); a part the bird's own drawing lacks links to a drawing that has it;
 * each part is linked at its first mention per note or per Description section.
 *
 * Kept free of the drawings (index.ts pulls in every geometry file): each term lists the drawings
 * that have its part, and bird-parts.test.ts checks those lists against the real glossaries.
 */

export type DiagramId =
  | "songbird" | "shorebird" | "duck" | "gull" | "raptor" | "heron" | "cormorant" | "auk" | "tubenose"
  | "woodpecker" | "hummingbird" | "gamebird" | "loon" | "grebe";

/** Fallback order when the bird's own drawing lacks a part: the order of the Parts of a Bird page. */
export const DIAGRAM_ORDER: readonly DiagramId[] = [
  "songbird", "shorebird", "duck", "gull", "raptor", "heron", "cormorant", "auk", "tubenose", "woodpecker", "hummingbird", "gamebird", "loon", "grebe",
];

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

/** Hawks, eagles, kites, harriers, falcons, the Osprey, vultures, the Secretarybird, and owls (td-dd4f9c). */
const RAPTOR_FAMILIES = new Set([
  "Accipitridae",
  "Falconidae",
  "Pandionidae",
  "Cathartidae",
  "Sagittariidae",
  "Strigidae",
  "Tytonidae",
]);

/** Herons, egrets and bitterns, and the other long-legged waders: storks, ibises and spoonbills, cranes, the Limpkin, the Shoebill and the Hamerkop (td-46e6e3). */
const HERON_FAMILIES = new Set([
  "Ardeidae",
  "Ciconiidae",
  "Threskiornithidae",
  "Gruidae",
  "Aramidae",
  "Balaenicipitidae",
  "Scopidae",
]);

/**
 * Cormorants and shags, the Anhinga, gannets and boobies, frigatebirds and pelicans (td-af7c6b). Tropicbirds share
 * the webbed feet but are built like terns, so they stay with the default drawing.
 */
const CORMORANT_FAMILIES = new Set(["Phalacrocoracidae", "Anhingidae", "Sulidae", "Fregatidae", "Pelecanidae"]);

/** Albatrosses, shearwaters, petrels and fulmars, and the storm-petrels of both hemispheres (td-315613). */
const TUBENOSE_FAMILIES = new Set(["Diomedeidae", "Procellariidae", "Hydrobatidae", "Oceanitidae"]);

/** Woodpeckers, and the rest of their order: barbets, toucans, honeyguides, jacamars and puffbirds (td-71bf41). */
const WOODPECKER_FAMILIES = new Set([
  "Picidae",
  "Lybiidae",
  "Megalaimidae",
  "Capitonidae",
  "Semnornithidae",
  "Ramphastidae",
  "Indicatoridae",
  "Galbulidae",
  "Bucconidae",
]);

/** Hummingbirds, and the swifts and treeswifts that share their order (td-725e4c). */
const HUMMINGBIRD_FAMILIES = new Set(["Trochilidae", "Apodidae", "Hemiprocnidae"]);

/** Grouse, ptarmigan, pheasants, partridges, turkeys, New World quail, guineafowl, curassows and guans, and megapodes (td-71be07). */
const GAMEBIRD_FAMILIES = new Set(["Phasianidae", "Odontophoridae", "Numididae", "Cracidae", "Megapodiidae"]);

/** The drawing a species' links prefer, by scientific family name. Everything else is the songbird. */
export function diagramForFamily(familySciName: string | null | undefined): DiagramId {
  if (familySciName === "Anatidae") return "duck";
  if (familySciName && RAPTOR_FAMILIES.has(familySciName)) return "raptor";
  if (familySciName && HERON_FAMILIES.has(familySciName)) return "heron";
  if (familySciName && CORMORANT_FAMILIES.has(familySciName)) return "cormorant";
  // Murres, the Razorbill, guillemots, puffins, auklets and murrelets (td-5076e6).
  if (familySciName === "Alcidae") return "auk";
  if (familySciName && TUBENOSE_FAMILIES.has(familySciName)) return "tubenose";
  if (familySciName && WOODPECKER_FAMILIES.has(familySciName)) return "woodpecker";
  if (familySciName && HUMMINGBIRD_FAMILIES.has(familySciName)) return "hummingbird";
  if (familySciName && GAMEBIRD_FAMILIES.has(familySciName)) return "gamebird";
  // Loons (divers, td-a3a17d) and grebes (td-7adea3).
  if (familySciName === "Gaviidae") return "loon";
  if (familySciName === "Podicipedidae") return "grebe";
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
  /**
   * The same part under another name on a drawing that lacks this id (the songbird's "legs" for the tarsus), so a
   * bird's link stays on its own drawing (td-d32fd3). Checked by test against the real glossaries.
   */
  sameAs?: Partial<Record<DiagramId, string>>;
}

const ALL: DiagramId[] = [...DIAGRAM_ORDER];
/** The hummingbird's wing has no alula, and its scapulars and tertials are not drawn. */
const NOT_HUMMINGBIRD: DiagramId[] = ALL.filter((d) => d !== "hummingbird");
const COVERTS = "[- ]coverts";

/**
 * Longer phrases come before shorter ones that share their start ("tertial crescent" before
 * "tertial"): at one position the regex takes the first alternative that matches.
 */
export const TERMS: PartTerm[] = [
  { part: "supercilium", forms: ["supercilium", "supercilia", "superciliums", "superciliary", "eyebrows?(?![- ]?combs?)"], drawnIn: ALL },
  { part: "lores", forms: ["lores", "loral"], drawnIn: ALL },
  { part: "eye-ring", forms: ["eye[- ]?rings?"], drawnIn: ALL },
  { part: "eye-line", forms: ["eye[- ]?lines?", "eye[- ]?stripes?"], drawnIn: ALL },
  // The duck's "cheek" is its ear-covert area (td-93f86b).
  { part: "ear-coverts", forms: [`ear${COVERTS}`, "auriculars?"], drawnIn: ALL.filter((d) => d !== "duck"), sameAs: { duck: "cheek" } },
  { part: "submoustachial", forms: ["submoustachial(?: stripes?)?"], drawnIn: ["songbird", "woodpecker"] },
  { part: "malar", forms: ["malar(?: stripes?)?"], drawnIn: ALL },
  { part: "cere", forms: ["ceres?"], drawnIn: ["raptor"] },
  { part: "orbital-ring", forms: ["orbital[- ]rings?"], drawnIn: ["gull"] },
  { part: "gonydeal-spot", forms: ["gonydeal spots?"], drawnIn: ["gull"] },
  { part: "gonys", forms: ["gonys"], drawnIn: ["gull"] },
  { part: "scapulars", forms: ["scapulars?"], drawnIn: NOT_HUMMINGBIRD },
  { part: "lesser-coverts", forms: [`lesser(?: upper)?(?:[- ]?wing)?${COVERTS}`], drawnIn: ALL },
  { part: "median-coverts", forms: [`median(?: upper)?(?:[- ]?wing)?${COVERTS}`], drawnIn: ALL },
  { part: "greater-coverts", forms: [`greater(?: upper)?(?:[- ]?wing)?${COVERTS}`], drawnIn: ALL },
  { part: "primary-coverts", forms: [`primary${COVERTS}`], drawnIn: ALL },
  { part: "primary-projection", forms: ["primary projections?"], drawnIn: ["shorebird"] },
  { part: "underwing-coverts", forms: [`under[- ]?wing${COVERTS}`, "wing[- ]linings?"], drawnIn: ALL },
  { part: "wing-coverts", forms: [`upper[- ]?wing${COVERTS}`, `wing${COVERTS}`], drawnIn: ALL },
  { part: "patagial-bar", forms: ["patagial(?: (?:bars?|marks?|bands?|patch(?:es)?|stripes?))?", "patagium", "patagia"], drawnIn: ["raptor"] },
  // "carpal bar" on a tern's upperwing is another mark, so only raptors' (and owls') pages link it.
  { part: "carpal-patch", forms: ["carpal (?:patch(?:es)?|bars?|marks?|crescents?|commas?|spots?)"], drawnIn: ["raptor"], onlyFor: ["raptor"] },
  { part: "alula", forms: ["alulae?"], drawnIn: NOT_HUMMINGBIRD },
  { part: "tertial-crescent", forms: ["tertial crescents?"], drawnIn: ["gull"] },
  { part: "tertials", forms: ["tertials?"], drawnIn: NOT_HUMMINGBIRD },
  { part: "secondaries", forms: ["secondaries"], drawnIn: ALL },
  // "fingers" is ordinary English elsewhere ("finger claws"), so only raptors' (and owls') pages link it.
  { part: "fingers", forms: ["emarginated primaries", "emarginations?", "emarginated", "emarginate", "(?:primary )?fingers?"], drawnIn: ["raptor"], onlyFor: ["raptor"] },
  { part: "primaries", forms: ["primaries"], drawnIn: ALL },
  { part: "wing-bars", forms: ["wing[- ]?bars?"], drawnIn: ["songbird"] },
  { part: "axillaries", forms: ["axillaries", "axillars", "axillary"], drawnIn: ALL },
  { part: "speculum", forms: ["speculum", "speculums", "specula"], drawnIn: ["duck"] },
  { part: "apical-spots", forms: ["apical spots?"], drawnIn: ["gull"] },
  { part: "mirrors", forms: ["mirrors?"], drawnIn: ["gull"], onlyFor: ["gull"] },
  { part: "undertail-coverts", forms: [`under[- ]?tail${COVERTS}`], drawnIn: ALL },
  { part: "uppertail-coverts", forms: [`upper[- ]?tail${COVERTS}`], drawnIn: ALL.filter((d) => d !== "grebe") },
  // A gull's or tern's bill has a "subterminal band" too, so only raptors' and gamebirds' pages link it.
  { part: "subterminal-band", forms: ["subterminal (?:tail )?bands?"], drawnIn: ["raptor", "gamebird"], onlyFor: ["raptor", "gamebird"] },
  { part: "belly-band", forms: ["belly[- ]?bands?"], drawnIn: ["raptor"] },
  {
    part: "tarsus",
    forms: ["tarsus", "tarsi"],
    drawnIn: ["raptor", "heron", "cormorant", "auk", "woodpecker", "gamebird", "loon", "grebe"],
    sameAs: { songbird: "legs", shorebird: "legs", duck: "legs", gull: "legs", hummingbird: "toes" },
  },
  { part: "tibia", forms: ["tibiae?", "tibias"], drawnIn: ["heron"] },
  // Common on other birds and close to the everyday "neck" and "plumes", so only the heron group's pages link them.
  { part: "foreneck", forms: ["fore[- ]?necks?"], drawnIn: ["heron"], onlyFor: ["heron"] },
  { part: "hindneck", forms: ["hind[- ]?necks?"], drawnIn: ["heron"], onlyFor: ["heron"] },
  { part: "head-plumes", forms: ["(?:head|nuchal|occipital) plumes?"], drawnIn: ["heron"], onlyFor: ["heron"] },
  // Storks, cranes, gamebirds and hummingbirds use "gular" and "throat pouch" for other throat marks, and a heron's
  // toes are not webbed, so only the cormorant group's pages link these.
  { part: "gular-skin", forms: ["gular(?: (?:pouch(?:es)?|skin|sacs?|patch(?:es)?))?", "throat[- ](?:pouch(?:es)?|sacs?)", "pouch(?:es)?"], drawnIn: ["cormorant"], onlyFor: ["cormorant"] },
  // Parrots, cuckoos and owls have zygodactyl feet too, but only the woodpecker drawing shows them.
  {
    part: "toes",
    forms: ["totipalmate(?: feet| foot)?", "zygodactyl(?: feet| foot| toes)?"],
    drawnIn: ["heron", "cormorant", "auk", "woodpecker", "hummingbird", "gamebird", "loon", "grebe"],
    onlyFor: ["cormorant", "woodpecker"],
  },
  // "nasal" alone is a call ("nasal kip"); only the tube words, and only on tubenose pages.
  { part: "nostril-tubes", forms: ["naricorns?", "nasal tubes?", "tubular nostrils?", "tube[- ]?nosed?"], drawnIn: ["tubenose"], onlyFor: ["tubenose"] },
  // Woodpeckers (td-71bf41). "Nape patch" is also a tit's white patch, so only woodpecker pages link it; the nasal
  // tufts of birds-of-paradise are the same feathers.
  { part: "nasal-tufts", forms: ["nasal[- ]tufts?"], drawnIn: ["woodpecker"] },
  { part: "nape-patch", forms: ["(?:nape|nuchal) (?:patch(?:es)?|spots?)"], drawnIn: ["woodpecker"], onlyFor: ["woodpecker"] },
  // Hummingbirds and swifts (td-725e4c). A partridge's or bee-eater's "gorget" is another throat mark, and a sparrow's
  // postocular stripe another face mark.
  { part: "gorget", forms: ["gorgets?"], drawnIn: ["hummingbird"], onlyFor: ["hummingbird"] },
  { part: "post-ocular-spot", forms: ["post[- ]?ocular(?: (?:spots?|stripes?|streaks?|lines?|patch(?:es)?))?"], drawnIn: ["hummingbird"], onlyFor: ["hummingbird"] },
  // Gamebirds (td-71be07). The drawn comb is the grouse's bare skin over the eye; a junglefowl's or pheasant's bare
  // "comb" is on top of the head (CODEX1), so only the eye words link (the supercilium's "eyebrow" stops short of
  // "eyebrow comb"). "Ruff" also names a sandpiper and a cowbird's neck feathers, and "crest" is an everyday word, so
  // only the quail's "topknot" stands for the crest.
  { part: "comb", forms: ["eye(?:brow)?[- ]?combs?"], drawnIn: ["gamebird"], onlyFor: ["gamebird"] },
  { part: "ruff", forms: ["(?:neck[- ])?ruffs?"], drawnIn: ["gamebird"], onlyFor: ["gamebird"] },
  { part: "crest", forms: ["top[- ]?knots?"], drawnIn: ["gamebird"], onlyFor: ["gamebird"] },
  // Grebes (td-7adea3): owls have "ear tufts" and many birds "horns".
  { part: "ear-tufts", forms: ["ear[- ]?tufts?", "ear[- ]?plumes?", "ear[- ]?fans?", "horns"], drawnIn: ["grebe"], onlyFor: ["grebe"] },
  // The tail feathers: every drawing but the songbird's (and the grebe's, which has almost no tail) draws them as the tail.
  {
    part: "rectrices",
    forms: ["rectrices", "rectrix"],
    drawnIn: ["songbird"],
    sameAs: Object.fromEntries(ALL.filter((d) => d !== "songbird" && d !== "grebe").map((d) => [d, "tail"])),
  },
];

/**
 * Whole words only: never part of a longer word or a hyphenated one ("White-browed", "eye-ringed").
 * The end is a lookahead; the start is checked by hand (no lookbehind, for older Safari).
 */
const TERM_RE = new RegExp(`(?:${TERMS.map((t, i) => `(?<t${i}>${t.forms.join("|")})`).join("|")})(?![\\p{L}\\p{N}_-])`, "giu");
const WORD_CHAR = /[\p{L}\p{N}_-]/u;

/** The bird's own drawing if it has the part (under its own id or another), else the first drawing that does. */
export function partTarget(term: PartTerm, own: DiagramId): { diagram: DiagramId; part: string } {
  if (term.drawnIn.includes(own)) return { diagram: own, part: term.part };
  const same = term.sameAs?.[own];
  return same ? { diagram: own, part: same } : { diagram: term.drawnIn[0], part: term.part };
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
      out.push({ text: m[0], ...partTarget(term, own) });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  });
}

export function partHref(diagram: DiagramId, part: string): string {
  return `/parts-of-a-bird#${diagram}-${part}`;
}
