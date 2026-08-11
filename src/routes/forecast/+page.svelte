<script lang="ts">
  import { enhance } from "$app/forms";
  import { page } from "$app/state";
  import MonthPicker from "$components/MonthPicker.svelte";
  import { formatDistance } from "$lib/geo";
  import { speciesLinkHref } from "$lib/species-context";
  import { SPECIES_DEFAULT_BACK_DAYS } from "$lib/time-windows";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();

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

  const covered = $derived(
    data.view ? data.view.analyzed.filter((a) => a.hasData).length : 0,
  );
  const uncovered = $derived(
    data.view ? data.view.analyzed.length - covered : 0,
  );
  const wellSampled = $derived(
    data.view ? data.view.species.filter((s) => !s.lowSample) : [],
  );
  const lowSampled = $derived(
    data.view ? data.view.species.filter((s) => s.lowSample) : [],
  );

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
  <p class="intro">
    Which species you still need are likely near a place in a given month,
    from prior years' eBird checklist frequencies. Looking for one species?
    <a href="/forecast/species">Species forecast</a> · What's loaded?
    <a href="/forecast/data">Forecast data</a>.
  </p>

  <section class="card">
    <form method="GET" class="filters">
      <div class="row">
        <label for="place">Near</label>
        <input
          id="place"
          name="place"
          type="search"
          placeholder={data.location && !data.placeQuery
            ? `${data.location.label} (saved home)`
            : "City, county, park, or address…"}
          value={data.placeQuery}
        />
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
      <noscript><button type="submit">Update</button></noscript>
    </form>
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
        Analyzed {v.analyzed.length} of {v.totalNearby} hotspots in range
        · {covered} with frequency data
        {#if v.outdatedCount > 0}
          · <span class="stale">{v.outdatedCount} outdated</span>
        {/if}
        {#if v.oldestFetchedAt}
          · oldest data {fmtDate(v.oldestFetchedAt)}
        {/if}
        {#if v.hotspotListStale}
          · <span class="stale">hotspot list from cache</span>
        {/if}
      </p>

      {#if (uncovered > 0 || v.outdatedCount > 0) && !data.isViewer}
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
                : uncovered > 0
                  ? `Load data for ${uncovered} hotspot${uncovered === 1 ? "" : "s"}`
                  : `Refresh outdated data (${v.outdatedCount} hotspot${v.outdatedCount === 1 ? "" : "s"})`}
            </button>
          </form>
        {/if}
      {/if}
      {#if uncovered > 0 && data.isViewer}
        <p class="notice">
          {covered === 0
            ? "The account owner hasn't loaded forecast data for this area yet."
            : "Some hotspots here have no data yet — the account owner can load it."}
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

      {#if covered > 0}
        {#if v.species.length === 0}
          <p>
            No needed species in the loaded data for
            {MONTH_NAMES[v.month - 1]} — nice life list!
          </p>
        {:else}
          <p class="summary">
            <strong>{v.species.length}</strong> needed species reported here in
            {MONTH_NAMES[v.month - 1]}{#if v.dataYears}
              ({v.dataYears.begin}–{v.dataYears.end} checklists){/if}.
          </p>
          <ol class="needs">
            {#each wellSampled as s (s.code)}
              <li>
                <div class="sp">
                  <a href={speciesHref(s.code)} class="name">{s.comName}</a>
                  <span class="freq"
                    >{pct(s.areaFreq)} of checklists (n={s.areaN.toLocaleString()})</span
                  >
                </div>
                {#if s.topHotspots.length > 0}
                  <div class="best">
                    best: {#each s.topHotspots as h, i (h.locId)}{i > 0
                        ? " · "
                        : ""}{h.locName} ({pct(h.freq)}{h.lowSample
                        ? " †"
                        : ""}){/each}
                  </div>
                {/if}
              </li>
            {/each}
          </ol>
          {#if lowSampled.length > 0}
            <details class="lown">
              <summary>
                {lowSampled.length} more with small samples (fewer than 40
                checklists)
              </summary>
              <ol class="needs">
                {#each lowSampled as s (s.code)}
                  <li>
                    <div class="sp">
                      <a href={speciesHref(s.code)} class="name">{s.comName}</a>
                      <span class="freq"
                        >{pct(s.areaFreq)} (n={s.areaN.toLocaleString()})</span
                      >
                    </div>
                  </li>
                {/each}
              </ol>
            </details>
          {/if}
        {/if}
      {/if}

      <details class="analyzed">
        <summary>Analyzed hotspots</summary>
        <ul>
          {#each v.analyzed as h (h.locId)}
            <li>
              {h.locName}
              <span class="meta">
                {formatDistance(h.distanceKm, "mi")} ·
                {h.hasData && h.fetchedAt
                  ? `data from ${fmtDate(h.fetchedAt)}`
                  : "no data yet"}
              </span>
            </li>
          {/each}
        </ul>
      </details>
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
</style>
