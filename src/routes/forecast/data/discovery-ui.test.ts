import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("src/routes/forecast/data/+page.svelte", "utf8");
const loader = readFileSync("src/routes/forecast/data/+page.server.ts", "utf8");
const workspace = readFileSync("src/routes/hotspots/[locId]/+page.svelte", "utf8");
const mapPicker = readFileSync("src/lib/components/MapPicker.svelte", "utf8");

/** The unit environment does not mount route components; these pin the wiring. */
describe("Phase 8B Hotspots & data discovery UI contract", () => {
  const rule = (selector: string) => {
    const at = page.indexOf(selector);
    expect(at, `${selector} rule`).toBeGreaterThan(-1);
    return page.slice(at, page.indexOf("}", at));
  };

  it("replaces the transient search with a server-rendered, native GET section", () => {
    expect(page).toContain("Find a country, region, county or hotspot");
    expect(page).not.toContain("Find a hotspot or region");
    expect(page).not.toContain("/api/hub-search?q=");
    expect(page).not.toContain("HubHit");
    expect(page).toContain('<form method="GET" action={`${page.url.pathname}#${HUB_RESULTS_ID}`} class="findform" role="search">');
    expect(page).toContain('name="find"');
    expect(page).toContain('<button type="submit" class="find-submit">Search</button>');
    // Unrelated parameters ride along on the native form; owned discovery and stale selection do not.
    expect(page).toContain("!HUB_DISCOVERY_PARAMS.includes(name)");
    expect(page).toContain("HUB_SELECTION_PARAMS as readonly string[]).includes(name)");
    expect(page).toContain('{#each preservedParams as [pname, pvalue]');
    // The results are rendered from the loader, so they exist without JavaScript.
    expect(page).toContain("const shown = $derived<HubDiscovery | null>(live ? live.discovery : data.discovery)");
    expect(page).toContain("id={HUB_RESULTS_ID}");
  });

  it("enhances with debounced live results from the same service, writing the same canonical URL", () => {
    expect(page).toContain("fetch(`/api/hub-search?${params}`)");
    expect(page).toContain("}, 250);");
    expect(page).toContain("replaceState(hubHref(params), {})");
    expect(page).toContain("if (seq !== findSeq || !res.ok) return;"); // out-of-order guard; failure keeps the last answer
    expect(page).toContain("withHubTyped(baseParams(), text)");
  });

  it("names each result's type and evidence in words rather than icon or colour alone", () => {
    for (const label of [
      'country: "country"',
      'region: "first-level region"',
      'county: "county or equivalent"',
      'hotspot: "verified eBird hotspot"',
      'reported: "reported location — hotspot status unverified"',
    ])
      expect(page).toContain(label);
    expect(page).toContain('class="hittype" data-type={r.type}');
    expect(page).toContain("evidence: {r.evidence.slice(1).join(\"; \")}");
    for (const state of ["loaded, current", "loaded, outdated", "last load failed", "not verified as a hotspot", "available, not loaded"])
      expect(page).toContain(state);
  });

  it("states the exact total, the result universe, and that zero is not absence", () => {
    expect(page).toContain("Showing {shown.first.toLocaleString()}–{shown.last.toLocaleString()} of");
    expect(page).toContain("{shown.total.toLocaleString()} {shown.total === 1 ? \"match\" : \"matches\"} for");
    expect(page).toContain("not that the place does not exist in");
    expect(page).toContain("Searches reference countries and first-level regions, loaded counties or");
    expect(page).toContain("Searching and\n      selecting a result never loads bird data.");
    expect(page).toContain("verified eBird hotspots, and failed loads");
    expect(page).toContain('<nav class="pagination" aria-label="More discovery results">');
    expect(page).toContain("← Previous");
    expect(page).toContain("Next →");
    expect(page).toContain("Page {shown.page} of {shown.pageCount.toLocaleString()}");
  });

  it("reuses the shared MapPicker with an explicit radius, Apply and Cancel, and no default", () => {
    expect(page).toContain('import MapPicker, { type PickedLocation } from "$components/MapPicker.svelte"');
    expect(page).not.toContain("google-maps");
    expect(page).toContain("<MapPicker bind:selected={picked}");
    expect(page).toContain("initialLabel={shown?.map?.place}");
    expect(page).toContain('let radiusText = $state("")');
    expect(page).toContain("radiusText = shown?.map ? String(shown.map.dist) : \"\"");
    expect(page).not.toMatch(/radiusText = \$state\(["']?\d/);
    expect(page).toContain("const canApply = $derived(picked !== null && radiusValid)");
    expect(page).toContain("disabled={!canApply}");
    expect(page).toContain('<label for="hub-radius">Radius in miles ({GUIDE_RADIUS_MIN}–{GUIDE_RADIUS_MAX})</label>');
    expect(page).toContain("Apply location");
    expect(page).toContain("withHubMap(baseParams(), {");
    // The picker's own search form cannot nest inside the typed search form.
    const typedForm = page.slice(page.indexOf('class="findform"'), page.indexOf("</form>", page.indexOf('class="findform"')));
    expect(typedForm).not.toContain("<MapPicker");
    // Its Search button stays distinct from the typed Search button.
    expect(mapPicker).toContain('"Search place"');
    expect(page).toContain('<button type="submit" class="find-submit">Search</button>');
  });

  it("says map choosing needs JavaScript while typed search and shared map links do not", () => {
    expect(page).toContain("<noscript>");
    expect(page).toContain("Typed search above works without JavaScript. Choosing or moving a map");
    expect(page).toContain("point needs JavaScript; a shared map link still shows its results.");
    expect(page).toContain("{#if jsReady}");
    expect(page).toContain("onMount(() => {");
  });

  it("gives the chooser a named region with focus on open and Cancel focus back on the trigger", () => {
    expect(page).toContain('role="group" aria-labelledby="hub-map-heading"');
    expect(page).toContain('id="hub-map-heading" tabindex="-1"');
    expect(page).toContain("chooserHeading?.focus({ preventScroll: true })");
    expect(page).toContain("aria-controls={chooserId}");
    expect(page).toContain("aria-expanded={mapOpen}");
    expect(page).toMatch(/async function cancelChooser\(\)[\s\S]*?await tick\(\);\s*chooseButton\?\.focus\(\);/);
    const cancel = page.slice(page.indexOf("async function cancelChooser()"), page.indexOf("function applyChooser()"));
    expect(cancel).not.toContain("goto(");
  });

  it("links every selectable result through a named return path to the exact canonical query", () => {
    expect(page).toContain("const returnHref = hubHref(baseParams(), rowId);");
    expect(page).toContain('withReturnTo(hubHotspotPath(target.id), returnHref, undefined, "Hotspots & data")');
    // The destination page offers that path as its immediate back link, even for a same-page selection.
    expect(loader).toContain('returnLink: safeReturnTo(url.searchParams.get("returnTo"), url.searchParams.get("returnLabel"))');
    expect(page).toContain('fallbackHref={data.returnLink.href !== "/" ? data.returnLink.href : "/forecast"}');
    expect(page).toContain('hasExplicitSource={data.returnLink.href !== "/"}');
    expect(page).toContain("Arriving on a row's fragment (a return path) focuses that row.");
    expect(page).toContain('withReturnTo(destination, returnHref, undefined, "Hotspots & data")');
    expect(page).toContain("hubSelectHref(baseParams(), target)");
    // Same focus-restoration convention the inventory rows already use.
    expect(page).toContain("class=\"hublink path-focus-target\"");
    expect(page).toContain("id={resultRowId(r.id)}");
    expect(page).toContain("const resultRowId = (id: string) => `forecast-data-search-${encodeURIComponent(id)}`");
    expect(page).toContain("navigationAction(data.accountId, { label: r.name, originId: resultRowId(r.id) })");
    // Never an external return URL: only the shared, validated builder is used.
    expect(page).not.toMatch(/returnTo=\$\{/);
    // A viewer cannot act on the Load workflow, so that selection is not a link.
    expect(page).toContain('if (target.kind === "load" && data.isViewer) return null;');
    expect(page).toContain("loading is available to the account owner");
  });

  it("summarizes represented areas without claiming containment", () => {
    expect(page).toContain("Areas represented by nearby verified hotspots");
    expect(page).toContain("This does not say the");
    expect(page).toContain("map point lies inside any of them.");
    expect(page).toContain("nearby verified hotspot");
    expect(page).toContain("could not be measured");
    expect(page).toContain("Region\n              centres are never used.");
  });

  it("renders the requested disclosure chain on the server and focuses its target", () => {
    expect(page).toContain("const areaOpen = (id: string) =>");
    expect(page).toContain("const stateOpen = (code: string) =>");
    expect(page).toContain("open={stateOpen(g.stateCode)}");
    expect(page).toContain("open={areaOpen(area.id)}");
    expect(page).toContain("const hasDetail = (code: string) => !!(groupDetail[code] ?? data.focusDetail[code]);");
    expect(page).toContain('<summary id={hubNodeId(g.stateCode)} class="hub-target">');
    expect(page).toContain('<summary id={hubNodeId(s.countryCode)} class="hub-target">');
    expect(page).toContain('<td id={hubNodeId(b.countyCode)} class="hub-target" tabindex="-1">');
    expect(page).toContain('open={data.focus?.kind === "failed"}');
    expect(page).toContain('<li id={hubFailedId(f.locCode)} class="hub-target" class:unverified={f.unverified} tabindex="-1">');
    expect(page).toContain("el.focus({ preventScroll: true })");
    expect(rule(".hub-target {")).toContain("scroll-margin-top: calc(var(--nav-h) + 16px);");
    // A person can still close what a selection opened.
    expect(page).toContain("noteToggle(code, open, focusStates)");
  });

  it("preselects the existing Load form without submitting it, and preserves unrelated parameters", () => {
    expect(page).toContain('<section class="card hub-target" id="load-region">');
    expect(page).toContain('<select id="region-select" name="region" required value={data.preselectRegion ?? ""}>');
    expect(page).toContain("Nothing has been loaded; choose <em>Load data</em> below if you want it.");
    expect(page).toContain('for (const name of ["region", "show"]) next.delete(name);');
    // The form still needs the person's own submit: nothing auto-submits.
    expect(page).not.toMatch(/requestSubmit|\.submit\(\)/);
    expect(loader).not.toMatch(/enqueueJob\(.*discovery|hubDiscover[\s\S]{0,80}enqueueJob/);
  });

  it("keeps every touched control at 48px and every text input at 16px, with no horizontal overflow", () => {
    expect(rule(".hubsearch {")).toMatch(/min-height: 48px;[\s\S]*font-size: 1rem;/);
    expect(rule(".radius-field input")).toMatch(/min-height: 48px;[\s\S]*font-size: 1rem;/);
    expect(rule(".find-submit,")).toContain("min-height: 48px;");
    expect(rule(".pagination a,")).toContain("min-height: 48px;");
    expect(rule(".hublink {")).toContain("min-height: 48px;");
    expect(rule(".hub-hits li {") ?? "").toBeDefined();
    expect(page).toMatch(/\.hub-areas li,\s*\.hub-hits li \{[\s\S]*?min-height: 48px;/);
    expect(rule(".chooser {")).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(rule(".map-chooser {")).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(rule(".hitmain {")).toContain("overflow-wrap: anywhere;");
    expect(rule(".hitmeta {")).toContain("overflow-wrap: anywhere;");
    expect(rule(".chooser p")).toContain("overflow-wrap: anywhere;");
  });

  it("keeps the unverified label visible on the hotspot workspace a reported location opens", () => {
    expect(workspace).toContain("{#if !data.verified}");
    expect(workspace).toContain("reported location — hotspot status unverified");
    // Never a verified-hotspot presentation for it.
    expect(workspace).toContain("{#if data.verified}<Badge kind=\"notable\" label=\"eBird hotspot\" />{/if}");
  });

  it("no longer imports or ships the capped search", () => {
    expect(page).not.toContain("HUB_SEARCH_LIMIT");
    expect(page).not.toContain("hubCapped");
    expect(loader).not.toContain("hubSearch(");
  });

  it("keeps a discovery or selection view local-only: no eBird fan-out and no counts fetch until the person acts", () => {
    // Server: the region-list fan-out is skipped whenever the URL carries discovery or selection state.
    expect(loader).toMatch(/const offlineView =\s*parsedDiscovery\.state\.mode !== "none" \|\| !!showParam \|\| !!regionParam \|\| !!countryParamRaw;/);
    expect(loader).toContain('const countryParamRaw = singleParam("country");');
    expect(loader).toContain('(childLvl === "subnational2" && (!apiKey || offlineView))');
    expect(loader).toMatch(/offlineView,\n\s+focus,/);
    // Client: hotspot tallies (an eBird-backed API) wait for a real interaction, tracked without reactivity.
    expect(page).toContain("let engaged = false;");
    expect(page).not.toMatch(/let engaged = \$state/);
    expect(page).toContain('window.addEventListener("pointerdown", mark, { capture: true, passive: true });');
    expect(page).toContain('window.addEventListener("keydown", mark, { capture: true, passive: true });');
    expect(page).toContain("if (data.offlineView && !engaged) return;");
    // Structurally, not only by timing: the restore effect never fetches on an offline view, and a
    // landing's own initial opens are not a person's action (closing then reopening is).
    expect(page).toContain("if (!data.offlineView) void loadHotspotCounts(code);");
    expect(page).toContain("const landingOpen = open && focusStates.has(code) && !dismissed.includes(code);");
    expect(page).toContain("if (!landingOpen) void loadHotspotCounts(code);");
    expect(page.indexOf("const landingOpen")).toBeLessThan(page.indexOf("noteToggle(code, open, focusStates)"));
    // A skipped fetch is not remembered as done, so a later explicit open can still fetch.
    const guard = page.indexOf("if (data.offlineView && !engaged) return;");
    expect(guard).toBeGreaterThan(page.indexOf("countsFetched.has(regionCode)) return;"));
    expect(guard).toBeLessThan(page.indexOf("countsFetched.add(regionCode);"));
    // Said out loud, with a way back to the full inventory.
    // Worded to stay true after interaction: it is the OPENING view that is local-only.
    expect(page).toContain("This search or selection view did not contact eBird when it opened");
    expect(page).toContain("Explicitly opening inventory groups below may request current");
    expect(page).not.toContain("does not contact eBird, so");
    expect(page).toContain("<a href={fullViewHref}>Open the full inventory</a>");
    // Hotspot results open the local-only tab.
    expect(page).toContain("hubHotspotPath(target.id)");
  });

  it("never links a hotspot from this page to the default live-observations tab", () => {
    // Every hotspot link (results, summaries and the auto-opened inventory rows) goes through the local-only builder.
    expect(page).toContain("withReturnTo(hubHotspotPath(r.locCode),page.url.pathname + page.url.search + page.url.hash,undefined,'Hotspots & data')");
    expect(page).not.toMatch(/`\/hotspots\//);
    expect(page).not.toContain('href="/hotspots/');
    expect(page.match(/hubHotspotPath\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("routes a reported location to the failed-load recovery row and labels that row", () => {
    expect(page).toContain("open={data.focus?.kind === \"failed\"}");
    expect(page).toContain('<span class="unverified-tag">reported location — hotspot status unverified</span>');
    expect(page).toContain("Retrying reloads history; it does not verify that this is a hotspot or say anything about public access.");
    // The service, not the page, decides the target: a reported location never gets a hotspot target.
    const service = readFileSync("src/lib/server/hub-discovery.ts", "utf8");
    const reported = service.slice(service.indexOf('evidence: [EVIDENCE_LABEL.reported]'), service.indexOf("evidenceRank: 3"));
    expect(reported).toContain('target: { kind: "failed", code: a.loc_code }');
    expect(reported).not.toContain('kind: "hotspot"');
  });

  it("makes a verified hotspot and a reported location visibly distinct beyond wording and colour", () => {
    expect(rule('.hub-hit[data-type="hotspot"]')).toContain("border-left: 4px solid var(--accent);");
    expect(page).toMatch(/\.hub-hit\[data-type="reported"\],\s*\.failed li\.unverified \{[\s\S]*?border-left: 4px dashed var\(--muted\);/);
    expect(rule('.hittype[data-type="hotspot"]::before')).toContain('content: "✓ ";');
    expect(page).toMatch(/\.hittype\[data-type="reported"\]::before,\s*\.unverified-tag::before \{\s*content: "⚠ ";/);
  });

  it("displays the submitted text while searching on the normalized text", () => {
    expect(page).toContain("data.discovery.submitted ?? data.discovery.find");
    expect(page).toContain("“{shown.submitted ?? shown.find}”");
    expect(page).toContain("No local match for “{shown.submitted ?? shown.find}”.");
  });

  it("keeps the hotspot workspace's unverified state plain: no venues, no eBird hotspot link, no verified actions", () => {
    expect(workspace).toContain("{#if data.verified && data.venueTypes.length > 0}");
    expect(workspace).toContain("{#if !data.known || !data.verified}");
    const plain = workspace.slice(workspace.indexOf("{#if !data.known || !data.verified}"), workspace.indexOf('<section class="card actions">'));
    for (const forbidden of ["ebird.org/hotspot", "mapsHref", "directionsHref", "tripHref", "forecastHref", "Badge", "venue"])
      expect(plain.includes(forbidden), forbidden).toBe(false);
    expect(plain).toContain("does not verify that the ID is a");
    expect(plain).toContain("Verify it with eBird before loading historical data.");
    // The owner-only explicit verify-and-load action remains, worded precisely.
    expect(plain).toContain('{#if !data.isViewer}');
    expect(plain).toContain('action={actionHref("load_hotspot")}');
    expect(plain).toContain("Verify hotspot and load history");
    expect(plain).toContain("This verifies eBird hotspot");
    expect(plain).toContain("identity only; it does not establish public access.");
    expect(plain).toContain("Viewer accounts cannot verify or queue historical loads.");
    // The eBird hotspot link and the data tabs exist only in the verified branch.
    const verifiedBranch = workspace.slice(workspace.indexOf('<section class="card actions">'));
    expect(verifiedBranch).toContain("https://ebird.org/hotspot/");
    expect(verifiedBranch).toContain('<nav class="tabs" aria-label="Hotspot data">');
    expect(workspace.slice(0, workspace.indexOf('<section class="card actions">'))).not.toContain('<nav class="tabs"');
  });
});
