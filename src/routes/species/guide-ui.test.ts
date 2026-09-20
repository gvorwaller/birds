import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const route = readFileSync(resolve(process.cwd(), "src/routes/species/+page.svelte"), "utf8");
const loader = readFileSync(resolve(process.cwd(), "src/routes/species/+page.server.ts"), "utf8");
const row = readFileSync(resolve(process.cwd(), "src/lib/components/GuideSpeciesRow.svelte"), "utf8");
const listModule = readFileSync(resolve(process.cwd(), "src/lib/guide-list.ts"), "utf8");
const mapPicker = readFileSync(resolve(process.cwd(), "src/lib/components/MapPicker.svelte"), "utf8");

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

describe("Phase 8A Field Guide geography UI contract (td-82fbc1)", () => {
  const rule = (selector: string) => {
    const at = route.indexOf(selector);
    expect(at, `${selector} rule`).toBeGreaterThan(-1);
    return route.slice(at, route.indexOf("}", at));
  };

  it("owns every geographic parameter so transitions change them deliberately and unknown ones survive", () => {
    expect(route).toContain("...GUIDE_LOCATION_PARAMS");
    expect(route).toContain("!ownedParams.has(key)");
    expect(route).toContain('p.delete("page")');
  });

  it("carries the current geography in both native GET forms without duplicating owned parameters", () => {
    expect(route).toContain("const locationPairs = $derived(guideLocationPairs(data.selection))");
    expect(route.match(/\{#each locationPairs as \[locName, locValue\] \(locName\)\}/g)).toHaveLength(2);
    expect(route.match(/name=\{key\} value=\{value\}/g)).toHaveLength(2);
  });

  it("offers Country, State / region, County / equivalent and Verified hotspot as labelled native selects", () => {
    for (const [id, name, label] of [
      ["guide-country", "country", "Country"],
      ["guide-region", "region", "State / region"],
      ["guide-county", "county", "County / equivalent"],
      ["guide-hotspot", "hotspot", "Verified hotspot"],
    ])
      expect(route).toContain(`<label for="${id}">${label}</label><select id="${id}" name="${name}"`);
    expect(route).toContain("disabled={!data.region || data.counties.length === 0}");
    expect(route).toContain("disabled={!data.county || data.hotspots.length === 0}");
    expect(route).toContain("{#each data.counties as c (c.code)}");
    expect(route).toContain("{#each data.hotspots as h (h.code)}");
    // Every option is rendered: no slice, sample or cap on either list.
    expect(route).not.toMatch(/data\.(counties|hotspots)\.slice/);
    expect(loader).not.toMatch(/(counties|hotspots).*slice\(/);
  });

  it("keeps native submission working: the selects live in the GET filter form with an Apply fallback", () => {
    const form = route.slice(route.indexOf('<form method="GET" action="/species#results" class="filter-form">'));
    const formEnd = form.indexOf("</form>");
    for (const name of ['name="country"', 'name="region"', 'name="county"', 'name="hotspot"', "Apply filters"])
      expect(form.slice(0, formEnd)).toContain(name);
    // Auto-submit is an enhancement that clears deeper levels via the shared contract.
    expect(route).toContain("descendantsOf(level)");
    expect(route).toContain("form.requestSubmit()");
    expect(route).toContain('onchange={(e) => levelChanged(e, "country")}');
    expect(route).toContain('onchange={(e) => levelChanged(e, "hotspot")}');
  });

  it("submits the applied hierarchy with the selects so a native form can clear stale descendants", () => {
    expect(route).toContain("...GUIDE_WAS_PARAMS");
    expect(route).toContain("{#each guideWasPairs(data.selection) as [wasName, wasValue] (wasName)}");
    const form = route.slice(route.indexOf('<form method="GET" action="/species#results" class="filter-form">'));
    const hierarchy = form.slice(0, form.indexOf("</form>"));
    // The intent fields live in the same native form as the selects and Apply filters.
    expect(hierarchy).toContain("guideWasPairs(data.selection)");
    expect(hierarchy.indexOf("guideWasPairs(data.selection)")).toBeLessThan(hierarchy.indexOf('name="country"'));
    expect(hierarchy).toContain("Apply filters");
    // No instruction asking a reader to reset lower lists by hand.
    expect(route).not.toContain("set the lower lists to Anywhere");
    expect(loader).toContain("canonicalizeGuideLevelChange(url.searchParams)");
    expect(loader).toContain("if (!canonical.ok) error(400, canonical.message);");
    expect(loader).toContain("redirect(303, guideResultsHref(canonical.params))");
  });

  it("swaps the hierarchy selects for a summary and native clear action while a map point is applied", () => {
    expect(route).toContain('data.selection.kind === "map" && data.map');
    expect(route).toContain("Clear location to choose a country, state, county or hotspot");
    expect(route).toContain("Clear location only");
    expect(route).toContain("clearGuideLocation(page.url.searchParams)");
  });

  it("names the exact selected type in the scope summary and explains coverage with the shared wording", () => {
    expect(route).toContain("guideScopeText(data.location)");
    expect(route).toContain("guideCoverage(data.location)");
    expect(route).toContain("coverage.text");
    // The coverage sentence sits in the always-visible scope summary, not only
    // inside the collapsed filter editor.
    const scope = route.slice(route.indexOf('class="scope-summary"'), route.indexOf('class="card filter-card"'));
    expect(scope).toContain("{coverage.text}");
    expect(route.match(/\{coverage\.text\}/g)).toHaveLength(1);
    expect(route).toContain('coverage.status === "unavailable"');
    expect(route).toContain('<a href="/forecast/data">Load an area in Hotspots &amp; data</a>');
    expect(route).toContain("Location coverage is unavailable; this does not mean there are no");
  });

  it("reuses the shared MapPicker and no other map provider or loader", () => {
    expect(route).toContain('import MapPicker, { type PickedLocation } from "$components/MapPicker.svelte"');
    expect(route).not.toContain("google-maps");
    expect(route).not.toContain("maps.googleapis");
    expect(route).toContain("<MapPicker bind:selected={picked}");
    expect(route).toContain("initialLabel={data.map?.place}");
    expect(mapPicker).toContain('initialLabel = "Saved home location"');
    // While the chooser is open the page also shows its species "Search" button.
    expect(route).toContain('<button type="submit">Search</button>');
    expect(mapPicker).toContain('"Search place"');
    expect(mapPicker).not.toMatch(/"Search"\}<\/button/);
    expect(mapPicker).toMatch(/placeMarker\(\s*initialLat as number,\s*initialLng as number,\s*initialLabel,\s*\)/);
    // The picker's own search <form> cannot nest inside the filter form.
    const filterForm = route.slice(route.indexOf('class="filter-form"'), route.indexOf("</form>", route.indexOf('class="filter-form"')));
    expect(filterForm).not.toContain("<MapPicker");
  });

  it("has no hidden default or saved radius and disables Apply until a point and valid radius exist", () => {
    expect(route).toContain('let radiusText = $state("")');
    expect(route).toContain("radiusText = data.map ? String(data.map.dist) : \"\"");
    expect(route).not.toMatch(/radiusText = \$state\(["']?\d/);
    expect(route).not.toMatch(/name="dist"[^>]*value="\d/);
    expect(route).toContain("const canApply = $derived(picked !== null && radiusValid)");
    expect(route).toContain("disabled={!canApply}");
    expect(route).toContain('<label for="guide-radius">Radius in miles ({GUIDE_RADIUS_MIN}–{GUIDE_RADIUS_MAX})</label>');
    expect(route).toContain('inputmode="numeric"');
    expect(route).toContain('aria-describedby="guide-apply-help"');
    expect(route).toContain("Apply location");
    expect(route).toContain("guideMapHref(page.url.searchParams");
    expect(route).toContain("Chosen point: {picked.label}".replace("{picked.label}", "${picked.label}"));
  });

  it("does not persist the selection or touch Settings, Home or saved location", () => {
    for (const forbidden of ["fetch(", "localStorage", "sessionStorage", "home_lat", "method: \"POST\"", 'method="POST"', 'method="post"', "use:enhance"])
      expect(route.includes(forbidden), forbidden).toBe(false);
    expect(loader).not.toMatch(/INSERT|UPDATE|DELETE/);
  });

  it("gives the chooser a named region, focus on open, and Cancel focus back on the trigger", () => {
    expect(route).toContain('role="group" aria-labelledby="guide-map-heading"');
    expect(route).toContain('id="guide-map-heading" tabindex="-1"');
    expect(route).toContain("chooserHeading?.focus({ preventScroll: true })");
    expect(route).toContain('chooserHeading?.scrollIntoView({ block: "start" })');
    expect(route).toContain("aria-controls={chooserId}");
    expect(route).toContain("aria-expanded={mapOpen}");
    expect(route).toMatch(/async function cancelChooser\(\)[\s\S]*?await tick\(\);\s*chooseButton\?\.focus\(\);/);
    expect(route).toMatch(/\.chooser h3[\s\S]*?scroll-margin-top: calc\(var\(--nav-h\) \+ 16px\);/);
    // Cancel changes nothing: it never navigates.
    const cancel = route.slice(route.indexOf("async function cancelChooser()"), route.indexOf("function applyChooser()"));
    expect(cancel).not.toContain("goto(");
  });

  it("says map choosing needs JavaScript and only shows the chooser once hydrated", () => {
    expect(route).toContain("<noscript>");
    expect(route).toContain("Choosing or moving a map point needs JavaScript.");
    expect(route).toContain("a shared map link still filters the results");
    expect(route).toContain("{#if jsReady}");
    expect(route).toContain("onMount(() => {");
  });

  it("keeps every touched control at 48px and every text input at 16px", () => {
    expect(rule(".radius-field input")).toMatch(/min-height: 48px;[\s\S]*font-size: 1rem;/);
    expect(rule(".map-chooser button.secondary,\n  .chooser-actions button")).toContain("min-height: 48px;");
    expect(rule(".clear-filters")).toContain("min-height: 48px;");
    expect(rule(".coverage a")).toContain("min-height: 48px;");
    expect(rule(".location-fields select")).toContain("min-height: 48px;");
    expect(mapPicker).toMatch(/\.search input[\s\S]*?min-height: 48px;[\s\S]*?font-size: 16px;/);
    // No horizontal overflow: long place names wrap and the groups shrink.
    expect(rule(".chooser {")).toContain("min-width: 0;");
    expect(rule(".chooser {")).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(rule(".map-chooser {")).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(rule(".chooser p")).toContain("overflow-wrap: anywhere;");
    expect(rule(".geo {")).toContain("min-width: 0;");
    expect(rule(".geo-map")).toContain("overflow-wrap: anywhere;");
  });

  it("keeps the phase 7A answer-first result layout, provenance and pagination in place", () => {
    expect(route.indexOf('class="filter-card"')).toBeLessThan(route.indexOf('class="card results"'));
    expect(row).toContain("match-provenance");
    expect(route).toContain('class="pagination"');
    expect(route).toContain("withReturnTo(");
    expect(route).toContain('page.url.pathname + page.url.search + "#results"');
  });
});

describe("Phase 9A All / Need / Seen UI contract (td-f02bf7)", () => {
  const rule = (source: string, selector: string) => {
    const at = source.indexOf(selector);
    expect(at, `${selector} rule`).toBeGreaterThan(-1);
    return source.slice(at, source.indexOf("}", at));
  };

  it("places a server-rendered link control after the tabs and before the search/filter summary", () => {
    const tabs = route.indexOf('<FieldGuideTabs active="browse" />');
    const nav = route.indexOf('<nav class="list-scope"');
    const search = route.indexOf('<section class="card guide-search">');
    expect(tabs).toBeGreaterThan(-1);
    expect(nav).toBeGreaterThan(tabs);
    expect(nav).toBeLessThan(search);
    expect(route).toContain('aria-label="Species list: All, Need or Seen"');
    // Links (no JavaScript needed), one per scope, with the selected one exposed and marked in a second, non-colour way.
    expect(route).toContain("{#each GUIDE_LISTS as list (list)}");
    expect(route).toContain("href={listHref(list)}");
    expect(route).toContain('aria-current={data.list === list ? "true" : undefined}');
    expect(route).toContain('{data.list === list ? "●" : "○"}');
    expect(route).toContain("const listHref = (list: GuideList) => guideListHref(page.url.searchParams, list);");
    const control = route.slice(nav, route.indexOf("</nav>", nav));
    expect(control).not.toContain("onclick");
    expect(control).not.toContain("<button");
    expect(rule(route, ".list-scope a {")).toContain("min-height: 48px;");
    expect(rule(route, ".list-scope a.current")).toContain("border: 2px solid var(--accent);");
    expect(route).toContain(".list-scope a:focus-visible { outline: 3px solid var(--accent);");
  });

  it("switches scope by removing only the stale page and keeping every other parameter", () => {
    expect(listModule).toContain('next.delete("page");');
    expect(listModule).toContain('next.set("list", list);');
    expect(listModule).not.toMatch(/delete\("(q|tags|family|sort|interest|country|region|county|hotspot|place|lat|lng|dist)"\)/);
    expect(listModule).toContain("guideResultsHref(withGuideList(base, list))");
  });

  it("keeps list out of the owned parameters so forms, tag links, Clear location and Clear all carry it", () => {
    const owned = route.slice(route.indexOf("const ownedParams = new Set(["), route.indexOf("]);", route.indexOf("const ownedParams = new Set([")));
    expect(owned).not.toContain('"list"');
    expect(route).toContain("[...page.url.searchParams].filter(([key]) => !ownedParams.has(key))");
    // Both native GET forms re-emit every non-owned parameter as a hidden input, which carries list.
    expect(route.match(/name=\{key\} value=\{value\}/g)).toHaveLength(2);
    // Clear all deletes only owned parameters, so the list survives it; choosing All is the way out.
    expect(route).toContain("for (const key of ownedParams) p.delete(key);");
    expect(route).toContain("clearGuideLocation(page.url.searchParams)");
    // Tag links start from the full current parameter set.
    expect(route).toContain("const p = new URLSearchParams(page.url.searchParams);");
  });

  it("names the selected scope in every count, empty state and scope chip", () => {
    expect(route).toContain("const scopeNoun = $derived(GUIDE_LIST_NOUN[data.list]);");
    expect(route).toContain('data.location && coverage?.status === "unavailable"');
    expect(route).toContain("<strong>{scopeNoun} unavailable for this location</strong>");
    expect(route).toContain("of {data.total} {scopeNoun}</strong>");
    expect(route).toContain('{:else if data.list === "all"}');
    expect(route).toContain("<strong>No species match these filters</strong>");
    expect(route).toContain("<strong>No {scopeNoun} match these filters</strong>");
    expect(route).toContain("<span>List: {GUIDE_LIST_LABEL[data.list]}</span>");
    expect(route).toContain("This is a list-scope result, not an answer about the place");
    // The existing Phase 8 coverage explanation stays adjacent to the count and is not rewritten.
    expect(route).toContain('{#if data.location && coverage}<p class="coverage" role="status">{coverage.text}');
    expect(route.indexOf("<strong>No {scopeNoun} match")).toBeLessThan(route.indexOf('class="coverage"'));
    expect(route).toContain("Location coverage is unavailable; this does not mean there are no");
    // A scoped empty result keeps the Need/Seen recovery even when the
    // Special-interest filter is also active; generic saved-species help is
    // only the All-scope fallback.
    expect(route.indexOf('{:else if data.list !== "all"}')).toBeLessThan(
      route.indexOf("{:else if data.interestOnly}", route.indexOf('id="results"')),
    );
  });

  it("adopts one shared species-row component for every result and keeps no inline row markup", () => {
    expect(route).toContain('import GuideSpeciesRow from "$components/GuideSpeciesRow.svelte";');
    expect(route.match(/<GuideSpeciesRow/g)).toHaveLength(1);
    expect(route).not.toContain('<article class="result">');
    expect(route).not.toContain("brokenPhotos");
    expect(route).toContain("interest={data.interests?.includes(r.species_code) ?? false}");
    expect(route).toContain("viewed={data.viewed[r.species_code]}");
    expect(route).toContain("href={detailHref(r.species_code)}");
  });

  it("keeps the row hierarchy: thumbnail, names, Seen/Need then personal badges, evidence, stable target", () => {
    const at = (needle: string) => {
      const i = row.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      "id={`guide-species-${encodeURIComponent(row.species_code)}`}", // the stable row target on the anchor
      'class="thumbnail"',
      'class="name">{row.com_name}',
      '<em>{row.sci_name}</em>',
      'kind="seen"',
      'class="interest-badge"',
      "<ViewedBadge",
      "Banding code:",
      'class="match-provenance">Name or code match',
      "row.iucn_status",
      'class="rowtags"',
      'class="muted craft"',
      'class="go"',
      'class="photo-credit"',
    ];
    const positions = order.map(at);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(row).toContain("{href}");
    expect(row).toContain("{onclick}");
  });

  it("preserves the honest thumbnail states, failed-image handling and source/licence credit", () => {
    expect(row).toContain('{row.photo ? "Photo unavailable" : "No photo yet"}');
    expect(row).toContain("use:checkThumbnail");
    expect(row).toContain("onerror={() => {");
    expect(row).toContain("image.complete && image.naturalWidth === 0");
    expect(row).toContain('Photo: {row.photo.creator ?? "Creator not recorded"}');
    expect(row).toContain('<a href={row.photo.sourceUrl} target="_blank" rel="noopener">source</a>');
    expect(row).toContain("{row.photo.licenseCode}");
    // A missing thumbnail is a labelled placeholder, never removal of the row.
    expect(row).toContain('<span class="photo-missing">');
    // Personal state is passed in by the caller from the SIGNED-IN account; the component reads no scope itself.
    expect(row).not.toMatch(/scopeId|locals|fetch\(/);
  });
});
