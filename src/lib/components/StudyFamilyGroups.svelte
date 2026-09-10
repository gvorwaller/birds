<script lang="ts">
  import { familyGroups, type StudySpecies } from "$lib/species-study";
  import StudySpeciesList from "./StudySpeciesList.svelte";
  let {
    rows,
    returnTo,
    openFamily = "",
    focusCode = "",
  }: {
    rows: StudySpecies[];
    returnTo: string;
    openFamily?: string;
    focusCode?: string;
  } = $props();
  const groups = $derived(familyGroups(rows));
  let expanded = $state(new Set<string>());
  const isOpen = (name: string) => expanded.has(name) || name === openFamily;
</script>

{#each groups as group (group.name)}
  <details
    id={"study-family-" + encodeURIComponent(group.name)}
    open={isOpen(group.name)}
    ontoggle={(event) => {
      const next = new Set(expanded);
      if (event.currentTarget.open) next.add(group.name);
      else {
        next.delete(group.name);
        if (openFamily === group.name) openFamily = "";
      }
      expanded = next;
    }}
  >
    <summary>{group.name} <span>{group.rows.length} species</span></summary>
    {#if isOpen(group.name)}
      <StudySpeciesList
        rows={group.rows}
        returnTo={returnTo +
          "&family=" +
          encodeURIComponent(group.name) +
          "#study-family-" +
          encodeURIComponent(encodeURIComponent(group.name))}
        {focusCode}
      />
    {/if}
  </details>
{/each}

<style>
  details {
    border-top: 1px solid var(--border);
    scroll-margin-top: 72px;
  }
  summary {
    padding: 12px 0;
    min-height: 48px;
    cursor: pointer;
    font-weight: 700;
    overflow-wrap: anywhere;
  }
  summary span {
    font-weight: 400;
    color: var(--muted);
    font-size: 0.85rem;
    margin-left: 8px;
  }
</style>
