import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const markup = readFileSync(
  resolve("src/lib/components/MapLink.svelte"),
  "utf8",
);

describe("MapLink.svelte markup & checklist contract", () => {
  it("accepts subId prop", () => {
    expect(markup).toContain("subId = null");
    expect(markup).toContain("subId?: string | null");
  });

  it("renders eBird checklist link with secure external attributes", () => {
    expect(markup).toContain("https://ebird.org/checklist/");
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener"');
    expect(markup).toContain("checklist ↗");
  });

  it("preserves mobile accessibility touch targets >= 48px", () => {
    expect(markup).toContain("min-height: 48px");
  });

  it("wraps the three links within narrow content columns", () => {
    const group = markup.match(/\.maplink\s*\{([^}]+)\}/)?.[1];
    expect(group).toContain("flex-wrap: wrap");
    expect(group).toContain("max-width: 100%");
  });

  it("styles checklist link with accent color matching species and nearest pages", () => {
    expect(markup).toContain(".maplink a.cl {");
    expect(markup).toContain("color: var(--accent);");
  });
});
