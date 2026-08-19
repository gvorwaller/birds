<script lang="ts">
  import Badge from "$components/Badge.svelte";
  import DistanceUnitToggle from "$components/DistanceUnitToggle.svelte";
  import MapLink from "$components/MapLink.svelte";
  import { formatDistance, type DistanceUnit } from "$lib/geo";
  import { isHotspotLocId } from "$lib/loc-id";
  import type { PageData } from "./$types";
  import type { NearestTarget } from "./+page.server";

  let { data }: { data: PageData } = $props();
  let distanceUnit = $state<DistanceUnit>("mi");

  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
</script>

{#snippet targetCard(t: NearestTarget)}
  <section class="card">
    <h2>
      <a class="sp" href={`/species/${t.speciesCode}?returnTo=${encodeURIComponent("/nearest")}`}
        >{t.comName}</a
      >
      <Badge kind="need" label="Need" />
      {#if t.areaFreq != null}
        <span class="muted freq">{Math.round(t.areaFreq * 100)}% of checklists this month</span>
      {/if}
      {#if t.stale}<Badge kind="stale" label="cached" />{/if}
    </h2>
    {#if t.error}
      <p class="muted">{t.error}</p>
    {:else if t.rows.length === 0}
      <p class="muted">No reports in the last {data.backDays} days.</p>
    {:else}
      {#each t.rows as o (o.locId + o.obsDt)}
        <div class="nrow">
          <div class="nline1">
            {#if o.distanceKm != null}
              <span class="ndist">{formatDistance(o.distanceKm, distanceUnit)}</span>
            {/if}
            {#if isHotspotLocId(o.locId)}
              <a class="nplace" href={`/hotspots/${o.locId}?returnTo=${encodeURIComponent("/nearest")}`}
                >{o.locName}</a
              >
            {:else}
              <span class="nplace">{o.locName}</span>
              {#if o.locationPrivate}<span class="privloc">personal location</span>{/if}
            {/if}
          </div>
          <div class="nline2">
            <span class="muted">{o.obsDt}</span>
            {#if o.howMany != null && o.howMany > 1}<span class="muted">×{o.howMany}</span>{/if}
            {#if !o.obsValid}<span class="unconf">Unconfirmed</span>{/if}
            <MapLink lat={o.lat} lng={o.lng} name={o.locName} googlePlaceId={o.googlePlaceId} />
            {#if o.subId}
              <a class="cl" href={`https://ebird.org/checklist/${o.subId}`} target="_blank" rel="noopener"
                >checklist ↗</a
              >
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </section>
{/snippet}

<svelte:head>
  <title>Nearest lifers — birds</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <h1>Nearest lifers</h1>
    <p class="sub">
      The closest current reports of birds you still need — any distance
      from home. <DistanceUnitToggle bind:unit={distanceUnit} />
    </p>
  </header>

  {#if !data.hasHome || !data.hasApiKey}
    <section class="card">
      <p class="muted">
        {#if data.isViewer}
          This page needs the account owner's home location and eBird API
          key.
        {:else}
          Nearest lookups need a <strong>home location</strong> and an
          <strong>eBird API key</strong> — set both in
          <a href="/settings">Settings</a>.
        {/if}
      </p>
    </section>
  {:else}
    <section class="card searchcard">
      <form method="GET" action="/nearest">
        <input
          type="search"
          name="q"
          value={data.q}
          placeholder="Find any species you still need"
          aria-label="Search a species you still need"
        />
        <button type="submit">Search</button>
      </form>
      {#if data.q.length >= 2}
        {#if data.searchMatches.length === 0}
          <p class="muted">No species match “{data.q}”.</p>
        {:else}
          <ul class="matches">
            {#each data.searchMatches as m (m.speciesCode)}
              <li>
                {#if m.seen}
                  <!-- Seen species: no eBird call — you already have it. -->
                  <span class="mseen">
                    {m.comName}
                    <Badge kind="seen" label="Seen" />
                    <a href={`/species/${m.speciesCode}?returnTo=${encodeURIComponent("/nearest")}`}
                      >species page →</a
                    >
                  </span>
                {:else}
                  <a class="mpick" href={`/nearest?code=${m.speciesCode}`}
                    >{m.comName} <Badge kind="need" label="Need" /></a
                  >
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </section>

    {#if data.searchedSeen}
      <section class="card">
        <p>
          You already have <strong>{data.searchedSeen.comName}</strong> — no
          lookup needed.
          <a href={`/species/${data.searchedSeen.speciesCode}?returnTo=${encodeURIComponent("/nearest")}`}
            >species page →</a
          >
        </p>
      </section>
    {:else if data.searched}
      {@render targetCard(data.searched)}
    {:else if data.q.length < 2}
      {#if data.forecastError}
        <section class="card"><p class="muted">{data.forecastError}</p></section>
      {:else if data.targets.length === 0}
        <section class="card">
          <p class="muted">
            No likely-band needs for {MONTH_NAMES[data.month - 1]} near home
            yet — search a species above, or load more hotspot data in
            <a href="/forecast">Forecast</a>.
          </p>
        </section>
      {:else}
        <p class="muted disclose">
          Checking your {data.targets.length} highest-probability target{data
            .targets.length === 1
            ? ""
            : "s"} for {MONTH_NAMES[data.month - 1]} near
          {data.homeLabel ?? "home"} — last {data.backDays} days, cached 30
          min{data.likelyCount > data.autoRunCap
            ? ` (of ${data.likelyCount} likely this month)`
            : ""}.
        </p>
        {#each data.targets as t (t.speciesCode)}
          {@render targetCard(t)}
        {/each}
      {/if}
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
  .card h2 {
    font-size: 1.02rem;
    margin-bottom: 6px;
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  a.sp {
    color: inherit;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    min-height: 48px;
  }
  @media (hover: hover) {
    a.sp:hover {
      color: var(--accent);
    }
  }
  .freq {
    font-weight: 400;
  }
  .searchcard form {
    display: flex;
    gap: 8px;
  }
  .searchcard input {
    flex: 1;
    min-height: 48px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    min-width: 0;
  }
  .searchcard button {
    min-height: 48px;
    padding: 10px 18px;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .matches {
    list-style: none;
    padding: 0;
    margin: 10px 0 0;
  }
  .matches li {
    border-top: 1px solid var(--border);
  }
  .mpick,
  .mseen {
    display: flex;
    gap: 8px;
    align-items: center;
    min-height: 48px;
    color: inherit;
    text-decoration: none;
    font-weight: 600;
    flex-wrap: wrap;
  }
  .mseen {
    font-weight: 400;
  }
  .mseen a {
    color: var(--accent);
    font-weight: 600;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    min-height: 48px;
  }
  @media (hover: hover) {
    .mpick:hover {
      color: var(--accent);
    }
  }
  .disclose {
    margin: 0 4px 10px;
  }
  /* Distance-hero rows (AGY two-line layout, GROK-pinned). */
  .nrow {
    padding: 6px 0;
  }
  .nrow + .nrow {
    border-top: 1px solid var(--border);
  }
  .nline1 {
    display: flex;
    gap: 10px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .ndist {
    font-weight: 800;
    font-size: 1.05rem;
    white-space: nowrap;
  }
  .nplace {
    font-weight: 600;
    color: inherit;
    text-decoration: none;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  a.nplace {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
  }
  @media (hover: hover) {
    a.nplace:hover {
      color: var(--accent);
    }
  }
  .nline2 {
    display: flex;
    gap: 8px 12px;
    align-items: center;
    flex-wrap: wrap;
    font-size: 0.85rem;
  }
  .privloc {
    color: var(--muted);
    font-size: 0.78rem;
    font-style: italic;
  }
  .unconf {
    padding: 1px 8px;
    border-radius: 6px;
    font-size: 0.72rem;
    font-weight: 700;
    background: #fde8c8;
    color: #5f3700;
  }
  a.cl {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    color: var(--accent);
    font-weight: 600;
    font-size: 0.82rem;
    text-decoration: none;
    white-space: nowrap;
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
