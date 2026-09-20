<script lang="ts">
  import FieldGuideTabs from "$components/FieldGuideTabs.svelte";
  import GuideSpeciesRow from "$components/GuideSpeciesRow.svelte";
  import { page } from "$app/state";
  import { navigationAction } from "$lib/navigation-context.svelte";
  import { withReturnTo } from "$lib/navigation-context";
  import PathNavigation from "$components/PathNavigation.svelte";
  import MapPicker, { type PickedLocation } from "$components/MapPicker.svelte";
  import { goto } from "$app/navigation";
  import { onMount, tick } from "svelte";
  import {
    GUIDE_LOCATION_PARAMS,
    GUIDE_WAS_PARAMS,
    GUIDE_RADIUS_MAX,
    GUIDE_RADIUS_MIN,
    clearGuideLocation,
    descendantsOf,
    guideCoverage,
    guideLocationPairs,
    guideMapHref,
    guideResultsHref,
    guideScopeText,
    guideWasPairs,
    type GuideLevel,
  } from "$lib/guide-location";
  import {
    TAG_DIMENSIONS,
    TAG_VOCABULARY,
    dimensionLabel,
    tagLabel,
    type TagDimension,
  } from "$lib/species-tags";
  import {
    GUIDE_LISTS,
    GUIDE_LIST_LABEL,
    GUIDE_LIST_MEANING,
    GUIDE_LIST_NOUN,
    guideListHref,
    type GuideList,
  } from "$lib/guide-list";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const selected = $derived(new Set(data.tags));
  const ownedParams = new Set([
    "q",
    "interest",
    "family",
    "sort",
    "tags",
    "page",
    ...GUIDE_LOCATION_PARAMS,
    ...GUIDE_WAS_PARAMS,
  ]);
  const unknownParams = $derived(
    [...page.url.searchParams].filter(([key]) => !ownedParams.has(key)),
  );
  let filtersOpen = $state(false);
  /** Enhanced auto-submit: a changed level clears every deeper level first,
   * matching the server contract. Apply filters stays the native fallback. */
  function levelChanged(event: Event, level: GuideLevel) {
    const form = (event.currentTarget as HTMLSelectElement).form!;
    for (const lower of descendantsOf(level)) {
      const control = form.elements.namedItem(lower) as HTMLSelectElement | null;
      if (control) control.value = "";
    }
    form.requestSubmit();
  }

  // List scope control (Phase 9A): links, so it works without JavaScript. A scope
  // switch removes only the stale page and keeps every other parameter.
  const listHref = (list: GuideList) => guideListHref(page.url.searchParams, list);
  const scopeNoun = $derived(GUIDE_LIST_NOUN[data.list]);

  // The current geography as canonical hidden pairs for the native forms.
  const locationPairs = $derived(guideLocationPairs(data.selection));
  const clearLocationHref = $derived(
    guideResultsHref(clearGuideLocation(page.url.searchParams)),
  );
  const coverage = $derived(data.location ? guideCoverage(data.location) : null);

  // Map + radius chooser. Creating a marker needs JavaScript, so the control
  // only appears once the page has hydrated; a <noscript> note explains it.
  const chooserId = "guide-map-chooser";
  let jsReady = $state(false);
  onMount(() => {
    jsReady = true;
  });
  let mapOpen = $state(false);
  let picked = $state<PickedLocation | null>(null);
  let radiusText = $state("");
  let applyError = $state("");
  let chooseButton = $state<HTMLButtonElement | undefined>();
  let chooserHeading = $state<HTMLHeadingElement | undefined>();
  const radiusValid = $derived(
    /^\d+$/.test(radiusText.trim()) &&
      Number(radiusText) >= GUIDE_RADIUS_MIN &&
      Number(radiusText) <= GUIDE_RADIUS_MAX,
  );
  const canApply = $derived(picked !== null && radiusValid);

  async function openChooser() {
    picked = null;
    applyError = "";
    // No saved or default radius: only an already-applied circle is shown.
    radiusText = data.map ? String(data.map.dist) : "";
    mapOpen = true;
    await tick();
    chooserHeading?.focus({ preventScroll: true });
    chooserHeading?.scrollIntoView({ block: "start" });
  }

  async function cancelChooser() {
    mapOpen = false;
    picked = null;
    radiusText = "";
    applyError = "";
    await tick();
    chooseButton?.focus();
  }

  function applyChooser() {
    if (!picked || !radiusValid) return;
    const built = guideMapHref(page.url.searchParams, {
      place: picked.label,
      lat: picked.lat,
      lng: picked.lng,
      dist: Number(radiusText),
    });
    if (!built.ok) {
      applyError = built.message;
      return;
    }
    mapOpen = false;
    picked = null;
    radiusText = "";
    applyError = "";
    goto(built.href);
  }

  /** Toggle URL for a tag chip — GET-driven, restorable, no client state. */
  function toggleHref(tag: string): string {
    const p = new URLSearchParams(page.url.searchParams);
    p.delete("tags");
    p.delete("page");
    const next = selected.has(tag)
      ? data.tags.filter((t) => t !== tag)
      : [...data.tags, tag];
    for (const t of next) p.append("tags", t);
    const s = p.toString();
    return `${s ? `/species?${s}` : "/species"}#results`;
  }

  function clearHref(): string {
    const p = new URLSearchParams(page.url.searchParams);
    for (const key of ownedParams) p.delete(key);
    const s = p.toString();
    return `${s ? `/species?${s}` : "/species"}#results`;
  }

  function activeFilterCount(): number {
    return Number(data.interestOnly) + Number(!!data.family) +
      Number(data.sort !== "relevance") + Number(!!data.location) + data.tags.length;
  }

  function detailHref(code: string): string {
    return withReturnTo(
      `/species/${encodeURIComponent(code)}`,
      // URL fragments are not sent to the server, so `page.url.hash` is empty
      // in SSR output even when the incoming browser URL ended at #results.
      // Every result row returns to this route's stable results target.
      page.url.pathname + page.url.search + "#results",
      undefined,
      "Field guide",
    );
  }
  function speciesAction(code: string, label: string) {
    return navigationAction(data.user?.id, {
      label,
      originId: `guide-species-${encodeURIComponent(code)}`,
    });
  }

  function tagDimension(tag: string): TagDimension {
    return tag.split(":")[0] as TagDimension;
  }
