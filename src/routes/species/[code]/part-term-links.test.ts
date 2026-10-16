import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import SimilarSpeciesCard, { type SimilarSpeciesRow } from "$components/SimilarSpeciesCard.svelte";
import PartTermText from "$components/PartTermText.svelte";
import { linkPartTerms } from "$lib/bird-parts/terms";
import { load as partsLoad } from "../../parts-of-a-bird/+page";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const page = read("src/routes/species/[code]/+page.svelte");
const server = read("src/routes/species/[code]/+page.server.ts");

function row(code: string, note: string | null): SimilarSpeciesRow {
  return { species_code: code, com_name: `Bird ${code}`, sci_name: "Avis", misid_count: 3, note, photo: null, seen: false };
}

describe("part-term links on species pages (td-e4c6dd)", () => {
  it("renders text and anchors only, with a deep link that names the way back", () => {
    const segments = linkPartTerms(['<b>x</b> & a pale supercilium'], "songbird")[0];
    const { body } = render(PartTermText, {
      props: { segments, idPrefix: "part-term-desc-0", accountId: 1, returnTo: "/species/sonspa?back=7", returnLabel: "Song Sparrow" },
    });
    expect(body).toContain("&lt;b>x&lt;/b> &amp; a pale ");
    expect(body).not.toContain("<b>");
    expect(body).toContain('id="part-term-desc-0-supercilium"');
    expect(body).toContain(
      'href="/parts-of-a-bird?returnTo=%2Fspecies%2Fsonspa%3Fback%3D7&amp;returnLabel=Song+Sparrow#songbird-supercilium"',
    );
    expect(body).toMatch(/>supercilium<span class="vh[^"]*"> \(Parts of a Bird\)<\/span><\/a>/);
  });

  it("links notes on the page species' drawing, with ids unique across notes", () => {
    const { body } = render(SimilarSpeciesCard, {
      props: {
        similar: [row("aaa1", "Lacks the bold white eye ring and supercilium."), row("bbb1", "Has a white supercilium; voice differs."), row("ccc1", null)],
        unresolved: [],
        inatStatus: "ok",
        backDays: 14,
        returnTo: "/species/gadwal",
        accountId: 1,
        currentSpeciesName: "Gadwall",
        partsDiagram: "duck",
      },
    });
    // The duck drawing lacks both, so they open the first drawing that has them.
    expect(body).toContain('id="part-term-similar-aaa1-eye-ring"');
    expect(body).toContain('id="part-term-similar-aaa1-supercilium"');
    expect(body).toContain('id="part-term-similar-bbb1-supercilium"');
    expect(body).toContain("#songbird-eye-ring");
    expect(body.match(/id="part-term-similar-[^"]+"/g)).toHaveLength(3);
  });

  it("leaves notes plain when the page has no drawing to link to", () => {
    const { body } = render(SimilarSpeciesCard, {
      props: { similar: [row("aaa1", "a pale supercilium")], unresolved: [], inatStatus: "ok", backDays: 14, returnTo: "/species/x", currentSpeciesName: "X" },
    });
    expect(body).toContain("a pale supercilium");
    expect(body).not.toContain("part-term");
  });

  it("links only the owner's two Wikipedia sections, on the family's drawing", () => {
    expect(page).toContain('const PART_TERM_SECTIONS = new Set(["Description", "Description and taxonomy"]);');
    expect(page).toContain("const partsDiagram = $derived(diagramForFamily(data.taxon.family_sci_name));");
    expect(page).toContain("{@const linked = PART_TERM_SECTIONS.has(s.title)");
    expect(page).toContain("idPrefix={`part-term-desc-${si}`}");
    expect(server).toContain("family_code, family_sci_name, order_name");
    // The lead paragraph and Finding this bird stay plain text.
    expect(page).toContain("{en?.wikipedia_extract}");
    expect(page).toContain('<p class="fieldcraft">{en?.field_craft}</p>');
  });

  it("reopens the section a part link came from on the way back", () => {
    expect(page).toContain("ui={{ expandedIds: [sectionId] }}");
    expect(page).toContain('<details class="wiki-section" open={reopenedSections.includes(sectionId)}>');
    expect(page).toContain("onRestore={restoreSpecies}");
    expect(read("src/lib/components/SimilarSpeciesCard.svelte")).toContain("ui={{ expandedIds: ['similar-species'] }}");
  });
});

describe("Parts of a Bird back link (td-e4c6dd)", () => {
  const run = (search: string) => partsLoad({ url: new URL(`http://x/parts-of-a-bird${search}`) } as never) as { returnLink: { href: string; label: string } | null };

  it("names the species page it came from", () => {
    expect(run("?returnTo=%2Fspecies%2Fsonspa&returnLabel=Song+Sparrow#songbird-supercilium").returnLink).toEqual({
      href: "/species/sonspa",
      label: "Song Sparrow",
    });
  });

  it("ignores a missing or unsafe returnTo", () => {
    expect(run("").returnLink).toBeNull();
    expect(run("?returnTo=https%3A%2F%2Fevil.example").returnLink).toBeNull();
    expect(run("?returnTo=%2F%2Fevil.example").returnLink).toBeNull();
  });
});
