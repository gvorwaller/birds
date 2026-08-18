<script lang="ts">
  import Badge from "$components/Badge.svelte";
  import DistanceUnitToggle from "$components/DistanceUnitToggle.svelte";
  import { enhance } from "$app/forms";
  import { jobsPoll } from "$lib/job-poll.svelte";
  import { formatDistance, type DistanceUnit } from "$lib/geo";
  import type { ActionData, PageData } from "./$types";

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let distanceUnit = $state<DistanceUnit>("mi");
  let loadBusy = $state(false);
  // Monthly list default view is capped for scanability; expansion exposes
  // EVERY row — never a hidden reduction (cs.md, CODEX1 on 84a1c4b).
  let showAllMonthly = $state(false);
  const MONTHLY_PREVIEW = 60;

  // In-place progress = the SAME jobsPoll store as the app-wide chip
  // (GROK pin: one progress channel, survives refresh).
  const myJob = $derived(
    jobsPoll.active.find((j) => (j.locCodes ?? []).includes(data.locId)) ?? null,
  );
  $effect(() => {
    const q = form && "queued" in form && form.queued ? form.queued : null;
    if (q) jobsPoll.track(q.jobId);
  });

  function tabHref(tab: "recent" | "monthly", extra: Record<string, string> = {}): string {
    const p = new URLSearchParams();
    if (tab === "monthly") p.set("tab", "monthly");
    if (tab === "recent" && extra.back) p.set("back", extra.back);
    if (tab === "monthly") p.set("month", extra.month ?? String(data.month));
    if (data.returnLink.href !== "/") p.set("returnTo", data.returnLink.href);
    const s = p.toString();
    return `/hotspots/${data.locId}${s ? `?${s}` : ""}`;
  }

  const mapsHref = $derived(
    data.googlePlaceId
      ? `https://www.google.com/maps/search/?api=1&query=${data.lat ?? ""},${data.lng ?? ""}&query_place_id=${data.googlePlaceId}`
      : data.lat != null && data.lng != null
        ? `https://www.google.com/maps/search/?api=1&query=${data.lat},${data.lng}`
        : null,
  );
  const directionsHref = $derived(
    data.lat != null && data.lng != null
      ? `https://www.google.com/maps/dir/?api=1&destination=${data.lat},${data.lng}${data.googlePlaceId ? `&destination_place_id=${data.googlePlaceId}` : ""}`
      : null,
  );
  const forecastHref = $derived(
    data.lat != null && data.lng != null
      ? `/forecast?lat=${data.lat.toFixed(5)}&lng=${data.lng.toFixed(5)}&label=${encodeURIComponent(data.locName ?? data.locId)}`
      : "/forecast",
  );
  // Existing planner contract: place + lat + lng (GROK veto on locId param).
  const tripHref = $derived(
    data.lat != null && data.lng != null && data.locName
      ? `/trips/plan?place=${encodeURIComponent(data.locName)}&lat=${data.lat.toFixed(5)}&lng=${data.lng.toFixed(5)}`
      : null,
  );

  function dayLabel(date: string): string {
    const d = new Date(`${date}T12:00:00`);
    return isNaN(d.getTime())
      ? date
      : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }
  function pct(freq: number): string {
    if (freq === 0) return "0%";
    if (freq < 0.01) return "<1%";
    return `${Math.round(freq * 100)}%`;
  }
</script>

