<script lang="ts">
  /**
   * A card whose body collapses (td-cf40b2). Used by the admin tabs, where
   * eight stacked sections — several of them long tables — make finding
   * anything a scroll.
   *
   * Deliberately `{#if}` rather than <details>: a closed <details> keeps its
   * contents in the DOM, so collapsing would hide the clutter while still
   * paying to render and hydrate every row. That exact trap cost /forecast/data
   * ~10 s of blocked input (2026-08-31). Here the content genuinely does not
   * exist until opened.
   *
   * Open/closed is remembered per card id in localStorage, like the region
   * groups on /forecast/data.
   */
  import { browser } from "$app/environment";

  let {
    id,
    title,
    /** Optional count rendered beside the title, e.g. "Jobs (3)". */
    badge = null,
    /** Default state the first time this card is ever seen. */
    initiallyOpen = true,
    children,
  }: {
    id: string;
    title: string;
    badge?: string | number | null;
    initiallyOpen?: boolean;
    children: import("svelte").Snippet;
  } = $props();

  const KEY = "admin-card-open";
  function readState(): Record<string, boolean> {
    if (!browser) return {};
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
    } catch {
      return {}; // private mode / corrupt value — fall back to defaults
    }
  }

  // null = "no explicit choice yet", so the prop default stays live rather
  // than being captured once at init.
  let chosen = $state<boolean | null>(null);
  const open = $derived(chosen ?? initiallyOpen);
  $effect(() => {
    const stored = readState()[id];
    if (typeof stored === "boolean") chosen = stored;
  });

  function toggle() {
    const next = !open;
    chosen = next;
    if (!browser) return;
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...readState(), [id]: next }));
    } catch {
      // private mode — the toggle still works for this session
    }
  }
</script>

<section class="card">
  <button
    type="button"
    class="cardtoggle"
    aria-expanded={open}
    aria-controls="card-{id}"
    onclick={toggle}
  >
    <h2>
      {title}{#if badge != null}<span class="badge"> ({badge})</span>{/if}
    </h2>
    <span class="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
  </button>
  {#if open}
    <div id="card-{id}">{@render children()}</div>
  {/if}
</section>

<style>
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 16px;
  }
  /* The whole header is the control — a 48px target per cs.md, not a
     hard-to-hit chevron. */
  .cardtoggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    min-height: 48px;
    padding: 0;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  h2 {
    font-size: 1.05rem;
    margin: 0;
  }
  .badge {
    color: var(--muted);
    font-weight: 400;
  }
  .chev {
    color: var(--muted);
    font-size: 0.9rem;
  }
  /* Restores the gap the old `h2 { margin: 0 0 10px }` provided, only when
     there is a body to separate from. */
  .cardtoggle + div {
    margin-top: 10px;
  }
</style>
