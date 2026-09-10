<script lang="ts">
  import ViewedBadge from "$components/ViewedBadge.svelte";
  import { viewedDate } from "$lib/species-views";
  import type { StudySpecies } from "$lib/species-study";
  let {
    rows,
    returnTo,
    focusCode = "",
  }: { rows: StudySpecies[]; returnTo: string; focusCode?: string } = $props();
  let shown = $state(100);
  const visible = $derived(
    Math.max(shown, rows.findIndex((r) => r.code === focusCode) + 1),
  );
  function detailHref(code: string) {
    const back = new URL(returnTo, "https://birds.invalid");
    back.searchParams.set("focus", code);
    return `/species/${code}?returnTo=${encodeURIComponent(back.pathname + back.search + back.hash)}`;
  }
</script>

<ul class="study-list">
  {#each rows.slice(0, visible) as row (row.code)}
    <li>
      <div class="name">
        {#if row.current}<a href={detailHref(row.code)}>{row.name}</a>
        {:else}<strong>{row.name ?? row.code}</strong><span class="muted"
            >Not in the current species taxonomy</span
          >{/if}
        {#if row.view}<ViewedBadge view={row.view} />{:else}<span class="muted"
            >Not yet viewed</span
          >{/if}
      </div>
      {#if row.scientificName}<em>{row.scientificName}</em>{/if}
      <p class="muted family">{row.family ?? "Family unavailable"}</p>
      {#if row.view}<p class="muted dates">
          First viewed {viewedDate(row.view.firstViewedAt)}<br />Last viewed {viewedDate(
            row.view.lastViewedAt,
          )}
        </p>{/if}
    </li>
  {/each}
</ul>
{#if visible < rows.length}
  <div class="more">
    <span>Showing {visible} of {rows.length} species</span><button
      type="button"
      onclick={() => (shown = visible + 100)}>Show 100 more</button
    >
  </div>
{/if}

<style>
  .study-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  li {
    padding: 12px 0;
    border-top: 1px solid var(--border);
    overflow-wrap: anywhere;
  }
  .name,
  .more {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }
  .name a {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    font-weight: 700;
  }
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .dates {
    margin-top: 6px;
  }
  button {
    min-height: 48px;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    font-size: 1rem;
  }
</style>
