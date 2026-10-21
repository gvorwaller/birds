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

  it("names, for each drawing a term borrows a name on, a part that drawing really has and lacks under the term's id", () => {
    for (const t of TERMS) {
      for (const [d, part] of Object.entries(t.sameAs ?? {})) {
        expect(t.drawnIn, `${t.part} on ${d}`).not.toContain(d);
        expect(DIAGRAMS.find((x) => x.id === d)!.glossary.some((p) => p.id === part), `${t.part} → ${d}/${part}`).toBe(true);
      }
    }
  });

  it("keeps the head and rump areas on every bird's own drawing (td-93f86b)", () => {
    // The owner's example: ear coverts in a Black-faced Cormorant's description opened the songbird.
    expect(links("dark ear coverts and a dark face", "cormorant")).toEqual(["ear coverts→cormorant-ear-coverts"]);
    for (const own of DIAGRAM_ORDER) {
      for (const [text, part] of [["supercilium", "supercilium"], ["lores", "lores"], ["eye-ring", "eye-ring"], ["eye-line", "eye-line"], ["malar", "malar"]]) {
        expect(links(text, own), `${text} on ${own}`).toEqual([`${text}→${own}-${part}`]);
      }
      if (own !== "duck") expect(links("ear coverts", own)).toEqual([`ear coverts→${own}-ear-coverts`]);
      if (own !== "grebe") expect(links("uppertail coverts", own)).toEqual([`uppertail coverts→${own}-uppertail-coverts`]);
    }
    expect(links("ear coverts", "duck")).toEqual(["ear coverts→duck-cheek"]);
    expect(links("pale tarsi", "duck")).toEqual(["tarsi→duck-legs"]);
    expect(links("pale tarsi", "gull")).toEqual(["tarsi→gull-legs"]);
    expect(links("pale tarsi", "shorebird")).toEqual(["tarsi→shorebird-legs"]);
    expect(links("pale tarsi", "hummingbird")).toEqual(["tarsi→hummingbird-toes"]);
  });

  it("keeps the songbird's legs and every bird's own tail for tarsus and rectrices (td-d32fd3)", () => {
    expect(links("pale pinkish tarsi and toes", "songbird")).toEqual(["tarsi→songbird-legs"]);
    expect(links("bare tarsi are red", "auk")).toEqual(["tarsi→auk-tarsus"]);
    expect(links("the outer rectrices are white", "duck")).toEqual(["rectrices→duck-tail"]);
    expect(links("the outer rectrices are white", "raptor")).toEqual(["rectrices→raptor-tail"]);
    expect(links("white outer rectrices", "songbird")).toEqual(["rectrices→songbird-rectrices"]);
    // A grebe has almost no tail: its page still opens the songbird's tail feathers.
    expect(links("rectrices", "grebe")).toEqual(["rectrices→songbird-rectrices"]);
    // The songbird's own covert area, where "wing coverts" used to open the shorebird.
    expect(links("brownish wing coverts with buff edges", "songbird")).toEqual(["wing coverts→songbird-wing-coverts"]);
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
      tarsus: "tarsi", tibia: "tibia", foreneck: "foreneck", hindneck: "hindneck", "head-plumes": "head plumes",
      "gular-skin": "gular pouch", toes: "totipalmate", "nostril-tubes": "naricorns", "nasal-tufts": "nasal tufts",
      "nape-patch": "nape patch", gorget: "gorget", "post-ocular-spot": "postocular spot", comb: "eye-comb", ruff: "ruff", crest: "topknot",
      "ear-tufts": "ear tufts",
    };
    expect(Object.keys(sample).sort()).toEqual(TERMS.map((t) => t.part).sort());
    for (const t of TERMS) {
      for (const own of DIAGRAM_ORDER) {
        if (t.onlyFor && !t.onlyFor.includes(own)) continue;
        const [seg] = linkPartTerms([sample[t.part]], own)[0];
        const part = t.drawnIn.includes(own) ? t.part : (t.sameAs?.[own] ?? t.part);
        expect(seg.part, `${t.part} on ${own}`).toBe(part);
        const href = partHref(seg.diagram!, seg.part!);
        expect(parseHash(href.slice(href.indexOf("#")))).toEqual({ diagram: seg.diagram, part });
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
    expect(diagramForFamily("Alcidae")).toBe("auk");
    for (const f of ["Accipitridae", "Falconidae", "Pandionidae", "Cathartidae", "Sagittariidae", "Strigidae", "Tytonidae"])
      expect(diagramForFamily(f), f).toBe("raptor");
    for (const f of ["Ardeidae", "Ciconiidae", "Threskiornithidae", "Gruidae", "Aramidae", "Balaenicipitidae", "Scopidae"])
      expect(diagramForFamily(f), f).toBe("heron");
    for (const f of ["Phalacrocoracidae", "Anhingidae", "Sulidae", "Fregatidae", "Pelecanidae"])
      expect(diagramForFamily(f), f).toBe("cormorant");
    // Tropicbirds have the same webbed feet but a tern's build.
    expect(diagramForFamily("Phaethontidae")).toBe("songbird");
    for (const f of ["Diomedeidae", "Procellariidae", "Hydrobatidae", "Oceanitidae"]) expect(diagramForFamily(f), f).toBe("tubenose");
    for (const f of ["Picidae", "Lybiidae", "Megalaimidae", "Capitonidae", "Semnornithidae", "Ramphastidae", "Indicatoridae", "Galbulidae", "Bucconidae"])
      expect(diagramForFamily(f), f).toBe("woodpecker");
    for (const f of ["Trochilidae", "Apodidae", "Hemiprocnidae"]) expect(diagramForFamily(f), f).toBe("hummingbird");
    for (const f of ["Phasianidae", "Odontophoridae", "Numididae", "Cracidae", "Megapodiidae"]) expect(diagramForFamily(f), f).toBe("gamebird");
    expect(diagramForFamily("Gaviidae")).toBe("loon");
    expect(diagramForFamily("Podicipedidae")).toBe("grebe");
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
    expect(links("bright orange-red cere, eye-ring and feet", "raptor")).toEqual(["cere→raptor-cere", "eye-ring→raptor-eye-ring"]);
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
    // The songbird draws the tarsus as its "legs" (td-d32fd3).
    expect(links("bare (unfeathered) on the tarsi", "songbird")).toEqual(["tarsi→songbird-legs"]);
    expect(links("a rufous belly band", "songbird")).toEqual(["belly band→raptor-belly-band"]);
  });

  it("links the heron terms production text uses, the neck words only on heron-group pages (td-46e6e3)", () => {
    // Phrases from species_similar notes and Description sections in the test snapshot.
    expect(links("Greater Adjutant's upper shank (tibia) is pinkish", "heron")).toEqual(["tibia→heron-tibia"]);
    expect(links("a dull red tibia", "shorebird")).toEqual(["tibia→heron-tibia"]);
    expect(links("a black face and foreneck with a broad white stripe", "heron")).toEqual(["foreneck→heron-foreneck"]);
    expect(links("contrasting with dark crown and hindneck", "heron")).toEqual(["hindneck→heron-hindneck"]);
    expect(links("fine head plumes and back aigrettes", "heron")).toEqual(["head plumes→heron-head-plumes"]);
    expect(links("yellow lores between a black bill and the eye", "heron")).toEqual(["lores→heron-lores"]);
    // Stilts and grebes use the neck words too; there they stay plain text.
    expect(links("a clean black hindneck collar", "shorebird")).toEqual([]);
    expect(links("a clean white face and foreneck", "songbird")).toEqual([]);
    // The heron's own drawing for the shared wing words.
    expect(links("slaty primaries and secondaries", "heron")).toEqual(["primaries→heron-primaries", "secondaries→heron-secondaries"]);
  });

  it("links the tube words production text uses, only on tubenose pages (td-315613)", () => {
    expect(links("a stouter, gull-like bill with tubular nostrils on top", "tubenose")).toEqual(["tubular nostrils→tubenose-nostril-tubes"]);
    expect(links("pink with a black tip and dark bluish naricorns", "tubenose")).toEqual(["naricorns→tubenose-nostril-tubes"]);
    expect(links("the nasal tube on top of the bill is long", "tubenose")).toEqual(["nasal tube→tubenose-nostril-tubes"]);
    expect(links("the fulmar's thick tubenose bill and stiff flight", "tubenose")).toEqual(["tubenose→tubenose-nostril-tubes"]);
    expect(links("Like other tube-nosed seabirds", "tubenose")).toEqual(["tube-nosed→tubenose-nostril-tubes"]);
    // The group name and a nasal call are not the part.
    expect(links("Moult is prolonged in all tubenoses", "tubenose")).toEqual([]);
    expect(links("a nasal call", "tubenose")).toEqual([]);
    expect(links("tubular nostrils", "gull")).toEqual([]);
    expect(links("silvery underwing coverts and dark primaries", "tubenose")).toEqual(["underwing coverts→tubenose-underwing-coverts", "primaries→tubenose-primaries"]);
  });

  it("links the woodpecker, hummingbird, gamebird, loon and grebe terms on their own pages only (td-56a506)", () => {
    // Phrases from species_similar notes and Description sections in the test snapshot.
    expect(links("They have zygodactyl feet, where the two toes facing forward", "woodpecker")).toEqual(["zygodactyl feet→woodpecker-toes"]);
    expect(links("a pale yellowish nasal tuft and red-and-white barred", "woodpecker")).toEqual(["nasal tuft→woodpecker-nasal-tufts"]);
    expect(links("the male's red nape patch is split", "woodpecker")).toEqual(["nape patch→woodpecker-nape-patch"]);
    expect(links("a ruby-red (not violet) gorget and no black chin band", "hummingbird")).toEqual(["gorget→hummingbird-gorget"]);
    expect(links("gray-bellied with a white postocular stripe", "hummingbird")).toEqual(["postocular stripe→hummingbird-post-ocular-spot"]);
    expect(links("a black bib and red eye-comb; the tail is blackish", "gamebird")).toEqual(["eye-comb→gamebird-comb"]);
    expect(links("a black ruff on the neck sides", "gamebird")).toEqual(["ruff→gamebird-ruff"]);
    expect(links("a forward-curving teardrop-shaped topknot", "gamebird")).toEqual(["topknot→gamebird-crest"]);
    expect(links("barred tail with a single broad dark subterminal band", "gamebird")).toEqual(["subterminal band→gamebird-subterminal-band"]);
    expect(links("males show a red eye comb but lack the yellow throat sac", "gamebird")).toEqual(["eye comb→gamebird-comb"]);
    expect(links("a throat/neck air sac and yellow eyebrow comb", "gamebird")).toEqual(["eyebrow comb→gamebird-comb"]);
    // A junglefowl's comb is on top of its head, not the grouse's eye comb (CODEX1); a loon's "necklace" is either the
    // neck-side collar or the throat streaks, so it is not linked.
    expect(links("Red Junglefowl males show a bright red comb, wattles, and glossy orange", "gamebird")).toEqual([]);
    expect(links("two white necklaces on the upper foreneck", "loon")).toEqual([]);
    expect(links("in nonbreeding plumage a thin, dark necklace", "loon")).toEqual([]);
    expect(links("breeding birds have a rufous neck with buff horns", "grebe")).toEqual(["horns→grebe-ear-tufts"]);
    expect(links("in summer show golden ear fans, not a red neck", "grebe")).toEqual(["ear fans→grebe-ear-tufts"]);
    // The same words on other birds' pages are other marks: an owl's ear tufts, a warbler's necklace, a partridge's
    // gorget, a cowbird's ruff, the Comb Duck, a tit's nape patch, a parrot's toes, a sparrow's postocular stripe.
    expect(links("close-set ear tufts, and yellow-orange eyes", "raptor")).toEqual([]);
    expect(links("plain yellow below with no dark necklace", "songbird")).toEqual([]);
    expect(links("examine throat coloration and gorget intensity", "gamebird")).toEqual([]);
    expect(links("can raise a thick neck ruff", "songbird")).toEqual([]);
    expect(links("Comb Duck is smaller", "duck")).toEqual([]);
    expect(links("a black cap with a white nape patch", "songbird")).toEqual([]);
    expect(links("The legs are dark-brown, with zygodactyl toes", "songbird")).toEqual([]);
    expect(links("a white postocular stripe", "songbird")).toEqual([]);
    expect(links("the Topknot Pigeon with its bushy crest", "songbird")).toEqual([]);
    // Shared parts open the bird's own drawing where it has them; a hummingbird's wing has no alula or tertials.
    expect(links("a long dark malar stripe and white secondaries", "woodpecker")).toEqual(["malar stripe→woodpecker-malar", "secondaries→woodpecker-secondaries"]);
    expect(links("the alula and tertials", "hummingbird")).toEqual(["alula→songbird-alula", "tertials→songbird-tertials"]);
    expect(links("feathered tarsi", "gamebird")).toEqual(["tarsi→gamebird-tarsus"]);
    expect(links("black-and-white scapulars", "loon")).toEqual(["scapulars→loon-scapulars"]);
    expect(links("black lores", "grebe")).toEqual(["lores→grebe-lores"]);
  });

  it("links an auk page's part names to the auk drawing where it has the part (td-5076e6)", () => {
    expect(links("scapulars and underwing coverts are dark", "auk")).toEqual(["scapulars→auk-scapulars", "underwing coverts→auk-underwing-coverts"]);
    expect(links("bare tarsi are red", "auk")).toEqual(["tarsi→auk-tarsus"]);
    // Every drawing has the head areas since td-93f86b; a mark only some birds show still opens the bird that shows it.
    expect(links("a white eye-ring and dark lores", "auk")).toEqual(["eye-ring→auk-eye-ring", "lores→auk-lores"]);
    expect(links("two white wing bars", "auk")).toEqual(["wing bars→songbird-wing-bars"]);
    // Cormorant-only words stay unlinked on an auk page.
    expect(links("a gular pouch", "auk")).toEqual([]);
  });

  it("links the cormorant terms production text uses, only on cormorant-group pages (td-af7c6b)", () => {
    // Phrases from species_similar notes and Description sections in the test snapshot.
    expect(links("the key mark is the yellow gular skin bordered below", "cormorant")).toEqual(["gular skin→cormorant-gular-skin"]);
    expect(links("bare face and gular pouch that projects forward", "cormorant")).toEqual(["gular pouch→cormorant-gular-skin"]);
    expect(links("a buff-tan chin strap bordering the throat pouch", "cormorant")).toEqual(["throat pouch→cormorant-gular-skin"]);
    expect(links("males show red gular sacs in both species", "cormorant")).toEqual(["gular sacs→cormorant-gular-skin"]);
    expect(links("a longer black gular stripe running well down", "cormorant")).toEqual(["gular→cormorant-gular-skin"]);
    expect(links("a huge orange-yellow bill and pouch", "cormorant")).toEqual(["pouch→cormorant-gular-skin"]);
    expect(links("fully webbed between all four toes (totipalmate)", "cormorant")).toEqual(["totipalmate→cormorant-toes"]);
    expect(links("orange lores and dark primaries", "cormorant")).toEqual(["lores→cormorant-lores", "primaries→cormorant-primaries"]);
    // Storks, gamebirds and hummingbirds use the throat words for other marks; there they stay plain text.
    expect(links("a bare red throat pouch", "heron")).toEqual([]);
    expect(links("an iridescent gular patch", "songbird")).toEqual([]);
    expect(links("totipalmate feet", "songbird")).toEqual([]);
  });

  it("uses the bird's own drawing when it has the part, otherwise the first that does", () => {
    expect(links("a blue speculum", "duck")).toEqual(["speculum→duck-speculum"]);
    expect(links("a blue speculum", "songbird")).toEqual(["speculum→duck-speculum"]);
    expect(links("two wing bars", "duck")).toEqual(["wing bars→songbird-wing-bars"]);
    expect(links("pale wing coverts", "gull")).toEqual(["wing coverts→gull-wing-coverts"]);
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
