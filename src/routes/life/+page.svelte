<script lang="ts">
  import ObsMap, { type ObsPoint } from "$components/ObsMap.svelte";
  import Badge from "$components/Badge.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  // AGY advisory: segmented Map|Timeline on mobile (Timeline default),
  // side-by-side on desktop (CSS shows both ≥64rem regardless of the tab).
  let view = $state<"timeline" | "map">("timeline");
  let regionFilter = $state<string | null>(null);

  const total = $derived(data.lifers.length);

  // Lifer # = total − csv_row_num + 1 against the FULL imported set,
  // recomputed at render (GROK pin 4 — never stored). Rows without a
  // csv_row_num (manual / pre-migration) get no number.
  const numbered = $derived(
    data.lifers.map((l) => ({
      ...l,
      liferNum: l.csv_row_num != null ? total - l.csv_row_num + 1 : null,
    })),
  );

  const filtered = $derived(
    regionFilter == null ? numbered : numbered.filter((l) => l.region_code === regionFilter),
  );

  // State chips sorted by lifer count desc (AGY advisory).
  const regionChips = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const l of numbered) {
      if (l.region_code) counts.set(l.region_code, (counts.get(l.region_code) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  });
  const regionLabel = (code: string) => (code.startsWith("US-") ? code.slice(3) : code);

  // Timeline grouped by year, newest first; sticky per-year count headers.
  const years = $derived.by(() => {
    const map = new Map<string, typeof filtered>();
    for (const l of filtered) {
      const y = l.first_seen ? l.first_seen.slice(0, 4) : "Undated";
      if (!map.has(y)) map.set(y, []);
      map.get(y)!.push(l);
    }
    return [...map.entries()].sort((a, b) =>
      a[0] === "Undated" ? 1 : b[0] === "Undated" ? -1 : b[0].localeCompare(a[0]),
    );
  });

  function escapeHtml(s: string): string {
    return s.replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
    );
  }

  function fmtDate(iso: string | null): string {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  // Map points: one marker per distinct location, pin glyph = lifer count
  // there, info window = scrollable lifer list (GROK pin 5 — the multi-item
  // content path, not ObsMap's single title/href composition).
  const points = $derived.by((): ObsPoint[] => {
    const byLoc = new Map<string, { name: string; lat: number; lng: number; lifers: typeof filtered }>();
    for (const l of filtered) {
      if (!l.loc_id || l.lat == null || l.lng == null) continue;
      let g = byLoc.get(l.loc_id);
      if (!g) {
        g = { name: l.location_name ?? l.loc_id, lat: l.lat, lng: l.lng, lifers: [] };
        byLoc.set(l.loc_id, g);
      }
      g.lifers.push(l);
    }
    return [...byLoc.values()].map((g) => ({
      lat: g.lat,
      lng: g.lng,
      title: g.name,
      kind: "need",
      glyph: String(g.lifers.length),
      html:
        `<b>${escapeHtml(g.name)}</b>` +
        `<ul style="margin:6px 0 0;padding-left:18px">` +
        g.lifers
          .map(
            (l) =>
              `<li style="margin-bottom:4px">` +
              `<a href="/species/${encodeURIComponent(l.species_code)}?returnTo=${encodeURIComponent("/life")}" style="color:#084298;font-weight:600">${escapeHtml(l.com_name)}</a>` +
              ` <span style="color:#555">${escapeHtml(fmtDate(l.first_seen))}</span>` +
              (l.sub_id
                ? ` · <a href="https://ebird.org/checklist/${encodeURIComponent(l.sub_id)}" target="_blank" rel="noopener" style="color:#0a5c43">checklist ↗</a>`
                : "") +
              `</li>`,
          )
          .join("") +
        `</ul>`,
    }));
  });

  const pending = $derived(data.pendingUnattempted);
  const negatives = $derived(data.negatives);
  const noLocRows = $derived(data.noLoc);
  const locStatus = $derived(data.locResolutionStatus);
  const locError = $derived(data.locResolutionError);

  const syncedOn = $derived(
    data.syncedAt ? new Date(data.syncedAt).toLocaleDateString() : null,
  );
  // Stale = last synced more than 8 days ago (the sync is meant to recur);
  // shown to the OWNER with a Settings pointer (GROK pin 5 — stale half).
  const syncStale = $derived(
    data.syncedAt != null &&
      Date.now() - new Date(data.syncedAt).getTime() > 8 * 86_400_000,
  );
</script>

<svelte:head>
  <title>Life list — birds</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <h1>Life list</h1>
    <p class="sub">
      {total} lifer{total === 1 ? "" : "s"}{#if syncedOn}&nbsp;· synced {syncedOn}{/if}
      · <a href="https://ebird.org" target="_blank" rel="noopener">Data from eBird.org ↗</a>
    </p>
  </header>

  {#if !data.isViewer && data.syncStatus === "error"}
    <p class="syncnote">
      ⚠ The last life-list sync failed{data.syncError ? ` — ${data.syncError}` : ""} ·
      showing the last synced list. <a href="/settings">Settings</a>
    </p>
  {:else if !data.isViewer && syncStale}
    <p class="syncnote">
      ⚠ Life list last synced {syncedOn} — re-sync from
      <a href="/settings">Settings</a> to pick up new lifers.
    </p>
  {/if}

  {#if total === 0}
    <section class="card">
      {#if data.isViewer}
        <p class="muted">This page needs the account owner's life list.</p>
      {:else}
        <p class="muted">
          Sync your life list to plot where you got each lifer — set up the
          eBird account sync (or upload a CSV) in
          <a href="/settings">Settings</a>.
        </p>
      {/if}
    </section>
  {:else}
    {#if regionChips.length > 0}
      <div class="chips" role="group" aria-label="Filter by state or region">
        <button
          type="button"
          class="chip"
          class:active={regionFilter == null}
          onclick={() => (regionFilter = null)}
        >
          All ({total})
        </button>
        {#each regionChips as [code, n] (code)}
          <button
            type="button"
            class="chip"
            class:active={regionFilter === code}
            onclick={() => (regionFilter = regionFilter === code ? null : code)}
          >
            {regionLabel(code)} ({n})
          </button>
        {/each}
      </div>
    {/if}

    <div class="seg" role="tablist" aria-label="View">
      <button
        type="button"
        role="tab"
        aria-selected={view === "timeline"}
        class:active={view === "timeline"}
        onclick={() => (view = "timeline")}
      >
        Timeline
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "map"}
        class:active={view === "map"}
        onclick={() => (view = "map")}
      >
        Map
      </button>
    </div>

    <div class="split">
      <section class="card mapcard" class:hidden-mobile={view !== "map"}>
        {#if points.length > 0}
          <ObsMap {points} />
        {:else}
          <p class="muted">No mappable locations{regionFilter ? " for this filter" : ""} yet.</p>
        {/if}
        {#if pending > 0 || negatives > 0 || noLocRows > 0}
          <div class="muted disclose">
            {#if pending > 0 && !data.hasCreds}
              <p>{pending} location{pending === 1 ? " needs" : "s need"} an eBird sign-in sync to plot.</p>
            {:else if pending > 0 && (locStatus === 'capped' || locStatus === 'stopped')}
              <p>{pending} location{pending === 1 ? "" : "s"} still resolving — sync again to plot more pins.</p>
            {:else if pending > 0 && locStatus === 'error'}
              <p>{pending} location{pending === 1 ? "" : "s"} could not be resolved{locError ? ` — ${locError}` : ""}. Check <a href="/settings">Settings</a>.</p>
            {:else if pending > 0}
              <p>{pending} location{pending === 1 ? "" : "s"} still resolving — sync again to plot more pins.</p>
            {/if}
            {#if negatives > 0}
              <p>{negatives} location{negatives === 1 ? " has" : "s have"} no map pin.</p>
            {/if}
            {#if noLocRows > 0}
              <p>{noLocRows} lifer{noLocRows === 1 ? "" : "s"} predate location tracking — the next sync fills them in.</p>
            {/if}
          </div>
        {/if}
      </section>

      <section class="card timeline" class:hidden-mobile={view !== "timeline"}>
        {#each years as [year, rows] (year)}
          <div class="yearhead">
            <span class="year">{year}</span>
            <span class="muted">{rows.length} lifer{rows.length === 1 ? "" : "s"}</span>
          </div>
          <ul class="lifers">
            {#each rows as l (l.species_code)}
              <li class:milestone={l.liferNum != null && l.liferNum % 100 === 0}>
                <span class="num">
                  {#if l.liferNum != null}#{l.liferNum}{/if}
                  {#if l.liferNum != null && l.liferNum % 100 === 0}⭐{/if}
                </span>
                <span class="what">
                  <a href={`/species/${l.species_code}?returnTo=${encodeURIComponent("/life")}`}>
                    {l.com_name}
                  </a>
                  {#if l.exotic}<Badge kind="notable" label="Exotic" />{/if}
                  {#if l.countable === false}<span class="muted small">not countable</span>{/if}
                  <span class="where muted">
                    {#if l.location_name}{l.location_name}{/if}
                    {#if l.region_code}&nbsp;· {regionLabel(l.region_code)}{/if}
                    {#if l.sub_id}
                      · <a
                        href={`https://ebird.org/checklist/${l.sub_id}`}
                        target="_blank"
                        rel="noopener">checklist ↗</a
                      >
                    {/if}
                  </span>
                </span>
                <span class="date muted">{fmtDate(l.first_seen)}</span>
              </li>
            {/each}
          </ul>
        {/each}
      </section>
    </div>
  {/if}
</div>

<style>
  .page {
    max-width: 72rem;
    margin: 0 auto;
    padding: 0.75rem;
  }
  .page-head h1 {
    margin: 0.25rem 0 0.1rem;
  }
  .sub {
    color: var(--muted, #555);
    margin: 0 0 0.6rem;
  }
  .muted {
    color: var(--muted, #555);
  }
  .small {
    font-size: 0.85em;
  }
  .card {
    background: var(--card-bg, #fff);
    border: 1px solid var(--border, #ddd);
    border-radius: 10px;
    padding: 0.75rem;
    margin-bottom: 0.75rem;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.6rem;
  }
  .chip {
    border: 1px solid var(--border, #ccc);
    background: var(--card-bg, #fff);
    border-radius: 999px;
    padding: 0.25rem 0.7rem;
    font-size: 0.9rem;
    cursor: pointer;
    min-height: 48px; /* AAA tap target (nearest precedent) */
  }
  .chip.active {
    background: #0a5c43;
    border-color: #07472f;
    color: #fff;
  }
  .seg {
    display: flex;
    gap: 0;
    margin-bottom: 0.6rem;
    border: 1px solid var(--border, #ccc);
    border-radius: 8px;
    overflow: hidden;
    width: fit-content;
  }
  .seg button {
    border: 0;
    background: var(--card-bg, #fff);
    padding: 0.4rem 1.1rem;
    font-size: 0.95rem;
    cursor: pointer;
    min-height: 48px; /* AAA tap target */
  }
  .seg button.active {
    background: #084298;
    color: #fff;
  }
  .yearhead {
    position: sticky;
    top: 0;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    background: var(--card-bg, #fff);
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--border, #eee);
    z-index: 1;
  }
  .year {
    font-weight: 700;
    font-size: 1.05rem;
  }
  .lifers {
    list-style: none;
    margin: 0 0 0.8rem;
    padding: 0;
  }
  .lifers li {
    display: grid;
    grid-template-columns: 3.2rem 1fr auto;
    gap: 0.5rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--border, #f0f0f0);
    align-items: baseline;
  }
  .lifers li.milestone {
    background: #fffbe8;
    border-radius: 6px;
    padding-left: 0.3rem;
  }
  .num {
    font-variant-numeric: tabular-nums;
    color: #555; /* 7.5:1 on white — AAA (GROK P2: #777 fails) */
    font-size: 0.9rem;
  }
  .what a {
    font-weight: 600;
  }
  .where {
    display: block;
    font-size: 0.85rem;
  }
  .date {
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .disclose {
    margin: 0.5rem 0 0;
    font-size: 0.9rem;
  }
  .syncnote {
    background: #fff3cd;
    border: 1px solid #ffe69c;
    border-radius: 8px;
    padding: 0.5rem 0.7rem;
    margin: 0 0 0.6rem;
    color: #664d03;
  }
  .mapcard :global(.map) {
    min-height: 320px;
  }
  /* Mobile: segmented control switches panels. Desktop: both visible. */
  @media (max-width: 63.99rem) {
    .hidden-mobile {
      display: none;
    }
  }
  @media (min-width: 64rem) {
    .seg {
      display: none;
    }
    .split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
      align-items: start;
    }
    .timeline {
      max-height: 78vh;
      overflow-y: auto;
    }
  }
</style>
