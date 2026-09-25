<script lang="ts">
  import FieldGuideTabs from "$components/FieldGuideTabs.svelte";
  import GuideSpeciesRow from "$components/GuideSpeciesRow.svelte";
  import { page } from "$app/state";
  import { browser } from "$app/environment";
  import { navigationAction } from "$lib/navigation-context.svelte";
  import { withReturnTo } from "$lib/navigation-context";
  import PathNavigation from "$components/PathNavigation.svelte";
  import MapPicker, { type PickedLocation } from "$components/MapPicker.svelte";
  import SearchableSelect from "$components/SearchableSelect.svelte";
  import { onMount, tick, untrack } from "svelte";
  import {
    GUIDE_LOCATION_PARAMS,
    GUIDE_WAS_PARAMS,
    GUIDE_RADIUS_MAX,
    GUIDE_RADIUS_MIN,
    clearGuideLocation,
    guideCoverage,
    guideLocationPairs,
    guideMapSelection,
    guideResultsHref,
    guideScopeText,
    guideWasPairs,
    type GuideChoicesLevel,
    type GuideLevel,
    type GuideLocationSelection,
  } from "$lib/guide-location";
  import {
    PlaceChoiceLoader,
    childLevel,
    fetchGuideChoices,
    guideDraftKey,
    placeLevels,
    toggledTag,
    withDraftLevel,
    type GuideDraft,
  } from "$lib/guide-draft";
  import type { PlaceChoice } from "$lib/place-filter";
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

  // ---- Draft filters (td-daff98) ------------------------------------------
  // Every control in Filters and sort edits this draft; only Apply filters runs
  // the search. The applied state is what the loader normalized.
  const applied = $derived<GuideDraft>({
    interest: data.interestOnly,
    family: data.family,
    sort: data.sort as GuideDraft["sort"],
    tags: [...data.tags].sort(),
    place: data.selection,
  });
  const copyDraft = (d: GuideDraft): GuideDraft => ({ ...d, tags: [...d.tags], place: { ...d.place } });
  let draft = $state<GuideDraft>(untrack(() => copyDraft(applied)));
  const dirty = $derived(guideDraftKey(draft) !== guideDraftKey(applied));
  const draftLevels = $derived(placeLevels(draft.place));
  const draftMap = $derived(draft.place.kind === "map" ? draft.place : null);

  // Place choices below the chosen level, loaded without navigating.
  const PARENT_OF: Record<GuideChoicesLevel, GuideLevel> = { region: "country", county: "region", hotspot: "county" };
  const CHOICE_NOUN: Record<GuideChoicesLevel, string> = { region: "states or regions", county: "counties", hotspot: "hotspots" };
  const loader = new PlaceChoiceLoader(fetchGuideChoices);
  let lists = $state<Record<GuideChoicesLevel, PlaceChoice[]>>(
    untrack(() => ({ region: data.regions, county: data.counties, hotspot: data.hotspots })),
  );
  let loadingLevel = $state<GuideChoicesLevel | null>(null);
  let choiceError = $state<{ level: GuideChoicesLevel; parent: string; message: string } | null>(null);

  function seedLists() {
    lists = { region: data.regions, county: data.counties, hotspot: data.hotspots };
    loader.seed("region", data.country, data.regions);
    loader.seed("county", data.region, data.counties);
    loader.seed("hotspot", data.county, data.hotspots);
  }

  /** Discard the draft and every transient edit state. */
  function resetToApplied() {
    loader.invalidate();
    loadingLevel = null;
    choiceError = null;
    mapOpen = false;
    picked = null;
    radiusText = "";
    applyError = "";
    seedLists();
    draft = copyDraft(applied);
  }

  // Any applied change (Back/Forward, a chip, a scope link, paging, Apply)
  // resets the panel before it renders, so no frame shows an old draft.
  const appliedSignature = $derived(`${guideDraftKey(applied)}|${page.url.search}`);
  let seenSignature = untrack(() => appliedSignature);
  $effect.pre(() => {
    const signature = appliedSignature;
    if (signature === seenSignature) return;
    seenSignature = signature;
    untrack(resetToApplied);
  });

  async function loadChoices(level: GuideChoicesLevel, parent: string) {
    loadingLevel = level;
    choiceError = null;
    const result = await loader.load(level, parent, () => placeLevels(draft.place)[PARENT_OF[level]]);
    if (result.status === "stale") return;
    loadingLevel = null;
    if (result.status === "ok") lists = { ...lists, [level]: result.choices };
    else choiceError = { level, parent, message: result.message };
  }

  /** Choose one Place level: clears deeper levels (and any map point) in the
   * draft, then loads the choices the new value unlocks. */
  function chooseLevel(level: GuideLevel, code: string) {
    // Re-picking the current value changes nothing (and keeps deeper choices).
    if (code.trim().toUpperCase() === placeLevels(draft.place)[level]) return;
    loader.invalidate();
    loadingLevel = null;
    choiceError = null;
    draft.place = withDraftLevel(draft.place, level, code);
    const levels = placeLevels(draft.place);
    let cleared = false;
    const next = { ...lists };
    for (const l of ["region", "county", "hotspot"] as GuideChoicesLevel[]) {
      if (l === childLevel(level)) cleared = true;
      if (cleared) next[l] = [];
    }
    lists = next;
    const child = childLevel(level);
    if (child && levels[level]) {
      const hit = loader.cached(child, levels[level]);
      if (hit) lists = { ...lists, [child]: hit };
      else void loadChoices(child, levels[level]);
    }
  }

  function toggleTag(tag: string) {
    draft.tags = toggledTag(draft.tags, tag);
  }

  // Native selects render until hydration; the searchable fields replace them
  // only after reading what the person may already have changed in the DOM, and
  // never while one of those selects has focus.
  let placeHydrated = $state(false);
  const PLACE_SELECT_IDS: Record<GuideLevel, string> = {
    country: "guide-country",
    region: "guide-region",
    county: "guide-county",
    hotspot: "guide-hotspot",
  };
  function readNativePlace(): Partial<Record<GuideLevel, string>> {
    const out: Partial<Record<GuideLevel, string>> = {};
    for (const level of ["country", "region", "county", "hotspot"] as GuideLevel[]) {
      const el = document.getElementById(PLACE_SELECT_IDS[level]);
      if (el instanceof HTMLSelectElement) out[level] = el.value.trim().toUpperCase();
    }
    return out;
  }
  // Captured while this script first runs, BEFORE hydration re-applies the
  // server's select values: a choice made in the server-rendered page before
  // JavaScript finished loading would otherwise be reset and lost (GROK).
  const nativePlaceAtBoot = browser ? readNativePlace() : {};
  function adoptNativePlace() {
    const now = readNativePlace();
    for (const level of ["country", "region", "county", "hotspot"] as GuideLevel[]) {
      const current = placeLevels(draft.place)[level];
      const live =
        now[level] !== undefined && now[level] !== current
          ? now[level]!
          : (nativePlaceAtBoot[level] ?? current);
      if (live !== current) {
        chooseLevel(level, live);
        break;
      }
    }
    placeHydrated = true;
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
    const focused = document.activeElement;
    const isPlaceSelect = (el: Element | null) =>
      el instanceof HTMLSelectElement && Object.values(PLACE_SELECT_IDS).includes(el.id);
    if (isPlaceSelect(focused)) {
      focused!.addEventListener("blur", () => requestAnimationFrame(adoptNativePlace), { once: true });
    } else {
      adoptNativePlace();
    }
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
  // Reopening the chooser shows the draft point when there is one, then the
  // applied one (CODEX1).
  const chooserSeed = $derived(draftMap ?? data.map);
  let mapSummaryButton = $state<HTMLButtonElement | undefined>();

  async function openChooser() {
    picked = null;
    applyError = "";
    // No saved or default radius: only a draft or applied circle is shown.
    radiusText = chooserSeed ? String(chooserSeed.dist) : "";
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
    (draftMap ? mapSummaryButton : chooseButton)?.focus();
  }

  /** "Use this point": the map point goes into the draft (replacing any
   * country/county choice); Apply filters runs it with everything else. */
  async function useChosenPoint() {
    if (!picked || !radiusValid) return;
    const built = guideMapSelection({
      place: picked.label,
      lat: picked.lat,
      lng: picked.lng,
      dist: Number(radiusText),
    });
    if (!built.ok) {
      applyError = built.message;
      return;
    }
    loader.invalidate();
    loadingLevel = null;
    choiceError = null;
    draft.place = built.selection as GuideLocationSelection;
    mapOpen = false;
    picked = null;
    radiusText = "";
    applyError = "";
    await tick();
    mapSummaryButton?.focus();
  }

  function usePlaceNames() {
    draft.place = { kind: "anywhere" };
    lists = { region: [], county: [], hotspot: [] };
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
      <summary>Filters and sort{activeFilterCount() ? ` (${activeFilterCount()} active)` : ""}{dirty ? " · changes not applied" : ""}</summary>
      <!-- One filter form. The map chooser holds MapPicker's own search <form>,
           which cannot nest, so the chooser sits outside this element and the
           controls after it join the form through form="guide-filter-form". -->
      <form id="guide-filter-form" method="GET" action="/species#results" class="filter-form">
        {#each unknownParams as [key, value], index (`filter-${index}-${key}-${value}`)}<input type="hidden" name={key} value={value} />{/each}
        {#if data.q}<input type="hidden" name="q" value={data.q} />{/if}
        <fieldset class="geo place">
          <legend>Place</legend>
          <p class="location-hint muted">All species recorded in this place in loaded eBird history, any time of year. Combine with All, Need or Seen above.</p>
          {#if draftMap}
            {#each guideLocationPairs(draftMap) as [locName, locValue] (locName)}<input type="hidden" name={locName} value={locValue} />{/each}
            <p class="geo-map">Map point: <strong>{draftMap.place}</strong>, within {draftMap.dist} {draftMap.dist === 1 ? "mile" : "miles"}.</p>
            {#if jsReady}
              <div class="place-actions">
                <button type="button" class="secondary" bind:this={mapSummaryButton} onclick={openChooser}>Change map point</button>
                <button type="button" class="secondary" onclick={usePlaceNames}>Choose a country, state, county or hotspot instead</button>
              </div>
            {:else}
              <a class="clear-filters" href={clearLocationHref}>Clear location to choose a country, state, county or hotspot</a>
            {/if}
          {:else}
            <!-- Without JavaScript the server works out which level changed from
                 these; once the searchable fields take over they are disabled,
                 because the submitted hierarchy is already consistent. -->
            {#each guideWasPairs(data.selection) as [wasName, wasValue] (wasName)}<input type="hidden" name={wasName} value={wasValue} disabled={placeHydrated} />{/each}
            <div class="location-fields">
              {#if placeHydrated}
                <SearchableSelect id="guide-country" name="country" label="Country" choices={data.countries} value={draftLevels.country} anywhereLabel="Anywhere" onCommit={(code) => chooseLevel("country", code)} />
                <SearchableSelect id="guide-region" name="region" label="State / region" choices={lists.region} value={draftLevels.region} anywhereLabel="Anywhere in this country" disabled={!draftLevels.country} disabledText="Choose a country first" loading={loadingLevel === "region"} emptyText="No loaded states or regions" onCommit={(code) => chooseLevel("region", code)} />
                <SearchableSelect id="guide-county" name="county" label="County / equivalent" choices={lists.county} value={draftLevels.county} anywhereLabel="Anywhere in this state or region" disabled={!draftLevels.region} disabledText="Choose a state or region first" loading={loadingLevel === "county"} emptyText="No loaded counties" onCommit={(code) => chooseLevel("county", code)} />
                <SearchableSelect id="guide-hotspot" name="hotspot" label="Verified hotspot" choices={lists.hotspot} value={draftLevels.hotspot} anywhereLabel="Anywhere in this county" disabled={!draftLevels.county} disabledText="Choose a county first" loading={loadingLevel === "hotspot"} emptyText="No loaded hotspots" onCommit={(code) => chooseLevel("hotspot", code)} />
              {:else}
                <div class="location-field"><label for="guide-country">Country</label><select id="guide-country" name="country" value={data.country}><option value="">Anywhere</option>{#each data.countries as c (c.code)}<option value={c.code}>{c.name}</option>{/each}</select></div>
                <div class="location-field"><label for="guide-region">State / region</label><select id="guide-region" name="region" value={data.region} disabled={!data.country || data.regions.length === 0}><option value="">{data.country ? "Anywhere in this country" : "Choose a country first"}</option>{#each data.regions as r (r.code)}<option value={r.code}>{r.name}</option>{/each}</select></div>
                <div class="location-field"><label for="guide-county">County / equivalent</label><select id="guide-county" name="county" value={data.county} disabled={!data.region || data.counties.length === 0}><option value="">{!data.region ? "Choose a state or region first" : data.counties.length === 0 ? "No loaded counties" : "Anywhere in this state or region"}</option>{#each data.counties as c (c.code)}<option value={c.code}>{c.name}</option>{/each}</select></div>
                <div class="location-field"><label for="guide-hotspot">Verified hotspot</label><select id="guide-hotspot" name="hotspot" value={data.hotspot} disabled={!data.county || data.hotspots.length === 0}><option value="">{!data.county ? "Choose a county first" : data.hotspots.length === 0 ? "No loaded hotspots" : "Anywhere in this county"}</option>{#each data.hotspots as h (h.code)}<option value={h.code}>{h.name}</option>{/each}</select></div>
              {/if}
            </div>
            {#if loadingLevel}<p class="muted place-status" role="status">Loading {CHOICE_NOUN[loadingLevel]}…</p>{/if}
            {#if choiceError}
              {@const failed = choiceError}
              <p class="err place-status" role="alert">
                Couldn't load {CHOICE_NOUN[failed.level]}. Your other choices are kept.
                <button type="button" class="secondary retry" aria-label={`Retry loading ${CHOICE_NOUN[failed.level]}`} onclick={() => loadChoices(failed.level, failed.parent)}>Retry</button>
              </p>
            {/if}
            {#if draftLevels.region && !draftLevels.county && !loadingLevel && !choiceError && lists.county.length === 0}<p class="location-hint muted">No county data is loaded for this state or region. <a href="/forecast/data">Load an area in Hotspots &amp; data</a> to choose a county.</p>{/if}
            {#if draftLevels.county && !draftLevels.hotspot && !loadingLevel && !choiceError && lists.hotspot.length === 0}<p class="location-hint muted">No hotspot data is loaded for this county. <a href="/forecast/data">Load an area in Hotspots &amp; data</a> to choose a hotspot.</p>{/if}
          {/if}
        </fieldset>
      </form>
      <section class="map-chooser" aria-labelledby="guide-map-label">
        <p id="guide-map-label" class="map-label">Or choose a point on the map</p>
        <noscript><p class="muted">Choosing or moving a map point needs JavaScript. The country, state, county and hotspot choices above work without it, and a shared map link still filters the results.</p></noscript>
        {#if jsReady && !draftMap}
          <button type="button" class="secondary" bind:this={chooseButton} hidden={mapOpen} aria-expanded={mapOpen} aria-controls={chooserId} onclick={openChooser}>Choose on map</button>
        {/if}
        {#if mapOpen}
          <div id={chooserId} class="chooser" role="group" aria-labelledby="guide-map-heading">
            <h3 bind:this={chooserHeading} id="guide-map-heading" tabindex="-1">Choose a map point and radius</h3>
            <p class="muted">Search for a place or tap the map, then enter a radius. The result covers only loaded eBird hotspots with recorded coordinates inside the circle; the part of the map you can see is never a boundary.</p>
            <MapPicker bind:selected={picked} initialLat={chooserSeed?.lat ?? null} initialLng={chooserSeed?.lng ?? null} initialLabel={chooserSeed?.place} />
            <p class="picked">{picked ? `Chosen point: ${picked.label}` : "No point chosen yet."}</p>
            <div class="radius-field">
              <label for="guide-radius">Radius in miles ({GUIDE_RADIUS_MIN}–{GUIDE_RADIUS_MAX})</label>
              <input id="guide-radius" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" bind:value={radiusText} aria-describedby="guide-apply-help" aria-invalid={radiusText.trim() !== "" && !radiusValid} onkeydown={(e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void useChosenPoint(); } }} />
            </div>
            <p id="guide-apply-help" class="muted">{canApply ? "Ready to use. Apply filters then runs the search." : `Choose a point on the map and enter a whole number of miles from ${GUIDE_RADIUS_MIN} to ${GUIDE_RADIUS_MAX}.`}</p>
            {#if applyError}<p class="err" role="alert">{applyError}</p>{/if}
            <div class="chooser-actions">
              <button type="button" class="apply-filters" disabled={!canApply} onclick={useChosenPoint}>Use this point</button>
              <button type="button" class="secondary" onclick={cancelChooser}>Cancel</button>
            </div>
          </div>
        {/if}
      </section>
      <div class="filter-form filter-rest">
        <label class="interest-filter"><input type="checkbox" form="guide-filter-form" name="interest" value="1" checked={draft.interest} onchange={(e) => (draft.interest = e.currentTarget.checked)} /> Special interest only</label>
        <div class="location-fields">
          <div class="location-field"><label for="guide-family">Bird family</label><select id="guide-family" form="guide-filter-form" name="family" value={draft.family} onchange={(e) => (draft.family = e.currentTarget.value)}><option value="">All families</option>{#each data.families as family}<option value={family.code}>{family.name ?? family.scientificName ?? family.code}{family.name && family.scientificName ? ` (${family.scientificName})` : ''}</option>{/each}</select></div>
          <div class="location-field"><label for="guide-sort">Sort</label><select id="guide-sort" form="guide-filter-form" name="sort" value={draft.sort} onchange={(e) => (draft.sort = e.currentTarget.value as GuideDraft["sort"])}><option value="relevance">Relevance</option><option value="name">Alphabetical</option><option value="taxonomic" disabled={!data.taxonomyAvailable}>Taxonomic order</option></select></div>
        </div>
        {#if !data.taxonomyAvailable}<p class="muted">Classification and taxonomic ordering await a taxonomy refresh.</p>{/if}
        {#each TAG_DIMENSIONS as d (d)}
          <details class="dim"><summary>{dimensionLabel(d)}</summary><div class="chips">{#each TAG_VOCABULARY[d] as v (v)}{@const tag = `${d}:${v}`}<label class="chip chip-choice" class:chip-on={draft.tags.includes(tag)} class:chip-tide={d === "tide"}><input type="checkbox" form="guide-filter-form" name="tags" value={tag} checked={draft.tags.includes(tag)} onchange={() => toggleTag(tag)} />{tagLabel(d, v)}</label>{/each}</div></details>
        {/each}
        <div class="apply-bar">
          <button class="apply-filters" type="submit" form="guide-filter-form">Apply filters</button>
          {#if dirty}
            <button type="button" class="secondary discard" onclick={resetToApplied}>Discard changes</button>
            <span class="unapplied">Changes not applied yet</span>
          {/if}
        </div>
      </div>
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
  .place-actions { display: flex; flex-wrap: wrap; gap: 10px; }
  .place-actions .secondary,
  .place-status .retry,
  .apply-bar .secondary { min-height: 48px; padding: 10px 16px; border-radius: 8px; background: var(--card); color: var(--accent); border: 1px solid var(--accent); font-weight: 600; }
  .place-status { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  /* Apply stays in reach while scrolling a long panel. */
  .apply-bar {
    position: sticky;
    bottom: calc(var(--bottomnav-h, 0px) + 8px);
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 10px 0;
    background: var(--card);
    border-top: 1px solid var(--border);
  }
  .unapplied { font-weight: 600; color: var(--accent); }
  /* Trait choices are real checkboxes (they wait for Apply) styled as chips. */
  .chip-choice { position: relative; cursor: pointer; }
  .chip-choice input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
  .chip-choice:has(input:focus-visible) { outline: 3px solid var(--accent); outline-offset: 2px; }
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
