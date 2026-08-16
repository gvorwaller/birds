<script lang="ts">
  import { enhance } from "$app/forms";
  import { browser } from "$app/environment";
  import { mapsPlaceUrl } from "$lib/geo";
  import { jobsPoll } from "$lib/job-poll.svelte";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let refreshing = $state<string | null>(null);

  // This page is the load/progress hub — force a fresh poll on arrival so
  // the jobs list is current even if the poller had gone idle.
  $effect(() => {
    jobsPoll.track(0);
  });

  // Any action that returns {queued} gets tracked so the new job appears in
  // the active list within one poll tick. Duplicate tracks are harmless.
  $effect(() => {
    const q = form && "queued" in form ? form.queued : null;
    if (q) jobsPoll.track(q.jobId);
  });

  // Cancel is destructive AND communal (any non-viewer can cancel anyone's
  // load) → modal confirmation per cs.md (GROK Phase-1 review #3).
  let cancelTarget = $state<{ id: number; name: string; by: string | null } | null>(null);
  function confirmCancel() {
    if (!cancelTarget) return;
    void jobsPoll.cancel(cancelTarget.id);
    cancelTarget = null;
  }

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

  function fmtTime(iso: string): string {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function fmtDuration(ms: number | null): string {
    if (ms == null) return "";
    if (ms < 1000) return "<1 s";
    const s = Math.round(ms / 1000);
    if (s < 90) return `${s} s`;
    return `${Math.round(s / 60)} min`;
  }

  function jobDuration(j: (typeof jobsPoll.jobs)[number]): number | null {
    if (!j.finishedAt) return null;
    return new Date(j.finishedAt).getTime() - new Date(j.enqueuedAt).getTime();
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
          {refreshing === r.locCode ? "Queueing…" : "Refresh"}
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
  {#if form?.queued}
    <p class="notice ok">
      {form.queued.deduped
        ? `Already loading — ${form.queued.label} is in the queue.`
        : `Queued: ${form.queued.label}.`}
    </p>
  {/if}

  <section class="card">
    <h2>Background loads</h2>
    {#if jobsPoll.worker && !jobsPoll.worker.alive}
      <p class="error">
        The background worker isn't running — queued loads will wait until it
        returns. (It restarts automatically on deploys; if this persists,
        something is wrong.)
      </p>
    {/if}
    {#if jobsPoll.isStale}
      <p class="notice">
        Connection to the app lost — loads continue on the server; this list
        will catch up when the connection returns.
      </p>
    {/if}
    {#if jobsPoll.active.length === 0}
      <p class="notice">No loads running or queued.</p>
    {:else}
      <ul class="jobs">
        {#each jobsPoll.active as j (j.id)}
          {@const total = j.progress.unitsTotal ?? 0}
          {@const done = j.progress.unitsDone ?? 0}
          <li>
            <div class="jobhead">
              <strong>{j.displayName}</strong>
              {#if j.requestedByName}
                <span class="jobby">queued by {j.requestedByName}</span>
              {/if}
              <span class="jobstatus" data-color={j.statusColor}>
                {#if j.cancelRequested}
                  cancelling…
                {:else if j.status === "running"}
                  running{#if total > 0}
                    &nbsp;— {done} of {total}{/if}
                {:else if j.progress.phase === "waiting_retry"}
                  retrying {j.nextRetryAt ? `at ${fmtTime(j.nextRetryAt)}` : "soon"}
                  (attempt {j.attempts} of {j.maxAttempts})
                {:else}
                  queued
                {/if}
              </span>
              {#if !data.isViewer && !j.cancelRequested}
                <button
                  type="button"
                  class="secondary"
                  onclick={() =>
                    (cancelTarget = {
                      id: j.id,
                      name: j.displayName,
                      by: j.requestedByName,
                    })}
                >
                  Cancel
                </button>
              {/if}
            </div>
            {#if j.status === "running" && total > 0}
              <div
                class="progressbar"
                role="progressbar"
                aria-valuenow={done}
                aria-valuemin={0}
                aria-valuemax={total}
              >
                <div class="fill" style="width: {(done / total) * 100}%"></div>
              </div>
              {#if j.progress.currentUnit}
                <p class="jobdetail">now: {j.progress.currentUnit.name}</p>
              {/if}
            {/if}
            {#if j.progress.lastError}
              <p class="jobdetail err">last problem: {j.progress.lastError}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if jobsPoll.recent.length > 0}
      <details class="history">
        <summary>Recent loads ({jobsPoll.recent.length})</summary>
        <ul class="jobs">
          {#each jobsPoll.recent as j (j.id)}
            <li>
              <div class="jobhead">
                <strong>{j.displayName}</strong>
                {#if j.requestedByName}
                  <span class="jobby">queued by {j.requestedByName}</span>
                {/if}
                <span class="jobstatus" data-color={j.statusColor}>
                  {j.status}{#if j.finishedAt}
                    &nbsp;· {fmtDate(j.finishedAt)}
                    {fmtTime(j.finishedAt)}{/if}{#if jobDuration(j) != null}
                    &nbsp;· {fmtDuration(jobDuration(j))}{/if}
                </span>
              </div>
              {#if j.error}
                <p class="jobdetail err">{j.error}</p>
              {/if}
              {#if (j.progress.unitsFailed ?? 0) > 0}
                <p class="jobdetail">
                  {j.progress.unitsFailed} of {j.progress.unitsTotal} location{(j
                    .progress.unitsFailed ?? 0) === 1
                    ? ""
                    : "s"} failed — see Failed loads below.
                </p>
              {/if}
            </li>
          {/each}
        </ul>
      </details>
    {/if}
  </section>

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
              ? "Queueing…"
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
                    ? "Queueing…"
                    : `Analyze ${missing} remaining ${missing === 1 ? "county" : "counties"}`}
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
                        {#if b.seat}
                          <span class="seat">· {b.seat}</span>
                        {/if}
                        <a
                          class="seatmap"
                          href={mapsPlaceUrl({ name: b.mapQuery })}
                          target="_blank"
                          rel="noopener"
                          title="Show {b.countyName} on Google Maps">📍</a
                        >
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
                  {refreshing === f.locCode ? "Queueing…" : "Retry"}
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

<!-- Destructive + communal action → modal confirmation (cs.md; GROK #3).
     Escape and overlay-click dismiss (GROK nit, Phase 2). -->
<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && cancelTarget) cancelTarget = null;
  }}
/>
{#if cancelTarget}
  <div
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="cancel-title"
  >
    <button
      class="modal-scrim"
      aria-label="Close dialog"
      onclick={() => (cancelTarget = null)}
    ></button>
    <div class="modal">
      <h3 id="cancel-title">Cancel this load?</h3>
      <p>
        "{cancelTarget.name}"{cancelTarget.by ? ` — queued by ${cancelTarget.by}` : ""}
        will stop after its current location. Data already loaded is kept;
        the rest stays unloaded until someone queues it again.
      </p>
      <div class="modal-actions">
        <button type="button" class="secondary" onclick={() => (cancelTarget = null)}>
          Keep loading
        </button>
        <button type="button" class="danger-solid" onclick={confirmCancel}>
          Cancel load
        </button>
      </div>
    </div>
  </div>
{/if}

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
  .jobs {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .jobs li {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .jobs li:last-child {
    border-bottom: none;
  }
  .jobhead {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }
  .jobstatus {
    font-size: 0.85rem;
    color: var(--muted);
    font-weight: 600;
  }
  .jobby {
    font-size: 0.82rem;
    color: var(--muted);
  }
  .seat {
    color: var(--muted);
    font-size: 0.82rem;
  }
  .seatmap {
    color: var(--link);
    text-decoration: none;
    font-size: 0.85rem;
    font-weight: 600;
    white-space: nowrap;
    padding: 4px 6px;
  }
  .seatmap:hover {
    text-decoration: underline;
  }
  .modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 2000;
    background: rgba(33, 37, 41, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .modal-scrim {
    position: absolute;
    inset: 0;
    background: none;
    border: none;
    cursor: default;
  }
  .modal {
    position: relative;
    background: var(--card);
    border-radius: 8px;
    padding: 24px;
    max-width: 420px;
    width: 100%;
  }
  .modal h3 {
    margin-bottom: 8px;
  }
  .modal p {
    color: var(--muted);
    margin-bottom: 20px;
  }
  .modal-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .danger-solid {
    min-height: 48px;
    padding: 10px 18px;
    font-size: 0.95rem;
    border: none;
    border-radius: 8px;
    background: var(--danger);
    color: #fff;
    cursor: pointer;
  }
  .jobstatus[data-color="ok"],
  .jobstatus[data-color="busy"] {
    color: var(--accent);
  }
  .jobstatus[data-color="error"] {
    color: var(--danger);
  }
  .jobdetail {
    margin: 4px 0 0;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .jobdetail.err {
    color: var(--danger);
  }
  .progressbar {
    height: 8px;
    background: var(--accent-soft, var(--border));
    border-radius: 4px;
    overflow: hidden;
    margin: 8px 0 4px;
  }
  .progressbar .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.4s ease;
  }
  .history summary {
    cursor: pointer;
    min-height: 48px;
    display: flex;
    align-items: center;
    color: var(--muted);
    font-size: 0.9rem;
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
