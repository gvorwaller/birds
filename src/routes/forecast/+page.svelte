<script lang="ts">
  import { enhance } from "$app/forms";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import ForecastTabs from "$components/ForecastTabs.svelte";
  import MapLink from "$components/MapLink.svelte";
  import MapPicker, { type PickedLocation } from "$components/MapPicker.svelte";
  import MonthPicker from "$components/MonthPicker.svelte";
  import ObsMap, { type ObsPoint } from "$components/ObsMap.svelte";
  import { formatDistance } from "$lib/geo";
  import { forecastBulkLoad } from "$lib/forecast-load.svelte";
  import { speciesLinkHref } from "$lib/species-context";
  import { SPECIES_DEFAULT_BACK_DAYS } from "$lib/time-windows";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let showPicker = $state(false);
  let picked = $state<PickedLocation | null>(null);

  function usePicked() {
    if (!picked) return;
    const p = new URLSearchParams();
    p.set("lat", picked.lat.toFixed(5));
    p.set("lng", picked.lng.toFixed(5));
    p.set("loc", picked.label);
    p.set("month", String(data.month));
    p.set("dist", String(data.dist));
    showPicker = false;
    picked = null;
    goto(`/forecast?${p.toString()}`);
  }

  const nearPlaceholder = $derived(
    data.location && !data.placeQuery
      ? data.originKind === "home"
        ? `${data.location.label} (saved home)`
        : data.location.label
      : "City, county, park, or address — anywhere",
  );

  // Species links carry a returnTo (so "← Forecast" comes back here with the
  // same place/month) plus the forecast origin as location context, so the
  // species page reports on the area being forecast — same pattern as Home.
  const returnTo = $derived(page.url.pathname + page.url.search);
  function speciesHref(code: string): string {
    return speciesLinkHref(code, {
      backDays: SPECIES_DEFAULT_BACK_DAYS,
      returnTo,
      context: data.location
        ? {
            lat: data.location.lat,
            lng: data.location.lng,
            distKm: data.dist,
            label: data.location.label,
          }
        : null,
    });
  }

  let loading = $state(false);
  let loadingLoc = $state<string | null>(null);
  let showAllUnloaded = $state(false);
  const UNLOADED_PREVIEW = 30;
  const unloadedShown = $derived(
    data.view
      ? showAllUnloaded
        ? data.view.unloadedNearby
        : data.view.unloadedNearby.slice(0, UNLOADED_PREVIEW)
      : [],
  );

  // Multi-select loading (td-8a6f97): checkbox selection is client state;
  // the loop itself lives in the app-level forecastBulkLoad manager so a run
  // SURVIVES in-app navigation — leave for /help mid-run and come back to a
  // live progress bar. ensureFrequencies fetches ≤12/invocation and skips
  // rows that became current, so resubmitting the selection is progress-safe.
  let selectedLocs = $state<string[]>([]);
  const bulk = forecastBulkLoad;
  const DAILY_FETCH_CAP = 200;

  function startBulk(e: SubmitEvent) {
    e.preventDefault();
    if (!data.location || selectedLocs.length === 0) return;
    void bulk.start(
      {
        lat: data.location.lat,
        lng: data.location.lng,
        dist: data.dist,
        label: data.location.label,
      },
      [...selectedLocs],
    );
  }

  // Loaded rows leave unloadedNearby on re-render; prune them from the
  // selection so counts stay honest mid-loop.
  $effect(() => {
    const available = new Set(
      (data.view?.unloadedNearby ?? []).map((h) => h.locId),
    );
    if (selectedLocs.some((id) => !available.has(id))) {
      selectedLocs = selectedLocs.filter((id) => available.has(id));
    }
  });

  function selectAllShown() {
    selectedLocs = [...new Set([...selectedLocs, ...unloadedShown.map((h) => h.locId)])];
  }

  const MONTH_NAMES = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  // `analyzed` is now every loaded hotspot in range — all rows have data.
  const covered = $derived(data.view ? data.view.analyzed.length : 0);
  const wellSampled = $derived(
    data.view ? data.view.species.filter((s) => !s.lowSample) : [],
  );
  const likely = $derived(wellSampled.filter((s) => s.areaFreq >= 0.2));
  const possible = $derived(
    wellSampled.filter((s) => s.areaFreq >= 0.05 && s.areaFreq < 0.2),
  );
  const longshots = $derived(
    wellSampled.filter((s) => s.areaFreq > 0 && s.areaFreq < 0.05),
  );
  const lowSampled = $derived(
    data.view ? data.view.species.filter((s) => s.lowSample) : [],
  );
  const richest = $derived.by(() => {
    const year = data.view?.year ?? [];
    let best = year[0] ?? null;
    for (const m of year) {
      if (!best || m.likely > best.likely || (m.likely === best.likely && m.possible > best.possible)) {
        best = m;
      }
    }
    return best && best.likely + best.possible > 0 ? best : null;
  });
  const hotspotPoints = $derived.by((): ObsPoint[] => {
    if (!data.view) return [];
    // Green pins: loaded hotspots feeding the numbers. Gray pins: the
    // nearest unloaded candidates, so the pick list has a map to point at.
    return [
      ...data.view.analyzed.map((h) => ({
        lat: h.lat,
        lng: h.lng,
        title: h.locName,
        sub: h.fetchedAt ? `data from ${fmtDate(h.fetchedAt)}` : "loaded",
        kind: "need" as const,
      })),
      ...data.view.unloadedNearby.slice(0, 25).map((h) => ({
        lat: h.lat,
        lng: h.lng,
        title: h.locName,
        sub: "no data loaded yet",
        kind: "pending" as const,
      })),
    ];
  });

  function speciesWhereHref(code: string): string | null {
    if (!data.view?.regionCode) return null;
    const p = new URLSearchParams();
    p.set("species", code);
    p.set("region", data.view.regionCode);
    p.set("month", String(data.month));
    return `/forecast/species?${p.toString()}`;
  }

  function addToTripHref(h: { lat: number; lng: number; locName: string }) {
    const p = new URLSearchParams();
    p.set("place", h.locName);
    p.set("lat", h.lat.toFixed(5));
    p.set("lng", h.lng.toFixed(5));
    return `/trips/plan?${p.toString()}`;
  }

  function pct(freq: number): string {
    if (freq === 0) return "0%";
    if (freq < 0.01) return "<1%";
    return `${Math.round(freq * 100)}%`;
  }

  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
