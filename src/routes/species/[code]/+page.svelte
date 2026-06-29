<script lang="ts">
  import Badge from "$components/Badge.svelte";
  import MapLink from "$components/MapLink.svelte";
  import { formatKm } from "$lib/geo";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

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
      href: `https://xeno-canto.org/explore?query=${encodeURIComponent(data.taxon.sci_name)}`,
    },
    {
      label: "iNaturalist ↗",
      sub: "observations & range",
      href: `https://www.inaturalist.org/taxa/search?q=${encodeURIComponent(data.taxon.sci_name)}`,
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

  <section class="card">
    <h2>
      Recent reports near home — last {data.backDays} days
      {#if data.stale}<Badge kind="stale" label="cached" />{/if}
    </h2>
    {#if !data.hasApiKey || !data.hasHome}
      <p class="muted">
        Set your eBird API key and home location in <a href="/settings"
          >Settings</a
        > to see nearby reports.
      </p>
    {:else if data.nearbyError}
      <p class="muted">{data.nearbyError}</p>
    {:else if data.nearby.length === 0}
      <p class="muted">No reports within {data.distKm} km in this window.</p>
    {:else}
      {#each data.nearby as o (o.locId + o.obsDt)}
        <div class="obs">
          <div class="grow">
            <div class="name">{o.locName}</div>
            <div class="meta">
              {o.howMany ?? 1}
              {(o.howMany ?? 1) === 1 ? "bird" : "birds"}
            </div>
            <MapLink lat={o.lat} lng={o.lng} name={o.locName} />
          </div>
          <div class="right">
            {#if o.distanceKm != null}<div class="dist">
                {formatKm(o.distanceKm)}
              </div>{/if}
            <div class="when">{o.obsDt}</div>
          </div>
        </div>
      {/each}
    {/if}
  </section>

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
    font-weight: 700;
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
