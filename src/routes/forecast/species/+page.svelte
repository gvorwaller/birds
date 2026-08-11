<script lang="ts">
  import { enhance } from "$app/forms";
  import FrequencyChart from "$components/FrequencyChart.svelte";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();

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
  <p class="intro">
    Best months for a species in a state, from prior years' eBird checklist
    frequencies. Area needs by month?
    <a href="/forecast">Forecast</a> · What's loaded?
    <a href="/forecast/data">Forecast data</a>.
  </p>

  <section class="card">
    <form method="GET" class="pick">
      <div class="row">
        <label for="q">Species</label>
        {#if data.taxon}
          <div class="chosen">
            <strong>{data.taxon.com_name}</strong>
            <span class="sci">{data.taxon.sci_name}</span>
            <a
              class="change"
              href="?region={encodeURIComponent(data.region?.code ?? '')}"
              >change</a
            >
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
        <label for="region">State</label>
        <select id="region" name="region">
          <option value="">Choose a state…</option>
          {#each data.states as s (s.code)}
            <option value={s.code} selected={s.code === data.region?.code}
              >{s.name}</option
            >
          {/each}
        </select>
      </div>
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
        The state list needs an eBird API key — add one in
        <a href="/settings">Settings</a>.
      </p>
    {:else if data.statesError}
      <p class="error">{data.statesError}</p>
    {/if}

    {#if !data.taxon && data.q}
      {#if data.speciesMatches.length === 0}
        <p class="notice">No species matched "{data.q}".</p>
      {:else}
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
            highlightMonth={best?.month ?? null}
            caption="Share of {data.region.name} eBird checklists reporting {data
              .taxon.com_name}, by month, {f.meta.beginYear}–{f.meta.endYear}"
          />
        {/if}
        <p class="meta">
          Data: {f.meta.beginYear}–{f.meta.endYear}, fetched
          {fmtDate(f.meta.fetchedAt)} · {f.meta.nSpecies.toLocaleString()} species
          stored{#if f.meta.nUnmatched > 0}
            · {f.meta.nUnmatched} names not matched to the taxonomy{/if}
        </p>
        {#if !data.isViewer}
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
              {loading ? "Refreshing…" : "Refresh data"}
            </button>
          </form>
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
            The account owner hasn't loaded forecast data for this state yet.
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
              {loading ? "Loading from eBird…" : "Load data (one eBird request)"}
            </button>
          </form>
        {/if}
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
            Could not load data: {form.ensure.failed[0].error}
          </p>
        {:else if form.ensure.refreshed.length > 0}
          <p class="notice ok">Data loaded from eBird.</p>
        {:else if form.ensure.ready.length > 0}
          <p class="notice ok">Data was already up to date.</p>
        {/if}
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
    margin: 0 0 10px;
  }
  .pick .row {
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
  .lowflag {
    color: var(--muted);
    font-size: 0.88rem;
  }
  .meta {
    color: var(--muted);
    font-size: 0.82rem;
    margin: 10px 0;
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
</style>
