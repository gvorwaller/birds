<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

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
  function fmt(iso: string | null): string {
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
</script>

<svelte:head>
  <title>Admin · Birds</title>
</svelte:head>

<div class="page">
  <div class="head">
    <h1>Admin</h1>
    <button type="button" class="secondary" onclick={() => invalidateAll()}>
      Refresh
    </button>
  </div>

  <section class="card">
    <h2>Worker</h2>
    {#if data.startupsLastHour > 3}
      <p class="error">
        ⚠ {data.startupsLastHour} worker startups in the last hour — likely a
        crash loop. Check <code>pm2 logs birds-worker</code>.
      </p>
    {/if}
    {#if !data.worker.alive}
      <p class="error">
        Worker is {data.worker.heartbeatAt ? "stale" : "not started"} — last
        heartbeat {ago(data.worker.heartbeatAt)}. Queued loads wait until it
        returns.
      </p>
    {/if}
    <div class="tablewrap">
      <table>
        <tbody>
          <tr><th>State</th><td>
            <span class="badge" data-color={data.worker.alive ? "ok" : "error"}>
              {data.worker.alive ? (data.worker.state ?? "unknown") : "down"}
            </span>
          </td></tr>
          <tr><th>Heartbeat</th><td>{ago(data.worker.heartbeatAt)}</td></tr>
          <tr><th>Started</th><td>{fmt(data.worker.startedAt)} ({ago(data.worker.startedAt)})</td></tr>
          <tr><th>PID / version</th><td>{data.worker.pid ?? "—"} · {data.worker.version ?? "—"}</td></tr>
          <tr><th>Current job</th><td>{data.worker.currentJobId ?? "idle"}</td></tr>
        </tbody>
      </table>
    </div>
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
    <h2>Jobs ({data.jobs.length})</h2>
    <ul class="jobs">
      {#each data.jobs as j (j.id)}
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
</div>

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
    min-height: 44px;
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
  details summary {
    cursor: pointer;
    min-height: 48px;
    display: flex;
    align-items: center;
    color: var(--muted);
  }
</style>
