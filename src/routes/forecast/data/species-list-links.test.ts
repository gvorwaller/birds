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

  it("links row counts: a hotspot inside its loaded county, or directly under its state (td-327dd6)", () => {
    expect(hub).toContain('speciesListHref(r.locCode, r.locKind === "hotspot" ? parent : null)');
    expect(hub).toContain("{@render dataRowCells(h, true, b.county ? b.countyCode : null)}");
    // A state-hotspot row links through its own guideParent (set by
    // regionDetail only for an exact state-direct row: region-detail-db.test).
    expect(hub).toContain("{@render dataRowCells(r, false, r.guideParent ?? null)}");
  });

  it("links discovery results through the hotspot's loaded county or its state", () => {
    expect(hub).toContain("speciesListHref(r.id, r.guideParent ?? null)");
    expect(discovery).toMatch(/guideParent: guideHotspotParent\(\s*loadedRow\?\.region_code \?\? null,\s*!!loadedRow\?\.region_code && ev\.loaded\.get\(loadedRow\.region_code\)\?\.loc_kind === "region",/);
  });

  it("joins the path so Back returns to the row, with a 48px target and a descriptive name", () => {
    expect(hub).toContain('withReturnTo(href, page.url.pathname + page.url.search + page.url.hash, undefined, "Hotspots & data")');
    expect(hub).toContain('onclick={navigationAction(data.accountId, { label: "Field guide"');
    expect(hub).toMatch(/\.specieslist \{[^}]*min-height: 48px;/);
    expect(hub).toContain("aria-label={`See the species list for ${r.locName} in the Field Guide`}");
  });
});

describe("region rows never stay 'Loading …' forever (td-fb6948)", () => {
  it("reads the body before merging, times out, and shows a failure with Retry", () => {
    expect(hub).toContain("const detail = (await res.json()) as GroupDetail;\n      groupDetail = { ...groupDetail, [code]: detail };");
    expect(hub).toContain("{ signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS) }");
    expect(hub).toContain("Couldn't load {g.stateName}'s rows.");
    expect(hub).toContain("onclick={() => loadGroupDetail(g.stateCode, g.stateName)}>Retry</button>");
    expect(hub).toContain("Couldn't load {s.countryName}'s countrywide rows.");
  });
});

describe("return focus to a lazily loaded row (GROK)", () => {
  it("waits for every open group's rows before restoring focus", () => {
    expect(hub).toContain("contentReady={hubContentReady}");
    expect(hub).toContain("return !groupCodes.has(code) || hasDetail(code) || detailFailed.includes(code);");
    // td-b6be76: an open country also waits for its lazily loaded groups.
    expect(hub).toContain("if (sec && countryGroupsPending(sec)) return false;");
    // A failed detail request settles the wait instead of blocking it.
    // (td-fb6948: an HTTP failure now throws into the same catch, so one site.)
    expect(hub.match(/detailFailed = \[\.\.\.detailFailed, code\];/g)).toHaveLength(1);
    expect(hub).toContain('if (!res.ok) throw new Error(String(res.status));');
    // Landing on a ?show= section yields to a return-to-row restore.
    expect(hub).toContain("const node = trailFor(data.accountId).nodes.at(-1);");
    expect(hub).toContain("if (shouldRestoreNavigationOrigin() && (node?.focusId || node?.originId)) return;");
  });
});

describe("hotspot page species-count link", () => {
  it("links the LOADED-history count through the hotspot's loaded county or its state", () => {
    expect(hotspotLoader).toContain("WHERE c.loc_code = f.region_code AND c.loc_kind = 'region') AS county_loaded");
    expect(hotspotLoader).toMatch(/guidePlaceListHref\(\s*locId,\s*guideHotspotParent\(guideParentRes\.rows\[0\]\?\.region_code \?\? null, guideParentRes\.rows\[0\]\?\.county_loaded \?\? false\),/);
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
