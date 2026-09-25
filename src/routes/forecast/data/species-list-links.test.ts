/**
 * td-c52c37: species counts on Hotspots & data and a hotspot page open the
 * Field Guide list for that place. Source contract; the link builder itself is
 * tested in src/lib/guide-location.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const hub = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");
const discovery = readFileSync(new URL("../../../lib/server/hub-discovery.ts", import.meta.url), "utf8");
const hotspot = readFileSync(new URL("../../hotspots/[locId]/+page.svelte", import.meta.url), "utf8");
const hotspotLoader = readFileSync(new URL("../../hotspots/[locId]/+page.server.ts", import.meta.url), "utf8");

describe("Hotspots & data species-count links", () => {
  it("links country and state/region totals, but not continent or worldwide totals", () => {
    expect(hub).toContain('{#if kind === "regions" && count > 0}');
    expect(hub).toContain('{@render speciesTotal("regions", g.stateCode, g.stateName)}');
    expect(hub).toContain('{@render speciesTotal("regions", s.countryCode, s.countryName)}');
    expect(hub).toContain('{@render speciesTotal("world", "world")}');
  });

  it("links row counts, and a hotspot only inside its loaded county", () => {
    expect(hub).toContain('speciesListHref(r.locCode, r.locKind === "hotspot" ? county : null)');
    expect(hub).toContain("{@render dataRowCells(h, true, b.county ? b.countyCode : null)}");
    // Hotspots recorded directly under a region have no county: no link.
    expect(hub).toMatch(/\{@render dataTable\("Hotspot", detail\.stateHotspots\)\}/);
  });

  it("links discovery results, using the hotspot's loaded county", () => {
    expect(hub).toContain("speciesListHref(r.id, r.guideCounty ?? null)");
    expect(discovery).toMatch(/guideCounty:\s*loadedRow\?\.region_code &&[\s\S]*?ev\.loaded\.get\(loadedRow\.region_code\)\?\.loc_kind === "region"/);
  });

  it("joins the path so Back returns to the row, with a 48px target and a descriptive name", () => {
    expect(hub).toContain('withReturnTo(href, page.url.pathname + page.url.search + page.url.hash, undefined, "Hotspots & data")');
    expect(hub).toContain('onclick={navigationAction(data.accountId, { label: "Field guide"');
    expect(hub).toMatch(/\.specieslist \{[^}]*min-height: 48px;/);
    expect(hub).toContain("aria-label={`See the species list for ${r.locName} in the Field Guide`}");
  });
});

describe("return focus to a lazily loaded row (GROK)", () => {
  it("waits for every open group's rows before restoring focus", () => {
    expect(hub).toContain("contentReady={hubContentReady}");
    expect(hub).toMatch(/const hubContentReady = \$derived\(\s*openStates\.every\(\(code\) => !groupCodes\.has\(code\) \|\| hasDetail\(code\) \|\| detailFailed\.includes\(code\)\),/);
    // A failed detail request settles the wait instead of blocking it.
    expect(hub.match(/detailFailed = \[\.\.\.detailFailed, code\];/g)).toHaveLength(2);
    // Landing on a ?show= section yields to a return-to-row restore.
    expect(hub).toContain("const node = trailFor(data.accountId).nodes.at(-1);");
    expect(hub).toContain("if (shouldRestoreNavigationOrigin() && (node?.focusId || node?.originId)) return;");
  });
});

describe("hotspot page species-count link", () => {
  it("links the LOADED-history count only when the hotspot's county is loaded", () => {
    expect(hotspotLoader).toContain("JOIN frequency_fetch c ON c.loc_code = f.region_code AND c.loc_kind = 'region'");
    expect(hotspotLoader).toContain("speciesListHref: freq ? guidePlaceListHref(locId, guideCountyRes.rows[0]?.county ?? null) : null");
    expect(hotspot).toMatch(/\{data\.freq\.nSpecies\} species\{#if speciesListLink\}/);
    // eBird's all-time number links to the loaded-history list without
    // presenting that destination as the same total.
    expect(hotspot).toContain("{data.numSpeciesAllTime} species all-time{#if speciesListLink}");
    expect(hotspot).toContain("see loaded history →");
    expect(hotspot).toContain("this list may differ from the eBird all-time count");
  });

  it("uses non-overlapping 48px targets", () => {
    expect(hub).toMatch(/\.specieslist \{[^}]*min-height: 48px;/);
    expect(hotspot).toMatch(/\.specieslist \{[^}]*min-height: 48px;/);
    expect(hub).not.toMatch(/\.specieslist \{[^}]*margin:\s*-\d/);
    expect(hotspot).not.toMatch(/\.specieslist \{[^}]*margin:\s*-\d/);
  });
});