<svelte:head>
  <title>{data.locName ?? data.locId} — birds</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <p class="sub"><a href={data.returnLink.href}>← {data.returnLink.label}</a></p>
    <h1>
      {data.locName ?? data.locId}
      {#if data.isHotspot}<Badge kind="notable" label="eBird hotspot" />{/if}
    </h1>
    <p class="sub">
      {#if data.countyName}{data.countyName}{#if data.stateName},
          {data.stateName}{/if}{:else if data.stateName}{data.stateName}{/if}
      {#if data.distanceKm != null}
        · {formatDistance(data.distanceKm, distanceUnit)}
        <DistanceUnitToggle bind:unit={distanceUnit} /> from home
      {/if}
      {#if data.numSpeciesAllTime != null}· {data.numSpeciesAllTime} species all-time{/if}
    </p>
    {#if data.venueTypes.length > 0}
      <p class="venues">
        {#each data.venueTypes as v (v)}<span class="venue">{v}</span>{/each}
      </p>
    {/if}
  </header>

  {#if !data.known}
    <section class="card">
      <p class="muted">
        This location isn't in our hotspot cache yet — it appears once a
        forecast search or load touches its area. You can still view it on
        <a
          href={`https://ebird.org/hotspot/${data.locId}`}
          target="_blank"
          rel="noopener">eBird ↗</a
        >.
      </p>
    </section>
  {:else}
    <section class="card actions">
      {#if mapsHref}<a class="act" href={mapsHref} target="_blank" rel="noopener">🗺 Maps</a>{/if}
      {#if directionsHref}<a class="act" href={directionsHref} target="_blank" rel="noopener">🚗 Directions</a>{/if}
      <a class="act" href={forecastHref}>📅 Forecast my needs here</a>
      {#if tripHref}<a class="act" href={tripHref}>🧭 Add to trip</a>{/if}
      <a class="act" href={`https://ebird.org/hotspot/${data.locId}`} target="_blank" rel="noopener">eBird ↗</a>
    </section>

    <section class="card">
      <h2>Historical data</h2>
      {#if form && "error" in form && form.error}<p class="err" role="alert">{form.error}</p>{/if}
      {#if form && "queued" in form && form.queued}
        <p class="ok">
          {form.queued.deduped ? "Already queued" : "Queued"} — progress shows below.
        </p>
      {/if}
      {#if myJob}
        <p class="progress">
          {myJob.status === "running" && (myJob.progress.unitsTotal ?? 0) > 0
            ? `Loading ${myJob.progress.unitsDone ?? 0} of ${myJob.progress.unitsTotal}…`
            : myJob.progress.phase === "waiting_retry"
              ? "Load retrying soon…"
              : "Load queued…"}
          <a href="/forecast/data">details</a>
        </p>
      {:else if data.freq}
        <p>
          Loaded {data.freq.beginYear}–{data.freq.endYear} ·
          {data.freq.nSpecies} species ·
          {data.freq.totalChecklists.toLocaleString()} checklists ·
          {#if data.freq.current}<Badge kind="seen" label="current" />{:else}<Badge
              kind="stale"
              label="outdated"
            />{/if}
        </p>
      {:else}
        <p class="muted">
          No historical data loaded for this hotspot yet — load it to unlock
          the Monthly view.
        </p>
      {/if}
      {#if !data.isViewer && !myJob}
        <form
          method="POST"
          action="?/load_hotspot"
          use:enhance={() => {
            loadBusy = true;
            return async ({ update }) => {
              await update();
              loadBusy = false;
            };
          }}
        >
          {#if data.freq}<input type="hidden" name="force" value="1" />{/if}
          <button type="submit" disabled={loadBusy}>
            {loadBusy
              ? "Queuing…"
              : data.freq
                ? "↻ Refresh historical data"
                : "⬇ Load historical data"}
          </button>
          <span class="muted">
            Fetches ~10 years of eBird checklist frequencies in the background.
          </span>
        </form>
      {/if}
    </section>

    <nav class="tabs" aria-label="Hotspot data">
      <a href={tabHref("recent")} class:active={data.tab === "recent"}>Recent</a>
      <a href={tabHref("monthly")} class:active={data.tab === "monthly"}>Monthly</a>
    </nav>

    {#if data.tab === "recent"}
      <section class="card">
        <div class="card-head">
          <h2>Recent reports</h2>
          <span class="backs">
            {#each [7, 14, 30] as b (b)}
              <a
                class="backopt"
                class:on={data.back === b}
                href={tabHref("recent", { back: String(b) })}>{b}d</a
              >
            {/each}
          </span>
        </div>
        {#if data.recentStale}
          <p class="muted">⚠ Showing cached reports — eBird was unreachable.</p>
        {/if}
        {#if !data.hasApiKey}
          <p class="muted">
            An eBird API key is required for live reports — add one in
            <a href="/settings">Settings</a>.
          </p>
        {:else if data.recentError}
          <p class="err">{data.recentError}</p>
        {:else if data.days.length === 0}
          <p class="muted">
            No reports in the last {data.back} days —
            {#if data.back < 30}<a href={tabHref("recent", { back: "30" })}
                >widen to 30 days</a
              >{:else}try the Monthly view for what's typical here{/if}.
          </p>
        {:else}
          <p class="muted">
            The most recent report of each species — one row per species
            (eBird's recent feed shows latest sightings, not every
            checklist). The link opens the checklist it came from.
          </p>
          {#each data.days as day (day.date)}
            <h3 class="day">{dayLabel(day.date)}</h3>
            <ul class="obs">
              {#each day.reports as sp (sp.speciesCode)}
                <li>
                  <a href={`/species/${sp.speciesCode}?returnTo=${encodeURIComponent(`/hotspots/${data.locId}`)}`}
                    >{sp.comName}</a
                  >
                  {#if sp.howMany != null && sp.howMany > 1}<span class="muted"
                      >×{sp.howMany}</span
                    >{/if}
                  {#if sp.time}<span class="muted">{sp.time}</span>{/if}
                  {#if sp.need}<Badge kind="need" label="Need" />{:else}<Badge
                      kind="seen"
                      label="Seen"
                    />{/if}
                  {#if sp.unconfirmed}<span class="unconf">Unconfirmed</span>{/if}
                  {#if sp.subId}
                    <a
                      class="cl"
                      href={`https://ebird.org/checklist/${sp.subId}`}
                      target="_blank"
                      rel="noopener">checklist ↗</a
                    >
                  {/if}
                </li>
              {/each}
            </ul>
          {/each}
        {/if}
      </section>
    {:else}
      <section class="card">
        <h2>Monthly likelihood</h2>
        {#if !data.freq}
          <p class="muted">
            Load historical data above to see month-by-month likelihood for
            this hotspot.
          </p>
        {:else if data.monthly}
          <div class="months">
            {#each MONTHS as name, i (name)}
              {@const m = i + 1}
              {@const r = data.monthly.year[i]}
              <a
                class="month"
                class:on={m === data.month}
                href={tabHref("monthly", { month: String(m) })}
              >
                <span class="mname">{name}</span>
                <span class="mcount">{r ? r.likely + r.possible : 0}</span>
              </a>
            {/each}
          </div>
          <p class="muted">
            Needs likely+possible per month · based on
            {data.freq.totalChecklists.toLocaleString()} checklists
            {data.freq.beginYear}–{data.freq.endYear}.
          </p>
          {#if data.monthly.species.length === 0}
            <p class="muted">Nothing recorded here in {MONTHS[data.month - 1]}.</p>
          {:else}
            <ul class="mspecies">
              {#each showAllMonthly ? data.monthly.species : data.monthly.species.slice(0, MONTHLY_PREVIEW) as sp (sp.speciesCode)}
                <li>
                  <a href={`/species/${sp.speciesCode}?returnTo=${encodeURIComponent(`/hotspots/${data.locId}?tab=monthly&month=${data.month}`)}`}
                    >{sp.comName}</a
                  >
                  <span class="muted">{pct(sp.freq)}{sp.lowSample ? "†" : ""}</span>
                  {#if sp.need}<Badge kind="need" label="Need" />{/if}
                </li>
              {/each}
            </ul>
            {#if data.monthly.species.length > MONTHLY_PREVIEW}
              <button
                type="button"
                class="showall"
                onclick={() => (showAllMonthly = !showAllMonthly)}
              >
                {showAllMonthly
                  ? `Show the top ${MONTHLY_PREVIEW}`
                  : `Show all ${data.monthly.species.length} species`}
              </button>
            {/if}
            <p class="muted">† = few checklists that month — treat as a hint.</p>
          {/if}
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
    max-width: 860px;
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
  .venues {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 6px;
  }
  .venue {
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 0.78rem;
    font-weight: 600;
    background: #e9f1ec;
    color: #1d4a35;
    border: 1px solid #c4d9cd;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .card h2 {
    font-size: 1.05rem;
    margin-bottom: 8px;
  }
  /* Action bar: stacked full-width <640px, 2-col ≥640 (GROK pin). */
  .actions {
    display: grid;
    grid-template-columns: 1fr;
    gap: 8px;
  }
  @media (min-width: 640px) {
    .actions {
      grid-template-columns: 1fr 1fr;
    }
  }
  .act {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    padding: 10px 14px;
    border: 1px solid var(--accent);
    border-radius: 8px;
    color: var(--accent);
    font-weight: 600;
    text-decoration: none;
    background: var(--bg);
  }
  .card form {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 10px;
  }
  .card form button {
    min-height: 48px;
    padding: 10px 18px;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .card form button:disabled {
    opacity: 0.5;
  }
  .progress {
    font-weight: 600;
  }
  .ok {
    color: var(--seen-text);
  }
  .err {
    color: var(--danger);
  }
  /* Two-tab bar (GROK-pinned: not <details>, not ForecastTabs reuse). */
  .tabs {
    display: flex;
    gap: 6px;
    margin: 0 0 12px;
  }
  .tabs a {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-weight: 600;
    color: var(--text);
    text-decoration: none;
    background: var(--card);
  }
  .tabs a.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .backs {
    display: flex;
    gap: 6px;
  }
  .backopt {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    min-width: 48px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-weight: 600;
    color: var(--text);
    text-decoration: none;
  }
  .backopt.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .day {
    font-size: 0.82rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin: 14px 0 6px;
  }
  .obs {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .obs li {
    display: flex;
    gap: 8px;
    align-items: center;
    min-height: 48px;
    flex-wrap: wrap;
    border-top: 1px solid var(--border);
  }
  .obs a {
    color: inherit;
    font-weight: 600;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    min-height: 48px;
  }
  .obs a.cl {
    margin-left: auto;
    color: var(--accent);
    font-weight: 600;
    font-size: 0.82rem;
    white-space: nowrap;
  }
  .showall {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 48px;
    margin-top: 8px;
    padding: 10px 14px;
    border: 1px solid var(--accent);
    border-radius: 8px;
    background: var(--bg);
    color: var(--accent);
    font-weight: 600;
  }
  .unconf {
    padding: 1px 8px;
    border-radius: 6px;
    font-size: 0.72rem;
    font-weight: 700;
    background: #fde8c8;
    color: #724200;
  }
  .months {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 6px;
    margin-bottom: 8px;
  }
  @media (min-width: 640px) {
    .months {
      grid-template-columns: repeat(12, 1fr);
    }
  }
  .month {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    border: 1px solid var(--border);
    border-radius: 8px;
    text-decoration: none;
    color: var(--text);
  }
  .month.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .mname {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
  }
  .mcount {
    font-size: 0.85rem;
    font-weight: 600;
  }
  .mspecies {
    list-style: none;
    padding: 0;
    margin: 8px 0 0;
  }
  .mspecies li {
    display: flex;
    gap: 10px;
    align-items: center;
    min-height: 40px;
    border-top: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .mspecies a {
    color: inherit;
    font-weight: 600;
    text-decoration: none;
  }
  @media (hover: hover) {
    .obs a:hover,
    .mspecies a:hover {
      color: var(--accent);
    }
    .act:hover {
      background: var(--accent);
      color: #fff;
    }
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
