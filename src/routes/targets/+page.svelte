<script lang="ts">
  import Badge from "$components/Badge.svelte";
  import BestPlaces from "$components/BestPlaces.svelte";
  import DistanceUnitToggle from "$components/DistanceUnitToggle.svelte";
  import MapLink from "$components/MapLink.svelte";
  import ObsMap, { type ObsPoint } from "$components/ObsMap.svelte";
  import { formatDistance, type DistanceUnit } from "$lib/geo";
  import { backOptionLabel, windowPhrase } from "$lib/time-windows";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  let distanceUnit = $state<DistanceUnit>("mi");

  // Client-side species search across both lists (Rare-this-week + needs). A
  // matched species expands to show every place in range it was reported.
  let q = $state("");
  let showAllNeeds = $state(false);
  let expanded = $state(new Set<string>());
  const NEEDS_PREVIEW = 25;

  let ql = $derived(q.trim().toLowerCase());
  let searching = $derived(ql.length > 0);
  function matches(n: { comName: string; sciName: string }): boolean {
    return (
      n.comName.toLowerCase().includes(ql) ||
      n.sciName.toLowerCase().includes(ql)
    );
  }

  let notableAll = $derived(data.view?.notable ?? []);
  let needsAll = $derived(data.view?.needs ?? []);
  let notableShown = $derived(
    searching ? notableAll.filter(matches) : notableAll,
  );
  let needsMatched = $derived(searching ? needsAll.filter(matches) : needsAll);
  let needsShown = $derived(
    searching || showAllNeeds
      ? needsMatched
      : needsMatched.slice(0, NEEDS_PREVIEW),
  );

  function toggleExpand(code: string) {
    const next = new Set(expanded);
    next.has(code) ? next.delete(code) : next.add(code);
    expanded = next;
  }
  function speciesHref(code: string): string {
    return `/species/${code}?back=${data.back}&returnTo=${encodeURIComponent(data.returnTo)}`;
  }
  let showPlaces = $derived((code: string) => searching || expanded.has(code));

  let mapCenter = $derived(
    data.location ? { lat: data.location.lat, lng: data.location.lng } : null,
  );
  // The map mirrors the visible lists: a pin per shown species by default, or
  // every place of each matched species while searching.
  let mapPoints = $derived.by<ObsPoint[]>(() => {
    if (!data.view || !data.location) return [];
    const notableCodes = new Set(notableAll.map((n) => n.speciesCode));
    const pts: ObsPoint[] = [
      {
        lat: data.location.lat,
        lng: data.location.lng,
        title: data.location.label,
        kind: "home",
      },
    ];
    if (searching) {
      for (const n of notableShown) {
        for (const pl of n.places) {
          pts.push({
            lat: pl.lat,
            lng: pl.lng,
            title: n.comName,
            sub: ["Notable", pl.locName].filter(Boolean).join(" · "),
            href: speciesHref(n.speciesCode),
            kind: "notable",
          });
        }
      }
      for (const n of needsMatched) {
        if (notableCodes.has(n.speciesCode)) continue;
        for (const pl of n.places) {
          pts.push({
            lat: pl.lat,
            lng: pl.lng,
            title: n.comName,
            sub: pl.locName,
            href: speciesHref(n.speciesCode),
            kind: "need",
          });
        }
      }
      return pts;
    }
    for (const n of notableShown) {
      pts.push({
        lat: n.lastLat,
        lng: n.lastLng,
        title: n.comName,
        sub: ["Notable", n.locations[0]].filter(Boolean).join(" · "),
        href: speciesHref(n.speciesCode),
        kind: "notable",
      });
    }
    for (const n of needsShown) {
      if (notableCodes.has(n.speciesCode)) continue;
      pts.push({
        lat: n.lastLat,
        lng: n.lastLng,
        title: n.comName,
        sub: n.locations[0] ?? "",
        href: speciesHref(n.speciesCode),
        kind: "need",
      });
    }
    return pts;
  });
</script>

