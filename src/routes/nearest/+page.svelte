<script lang="ts">
  import Badge from "$components/Badge.svelte";
  import DistanceUnitToggle from "$components/DistanceUnitToggle.svelte";
  import MapLink from "$components/MapLink.svelte";
  import { formatDistance, type DistanceUnit } from "$lib/geo";
  import { isHotspotLocId } from "$lib/loc-id";
  import { page } from "$app/state";
  import PathNavigation from "$components/PathNavigation.svelte";
  import { navigationAction } from "$lib/navigation-context.svelte";
  import { withReturnTo } from "$lib/navigation-context";
  import type { PageData } from "./$types";
  import type { NearestTarget } from "./+page.server";
  import { observationIdentity } from "$lib/observation-evidence";

  let { data }: { data: PageData } = $props();
  let distanceUnit = $state<DistanceUnit>("mi");
  let searchEdited = $state(false);
  let searchScope = $state("");
  $effect(() => {
    const nextScope = `${data.selectedCode ?? ""}|${data.q}|${data.backDays}|${data.nearestKm}`;
    if (nextScope !== searchScope) {
      searchScope = nextScope;
      searchEdited = false;
    }
  });
  const backOptions = [1, 7, 14, 30];
  const distanceOptions = ["any", 25, 50, 100, 250, 500] as const;
  function speciesPageHref(code: string): string {
    return withReturnTo(`/species/${encodeURIComponent(code)}?back=${data.backDays}&nearestKm=${data.nearestKm}`,page.url.pathname + page.url.search + page.url.hash,undefined,"Nearest reports");
  }
  function reportAction(id: string, label: string) {
    return navigationAction(data.user?.id, { label, originId: `nearest-report-${encodeURIComponent(id)}` });
  }
  function speciesAction(code: string, label: string, section: string) {
    return navigationAction(data.user?.id, { label, originId: `nearest-${section}-${encodeURIComponent(code)}` });
  }
  function evidenceAsOf(value: string | Date): string {
    return new Date(value).toLocaleString("en-US", {
      timeZone: "America/New_York", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });
  }

  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
</script>

