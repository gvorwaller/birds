<script lang="ts">
  import { invalidate } from "$app/navigation";
  import { onMount } from "svelte";
  import ViewedBadge from "./ViewedBadge.svelte";
  import type { SpeciesViewResult } from "$lib/species-views";
  let { code, accountId }: { code: string; accountId: number } = $props();
  let result = $state<SpeciesViewResult | null>(null);
  let message = $state("");
  let busy = $state(false);
  let visitId: string;
  let alive = false;
  let controller: AbortController | undefined;
  async function save() {
    if (busy || !alive || document.visibilityState !== "visible") return;
    busy = true;
    message = "";
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 15000);
    try {
      const response = await fetch("/api/species-views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speciesCode: code, accountId, visitId }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Could not save viewing history.");
      const saved: SpeciesViewResult = await response.json();
      if (alive) {
        result = saved;
        // Discard prefetched list data so Back cannot show stale badges.
        void invalidate("app:species-views").catch(() => {});
      }
    } catch {
      if (alive) message = "Could not save viewing history.";
    } finally {
      clearTimeout(timeout);
      if (alive) busy = false;
    }
  }
  onMount(() => {
    alive = true;
    visitId = crypto.randomUUID();
    // One event per mounted account/species. Query changes and loader
    // invalidations retain this component; preloading never mounts it.
    let started = false;
    const display = () => {
      if (!started && document.visibilityState === "visible") {
        started = true;
        void save();
      }
    };
    display();
    document.addEventListener("visibilitychange", display);
    return () => {
      alive = false;
      controller?.abort();
      document.removeEventListener("visibilitychange", display);
    };
  });
</script>

<div class="history">
  {#if result?.view}<ViewedBadge view={result.view} />{/if}
  {#if result && !result.enabled}<span>Viewing history paused.</span>{/if}
  {#if message}<span role="status">{message}</span><button
      type="button"
      disabled={busy}
      onclick={save}>Retry</button
    >{/if}
  <a href="/viewed">Viewed species</a>
</div>

<style>
  .history {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 0.8rem;
  }
  a,
  button {
    min-height: 48px;
    display: inline-flex;
    align-items: center;
  }
  button {
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    font-size: 1rem;
    cursor: pointer;
  }
</style>
