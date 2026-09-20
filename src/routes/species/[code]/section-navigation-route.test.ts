import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const route = readFileSync(
  resolve(process.cwd(), "src/routes/species/[code]/+page.svelte"),
  "utf8",
);
const media = readFileSync(
  resolve(process.cwd(), "src/lib/components/SpeciesMediaCard.svelte"),
  "utf8",
);
const similar = readFileSync(
  resolve(process.cwd(), "src/lib/components/SimilarSpeciesCard.svelte"),
  "utf8",
);

describe("Phase 7B species-page section navigation", () => {
  it("keeps the menu data-aware and names every documented fragment", () => {
    expect(route).toContain('<nav class="on-page" aria-label="On this page">');
    for (const [id, label] of [
      ["identification", "Identification"],
      ["similar-species", "Similar species"],
      ["finding-this-bird", "Finding this bird"],
      ["seasonal-distribution", "Seasonal distribution"],
      ["best-time", "Best time"],
      ["recent-reports", "Recent reports"],
      ["nearest-reports", "Nearest reports"],
      ["about", "About"],
      ["learn-more", "Learn more"],
    ]) {
      expect(route).toContain(`id: "${id}"`);
      expect(route).toContain(`label: "${label}"`);
    }
    expect(route).toContain("if (hasIdentification)");
    expect(route).toContain("if (hasSimilarSpecies)");
    expect(route).toContain("if (hasFieldCraft)");
    expect(route).toContain("if (hasSeasonalDistribution)");
    expect(route).toContain("if (hasBestTime)");
    expect(route).toContain("if (hasNearestReports)");
    expect(route).toContain("if (hasAbout)");
  });

  it("keeps target headings focusable with shell clearance", () => {
    for (const id of [
      "finding-this-bird",
      "seasonal-distribution",
      "best-time",
      "recent-reports",
      "nearest-reports",
      "about",
      "learn-more",
    ])
      expect(route).toMatch(
        new RegExp(`id="${id}" class="section-target" tabindex="-1"`),
      );
    expect(media).toContain(
      'id="identification" class="section-target" tabindex="-1"',
    );
    expect(similar).toContain(
      'id="similar-species" class="section-target" tabindex="-1"',
    );
    expect(route).toContain("scroll-margin-top: calc(var(--nav-h) + 16px);");
		expect(route).toMatch(/\.section-target:focus\s*\{[^}]*outline:/s);
		expect(media).toMatch(/\.section-target:focus\s*\{[^}]*outline:/s);
		expect(similar).toMatch(/\.section-target:focus\s*\{[^}]*outline:/s);
  });

  it("reveals native disclosures and replaces the current history entry before focusing", () => {
    expect(route).toContain("reveal: () => (similarExpanded = true)");
    expect(route).toContain("reveal: () => (ribbonExpanded = true)");
    expect(similar).toContain("bind:open");
    expect(route).toMatch(
      /replaceState\(\s*sectionHref\(page\.url\.pathname, page\.url\.search, id\),\s*page\.state\s*\)/,
    );
    expect(route).toContain('behavior: reducedMotion ? "auto" : "smooth"');
    expect(route).toContain("target.focus({ preventScroll: true })");
    expect(route).toContain('await navigateToSection("best-time")');
  });
});
