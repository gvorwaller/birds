import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Home collapsible sections", () => {
  it("renders every Home card as an open-by-default disclosure", () => {
    const home = source("src/routes/+page.svelte");
    const cards = home.match(/<details class="card[^>]* open>/g) ?? [];

    expect(cards.length).toBeGreaterThanOrEqual(10);
    expect(home).not.toContain('<section class="card');
    expect(home).toContain("<summary><h2>At a glance</h2></summary>");
    expect(home).toContain("<summary><h2>Map</h2></summary>");
  });

  it("makes the child result cards open-by-default disclosures too", () => {
    for (const path of [
      "src/lib/components/BestPlaces.svelte",
      "src/lib/components/HotspotComparison.svelte",
    ]) {
      const component = source(path);
      expect(component).toContain('<details class="card');
      expect(component).toMatch(/<details class="card[^>]* open>/);
      expect(component).toContain("<summary>");
    }
  });
});