</script>

<svelte:head>
  <title>Field guide — birds</title>
</svelte:head>

<div class="page">
  <PathNavigation accountId={data.user?.id} label="Field guide" href={page.url.pathname + page.url.search + page.url.hash} fallbackHref="/" fallbackLabel="Home" hideWhenNoPath />
  <header class="page-head">
    <h1>📖 Field guide</h1>
    <p class="sub">
      Search {data.counts.taxonomy} species by name or code;
      {data.counts.withWikipedia} have Wikipedia notes{data.counts.annotated > 0
        ? ` and ${data.counts.annotated} have AI field craft`
        : ""}.
    </p>
    <a class="history-link" href="/viewed">◉ Viewed species</a>
    {#if data.viewedUnavailable}<p role="status">Viewing history is temporarily unavailable.</p>{/if}
  </header>

  <FieldGuideTabs active="browse" />
  <nav class="list-scope" aria-label="Species list: All, Need or Seen">
    {#each GUIDE_LISTS as list (list)}
      <a
        id={`guide-list-${list}`}
        class:current={data.list === list}
        href={listHref(list)}
        aria-current={data.list === list ? "true" : undefined}
        title={GUIDE_LIST_MEANING[list]}
        ><span class="list-mark" aria-hidden="true">{data.list === list ? "●" : "○"}</span>{GUIDE_LIST_LABEL[list]}</a
      >
    {/each}
  </nav>
  {#if data.interests === null}<p role="status">Special interest badges are temporarily unavailable.</p>{/if}
  {#if data.interestOnly}<p>Your saved species matching the filters below. <a href="/special-interest">Open the complete collection</a>, including any retired species.</p>{/if}

  <section class="card guide-search">
    <form method="GET" action="/species#results" class="searchform">
      {#each unknownParams as [key, value], index (`search-${index}-${key}-${value}`)}
        <input type="hidden" name={key} value={value} />
      {/each}
      {#if data.interestOnly}<input type="hidden" name="interest" value="1" />{/if}
      {#if data.family}<input type="hidden" name="family" value={data.family} />{/if}
      {#if data.sort !== "relevance"}<input type="hidden" name="sort" value={data.sort} />{/if}
      {#each locationPairs as [locName, locValue] (locName)}<input type="hidden" name={locName} value={locValue} />{/each}
      {#each data.tags as t (t)}<input type="hidden" name="tags" value={t} />{/each}
      <div class="search-entry">
        <input
          type="search"
          name="q"
          value={data.q}
          placeholder="Shoebill, mudflats, granary trees…"
          aria-label="Search species"
        />
        <button type="submit">Search</button>
      </div>
    </form>
    <p class="search-help muted">
      Searches common and scientific names and eBird/banding codes first, then Wikipedia text, field notes and tags when available.
    </p>

    {#if data.active}
      <div class="scope-summary" aria-label="Current Field Guide search and filters">
        {#if data.location && coverage?.status === "unavailable"}
          <strong>{scopeNoun} unavailable for this location</strong>
        {:else if data.results.length > 0}
          <strong>Showing {(data.page - 1) * 100 + 1}–{(data.page - 1) * 100 + data.results.length} of {data.total} {scopeNoun}</strong>
        {:else if data.list === "all"}
          <strong>No species match these filters</strong>
        {:else}
          <strong>No {scopeNoun} match these filters</strong>
        {/if}
        <div class="scope-items">
          <span>List: {GUIDE_LIST_LABEL[data.list]}</span>
          {#if data.q}<span>Search: “{data.q}”</span>{/if}
          {#if data.location}<span>{guideScopeText(data.location)}</span>{/if}
          {#if data.family}<span>Family: {data.families.find((f) => f.code === data.family)?.name ?? data.family}</span>{/if}
          {#if data.interestOnly}<span>Special interest only</span>{/if}
          {#if data.sort !== "relevance"}<span>Sort: {data.sort === "name" ? "Alphabetical" : "Taxonomic"}</span>{/if}
        </div>
        {#if data.location && coverage}<p class="coverage" role="status">{coverage.text}{#if coverage.status === "unavailable"} <a href="/forecast/data">Load an area in Hotspots &amp; data</a> to search here.{/if}</p>{/if}
        {#if data.tags.length > 0}
          <div class="active-filters">
            <span class="muted af-label">Match all selected tags:</span>
            {#each data.tags as t (t)}
              <a class="chip chip-active" class:chip-tide={tagDimension(t) === "tide"} href={toggleHref(t)} title="Remove filter">
                {tagLabel(tagDimension(t), t.split(":")[1])} ✕
              </a>
            {/each}
          </div>
        {/if}
        <div class="scope-actions">
          {#if data.location}<a class="clear-filters" href={clearLocationHref}>Clear location only</a>{/if}
          <a class="clear-filters" href={clearHref()}>Clear all search and filters</a>
        </div>
      </div>
    {:else}
      <p class="muted scope-summary">Enter a search or use Filters and sort to browse the current taxonomy.</p>
    {/if}
  </section>

  <section class="card filter-card">
    <details class="filters" bind:open={filtersOpen}>
      <summary>Filters and sort{activeFilterCount() ? ` (${activeFilterCount()} active)` : ""}</summary>
      <form method="GET" action="/species#results" class="filter-form">
        {#each unknownParams as [key, value], index (`filter-${index}-${key}-${value}`)}<input type="hidden" name={key} value={value} />{/each}
        {#if data.q}<input type="hidden" name="q" value={data.q} />{/if}
        {#each data.tags as t (t)}<input type="hidden" name="tags" value={t} />{/each}
        <label class="interest-filter"><input type="checkbox" name="interest" value="1" checked={data.interestOnly} /> Special interest only</label>
        <div class="location-fields">
          <div class="location-field"><label for="guide-family">Bird family</label><select id="guide-family" name="family" value={data.family}><option value="">All families</option>{#each data.families as family}<option value={family.code}>{family.name ?? family.scientificName ?? family.code}{family.name && family.scientificName ? ` (${family.scientificName})` : ''}</option>{/each}</select></div>
          <div class="location-field"><label for="guide-sort">Sort</label><select id="guide-sort" name="sort" value={data.sort}><option value="relevance">Relevance</option><option value="name">Alphabetical</option><option value="taxonomic" disabled={!data.taxonomyAvailable}>Taxonomic order</option></select></div>
        </div>
        {#if !data.taxonomyAvailable}<p class="muted">Classification and taxonomic ordering await a taxonomy refresh.</p>{/if}
        <fieldset class="geo">
          <legend>Location</legend>
          {#if data.selection.kind === "map" && data.map}
            {#each locationPairs as [locName, locValue] (locName)}<input type="hidden" name={locName} value={locValue} />{/each}
            <p class="geo-map">Map point: <strong>{data.map.place}</strong>, within {data.map.dist} {data.map.dist === 1 ? "mile" : "miles"}.</p>
            <a class="clear-filters" href={clearLocationHref}>Clear location to choose a country, state, county or hotspot</a>
          {:else}
            {#each guideWasPairs(data.selection) as [wasName, wasValue] (wasName)}<input type="hidden" name={wasName} value={wasValue} />{/each}
            <div class="location-fields">
              <div class="location-field"><label for="guide-country">Country</label><select id="guide-country" name="country" value={data.country} onchange={(e) => levelChanged(e, "country")}><option value="">Anywhere</option>{#each data.countries as c (c.code)}<option value={c.code}>{c.name}</option>{/each}</select></div>
              <div class="location-field"><label for="guide-region">State / region</label><select id="guide-region" name="region" value={data.region} disabled={!data.country || data.regions.length === 0} onchange={(e) => levelChanged(e, "region")}><option value="">{data.country ? "Anywhere in this country" : "Choose a country first"}</option>{#each data.regions as r (r.code)}<option value={r.code}>{r.name}</option>{/each}</select></div>
              <div class="location-field"><label for="guide-county">County / equivalent</label><select id="guide-county" name="county" value={data.county} disabled={!data.region || data.counties.length === 0} onchange={(e) => levelChanged(e, "county")}><option value="">{!data.region ? "Choose a state or region first" : data.counties.length === 0 ? "No loaded counties" : "Anywhere in this state or region"}</option>{#each data.counties as c (c.code)}<option value={c.code}>{c.name}</option>{/each}</select></div>
              <div class="location-field"><label for="guide-hotspot">Verified hotspot</label><select id="guide-hotspot" name="hotspot" value={data.hotspot} disabled={!data.county || data.hotspots.length === 0} onchange={(e) => levelChanged(e, "hotspot")}><option value="">{!data.county ? "Choose a county first" : data.hotspots.length === 0 ? "No loaded hotspots" : "Anywhere in this county"}</option>{#each data.hotspots as h (h.code)}<option value={h.code}>{h.name}</option>{/each}</select></div>
            </div>
            {#if data.region && data.counties.length === 0}<p class="location-hint muted">No county data is loaded for this state or region. <a href="/forecast/data">Load an area in Hotspots &amp; data</a> to choose a county.</p>{/if}
            {#if data.county && data.hotspots.length === 0}<p class="location-hint muted">No hotspot data is loaded for this county. <a href="/forecast/data">Load an area in Hotspots &amp; data</a> to choose a hotspot.</p>{/if}
          {/if}
        </fieldset>
        <p class="location-hint muted">Optional: birds reported in this location at any time of year.</p>
        {#each TAG_DIMENSIONS as d (d)}
          <details class="dim"><summary>{dimensionLabel(d)}</summary><div class="chips">{#each TAG_VOCABULARY[d] as v (v)}{@const tag = `${d}:${v}`}<a class="chip" class:chip-on={selected.has(tag)} class:chip-tide={d === "tide"} href={toggleHref(tag)}>{tagLabel(d, v)}</a>{/each}</div></details>
        {/each}
        <button class="apply-filters" type="submit">Apply filters</button>
      </form>
      <section class="map-chooser" aria-labelledby="guide-map-label">
        <p id="guide-map-label" class="map-label">Or choose a point on the map</p>
        <noscript><p class="muted">Choosing or moving a map point needs JavaScript. The country, state, county and hotspot choices above work without it, and a shared map link still filters the results.</p></noscript>
        {#if jsReady}
          <button type="button" class="secondary" bind:this={chooseButton} hidden={mapOpen} aria-expanded={mapOpen} aria-controls={chooserId} onclick={openChooser}>Choose on map</button>
        {/if}
        {#if mapOpen}
          <div id={chooserId} class="chooser" role="group" aria-labelledby="guide-map-heading">
            <h3 bind:this={chooserHeading} id="guide-map-heading" tabindex="-1">Choose a map point and radius</h3>
            <p class="muted">Search for a place or tap the map, then enter a radius. The result covers only loaded eBird hotspots with recorded coordinates inside the circle; the part of the map you can see is never a boundary.</p>
            <MapPicker bind:selected={picked} initialLat={data.map?.lat ?? null} initialLng={data.map?.lng ?? null} initialLabel={data.map?.place} />
            <p class="picked">{picked ? `Chosen point: ${picked.label}` : "No point chosen yet."}</p>
            <div class="radius-field">
              <label for="guide-radius">Radius in miles ({GUIDE_RADIUS_MIN}–{GUIDE_RADIUS_MAX})</label>
              <input id="guide-radius" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" bind:value={radiusText} aria-describedby="guide-apply-help" aria-invalid={radiusText.trim() !== "" && !radiusValid} />
            </div>
            <p id="guide-apply-help" class="muted">{canApply ? "Ready to apply." : `Choose a point on the map and enter a whole number of miles from ${GUIDE_RADIUS_MIN} to ${GUIDE_RADIUS_MAX}.`}</p>
            {#if applyError}<p class="err" role="alert">{applyError}</p>{/if}
            <div class="chooser-actions">
              <button type="button" class="apply-filters" disabled={!canApply} onclick={applyChooser}>Apply location</button>
              <button type="button" class="secondary" onclick={cancelChooser}>Cancel</button>
            </div>
          </div>
        {/if}
      </section>
    </details>
  </section>

  {#if data.active}
    {#if data.results.length === 0}
      <section class="card" id="results">
        {#if data.location?.sourceCount === 0}
          <p class="muted">
            Location coverage is unavailable; this does not mean there are no
            birds here. <a href="/forecast/data">Load an area in Hotspots &amp; data</a>.
          </p>
        {:else if data.counts.taxonomy === 0}
          <p class="muted">
            No species taxonomy loaded yet. Sync eBird taxonomy from
            <a href="/settings">Settings</a> or load a forecast area on
            <a href="/forecast/data">Hotspots &amp; data</a>.
          </p>
        {:else if data.list !== "all"}
          <p class="muted">
            No {scopeNoun} match these filters{data.location ? ` in the stored data for ${data.location.label}` : ""}.
            This is a list-scope result, not an answer about the place:
            {#each GUIDE_LISTS.filter((l) => l !== data.list) as other, i (other)}{i > 0 ? " or " : ""}<a href={listHref(other)}>choose {GUIDE_LIST_LABEL[other]}</a>{/each}
            to see the other species that match. Choosing All includes every matching species.
          </p>
        {:else if data.interestOnly}
          <p>No saved species match these filters. Save birds with ☆ Special interest on their species pages, or <a href="/special-interest">open your complete collection</a>.</p>
        {:else}
          <p class="muted">
            No species match{data.q ? ` "${data.q}"` : ""}{data.tags.length > 0
              ? " with every selected tag"
              : ""}{data.location
              ? ` in the stored data for ${data.location.label}`
              : ""}.
            {data.tags.length > 0
              ? "Try fewer tags or a broader search — tags come from AI annotation, which is still filling in."
              : "Try a different name, species code, or description."}
          </p>
        {/if}
      </section>
    {:else}
      <section class="card results" id="results">
        {#each data.results as r (r.species_code)}
          <GuideSpeciesRow
            row={r}
            href={detailHref(r.species_code)}
            onclick={speciesAction(r.species_code, r.com_name)}
            selectedTags={selected}
            interest={data.interests?.includes(r.species_code) ?? false}
            viewed={data.viewed[r.species_code]}
          />
        {/each}
      </section>
      <nav class="pagination" aria-label="More results pages">{#if data.previous}<a href={data.previous}>← Previous</a>{/if}<span>Page {data.page}</span>{#if data.next}<a href={data.next}>Next →</a>{/if}</nav>
    {/if}
  {:else}
    <section class="card" id="results">
      <p class="muted">
        Choose a family or location, pick tags above, or type a search — try
        <a href="/species?tags=habitat%3Amudflat&tags=tide%3Alow"
          >mudflat birds at low tide</a
        >
        or
        <a href="/species?tags=find%3Aheard-more-than-seen"
          >birds you hear more than see</a
        >.
      </p>
    </section>
  {/if}

  <p class="attribution">
    Species text from
    <a href="https://en.wikipedia.org" target="_blank" rel="noopener"
      >Wikipedia</a
    >
    where available (CC BY-SA 4.0) · data from
    <a href="https://ebird.org" target="_blank" rel="noopener">eBird.org</a>
  </p>
</div>

<style>
  .interest-filter { display:flex; align-items:center; gap:8px; min-height:48px; cursor:pointer; }
  .interest-filter input { width:24px; height:24px; min-height:24px; }
 .pagination { display:flex; flex-wrap:wrap; align-items:center; gap:16px; margin:12px 0; }
 .pagination a { min-height:48px; display:inline-flex; align-items:center; }
  .history-link { display:inline-flex; align-items:center; min-height:48px; }
  .page {
    max-width: 860px;
    margin: 0 auto;
    padding: 16px;
  }
  .page-head {
    margin: 4px 0 16px;
  }
  h1 {
    font-size: 1.4rem;
  }
  .sub,
  .muted {
    color: var(--muted);
    font-size: 0.89rem;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .searchform {
    display: grid;
    gap: 12px;
    margin-bottom: 10px;
  }
  .search-help { margin: 0; }
  .scope-summary {
    display: grid;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .scope-items { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--muted); font-size: 0.89rem; }
  .clear-filters { display: inline-flex; align-items: center; min-height: 48px; width: fit-content; }
  .coverage { margin: 0; font-size: 0.89rem; overflow-wrap: anywhere; }
  .coverage a { display: inline-flex; align-items: center; min-height: 48px; }
  .scope-actions { display: flex; flex-wrap: wrap; gap: 0 16px; }
  .geo { border: 0; margin: 0; padding: 0; min-width: 0; display: grid; gap: 12px; }
  .geo legend { padding: 0; font-size: 0.89rem; font-weight: 600; margin-bottom: 8px; }
  .geo-map { margin: 0; overflow-wrap: anywhere; }
  .map-chooser { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 12px 0 16px; border-top: 1px solid var(--border); }
  .map-label { margin: 0; font-weight: 600; }
  .map-chooser button.secondary,
  .chooser-actions button {
    min-height: 48px;
    padding: 10px 18px;
    border-radius: 8px;
    font-weight: 600;
  }
  .map-chooser button.secondary { width: fit-content; background: var(--card); color: var(--accent); border: 1px solid var(--accent); }
  /* minmax(0, 1fr): an auto column would size to the picker's intrinsic search
     row and push it past a 320px viewport. */
  .chooser { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; min-width: 0; }
  .chooser h3 { margin: 0; font-size: 1.05rem; scroll-margin-top: calc(var(--nav-h) + 16px); }
  .chooser p { margin: 0; overflow-wrap: anywhere; }
  .picked { font-weight: 600; }
  .radius-field { display: grid; gap: 4px; font-size: 0.89rem; font-weight: 600; }
  .radius-field input {
    min-height: 48px;
    max-width: 12rem;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    font-size: 1rem;
  }
  .chooser-actions { display: flex; flex-wrap: wrap; gap: 10px; }
  .chooser-actions .secondary { background: var(--card); color: var(--accent); border: 1px solid var(--accent); }
  .chooser-actions .apply-filters:disabled { opacity: 0.5; }
  .err { color: var(--danger); font-weight: 600; }
  .list-scope { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
  .list-scope a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 48px;
    padding: 8px 18px;
    border: 1px solid var(--border);
    border-radius: 24px;
    background: var(--bg);
    color: var(--text);
    font-weight: 600;
    text-decoration: none;
  }
  /* The selected scope differs in shape (filled mark, heavier border), not colour alone. */
  .list-scope a.current { border: 2px solid var(--accent); background: var(--card); color: var(--accent); }
  .list-scope a:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .filter-card { padding: 0 16px; margin-bottom: 4px; }
  .filters > summary {
    min-height: 48px;
    display: flex;
    align-items: center;
    cursor: pointer;
    font-weight: 600;
    list-style: none;
  }
  .filters > summary::-webkit-details-marker { display: none; }
  .filters > summary::after { content: "▸"; margin-left: auto; color: var(--accent); font-size: 1.1em; }
  .filters[open] > summary::after { content: "▾"; }
  .filter-form { display: grid; gap: 12px; padding-bottom: 16px; }
  .apply-filters { min-height: 48px; padding: 10px 18px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: var(--on-accent); font-weight: 600; }
  .search-entry {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .searchform input[type="search"] {
    flex: 1;
    min-width: 200px;
    min-height: 48px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    font-size: 1rem; /* prevents iOS focus zoom (GROK contract) */
  }
  .searchform button {
    min-height: 48px;
    padding: 10px 18px;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
  }
  .location-fields {
    display: grid;
    gap: 12px;
  }
  .location-field {
    position: relative;
    display: grid;
    gap: 4px;
    font-size: 0.89rem;
    font-weight: 600;
    min-width: 0;
  }
  .location-fields select {
    appearance: none;
    width: 100%;
    min-width: 0;
    min-height: 48px;
    padding: 8px 32px 8px 12px;
    font-size: 1rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .location-field::after {
    content: "";
    position: absolute;
    right: 16px;
    bottom: 21px;
    width: 8px;
    height: 8px;
    border-right: 2px solid var(--muted);
    border-bottom: 2px solid var(--muted);
    transform: rotate(45deg);
    pointer-events: none;
  }
  .location-hint {
    font-size: 0.89rem;
    margin: 8px 0 12px;
  }
  @media (min-width: 640px) {
    .location-fields {
      grid-template-columns: 1fr 1fr;
    }
  }
  .active-filters {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  .af-label {
    font-weight: 600;
  }
  .dim summary {
    min-height: 48px;
    display: flex;
    align-items: center;
    cursor: pointer;
    font-weight: 600;
    list-style: none;
  }
  .dim summary::-webkit-details-marker {
    display: none;
  }
  .dim summary::after {
    content: "▸";
    margin-left: auto;
    padding-left: 12px;
    color: var(--accent);
    font-size: 1.1em;
  }
  .dim[open] summary::after {
    content: "▾";
  }
  .dim + .dim {
    border-top: 1px solid var(--border);
  }
  .chips {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    padding: 4px 0 12px;
  }
  /* Interactive chips: 48px tap targets (cs.md family rule — these ARE
     controls, unlike the display chips on the species page). */
  .chip {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    padding: 8px 16px;
    border-radius: 24px;
    font-size: 0.85rem;
    font-weight: 600;
    background: var(--bg);
    color: var(--tag-text);
    border: 1px solid var(--tag-border);
    text-decoration: none;
  }
  .chip-on,
  .chip-active {
    background: #1d4a35;
    color: #f2f7f4;
    border-color: var(--tag-text);
  }
  .chip-tide {
    color: var(--info-text);
    border-color: var(--info-border);
  }
  .chip-tide.chip-on,
  .chip-tide.chip-active {
    background: #163e5e;
    color: #eef5fb;
    border-color: var(--info-text);
  }
  .results {
    padding: 4px 0;
  }
  @media (hover: hover) {
    .chip:hover {
      border-color: var(--accent);
    }
  }
  .attribution {
    text-align: center;
    color: var(--muted);
    font-size: 0.78rem;
    padding: 20px 0 8px;
  }
  .attribution a {
    color: var(--muted);
  }
  /* The tags the user filtered by light up on each hit. */
</style>
