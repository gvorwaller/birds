<script lang="ts">
  import Badge from "$lib/components/Badge.svelte";
  import { page } from "$app/stores";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  /** External click URLs (eBird checklists) open a new tab — a same-tab
   * title tap must never eject the app (GROK). In-app URLs stay same-tab. */
  function isExternal(url: string): boolean {
    try {
      return new URL(url, $page.url.origin).origin !== $page.url.origin;
    } catch {
      return false;
    }
  }

  // Compact relative time for list rows; absolute date once it's old enough
  // that "days ago" stops being useful.
  function when(iso: string): string {
    const t = new Date(iso).getTime();
    const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  // Group by calendar day so a busy stretch reads as a timeline.
  const groups = $derived.by(() => {
    const out: { day: string; rows: typeof data.history }[] = [];
    for (const row of data.history) {
      const day = new Date(row.sent_at).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(row);
      else out.push({ day, rows: [row] });
    }
    return out;
  });
</script>

<svelte:head>
  <title>Alerts — birds</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <h1>
      Alerts
      {#if data.alerts.enabled}<Badge kind="seen" label="on" />{:else}<Badge
          kind="need"
          label="off"
        />{/if}
    </h1>
    <p class="sub">
      Every need alert this app has pushed to your devices, exactly as sent.
    </p>
  </header>

  <section class="card status">
    <p class="muted">
      {#if data.alerts.enabled}
        Watching within <strong>{data.alerts.radius_km} km</strong> of home ·
        re-alerts the same species after {data.alerts.realert_days} days ·
        {data.pushDeviceCount} device{data.pushDeviceCount === 1 ? "" : "s"}
        enrolled.
      {:else}
        Need alerts are off — nothing new will appear here.
      {/if}
      {#if data.lastScanAt}
        Last scan {when(data.lastScanAt)}.
      {/if}
    </p>
    <a class="settings-link" href="/settings">Alert settings →</a>
  </section>

  {#if data.history.length === 0}
    <section class="card">
      <p class="muted">
        No alerts yet. When a rare bird you still need is reported near home,
        it lands here as well as on your enrolled devices.
        {#if !data.alerts.enabled}
          Turn alerts on in <a href="/settings">Settings</a> to start watching.
        {/if}
      </p>
    </section>
  {:else}
    {#each groups as group (group.day)}
      <h2 class="day">{group.day}</h2>
      <section class="card list">
        {#each group.rows as row (row.id)}
          <div class="row">
            <span class="row-main">
              <a
                class="title"
                href={row.url}
                target={isExternal(row.url) ? "_blank" : undefined}
                rel={isExternal(row.url) ? "noopener" : undefined}
              >{row.title}</a>
              <span class="body muted">{row.body}</span>
              {#if row.reports.length > 0}
                <span class="reports">
                  {#each row.reports as r, i (i)}
                    {#if r.subId}
                      <a
                        class="report-link"
                        href={`https://ebird.org/checklist/${encodeURIComponent(r.subId)}`}
                        target="_blank"
                        rel="noopener"
                      >
                        {r.locName} · {r.distanceMi} mi ↗
                      </a>
                    {:else}
                      <span class="report-link muted">{r.locName} · {r.distanceMi} mi</span>
                    {/if}
                  {/each}
                </span>
              {/if}
            </span>
            <span class="time muted">{when(row.sent_at)}</span>
          </div>
        {/each}
      </section>
    {/each}
    {#if data.history.length === 200}
      <p class="muted trunc">Showing the most recent 200 alerts.</p>
    {/if}
  {/if}

  <p class="attribution">
    Data from
    <a href="https://ebird.org" target="_blank" rel="noopener">eBird.org</a>
  </p>
</div>

<style>
  .page {
    max-width: 720px;
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
  .status {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .status p {
    margin: 0;
    flex: 1;
    min-width: 220px;
  }
  .settings-link {
    color: var(--accent);
    font-weight: 600;
    white-space: nowrap;
    min-height: 48px;
    display: inline-flex;
    align-items: center;
  }
  .day {
    font-size: 0.82rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin: 16px 4px 6px;
  }
  .list {
    padding: 4px 0;
  }
  .row {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
    padding: 4px 16px;
    min-height: 48px;
    color: inherit;
    text-decoration: none;
  }
  .time {
    padding-top: 14px;
  }
  a.title {
    color: inherit;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    min-height: 48px; /* cs.md tap-target floor (CODEX1) */
  }
  .reports {
    display: flex;
    gap: 0 18px;
    flex-wrap: wrap;
  }
  .report-link {
    display: inline-flex;
    align-items: center;
    min-height: 48px; /* cs.md tap-target floor (CODEX1); 18px column gap
                         keeps adjacent targets distinct when wrapped */
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--accent);
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  /* No-subId reports are TEXT, not links — must not look tappable (GROK:
     the earlier .muted lost the same-specificity battle to the rule above). */
  span.report-link.muted {
    color: var(--muted);
    font-weight: 400;
  }
  .row + .row {
    border-top: 1px solid var(--border);
  }
  /* Hover-capable pointers only — iOS tap-hover must not stick (GROK). */
  @media (hover: hover) {
    .row:hover a.title,
    .report-link:hover {
      text-decoration: underline;
    }
  }
  .row-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .title {
    font-weight: 600;
  }
  .body {
    overflow-wrap: anywhere;
  }
  .time {
    white-space: nowrap;
  }
  .trunc {
    text-align: center;
    margin: 4px 0 16px;
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
</style>