</script>

<svelte:head>
  <title>Forecast · Birds</title>
</svelte:head>

<div class="page">
  <h1>Forecast</h1>
  <ForecastTabs
    mode="area"
    params={page.url.search.slice(1)}
    month={data.month}
  />
  <p class="intro">
    Which species you still need are likely near a place in a given month,
    from prior years' eBird checklist frequencies.
    <a href="/forecast/data">Forecast data</a> shows what's loaded.
  </p>

  <section class="card">
    <form method="GET" class="filters">
      {#if data.originKind === "pin" && data.location}
        <input type="hidden" name="lat" value={data.location.lat.toFixed(5)} />
        <input type="hidden" name="lng" value={data.location.lng.toFixed(5)} />
        <input type="hidden" name="loc" value={data.location.label} />
      {/if}
      <div class="row">
        <label for="place">Near</label>
        <div class="nearrow">
          <input
            id="place"
            name="place"
            type="search"
            placeholder={nearPlaceholder}
            value={data.placeQuery}
          />
          <button
            type="button"
            class="secondary"
            onclick={() => (showPicker = !showPicker)}
          >
            📍 Pick on map
          </button>
        </div>
      </div>
      <div class="row">
        <label for="dist">Within</label>
        <select id="dist" name="dist">
          {#each data.radiusOptionsKm as km (km)}
            <option value={km} selected={km === data.dist}
              >{formatDistance(km, "mi")}</option
            >
          {/each}
        </select>
      </div>
      <!-- Implicit submission (Enter in the search box) "clicks" the FIRST
           submit button, which would otherwise be MonthPicker's January.
           This visually-hidden default button carries the current month. -->
      <button
        type="submit"
        name="month"
        value={data.month}
        class="default-submit"
        tabindex="-1"
        aria-hidden="true"></button>
      <div class="row month-row">
        <span class="label">Month</span>
        <MonthPicker value={data.month} />
      </div>
      <div class="row">
        <button type="submit" name="month" value={data.month}>Update</button>
      </div>
    </form>
    {#if showPicker}
      <div class="picker-wrap">
        <MapPicker
          bind:selected={picked}
          initialLat={data.location?.lat ?? null}
          initialLng={data.location?.lng ?? null}
        />
        <div class="picker-actions">
          <button type="button" onclick={usePicked} disabled={!picked}>
            {picked ? `Forecast near ${picked.label}` : "Tap the map to drop a pin"}
          </button>
          <button
            type="button"
            class="secondary"
            onclick={() => {
              showPicker = false;
              picked = null;
            }}>Cancel</button
          >
        </div>
      </div>
    {/if}
    {#if data.error}
      <p class="error">{data.error}</p>
    {/if}
    {#if data.needsLocation}
      <p class="notice">
        Search a place above, or set a home location in
        <a href="/settings">Settings</a>.
      </p>
    {:else if !data.hasApiKey}
      <p class="notice">
        Hotspot lookup needs an eBird API key — add one in
        <a href="/settings">Settings</a>.
      </p>
    {/if}
  </section>

  {#if data.view && data.location}
    {@const v = data.view}
    <section class="card">
      <h2>
        {MONTH_NAMES[v.month - 1]} near {data.location.label}
      </h2>
      <p class="coverage">
        {#if v.dataYears}{v.dataYears.begin}–{v.dataYears.end} ·
        {/if}using {v.analyzed.length} loaded hotspot{v.analyzed.length === 1
          ? ""
          : "s"} · {v.totalNearby} in range
        {#if v.outdatedCount > 0}
          · <span class="stale">{v.outdatedCount} outdated</span>
        {/if}
        {#if v.hotspotListStale}
          · <span class="stale">hotspot list from cache</span>
        {/if}
        · <a href="/forecast/data">details</a>
      </p>

      {#if (v.suggested.length > 0 || v.outdatedCount > 0) && !data.isViewer}
        {#if !data.hasLogin}
          <p class="notice">
            Loading frequency data uses your eBird sign-in — add it in
            <a href="/settings">Settings</a>.
          </p>
        {:else}
          <form
            method="POST"
            action="?/loadData"
            use:enhance={() => {
              loading = true;
              return async ({ update }) => {
                loading = false;
                await update();
              };
            }}
          >
            <input type="hidden" name="lat" value={data.location.lat} />
            <input type="hidden" name="lng" value={data.location.lng} />
            <input type="hidden" name="dist" value={data.dist} />
            <button type="submit" disabled={loading}>
              {loading
                ? "Loading from eBird…"
                : v.suggested.length > 0
                  ? `Load ${v.suggested.length} suggested hotspot${v.suggested.length === 1 ? "" : "s"}`
                  : v.outdatedCount > 12
                    ? `Refresh outdated data (12 of ${v.outdatedCount} per click)`
                    : `Refresh outdated data (${v.outdatedCount} hotspot${v.outdatedCount === 1 ? "" : "s"})`}
            </button>
          </form>
          {#if v.suggested.length > 0 && v.analyzed.length > 0}
            <p class="notice">
              Suggestions mix nearest + most-active — or pick exact hotspots
              under "More hotspots in range" below.
            </p>
          {/if}
        {/if}
      {/if}

      {#if v.analyzed.length > 0 && v.unloadedNearby.length > 0}
        <!-- Symmetric phrasing (GROK #2): partial coverage can under- OR
             over-state a species for the area, so state the fact, not one
             direction. -->
        <p class="partial">
          ⚠ Frequencies reflect only the {v.analyzed.length} loaded of
          {v.totalNearby} hotspots in range — unloaded sites aren't counted.
        </p>
      {/if}
      {#if v.analyzed.length === 0 && data.isViewer}
        <p class="notice">
          The account owner hasn't loaded forecast data for this area yet.
        </p>
      {/if}

      {#if form && "error" in form && form.error}
        <p class="error">{form.error}</p>
      {/if}
      {#if form?.ensure}
        {#if form.ensure.credentialProblem}
          <p class="error">{form.ensure.credentialProblem}</p>
        {:else if form.ensure.busy}
          <p class="notice">
            Another data load is already running — try again in a moment.
          </p>
        {:else if form.ensure.failed.length > 0}
          <p class="error">
            {form.ensure.failed.length} hotspot{form.ensure.failed.length === 1
              ? ""
              : "s"} failed: {form.ensure.failed[0].error}
          </p>
        {:else if form.ensure.refreshed.length > 0}
          <p class="notice ok">
            Loaded data for {form.ensure.refreshed.length} hotspot{form.ensure
              .refreshed.length === 1
              ? ""
              : "s"}.
          </p>
        {/if}
      {/if}

      {#if covered > 0 && v.year.some((m) => m.likely + m.possible + m.longshot > 0)}
        <form method="GET" class="yearform">
          {#if data.originKind === "pin" && data.location}
            <input type="hidden" name="lat" value={data.location.lat.toFixed(5)} />
            <input type="hidden" name="lng" value={data.location.lng.toFixed(5)} />
            <input type="hidden" name="loc" value={data.location.label} />
          {:else if data.placeQuery}
            <input type="hidden" name="place" value={data.placeQuery} />
          {/if}
          <input type="hidden" name="dist" value={data.dist} />
          <p class="label">Best month for your needs here</p>
          {#if richest}
            <p class="yearlead">
              {MONTH_NAMES[richest.month - 1]} is richest —
              {richest.likely} likely
              {#if richest.possible > 0}
                · {richest.possible} possible
              {/if}
              {#if richest.month !== v.month}
                <span class="yearhint"
                  >(you’re looking at {MONTH_NAMES[v.month - 1]})</span
                >
              {/if}
            </p>
          {/if}
          <div class="yeargrid" role="group" aria-label="Needed species by month">
            {#each v.year as m (m.month)}
              {@const score = m.likely + m.possible}
              <button
                type="submit"
                name="month"
                value={m.month}
                class:active={m.month === v.month}
                class:peak={richest && m.month === richest.month}
              >
                <span class="ym">{MONTH_NAMES[m.month - 1].slice(0, 3)}</span>
                <span class="ys">{score}</span>
                <span class="yl"
                  >{m.likely > 0 ? `${m.likely} likely` : score > 0 ? "possible" : "—"}</span
                >
              </button>
            {/each}
          </div>
        </form>
      {/if}

      {#if covered > 0}
        {#if v.species.length === 0}
          <p>
            No needed species in the loaded data for
            {MONTH_NAMES[v.month - 1]} — nice life list!
          </p>
        {:else}
          <p class="summary">
            <strong>{likely.length}</strong> likely
            {#if possible.length > 0}
              · {possible.length} possible
            {/if}
            needed species in {MONTH_NAMES[v.month - 1]}
            {#if longshots.length + lowSampled.length > 0}
              <span class="muted">
                · {longshots.length + lowSampled.length} long shots below</span
              >
            {/if}
          </p>
          {#snippet speciesList(items: typeof wellSampled)}
            <ol class="needs">
              {#each items as s (s.code)}
                {@const where = speciesWhereHref(s.code)}
                <li>
                  <div class="sp">
                    <a href={speciesHref(s.code)} class="name">{s.comName}</a>
                    <span class="freq"
                      >{pct(s.areaFreq)} of checklists (n={s.areaN.toLocaleString()})</span
                    >
                  </div>
                  {#if s.topHotspots.length > 0}
                    <div class="best">
                      {#if s.concentration === "local" && s.localClaim && s.topHotspots[0]}
                        mostly at {s.topHotspots[0].locName} ({pct(s.topHotspots[0].freq)}{s.topHotspots[0].lowSample ? " †" : ""})
                      {:else if s.concentration === "widespread"}
                        widespread
                        {#each s.topHotspots as h, i (h.locId)}{i > 0 ? " · " : " — "}{h.locName} ({pct(h.freq)}{h.lowSample ? " †" : ""}){/each}
                      {:else}
                        best: {#each s.topHotspots as h, i (h.locId)}{i > 0
                            ? " · "
                            : ""}{h.locName} ({pct(h.freq)}{h.lowSample
                            ? " †"
                            : ""}){/each}
                      {/if}
                    </div>
                  {/if}
                  {#if where}
                    <div class="actions">
                      <a href={where}
                        >Where in {v.regionName ?? "this state"}</a
                      >
                    </div>
                  {/if}
                </li>
              {/each}
            </ol>
          {/snippet}
          {#if likely.length > 0}
            <h3 class="band">Likely — on at least 20% of checklists</h3>
            {@render speciesList(likely)}
          {/if}
          {#if possible.length > 0}
            <h3 class="band">Possible — 5–19% of checklists</h3>
            {@render speciesList(possible)}
          {/if}
          {#if longshots.length > 0}
            <details class="lown">
              <summary>
                {longshots.length} long shot{longshots.length === 1 ? "" : "s"}
                (under 5% of checklists)
              </summary>
              {@render speciesList(longshots)}
            </details>
          {/if}
          {#if lowSampled.length > 0}
            <details class="lown">
              <summary>
                {lowSampled.length} more with small samples (fewer than 40
                checklists)
              </summary>
              {@render speciesList(lowSampled)}
            </details>
          {/if}
        {/if}
      {/if}

      {#if data.countyNeeds.length > 0 && v.regionName}
        <div class="counties">
          <h3 class="band">
            Best counties in {v.regionName} for your needs —
            {MONTH_NAMES[v.month - 1]}
          </h3>
          <p class="muted">
            From statewide county data already loaded. Ranked by how many of
            your needs are likely there.
          </p>
          <ol class="needs">
            {#each data.countyNeeds.slice(0, 10) as c (c.code)}
              <li>
                <div class="sp">
                  <span class="name">{c.name}</span>
                  <span class="freq"
                    >{c.likely} likely{#if c.possible > 0}&nbsp;· {c.possible} possible{/if}</span
                  >
                </div>
              </li>
            {/each}
          </ol>
        </div>
      {/if}

      <details class="analyzed">
        <summary>Loaded hotspots in use ({v.analyzed.length})</summary>
        <ul>
          {#each v.analyzed as h (h.locId)}
            <li>
              <div class="sp">
                <span class="name">{h.locName}</span>
                <span class="meta">
                  {formatDistance(h.distanceKm, "mi")} ·
                  {h.fetchedAt ? `data from ${fmtDate(h.fetchedAt)}` : ""}
                  {#if !h.current}· outdated{/if}
                </span>
              </div>
              <div class="actions">
                <MapLink lat={h.lat} lng={h.lng} name={h.locName} />
                <a
                  href="https://ebird.org/hotspot/{h.locId}"
                  target="_blank"
                  rel="noopener">eBird ↗</a
                >
                <a href={addToTripHref(h)}>Add to trip</a>
              </div>
            </li>
          {/each}
        </ul>
      </details>

      {#if v.unloadedNearby.length > 0}
        <details class="analyzed">
          <summary>
            More hotspots in range ({v.unloadedNearby.length}) — pick what to
            load
          </summary>
          {#if !data.isViewer && data.hasLogin && data.location}
            <div class="bulkbar">
              <button type="button" class="rowload" onclick={selectAllShown}>
                Select all shown
              </button>
              {#if selectedLocs.length > 0}
                <button
                  type="button"
                  class="rowload"
                  onclick={() => (selectedLocs = [])}
                >
                  Clear ({selectedLocs.length})
                </button>
              {/if}
              {#if selectedLocs.length > 0 && !bulk.running}
                <!-- Plain no-JS fallback posts once (≤12); with JS the
                     app-level manager drives the loop so it survives
                     navigating away and back. -->
                <form method="POST" action="?/loadData" onsubmit={startBulk}>
                  <input type="hidden" name="lat" value={data.location.lat} />
                  <input type="hidden" name="lng" value={data.location.lng} />
                  <input type="hidden" name="dist" value={data.dist} />
                  {#each selectedLocs as id (id)}
                    <input type="hidden" name="loc" value={id} />
                  {/each}
                  <button type="submit" disabled={loadingLoc !== null}>
                    Load selected ({selectedLocs.length})
                  </button>
                </form>
              {/if}
              {#if bulk.running}
                <span class="bulkstatus"
                  >Loading {bulk.label}… {bulk.done} of {bulk.total}</span
                >
              {/if}
            </div>
            {#if bulk.running && bulk.total > 0}
              <div
                class="progressbar"
                role="progressbar"
                aria-valuenow={bulk.done}
                aria-valuemin={0}
                aria-valuemax={bulk.total}
              >
                <div
                  class="fill"
                  style="width: {(bulk.done / bulk.total) * 100}%"
                ></div>
              </div>
            {/if}
            {#if selectedLocs.length > DAILY_FETCH_CAP}
              <p class="notice">
                {selectedLocs.length} selected exceeds the {DAILY_FETCH_CAP}/day
                request ceiling — the rest will wait for tomorrow.
              </p>
            {/if}
            {#if bulk.hasResult}
              {#if bulk.credentialProblem}
                <p class="error">{bulk.credentialProblem}</p>
              {:else if bulk.busyConflict}
                <p class="notice">
                  Another data load was already running — try again in a
                  moment.
                </p>
              {:else if bulk.failed.length > 0}
                <p class="error">
                  {bulk.failed.length} hotspot{bulk.failed.length === 1
                    ? ""
                    : "s"} didn't load — {bulk.failed[0].error} (eBird's export
                  errors on some locations; retry later from Forecast data).
                </p>
              {/if}
              <button type="button" class="rowload" onclick={() => bulk.dismiss()}>
                Dismiss
              </button>
            {/if}
          {/if}
          <ul>
            {#each unloadedShown as h (h.locId)}
              <li>
                <div class="sp">
                  {#if !data.isViewer && data.hasLogin}
                    <label class="pick">
                      <input
                        type="checkbox"
                        bind:group={selectedLocs}
                        value={h.locId}
                        disabled={bulk.running}
                      />
                      <span class="name">{h.locName}</span>
                    </label>
                  {:else}
                    <span class="name">{h.locName}</span>
                  {/if}
                  <span class="meta">
                    {formatDistance(h.distanceKm, "mi")}
                    {#if h.numSpeciesAllTime != null}
                      · {h.numSpeciesAllTime} species all-time
                    {/if}
                  </span>
                </div>
                <div class="actions">
                  {#if !data.isViewer && data.hasLogin && data.location}
                    <form
                      method="POST"
                      action="?/loadData"
                      use:enhance={() => {
                        loadingLoc = h.locId;
                        return async ({ update }) => {
                          loadingLoc = null;
                          await update();
                        };
                      }}
                    >
                      <input
                        type="hidden"
                        name="lat"
                        value={data.location.lat}
                      />
                      <input
                        type="hidden"
                        name="lng"
                        value={data.location.lng}
                      />
                      <input type="hidden" name="dist" value={data.dist} />
                      <input type="hidden" name="loc" value={h.locId} />
                      <button
                        type="submit"
                        class="rowload"
                        disabled={loadingLoc !== null || bulk.running}
                      >
                        {loadingLoc === h.locId ? "Loading…" : "Load"}
                      </button>
                    </form>
                  {/if}
                  <a
                    href="https://ebird.org/hotspot/{h.locId}"
                    target="_blank"
                    rel="noopener">eBird ↗</a
                  >
                </div>
              </li>
            {/each}
          </ul>
          {#if v.unloadedNearby.length > UNLOADED_PREVIEW}
            <button
              type="button"
              class="rowload"
              onclick={() => (showAllUnloaded = !showAllUnloaded)}
            >
              {showAllUnloaded
                ? "Show fewer"
                : `Show all ${v.unloadedNearby.length}`}
            </button>
          {/if}
        </details>
      {/if}
      {#if hotspotPoints.length > 0}
        <div class="map">
          <ObsMap
            points={hotspotPoints}
            center={data.location
              ? { lat: data.location.lat, lng: data.location.lng }
              : null}
          />
        </div>
      {/if}
    </section>
  {/if}

  <p class="attribution">
    Data from
    <a href="https://ebird.org" target="_blank" rel="noopener">eBird.org</a>
  </p>
</div>

<style>
  .page {
    max-width: 760px;
    margin: 0 auto;
    padding: 16px;
  }
  h1 {
    font-size: 1.35rem;
    margin: 0 0 4px;
  }
  .intro {
    color: var(--muted);
    margin: 0 0 16px;
    font-size: 0.92rem;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 16px;
  }
  h2 {
    font-size: 1.1rem;
    margin: 0 0 6px;
  }
  .filters .row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }
  label,
  .label {
    font-weight: 600;
    font-size: 0.88rem;
  }
  input[type="search"],
  select {
    font-size: 16px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    min-height: 48px;
    height: 48px;
  }
  button {
    min-height: 48px;
    padding: 10px 18px;
    font-size: 1rem;
    border: none;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .bulkbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin: 8px 0;
  }
  .progressbar {
    height: 8px;
    background: var(--accent-soft);
    border-radius: 4px;
    overflow: hidden;
    margin: 8px 0;
  }
  .progressbar .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.4s ease;
  }
  .pick {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    min-height: 48px;
  }
  .pick input[type="checkbox"] {
    width: 22px;
    height: 22px;
    accent-color: var(--accent);
  }
  .bulkstatus {
    color: var(--accent);
    font-weight: 600;
    font-size: 0.9rem;
  }
  .partial {
    background: var(--need-bg);
    color: var(--need-text);
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 0.88rem;
    margin: 10px 0 0;
  }
  button.rowload {
    min-height: 48px;
    padding: 6px 16px;
    font-size: 0.88rem;
    background: var(--card);
    color: var(--accent);
    border: 1px solid var(--accent);
  }
  .default-submit {
    position: absolute;
    width: 1px;
    height: 1px;
    min-height: 0;
    padding: 0;
    border: 0;
    clip: rect(0 0 0 0);
    overflow: hidden;
  }
  .nearrow {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .nearrow input {
    flex: 1;
    min-width: 200px;
  }
  button.secondary {
    background: var(--card);
    color: var(--accent);
    border: 1px solid var(--accent);
  }
  .picker-wrap {
    margin-top: 12px;
  }
  .picker-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 10px;
  }
  .coverage {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0 0 12px;
  }
  .stale {
    color: var(--need-text);
  }
  .summary {
    margin: 14px 0 8px;
  }
  .muted {
    color: var(--muted);
  }
  .yearform {
    margin: 12px 0 16px;
  }
  .yearlead {
    margin: 0 0 8px;
    font-size: 0.95rem;
  }
  .yearhint {
    color: var(--muted);
    font-size: 0.88rem;
  }
  .yeargrid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .yeargrid button {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    min-height: 64px;
    padding: 6px 2px;
    background: var(--card);
    color: var(--text);
    border: 1px solid var(--border);
  }
  .yeargrid button:hover {
    background: var(--bg);
  }
  .yeargrid button.active {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .yeargrid button.peak .ys {
    color: var(--accent);
  }
  .yeargrid .ym {
    font-size: 0.78rem;
    font-weight: 600;
  }
  .yeargrid .ys {
    font-size: 1.1rem;
    font-weight: 700;
    line-height: 1.1;
  }
  .yeargrid .yl {
    font-size: 0.68rem;
    color: var(--muted);
  }
  .band {
    font-size: 0.92rem;
    margin: 16px 0 6px;
  }
  .counties {
    margin-top: 18px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin-top: 4px;
    font-size: 0.85rem;
    align-items: center;
  }
  .actions a {
    min-height: 48px;
    min-width: 48px;
    display: inline-flex;
    align-items: center;
  }
  .map {
    margin-top: 14px;
  }
  .needs {
    margin: 0;
    padding-left: 1.4em;
  }
  .needs li {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .needs li:last-child {
    border-bottom: none;
  }
  .sp {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    align-items: baseline;
  }
  .name {
    font-weight: 600;
    min-height: 48px;
    display: inline-flex;
    align-items: center;
  }
  .freq {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .best {
    color: var(--muted);
    font-size: 0.82rem;
    margin-top: 2px;
  }
  .lown,
  .analyzed {
    margin-top: 14px;
  }
  summary {
    cursor: pointer;
    color: var(--accent);
    font-size: 0.9rem;
    min-height: 48px;
    display: flex;
    align-items: center;
  }
  .analyzed ul {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
  }
  .analyzed li {
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.9rem;
  }
  .analyzed li:last-child {
    border-bottom: none;
  }
  .meta {
    color: var(--muted);
    font-size: 0.82rem;
    margin-left: 6px;
  }
  .error {
    color: var(--danger);
    font-weight: 600;
    margin: 10px 0 0;
  }
  .notice {
    color: var(--muted);
    margin: 10px 0 0;
  }
  .notice.ok {
    color: var(--accent);
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
  @media (min-width: 640px) {
    .page {
      padding: 24px;
    }
    h1 {
      font-size: 1.6rem;
    }
    .filters {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: end;
    }
    .filters .row {
      margin-bottom: 0;
    }
    .month-row {
      grid-column: 1 / -1;
    }
  }
  @media (min-width: 1024px) {
    .yeargrid {
      grid-template-columns: repeat(12, 1fr);
    }
  }
</style>
