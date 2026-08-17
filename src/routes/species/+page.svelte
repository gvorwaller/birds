<script lang="ts">
  import Badge from "$components/Badge.svelte";
  import {
    TAG_DIMENSIONS,
    TAG_VOCABULARY,
    dimensionLabel,
    tagLabel,
    type TagDimension,
  } from "$lib/species-tags";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const selected = $derived(new Set(data.tags));

  /** Toggle URL for a tag chip — GET-driven, restorable, no client state. */
  function toggleHref(tag: string): string {
    const p = new URLSearchParams();
    if (data.q) p.set("q", data.q);
    const next = selected.has(tag)
      ? data.tags.filter((t) => t !== tag)
      : [...data.tags, tag];
    for (const t of next) p.append("tags", t);
    const s = p.toString();
    return s ? `/species?${s}` : "/species";
  }

  function detailHref(code: string): string {
    const back = new URLSearchParams();
    if (data.q) back.set("q", data.q);
    for (const t of data.tags) back.append("tags", t);
    const qs = back.toString();
    const returnTo = encodeURIComponent(`/species${qs ? `?${qs}` : ""}`);
    return `/species/${code}?returnTo=${returnTo}&returnLabel=${encodeURIComponent("Field guide")}`;
  }

  function tagDimension(tag: string): TagDimension {
    return tag.split(":")[0] as TagDimension;
  }
</script>

<svelte:head>
  <title>Field guide — birds</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <h1>📖 Field guide</h1>
    <p class="sub">
      Search {data.counts.enriched} enriched species by name, description, or
      field-craft tags{data.counts.annotated > 0
        ? ` (${data.counts.annotated} with AI field craft)`
        : ""}.
    </p>
  </header>

  <section class="card">
    <form method="GET" action="/species" class="searchform">
      {#each data.tags as t (t)}
        <input type="hidden" name="tags" value={t} />
      {/each}
      <input
        type="search"
        name="q"
        value={data.q}
        placeholder="mudflats, probing, granary trees…"
        aria-label="Search species"
      />
      <button type="submit">Search</button>
    </form>

    {#if data.tags.length > 0}
      <div class="active-filters">
        <span class="muted af-label">Match all selected tags:</span>
        {#each data.tags as t (t)}
          <a
            class="chip chip-active"
            class:chip-tide={tagDimension(t) === "tide"}
            href={toggleHref(t)}
            title="Remove filter"
          >
            {tagLabel(tagDimension(t), t.split(":")[1])} ✕
          </a>
        {/each}
      </div>
    {/if}

    {#each TAG_DIMENSIONS as d (d)}
      <details class="dim">
        <summary>{dimensionLabel(d)}</summary>
        <div class="chips">
          {#each TAG_VOCABULARY[d] as v (v)}
            {@const tag = `${d}:${v}`}
            <a
              class="chip"
              class:chip-on={selected.has(tag)}
              class:chip-tide={d === "tide"}
              href={toggleHref(tag)}
            >
              {tagLabel(d, v)}
            </a>
          {/each}
        </div>
      </details>
    {/each}
  </section>

  {#if data.active}
    {#if data.results.length === 0}
      <section class="card">
        <p class="muted">
          No species match{data.q ? ` “${data.q}”` : ""}{data.tags.length > 0
            ? " with every selected tag"
            : ""}. Try fewer tags or a broader search — tags come from AI
          annotation, which is still filling in.
        </p>
      </section>
    {:else}
      <section class="card results">
        {#each data.results as r (r.species_code)}
          <a class="row" href={detailHref(r.species_code)}>
            <span class="row-main">
              <span class="name">
                {r.com_name}
                {#if r.seen}<Badge kind="seen" label="Seen" />{:else}<Badge
                    kind="need"
                    label="Need"
                  />{/if}
              </span>
              <span class="muted sci"><em>{r.sci_name}</em>{#if r.family}
                  · {r.family}{/if}</span>
              {#if r.field_craft}
                <span class="muted craft">{r.field_craft.slice(0, 140)}{r
                    .field_craft.length > 140
                    ? "…"
                    : ""}</span>
              {/if}
            </span>
            <span class="go" aria-hidden="true">›</span>
          </a>
        {/each}
      </section>
      {#if data.results.length === 50}
        <p class="muted trunc">Showing the first 50 matches — narrow the search.</p>
      {/if}
    {/if}
  {:else}
    <section class="card">
      <p class="muted">
        Pick tags above or type a search — try
        <a href="/species?tags=habitat%3Amudflat&tags=tide%3Alow"
          >mudflat birds at low tide</a
        >
        or
        <a href="/species?tags=find%3Aheard-more-than-seen"
          >birds you hear more than see</a
        >.
      </p>
    </section>
  {/if}

  <p class="attribution">
    Species text from
    <a href="https://en.wikipedia.org" target="_blank" rel="noopener">Wikipedia</a>
    (CC BY-SA 4.0) · data from
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
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .searchform {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .searchform input[type="search"] {
    flex: 1;
    min-width: 200px;
    min-height: 48px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    font-size: 1rem; /* prevents iOS focus zoom (GROK contract) */
  }
  .searchform button {
    min-height: 48px;
    padding: 10px 18px;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .active-filters {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  .af-label {
    font-weight: 600;
  }
  .dim summary {
    min-height: 48px;
    display: flex;
    align-items: center;
    cursor: pointer;
    font-weight: 600;
    list-style: none;
  }
  .dim summary::-webkit-details-marker {
    display: none;
  }
  .dim summary::after {
    content: "▸";
    margin-left: auto;
    padding-left: 12px;
    color: var(--accent);
    font-size: 1.1em;
  }
  .dim[open] summary::after {
    content: "▾";
  }
  .dim + .dim {
    border-top: 1px solid var(--border);
  }
  .chips {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    padding: 4px 0 12px;
  }
  /* Interactive chips: 48px tap targets (cs.md family rule — these ARE
     controls, unlike the display chips on the species page). */
  .chip {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    padding: 8px 16px;
    border-radius: 24px;
    font-size: 0.85rem;
    font-weight: 600;
    background: var(--bg);
    color: #1d4a35;
    border: 1px solid #c4d9cd;
    text-decoration: none;
  }
  .chip-on,
  .chip-active {
    background: #1d4a35;
    color: #f2f7f4;
    border-color: #1d4a35;
  }
  .chip-tide {
    color: #163e5e;
    border-color: #b3d1e8;
  }
  .chip-tide.chip-on,
  .chip-tide.chip-active {
    background: #163e5e;
    color: #eef5fb;
    border-color: #163e5e;
  }
  .results {
    padding: 4px 0;
  }
  .row {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    min-height: 48px;
    color: inherit;
    text-decoration: none;
  }
  .row + .row {
    border-top: 1px solid var(--border);
  }
  .row-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .name {
    font-weight: 600;
  }
  .sci,
  .craft {
    overflow-wrap: anywhere;
  }
  .go {
    color: var(--accent);
    font-size: 1.3em;
    flex-shrink: 0;
  }
  @media (hover: hover) {
    .row:hover .name {
      color: var(--accent);
    }
    .chip:hover {
      border-color: var(--accent);
    }
  }
  .trunc {
    text-align: center;
    margin: 4px 0 16px;
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