<svelte:head>
  <title>Targets — birds</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <h1>Targets</h1>
    <p class="sub">Your needs for a place, with live recent activity</p>
  </header>

  <section class="card">
    <form method="GET" class="filters">
      <label class="grow-field">
        <span>Place</span>
        <input
          type="text"
          name="place"
          placeholder="Search a city, county, park, or address…"
          value={data.location?.label ?? ""}
          list="place-suggestions"
        />
        <datalist id="place-suggestions">
          {#each data.suggestions as s (s)}
            <option value={s}></option>
          {/each}
        </datalist>
      </label>
      <label>
        <span>Within</span>
        <select name="dist">
          {#each [10, 25, 50] as d (d)}
            <option value={d} selected={data.dist === d}>{d} km</option>
          {/each}
        </select>
      </label>
      <label>
        <span>Window</span>
        <select name="back">
          {#each data.backOptions as d (d)}
            <option value={d} selected={data.back === d}
              >{backOptionLabel(d)}</option
            >
          {/each}
        </select>
      </label>
      <div class="unit-control">
        <span>Units</span>
        <DistanceUnitToggle bind:unit={distanceUnit} />
      </div>
      <button type="submit">Search</button>
    </form>
    {#if data.location}
      <p class="muted loc">
        📍 {data.location.label} · within {data.dist} km · {windowPhrase(
          data.back,
        )}
      </p>
    {/if}
  </section>

  {#if data.needsLocation}
    <section class="card">
      <p class="muted">
        Search a place above, or <a href="/settings">set your home location</a> to
        default to it.
      </p>
    </section>
  {/if}

  {#if data.view && mapCenter}
    <section class="card map-card">
      <ObsMap points={mapPoints} center={mapCenter} />
      <p class="legend">
        <span class="dot need"></span> need
        <span class="dot notable"></span> notable
        <span class="dot home"></span> searched location
      </p>
    </section>
  {/if}

  {#if data.error}
    <section class="card">
      <p class="muted">
        {data.error}
        {#if !data.location}<a href="/settings">Settings</a>{/if}
      </p>
    </section>
  {/if}

  {#if data.view}
    <section class="card search-card">
      <input
        class="search"
        type="search"
        placeholder="Search species by name…"
        bind:value={q}
      />
      {#if searching}
        <span class="search-count"
          >{notableShown.length + needsMatched.length} match{notableShown.length +
            needsMatched.length ===
          1
            ? ""
            : "es"}</span
        >
      {/if}
    </section>

    <section class="card">
      <h2>
        Rare this week <Badge kind="notable" label="Notable" />
        {#if data.view.stale}<Badge kind="stale" label="cached" />{/if}
      </h2>
      <p class="muted intro">
        eBird notable reports near {data.location?.label ?? "here"} — {windowPhrase(
          data.back,
        )}, whether or not they're on your needs list.
      </p>
      {#if data.view.notable.length === 0}
        <p class="muted">No notable reports in this window.</p>
      {:else if searching && notableShown.length === 0}
        <p class="muted">No notable reports match “{q}”.</p>
      {/if}
      {#each notableShown as n (n.speciesCode)}
        <div class="obs">
          <div class="grow">
            <div class="name">
              <a href={speciesHref(n.speciesCode)}>{n.comName}</a>
              <Badge kind="notable" label="Notable" />
              {#if n.seen}<Badge kind="seen" label="Seen" />{:else}<Badge
                  kind="need"
                  label="Need"
                />{/if}
            </div>
            <div class="meta">
              <strong
                >{n.locationCount}
                {n.locationCount === 1 ? "location" : "locations"}</strong
              >
              ·
              <strong
                >{n.totalCount} {n.totalCount === 1 ? "bird" : "birds"}</strong
              >
              ·
              {n.locations.join(" · ")}
              {#if data.hasGallery && n.photoCount > 0}
                · 📷 you have {n.photoCount}
                {n.photoCount === 1 ? "photo" : "photos"}{/if}
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
                      >{#if pl.distanceKm != null}{formatDistance(
                          pl.distanceKm,
                          distanceUnit,
                        )} ·
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
            <div class="dist">{n.locationCount} ×</div>
            <div class="when">{n.lastObsDt}</div>
          </div>
        </div>
      {/each}
    </section>

    <section class="card">
      <h2>
        {data.view.needs.length} needs reported here — {windowPhrase(data.back)}
      </h2>
      {#if data.view.seenCount === 0}
        <p class="muted">
          Your life list is empty, so every species counts as a need. Sync it in
          <a href="/settings">Settings</a>.
        </p>
      {/if}
      {#if searching && needsMatched.length === 0}
        <p class="muted">No needs match “{q}”.</p>
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
                >{n.totalCount} {n.totalCount === 1 ? "bird" : "birds"}</strong
              >
              ·
              {n.locations.join(" · ")}
              {#if data.hasGallery && n.photoCount === 0}
                · 📷 no photo yet{/if}
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
                      >{#if pl.distanceKm != null}{formatDistance(
                          pl.distanceKm,
                          distanceUnit,
                        )} ·
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
                {formatDistance(n.distanceKm, distanceUnit)}
              </div>{/if}
            <div class="when">{n.lastObsDt}</div>
          </div>
        </div>
      {/each}
      {#if !searching && needsMatched.length > NEEDS_PREVIEW}
        <button class="more" onclick={() => (showAllNeeds = !showAllNeeds)}>
          {showAllNeeds
            ? "Show fewer"
            : `Show all ${needsMatched.length} needs`}
        </button>
      {/if}
    </section>

    <BestPlaces places={data.view.bestPlaces} {distanceUnit} />
  {/if}

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
  .intro {
    margin-bottom: 8px;
  }
  .loc {
    margin-top: 10px;
    font-weight: 600;
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
    margin-bottom: 10px;
  }
  .map-card {
    padding: 8px;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    font-size: 0.78rem;
    color: var(--muted);
    padding: 8px 4px 2px;
  }
  .dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 3px;
    vertical-align: middle;
  }
  .dot.need {
    background: #0a5c43;
  }
  .dot.notable {
    background: #842029;
  }
  .dot.home {
    background: #084298;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: flex-end;
  }
  .filters label,
  .unit-control {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--muted);
  }
  .filters .grow-field {
    flex: 1;
    min-width: 220px;
  }
  .filters input,
  .filters select {
    min-height: 48px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
  }
  .filters .grow-field input {
    width: 100%;
  }
  .filters button {
    min-height: 48px;
    padding: 10px 20px;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .search-card {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .search {
    flex: 1;
    min-height: 44px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    font-size: 16px;
  }
  .search-count {
    color: var(--muted);
    font-size: 0.83rem;
    font-weight: 600;
    white-space: nowrap;
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
