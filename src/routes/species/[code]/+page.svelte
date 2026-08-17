<script lang="ts">
  import Badge from "$components/Badge.svelte";
  import DistanceUnitToggle from "$components/DistanceUnitToggle.svelte";
  import FrequencyChart from "$components/FrequencyChart.svelte";
  import { formatMonthWindow } from "$lib/forecast-calendar";
  import MapLink from "$components/MapLink.svelte";
  import { formatDistance, type DistanceUnit } from "$lib/geo";
  import { windowPhrase } from "$lib/time-windows";
  import { enhance } from "$app/forms";
  import { jobsPoll } from "$lib/job-poll.svelte";
  import type { ActionData, PageData } from "./$types";

  const MONTH_NAMES = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let distanceUnit = $state<DistanceUnit>("mi");

  let isViewer = $derived(data.user?.role === "viewer");
  // Reports are centered on the place Home was showing, or the saved home.
  let originName = $derived(data.originLabel ?? "home");

  // --- Species enrichment (About card) ------------------------------------
  let aboutExpanded = $state(false);
  let refreshBusy = $state(false);
  const en = $derived(data.enrichment);

  // Track a queued manual refresh so the layout job chip picks it up.
  $effect(() => {
    const q = form && "queued" in form && form.queued ? form.queued : null;
    if (q) jobsPoll.track(q.jobId);
  });

  const IUCN_LABELS: Record<string, string> = {
    LC: "Least Concern",
    NT: "Near Threatened",
    VU: "Vulnerable",
    EN: "Endangered",
    CR: "Critically Endangered",
    EW: "Extinct in the Wild",
    EX: "Extinct",
    DD: "Data Deficient",
  };

  /**
   * Wikidata quantity claims can carry junk alongside real values (verified:
   * Gray Catbird has a 3.8 g best-rank mass) — only badge a range whose
   * spread is plausible (max ≤ 3× min), else stay silent rather than wrong.
   */
  function rangeBadge(
    min: number | undefined,
    max: number | undefined,
    unit: string,
  ): string | null {
    if (min == null || max == null || min <= 0) return null;
    if (max / min > 3) return null;
    const lo = Math.round(min);
    const hi = Math.round(max);
    return lo === hi ? `${lo} ${unit}` : `${lo}–${hi} ${unit}`;
  }
  const massBadge = $derived(
    rangeBadge(en?.facts?.mass_g_min, en?.facts?.mass_g_max, "g"),
  );
  const wingspanBadge = $derived(
    rangeBadge(en?.facts?.wingspan_cm_min, en?.facts?.wingspan_cm_max, "cm"),
  );
  // Gate on STORED prose, not the latest attempt's status — a transient
  // refresh failure keeps serving the preserved last-good revision instead
  // of hiding it for the whole retry window (CODEX1 P1 #3).
  const hasProse = $derived(!!en?.wikipedia_extract);
  const proseStale = $derived(hasProse && en?.wiki_status === "error");
  const hasFacts = $derived(
    !!en && (en.iucn_status != null || massBadge != null || wingspanBadge != null),
  );
  const retrievedOn = $derived(
    en?.wiki_fetched_at ? new Date(en.wiki_fetched_at).toLocaleDateString() : null,
  );
  const revisionPermalink = $derived(
    en?.wikipedia_title && en?.wikipedia_rev_id
      ? `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(en.wikipedia_title.replace(/ /g, "_"))}&oldid=${en.wikipedia_rev_id}`
      : null,
  );

  const links = $derived([
    {
      label: "eBird species page ↗",
      sub: "range maps, bar charts, photos",
      href: `https://ebird.org/species/${data.taxon.species_code}`,
    },
    {
      label: "All About Birds ↗",
      sub: "ID tips, life history",
      href: `https://www.allaboutbirds.org/guide/${data.taxon.com_name.replace(/\s+/g, "_")}`,
    },
    {
      label: "Macaulay Library ↗",
      sub: "photos, audio, video",
      href: `https://search.macaulaylibrary.org/catalog?taxonCode=${data.taxon.species_code}`,
    },
    {
      label: "xeno-canto ↗",
      sub: "sound recordings",
      // Direct species page when the enrichment cross-ID is known.
      href: en?.cross_ids?.xeno_canto_id
        ? `https://xeno-canto.org/species/${encodeURIComponent(en.cross_ids.xeno_canto_id)}`
        : `https://xeno-canto.org/explore?query=${encodeURIComponent(data.taxon.sci_name)}`,
    },
    {
      label: "iNaturalist ↗",
      sub: "observations & range",
      href: en?.cross_ids?.inat_taxon_id
        ? `https://www.inaturalist.org/taxa/${encodeURIComponent(en.cross_ids.inat_taxon_id)}`
        : `https://www.inaturalist.org/taxa/search?q=${encodeURIComponent(data.taxon.sci_name)}`,
    },
  ]);
