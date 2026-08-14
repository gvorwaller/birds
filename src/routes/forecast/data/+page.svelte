<script lang="ts">
  import { enhance } from "$app/forms";
  import { browser } from "$app/environment";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let refreshing = $state<string | null>(null);

  // Which state sections are expanded — remembered across sessions (GBV).
  const OPEN_KEY = "forecast-data-open-states";
  function readOpen(): string[] {
    if (!browser) return [];
    try {
      const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  let openStates = $state<string[]>([]);
  $effect(() => {
    openStates = readOpen();
  });
  function toggleState(code: string, open: boolean) {
    const next = openStates.filter((c) => c !== code);
    if (open) next.push(code);
    openStates = next;
    if (browser) {
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        // private mode
      }
    }
  }

  // Hotspot rows collapse under their county row (GBV: dozens of hotspots
  // per county get unwieldy). Collapsed by default; remembered like states.
  const OPEN_COUNTIES_KEY = "forecast-data-open-counties";
  let openCounties = $state<string[]>([]);
  $effect(() => {
    if (!browser) return;
    try {
      const v = JSON.parse(localStorage.getItem(OPEN_COUNTIES_KEY) ?? "[]");
      openCounties = Array.isArray(v)
        ? v.filter((x) => typeof x === "string")
        : [];
    } catch {
      openCounties = [];
    }
  });
  function toggleCounty(code: string) {
    const open = !openCounties.includes(code);
    const next = openCounties.filter((c) => c !== code);
    if (open) next.push(code);
    openCounties = next;
    if (browser) {
      try {
        localStorage.setItem(OPEN_COUNTIES_KEY, JSON.stringify(next));
      } catch {
        // private mode
      }
    }
  }

  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
</script>

{#snippet metaCells(r: PageData["stateGroups"][number]["stateHotspots"][number])}
  <td>
    {r.beginYear}–{r.endYear}
    {#if !r.current}
      <span class="outdated">outdated</span>
    {/if}
  </td>
  <td>{r.nSpecies.toLocaleString()}</td>
  <td>{fmtDate(r.fetchedAt)}</td>
  {#if !data.isViewer}
    <td>
      <form
        method="POST"
        action="?/refresh"
        use:enhance={() => {
          refreshing = r.locCode;
          return async ({ update }) => {
            refreshing = null;
            await update();
          };
        }}
      >
        <input type="hidden" name="loc" value={r.locCode} />
        <button
          type="submit"
          class="secondary"
          disabled={refreshing !== null}
        >
          {refreshing === r.locCode ? "Refreshing…" : "Refresh"}
        </button>
      </form>
    </td>
  {/if}
{/snippet}

{#snippet dataRowCells(
  r: PageData["stateGroups"][number]["stateHotspots"][number],
  indent: boolean,
)}
  <tr class:indent>
    <td>
      {#if indent}<span class="twig" aria-hidden="true">↳</span>{/if}
      <strong>{r.locName}</strong>
      <span class="code">{r.locCode}</span>
    </td>
    {@render metaCells(r)}
  </tr>
{/snippet}

{#snippet dataTable(label: string, rows: PageData["stateGroups"][number]["stateHotspots"])}
  <div class="tablewrap">
    <table>
      <thead>
        <tr>
          <th>{label}</th>
          <th>Years</th>
          <th>Species</th>
          <th>Loaded</th>
          {#if !data.isViewer}<th></th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.locCode)}
          {@render dataRowCells(r, false)}
        {/each}
      </tbody>
    </table>
  </div>
{/snippet}

<svelte:head>
  <title>Forecast data · Birds</title>
</svelte:head>

<div class="page">
  <h1>Forecast data</h1>
  <p class="intro">
    Frequency data stored from eBird bar-chart exports — what's loaded, how
    current it is, and when it was fetched. Data refreshes matter only once a
    year, when a new complete year of checklists becomes available.
    <a href="/forecast">← Back to Forecast</a>
  </p>

  {#if form && "error" in form && form.error}
    <p class="error">{form.error}</p>
  {/if}
  {#if form?.ensure}
    {#if form.ensure.credentialProblem}
      <p class="error">{form.ensure.credentialProblem}</p>
    {:else if form.ensure.busy}
      <p class="notice">Another data load is already running — try again in a moment.</p>
    {:else if form.ensure.failed.length > 0}
      <p class="error">Refresh failed: {form.ensure.failed[0].error}</p>
    {:else if form.ensure.refreshed.length > 0}
      <p class="notice ok">
        {#if "progress" in form && form.progress}
          Analyzed {form.ensure.refreshed.length} count{form.ensure.refreshed
            .length === 1
            ? "y"
            : "ies"} — {form.progress.current}/{form.progress.total} done.
        {:else}
          Refreshed {form.ensure.refreshed[0]}.
        {/if}
      </p>
    {/if}
  {/if}

  {#if !data.isViewer}
    <section class="card">
      <h2>Load a state</h2>
      {#if !data.hasApiKey}
        <p class="notice">
          The state list needs an eBird API key — add one in
          <a href="/settings">Settings</a>.
        </p>
      {:else if data.statesError}
        <p class="error">{data.statesError}</p>
      {:else}
        <form
          method="POST"
          action="?/loadRegion"
          class="loadstate"
          use:enhance={() => {
            refreshing = "new-region";
            return async ({ update }) => {
              refreshing = null;
              await update();
            };
          }}
        >
          <select name="region" required>
            <option value="">Choose a state…</option>
            {#each data.states as s (s.code)}
              <option value={s.code}>{s.name}</option>
            {/each}
          </select>
          <button type="submit" disabled={refreshing !== null}>
            {refreshing === "new-region"
              ? "Loading from eBird…"
              : "Load data (one eBird request)"}
          </button>
        </form>
        <p class="notice">
          Statewide data powers the Species forecast month curves. Already
          loaded states aren't listed.
        </p>
      {/if}
    </section>
  {/if}

  <section class="card">
    <h2>
      Loaded data ({data.stateGroups.length} state{data.stateGroups.length ===
      1
        ? ""
        : "s"})
    </h2>
    {#if data.stateGroups.length === 0}
      <p class="notice">Nothing loaded yet — load a state above.</p>
    {:else}
      {#each data.stateGroups as g (g.stateCode)}
        <details
          class="stategroup"
          open={openStates.includes(g.stateCode)}
          ontoggle={(e) => toggleState(g.stateCode, e.currentTarget.open)}
        >
          <summary>
            <strong>{g.stateName}</strong>
            <span class="groupmeta">
              {#if g.state}
                statewide{g.state.current ? "" : " (outdated)"} ·
              {/if}
              {g.countiesLoaded}{g.countyTotal != null
                ? ` of ${g.countyTotal}`
                : ""} count{g.countiesLoaded === 1 && g.countyTotal == null
                ? "y"
                : "ies"}
              · {g.hotspotCount} hotspot{g.hotspotCount === 1 ? "" : "s"}
            </span>
          </summary>
          {#if !data.isViewer && (g.countyRemaining ?? 0) > 0}
            {@const missing = g.countyRemaining ?? 0}
            {#if data.hasLogin}
              <form
                method="POST"
                action="?/analyzeCounties"
                class="groupaction"
                use:enhance={() => {
                  refreshing = `counties-${g.stateCode}`;
                  return async ({ update }) => {
                    refreshing = null;
                    await update();
                  };
                }}
              >
                <input type="hidden" name="region" value={g.stateCode} />
                <button type="submit" disabled={refreshing !== null}>
                  {refreshing === `counties-${g.stateCode}`
                    ? "Analyzing…"
                    : `Analyze ${Math.min(12, missing)} remaining ${missing === 1 ? "county" : "counties"}`}
                </button>
              </form>
            {:else}
              <p class="notice">
                Analyzing counties uses your eBird sign-in — add it in
                <a href="/settings">Settings</a>.
              </p>
            {/if}
          {/if}
          {#if g.state}
            {@render dataTable("Statewide", [g.state])}
          {/if}
          {#if g.countyBlocks.length > 0}
            <div class="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>County · hotspots</th>
                    <th>Years</th>
                    <th>Species</th>
                    <th>Loaded</th>
                    {#if !data.isViewer}<th></th>{/if}
                  </tr>
                </thead>
                <tbody>
                  {#each g.countyBlocks as b (b.countyCode)}
                    {@const open = openCounties.includes(b.countyCode)}
                    <tr>
                      <td>
                        {#if b.hotspots.length > 0}
                          <button
                            type="button"
                            class="ctoggle"
                            aria-expanded={open}
                            onclick={() => toggleCounty(b.countyCode)}
                          >
                            <span class="chev" aria-hidden="true"
                              >{open ? "▾" : "▸"}</span
                            >
                            <strong>{b.countyName}</strong>
                            <span class="hscount"
                              >{b.hotspots.length} hotspot{b.hotspots.length ===
                              1
                                ? ""
                                : "s"}</span
                            >
                          </button>
                        {:else}
                          <strong>{b.countyName}</strong>
                        {/if}
                        <span class="code">{b.countyCode}</span>
                      </td>
                      {#if b.county}
                        {@render metaCells(b.county)}
                      {:else}
                        <!-- Hotspots loaded before their county was analyzed -->
                        <td colspan={data.isViewer ? 3 : 4} class="muted"
                          >county not analyzed yet</td
                        >
                      {/if}
                    </tr>
                    {#if open}
                      {#each b.hotspots as h (h.locCode)}
                        {@render dataRowCells(h, true)}
                      {/each}
                    {/if}
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
          {#if g.stateHotspots.length > 0}
            <p class="notice">
              Hotspots below have no recorded county — refreshing them (or the
              next area load) files them correctly.
            </p>
            {@render dataTable("Hotspot", g.stateHotspots)}
          {/if}
        </details>
      {/each}
      {#if data.orphanHotspots.length > 0}
        <details class="stategroup">
          <summary>
            <strong>Other hotspots</strong>
            <span class="groupmeta">
              {data.orphanHotspots.length} without a recorded state — Forecast
              near the hotspot to record it
            </span>
          </summary>
          {@render dataTable("Hotspot", data.orphanHotspots)}
        </details>
      {/if}
    {/if}
  </section>

  {#if data.failed.length > 0}
    <section class="card">
      <h2>Failed loads ({data.failed.length})</h2>
      <p class="notice">
        These locations were attempted but have no stored data. eBird's export
        sometimes errors on individual hotspots — retrying later often works.
      </p>
      <ul class="failed">
        {#each data.failed as f (f.locCode)}
          <li>
            <div class="failinfo">
              <strong>{f.locName ?? f.locCode}</strong>
              {#if f.regionName}
                <span class="region">· {f.regionName}</span>
              {/if}
              <span class="code">{f.locCode}</span>
              <span class="err">{f.error ?? "unknown error"}</span>
              <span class="when">{fmtDate(f.lastAttemptAt)}</span>
            </div>
            {#if !data.isViewer}
              <form
                method="POST"
                action="?/retry"
                use:enhance={() => {
                  refreshing = f.locCode;
                  return async ({ update }) => {
                    refreshing = null;
                    await update();
                  };
                }}
              >
                <input type="hidden" name="loc" value={f.locCode} />
                <button
                  type="submit"
                  class="secondary"
                  disabled={refreshing !== null}
                >
                  {refreshing === f.locCode ? "Retrying…" : "Retry"}
                </button>
              </form>
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <p class="attribution">
    Data from
    <a href="https://ebird.org" target="_blank" rel="noopener">eBird.org</a>
  </p>
</div>

<style>
  .page {
    max-width: 860px;
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
    font-size: 1.05rem;
    margin: 0 0 10px;
  }
  .stategroup {
    border-top: 1px solid var(--border);
  }
  .stategroup:first-of-type {
    border-top: none;
  }
  .stategroup summary {
    cursor: pointer;
    min-height: 48px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    color: var(--text);
    font-size: 0.95rem;
  }
  .stategroup summary:hover {
    background: var(--bg);
  }
  .groupmeta {
    color: var(--muted);
    font-size: 0.82rem;
  }
  .stategroup .tablewrap {
    margin: 0 0 12px 12px;
  }
  .groupaction {
    margin: 4px 0 12px 12px;
  }
  tr.indent td:first-child {
    padding-left: 34px;
  }
  .ctoggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    padding: 6px 4px 6px 0;
    min-height: 48px;
    cursor: pointer;
    color: var(--text);
    font-size: inherit;
    text-align: left;
  }
  .ctoggle:hover .hscount {
    text-decoration: underline;
  }
  .chev {
    color: var(--accent);
    width: 12px;
  }
  .hscount {
    color: var(--accent);
    font-size: 0.82rem;
    white-space: nowrap;
  }
  tr.indent strong {
    font-weight: 500;
  }
  .twig {
    color: var(--muted);
    margin-right: 4px;
  }
  .muted {
    color: var(--muted);
  }
  .groupaction button {
    min-height: 48px;
    padding: 10px 18px;
    font-size: 1rem;
    border: none;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
  }
  .groupaction button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .tablewrap {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }
  th {
    text-align: left;
    color: var(--muted);
    font-weight: 600;
    font-size: 0.8rem;
    padding: 6px 10px 6px 0;
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: 8px 10px 8px 0;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  tr:last-child td {
    border-bottom: none;
  }
  .code {
    display: block;
    color: var(--muted);
    font-size: 0.78rem;
  }
  .outdated {
    display: inline-block;
    background: var(--need-bg);
    color: var(--need-text);
    font-size: 0.75rem;
    font-weight: 600;
    border-radius: 6px;
    padding: 1px 6px;
    margin-left: 4px;
  }
  button.secondary {
    min-height: 48px;
    padding: 6px 14px;
    font-size: 0.88rem;
    border-radius: 8px;
    background: var(--card);
    color: var(--accent);
    border: 1px solid var(--accent);
    cursor: pointer;
  }
  button.secondary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .failed {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .failed li {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.88rem;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  }
  .failed li:last-child {
    border-bottom: none;
  }
  .failinfo {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: baseline;
    min-width: 0;
  }
  .failed .code {
    display: inline;
  }
  .region {
    color: var(--muted);
  }
  .loadstate {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }
  .loadstate select {
    flex: 1;
    min-width: 200px;
    font-size: 16px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    min-height: 48px;
  }
  .loadstate button {
    min-height: 48px;
    padding: 10px 18px;
    font-size: 1rem;
    border: none;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
  }
  .loadstate button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .err {
    color: var(--danger);
  }
  .when {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .error {
    color: var(--danger);
    font-weight: 600;
    margin: 10px 0;
  }
  .notice {
    color: var(--muted);
    margin: 8px 0;
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
  }
</style>
