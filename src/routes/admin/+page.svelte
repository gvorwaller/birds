<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { enhance } from "$app/forms";
  import { onMount, untrack } from "svelte";
  import { nextIntervalMs } from "$lib/job-poll-core";
  import { meterDollars } from "$lib/ai-meter";
  import type { AdminLiveStatus } from "$server/admin-status";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let nudgeBusy = $state(false);
  let refreshBusy = $state(false);
  let manualRefreshError = $state<string | null>(null);
  let liveRefreshError = $state<string | null>(null);
  let liveStatus = $state<AdminLiveStatus | null>(null);
  let liveWorker = $derived(liveStatus?.worker ?? data.worker);
  let liveJobs = $derived(liveStatus?.jobs ?? data.jobs);
  let lastRefreshedAt = $derived(liveStatus?.now ?? data.now);
  let liveTimer: ReturnType<typeof setTimeout> | null = null;
  let liveAbort: AbortController | null = null;
  let mounted = false;

  // AI & Cost tab (docs/2026-08-26-admin-ai-tab-ui-AGY.md). Tab choice is
  // purely local UI state — the status poller above never reads it, so
  // switching tabs never pauses live worker polling.
  type Surface = "enrichment" | "guidance";
  let activeTab = $state<"status" | "ai">("status");
  const SURFACES: { key: Surface; title: string; blurb: string }[] = [
    { key: "enrichment", title: "Enrichment", blurb: "worker batch jobs" },
    { key: "guidance", title: "Guidance", blurb: "live trip requests" },
  ];
  let modelModal = $state<{ surface: Surface; model: string } | null>(null);
  let setModelBusy = $state(false);
  let compareSpecies = $state("");
  let selectedCompareModels = $state<string[]>([]);
  let compareBusy = $state(false);

  function modelEntry(id: string) {
    return data.ai.models.find((m) => m.id === id);
  }
  function surfaceTitle(surface: Surface): string {
    return SURFACES.find((s) => s.key === surface)?.title ?? surface;
  }
  function openModelModal(surface: Surface, model: string) {
    if (model === data.ai.current[surface]) return;
    modelModal = { surface, model };
  }

  function stopLiveRefresh() {
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = null;
    liveAbort?.abort();
    liveAbort = null;
  }

  function scheduleLiveRefresh() {
    if (!mounted) return;
    if (liveTimer) clearTimeout(liveTimer);
    const delay = nextIntervalMs(liveJobs);
    liveTimer = delay == null ? null : setTimeout(refreshLiveStatus, delay);
  }

  async function refreshLiveStatus() {
    liveTimer = null;
    const controller = new AbortController();
    liveAbort = controller;
    try {
      const res = await fetch("/api/admin/status", {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(String(res.status));
      const current = (await res.json()) as AdminLiveStatus;
      if (controller.signal.aborted) return;
      liveStatus = current;
      liveRefreshError = null;
    } catch {
      if (!controller.signal.aborted) {
        liveRefreshError =
          "Live status could not refresh; showing the last successful update.";
      }
    } finally {
      if (liveAbort === controller) liveAbort = null;
      if (!controller.signal.aborted) scheduleLiveRefresh();
    }
  }

  async function refreshAll() {
    refreshBusy = true;
    manualRefreshError = null;
    stopLiveRefresh();
    try {
      await invalidateAll();
      // Event rows are fetched separately from page data. Discard them so a
      // later expansion cannot display pre-refresh history.
      openEvents = {};
    } catch {
      manualRefreshError =
        "Refresh failed. The previous Admin snapshot is still shown.";
    } finally {
      refreshBusy = false;
      scheduleLiveRefresh();
    }
  }

  // Form actions and a successful full invalidate replace PageData. Keep the
  // lightweight live view aligned with that authoritative snapshot.
  $effect(() => {
    data.now;
    liveStatus = null;
    if (mounted) untrack(scheduleLiveRefresh);
  });

  onMount(() => {
    mounted = true;
    scheduleLiveRefresh();
    return () => {
      mounted = false;
      stopLiveRefresh();
    };
  });

  // Per-job event log, fetched on expand via the existing API.
  let openEvents = $state<Record<number, { at: string; action: string; details: unknown }[] | "loading" | "error">>({});
  async function toggleEvents(jobId: number) {
    if (openEvents[jobId]) {
      const next = { ...openEvents };
      delete next[jobId];
      openEvents = next;
      return;
    }
    openEvents = { ...openEvents, [jobId]: "loading" };
    try {
      const res = await fetch(`/api/jobs/${jobId}/events`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as {
        events: { at: string; action: string; details: unknown }[];
      };
      openEvents = { ...openEvents, [jobId]: body.events };
    } catch {
      openEvents = { ...openEvents, [jobId]: "error" };
    }
  }

  function ago(iso: string | null): string {
    if (!iso) return "never";
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 90) return `${s} s ago`;
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 129600) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }
  function fmt(iso: string | Date | null): string {
    return iso
      ? new Date(iso).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "—";
  }
  function fmtDuration(ms: number | null): string {
    if (ms == null) return "—";
    if (ms < 1000) return "<1 s";
    const s = Math.round(ms / 1000);
    return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
  }
  function compactJson(v: unknown): string {
    if (v == null) return "";
    const s = JSON.stringify(v);
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  }

  // AI & Cost formatting helpers ----------------------------------------
  /** Dollars dominant, never $0.00 for a real nonzero spend (compare calls
   * run $0.002-$0.01) and never NaN. */
  function fmtDollars(d: number | null): string {
    if (d == null || !Number.isFinite(d)) return "—";
    if (d > 0 && d < 0.01) return `$${d.toPrecision(2)}`;
    return `$${d.toFixed(2)}`;
  }
  function fmtMeterDollars(dollars: number, unpricedAttempts: number): string {
    return fmtDollars(meterDollars(dollars, unpricedAttempts));
  }
  function fmtTok(n: number | null): string {
    if (n == null) return "—";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return `${n}`;
  }
  function fmtRatePair(m: { inPerMTok: number | null; outPerMTok: number | null }): string {
    if (m.inPerMTok == null || m.outPerMTok == null) return "Rate unavailable";
    return `${fmtDollars(m.inPerMTok)} / ${fmtDollars(m.outPerMTok)} per MTok`;
  }
  function costMultiplierText(
    curr: { inPerMTok: number | null } | undefined,
    next: { inPerMTok: number | null } | undefined,
  ): string {
    if (!curr?.inPerMTok || !next?.inPerMTok) return "Cost comparison unavailable for this pair.";
    const ratio = next.inPerMTok / curr.inPerMTok;
    if (!Number.isFinite(ratio) || ratio <= 0) return "Cost comparison unavailable for this pair.";
    if (Math.abs(ratio - 1) < 0.05) return "About the same input cost per token.";
    const magnitude = ratio >= 1 ? ratio : 1 / ratio;
    const shown = magnitude >= 10 ? Math.round(magnitude) : Math.round(magnitude * 10) / 10;
    return ratio > 1 ? `~${shown}× input cost increase.` : `~${shown}× input cost decrease.`;
  }
</script>

<svelte:head>
  <title>Admin · Birds</title>
</svelte:head>

<div class="page">
  <div class="head">
    <h1>Admin</h1>
    <div class="refresh-controls">
      <span class="muted" aria-live="polite">Updated {fmt(lastRefreshedAt)}</span>
      <button
        type="button"
        class="secondary"
        disabled={refreshBusy}
        aria-busy={refreshBusy}
        onclick={refreshAll}
      >
        {refreshBusy ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  </div>
  {#if manualRefreshError}
    <p class="error" role="alert">{manualRefreshError}</p>
  {/if}
  {#if liveRefreshError}
    <p class="error" role="alert">{liveRefreshError}</p>
  {/if}

  <div class="seg" role="tablist" aria-label="Admin section">
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === "status"}
      class:active={activeTab === "status"}
      onclick={() => (activeTab = "status")}
    >
      Status
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === "ai"}
      class:active={activeTab === "ai"}
      onclick={() => (activeTab = "ai")}
    >
      AI &amp; Cost
    </button>
  </div>

  {#if activeTab === "status"}
  <section class="card">
    <h2>Worker</h2>
    {#if data.startupsLastHour > 3}
      <p class="error">
        ⚠ {data.startupsLastHour} worker startups in the last hour — likely a
        crash loop. Check <code>pm2 logs birds-worker</code>.
      </p>
    {/if}
    {#if !liveWorker.alive}
      <p class="error">
        Worker is {liveWorker.heartbeatAt ? "stale" : "not started"} — last
        heartbeat {ago(liveWorker.heartbeatAt)}. Queued loads wait until it
        returns.
      </p>
    {/if}
    <div class="tablewrap">
      <table>
        <tbody>
          <tr><th>State</th><td>
            <span class="badge" data-color={liveWorker.alive ? "ok" : "error"}>
              {liveWorker.alive ? (liveWorker.state ?? "unknown") : "down"}
            </span>
          </td></tr>
          <tr><th>Heartbeat</th><td>{ago(liveWorker.heartbeatAt)}</td></tr>
          <tr><th>Started</th><td>{fmt(liveWorker.startedAt)} ({ago(liveWorker.startedAt)})</td></tr>
          <tr><th>PID / version</th><td>{liveWorker.pid ?? "—"} · {liveWorker.version ?? "—"}</td></tr>
          <tr><th>Current job</th><td>{liveWorker.currentJobId ?? "idle"}</td></tr>
        </tbody>
      </table>
    </div>
    <form
      method="POST"
      action="?/nudge_enrichment"
      class="nudge"
      use:enhance={() => {
        nudgeBusy = true;
        return async ({ update }) => {
          await update();
          nudgeBusy = false;
        };
      }}
    >
      <button type="submit" disabled={nudgeBusy}>
        {nudgeBusy ? "Nudging…" : "⚡ Run enrichment scan now"}
      </button>
      <span class="muted">
        Skips the idle 24h wait — queues newly in-scope species and retries
        failed sample media now.
      </span>
    </form>
    {#if form?.kind === "nudge" && "message" in form && form.message}
      <p class="ok">{form.message}</p>
    {/if}
    {#if form?.kind === "nudge" && "error" in form && form.error}
      <p class="error" role="alert">{form.error}</p>
    {/if}
    <details>
      <summary>Status history ({data.workerHistory.length})</summary>
      <div class="tablewrap">
        <table>
          <thead><tr><th>When</th><th>State</th><th>PID</th><th>Version</th><th>Note</th></tr></thead>
          <tbody>
            {#each data.workerHistory as h (h.id)}
              <tr>
                <td>{fmt(h.at)}</td>
                <td>{h.state}</td>
                <td>{h.pid ?? "—"}</td>
                <td>{h.version ?? "—"}</td>
                <td>{h.note ?? ""}{h.current_job_id ? ` (job ${h.current_job_id})` : ""}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </details>
  </section>

  <section class="card">
    <h2>Jobs ({liveJobs.length})</h2>
    <ul class="jobs">
      {#each liveJobs as j (j.id)}
        {@const ev = openEvents[j.id]}
        <li>
          <div class="jobhead">
            <strong>#{j.id} {j.displayName}</strong>
            <span class="badge" data-color={j.statusColor}>{j.status}</span>
            {#if j.requestedByName}<span class="muted">by {j.requestedByName}</span>{/if}
            <span class="muted">{fmt(j.enqueuedAt)} · {fmtDuration(j.durationMs)}</span>
            <button type="button" class="linkish" onclick={() => toggleEvents(j.id)}>
              {openEvents[j.id] ? "hide events" : "events"}
            </button>
          </div>
          <div class="jobmeta muted">
            attempt {j.attempts}/{j.maxAttempts}
            {#if j.nextRetryAt}· retry at {fmt(j.nextRetryAt)}{/if}
            {#if j.cancelRequested}· cancel requested{/if}
            {#if j.progress && "unitsTotal" in j.progress}
              · {j.progress.unitsDone ?? 0}/{j.progress.unitsTotal} units
              {#if (j.progress.unitsFailed ?? 0) > 0}· {j.progress.unitsFailed} failed{/if}
              {#if (j.progress.unitsSkipped ?? 0) > 0}· {j.progress.unitsSkipped} skipped{/if}
            {/if}
          </div>
          {#if j.error}<p class="error">{j.error}</p>{/if}
          {#if j.result != null}
            <p class="mono muted">{compactJson(j.result)}</p>
          {/if}
          {#if ev === "loading"}
            <p class="muted">Loading events…</p>
          {:else if ev === "error"}
            <p class="error">Could not load events.</p>
          {:else if Array.isArray(ev)}
            <div class="tablewrap">
              <table>
                <thead><tr><th>At</th><th>Action</th><th>Details</th></tr></thead>
                <tbody>
                  {#each ev as e (e.at + e.action)}
                    <tr>
                      <td class="nowrap">{fmt(e.at)}</td>
                      <td>{e.action}</td>
                      <td class="mono">{compactJson(e.details)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </section>

  <section class="card">
    <h2>Recent fetch attempts ({data.attempts.length})</h2>
    <div class="tablewrap">
      <table>
        <thead><tr><th>Location</th><th>Status</th><th>Error</th><th>When</th></tr></thead>
        <tbody>
          {#each data.attempts as a (a.loc_code + a.last_attempt_at)}
            <tr>
              <td>
                <strong>{a.loc_name ?? a.loc_code}</strong>
                <span class="code">{a.loc_code}{a.region_code ? ` · ${a.region_code}` : ""}</span>
              </td>
              <td>
                <span class="badge" data-color={a.status === "ok" ? "ok" : "error"}>{a.status}</span>
              </td>
              <td class="errcell">{a.error ?? ""}</td>
              <td class="nowrap">{fmt(a.last_attempt_at)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="card">
    <h2>Caches</h2>
    <div class="tablewrap">
      <table>
        <thead><tr><th>Namespace</th><th>Entries</th><th>Oldest</th><th>Newest</th></tr></thead>
        <tbody>
          {#each data.cacheStats as c (c.ns)}
            <tr>
              <td>{c.ns}</td>
              <td>{c.n}</td>
              <td>{ago(c.oldest)}</td>
              <td>{ago(c.newest)}</td>
            </tr>
          {/each}
          <tr>
            <td>taxonomy</td>
            <td>{data.taxonomy.n}</td>
            <td colspan="2">refreshed {ago(data.taxonomy.newest)}</td>
          </tr>
          <tr>
            <td>gallery source</td>
            <td colspan="3">
              <span class="badge" data-color={data.gallerySource === "ok" ? "ok" : "error"}>
                {data.gallerySource}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  {:else}
  <section class="card">
    <h2>Usage meter</h2>
    <p class="muted">
      The live status above updates worker state only — Refresh reloads this
      meter.
    </p>
    <div class="stat-grid">
      {#each [
        { key: "today", label: "Today", w: data.ai.usage.windows.today },
        { key: "d7", label: "7 days", w: data.ai.usage.windows.d7 },
        { key: "d30", label: "30 days", w: data.ai.usage.windows.d30 },
        { key: "all", label: "All-time", w: data.ai.usage.windows.all },
      ] as tile (tile.key)}
        <div class="stat-tile">
          <div class="stat-head">
            <span class="stat-label">{tile.label}</span>
            {#if tile.key === "today" && tile.w.dollars > data.ai.highBurnPerDayUsd}
              <span class="badge" data-color="warn">High burn</span>
            {/if}
          </div>
          <div class="stat-dollar">{fmtMeterDollars(tile.w.dollars, tile.w.unpricedAttempts)}</div>
          <div class="stat-sub muted">
            {tile.w.calls} call{tile.w.calls === 1 ? "" : "s"} ·
            {fmtTok(tile.w.inputTokens + tile.w.outputTokens)} tok
            {#if tile.w.unpricedAttempts > 0}· +{tile.w.unpricedAttempts} unpriced{/if}
          </div>
        </div>
      {/each}
    </div>
    {#if data.ai.usage.byModelPurpose.length > 0}
      <h3>Cost by model and purpose</h3>
      <div class="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Served model</th><th>Purpose</th><th>Calls</th><th>Attempts</th><th>Tokens</th><th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {#each data.ai.usage.byModelPurpose as cell ((cell.servedModel ?? "unknown") + ":" + cell.purpose)}
              <tr>
                <td>{cell.servedModel ?? "Unknown"}</td>
                <td>{cell.purpose}</td>
                <td>{cell.calls}</td>
                <td>{cell.attempts}</td>
                <td class="nowrap">{fmtTok(cell.inputTokens)} / {fmtTok(cell.outputTokens)}</td>
                <td class="nowrap">
                  {fmtMeterDollars(cell.dollars, cell.unpricedAttempts)}
                  {#if cell.unpricedAttempts > 0}
                    <span class="badge" data-color="warn">+{cell.unpricedAttempts} unpriced</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <section class="card">
    <h2>Model choice</h2>
    <p class="muted">
      Applies to future calls only — nothing already generated is
      regenerated.
    </p>
    {#if form?.kind === "set_model"}
      {#if "message" in form && form.message}
        <p class="ok">{form.message}</p>
      {/if}
      {#if "error" in form && form.error}
        <p class="error" role="alert">{form.error}</p>
      {/if}
    {/if}
    {#each SURFACES as surface (surface.key)}
      <div class="surface-section">
        <h3>{surface.title} <span class="muted">— {surface.blurb}</span></h3>
        <div class="model-options">
          {#each data.ai.models as m (m.id)}
            {@const isActive = m.id === data.ai.current[surface.key]}
            <button
              type="button"
              class="model-option"
              class:active={isActive}
              aria-pressed={isActive}
              onclick={() => openModelModal(surface.key, m.id)}
            >
              <div class="model-option-head">
                <span class="model-label">{m.label}</span>
                {#if isActive}<span class="badge" data-color="ok">Active</span>{/if}
              </div>
              <div class="model-rate muted">{fmtRatePair(m)}</div>
              <div class="model-desc muted">{m.description}</div>
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </section>

  <section class="card">
    <h2>Compare Lab</h2>
    <p class="muted">
      Task-level apples-to-apples (same prompt, schema, answer budget;
      request params differ per model). Real spend — included in the meter
      above.
    </p>
    <form
      method="POST"
      action="?/run_compare"
      use:enhance={() => {
        compareBusy = true;
        return async ({ update }) => {
          await update();
          compareBusy = false;
        };
      }}
    >
      <label class="field">
        <span>Species code</span>
        <input
          type="text"
          name="species"
          bind:value={compareSpecies}
          placeholder="e.g. dowwoo"
          required
        />
      </label>
      {#if data.ai.quickPick.length > 0}
        <div class="quickpills">
          {#each data.ai.quickPick as q (q.code)}
            <button
              type="button"
              class="pill"
              class:active={compareSpecies === q.code}
              onclick={() => (compareSpecies = q.code)}
            >
              {q.comName}
            </button>
          {/each}
        </div>
      {/if}
      <div class="model-checks">
        {#each data.ai.models as m (m.id)}
          <label class="check">
            <input type="checkbox" name="models" value={m.id} bind:group={selectedCompareModels} />
            {m.label}
          </label>
        {/each}
      </div>
      <button
        type="submit"
        class="btn accent-solid"
        disabled={compareBusy || selectedCompareModels.length === 0}
      >
        {compareBusy
          ? `Benchmarking ${selectedCompareModels.length} model${selectedCompareModels.length === 1 ? "" : "s"} (~45s max)…`
          : "Run comparison"}
      </button>
    </form>

    {#if form?.kind === "compare"}
      {#if "ok" in form && form.ok}
        <h3 class="compare-result-title">Results for {form.speciesName} ({form.species})</h3>
        <div class="compare-grid">
          {#each form.columns as col (col.modelId)}
            <div class="compare-col" class:iserror={!col.ok}>
              <div class="compare-col-head">
                <strong>{col.label}</strong>
                {#if col.fallback}
                  <span class="badge" data-color="warn">Fallback: {col.servedModel}</span>
                {/if}
              </div>
              <div class="compare-metrics">
                <div class="metric-dollar">{fmtDollars(col.dollars)}</div>
                <div class="muted">{(col.durationMs / 1000).toFixed(1)} s</div>
                <div class="muted">
                  {fmtTok(col.inputTokens)} in · {fmtTok(col.outputTokens)} out
                  {#if col.thinkingTokens != null}({fmtTok(col.thinkingTokens)} thinking, incl. in out){/if}
                </div>
              </div>
              {#if col.ok}
                {#if col.fieldCraft}
                  <div class="compare-section">
                    <h4>Field Craft</h4>
                    <p>{col.fieldCraft}</p>
                  </div>
                {/if}
                {#if col.similar.length > 0}
                  <div class="compare-section">
                    <h4>Similar Species</h4>
                    <ul>
                      {#each col.similar as s (s.code)}
                        <li><strong>{s.comName}</strong> — {s.note}</li>
                      {/each}
                    </ul>
                  </div>
                {/if}
              {:else}
                <p class="error">{col.error}</p>
                {#if col.aborted}
                  <p class="abort-caption">Aborted calls may still incur provider cost.</p>
                {/if}
              {/if}
            </div>
          {/each}
        </div>
      {:else if "error" in form && form.error}
        <p class="error" role="alert">{form.error}</p>
      {/if}
    {/if}
  </section>

  <section class="card">
    <h2>Recent calls</h2>
    {#if data.ai.usage.stopReasons.length > 0 || data.ai.usage.errors.length > 0}
      <div class="chipsrow">
        {#each data.ai.usage.stopReasons as sr (sr.key ?? "null")}
          <span class="badge">{sr.key ?? "unknown"}: {sr.n}</span>
        {/each}
        {#each data.ai.usage.errors as er (er.key ?? "null")}
          <span class="badge" data-color="error">{er.key ?? "unknown error"}: {er.n}</span>
        {/each}
      </div>
    {/if}
    {#if data.ai.usage.recent.length === 0}
      <p class="muted">No AI calls recorded yet. Ledger begins on first API call.</p>
    {:else}
      <div class="tablewrap">
        <table>
          <thead>
            <tr>
              <th>When</th><th>Purpose</th><th>Species</th><th>Model</th><th>Tokens</th><th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {#each data.ai.usage.recent as r (r.callId)}
              <tr>
                <td class="nowrap">{fmt(r.at)}</td>
                <td>{r.purpose}</td>
                <td>{r.speciesCode ?? "—"}</td>
                <td>
                  {r.requestedModel}
                  {#if r.servedModel && r.servedModel !== r.requestedModel}
                    → {r.servedModel}
                  {/if}
                </td>
                <td class="nowrap">{fmtTok(r.inputTokens)} / {fmtTok(r.outputTokens)}</td>
                <td class="nowrap">
                  {#if r.dollars == null}
                    <!-- Two distinct null-dollar states (AGY): no tokens =
                         call died before a response (spend unknown); tokens
                         but no price = served model missing from the rate
                         table. Conflating them mislabels rate gaps as aborts. -->
                    {#if r.inputTokens == null}
                      <span>—</span>
                      <span class="badge" data-color="warn">
                        {r.httpStatus == null ? "cost unknown (aborted)" : "cost unknown"}
                      </span>
                    {:else}
                      <span>—</span> <span class="badge" data-color="warn">rate unavailable</span>
                    {/if}
                  {:else if r.billed === false}
                    <!-- "refusal" only when the API said so — any 0-output
                         event row used to get the refusal caption (GROK P2). -->
                    {#if r.stopReason === "refusal"}
                      <span class="badge" data-color="warn">$0.00 (refusal)</span>
                    {:else}
                      <span class="badge" data-color="warn">$0.00 (no output)</span>
                    {/if}
                  {:else}
                    {fmtDollars(r.dollars)}
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
  {/if}
</div>

{#if modelModal}
  {@const curr = modelEntry(data.ai.current[modelModal.surface])}
  {@const next = modelEntry(modelModal.model)}
  <!-- Reuses the house modal pattern (trips/[id]/+page.svelte) rather than a
       second dialog implementation (AGY correction 6). -->
  <div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="model-modal-title">
    <div class="modal">
      <h3 id="model-modal-title">Change {surfaceTitle(modelModal.surface)} model?</h3>
      <div class="diff-box">
        <div class="diff-col">
          <span class="diff-label">Current</span>
          <strong>{curr?.label ?? data.ai.current[modelModal.surface]}</strong>
          <span class="muted">{curr ? fmtRatePair(curr) : "Rate unavailable"}</span>
        </div>
        <span class="diff-arrow">→</span>
        <div class="diff-col">
          <span class="diff-label">New</span>
          <strong>{next?.label ?? modelModal.model}</strong>
          <span class="muted">{next ? fmtRatePair(next) : "Rate unavailable"}</span>
        </div>
      </div>
      <p class="multiplier">{costMultiplierText(curr, next)}</p>
      <p class="scope-note">Applies to future calls only — nothing is regenerated.</p>
      <div class="actions">
        <button type="button" class="btn" onclick={() => (modelModal = null)}>Cancel</button>
        <form
          method="POST"
          action="?/set_ai_model"
          use:enhance={() => {
            setModelBusy = true;
            return async ({ result, update }) => {
              await update();
              setModelBusy = false;
              if (result.type === "success") modelModal = null;
            };
          }}
        >
          <input type="hidden" name="surface" value={modelModal.surface} />
          <input type="hidden" name="model" value={modelModal.model} />
          <button type="submit" class="btn accent-solid" disabled={setModelBusy}>
            {setModelBusy ? "Saving…" : "Confirm"}
          </button>
        </form>
      </div>
    </div>
  </div>
{/if}

<style>
  .page {
    max-width: 960px;
    margin: 0 auto;
    padding: 16px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }
  .refresh-controls {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    flex-wrap: wrap;
  }
  h1 {
    font-size: 1.35rem;
    margin: 0;
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
  .tablewrap {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.88rem;
  }
  th {
    text-align: left;
    color: var(--muted);
    font-weight: 600;
    font-size: 0.8rem;
    padding: 6px 10px 6px 0;
  }
  td {
    padding: 6px 10px 6px 0;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  tr:last-child td {
    border-bottom: none;
  }
  .badge {
    display: inline-block;
    font-size: 0.75rem;
    font-weight: 700;
    border-radius: 6px;
    padding: 2px 8px;
    background: var(--bg);
    color: var(--muted);
  }
  .badge[data-color="ok"],
  .badge[data-color="busy"] {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .badge[data-color="warn"] {
    background: var(--need-bg);
    color: var(--need-text);
  }
  .badge[data-color="error"] {
    background: #fdf0f1;
    color: var(--danger);
  }
  .jobs {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .jobs li {
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }
  .jobs li:last-child {
    border-bottom: none;
  }
  .jobhead {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;
  }
  .jobmeta {
    font-size: 0.82rem;
    margin-top: 2px;
  }
  .nudge {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
    margin: 12px 0 4px;
  }
  .nudge button {
    min-height: 48px;
    padding: 10px 18px;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .nudge button:disabled {
    opacity: 0.5;
  }
  .ok {
    color: var(--seen-text);
    margin: 6px 0;
  }
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .mono {
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    word-break: break-all;
    margin: 4px 0 0;
  }
  .code {
    display: block;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .errcell {
    color: var(--danger);
    font-size: 0.82rem;
    max-width: 320px;
  }
  .nowrap {
    white-space: nowrap;
  }
  .error {
    color: var(--danger);
    font-weight: 600;
    margin: 8px 0;
  }
  .linkish {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 0.85rem;
    padding: 4px 8px;
    min-height: 48px;
  }
  .linkish:hover {
    text-decoration: underline;
  }
  button.secondary {
    min-height: 48px;
    padding: 8px 16px;
    border-radius: 8px;
    background: var(--card);
    color: var(--accent);
    border: 1px solid var(--accent);
    cursor: pointer;
  }
  button.secondary:disabled {
    cursor: wait;
    opacity: 0.65;
  }
  details summary {
    cursor: pointer;
    min-height: 48px;
    display: flex;
    align-items: center;
    color: var(--muted);
  }

  /* Tab bar (house .seg pattern, life/+page.svelte) */
  .seg {
    display: flex;
    gap: 0;
    margin-bottom: 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    width: fit-content;
  }
  .seg button {
    border: 0;
    background: var(--card);
    padding: 0.4rem 1.1rem;
    font-size: 0.95rem;
    cursor: pointer;
    min-height: 48px;
    color: var(--text);
  }
  .seg button.active {
    background: var(--accent);
    color: #fff;
  }

  /* Usage meter */
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin-top: 10px;
  }
  .stat-tile {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
  }
  .stat-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
  }
  .stat-label {
    font-size: 0.82rem;
    color: var(--muted);
    font-weight: 600;
  }
  .stat-dollar {
    font-size: 1.6rem;
    font-weight: 700;
    margin: 4px 0 2px;
  }
  .stat-sub {
    font-size: 0.78rem;
  }

  /* Model choice */
  .surface-section {
    margin-top: 14px;
  }
  .surface-section h3 {
    font-size: 0.95rem;
    margin-bottom: 8px;
  }
  .model-options {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .model-option {
    text-align: left;
    min-height: 48px;
    border: 1px solid var(--border);
    background: var(--card);
    border-radius: 8px;
    padding: 10px 14px;
    cursor: pointer;
    color: var(--text);
  }
  .model-option.active {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .model-option-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .model-label {
    font-weight: 700;
  }
  .model-rate {
    font-size: 0.82rem;
    margin-top: 2px;
  }
  .model-desc {
    font-size: 0.82rem;
    margin-top: 2px;
  }

  /* Confirmation modal (house pattern, trips/[id]/+page.svelte) */
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
  .modal {
    background: var(--card);
    border-radius: 8px;
    padding: 24px;
    max-width: 460px;
    width: 100%;
  }
  .modal h3 {
    margin-bottom: 12px;
  }
  .diff-box {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  .diff-col {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .diff-label {
    font-size: 0.75rem;
    color: var(--muted);
    text-transform: uppercase;
    font-weight: 700;
  }
  .diff-arrow {
    font-size: 1.2rem;
    color: var(--muted);
  }
  .multiplier {
    font-weight: 600;
    margin-bottom: 8px;
  }
  .scope-note {
    color: var(--muted);
    font-size: 0.85rem;
    margin-bottom: 20px;
  }
  .modal .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .btn {
    min-height: 48px;
    padding: 10px 20px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--text);
    font-weight: 600;
  }
  .btn.accent-solid {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .btn:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  /* Compare Lab */
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
    font-size: 0.85rem;
    font-weight: 600;
  }
  .field input {
    min-height: 48px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-weight: 400;
  }
  .quickpills {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 10px;
  }
  .pill {
    border: 1px solid var(--border);
    background: var(--card);
    border-radius: 999px;
    padding: 0.25rem 0.9rem;
    font-size: 0.85rem;
    cursor: pointer;
    min-height: 48px;
  }
  .pill.active {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .model-checks {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 12px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 48px;
    font-size: 0.88rem;
  }

  .compare-result-title {
    margin: 16px 0 8px;
    font-size: 0.95rem;
  }
  .compare-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
  }
  .compare-col {
    border: 1px solid var(--border);
    background: var(--bg);
    border-radius: 8px;
    padding: 12px;
  }
  .compare-col.iserror {
    /* AGY correction 1: border-only signal on --bg, no hardcoded tint. */
    border-color: var(--danger);
  }
  .compare-col-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }
  .compare-metrics {
    margin-bottom: 8px;
  }
  .metric-dollar {
    font-size: 1.25rem;
    font-weight: 700;
  }
  .compare-section {
    margin-top: 8px;
    font-size: 0.85rem;
  }
  .compare-section h4 {
    font-size: 0.8rem;
    color: var(--muted);
    margin-bottom: 4px;
  }
  .compare-section ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .compare-section li {
    padding: 2px 0;
  }
  .abort-caption {
    /* AGY correction 5: always a visible caption, never hover-only. */
    color: var(--danger);
    font-size: 0.8rem;
    margin-top: 4px;
  }

  /* Recent calls */
  .chipsrow {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
  }

  @media (min-width: 640px) {
    .stat-grid {
      grid-template-columns: repeat(4, 1fr);
    }
    .compare-grid {
      /* AGY correction 4: 2 cols at 640, not repeat(var(--cols)) from 640. */
      grid-template-columns: repeat(2, 1fr);
    }
  }
  @media (min-width: 1024px) {
    .compare-grid {
      grid-template-columns: repeat(4, 1fr);
    }
  }
</style>
