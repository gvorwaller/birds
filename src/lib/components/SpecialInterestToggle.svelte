<script lang="ts">
  import { invalidate } from "$app/navigation";
  import { onDestroy } from "svelte";
  let {
    code,
    accountId,
    initialSaved,
    name,
    removableOnly = false,
    onRemoved,
  }: {
    code: string;
    accountId: number;
    initialSaved: boolean | null;
    name: string;
    removableOnly?: boolean;
    onRemoved?: () => void;
  } = $props();
  let override = $state<boolean | undefined>();
  const saved = $derived(override ?? initialSaved);
  let busy = $state(false);
  let message = $state("");
  let retryTarget = $state<boolean | null>(null);
  let controller: AbortController | undefined;
  let alive = true;
  $effect(() => {
    initialSaved;
    override = undefined;
  });
  onDestroy(() => {
    alive = false;
    controller?.abort();
  });

  async function save(target: boolean) {
    if (busy) return;
    busy = true;
    message = "";
    retryTarget = null;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 15000);
    try {
      const response = await fetch("/api/special-interest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speciesCode: code, accountId, saved: target }),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 409 || response.status === 401) {
          message =
            "Your account changed or session expired. Reload this page.";
          return;
        }
        if (response.status === 404) {
          message =
            "This species is no longer in the current taxonomy. Reload this page.";
          return;
        }
        throw new Error("Save failed");
      }
      const result = await response.json();
      if (result.saved !== target) throw new Error("Invalid save response");
      if (!alive) return;
      override = target;
      message = target
        ? "Saved to Special interest."
        : "Removed from Special interest.";
      try {
        await invalidate("app:special-interest");
      } catch {
        if (alive) message += " Reload to refresh the collection.";
      }
      if (!target) onRemoved?.();
    } catch {
      if (alive) {
        message = "Could not confirm the change. Retry to save your selection.";
        retryTarget = target;
      }
    } finally {
      clearTimeout(timeout);
      if (alive) busy = false;
    }
  }
  async function reloadState() {
    busy = true;
    try {
      await invalidate("app:special-interest");
    } catch {
      message = "Special interest is unavailable. Please reload this page.";
    } finally {
      if (alive) busy = false;
    }
  }
</script>

<div class="special-interest">
  {#if saved === null}
    <span role="status">Special interest is unavailable.</span>
    <button type="button" disabled={busy} onclick={reloadState}
      >Retry loading Special interest</button
    >
  {:else}
    <button
      type="button"
      class:saved
      aria-pressed={saved}
      aria-label={removableOnly
        ? `Remove ${name} from Special interest`
        : `Special interest: ${name}`}
      disabled={busy || retryTarget !== null || (removableOnly && !saved)}
      onclick={() => save(!saved)}
    >
      {busy
        ? "Saving…"
        : removableOnly
          ? "Remove"
          : saved
            ? "★ Special interest"
            : "☆ Special interest"}
    </button>
  {/if}
  {#if message}<span role="status">{message}</span>{/if}
  {#if retryTarget !== null}<button
      type="button"
      disabled={busy}
      onclick={() => save(retryTarget!)}>Retry</button
    >{/if}
  <noscript>Enable JavaScript to change Special interest.</noscript>
</div>

<style>
  .special-interest {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin: 8px 0;
    color: var(--text);
  }
  button {
    min-height: 48px;
    min-width: 48px;
    padding: 8px 12px;
    border: 1px solid var(--muted);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  button.saved {
    border: 2px solid var(--accent);
  }
  button:disabled {
    cursor: wait;
  }
  span,
  noscript {
    font-size: 0.9rem;
  }
</style>
