import { describe, expect, it } from "vitest";
import { DIAGRAMS, parseHash } from "./index";
import { DIAGRAM_ORDER, TERMS, diagramForFamily, linkPartTerms, partHref, type DiagramId, type PartTermSegment } from "./terms";

/** The linked words of one block, as "word→diagram-part". */
function links(text: string, own: DiagramId = "songbird"): string[] {
  return linkPartTerms([text], own)[0]
    .filter((s): s is Extract<PartTermSegment, { part: string }> => s.part !== undefined)
    .map((s) => `${s.text}→${s.diagram}-${s.part}`);
}

describe("part terms (td-e4c6dd)", () => {
  it("lists, for every term, exactly the drawings whose glossary has its part", () => {
    expect(DIAGRAM_ORDER).toEqual(DIAGRAMS.map((d) => d.id));
    for (const t of TERMS) {
      const drawn = DIAGRAMS.filter((d) => d.glossary.some((p) => p.id === t.part)).map((d) => d.id);
      expect(t.drawnIn, t.part).toEqual(drawn);
    }
  });

  it("builds deep links that Parts of a Bird accepts, for every term on every bird", () => {
    const sample: Record<string, string> = {
      supercilium: "supercilium", lores: "lores", "eye-ring": "eye-ring", "eye-line": "eye-line", "ear-coverts": "ear coverts",
      submoustachial: "submoustachial", malar: "malar", "orbital-ring": "orbital ring", "gonydeal-spot": "gonydeal spot",
      gonys: "gonys", scapulars: "scapulars", "lesser-coverts": "lesser coverts", "median-coverts": "median coverts",
      "greater-coverts": "greater coverts", "primary-coverts": "primary coverts", "primary-projection": "primary projection",
      "underwing-coverts": "underwing coverts", "wing-coverts": "wing coverts", alula: "alula", "tertial-crescent": "tertial crescent",
      tertials: "tertials", secondaries: "secondaries", primaries: "primaries", "wing-bars": "wing bars", axillaries: "axillaries",
      speculum: "speculum", "apical-spots": "apical spots", mirrors: "mirrors", "undertail-coverts": "undertail coverts",
      "uppertail-coverts": "uppertail coverts", rectrices: "rectrices", cere: "cere", "patagial-bar": "patagial bar",
      "carpal-patch": "carpal patch", fingers: "fingers", "subterminal-band": "subterminal band", "belly-band": "belly band",
      tarsus: "tarsi",
    };
    expect(Object.keys(sample).sort()).toEqual(TERMS.map((t) => t.part).sort());
    for (const t of TERMS) {
      for (const own of DIAGRAM_ORDER) {
        if (t.onlyFor && !t.onlyFor.includes(own)) continue;
        const [seg] = linkPartTerms([sample[t.part]], own)[0];
        expect(seg.part, `${t.part} on ${own}`).toBe(t.part);
        const href = partHref(seg.diagram!, seg.part!);
        expect(parseHash(href.slice(href.indexOf("#")))).toEqual({ diagram: seg.diagram, part: t.part });
      }
    }
  });

  it("maps families to drawings", () => {
    expect(diagramForFamily("Anatidae")).toBe("duck");
    expect(diagramForFamily("Laridae")).toBe("gull");
    expect(diagramForFamily("Stercorariidae")).toBe("gull");
    for (const f of ["Scolopacidae", "Charadriidae", "Recurvirostridae", "Haematopodidae", "Jacanidae", "Burhinidae", "Glareolidae", "Rostratulidae", "Thinocoridae", "Chionidae", "Dromadidae", "Ibidorhynchidae", "Pluvianellidae", "Pluvianidae", "Pedionomidae"])
      expect(diagramForFamily(f), f).toBe("shorebird");
    expect(diagramForFamily("Parulidae")).toBe("songbird");
    expect(diagramForFamily("Alcidae")).toBe("songbird");
    for (const f of ["Accipitridae", "Falconidae", "Pandionidae", "Cathartidae", "Sagittariidae", "Strigidae", "Tytonidae"])
      expect(diagramForFamily(f), f).toBe("raptor");
    expect(diagramForFamily(null)).toBe("songbird");
  });

  it("matches the spellings production text uses", () => {
    // species_similar buggna→bktgna and buggna→calgna (CODEX1 plan review).
    expect(links("little or no obvious white eye ring")).toEqual(["eye ring→songbird-eye-ring"]);
    expect(links("lacks a bold white eye ring")).toEqual(["eye ring→songbird-eye-ring"]);
    expect(links("a broken Eye-ring")).toEqual(["Eye-ring→songbird-eye-ring"]);
    expect(links("bold eyering")).toEqual(["eyering→songbird-eye-ring"]);
    expect(links("a dark eye stripe")).toEqual(["eye stripe→songbird-eye-line"]);
    expect(links("pale supercilia")).toEqual(["supercilia→songbird-supercilium"]);
    expect(links("a whitish superciliary stripe")).toEqual(["superciliary→songbird-supercilium"]);
    expect(links("loral spots are yellow")).toEqual(["loral→songbird-lores"]);
    expect(links("brown auriculars")).toEqual(["auriculars→songbird-ear-coverts"]);
    expect(links("grey ear-coverts")).toEqual(["ear-coverts→songbird-ear-coverts"]);
    expect(links("a thin malar stripe")).toEqual(["malar stripe→songbird-malar"]);
    expect(links("black under-tail coverts")).toEqual(["under-tail coverts→songbird-undertail-coverts"]);
    expect(links("white uppertail-coverts")).toEqual(["uppertail-coverts→songbird-uppertail-coverts"]);
    expect(links("two whitish wingbars")).toEqual(["wingbars→songbird-wing-bars"]);
    expect(links("chestnut wing linings")).toEqual(["wing linings→songbird-underwing-coverts"]);
    expect(links("outer rectrix")).toEqual(["rectrix→songbird-rectrices"]);
    expect(links("black axillaries")).toEqual(["axillaries→songbird-axillaries"]);
  });

  it("takes the longest phrase at a position", () => {
    expect(links("pale lesser wing-coverts")).toEqual(["lesser wing-coverts→songbird-lesser-coverts"]);
    expect(links("grey lesser upperwing coverts")).toEqual(["lesser upperwing coverts→songbird-lesser-coverts"]);
    expect(links("dark primary coverts")).toEqual(["primary coverts→songbird-primary-coverts"]);
    expect(links("whitish underwing coverts")).toEqual(["underwing coverts→songbird-underwing-coverts"]);
    expect(links("a broad tertial crescent", "gull")).toEqual(["tertial crescent→gull-tertial-crescent"]);
    expect(links("long primary projection", "shorebird")).toEqual(["primary projection→shorebird-primary-projection"]);
    expect(links("a red gonydeal spot", "gull")).toEqual(["gonydeal spot→gull-gonydeal-spot"]);
  });

  it("never links inside a longer or hyphenated word", () => {
    expect(links("White-browed Sparrow")).toEqual([]);
    expect(links("an eye-ringed bird")).toEqual([]);
    expect(links("non-tertials")).toEqual([]);
    expect(links("scapularis")).toEqual([]);
    expect(links("Spectacled Eyebrowed Thrush")).toEqual([]);
  });

  it("never links the everyday parts the owner left out", () => {
    const text =
      "The crown, nape, mantle, back, rump, flanks, sides, breast, belly, throat, chin, cheek, bill, tail, wing, wingtip, legs and vent are plain; scan the crown of the tree.";
    for (const own of DIAGRAM_ORDER) expect(links(text, own)).toEqual([]);
  });

  it("links mirrors only on gull-group pages", () => {
    expect(links("likely behavior mirrors the common paradise kingfisher", "songbird")).toEqual([]);
    expect(links("black wingtips with white mirrors", "gull")).toEqual(["mirrors→gull-mirrors"]);
  });

  it("links the raptor terms production text uses (td-dd4f9c)", () => {
    // Phrases from species_similar notes and Description sections in the test snapshot.
    expect(links("a dark leading-edge patagial mark", "raptor")).toEqual(["patagial mark→raptor-patagial-bar"]);
    expect(links("lacking the pale patagial band", "raptor")).toEqual(["patagial band→raptor-patagial-bar"]);
    expect(links("a bold blackish carpal patch", "raptor")).toEqual(["carpal patch→raptor-carpal-patch"]);
    expect(links("bolder dark carpal commas", "raptor")).toEqual(["carpal commas→raptor-carpal-patch"]);
    expect(links("four (not five) visible primary 'fingers'.", "raptor")).toEqual(["fingers→raptor-fingers"]);
    expect(links("its deep wing emarginations", "raptor")).toEqual(["emarginations→raptor-fingers"]);
    expect(links("a whitish tail with a single black subterminal band", "raptor")).toEqual(["subterminal band→raptor-subterminal-band"]);
    expect(links("bright orange-red cere, eye-ring and feet", "raptor")).toEqual(["cere→raptor-cere", "eye-ring→songbird-eye-ring"]);
    expect(links("Feathered tarsi", "raptor")).toEqual(["tarsi→raptor-tarsus"]);
    expect(links("a distinctive dark belly band", "raptor")).toEqual(["belly band→raptor-belly-band"]);
    // Shared words go to the hawk on a raptor's page.
    expect(links("pale primaries and a dark malar", "raptor")).toEqual(["primaries→raptor-primaries", "malar→raptor-malar"]);
  });

  it("links the raptor-only words only on raptor and owl pages", () => {
    // A tern's upperwing carpal bar, a gull's bill band and a hoatzin's finger claws are other things.
    expect(links("in winter it has a dark carpal bar", "gull")).toEqual([]);
    expect(links("a dark red bill with a dark subterminal band", "gull")).toEqual([]);
    expect(links("the dinosaurian finger claws and fingers", "songbird")).toEqual([]);
    // Words every bird shares still link from any page, to the hawk that draws them.
    expect(links("a dark bill with a white cere", "songbird")).toEqual(["cere→raptor-cere"]);
    expect(links("bare (unfeathered) on the tarsi", "songbird")).toEqual(["tarsi→raptor-tarsus"]);
    expect(links("a rufous belly band", "songbird")).toEqual(["belly band→raptor-belly-band"]);
  });

  it("uses the bird's own drawing when it has the part, otherwise the first that does", () => {
    expect(links("a blue speculum", "duck")).toEqual(["speculum→duck-speculum"]);
    expect(links("a blue speculum", "songbird")).toEqual(["speculum→duck-speculum"]);
    expect(links("two wing bars", "duck")).toEqual(["wing bars→songbird-wing-bars"]);
    expect(links("pale wing coverts", "gull")).toEqual(["wing coverts→shorebird-wing-coverts"]);
    expect(links("white-tipped tertials", "gull")).toEqual(["tertials→gull-tertials"]);
  });

  it("links a part at its first mention across the blocks of one call, keeping case and text", () => {
    const [a, b] = linkPartTerms(["Tertials edged buff; the tertial tips wear.", "Tertials again, and a pale supercilium."], "songbird");
    expect(a).toEqual([
      { text: "Tertials", diagram: "songbird", part: "tertials" },
      { text: " edged buff; the tertial tips wear." },
    ]);
    expect(b).toEqual([
      { text: "Tertials again, and a pale " },
      { text: "supercilium", diagram: "songbird", part: "supercilium" },
      { text: "." },
    ]);
    // Separate calls (two notes) each link their own first mention.
    expect(linkPartTerms(["a pale supercilium"], "songbird")[0][1].part).toBe("supercilium");
    expect(linkPartTerms(["a pale supercilium"], "songbird")[0][1].part).toBe("supercilium");
  });

  it("returns the text unchanged when nothing matches, and handles empty text", () => {
    expect(linkPartTerms(["Voice differs."], "songbird")).toEqual([[{ text: "Voice differs." }]]);
    expect(linkPartTerms([""], "songbird")).toEqual([[]]);
  });
});
