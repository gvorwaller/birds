import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Species page collapsible cards (td-d16c18)", () => {
  const route = source("src/routes/species/[code]/+page.svelte");
  const media = source("src/lib/components/SpeciesMediaCard.svelte");

  it("folds every card, open by default", () => {
    expect(route).not.toContain('<section class="card');
    const folds = route.match(/<details class="card fold[^"]*" bind:open=\{cardOpen\.\w+\}>/g) ?? [];
    expect(folds.length).toBe(8);
    for (const key of ["recorded", "photos", "identification", "finding", "bestTime", "recent", "nearest", "about", "learnMore"])
      expect(route).toContain(`${key}: true,`);
    expect(media).toContain('<details class="card fold" bind:open>');
    expect(media).toContain("open = $bindable(true)");
    expect(route).toContain("bind:open={cardOpen.identification}");
  });

  it("names Recent and Nearest reports in their fold headings", () => {
    expect(route).toMatch(/<summary><h2 id="recent-reports"[^]*?<\/h2><\/summary>/);
    expect(route).toMatch(/<summary><h2 id="nearest-reports"[^]*?<\/h2><\/summary>/);
  });

  it("keeps the Units toggle out of the fold heading", () => {
    const heading = route.match(/<summary><h2 id="recent-reports"[^]*?<\/summary>/)?.[0] ?? "";
    expect(heading).not.toContain("DistanceUnitToggle");
    expect(route).toContain("<DistanceUnitToggle bind:unit={distanceUnit} />");
  });

  it("opens a folded card before jumping to it from On this page", () => {
    expect(route).toContain('const fold = target.closest("details");');
    expect(route).toContain("if (fold && !fold.open) fold.open = true;");
  });

  it("does not focus a fold heading when it is tapped", () => {
    expect(route).toContain("<svelte:document onmousedown={keepFoldHeadingUnfocused} />");
    expect(route).toContain('closest?.("summary > .section-target")) event.preventDefault();');
  });

  it("reopens every card for a new species", () => {
    expect(route).toMatch(/disclosureSpecies = code;[^}]*cardOpen = allCardsOpen\(\);/s);
  });
});
