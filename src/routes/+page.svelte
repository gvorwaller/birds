<script lang="ts">
  import Badge from "$components/Badge.svelte";
  import BestPlaces from "$components/BestPlaces.svelte";
  import DistanceUnitToggle from "$components/DistanceUnitToggle.svelte";
  import MapLink from "$components/MapLink.svelte";
  import ObsMap, { type ObsPoint } from "$components/ObsMap.svelte";
  import PlaceMatches from "$components/PlaceMatches.svelte";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { formatDistance, type DistanceUnit } from "$lib/geo";
  import { FORECAST_CALENDAR_TZ } from "$lib/forecast-calendar";
  import {
    buildPlaceIndex,
    searchPlaces,
    speciesAtPlace,
  } from "$lib/place-search";
  import { homeUrlWithQuery } from "$lib/return-link";
  import { nearestDistanceKm, sortNeedsByNearest } from "$lib/needs-sort";
  import { speciesLinkHref } from "$lib/species-context";
  import { backOptionLabel, windowPhrase } from "$lib/time-windows";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  let distanceUnit = $state<DistanceUnit>("mi");

  // Minted here, not in the loader. `page.url` is populated under SSR as well
  // as on the client, and it is the only source that stays correct across a
  // client-side focus navigation — the loader deliberately never reads
  // `url.search` (see its INVARIANT note), so a server-built value would go
  // stale the moment `?loc=` changes and the species round trip would drop the
  // focused place.
  let returnTo = $derived(homeUrlWithQuery(page.url.search));

  // Read-only family accounts can't reach Settings, so never point them there.
  let isViewer = $derived(data.user?.role === "viewer");

  // Client-side species search across both lists (notable + needs). A matched
  // species expands to show every place in range it was reported.
  let q = $state("");
  let showAllNeeds = $state(false);
  let expanded = $state(new Set<string>());
  let needsSort = $state<"activity" | "nearest">("activity");
  const NEEDS_PREVIEW = 25;

  let ql = $derived(q.trim().toLowerCase());
  let searching = $derived(ql.length > 0);
  function matches(n: { comName: string; sciName: string }): boolean {
    return (
      n.comName.toLowerCase().includes(ql) ||
      n.sciName.toLowerCase().includes(ql)
    );
  }

  // Tier-1 (td-97b22e): fetchedAt shipped on every view but rendered only
  // as a binary "cached" badge — the actual freshness time is the useful bit.
  // Explicit app time zone (the forecast-calendar precedent): the droplet
  // SSRs in UTC, so an undefined locale/zone painted "10:30 PM" for a
  // 6:30 PM ET fetch until hydration corrected it (GROK P2).
  function asOf(iso: string | Date): string {
    return (
      new Date(iso).toLocaleTimeString("en-US", {
        timeZone: FORECAST_CALENDAR_TZ,
        hour: "numeric",
        minute: "2-digit",
      }) + " ET"
    );
  }

  let notableAll = $derived(data.view?.notable ?? []);
  let needsAll = $derived(data.view?.needs ?? []);

  // No species may render in both the Notable and Needs lists (item 2 of
  // 2026-08-11-forecast-ux-suggestions.md #7): a species that is both notable
  // and still needed stays in Needs, gains an extra "Notable" badge there, and
  // is dropped from the Notable list rather than shown twice. `allNotableCodes`
  // is built from the RAW list (before dropping) since that is what the Needs
  // badge below must test against; named apart from `mapPoints`' own
  // `notableCodes` local below, which dedups against the RENDERED list for a
  // different reason (see its comment) and must not be confused with this one.
  let needsCodes = $derived(new Set(needsAll.map((n) => n.speciesCode)));
  let allNotableCodes = $derived(
    new Set(notableAll.map((n) => n.speciesCode)),
  );
  let notableDeduped = $derived(
    notableAll.filter((n) => !needsCodes.has(n.speciesCode)),
  );

  // --- Place search + focus -------------------------------------------------
  // The index inverts the species→places data the loader already ships, so this
  // costs no extra requests. Rebuilt only when the view changes, never per
  // keystroke; only `searchPlaces` runs on input.
  let placeIndex = $derived(buildPlaceIndex(notableAll, needsAll));
  let placeHits = $derived(searching ? searchPlaces(placeIndex, q) : []);

  // `?loc=` is the single source of truth. It is deliberately untracked by the
  // loader, so changing it is a client-side navigation that reuses server data.
  let focusKey = $derived(page.url.searchParams.get("loc"));
  let focused = $derived(
    focusKey ? (placeIndex.find((p) => p.key === focusKey) ?? null) : null,
  );

  function urlWithFocus(key: string | null): string {
    const u = new URL(page.url);
    if (key) u.searchParams.set("loc", key);
    else u.searchParams.delete("loc");
    return u.pathname + u.search;
  }

  function focusPlace(key: string | null, replace = false) {
    // No-op when nothing would change: a same-URL `goto` without
    // `replaceState` still pushes a history entry, so re-clicking the focused
    // row would stack duplicates and make Back look broken.
    if ((focusKey ?? null) === key) return;
    // Rapid clicks overtake each other and SvelteKit rejects the loser with
    // "navigation aborted". The last one still wins, but an unhandled
    // rejection would surface as a console error.
    goto(urlWithFocus(key), {
      keepFocus: true,
      noScroll: true,
      replaceState: replace,
    }).catch(() => {});
  }

  // Self-heal: a radius/window/place change rebuilds the index, and the focused
  // key may no longer exist in it — as can a hand-edited or shared stale `loc`.
  //
  // No `placeIndex.length > 0` guard: `placeIndex` is derived synchronously from
  // `data`, so it is never transiently unbuilt, and requiring a non-empty index
  // meant a stale `loc` survived forever in exactly the states that have no
  // index at all (eBird error, no key, no home — `view` is null). Idempotent
  // because the repair drops `loc` from `page.url`, making this condition false.
  $effect(() => {
    if (focusKey && !focused) focusPlace(null, true);
  });

  // Focus REPLACES the species-name predicate rather than ANDing with it: no
  // species is named "hugenot", so intersecting the two would empty both lists.
  // The typed text stays put so the Places group and escape hatch remain usable.
  let notableShown = $derived(
    focused
      ? speciesAtPlace(focused, notableDeduped)
      : searching
        ? notableDeduped.filter(matches)
        : notableDeduped,
  );
  let needsMatched = $derived(
    focused
      ? speciesAtPlace(focused, needsAll)
      : searching
        ? needsAll.filter(matches)
        : needsAll,
  );
  // "Activity" is a no-op (needsMatched already arrives in that order from the
  // loader); "Nearest" is the only client-side reorder. Applied before the
  // preview slice so the sort choice also governs which 25 are shown by
  // default, not just their order once expanded.
  let needsSorted = $derived.by(() => {
    const sorted =
      needsSort === "nearest"
        ? sortNeedsByNearest(needsMatched)
        : needsMatched;
    // Notable needs stay above the 25-row fold so they don't vanish from
    // both lists after the Notable→Needs dedup.
    if (
      needsSort !== "activity" ||
      searching ||
      focused ||
      showAllNeeds
    ) {
      return sorted;
    }
    const notable = sorted.filter((n) => allNotableCodes.has(n.speciesCode));
    const rest = sorted.filter((n) => !allNotableCodes.has(n.speciesCode));
    return [...notable, ...rest];
  });
  let needsShown = $derived(
    searching || focused || showAllNeeds
      ? needsSorted
      : needsSorted.slice(0, NEEDS_PREVIEW),
  );

  // Escape hatch when nothing in the loaded reports matches: re-run the real
  // geocoder. Built with URL/URLSearchParams so a query containing `&`, `#` or
  // existing percent-escapes cannot change the link's meaning.
  let geocodeHref = $derived.by(() => {
    const params = new URLSearchParams();
    params.set("place", q.trim());
    params.set("dist", String(data.dist));
    params.set("back", String(data.back));
    return `/?${params.toString()}`;
  });

  function toggleExpand(code: string) {
    const next = new Set(expanded);
    next.has(code) ? next.delete(code) : next.add(code);
    expanded = next;
  }

  // Carry the selected origin into the species drilldown, but only once the
  // view has moved off the plain saved-home default — that path keeps its
  // historical behavior of loading reports around home at the species radius.
  let speciesContext = $derived(
    data.location && !data.usingSavedHome
      ? {
          lat: data.location.lat,
          lng: data.location.lng,
          distKm: data.dist,
          label: data.location.label,
        }
      : null,
  );
  function speciesHref(code: string): string {
    return speciesLinkHref(code, {
      backDays: data.back,
      returnTo,
      context: speciesContext,
    });
  }
  // `focused` matters independently of `searching`: a cold or shared `?loc=`
  // URL arrives with an empty query box, and without this the focused cards
  // would render no place details at all.
  let showPlaces = $derived(
    (code: string) => searching || !!focused || expanded.has(code),
  );

  // One-action reset to the saved home *and* the saved radius, keeping only the
  // chosen report window. Dropping `place` and `dist` is what restores both.
  let resetHomeHref = $derived(`/?back=${data.back}`);

  // Null while focused. `ObsMap` always extends its bounds with `center` and
  // counts entries rather than unique coordinates, so passing the focused
  // coordinates *and* a marker at those same coordinates would score 2 points
  // and run `fitBounds` on a zero-area box. With no center, one marker takes
  // the single-point `setCenter` + `setZoom` path — a predictable focus zoom.
  let mapCenter = $derived(
    focused
      ? null
      : data.location
        ? { lat: data.location.lat, lng: data.location.lng }
        : null,
  );
  // The map mirrors the visible lists: a pin per shown species by default, or
  // every place of each matched species while searching.
  let mapPoints = $derived.by<ObsPoint[]>(() => {
    if (!data.view || !data.location) return [];

    // Focused: one aggregate marker for the place itself. Emitting a pin per
    // species would stack them all on identical coordinates.
    if (focused) {
      const needCount = focused.needCodes.size;
      const rareCount = focused.notableCodes.size;
      return [
        {
          lat: focused.lat,
          lng: focused.lng,
          title: focused.locName,
          sub: [
            needCount ? `${needCount} ${needCount === 1 ? "need" : "needs"}` : "",
            rareCount
              ? `${rareCount} ${rareCount === 1 ? "rarity" : "rarities"}`
              : "",
          ]
            .filter(Boolean)
            .join(" · "),
          kind: rareCount > 0 ? "notable" : "need",
        },
      ];
    }

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
  <title>Home — birds</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <h1>Home</h1>
    <p class="sub">
      Find birds you need near home or anywhere you plan to go.
    </p>
  </header>

  <!-- Moved up from the bottom of the page (item 5): a compact strip so it
       stays out of the way of the Needs/Notable content on a mobile screen,
       rather than a full "card" of rows the user has to scroll past to reach
       it. -->
  <section class="card glance">
    <div class="glance-item">
      <span class="glance-label">Life list</span>
      <span class="glance-value">{data.seenCount}</span>
    </div>
    {#if data.hasGallery}
      <div class="glance-item">
        <span class="glance-label"><a href="/photos">Photos</a></span>
        <span class="glance-value">{data.photoCount}</span>
      </div>
    {/if}
    <div class="glance-item">
      <span class="glance-label">Sync</span>
      <span class="glance-value">
        {#if data.lifeListSyncedAt}
          <span title={new Date(data.lifeListSyncedAt).toLocaleString()}
            >{new Date(data.lifeListSyncedAt).toLocaleDateString()}</span
          >
          {#if data.lifeListStatus === "error" && !isViewer}<Badge
              kind="notable"
              label="sync error"
            />{/if}
        {:else if isViewer}
          not synced
        {:else}
          <a href="/settings">not synced</a>
        {/if}
      </span>
    </div>
  </section>

  <section class="card">
    <form method="GET" class="filters">
      <label class="grow-field">
        <span>View a different area</span>
        <input
          type="text"
          name="place"
          placeholder="View a different area…"
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
          {#each data.radiusOptionsKm as km (km)}
            <option value={km} selected={data.dist === km}
              >{formatDistance(km, distanceUnit)}</option
            >
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
      <div class="loc">
        <p class="muted loc-text">
          📍 {data.location.label} · within {formatDistance(
            data.dist,
            distanceUnit,
          )} · {windowPhrase(data.back)}
        </p>
        {#if data.hasHome && !data.usingSavedHome}
          <!-- Clears the searched place *and* the view-only radius, so it is a
               reset to both saved defaults, not just a re-centering on home. -->
          <a href={resetHomeHref} class="reset-home">↺ Reset home defaults</a>
        {/if}
      </div>
    {/if}
  </section>

  {#if data.needsLocation}
    <section class="card">
      <h2>Pick a place to start</h2>
      <p class="muted">
        {#if isViewer}
          Search a place above to see needs and notable reports.
        {:else}
          Search a place above, or <a href="/settings"
            >set your home location</a
          > to default to it.
        {/if}
      </p>
    </section>
  {/if}

  {#if !data.hasApiKey}
    <section class="card">
      <h2>Get set up</h2>
      <p class="muted">
        {#if isViewer}
          Live eBird data isn't available on this account right now.
        {:else}
          Add your eBird API key in <a href="/settings">Settings</a> to see your
          needs and notable reports.
        {/if}
      </p>
    </section>
  {/if}

  <!-- Guarded on the location, NOT on `mapCenter`: focus mode deliberately
       passes a null center (see its comment) and the map must stay rendered. -->
  {#if data.view && data.location}
    <section class="card map-card">
      <ObsMap points={mapPoints} center={mapCenter} />
      <p class="legend">
        {#if focused}
          <!-- Must track the marker kind emitted above, which goes notable
               (red) when the place has a rarity — a fixed `need` dot here
               would show green beside a red pin. -->
          <span
            class="dot {focused.notableCodes.size > 0 ? 'notable' : 'need'}"
          ></span>
          focused place
        {:else}
          <span class="dot need"></span> need
          <span class="dot notable"></span> notable
          <span class="dot home"></span> selected location
        {/if}
      </p>
    </section>
  {/if}

  {#if data.error}
    <section class="card">
      <p class="muted">{data.error}</p>
    </section>
  {/if}

  {#if data.view}
    <section class="card search-card">
      <label class="sr-only" for="home-search"
        >Filter these birds and places</label
      >
      <input
        id="home-search"
        class="search"
        type="search"
        placeholder="Filter these birds and places…"
        bind:value={q}
      />
      {#if searching}
        <!-- While focused the bird lists show the PLACE's birds, not birds
             matching the query, so only the place count is a match count. -->
        <span class="search-count"
          >{placeHits.length}
          {placeHits.length === 1 ? "place" : "places"}{focused
            ? ""
            : ` · ${notableShown.length + needsMatched.length} ${
                notableShown.length + needsMatched.length === 1
                  ? "bird"
                  : "birds"
              }`}</span
        >
      {/if}
    </section>

    <p aria-live="polite" class="sr-only">
      {#if focused}
        Showing birds reported at {focused.locName}.
      {:else if searching}
        {placeHits.length} places and {notableShown.length + needsMatched.length}
        birds match {q}.
      {/if}
    </p>

    {#if focused}
      <div class="focus-bar">
        <span class="focus-chip">
          📍 {focused.locName}
        </span>
        {#if data.view?.enrichPartial}
          <!-- Absence of a species here is not proof it isn't there: some
               per-species detail calls failed. Said where focus is visible,
               since the collapsed Places list may not be showing it. -->
          <span class="muted partial-note">some locations may be missing</span>
        {/if}
        <button
          type="button"
          class="focus-clear"
          onclick={() => focusPlace(null)}
        >
          Clear place focus
        </button>
      </div>
    {/if}

    {#if searching}
      <PlaceMatches
        places={placeHits}
        query={q}
        focusedKey={focusKey}
        {distanceUnit}
        partial={data.view.enrichPartial}
        onfocusplace={(p) => focusPlace(p.key)}
      />
      <!-- Shown even while focused: the typed text deliberately survives
           focusing (§4a), so the user can retype and must still be offered the
           geocoder when nothing in range matches. Gating this on `!focused`
           made the escape hatch unreachable exactly when someone was searching
           for somewhere new. -->
      {#if placeHits.length === 0}
        <section class="card">
          <p class="muted">
            No place in the loaded reports matches “{q}”{data.view.enrichPartial
              ? " (and some locations may be missing)"
              : ""} —
            <a href={geocodeHref}>search it as a location instead →</a>
          </p>
        </section>
      {/if}
    {/if}

    <section class="card">
      <h2>
        Notable reports — {windowPhrase(data.back)}
        <Badge kind="notable" label="Notable" />
        {#if data.view.stale}<Badge kind="stale" label="cached" />{/if}
        {#if data.view.fetchedAt}
          <span class="asof">reports as of {asOf(data.view.fetchedAt)}</span>
        {/if}
      </h2>
      <p class="muted intro">
        eBird notable reports near {data.location?.label ?? "here"} —
        {windowPhrase(data.back)}. Species you still need appear in Needs below
        with a Notable badge.
      </p>
      {#if data.view.notable.length === 0}
        <p class="muted">No notable reports in this window.</p>
      {:else if notableShown.length === 0}
        <p class="muted">
          {#if focused && focused.notableCodes.size > 0}
            Notable reports at {focused.locName} are in your needs list below.
          {:else if focused}
            No notable reports at {focused.locName} in the reports loaded for
            this view.
          {:else if searching}
            No notable reports match “{q}”.
          {:else}
            <!-- Every notable report this window is also one of your needs —
                 see it there instead, badged "Notable" (item 2). -->
            All notable reports in this window are already in your needs list
            below.
          {/if}
        </p>
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
              · {n.nReports} report{n.nReports === 1 ? "" : "s"}
              {#if n.distanceKm != null}
                · nearest {formatDistance(n.distanceKm, distanceUnit)}{/if}
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
      <div class="needs-head">
        <h2>
          {#if focused}
            {needsMatched.length}
            {needsMatched.length === 1 ? "need" : "needs"} at {focused.locName} — {windowPhrase(
              data.back,
            )}
          {:else}
            {data.view.needs.length} needs reported here — {windowPhrase(
              data.back,
            )}
          {/if}
          {#if data.view.stale}<Badge kind="stale" label="cached" />{/if}
          {#if data.view.fetchedAt}
            <span class="asof">as of {asOf(data.view.fetchedAt)}</span>
          {/if}
        </h2>
        {#if needsAll.length > 1}
          <label class="sort-control">
            <span>Sort</span>
            <select bind:value={needsSort}>
              <option value="activity">Activity</option>
              <option value="nearest">Nearest</option>
            </select>
          </label>
        {/if}
      </div>
      {#if data.seenCount === 0}
        <p class="muted">
          Your life list is empty, so every species counts as a need.
          {#if !isViewer}Sync it in <a href="/settings">Settings</a>.{/if}
        </p>
      {/if}
      {#if (searching || focused) && needsMatched.length === 0}
        <p class="muted">
          {#if focused}
            None of your needs were reported at {focused.locName} in the reports
            loaded for this view.
          {:else}
            No needs match “{q}”.
          {/if}
        </p>
      {/if}
      {#each needsShown as n (n.speciesCode)}
        <div class="obs">
          <div class="grow">
            <div class="name">
              <a href={speciesHref(n.speciesCode)}>{n.comName}</a>
              <Badge kind="need" label="Need" />
              {#if allNotableCodes.has(n.speciesCode)}<Badge
                  kind="notable"
                  label="Notable"
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
              · {n.nReports} report{n.nReports === 1 ? "" : "s"}
              {#if n.distanceKm != null}
                · nearest {formatDistance(n.distanceKm, distanceUnit)}{/if}
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
            {#if (needsSort === "nearest" ? nearestDistanceKm(n) : n.distanceKm) !=
              null}<div class="dist">
                {formatDistance(
                  (needsSort === "nearest"
                    ? nearestDistanceKm(n)
                    : n.distanceKm)!,
                  distanceUnit,
                )}
              </div>{/if}
            <div class="when">{n.lastObsDt}</div>
          </div>
        </div>
      {/each}
      <!-- `needsShown` already returns everything while focused, so without
           `!focused` this button can appear and then do nothing. -->
      {#if !searching && !focused && needsMatched.length > NEEDS_PREVIEW}
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
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin-top: 10px;
  }
  .loc-text {
    font-weight: 600;
    margin: 0;
  }
  /* A real control, not an inline link: >=48px tall per the tap-target rule,
	   and allowed to wrap onto its own row on a narrow phone. */
  .reset-home {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 48px;
    padding: 8px 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--accent);
    font-size: 0.83rem;
    font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
  }
  .reset-home:hover {
    background: var(--bg);
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
  /* Item 5: a single compact strip rather than a full card of `.obs` rows, so
     it reads at a glance and does not push the Needs card below the fold on a
     mobile screen. */
  .glance {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 24px;
    align-items: baseline;
    padding: 12px 16px;
  }
  .glance-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
    white-space: nowrap;
  }
  .glance-label {
    color: var(--muted);
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .glance-label a {
    color: inherit;
  }
  .glance-value {
    font-weight: 700;
    font-size: 0.95rem;
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
  .needs-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    margin-bottom: 10px;
  }
  .needs-head h2 {
    margin-bottom: 0;
  }
  .sort-control {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--muted);
    white-space: nowrap;
  }
  .sort-control select {
    min-height: 48px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    font-size: 16px;
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
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .focus-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin-bottom: 12px;
  }
  .focus-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 48px;
    padding: 8px 16px;
    border: 1px solid var(--accent);
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 700;
  }
  .partial-note {
    font-size: 0.83rem;
  }
  .focus-clear {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    padding: 8px 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .search-card {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .search {
    flex: 1;
    min-width: 0;
    /* cs.md:82 — >=48px tap targets. Was 44px. */
    min-height: 48px;
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
    min-height: 48px;
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
  .asof {
    color: var(--muted);
    font-size: 0.78rem;
    font-weight: 400;
  }
</style>
