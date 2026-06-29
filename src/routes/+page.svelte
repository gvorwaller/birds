<script lang="ts">
  import Badge from "$components/Badge.svelte";
  import BestPlaces from "$components/BestPlaces.svelte";
  import MapLink from "$components/MapLink.svelte";
  import ObsMap, { type ObsPoint } from "$components/ObsMap.svelte";
  import { formatKm } from "$lib/geo";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  // Client-side species search over the full needs list (the server now sends
  // all needs, not just the top 20). When searching, a matched species expands
  // to show every place in range it was reported.
  let q = $state("");
  let showAll = $state(false);
  let expanded = $state(new Set<string>());
  const PREVIEW = 20;

  let ql = $derived(q.trim().toLowerCase());
  let searching = $derived(ql.length > 0);
  let matched = $derived(
    searching
      ? data.needs.filter(
          (n) =>
            n.comName.toLowerCase().includes(ql) ||
            n.sciName.toLowerCase().includes(ql),
        )
      : data.needs,
  );
  let needsShown = $derived(
    searching || showAll ? matched : matched.slice(0, PREVIEW),
  );

  function toggleExpand(code: string) {
    const next = new Set(expanded);
    next.has(code) ? next.delete(code) : next.add(code);
    expanded = next;
  }
  function speciesHref(code: string): string {
    return `/species/${code}?back=${data.backDays}&returnTo=${encodeURIComponent(data.returnTo)}`;
  }
  let showPlaces = $derived((code: string) => searching || expanded.has(code));

  let homeCenter = $derived(
    data.home ? { lat: data.home.lat, lng: data.home.lon } : null,
  );
  // The map mirrors the visible list: one pin per shown need by default, or
  // every place of each matched species while searching.
  let mapPoints = $derived.by<ObsPoint[]>(() => {
    const home: ObsPoint[] = data.home
      ? [
          {
            lat: data.home.lat,
            lng: data.home.lon,
            title: "Home",
            kind: "home",
          },
        ]
      : [];
    if (searching) {
      const pts: ObsPoint[] = [];
      for (const n of matched) {
        for (const pl of n.places) {
          pts.push({
            lat: pl.lat,
            lng: pl.lng,
            title: n.comName,
            sub: [
              pl.locName,
              pl.distanceKm != null ? formatKm(pl.distanceKm) : null,
            ]
              .filter(Boolean)
              .join(" · "),
            href: speciesHref(n.speciesCode),
            kind: "need",
          });
        }
      }
      return [...home, ...pts];
    }
    return [
      ...home,
      ...needsShown.map((n) => ({
        lat: n.lastLat,
        lng: n.lastLng,
        title: n.comName,
        sub: [
          n.locations[0],
          n.distanceKm != null ? formatKm(n.distanceKm) : null,
        ]
          .filter(Boolean)
          .join(" · "),
        href: speciesHref(n.speciesCode),
        kind: "need" as const,
      })),
    ];
  });
</script>

