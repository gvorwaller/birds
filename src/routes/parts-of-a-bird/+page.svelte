<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { page } from "$app/state";
  import FieldGuideTabs from "$components/FieldGuideTabs.svelte";
  import PathNavigation from "$components/PathNavigation.svelte";
  import PartsDiagram from "$components/PartsDiagram.svelte";
  import { DIAGRAMS, parseHash } from "$lib/bird-parts";
  import type { Layer } from "$lib/bird-parts/types";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  // The page owns every section's state so fragment links and Expand/Collapse all can drive it.
  // Closed in SSR too: opening them server-side would flash open, then shut, on every load.
  let open = $state<Record<string, boolean>>(Object.fromEntries(DIAGRAMS.map((d) => [d.id, false])));
  let layers = $state<Record<string, Layer>>(Object.fromEntries(DIAGRAMS.map((d) => [d.id, "main" as Layer])));
  let selected = $state<Record<string, string | null>>(Object.fromEntries(DIAGRAMS.map((d) => [d.id, null])));
  let hydrated = $state(false);
  onMount(() => (hydrated = true));

  function setAll(value: boolean) {
    for (const d of DIAGRAMS) open[d.id] = value;
  }

  async function revealFromHash(hash: string) {
    const target = parseHash(hash);
    if (!target) return;
    open[target.diagram] = true;
    if (target.part) {
      const part = DIAGRAMS.find((d) => d.id === target.diagram)!.parts.find((p) => p.id === target.part)!;
      if (!part.layers.includes(layers[target.diagram])) layers[target.diagram] = part.layers[0];
      selected[target.diagram] = part.id;
    }
    await tick();
    document.getElementById(target.diagram)?.scrollIntoView({ block: "start" });
    if (target.part) document.getElementById(`${target.diagram}-${target.part}`)?.focus({ preventScroll: true });
  }
  // Follows page.url.hash, not afterNavigate: SvelteKit treats a same-page hash link and
  // Back/Forward between hashes as shallow (page.url changes, afterNavigate never runs).
  // This also runs once on mount, covering cold deep links and links from other pages.
  $effect(() => {
    const hash = page.url.hash;
    untrack(() => void revealFromHash(hash));
  });
</script>

<svelte:head><title>Parts of a Bird — birds</title></svelte:head>
<div class="page">
  <PathNavigation accountId={data.user?.id} label="Parts of a Bird" href={page.url.pathname} fallbackHref="/species" fallbackLabel="Field guide" hideWhenNoPath />
  <h1>📖 Field guide</h1>
  <p class="muted">Learn the parts of a bird that identification depends on.</p>
  <FieldGuideTabs active="parts" />

  <section class="card intro">
    <div class="card-head">
      <h2>Parts of a Bird</h2>
      {#if hydrated}
        <div class="actions">
          <button type="button" class="btn-link" onclick={() => setAll(true)}>Expand all</button>
          <span class="sep" aria-hidden="true">·</span>
          <button type="button" class="btn-link" onclick={() => setAll(false)}>Collapse all</button>
        </div>
      {/if}
    </div>
    <p>Field guides describe birds by their parts: a pale supercilium, two wing bars, long primary projection. Open a bird, then tap a part on the drawing or a name below it to see what to look for there.</p>
    <p class="muted">Each drawing is simplified to show where the parts are, not the exact colours of every species.</p>
  </section>

  {#each DIAGRAMS as d (d.id)}
    <details class="card bird" id={d.id} bind:open={open[d.id]}>
      <summary><h2>{d.title}</h2></summary>
      <PartsDiagram diagram={d} bind:layer={layers[d.id]} bind:selected={selected[d.id]} />
    </details>
  {/each}
</div>

<style>
  .page {
    max-width: 960px;
    margin: 0 auto;
    padding: 16px;
  }
  h1 {
    font-size: 1.4rem;
    margin-bottom: 8px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin: 16px 0;
  }
  .card p {
    margin: 12px 0;
  }
  .muted {
    color: var(--muted);
    font-size: 0.9rem;
  }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .card-head h2 {
    font-size: 1.15rem;
    margin: 0;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .btn-link {
    min-height: 44px;
    padding: 0 6px;
    border: 0;
    background: none;
    color: var(--link);
    font: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
  }
  .btn-link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .sep {
    color: var(--muted);
  }
  .bird {
    padding: 0 16px;
    scroll-margin-top: 90px;
  }
  .bird[open] {
    padding-bottom: 16px;
  }
  .bird > summary {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-height: 52px;
    cursor: pointer;
    list-style: none;
  }
  .bird > summary::-webkit-details-marker {
    display: none;
  }
  .bird > summary::before {
    content: "▸";
    flex: none;
  }
  .bird[open] > summary::before {
    content: "▾";
  }
  .bird > summary h2 {
    flex: 1;
    margin: 0;
    font-size: 1.15rem;
  }
  .bird > summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 4px;
    border-radius: 4px;
  }
</style>