{#snippet targetCard(t: NearestTarget)}
  <section class="card">
    <h2>
      <a class="sp path-focus-target" id={`nearest-species-${encodeURIComponent(t.speciesCode)}`} href={speciesPageHref(t.speciesCode)} onclick={navigationAction(data.user?.id,{label:t.comName,originId:`nearest-species-${encodeURIComponent(t.speciesCode)}`})}
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
      {#if t.via === "ladder"}
        <!-- The region search does not cover everywhere, and a capped search
             stopped early — "no reports" would claim a search we didn't run. -->
        <p class="muted">
          No reports in the {t.searched.regions} regions searched.
          <a href="https://ebird.org/map/{t.speciesCode}" target="_blank" rel="noopener"
            >See its map on eBird ↗</a
          >
        </p>
      {:else}
        <p class="muted">No matching reports returned by the checked feeds for the selected window and distance; other reports may be unavailable.</p>
      {/if}
    {:else}
      {#each t.rows as o (observationIdentity(o))}
        <div class="nrow">
          <div class="nline1">
            {#if o.distanceKm != null}
              <span class="ndist">{formatDistance(o.distanceKm, distanceUnit)}</span>
            {/if}
            {#if isHotspotLocId(o.locId)}
              <a class="nplace path-focus-target" id={`nearest-report-${encodeURIComponent(observationIdentity(o))}`} href={withReturnTo(`/hotspots/${encodeURIComponent(o.locId)}`,page.url.pathname + page.url.search + page.url.hash,undefined,"Nearest reports")} onclick={reportAction(observationIdentity(o),o.locName)}
                >{o.locName}</a
              >
            {:else}
              <span class="nplace">{o.locName}</span>
              {#if o.locationPrivate}<span class="privloc">personal location</span>{/if}
            {/if}
          </div>
          <div class="nline2">
            <span class="muted">{o.obsDt}</span>
            {#if o.howMany != null}<span class="muted">count {o.howMany}</span>{:else}<span class="muted">reported count unavailable</span>{/if}
            {#if o.obsValid === true}<span class="accepted">Accepted</span>{:else if o.obsValid === false}<span class="unconf">Unconfirmed</span>{:else}<span class="muted">Review status unavailable</span>{/if}
            {#if o.sources?.length}<span class="muted">source: {o.sources.join(" + ")}</span>{/if}
            {#if o.fetchedAt}<span class="muted">fetched {evidenceAsOf(o.fetchedAt)}</span>{/if}
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
    {#if !t.error && t.via === "ladder" && (t.rows.length > 0 || !t.proven)}
      <p class="muted via">
        {#if t.rows.length > 0}
          Found by searching {t.searched.regions} regions outward from home.
        {/if}
        {#if !t.proven}Some closer regions couldn't be checked.{/if}
      </p>
    {/if}
    {#if !t.error}<p class="muted evidence-note">Showing up to five closest reports returned by the checked feeds. A finite distance is a result filter, not complete area coverage.</p>{/if}
    {#if t.partial && !t.error}<p class="muted">Some checked feeds were unavailable; the reports shown are incomplete.</p>{/if}
  </section>
{/snippet}

<svelte:head>
  <title>Nearest lifers — birds</title>
</svelte:head>

<div class="page">
  <PathNavigation accountId={data.user?.id} label="Nearest reports" href={page.url.pathname + page.url.search + page.url.hash} fallbackHref="/" fallbackLabel="Home" hideWhenNoPath />
  <header class="page-head">
    <h1>Nearest lifers</h1>
    <p class="sub">
      The closest current reports of birds you still need from your saved home.
      <DistanceUnitToggle bind:unit={distanceUnit} />
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
          oninput={() => (searchEdited = true)}
          placeholder="Find any species you still need"
          aria-label="Search a species you still need"
        />
        {#if !searchEdited && !data.q && data.selectedCode}
          <input type="hidden" name="code" value={data.selectedCode} />
        {/if}
        <label><span>Window</span><select name="back">
          {#each backOptions as option}<option value={option} selected={data.backDays === option}>{option === 1 ? "Last 24 hours" : `Last ${option} days`}</option>{/each}
        </select></label>
        <label><span>Distance</span><select name="nearestKm">
          {#each distanceOptions as option}<option value={option} selected={data.nearestKm === option}>{option === "any" ? "Any distance" : `Within ${formatDistance(option, distanceUnit)}`}</option>{/each}
        </select></label>
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
                  <a class="path-focus-target" id={`nearest-match-${encodeURIComponent(m.speciesCode)}`} href={speciesPageHref(m.speciesCode)} onclick={speciesAction(m.speciesCode,m.comName,'match')}
                      >species page →</a
                    >
                  </span>
                {:else}
                  <a class="mpick" href={`/nearest?code=${m.speciesCode}&back=${data.backDays}&nearestKm=${data.nearestKm}`}
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
          <a class="path-focus-target" id={`nearest-seen-${encodeURIComponent(data.searchedSeen.speciesCode)}`} href={speciesPageHref(data.searchedSeen.speciesCode)} onclick={speciesAction(data.searchedSeen.speciesCode,data.searchedSeen.comName,'seen')}
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
          {data.homeLabel ?? "home"} — last {data.backDays} days, cached 3 hours{data.likelyCount >
          data.autoRunCap
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
  .via {
    margin-top: 8px;
    font-size: 0.82rem;
  }
  .searchcard form {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .searchcard label {
    display: grid;
    gap: 3px;
    font-size: 0.82rem;
  }
  .searchcard select {
    appearance: none;
    height: 48px;
    padding: 8px 32px 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
    background-position: calc(100% - 15px) 50%, calc(100% - 10px) 50%;
    background-size: 5px 5px;
    background-repeat: no-repeat;
  }
  .searchcard select,
  .searchcard input,
  .searchcard button {
    min-height: 48px;
    font-size: 16px;
  }
  .searchcard input {
    flex: 1 1 240px;
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
    color: var(--on-accent);
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
  .accepted {
    color: var(--seen-text);
    font-weight: 700;
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
