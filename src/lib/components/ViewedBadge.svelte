<script lang="ts">
  import { viewedDate, type SpeciesView } from "$lib/species-views";
  let { view }: { view: SpeciesView } = $props();
</script>

<span
  class="viewed"
  title={`First viewed ${viewedDate(view.firstViewedAt)}; last viewed ${viewedDate(view.lastViewedAt)}`}
  >◉ Viewed in app</span
>

<style>
  .viewed {
    display: inline-block;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 2px 6px;
    font-size: 0.75rem;
    font-weight: 500;
  }
</style>
