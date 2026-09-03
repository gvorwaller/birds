<script lang="ts">
  import Badge from "$components/Badge.svelte";
  import DistanceUnitToggle from "$components/DistanceUnitToggle.svelte";
  import FrequencyChart from "$components/FrequencyChart.svelte";
  import MigrationRibbon, {
    type RibbonRegionRowClient,
  } from "$components/MigrationRibbon.svelte";
  import { formatMonthWindow } from "$lib/forecast-calendar";
  import MapLink from "$components/MapLink.svelte";
  import { formatDistance, type DistanceUnit } from "$lib/geo";
  import { isHotspotLocId } from "$lib/loc-id";
  import { page } from "$app/state";
  import { windowPhrase } from "$lib/time-windows";
  import { enhance } from "$app/forms";
  import { jobsPoll } from "$lib/job-poll.svelte";
  import { tick } from "svelte";
  import { browser } from "$app/environment";
  import { sectionBlocks } from "$lib/wiki-render";
  import { groupTags, dimensionLabel, tagLabel } from "$lib/species-tags";
  import { allAboutBirdsUrl } from "$lib/species-links";
  import { formatFeet, tideWord, TIDE_ATTRIBUTION_URL } from "$lib/tide-format";
  import type { TideResult } from "$lib/tide-format";
  import Skeleton from "$components/Skeleton.svelte";
  import SpeciesMediaCard from "$components/SpeciesMediaCard.svelte";
  import SimilarSpeciesCard from "$components/SimilarSpeciesCard.svelte";
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

  /**
   * Forecast drill for this species in one region, carrying THIS page's full
   * URL as returnTo — the forecast page turns that into a breadcrumb back to
   * the bird and, one level further, to the list this page was opened from
   * (Gaylon 2026-08-29: the drill was a dead end otherwise).
   */
  /**
   * Similar-species links point BACK HERE (td-57822b). The card used to be
   * handed THIS page's own back link, so tapping a look-alike skipped past
   * the very bird you were comparing it against — a dead end.
   *
   * The nested returnTo is stripped so an A -> B -> C chain cannot accumulate
   * an unbounded URL: every hop keeps its location context (lat/lng/dist/loc,
   * back) and gets exactly one level of "back to the bird", which is what the
   * comparison actually needs.
   */
  const similarReturnTo = $derived.by(() => {
    const p = new URLSearchParams(page.url.searchParams);
    p.delete("returnTo");
    const qs = p.toString();
    return page.url.pathname + (qs ? `?${qs}` : "");
  });

  // --- Streamed sections (plan Phase 9) -----------------------------------
  // Each streamed promise's LAST RESOLVED value is held per species and only
  // swapped when the new promise settles, so a jobsPoll invalidateAll() (or
  // any same-page reload) never blanks a populated section back to its
  // skeleton (AGY review). Navigating to a different species resets to the
  // skeleton via the derived species-code check.
  type StreamedResult<T> = { ok: true; data: T } | { ok: false; error: string };
  function retained<T>(get: () => Promise<StreamedResult<T>> | null) {
    let view = $state<{ code: string; res: StreamedResult<T> } | null>(null);
    $effect(() => {
      const code = data.taxon.species_code;
      const p = get();
      if (!p) return;
      let alive = true;
      void p.then((res) => {
        if (alive) view = { code, res };
      });
      return () => {
        alive = false;
      };
    });
    return {
      get current() {
        return view?.code === data.taxon.species_code ? view.res : null;
      },
    };
  }
  const nearbyView = retained(() => data.nearby);
  const nearestView = retained(() => data.nearest);
  // Tide never rejects (server contract) — wrap to the same shape.
  const tideView = retained<TideResult | null>(() =>
    data.tide.then((t) => ({ ok: true as const, data: t })),
  );

  // --- Best-time-of-year peers (plan Phase 5) -----------------------------
  // Selection is client-side only: every peer carries its own curve, so
  // switching tabs re-renders the chart with no round trip.
  type PeerRow = NonNullable<PageData["forecastTeaser"]>["peers"][number];
  /** A region tapped in the migration ribbon's drill panel becomes a third,
   * client-only peer tab here (build spec td-59c2d0 TD-C, CODEX1 P1-4) —
   * never sent to the server, reset whenever the species changes. */
  type CardPeer = Omit<PeerRow, "kind"> & { kind: PeerRow["kind"] | "chart" };
  let selectedTeaserCode = $state<string | null>(null);
  let chartPeer = $state<CardPeer | null>(null);
  $effect(() => {
    // Reset to the server's default when navigating between species.
    selectedTeaserCode = data.forecastTeaser?.defaultLocCode ?? null;
    chartPeer = null;
  });
  // Every `ft.` dereference the old single-teaser card made becomes a read
  // of this list (or an `ft?.` fallback on `selectedPeer`) so the card still
  // renders when there is no server teaser at all but the ribbon's drill
  // supplied a chart peer (CODEX1 P1-4).
  const cardPeers = $derived<CardPeer[]>(
    chartPeer &&
      !(data.forecastTeaser?.peers ?? []).some((p) => p.locCode === chartPeer!.locCode)
      ? [...(data.forecastTeaser?.peers ?? []), chartPeer]
      : (data.forecastTeaser?.peers ?? []),
  );
  const selectedPeer = $derived(
    cardPeers.find((p) => p.locCode === selectedTeaserCode) ?? cardPeers[0] ?? null,
  );
  function peerKindLabel(
    kind: "closest" | "best" | "both" | "chart",
    poolSize: number,
  ): string {
    // "Best of N loaded regions": the qualifier lives in the label itself —
    // an unqualified "Best overall" across N-of-the-world regions is a false
    // claim (937bdb8 lesson; AGY review).
    if (kind === "closest") return "Closest with sightings";
    if (kind === "chart") return "From the chart";
    if (kind === "best")
      return poolSize === 1
        ? "Only loaded region with sightings"
        : `Best of ${poolSize} loaded regions`;
    return poolSize === 1
      ? "Only loaded region with sightings"
      : `Closest and best of ${poolSize} loaded regions`;
  }
  function onPeerTabKeydown(e: KeyboardEvent) {
    // Arrow-key navigation with roving tabindex (ARIA tabs pattern).
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const peers = cardPeers;
    if (peers.length < 2) return;
    e.preventDefault();
    const i = peers.findIndex((p) => p.locCode === selectedTeaserCode);
    const next =
      peers[(i + (e.key === "ArrowRight" ? 1 : peers.length - 1)) % peers.length];
    selectedTeaserCode = next.locCode;
    document.getElementById(`peer-tab-${next.locCode}`)?.focus();
  }

  // Local to this page (build spec td-59c2d0 TD-C) — nothing named `reduced`
  // exists here; the ribbon component samples its own copy independently.
  const reducedMotion = $derived(
    browser && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  /** A region tapped in the migration ribbon's drill panel (build spec TD-C):
   * build a third "From the chart" peer, select it, and scroll the
   * Best-time-of-year card into view. `tick()` first because the card may
   * not exist yet — with no server teaser at all, `chartPeer` is what makes
   * it render (CODEX1 P1-4). */
  async function onChartRegion(r: RibbonRegionRowClient) {
    chartPeer = {
      kind: "chart",
      locCode: r.locCode,
      containsHome: false,
      label: r.label,
      distanceKm: null,
      curve: r.curve,
      weeks: r.weeks,
      migration: r.migration,
      best: r.best,
      peakPhrase: r.peakPhrase,
      good: r.good,
    };
    selectedTeaserCode = r.locCode;
    await tick();
    document
      .getElementById("besth")
      ?.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
  }

  function forecastHref(regionCode: string): string {
    const params = new URLSearchParams({
      species: data.taxon.species_code,
      region: regionCode,
      returnTo: page.url.pathname + page.url.search,
    });
    return `/forecast/species?${params.toString()}`;
  }

  // GROK P2-1/P2-2: keep the whole current query (location context, back —
  // whose default here is 14, not 7 — returnTo) and only add nearest=1.
  const nearestHref = $derived.by(() => {
    const p = new URLSearchParams(page.url.searchParams);
    p.set("nearest", "1");
    return `?${p.toString()}`;
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
  // "Finding this bird" (Phase 2): render only when AI content exists —
  // never an empty shell (GROK contract). The single refresh button lives
  // here when the card exists, on About otherwise.
  const hasFieldCraft = $derived(!!en?.field_craft);
  // Field-guide sample media (td-86a2b6 §11b).
  const hasMedia = $derived(
    data.sampleMedia.photo != null || data.sampleMedia.sounds.length > 0,
  );
  const tagGroups = $derived(groupTags(en?.tags ?? []));
  const aiGeneratedOn = $derived(
    en?.ai_generated_at
      ? new Date(en.ai_generated_at).toLocaleDateString()
      : null,
  );
  const hasFacts = $derived(
    !!en &&
      (en.iucn_status != null || massBadge != null || wingspanBadge != null),
  );
  // Attribution date = when the STORED prose was successfully retrieved —
  // never the failed-attempt clock (CODEX1 round 3).
  const retrievedOn = $derived(
    en?.wiki_ok_at ? new Date(en.wiki_ok_at).toLocaleDateString() : null,
  );
  // Read more only when the clamp actually hides content (GROK).
  let leadEl = $state<HTMLElement | null>(null);
  let leadOverflows = $state(false);
  $effect(() => {
    void en?.wikipedia_extract;
    if (leadEl && !aboutExpanded) {
      leadOverflows = leadEl.scrollHeight > leadEl.clientHeight + 2;
    }
  });
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
      // Cornell slugs strip punctuation — "Anna's" → Annas (td-09fdc0).
      href: allAboutBirdsUrl(data.taxon.com_name),
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

  {#if hasMedia || data.sampleMedia.audioStatus === "restricted" || (data.isAdmin && data.sampleMedia.status != null)}
    <SpeciesMediaCard
      media={data.sampleMedia}
      comName={data.taxon.com_name}
      isAdmin={data.isAdmin}
    />
  {/if}

  <SimilarSpeciesCard
    similar={data.similar.similar}
    unresolved={data.similar.unresolved}
    inatStatus={data.similar.inatStatus}
    backDays={data.backDays}
    returnTo={similarReturnTo}
    context={data.locationContext}
  />

  {#if hasFieldCraft}
    <section class="card">
      <h2>Finding this bird</h2>
      {#if form && "message" in form && form.message}
        <p class="ok" role="status">{form.message}</p>
      {/if}
      {#if form && "error" in form && form.error}
        <p class="err" role="alert">{form.error}</p>
      {/if}
      <p class="fieldcraft">{en?.field_craft}</p>
      {#if tagGroups.length > 0}
        <div class="taggroups">
          {#each tagGroups as g (g.dimension)}
            <div class="taggroup">
              <span class="tagdim muted">{dimensionLabel(g.dimension)}</span>
              <span class="tagchips">
                {#each g.values as v (v)}
                  <span class="tag" class:tag-tide={g.dimension === "tide"}>
                    {tagLabel(g.dimension, v)}
                  </span>
                {/each}
              </span>
            </div>
          {/each}
        </div>
      {/if}
      {#if tideView.current?.ok && tideView.current.data}
        {@const t = tideView.current.data}
        <div class="tideline">
          <span class="tidehead"
            >🌊 Tide at {t.station.name}
            {#if t.stale}<Badge kind="stale" label="cached" />{/if}</span
          >
          <span class="tidetimes">
            {#if t.mode === "next"}
              {#if t.nextHigh}<span class="tideitem">{t.nextHigh.phrase}</span
                >{/if}
              {#if t.nextLow}<span class="tideitem">{t.nextLow.phrase}</span
                >{/if}
            {:else}
              {#each t.day as e, i (e.at + i)}
                <span class="tideitem"
                  >{tideWord(e.type)}
                  {e.timeLabel}&nbsp;({formatFeet(e.feetMllw)})</span
                >
              {/each}
            {/if}
          </span>
          <span class="tidestation"
            >{formatDistance(t.station.distanceKm, distanceUnit)} from {originName}
            · NOAA CO-OPS predictions, MLLW</span
          >
        </div>
      {/if}
      <p class="ai-attrib muted">
        AI-generated from the Wikipedia article{#if aiGeneratedOn}&nbsp;·
          {aiGeneratedOn}{/if} · verify in the field
        {#if tideView.current?.ok && tideView.current.data}
          · <a href={TIDE_ATTRIBUTION_URL} target="_blank" rel="noopener"
            >Tides: NOAA CO-OPS</a
          >
        {/if}
        ·
        <a href="/species">Browse field guide →</a>
      </p>
      {#if data.isAdmin}
        <form
          method="POST"
          action="?/refresh_enrichment"
          use:enhance={() => {
            refreshBusy = true;
            return async ({ update }) => {
              try {
                await update();
              } finally {
                refreshBusy = false;
              }
            };
          }}
          aria-busy={refreshBusy}
        >
          <button type="submit" class="secondary" disabled={refreshBusy}>
            {refreshBusy ? "Refreshing…" : "↻ Refresh species data"}
          </button>
        </form>
      {/if}
    </section>
  {/if}

  <!-- Migration ribbon (build spec td-59c2d0 TD-C): a discriminated loader
       result, never rendered as plain absence (CODEX1 P2-10) — `ok, grid:
       null` (nothing loaded yet) renders nothing, `ok: false` renders a
       one-line failure, and only `ok, grid` renders the chart. -->
  {#if data.ribbon.ok && data.ribbon.grid}
    <section class="card" aria-labelledby="ribh">
      <h2 id="ribh">Where it is through the year</h2>
      <MigrationRibbon
        grid={data.ribbon.grid}
        speciesCode={data.taxon.species_code}
        speciesName={data.taxon.com_name}
        onchartregion={onChartRegion}
      />
    </section>
  {:else if !data.ribbon.ok}
    <section class="card">
      <h2>Where it is through the year</h2>
      <p class="muted">The migration chart could not be loaded.</p>
    </section>
  {/if}

  {#if selectedPeer}
    {@const ft = data.forecastTeaser}
    <section class="card">
      <h2 id="besth">Best time of year</h2>
      <!-- Both picks as equal peers (plan Phase 5; AGY: a TABLIST, not a
           radiogroup — this selects which region's data a panel displays).
           The honesty qualifier lives IN the row label ("Best of N loaded
           regions"), where the claim is made (937bdb8 lesson). A region
           tapped in the migration ribbon's drill panel becomes a third
           "From the chart" tab (build spec td-59c2d0 TD-C, CODEX1 P1-4) —
           `cardPeers`/`ft?.` everywhere the card used to assume a server
           teaser existed. -->
      {#if cardPeers.length > 1}
        <div class="peer-tabs" role="tablist" aria-label="Region to chart">
          {#each cardPeers as peer (peer.locCode)}
            {@const active = peer.locCode === selectedTeaserCode}
            <button
              type="button"
              role="tab"
              id="peer-tab-{peer.locCode}"
              aria-selected={active}
              aria-controls="teaser-panel"
              tabindex={active ? 0 : -1}
              class:active
              onclick={() => (selectedTeaserCode = peer.locCode)}
              onkeydown={onPeerTabKeydown}
            >
              <span class="peer-kind">{peerKindLabel(peer.kind, ft?.poolSize ?? 0)}</span>
              <span class="peer-name">{peer.label}</span>
              <span class="peer-meta">
                {#if peer.containsHome}
                  you're here
                {:else if peer.kind === "closest" && peer.distanceKm != null}
                  ~{formatDistance(peer.distanceKm, distanceUnit)} to its edge
                {:else if peer.peakPhrase}
                  peaks {peer.peakPhrase}
                {:else if peer.best}
                  peak {MONTH_NAMES[peer.best.month - 1]}
                {/if}
              </span>
            </button>
          {/each}
        </div>
      {:else}
        <p class="peer-single">
          <strong>{peerKindLabel(selectedPeer.kind, ft?.poolSize ?? 0)}</strong>
          — {selectedPeer.label}
          {#if selectedPeer.containsHome}
            <span class="muted">· you're here</span>
          {:else if selectedPeer.distanceKm != null}
            <span class="muted"
              >· ~{formatDistance(selectedPeer.distanceKm, distanceUnit)} to its
              edge</span
            >
          {/if}
        </p>
        {#if ft && !ft.hasOrigin}
          <p class="muted">
            Set a home location in <a href="/settings">Settings</a> to see the
            closest region with sightings.
          </p>
        {/if}
      {/if}
      <!-- What the numbers mean (Gaylon 2026-08-31): these are WHOLE-REGION
           figures — a distance to a state's edge, and a frequency averaged
           over all of it. The county/hotspot drill is the precision path. -->
      <p class="peer-scope muted">
        Whole-region figures — distances are to the region itself, and
        frequencies average all of it.
      </p>
      <!-- The chart, its caption, AND the "Where should I go?" link live
           inside the tabpanel: the link target follows the selection, and
           outside aria-controls a screen-reader user would never be told it
           changed (AGY review). -->
      <div
        id="teaser-panel"
        role={cardPeers.length > 1 ? "tabpanel" : null}
        aria-labelledby={cardPeers.length > 1
          ? `peer-tab-${selectedTeaserCode}`
          : null}
      >
        <p class="muted peer-season">
          {#if selectedPeer.peakPhrase}
            peaks {selectedPeer.peakPhrase}
          {:else if selectedPeer.best}
            peak {MONTH_NAMES[selectedPeer.best.month - 1]}
          {:else}
            not reported in any month
          {/if}
          {#if selectedPeer.good.length > 1}
            · good {formatMonthWindow(selectedPeer.good)}
          {/if}
        </p>
        <FrequencyChart
          weeks={selectedPeer.weeks}
          months={selectedPeer.curve}
          highlightMonth={selectedPeer.best?.month ?? null}
          caption="Share of {selectedPeer.label} eBird checklists reporting {data
            .taxon.com_name}, by month"
        />
        {#if selectedPeer.migration}
          <p class="migration">🛫 {selectedPeer.migration}</p>
        {/if}
        <p class="muted">
          <a href={forecastHref(selectedPeer.locCode)}>
            Where should I go? — county &amp; hotspot forecast →
          </a>
        </p>
      </div>
    </section>
  {/if}

  <section class="card">
    <div class="card-head">
      <h2>
        Recent reports near {originName} — {windowPhrase(data.backDays)}
        {#if nearbyView.current?.ok && nearbyView.current.data.stale}<Badge
            kind="stale"
            label="cached"
          />{/if}
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
    {:else if nearbyView.current == null}
      <!-- Streamed (Phase 9): reserved height so settling never shifts the
           cards below (AGY P1 — the min-height IS the point). -->
      <Skeleton minHeight="220px" label="Checking recent reports…" />
    {:else if !nearbyView.current.ok}
      <p class="muted">{nearbyView.current.error}</p>
    {:else if nearbyView.current.data.rows.length === 0}
      <p class="muted">
        No reports within {formatDistance(data.distKm, distanceUnit)} in this window.
      </p>
    {:else}
      {#each nearbyView.current.data.rows as o (o.locId + o.obsDt)}
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
              {#if !o.obsValid}<span class="unconf">Unconfirmed</span>{/if}
              {#if o.locationPrivate}<span
                  class="privloc"
                  title="Reported from someone's personal (non-hotspot) location"
                  >personal location</span
                >{/if}
              {#if o.subId}
                <a
                  class="cl"
                  href={`https://ebird.org/checklist/${o.subId}`}
                  target="_blank"
                  rel="noopener">checklist ↗</a
                >
              {/if}
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

  {#if !data.seen && data.hasApiKey && data.hasHome}
    <!-- Nearest lifer (td-a6c322): ON-DEMAND — the ?nearest=1 link makes it
         an SSR fetch the default page load never pays for (GROK pin). Need
         species only; unbounded distance from the saved home. -->
    <section class="card">
      <h2>
        Nearest reports — any distance
        {#if nearestView.current?.ok && nearestView.current.data.stale}<Badge
            kind="stale"
            label="cached"
          />{/if}
      </h2>
      {#if !data.wantNearest || data.nearest == null}
        <p class="muted">
          How far away is the closest current report? Any distance from home.
        </p>
        <!-- Preserve every existing param (location context, back, returnTo)
             — a bare ?nearest=1 clobbered the query and silently retargeted
             the nearby card to home (GROK P2-1/P2-2). -->
        <a class="nearestcta" href={nearestHref} data-sveltekit-noscroll
          >Check nearest reports</a
        >
      {:else if nearestView.current == null}
        <Skeleton minHeight="140px" label="Checking nearest reports…" />
      {:else if !nearestView.current.ok}
        <p class="muted">{nearestView.current.error}</p>
      {:else if nearestView.current.data.rows.length === 0}
        {#if nearestView.current.data.via === "nearest"}
          <!-- eBird's own global lookup answered, and answered empty. -->
          <p class="muted">
            No reports anywhere in the last {data.backDays} days.
          </p>
        {:else}
          <!-- The region search cannot see everywhere: our seeded coverage has
               holes (regions eBird never geocoded, antimeridian regions with no
               usable bound), and a capped search stopped early. Saying "nowhere"
               would claim a search we did not run. -->
          <p class="muted">
            No reports in the {nearestView.current.data.searched.regions} regions
            searched.
            <a
              href="https://ebird.org/map/{data.taxon.species_code}"
              target="_blank"
              rel="noopener">See this species' map on eBird ↗</a
            >
          </p>
        {/if}
      {:else}
        {#each nearestView.current.data.rows as o (o.locId + o.obsDt)}
          <div class="nrow">
            <div class="nline1">
              {#if o.distanceKm != null}
                <span class="ndist"
                  >{formatDistance(o.distanceKm, distanceUnit)}</span
                >
              {/if}
              {#if isHotspotLocId(o.locId)}
                <!-- returnTo carries the full URL so Back reopens the card
                     with its context intact (GROK P3 on 3b12042). -->
                <a
                  class="nplace"
                  href={`/hotspots/${o.locId}?returnTo=${encodeURIComponent(page.url.pathname + page.url.search)}`}
                  >{o.locName}</a
                >
              {:else}
                <span class="nplace">{o.locName}</span>
                {#if o.locationPrivate}<span class="privloc"
                    >personal location</span
                  >{/if}
              {/if}
            </div>
            <div class="nline2">
              <span class="muted">{o.obsDt}</span>
              {#if o.howMany != null && o.howMany > 1}<span class="muted"
                  >×{o.howMany}</span
                >{/if}
              {#if !o.obsValid}<span class="unconf">Unconfirmed</span>{/if}
              <MapLink
                lat={o.lat}
                lng={o.lng}
                name={o.locName}
                googlePlaceId={o.googlePlaceId}
              />
              {#if o.subId}
                <a
                  class="cl"
                  href={`https://ebird.org/checklist/${o.subId}`}
                  target="_blank"
                  rel="noopener">checklist ↗</a
                >
              {/if}
            </div>
          </div>
        {/each}
      {/if}
      <!-- How the answer was reached, when that changes what it means. The
           direct lookup covers eBird's whole database; the region search covers
           the regions we hold, so it must say so rather than let the heading's
           "any distance" imply more than it proved. -->
      {#if nearestView.current?.ok && nearestView.current.data.via === "ladder"}
        <p class="muted nvia">
          {#if nearestView.current.data.rows.length > 0}
            Found by searching {nearestView.current.data.searched.regions} regions
            outward from home.
          {/if}
          {#if !nearestView.current.data.proven}
            Some closer regions couldn't be checked.
          {/if}
        </p>
      {/if}
    </section>
  {/if}

  {#if data.taxon.category === "species"}
    <section class="card">
      <h2>
        About {data.taxon.com_name}
        {#if en?.iucn_status}
          <span
            class="iucn s-{en.iucn_status.toLowerCase()}"
            title={IUCN_LABELS[en.iucn_status] ?? en.iucn_status}
          >
            {en.iucn_status} · {IUCN_LABELS[en.iucn_status] ?? "IUCN status"}
          </span>
        {/if}
      </h2>
      <!-- Refresh flash lives with the refresh button: here only when the
           Finding card (which owns the button then) doesn't exist (GROK). -->
      {#if !hasFieldCraft}
        {#if form && "message" in form && form.message}
          <p class="ok" role="status">{form.message}</p>
        {/if}
        {#if form && "error" in form && form.error}
          <p class="err" role="alert">{form.error}</p>
        {/if}
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
            ⚠ The last refresh failed — showing the previously fetched article
            text.
          </p>
        {/if}
        <p bind:this={leadEl} class="lead" class:clamped={!aboutExpanded}>
          {en?.wikipedia_extract}
        </p>
        {#if aboutExpanded || leadOverflows}
          <button
            type="button"
            class="readmore"
            aria-expanded={aboutExpanded}
            onclick={() => (aboutExpanded = !aboutExpanded)}
          >
            {aboutExpanded ? "Show less" : "Read more"}
          </button>
        {/if}
        {#each en?.wikipedia_sections ?? [] as s (s.title)}
          <details class="wiki-section">
            <summary>{s.title}</summary>
            <div class="section-text">
              {#each sectionBlocks(s.text) as block, i (i)}
                {#if block.kind === "sub"}
                  <p class="subhead">{block.text}</p>
                {:else}
                  <p>{block.text}</p>
                {/if}
              {/each}
            </div>
          </details>
        {/each}
        {#if en?.resolution === "no_sitelink" && en?.wiki_status === "ok"}
          <!-- Binomial-redirect fallback (GROK pin b): honest label when the
               article came via the scientific name, not a Wikidata sitelink. -->
          <p class="muted">
            Wikipedia has no sitelink for this taxon — showing "{en.wikipedia_title}".
          </p>
        {/if}
        <p class="wiki-attrib muted">
          Wikipedia · CC BY-SA 4.0{#if retrievedOn}&nbsp;· retrieved {retrievedOn}{/if}{#if !hasFieldCraft}
            · <a href="/species">Browse field guide →</a>{/if}
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
      {:else if en?.wiki_fetched_at}
        <p class="muted">
          No Wikipedia article for this species{en.resolution === "no_mapping"
            ? " (no Wikidata mapping)"
            : ""}{hasFacts ? " — facts above come from Wikidata." : "."}
          <a href="/species">Browse field guide →</a>
        </p>
      {:else}
        <p class="muted">Wikipedia notes haven't been loaded yet.</p>
        <form
          method="POST"
          action="?/load_enrichment"
          use:enhance={() => {
            refreshBusy = true;
            return async ({ update }) => {
              try {
                await update();
              } finally {
                refreshBusy = false;
              }
            };
          }}
          aria-busy={refreshBusy}
        >
          <button type="submit" class="secondary" disabled={refreshBusy}>
            {refreshBusy
              ? "Loading… this can take up to 20 seconds"
              : "Load Wikipedia notes"}
          </button>
        </form>
        <p class="muted" style="margin-top:6px;font-size:0.78rem">
          Adds Wikipedia notes to the shared field guide. Your sightings won't
          change.
        </p>
      {/if}
      {#if data.isAdmin && en?.wiki_fetched_at && !hasFieldCraft}
        <form
          method="POST"
          action="?/refresh_enrichment"
          use:enhance={() => {
            refreshBusy = true;
            return async ({ update }) => {
              try {
                await update();
              } finally {
                refreshBusy = false;
              }
            };
          }}
          aria-busy={refreshBusy}
        >
          <button type="submit" class="secondary" disabled={refreshBusy}>
            {refreshBusy ? "Refreshing…" : "↻ Refresh species data"}
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
      > (CC BY-SA 4.0){/if}{#if hasMedia}
      · sample media from
      <a href="https://commons.wikimedia.org" target="_blank" rel="noopener"
        >Wikimedia Commons</a
      >
      and
      <a href="https://xeno-canto.org" target="_blank" rel="noopener"
        >xeno-canto</a
      >{/if}
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
  /* Best-time-of-year peer tabs (Phase 5). Selection is colour AND border
     AND aria-selected — never colour alone (cs.md). ≥48px tap targets. */
  .peer-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 4px 0 10px;
  }
  .peer-tabs [role="tab"] {
    flex: 1 1 240px;
    min-height: 48px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 8px 12px;
    border: 2px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .peer-tabs [role="tab"].active {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .peer-kind {
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--muted);
  }
  .peer-tabs [role="tab"].active .peer-kind {
    color: var(--accent);
  }
  .peer-name {
    font-weight: 600;
  }
  .peer-meta {
    font-size: 0.85rem;
    color: var(--muted);
  }
  .peer-single {
    margin: 4px 0 6px;
  }
  .peer-season {
    margin: 0 0 6px;
  }
  .peer-scope {
    margin: 0 0 8px;
    font-size: 0.85rem;
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
    vertical-align: middle;
    /* Unknown/unmapped statuses fall back to neutral, never all-clear. */
    background: #e9ecef;
    color: #343a40;
  }
  /* Per-status tokens (GROK P1: EN in seen-green read as all-clear) —
     color + text, AAA-contrast pairs, escalating warmth with threat. */
  .iucn.s-lc {
    background: #d8ecd9;
    color: #1e4620;
  }
  .iucn.s-nt {
    background: #e8ecc9;
    color: #4a4d1d;
  }
  .iucn.s-vu {
    background: #fde8c8;
    color: #724200; /* ≥7:1 on this bg (GROK-measured AAA floor) */
  }
  .iucn.s-en {
    background: #fcd9cc;
    color: #842607;
  }
  .iucn.s-cr {
    background: #f8d0d4;
    color: #880e1a;
  }
  .iucn.s-ew,
  .iucn.s-ex {
    background: #43464a;
    color: #f4f5f6;
  }
  .iucn.s-dd {
    background: #e9ecef;
    color: #343a40;
  }
  .facts {
    margin-bottom: 8px;
  }
  /* --- Finding this bird (Phase 2) --- */
  .fieldcraft {
    line-height: 1.55;
    margin-bottom: 12px;
  }
  .taggroups {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 10px;
  }
  .taggroup {
    display: flex;
    gap: 10px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .tagdim {
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    min-width: 84px;
    white-space: nowrap; /* "TIME OF DAY" must not wrap at 320px (GROK) */
  }
  .tagchips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    padding: 4px 12px;
    min-height: 32px;
    border-radius: 16px;
    font-size: 0.82rem;
    font-weight: 600;
    background: #e9f1ec;
    color: #1d4a35;
    border: 1px solid #c4d9cd;
  }
  /* Tide chips: distinct token + the word "Tide" in the label (color+text,
     never color alone) — the td-47d6d5 payload. */
  .tag.tag-tide {
    background: #dcebf7;
    color: #163e5e;
    border: 1px solid #b3d1e8;
  }
  /* Tide line (td-6a3d2e) — same tokens as .tag-tide (#dcebf7 bg / #163e5e
     text = 9.16:1, AAA). Do NOT use .muted here: var(--muted) on #dcebf7 is
     not guaranteed to hit 7:1. */
  .tideline {
    margin-top: 6px;
    margin-bottom: 10px;
    padding: 8px 10px;
    background: #dcebf7;
    border-left: 3px solid #163e5e;
    border-radius: 6px;
    font-size: 0.85rem;
    color: #163e5e;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tidehead {
    font-weight: 700;
  }
  .tidetimes {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
  }
  .tidestation {
    font-size: 0.76rem;
  }
  .ai-attrib {
    font-size: 0.78rem;
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
  /* Visible affordance (GROK: hidden marker + muted ::after read as static
     headings) — accent-colored chevron, clearly a control. */
  .wiki-section summary::after,
  .wiki-license summary::after {
    content: "▸";
    margin-left: auto;
    padding-left: 12px;
    color: var(--accent);
    font-size: 1.1em;
  }
  .wiki-section[open] summary::after,
  .wiki-license[open] summary::after {
    content: "▾";
  }
  .section-text {
    line-height: 1.5;
    padding-bottom: 10px;
  }
  .section-text p {
    margin: 0 0 10px;
  }
  .section-text .subhead {
    font-weight: 700;
    font-size: 0.92rem;
    margin: 12px 0 6px;
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
    color: var(--muted);
    border-color: var(--muted);
    cursor: not-allowed;
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
  /* Tier-1 (td-97b22e): fields that always crossed the wire, now shown. */
  .unconf {
    padding: 1px 8px;
    border-radius: 6px;
    font-size: 0.72rem;
    font-weight: 700;
    background: #fde8c8;
    color: #5f3700; /* 8.7:1 AAA (hotspot-page precedent) */
  }
  .privloc {
    color: var(--muted);
    font-size: 0.78rem;
    font-style: italic;
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
  /* Nearest lifer rows: distance is the hero (AGY layout, GROK-pinned). */
  .nearestcta {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    padding: 10px 18px;
    border: 1px solid var(--accent);
    border-radius: 8px;
    color: var(--accent);
    font-weight: 700;
    text-decoration: none;
  }
  .nrow {
    padding: 6px 0;
  }
  .nvia {
    margin-top: 8px;
    font-size: 0.82rem;
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
  .migration {
    color: var(--text);
    font-weight: 600;
    font-size: 0.92rem;
    margin: 8px 0 0;
  }
</style>
