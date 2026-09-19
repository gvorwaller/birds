import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const route = readFileSync(resolve(process.cwd(), "src/routes/species/+page.svelte"), "utf8");
const loader = readFileSync(resolve(process.cwd(), "src/routes/species/+page.server.ts"), "utf8");

describe("Phase 7A Field Guide UI contract", () => {
  it("keeps unknown query parameters on both native GET forms and tag links", () => {
    expect(route).toContain("const unknownParams = $derived");
    expect(route).toContain("!ownedParams.has(key)");
    expect(route.match(/name=\{key\} value=\{value\}/g)).toHaveLength(2);
    expect(route).toContain("search-${index}-${key}-${value}");
    expect(route).toContain("filter-${index}-${key}-${value}");
    expect(route).toContain("const p = new URLSearchParams(page.url.searchParams)");
    expect(route).toContain('p.delete("page")');
  });

  it("uses a labelled native disclosure before a fragment-addressable result section", () => {
    expect(route).toMatch(/<details class="filters" bind:open=\{filtersOpen\}>/);
    expect(route).toContain("Filters and sort");
    expect(route.indexOf('class="filter-card"')).toBeLessThan(route.indexOf('class="card results"'));
    expect(route).toContain('class="card results" id="results"');
    expect(route).toContain('class="card" id="results"');
    expect(route).not.toContain('id="results" tabindex');
    expect(route.match(/Showing \{\(data\.page - 1\)/g)).toHaveLength(1);
    expect(route).not.toContain('aria-label="Results pages"');
  });

  it("keeps pagination in the result fragment while retaining the full query string", () => {
    expect(loader).toContain("new URLSearchParams(url.searchParams)");
    expect(loader).toContain("return `/species?${p}#results`;");
  });
});