<svelte:head>
  <title>Near Me — birds</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <h1>Near Me</h1>
    <p class="sub">
      {#if data.home}
        Home: {data.home.lat.toFixed(3)}, {data.home.lon.toFixed(3)} · radius {data.distKm}
        km ·
        <a href="/settings">change</a>
      {:else}
        No home location saved — <a href="/settings">set it in Settings</a>
      {/if}
    </p>
  </header>

  {#if data.home && data.hasApiKey && !data.needsError}
    <section class="card map-card">
      <ObsMap points={mapPoints} center={homeCenter} />
    </section>
  {/if}

  {#if !data.hasApiKey}
    <section class="card">
      <h2>Get set up</h2>
      <p class="muted">
        Add your eBird API key in <a href="/settings">Settings</a> to see your needs
        reported nearby.
      </p>
    </section>
  {:else if data.needsError}
    <section class="card">
      <h2>Your needs reported nearby</h2>
      <p class="muted">{data.needsError}</p>
    </section>
  {:else if data.home}
    <section class="card">
      <h2>
        Your needs reported nearby — last {data.backDays} days
        {#if data.stale}<Badge kind="stale" label="cached" />{/if}
      </h2>
      <form method="GET" class="window-form">
        <label>
          <span>Window</span>
          <select
            name="back"
            onchange={(e) => e.currentTarget.form?.requestSubmit()}
          >
            {#each data.backOptions as d (d)}
              <option value={d} selected={data.backDays === d}
                >Last {d} days</option
              >
            {/each}
          </select>
        </label>
      </form>
      {#if data.needs.length === 0}
        <p class="muted">
          No unseen species reported within {data.distKm} km this week.
          {#if data.seenCount === 0}Import your life list in <a href="/settings"
              >Settings</a
            > first — otherwise everything counts as a need.{/if}
        </p>
      {:else}
        <input
          class="search"
          type="search"
          placeholder="Search your {data.needs.length} needs by name…"
          bind:value={q}
        />
        {#if searching && matched.length === 0}
          <p class="muted no-match">No needs match “{q}”.</p>
        {/if}
        {#each needsShown as n (n.speciesCode)}
          <div class="obs">
            <div class="grow">
              <div class="name">
                <a href={speciesHref(n.speciesCode)}>{n.comName}</a>
                <Badge kind="need" label="Need" />
              </div>
              <div class="meta">
                <strong
                  >{n.locationCount}
                  {n.locationCount === 1 ? "location" : "locations"}</strong
                >
                ·
                <strong
                  >{n.totalCount}
                  {n.totalCount === 1 ? "bird" : "birds"}</strong
                >
                ·
                {n.locations.join(" · ")}
              </div>
              {#if n.places.length > 1 && !searching}
                <button
                  class="places-toggle"
                  onclick={() => toggleExpand(n.speciesCode)}
                >
                  {expanded.has(n.speciesCode)
                    ? "▾ Hide places"
                    : `▸ Show all ${n.places.length} places`}
                </button>
              {/if}
              {#if showPlaces(n.speciesCode) && n.places.length > 0}
                <ul class="places">
                  {#each n.places as pl (pl.locId ?? `${pl.lat},${pl.lng}`)}
                    <li>
                      <MapLink
                        lat={pl.lat}
                        lng={pl.lng}
                        name={pl.locName}
                        googlePlaceId={pl.googlePlaceId}
                      />
                      <span class="pl-name">{pl.locName}</span>
                      <span class="pl-meta"
                        >{#if pl.distanceKm != null}{formatKm(pl.distanceKm)} ·
                        {/if}{pl.nReports}
                        {pl.nReports === 1 ? "report" : "reports"} · {pl.totalCount}
                        {pl.totalCount === 1 ? "bird" : "birds"} ·
                        {pl.lastObsDt}</span
                      >
                    </li>
                  {/each}
                </ul>
              {:else}
                <MapLink
                  lat={n.lastLat}
                  lng={n.lastLng}
                  name={n.locations[0] ?? n.comName}
                  googlePlaceId={n.googlePlaceId}
                />
              {/if}
            </div>
            <div class="right">
              {#if n.distanceKm != null}<div class="dist">
                  {formatKm(n.distanceKm)}
                </div>{/if}
              <div class="when">{n.lastObsDt}</div>
            </div>
          </div>
        {/each}
        {#if !searching && matched.length > PREVIEW}
          <button class="more" onclick={() => (showAll = !showAll)}>
            {showAll ? "Show fewer" : `Show all ${matched.length} needs`}
          </button>
        {/if}
      {/if}
    </section>
  {/if}

  <BestPlaces places={data.bestPlaces} title="Best places near you" limit={6} />

  <section class="card">
    <h2>At a glance</h2>
    <div class="obs">
      <div class="grow">
        <div class="name">Life list</div>
        <div class="meta">
          {#if data.lifeListSyncedAt}
            synced from eBird {new Date(data.lifeListSyncedAt).toLocaleString()}
            {#if data.lifeListStatus === "error"}<Badge
                kind="notable"
                label="sync error"
              />{/if}
          {:else}
            not synced yet — <a href="/settings">Settings</a>
          {/if}
        </div>
      </div>
      <div class="right"><div class="dist">{data.seenCount}</div></div>
    </div>
    {#if data.hasGallery}
      <div class="obs">
        <div class="grow">
          <div class="name">Photos on gaylon.photos</div>
          <div class="meta"><a href="/photos">My Photos</a></div>
        </div>
        <div class="right"><div class="dist">{data.photoCount}</div></div>
      </div>
    {/if}
  </section>

  <p class="attribution">
    Data from <a href="https://ebird.org" target="_blank" rel="noopener"
      >eBird.org</a
    >
  </p>
</div>

<style>
  .page {
    max-width: 1100px;
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
  .map-card {
    padding: 8px;
  }
  .card h2 {
    font-size: 1.05rem;
    margin-bottom: 10px;
  }
  .search {
    width: 100%;
    min-height: 44px;
    padding: 8px 12px;
    margin-bottom: 8px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    font-size: 16px;
  }
  .window-form {
    display: flex;
    justify-content: flex-end;
    margin: -4px 0 10px;
  }
  .window-form label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 0.83rem;
    font-weight: 600;
  }
  .window-form select {
    min-height: 40px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
  }
  .no-match {
    padding: 8px 0;
  }
  .places-toggle {
    margin-top: 4px;
    padding: 2px 0;
    background: none;
    border: none;
    color: var(--accent);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
  }
  .places {
    list-style: none;
    margin: 6px 0 2px;
    padding: 8px 0 2px 10px;
    border-left: 2px solid var(--accent-soft);
  }
  .places li {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 3px 0;
    font-size: 0.83rem;
  }
  .pl-name {
    font-weight: 600;
  }
  .pl-meta {
    color: var(--muted);
    font-size: 0.78rem;
  }
  .more {
    margin-top: 12px;
    min-height: 48px;
    padding: 10px 20px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--text);
    font-weight: 600;
  }
  .more:hover {
    background: var(--bg);
  }
  .obs {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 0;
    border-top: 1px solid var(--border);
  }
  .obs:first-of-type {
    border-top: none;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .name {
    font-weight: 700;
  }
  .name a {
    color: var(--text);
    text-decoration: none;
  }
  .name a:hover {
    text-decoration: underline;
  }
  .meta {
    color: var(--muted);
    font-size: 0.83rem;
    margin-top: 2px;
  }
  .right {
    text-align: right;
    flex-shrink: 0;
  }
  .dist {
    font-weight: 700;
    color: var(--accent);
    white-space: nowrap;
  }
  .when {
    color: var(--muted);
    font-size: 0.78rem;
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