</script>

<svelte:head>
  <title>{data.taxon.com_name} — birds</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <p class="sub">
      <a href={data.returnLink.href}>← {data.returnLink.label}</a>
    </p>
    <h1>
      {data.taxon.com_name}
      {#if data.seen}<Badge kind="seen" label="Seen" />{:else}<Badge
          kind="need"
          label="Need"
        />{/if}
    </h1>
    <p class="sub">
      <em>{data.taxon.sci_name}</em> · eBird code
      <code>{data.taxon.species_code}</code>
      {#if data.taxon.family}· {data.taxon.family}{/if}
      {#if data.seen?.first_seen}· first seen {new Date(
          data.seen.first_seen,
        ).toLocaleDateString()}{/if}
    </p>
  </header>

  {#if data.hasGallery}
    <section class="card">
      <h2>
        Your photos
        <span class="muted">
          {data.photos.length} on gaylon.photos
        </span>
      </h2>
      {#if data.photos.length === 0}
        <p class="muted">
          No photos of this species yet — new uploads to gaylon.photos appear
          after the next
          <a href="/photos">gallery sync</a>.
        </p>
      {:else}
        <div class="strip">
          {#each data.photos as p (p.photo_id)}
            <a href={p.page_url} target="_blank" rel="noopener">
              <img loading="lazy" src={p.thumbnail} alt={data.taxon.com_name} />
            </a>
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  {#if data.forecastTeaser}
    {@const ft = data.forecastTeaser}
    <section class="card">
      <h2>
        Best time of year — {ft.regionName}
        <span class="muted">among loaded states</span>
        {#if ft.peakPhrase}
          <span class="muted">peaks {ft.peakPhrase}</span>
        {:else if ft.best}
          <span class="muted">peak {MONTH_NAMES[ft.best.month - 1]}</span>
        {/if}
        {#if ft.good.length > 1}
          <span class="muted">· good {formatMonthWindow(ft.good)}</span>
        {/if}
      </h2>
      <FrequencyChart
        months={ft.curve}
        highlightMonth={ft.best?.month ?? null}
        caption="Share of {ft.regionName} eBird checklists reporting {data.taxon
          .com_name}, by month"
      />
      <p class="muted">
        <a
          href="/forecast/species?species={data.taxon
            .species_code}&region={ft.regionCode}"
        >
          Where should I go? — county &amp; hotspot forecast →
        </a>
      </p>
    </section>
  {/if}

  <section class="card">
    <div class="card-head">
      <h2>
        Recent reports near {originName} — {windowPhrase(data.backDays)}
        {#if data.stale}<Badge kind="stale" label="cached" />{/if}
      </h2>
      <div class="unit-control">
        <span>Units</span>
        <DistanceUnitToggle bind:unit={distanceUnit} />
      </div>
    </div>
    {#if !data.hasApiKey || !data.hasOrigin}
      <p class="muted">
        {#if isViewer}
          Nearby reports aren't available on this account right now.
        {:else}
          Set your eBird API key and home location in <a href="/settings"
            >Settings</a
          > to see nearby reports.
        {/if}
      </p>
    {:else if data.nearbyError}
      <p class="muted">{data.nearbyError}</p>
    {:else if data.nearby.length === 0}
      <p class="muted">
        No reports within {formatDistance(data.distKm, distanceUnit)} in this window.
      </p>
    {:else}
      {#each data.nearby as o (o.locId + o.obsDt)}
        <div class="obs">
          <div class="grow">
            <div class="name">
              {#if o.isHotspot && o.locId}
                <a
                  class="place-link"
                  href={`https://ebird.org/hotspot/${o.locId}`}
                  target="_blank"
                  rel="noopener">{o.locName}</a
                >
                <a
                  class="hotspot-badge"
                  href={`https://ebird.org/hotspot/${o.locId}`}
                  target="_blank"
                  rel="noopener"
                  title="Verified eBird hotspot">eBird hotspot ↗</a
                >
              {:else}
                {o.locName}
              {/if}
            </div>
            <div class="meta">
              {o.howMany ?? 1}
              {(o.howMany ?? 1) === 1 ? "bird" : "birds"}
            </div>
            <MapLink
              lat={o.lat}
              lng={o.lng}
              name={o.locName}
              googlePlaceId={o.googlePlaceId}
            />
          </div>
          <div class="right">
            {#if o.distanceKm != null}<div class="dist">
                {formatDistance(o.distanceKm, distanceUnit)}
              </div>{/if}
            <div class="when">{o.obsDt}</div>
          </div>
        </div>
      {/each}
    {/if}
  </section>

  {#if en || data.isAdmin}
    <section class="card">
      <h2>
        About {data.taxon.com_name}
        {#if en?.iucn_status}
          <span class="iucn" title={IUCN_LABELS[en.iucn_status] ?? en.iucn_status}>
            {en.iucn_status} · {IUCN_LABELS[en.iucn_status] ?? "IUCN status"}
          </span>
        {/if}
      </h2>
      {#if form && "message" in form && form.message}
        <p class="ok">{form.message}</p>
      {/if}
      {#if form && "error" in form && form.error}
        <p class="err" role="alert">{form.error}</p>
      {/if}
      {#if hasFacts && (massBadge || wingspanBadge)}
        <p class="facts muted">
          {#if massBadge}Mass {massBadge}{/if}
          {#if massBadge && wingspanBadge}·{/if}
          {#if wingspanBadge}Wingspan {wingspanBadge}{/if}
        </p>
      {/if}
      {#if hasProse}
        {#if proseStale}
          <p class="muted">
            ⚠ The last refresh failed — showing the previously fetched
            article text.
          </p>
        {/if}
        <p class="lead" class:clamped={!aboutExpanded}>{en?.wikipedia_extract}</p>
        {#if !aboutExpanded}
          <button type="button" class="readmore" onclick={() => (aboutExpanded = true)}>
            Read more
          </button>
        {/if}
        {#each en?.wikipedia_sections ?? [] as s (s.title)}
          <details class="wiki-section">
            <summary>{s.title}</summary>
            <p class="section-text">{s.text}</p>
          </details>
        {/each}
        <p class="wiki-attrib muted">
          Wikipedia · CC BY-SA 4.0{#if retrievedOn}&nbsp;· retrieved {retrievedOn}{/if}
        </p>
        <details class="wiki-license">
          <summary>Source &amp; license</summary>
          <p class="muted">
            Text excerpted, sectioned, and length-capped from the Wikipedia
            article
            {#if revisionPermalink}
              <a href={revisionPermalink} target="_blank" rel="noopener"
                >"{en?.wikipedia_title}" (this revision)</a
              >{:else}"{en?.wikipedia_title}"{/if}
            {#if en?.wikipedia_url}
              ·
              <a href={en.wikipedia_url} target="_blank" rel="noopener"
                >current article</a
              >
            {/if}
            · licensed
            <a
              href="https://creativecommons.org/licenses/by-sa/4.0/"
              target="_blank"
              rel="noopener">CC BY-SA 4.0</a
            >{#if retrievedOn}&nbsp;· retrieved {retrievedOn}{/if}. Authors are
            credited via the revision history linked above.
          </p>
        </details>
      {:else if en}
        <p class="muted">
          No Wikipedia article for this species{en.resolution === "no_mapping"
            ? " (no Wikidata mapping)"
            : ""} — facts above come from Wikidata where available.
        </p>
      {:else}
        <p class="muted">No enrichment data fetched yet for this species.</p>
      {/if}
      {#if data.isAdmin}
        <form
          method="POST"
          action="?/refresh_enrichment"
          use:enhance={() => {
            refreshBusy = true;
            return async ({ update }) => {
              await update();
              refreshBusy = false;
            };
          }}
        >
          <button type="submit" class="secondary" disabled={refreshBusy}>
            {refreshBusy ? "Queuing…" : "↻ Refresh species data"}
          </button>
        </form>
      {/if}
    </section>
  {/if}

  <section class="card">
    <h2>Learn more</h2>
    {#each links as l (l.href)}
      <div class="obs">
        <div class="grow">
          <div class="name">
            <a href={l.href} target="_blank" rel="noopener">{l.label}</a>
          </div>
          <div class="meta">{l.sub}</div>
        </div>
      </div>
    {/each}
  </section>

  <p class="attribution">
    Data from <a href="https://ebird.org" target="_blank" rel="noopener"
      >eBird.org</a
    >
    · photos on
    <a href="https://gaylon.photos/birds" target="_blank" rel="noopener"
      >gaylon.photos</a
    >{#if hasProse}
      · species text from
      <a href="https://en.wikipedia.org" target="_blank" rel="noopener"
        >Wikipedia</a
      > (CC BY-SA 4.0){/if}
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
  code {
    font-size: 0.85em;
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
  /* --- About card (species enrichment) --- */
  .iucn {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    background: var(--seen-bg);
    color: var(--seen-text);
    vertical-align: middle;
  }
  .facts {
    margin-bottom: 8px;
  }
  .lead {
    white-space: pre-line;
    line-height: 1.5;
  }
  .lead.clamped {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    overflow: hidden;
  }
  .readmore {
    background: none;
    border: none;
    color: var(--accent);
    font-weight: 600;
    padding: 8px 0;
    min-height: 48px;
    cursor: pointer;
  }
  .wiki-section {
    border-top: 1px solid var(--border);
  }
  .wiki-section summary,
  .wiki-license summary {
    min-height: 48px;
    display: flex;
    align-items: center;
    cursor: pointer;
    font-weight: 600;
    list-style: none;
  }
  .wiki-section summary::-webkit-details-marker,
  .wiki-license summary::-webkit-details-marker {
    display: none;
  }
  .wiki-section summary::after,
  .wiki-license summary::after {
    content: "▸";
    margin-left: auto;
    color: var(--muted);
  }
  .wiki-section[open] summary::after,
  .wiki-license[open] summary::after {
    content: "▾";
  }
  .section-text {
    white-space: pre-line;
    line-height: 1.5;
    padding-bottom: 10px;
  }
  .wiki-attrib {
    margin-top: 10px;
    font-size: 0.78rem;
  }
  .wiki-license summary {
    font-weight: 400;
    color: var(--muted);
    font-size: 0.78rem;
  }
  .ok {
    color: var(--seen-text);
  }
  .err {
    color: var(--danger);
  }
  button.secondary {
    min-height: 48px;
    padding: 8px 16px;
    border-radius: 8px;
    background: var(--card);
    color: var(--accent);
    border: 1px solid var(--accent);
    font-weight: 600;
    margin-top: 10px;
  }
  button.secondary:disabled {
    opacity: 0.5;
  }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .card-head h2 {
    margin-bottom: 0;
  }
  .unit-control {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 0.83rem;
    font-weight: 600;
  }
  .card h2 .muted {
    font-weight: 400;
    font-size: 0.85rem;
  }
  .strip {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 4px;
  }
  .strip a {
    flex: 0 0 auto;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--border);
  }
  .strip img {
    display: block;
    height: 110px;
    width: auto;
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
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    font-weight: 700;
  }
  .place-link {
    color: var(--text);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }
  .hotspot-badge {
    background: #e8f2ff;
    border: 1px solid #bfd8ff;
    border-radius: 999px;
    color: #165c9f;
    font-size: 0.68rem;
    font-weight: 800;
    letter-spacing: 0.02em;
    padding: 2px 7px;
    text-decoration: none;
    text-transform: uppercase;
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
