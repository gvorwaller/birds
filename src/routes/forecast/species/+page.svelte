<script lang="ts">
  import { enhance } from "$app/forms";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import ForecastTabs from "$components/ForecastTabs.svelte";
  import FrequencyChart from "$components/FrequencyChart.svelte";
  import MonthPicker from "$components/MonthPicker.svelte";
  import MapLink from "$components/MapLink.svelte";
  import ObsMap, { type ObsPoint } from "$components/ObsMap.svelte";
  import { formatMonthWindow } from "$lib/forecast-calendar";
  import { mapsPlaceUrl } from "$lib/geo";
  import { jobsPoll } from "$lib/job-poll.svelte";
  import { countryOf, regionLevel } from "$lib/region-code";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let loading = $state(false);

  // Country picker (td-f1d6da): switching countries reloads the loader with
  // the new ?country=, dropping the now-stale region/county selection so the
  // region select resets to its prompt (AGY-accepted pin 1) rather than
  // carrying over a region that belongs to the previous country.
  const selectedCountryName = $derived(
    data.countries.find((c) => c.code === data.country)?.name ?? data.country,
  );
  // US pinned first with its own <optgroup> so a ~250-country list doesn't
  // read as unsorted (GROK UX review #2).
  // Typing narrows both optgroups (GBV 2026-08-24 — ~250 entries is a lot of
  // scrolling). The current selection always survives the filter, or the
  // <select> would render blank.
  let countryFilter = $state("");
  const countryMatches = $derived((c: { code: string; name: string }) => {
    const q = countryFilter.trim().toLowerCase();
    return (
      q === "" ||
      c.code === data.country ||
      c.name.toLowerCase().includes(q) ||
      c.code.toLowerCase().startsWith(q)
    );
  });
  const usCountry = $derived(
    data.countries.find((c) => c.code === "US" && countryMatches(c)) ?? null,
  );
  const otherCountries = $derived(
    data.countries.filter((c) => c.code !== "US" && countryMatches(c)),
  );
  function onCountryChange(e: Event & { currentTarget: HTMLSelectElement }) {
    const params = new URLSearchParams(page.url.searchParams);
    params.set("country", e.currentTarget.value);
    params.delete("region");
    params.delete("county");
    void goto(`?${params.toString()}`, { keepFocus: true, noScroll: true });
  }

  const progress = $derived(data.countyCoverage);

  // "county"/"counties" for US states' subnational2 children; "region"/
  // "regions" everywhere else (non-US subnational1's children, and any
  // country-level region's subnational1 children) — td-f1d6da.
  const countyNoun = $derived(
    data.region &&
      regionLevel(data.region.code) === "subnational1" &&
      countryOf(data.region.code) === "US"
      ? "county"
      : "region",
  );
  const countyNounPlural = $derived(countyNoun === "county" ? "counties" : "regions");

  // Deep link fail-soft (GROK UX review #4): a region param whose code isn't
  // in the fetched subnational1 list or the "Entire {Country}" option (e.g.
  // no API key, or a fetch failure) still needs to render as the visibly
  // selected value rather than falling back to the blank prompt.
  const regionIsWholeCountryOption = $derived(
    data.region != null && data.country !== "US" && data.region.code === data.country,
  );
  const regionInStatesList = $derived(
    data.region != null && data.states.some((s) => s.code === data.region!.code),
  );
  const regionMissingFromList = $derived(
    data.region != null && !regionIsWholeCountryOption && !regionInStatesList,
  );

  // Whole-state county analysis is now ONE background job — the old
  // ≤12-per-click resubmit loop is gone. The worker reports per-county
  // progress; the throttled invalidateAll refreshes the ranking as counties
  // land, and countyCoverage catches the bar up between polls.
  // Scoped to THIS state via the job's target (CODEX1 re-review #3): while
  // Maine analyzes, a Texas page must neither disable its action nor label
  // Maine's counts as Texas progress.
  const analyzeJob = $derived(
    jobsPoll.active.find(
      (j) => j.type === "analyze_counties" && j.target === data.region?.code,
    ) ?? null,
  );
  const analyzing = $derived(analyzeJob != null);

  // Any action that returns {queued} gets tracked so the job shows up in the
  // progress banner within one poll tick. Duplicate tracks are harmless.
  $effect(() => {
    const q = form && "queued" in form ? form.queued : null;
    if (q) jobsPoll.track(q.jobId);
  });

  // Preserves month (and county, when it belongs to the current region) so
  // "change" doesn't silently reset the month picker back to default
  // (GROK UX review #8). Country is inferred from region on the next load.
  function changeSpeciesHref(): string {
    const p = new URLSearchParams();
    if (data.region) p.set("region", data.region.code);
    p.set("month", String(data.month));
    if (data.county && data.region && data.county.code.startsWith(`${data.region.code}-`)) {
      p.set("county", data.county.code);
    }
    return `?${p.toString()}`;
  }

  function countyHref(
    countyCode: string | null,
    hs: number | null = null,
  ): string {
    const p = new URLSearchParams();
    if (data.taxon) p.set("species", data.taxon.species_code);
    if (data.region) p.set("region", data.region.code);
    p.set("month", String(data.month));
    if (countyCode) p.set("county", countyCode);
    if (hs) p.set("hs", String(hs));
    // Jump to the hotspot section — it renders below the county list, and
    // without the anchor a "Hotspots" click looks like a dead link.
    return `?${p.toString()}${countyCode ? "#county-hotspots" : ""}`;
  }

  /** Mode A prefilled at a hotspot's coordinates ("Forecast my needs here"). */
  function needsHereHref(h: { lat: number; lng: number; locName: string }) {
    const p = new URLSearchParams();
    p.set("lat", h.lat.toFixed(5));
    p.set("lng", h.lng.toFixed(5));
    p.set("loc", h.locName);
    p.set("month", String(data.month));
    return `/forecast?${p.toString()}`;
  }

  /** Trip planner prefilled at a hotspot (trips/plan reads these params). */
  function addToTripHref(h: { lat: number; lng: number; locName: string }) {
    const p = new URLSearchParams();
    p.set("place", h.locName);
    p.set("lat", h.lat.toFixed(5));
    p.set("lng", h.lng.toFixed(5));
    return `/trips/plan?${p.toString()}`;
  }

  // All selected hotspots go on the map — loaded ones as green "need" pins,
  // not-yet-loaded candidates as gray "pending" pins (UX doc #5).
  const hotspotPoints = $derived.by((): ObsPoint[] => {
    if (!data.countyHotspots) return [];
    const byCode = new Map(
      data.countyHotspots.ranking.map((r) => [r.code, r]),
    );
    return data.countyHotspots.selected.map((h) => {
      const r = h.hasData ? byCode.get(h.locId) : undefined;
      return {
        lat: h.lat,
        lng: h.lng,
        // Low-sample marker travels onto the map pin too (CODEX8 #3).
        title: r?.lowSample ? `${h.locName} †` : h.locName,
        sub: r
          ? `${pct(r.freq)} of checklists (n=${r.n.toLocaleString()})${r.lowSample ? " — small sample" : ""}`
          : h.hasData
            ? undefined
            : "no data loaded yet",
        kind: h.hasData ? ("need" as const) : ("pending" as const),
      };
    });
  });

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

  const best = $derived(data.forecast?.best ?? null);
  const meta = $derived(data.forecast?.meta ?? null);

  function pct(freq: number): string {
    if (freq === 0) return "0%";
    if (freq < 0.01) return "<1%";
    return `${Math.round(freq * 100)}%`;
  }

  function fmtDate(d: Date | string): string {
    return new Date(d).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
</script>

<svelte:head>
  <title>Species forecast · Birds</title>
</svelte:head>

<div class="page">
  <h1>Species forecast</h1>
  <ForecastTabs
    mode="species"
    params={page.url.search.slice(1)}
    month={data.month}
  />
  <p class="intro">
    Best months and places for a species, from prior years' eBird checklist
    frequencies. <a href="/forecast/data">Hotspots &amp; data</a> shows what's
    loaded.
  </p>

  <section class="card">
    {#if data.countries.length > 0}
      <div class="row countrypick">
        <label for="country-search">Country</label>
        <input
          id="country-search"
          type="search"
          placeholder="Search {data.countries.length} countries…"
          autocomplete="off"
          bind:value={countryFilter}
        />
        <select
          id="country"
          aria-label="Country"
          value={data.country}
          onchange={onCountryChange}
        >
          {#if usCountry}
            <optgroup label="United States">
              <option value={usCountry.code}>{usCountry.name}</option>
            </optgroup>
          {/if}
          <optgroup label={data.hasHome ? "All countries (nearest first)" : "All countries"}>
            {#each otherCountries as c (c.code)}
              <option value={c.code}>{c.name}</option>
            {/each}
          </optgroup>
        </select>
      </div>
    {/if}
    <form method="GET" class="pick">
      <div class="row">
        <label for="q">Species</label>
        {#if data.taxon}
          <div class="chosen">
            <strong>{data.taxon.com_name}</strong>
            <span class="sci">{data.taxon.sci_name}</span>
            <a class="change" href={changeSpeciesHref()}>change</a>
          </div>
          <input type="hidden" name="species" value={data.taxon.species_code} />
        {:else}
          <input
            id="q"
            name="q"
            type="search"
            placeholder="Search by common or scientific name…"
            value={data.q}
          />
        {/if}
      </div>
      <div class="row">
        <label for="region"
          >Region{#if data.hasHome}<span class="muted"> (nearest first)</span
            >{/if}</label
        >
        <select id="region" name="region">
          <option value="">Choose a region…</option>
          {#if data.country !== "US"}
            <option
              value={data.country}
              selected={data.country === data.region?.code}
              >Entire {selectedCountryName}</option
            >
          {/if}
          {#each data.states as s (s.code)}
            <option value={s.code} selected={s.code === data.region?.code}
              >{s.name}</option
            >
          {/each}
          {#if regionMissingFromList && data.region}
            <option value={data.region.code} selected>{data.region.name}</option>
          {/if}
        </select>
      </div>
      <input type="hidden" name="country" value={data.country} />
      <input type="hidden" name="month" value={data.month} />
      {#if data.county && data.region && data.county.code.startsWith(`${data.region.code}-`)}
        <input type="hidden" name="county" value={data.county.code} />
      {/if}
      <div class="row">
        <button type="submit">{data.taxon ? "View" : "Search"}</button>
      </div>
    </form>

    {#if data.speciesError}
      <p class="error">{data.speciesError}</p>
    {/if}
    {#if data.regionError}
      <p class="error">{data.regionError}</p>
    {/if}
    {#if !data.hasApiKey}
      <p class="notice">
        The region list needs an eBird API key — add one in
        <a href="/settings">Settings</a>.
      </p>
    {:else if data.statesError}
      <p class="error">{data.statesError}</p>
    {:else if data.statesStale}
      <p class="notice">Region list shown from cache.</p>
    {/if}

    {#if !data.taxon && data.q}
      {#if data.speciesMatches.length === 0}
        <p class="notice">No species matched "{data.q}".</p>
      {:else}
        {#if data.searchScope === "state" && data.region}
          <p class="notice">
            Species reported in {data.region.name}, most frequent first.
          </p>
        {:else if data.searchFellBack && data.region}
          <p class="notice">
            None of these are reported in {data.region.name} — showing all
            matches.
          </p>
        {/if}
        <ul class="matches">
          {#each data.speciesMatches as m (m.species_code)}
            <li>
              <a
                href="?species={m.species_code}&region={encodeURIComponent(
                  data.region?.code ?? '',
                )}"
              >
                {m.com_name} <span class="sci">{m.sci_name}</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>

  {#if data.taxon && data.region}
    <section class="card">
      <h2>{data.taxon.com_name} in {data.region.name}</h2>

      {#if data.forecast}
        {@const f = data.forecast}
        {#if f.neverReported}
          <p>
            Not reported in {data.region.name} checklists in
            {f.meta.beginYear}–{f.meta.endYear}.
          </p>
        {:else}
          {#if best}
            <p class="best">
              Best month: <strong>{MONTH_NAMES[best.month - 1]}</strong> —
              reported on {pct(best.freq)} of checklists (n={best.n.toLocaleString()})
              {#if f.peakPhrase}
                · peaks {f.peakPhrase}
              {/if}
              {#if f.good.length > 1}
                · good {formatMonthWindow(f.good)}
              {/if}
              {#if best.lowSample}
                <span class="lowflag"
                  >— small sample; no month reached the reliable-checklist
                  threshold</span
                >
              {/if}
            </p>
          {/if}
          <FrequencyChart
            months={f.curve}
            weeks={f.weeks}
            showEffort
            highlightMonth={best?.month ?? null}
            caption="Share of {data.region.name} eBird checklists reporting {data
              .taxon.com_name}, by month, {f.meta.beginYear}–{f.meta.endYear}"
          />
          {#if f.migration}
            <!-- td-af8393: emitted only for supported migratory shapes. -->
            <p class="migration">🛫 {f.migration}</p>
          {/if}
        {/if}
        <p class="meta">
          Data: {f.meta.beginYear}–{f.meta.endYear}, fetched
          {fmtDate(f.meta.fetchedAt)} · {f.meta.nSpecies.toLocaleString()} species
          stored{#if f.meta.nUnmatched > 0}
            · {f.meta.nUnmatched} non-species entries{/if}
        </p>
        {#if (f.meta.unmatchedNames?.length ?? 0) > 0}
          <!-- Tier-1 (td-97b22e): the names always shipped; only the count
               rendered. Mostly subspecies/hybrid bar-chart rows. -->
          <details class="unmnames">
            <summary>Show non-species names</summary>
            <p class="meta">{f.meta.unmatchedNames.join(" · ")}</p>
          </details>
        {/if}
        {#if !data.isViewer}
          {#if data.hasLogin}
            <form
              method="POST"
              action="?/loadState"
              use:enhance={() => {
                loading = true;
                return async ({ update }) => {
                  loading = false;
                  await update();
                };
              }}
            >
              <input type="hidden" name="region" value={data.region.code} />
              <input type="hidden" name="force" value="1" />
              <button type="submit" class="secondary" disabled={loading}>
                {loading ? "Queueing…" : "Refresh data"}
              </button>
            </form>
          {:else}
            <p class="notice">
              Refreshing uses your eBird sign-in — add it in
              <a href="/settings">Settings</a>.
            </p>
          {/if}
        {/if}
      {:else}
        <p>No frequency data loaded yet for {data.region.name}.</p>
        {#if data.attempt?.status === "error"}
          <p class="error">
            Last attempt ({fmtDate(data.attempt.lastAttemptAt)}) failed:
            {data.attempt.error}
          </p>
        {/if}
        {#if data.isViewer}
          <p class="notice">
            The account owner hasn't loaded forecast data for this region yet.
          </p>
        {:else if !data.hasLogin}
          <p class="notice">
            Loading frequency data uses your eBird sign-in — add it in
            <a href="/settings">Settings</a>.
          </p>
        {:else}
          <form
            method="POST"
            action="?/loadState"
            use:enhance={() => {
              loading = true;
              return async ({ update }) => {
                loading = false;
                await update();
              };
            }}
          >
            <input type="hidden" name="region" value={data.region.code} />
            <button type="submit" disabled={loading}>
              {loading ? "Queueing…" : "Load data (one eBird request)"}
            </button>
          </form>
        {/if}
      {/if}

      {#if form && "error" in form && form.error}
        <p class="error">{form.error}</p>
      {/if}
      {#if form?.queued}
        <p class="notice ok">
          {form.queued.deduped
            ? `Already loading — ${form.queued.label} is in the queue.`
            : `Queued: ${form.queued.label}.`}
          Progress shows here and in
          <a href="/forecast/data">Hotspots &amp; data</a>.
        </p>
      {/if}
    </section>

    {#if data.taxon && data.region}
      <section class="card">
        <h2>Where in {data.region.name}</h2>
        <form method="GET" class="monthform">
          <input type="hidden" name="species" value={data.taxon.species_code} />
          <input type="hidden" name="region" value={data.region.code} />
          {#if data.county}
            <input type="hidden" name="county" value={data.county.code} />
          {/if}
          <span class="label">Month</span>
          <MonthPicker value={data.month} />
        </form>

        {#if data.countyError}
          <p class="error">{data.countyError}</p>
          <p class="notice">
            Any previously analyzed {countyNounPlural} still rank below; reload
            the page to retry the {countyNoun} list.
          </p>
        {/if}

        {#if progress}
          <p class="coverage">
            {#if data.countyDataYears}{data.countyDataYears.begin}–{data
                .countyDataYears.end} ·
            {/if}{#if data.hasApiKey}{progress.current}/{progress.total}
              {countyNounPlural}{:else}{progress.current} {countyNounPlural} loaded{/if}
            {#if progress.stale > 0}
              · <span class="lowflag">{progress.stale} outdated</span>
            {/if}
            {#if progress.failed > 0}
              · {progress.failed} failed
            {/if}
            · <a href="/forecast/data">details</a>
          </p>
          {#if analyzing && analyzeJob}
            {@const jTotal = analyzeJob.progress.unitsTotal ?? progress.total}
            {@const jDone = analyzeJob.progress.unitsDone ?? progress.current}
            <p class="coverage">
              {analyzeJob.status === "pending"
                ? analyzeJob.progress.phase === "waiting_retry"
                  ? "Analysis hit a temporary eBird problem — it will retry automatically."
                  : "Analysis queued — starting shortly."
                : `Analyzing… ${jDone} of ${jTotal}${analyzeJob.progress.currentUnit ? ` · ${analyzeJob.progress.currentUnit.name}` : ""}`}
            </p>
            <div
              class="progressbar"
              role="progressbar"
              aria-valuenow={jDone}
              aria-valuemin={0}
              aria-valuemax={jTotal}
            >
              <div
                class="fill"
                style="width: {jTotal > 0 ? (jDone / jTotal) * 100 : 0}%"
              ></div>
            </div>
            {#if jobsPoll.isStale}
              <p class="meta">
                Connection to the app lost — the analysis continues on the
                server; progress will catch up when the connection returns.
              </p>
            {/if}
          {:else if progress.current > 0 && progress.remaining > 0}
            <div
              class="progressbar"
              role="progressbar"
              aria-valuenow={progress.current}
              aria-valuemin={0}
              aria-valuemax={progress.total}
            >
              <div
                class="fill"
                style="width: {(progress.current / progress.total) * 100}%"
              ></div>
            </div>
          {/if}

          {#if progress.remaining > 0 && !data.isViewer && !analyzing}
            {#if data.hasLogin}
              <form
                method="POST"
                action="?/analyzeCounties"
                use:enhance={() => {
                  loading = true;
                  return async ({ update }) => {
                    loading = false;
                    await update();
                  };
                }}
                class="analyze"
              >
                <input type="hidden" name="region" value={data.region.code} />
                <button type="submit" disabled={loading}>
                  {loading
                    ? "Queueing…"
                    : progress.current === 0
                      ? `Analyze all ${progress.total} ${countyNounPlural}`
                      : progress.stale > 0 &&
                          progress.current + progress.stale === progress.total
                        ? `Refresh outdated ${countyNounPlural}`
                        : `Analyze ${progress.remaining} remaining ${countyNounPlural}`}
                </button>
              </form>
            {:else}
              <p class="notice">
                Analyzing {countyNounPlural} uses your eBird sign-in — add it
                in
                <a href="/settings">Settings</a>.
              </p>
            {/if}
          {:else if progress.remaining > 0 && data.isViewer}
            <p class="notice">
              {progress.current === 0
                ? `The account owner hasn't analyzed this region's ${countyNounPlural} yet.`
                : `More ${countyNounPlural} can be analyzed by the account owner.`}
            </p>
          {/if}
        {/if}

        {#if data.countyRanking.length > 0}
          {@const reported = data.countyRanking.filter((c) => c.freq > 0)}
          {@const adequate = reported.filter((c) => !c.lowSample)}
          {@const lowSampleCounties = reported.filter((c) => c.lowSample)}
          {@const unreported = data.countyRanking.length - reported.length}
          {#if reported.length === 0}
            <p>
              Not reported in any analyzed {countyNoun}'s checklists in
              {MONTH_NAMES[data.month - 1]}.
            </p>
          {:else}
            {#if adequate.length > 0}
              <p class="summary">
                Best {countyNounPlural} for {data.taxon.com_name} in
                {MONTH_NAMES[data.month - 1]}:
              </p>
              <ol class="ranked">
                {#each adequate.slice(0, 15) as c (c.code)}
                  {@const peak = data.countyPeaks[c.code]}
                  <li>
                    <div class="sp">
                      <span>
                        <a href={countyHref(c.code)} class="name">{c.name}</a>
                        {#if c.seat}
                          <span class="seat">· {c.seat}</span>
                        {/if}
                      </span>
                      <span class="freq"
                        >{pct(c.freq)} of checklists (n={c.n.toLocaleString()})</span
                      >
                    </div>
                    {#if peak && peak.month !== data.month}
                      <div class="peakmonth">
                        peaks in {MONTH_NAMES[peak.month - 1]} ({pct(peak.freq)})
                      </div>
                    {/if}
                    <div class="actions">
                      <a href={countyHref(c.code)}>Hotspots</a>
                      <a
                        href={mapsPlaceUrl({ name: c.mapQuery })}
                        target="_blank"
                        rel="noopener"
                        title="Show {c.name} on Google Maps">📍 Map</a
                      >
                      <a
                        href="https://ebird.org/region/{c.code}"
                        target="_blank"
                        rel="noopener">eBird ↗</a
                      >
                    </div>
                  </li>
                {/each}
              </ol>
            {/if}
            {#if lowSampleCounties.length > 0}
              <details class="lown">
                <summary>
                  {lowSampleCounties.length}
                  {lowSampleCounties.length === 1 ? countyNoun : countyNounPlural}
                  with small samples (fewer than 40 checklists) — not ranked
                </summary>
                <ul class="ranked">
                  {#each lowSampleCounties as c (c.code)}
                    <li>
                      <div class="sp">
                        <span>
                          <a href={countyHref(c.code)} class="name">{c.name}</a>
                          {#if c.seat}
                            <span class="seat">· {c.seat}</span>
                          {/if}
                          <a
                            class="seatmap"
                            href={mapsPlaceUrl({ name: c.mapQuery })}
                            target="_blank"
                            rel="noopener"
                            title="Show {c.name} on Google Maps">📍 Map</a
                          >
                        </span>
                        <span class="freq"
                          >{pct(c.freq)} (n={c.n.toLocaleString()}) †</span
                        >
                      </div>
                    </li>
                  {/each}
                </ul>
              </details>
            {/if}
            {#if unreported > 0}
              <p class="notice">
                Not reported in {unreported} other analyzed
                {unreported === 1 ? countyNoun : countyNounPlural} that month.
              </p>
            {/if}
            {#if progress && progress.stale > 0}
              <p class="meta">
                Includes {progress.stale}
                {progress.stale === 1 ? countyNoun : countyNounPlural} from an
                older year window.
              </p>
            {/if}
          {/if}
        {/if}
      </section>
    {/if}

    {#if data.hotspotError}
      <!-- Mutually exclusive with the drill section, so the anchor is safe. -->
      <section class="card" id="county-hotspots">
        <h2>Hotspots</h2>
        <p class="error">{data.hotspotError}</p>
      </section>
    {/if}

    {#if data.county && data.countyHotspots}
      {@const ch = data.countyHotspots}
      {@const uncovered = ch.selected.filter((h) => !h.current).length}
      <section class="card" id="county-hotspots">
        <h2>
          Hotspots in {data.county.name}{data.county.seat
            ? ` (${data.county.seat})`
            : ""} — {MONTH_NAMES[data.month - 1]}
          <a
            class="seatmap"
            href={mapsPlaceUrl({ name: data.county.mapQuery })}
            target="_blank"
            rel="noopener"
            title="Show {data.county.name} on Google Maps">📍 Map</a
          >
        </h2>
        <p class="coverage">
          {#if ch.dataYears}{ch.dataYears.begin}–{ch.dataYears.end} ·
          {/if}{ch.selected.length} of {ch.totalInCounty} hotspots — picked by
          species count + recent activity
          {#if ch.hotspotListStale}
            · <span class="lowflag">list from cache</span>
          {/if}
          {#if ch.limit < ch.maxLimit && ch.selected.length < ch.totalInCounty}
            · <a href={countyHref(data.county.code, ch.limit + 6)}
              >analyze 6 more</a
            >
          {/if}
          · <a href={countyHref(null)}>close {countyNoun}</a>
        </p>

        {#if uncovered > 0 && !data.isViewer}
          {#if data.hasLogin}
            <form
              method="POST"
              action="?/loadHotspots"
              use:enhance={() => {
                loading = true;
                return async ({ update }) => {
                  loading = false;
                  await update();
                };
              }}
            >
              <input type="hidden" name="region" value={data.region.code} />
              <input type="hidden" name="county" value={data.county.code} />
              <input type="hidden" name="limit" value={ch.limit} />
              <button type="submit" disabled={loading}>
                {loading
                  ? "Queueing…"
                  : `Load data for ${uncovered} hotspot${uncovered === 1 ? "" : "s"}`}
              </button>
            </form>
          {:else}
            <p class="notice">
              Loading hotspot data uses your eBird sign-in — add it in
              <a href="/settings">Settings</a>.
            </p>
          {/if}
        {:else if uncovered > 0 && data.isViewer}
          <p class="notice">
            {uncovered} hotspot{uncovered === 1 ? " has" : "s have"} no current
            data — the account owner can load it.
          </p>
        {/if}

        {#if ch.ranking.length > 0}
          {@const reportedHs = ch.ranking.filter((h) => h.freq > 0)}
          {@const adequateHs = reportedHs.filter((h) => !h.lowSample)}
          {@const lowHs = reportedHs.filter((h) => h.lowSample)}
          {#if reportedHs.length === 0}
            <p>
              Not reported at the loaded hotspots' checklists in
              {MONTH_NAMES[data.month - 1]}.
            </p>
          {:else}
            {#if adequateHs.length > 0}
              <ol class="ranked">
                {#each adequateHs as h (h.code)}
                  {@const sel = ch.selected.find((s) => s.locId === h.code)}
                  <li>
                    <div class="sp">
                      <a class="name" href={`/hotspots/${h.code}?returnTo=${encodeURIComponent(page.url.pathname + page.url.search)}`}
                        >{h.name}</a
                      >
                      <span class="freq"
                        >{pct(h.freq)} of checklists (n={h.n.toLocaleString()})</span
                      >
                    </div>
                    {#if sel}
                      <div class="actions">
                        <MapLink lat={sel.lat} lng={sel.lng} name={h.name} />
                        <a
                          href="https://ebird.org/hotspot/{h.code}"
                          target="_blank"
                          rel="noopener">eBird ↗</a
                        >
                        <a href={needsHereHref({ ...sel, locName: h.name })}
                          >My needs here</a
                        >
                        <a href={addToTripHref({ ...sel, locName: h.name })}
                          >Add to trip</a
                        >
                      </div>
                    {/if}
                  </li>
                {/each}
              </ol>
            {/if}
            {#if lowHs.length > 0}
              <details class="lown">
                <summary>
                  {lowHs.length} hotspot{lowHs.length === 1 ? "" : "s"} with
                  small samples (fewer than 40 checklists) — not ranked
                </summary>
                <ul class="ranked">
                  {#each lowHs as h (h.code)}
                    {@const sel = ch.selected.find((s) => s.locId === h.code)}
                    <li>
                      <div class="sp">
                        <a class="name" href={`/hotspots/${h.code}?returnTo=${encodeURIComponent(page.url.pathname + page.url.search)}`}
                        >{h.name}</a
                      >
                        <span class="freq"
                          >{pct(h.freq)} (n={h.n.toLocaleString()}) †</span
                        >
                      </div>
                      {#if sel}
                        <div class="actions">
                          <MapLink lat={sel.lat} lng={sel.lng} name={h.name} />
                          <a
                            href="https://ebird.org/hotspot/{h.code}"
                            target="_blank"
                            rel="noopener">eBird ↗</a
                          >
                          <a href={needsHereHref({ ...sel, locName: h.name })}
                            >My needs here</a
                          >
                          <a href={addToTripHref({ ...sel, locName: h.name })}
                            >Add to trip</a
                          >
                        </div>
                      {/if}
                    </li>
                  {/each}
                </ul>
              </details>
            {/if}
          {/if}
        {/if}

        {#if hotspotPoints.length > 0}
          <div class="map">
            <ObsMap points={hotspotPoints} />
          </div>
        {/if}
      </section>
    {/if}
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
  .muted {
    color: var(--muted);
    font-weight: 400;
    font-size: 0.85em;
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
    margin: 0 0 10px;
  }
  .pick .row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }
  .countrypick {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }
  label {
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
  button.secondary {
    background: var(--card);
    color: var(--accent);
    border: 1px solid var(--accent);
  }
  .chosen {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    min-height: 48px;
    align-content: center;
  }
  .sci {
    color: var(--muted);
    font-style: italic;
    font-size: 0.88rem;
  }
  .change {
    font-size: 0.88rem;
  }
  .matches {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
  }
  .matches li a {
    display: block;
    padding: 12px 8px;
    border-top: 1px solid var(--border);
    text-decoration: none;
    color: var(--text);
  }
  .matches li a:hover {
    background: var(--bg);
  }
  .best {
    font-size: 1rem;
  }
  .peakmonth {
    color: var(--muted);
    font-size: 0.82rem;
    margin-top: 2px;
  }
  .seat {
    color: var(--muted);
    font-size: 0.88rem;
    font-weight: 400;
  }
  .seatmap {
    color: var(--link);
    text-decoration: none;
    font-size: 0.85rem;
    font-weight: 600;
    white-space: nowrap;
    padding: 0 6px;
    min-height: 48px;
    display: inline-flex;
    align-items: center;
    vertical-align: middle;
  }
  .seatmap:hover {
    text-decoration: underline;
  }
  .lowflag {
    color: var(--muted);
    font-size: 0.88rem;
  }
  .meta {
    color: var(--muted);
    font-size: 0.82rem;
    margin: 10px 0;
  }
  .monthform {
    margin-bottom: 12px;
  }
  .monthform .label {
    display: block;
    font-weight: 600;
    font-size: 0.88rem;
    margin-bottom: 4px;
  }
  .coverage {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0 0 10px;
  }
  .progressbar {
    height: 8px;
    background: var(--accent-soft);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 10px;
  }
  .progressbar .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.4s ease;
  }
  .summary {
    margin: 14px 0 8px;
  }
  .ranked {
    margin: 0;
    padding-left: 1.4em;
  }
  .ranked li {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .ranked li:last-child {
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
  .map {
    margin-top: 14px;
  }
  .lown {
    margin-top: 14px;
  }
  .lown summary {
    cursor: pointer;
    color: var(--accent);
    font-size: 0.9rem;
    min-height: 48px;
    display: flex;
    align-items: center;
  }
  .lown ul {
    list-style: none;
    padding-left: 0;
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
  .analyze {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 10px;
  }
  button.secondary {
    background: var(--card);
    color: var(--accent);
    border: 1px solid var(--accent);
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
    .pick {
      display: flex;
      gap: 12px;
      align-items: flex-end;
    }
    .pick .row {
      margin-bottom: 0;
    }
    .pick .row:first-child {
      flex: 1;
    }
  }
  .unmnames summary {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    cursor: pointer;
    color: var(--accent);
    font-weight: 600;
    font-size: 0.85rem;
  }
  .migration {
    color: var(--text);
    font-weight: 600;
    font-size: 0.92rem;
    margin: 8px 0 0;
  }
</style>
