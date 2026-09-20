<script lang="ts">
  import Badge from "$components/Badge.svelte";
  import ViewedBadge from "$components/ViewedBadge.svelte";
  import { tagLabel, type TagDimension } from "$lib/species-tags";
  import type { SpeciesView } from "$lib/species-views";
  import type { GuideResult } from "$server/species-enrichment";

  /**
   * The shared Field Guide species row (Phase 9A, td-f02bf7): the first adopter
   * of one information hierarchy. Every Field Guide result, including the
   * country/region/county/hotspot/map results from Phase 8A, renders through it.
   *
   * Order, top to bottom / left to right:
   *   1. reference thumbnail, or the honest unavailable state;
   *   2. common and scientific names;
   *   3. Seen/Need, then other personal badges (Special interest, Viewed);
   *   4. evidence/meaning: banding-code and text-match provenance, family,
   *      conservation status, tags and the short field note;
   *   5. the stable `guide-species-{code}` row target and the complete return URL
   *      (the caller supplies `href`, already carrying the source query).
   * Photo credit sits directly below the row. A missing or failed thumbnail is
   * labelled, never an empty broken image, and never removes the row.
   */
  let {
    row,
    href,
    onclick,
    selectedTags,
    interest = false,
    viewed,
  }: {
    row: GuideResult;
    href: string;
    onclick?: (event: MouseEvent) => void;
    selectedTags: ReadonlySet<string>;
    /** The SIGNED-IN account's own Special-interest state. */
    interest?: boolean;
    /** The SIGNED-IN account's own viewing history. */
    viewed?: SpeciesView;
  } = $props();

  // A failed thumbnail is remembered by URL, so a different photo is tried afresh.
  let brokenUrl = $state<string | null>(null);
  const broken = $derived(row.photo != null && brokenUrl === row.photo.url);

  function checkThumbnail(image: HTMLImageElement) {
    // An SSR image may fail before hydration installs its error handler.
    if (image.complete && image.naturalWidth === 0 && row.photo) brokenUrl = row.photo.url;
  }

  // Tier-1 (td-97b22e): every result row SHIPS its tags + IUCN status —
  // the user just filtered by tags and the rows didn't show them.
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
  function chipText(tag: string): string {
    const i = tag.indexOf(":");
    if (i < 1) return tag.replace(/-/g, " ");
    return tagLabel(tag.slice(0, i) as TagDimension, tag.slice(i + 1));
  }
</script>

<article class="result">
  <a
    class="row path-focus-target"
    id={`guide-species-${encodeURIComponent(row.species_code)}`}
    {href}
    {onclick}
  >
    <span class="thumbnail">
      {#if row.photo && !broken}
        <img
          src={row.photo.url}
          alt=""
          width="88"
          height="88"
          loading="lazy"
          decoding="async"
          use:checkThumbnail
          onerror={() => {
            if (row.photo) brokenUrl = row.photo.url;
          }}
        />
      {:else}
        <span class="photo-missing">{row.photo ? "Photo unavailable" : "No photo yet"}</span>
      {/if}
    </span>
    <span class="row-main">
      <span class="name">{row.com_name}</span>
      <span class="muted sci"><em>{row.sci_name}</em></span>
      <span class="badges">
        {#if row.seen}<Badge kind="seen" label="Seen" />{:else}<Badge kind="need" label="Need" />{/if}
        {#if interest}<span class="interest-badge">★ Special interest</span>{/if}
        {#if viewed}<ViewedBadge view={viewed} />{/if}
      </span>
      {#if row.matched_banding_code}<span class="muted">Banding code: {row.matched_banding_code}</span>{/if}
      {#if row.match_provenance === "name_or_code"}<span class="match-provenance">Name or code match</span>{/if}
      {#if row.match_provenance === "description_or_field_note"}<span class="match-provenance">Description or field-note match</span>{/if}
      {#if row.family || row.iucn_status}
        <span class="muted sci family"
          >{#if row.family}{row.family}{/if}
          {#if row.iucn_status}<span
              class="iucn s-{row.iucn_status.toLowerCase()}"
              title={IUCN_LABELS[row.iucn_status] ?? "IUCN status"}>{row.iucn_status}</span
            >{/if}</span
        >
      {/if}
      {#if (row.tags ?? []).length > 0}
        <span class="rowtags">
          {#each row.tags as t (t)}
            <span class="rowtag" class:hit={selectedTags.has(t)}>{chipText(t)}</span>
          {/each}
        </span>
      {/if}
      {#if row.field_craft}
        <span class="muted craft"
          >{row.field_craft.slice(0, 140)}{row.field_craft.length > 140 ? "…" : ""}</span
        >
      {:else if !row.wiki_fetched_at}
        <span class="muted craft">Wikipedia notes not loaded yet.</span>
      {:else if !row.has_prose}
        <span class="muted craft">No Wikipedia article.</span>
      {/if}
    </span>
    <span class="go" aria-hidden="true">›</span>
  </a>
  {#if row.photo}
    <p class="photo-credit">
      Photo: {row.photo.creator ?? "Creator not recorded"} ·
      <a href={row.photo.sourceUrl} target="_blank" rel="noopener">source</a>
      ·
      {#if row.photo.licenseUrl}
        <a href={row.photo.licenseUrl} target="_blank" rel="noopener">{row.photo.licenseCode}</a>
      {:else}{row.photo.licenseCode}{/if}
    </p>
  {/if}
</article>

<style>
  .muted {
    color: var(--muted);
    font-size: 0.89rem;
  }
  .result + :global(.result) {
    border-top: 1px solid var(--border);
  }
  .row {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
    padding: 10px 16px;
    min-height: 48px;
    color: inherit;
    text-decoration: none;
  }
  .row-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .thumbnail {
    width: 64px;
    height: 64px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    background: var(--bg);
    border-radius: 6px;
    overflow: hidden;
  }
  .thumbnail img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .photo-missing {
    color: var(--muted);
    font-size: 0.75rem;
    text-align: center;
  }
  .photo-credit {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0 6px;
    padding: 0 16px 8px;
    margin: 0;
    font-size: 0.78rem;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .photo-credit a {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
  }
  @media (min-width: 640px) {
    .thumbnail {
      width: 88px;
      height: 88px;
    }
  }
  .name {
    font-weight: 600;
    overflow-wrap: anywhere; /* long hyphenated names at 320 + zoom (GROK) */
  }
  .badges {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 8px;
  }
  .sci,
  .craft {
    overflow-wrap: anywhere;
  }
  .go {
    align-self: center;
    color: var(--accent);
    font-size: 1.3em;
    flex-shrink: 0;
  }
  @media (hover: hover) {
    .row:hover .name {
      color: var(--accent);
    }
  }
  .rowtags {
    display: flex;
    gap: 4px 6px;
    flex-wrap: wrap;
    margin-top: 2px;
  }
  .rowtag {
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 0.72rem;
    font-weight: 600;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--muted);
  }
  /* The tags the user filtered by light up on each hit. */
  .rowtag.hit {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .interest-badge {
    font-size: 0.8rem;
    color: var(--text);
    font-weight: 600;
  }
  .match-provenance {
    width: fit-content;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text);
  }
  .iucn {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 6px;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    vertical-align: middle;
    margin-left: 6px;
    background: #e9ecef;
    color: #343a40;
  }
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
    color: #724200;
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
</style>
