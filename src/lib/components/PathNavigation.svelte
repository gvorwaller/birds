<script lang="ts">
  import { tick, untrack } from "svelte";
  import { page } from "$app/state";
  import { browser } from "$app/environment";
  import {
    ensureCurrentNode,
    navigationAction,
    navigationStorageAvailable,
    navigationReferenceUnavailable,
    navigationNodeHref,
    shouldRestoreNavigationOrigin,
    trailFor,
    updateCurrentNode,
  } from "$lib/navigation-context.svelte";
  import {
    canonicalHref,
    parseLocalHref,
    type NavigationNode,
    type NavigationUiState,
  } from "$lib/navigation-context";

  let {
    accountId,
    label,
    fallbackHref = "/",
    fallbackLabel = "Home",
    hasExplicitSource = false,
    href,
    onRestore,
    contentReady = true,
    ui,
    hideWhenNoPath = false,
  }: {
    accountId: number | null | undefined;
    label: string;
    fallbackHref?: string;
    fallbackLabel?: string;
    hasExplicitSource?: boolean;
    href?: string;
    onRestore?: (state: {
      originId: string | null;
      focusId: string | null;
      ui: NavigationUiState | null;
    }) => void;
    contentReady?: boolean;
    ui?: NavigationUiState | null;
    hideWhenNoPath?: boolean;
  } = $props();

  let current = $state<NavigationNode | null>(null);
  let ancestors = $state<NavigationNode[]>([]);
  let truncated = $state(false);
  let restoredNodeId = $state<string | null>(null);
  let restorationMissing = $state(false);
  const currentHref = $derived(
    canonicalHref(
      href ?? page.url.pathname + page.url.search + page.url.hash,
    ) ?? "/",
  );
  const safeFallbackHref = $derived.by(() => {
    const parsed = parseLocalHref(fallbackHref);
    return parsed ? parsed.pathname + parsed.search + parsed.hash : "/";
  });
  const storageBlocked = $derived(
    browser && accountId != null && !navigationStorageAvailable(accountId),
  );
  const referenceUnavailable = $derived(
    accountId != null && navigationReferenceUnavailable(accountId),
  );

  function refresh() {
    const next = ensureCurrentNode({ accountId, href: currentHref, label, ui });
    const previous = untrack(() => current);
    const sameUi =
      JSON.stringify(previous?.ui ?? null) === JSON.stringify(next?.ui ?? null);
    if (previous?.id !== next?.id || previous?.href !== next?.href || !sameUi)
      current = next;
    const trail = trailFor(accountId, next?.id);
    ancestors = trail.nodes.slice(0, -1);
    truncated = trail.truncated;
    if (next && untrack(() => restoredNodeId) !== next.id) {
      restoredNodeId = next.id;
      onRestore?.({
        originId: next.originId,
        focusId: next.focusId,
        ui: next.ui,
      });
    }
  }

  $effect(() => {
    page.url.pathname;
    page.url.search;
    page.state;
    accountId;
    refresh();
  });

  const restoreNodeId = $derived(current?.id ?? null);
  let userMoved = $state(false);
  let focusedForNode = $state<string | null>(null);

  // Observe intent throughout streamed loading, not just during the last frame.
  $effect(() => {
    restoreNodeId;
    userMoved = false;
    restorationMissing = false;
    const events = ["pointerdown", "wheel", "touchstart", "keydown"];
    const interrupt = () => {
      userMoved = true;
    };
    for (const event of events)
      window.addEventListener(event, interrupt, { passive: true });
    return () => {
      for (const event of events) window.removeEventListener(event, interrupt);
    };
  });

  $effect(() => {
    const node = current;
    if (
      !node ||
      !contentReady ||
      userMoved ||
      untrack(() => focusedForNode) === node.id
    )
      return;
    let cancelled = false;
    void tick()
      .then(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      .then(() => {
        if (cancelled || userMoved) return;
        focusedForNode = node.id;
        if (!shouldRestoreNavigationOrigin()) return;
        const targetId = node.focusId ?? node.originId;
        if (!targetId) return;
        const target = document.getElementById(targetId);
        if (!target) {
          restorationMissing = true;
          return;
        }
        if (document.activeElement && document.activeElement !== document.body)
          return;
        if (target instanceof HTMLElement) {
          if (target.tabIndex < 0) target.tabIndex = -1;
          target.focus({ preventScroll: true });
        }
        target.scrollIntoView({ block: "center" });
      });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    page.url.pathname;
    page.url.search;
    if (current && accountId != null) {
      updateCurrentNode({ accountId, href: currentHref, label, ui });
    }
  });

  function ancestorAction(node: NavigationNode) {
    return navigationAction(accountId, {
      label: node.label,
      existingNodeId: node.id,
    });
  }
  function ancestorHref(node: NavigationNode): string {
    return navigationNodeHref(accountId, node.id);
  }
</script>

<nav class="path-nav" aria-label="Page path">
  {#if storageBlocked || referenceUnavailable}<p class="muted" role="status">
      Path history is unavailable in this browser; the immediate link remains
      available.
    </p>{/if}
  {#if restorationMissing}<p class="muted" role="status">
      The original item is no longer in this view; the current results remain
      available.
    </p>{/if}
  {#if ancestors.length > 0 || !hideWhenNoPath}<p class="back-row">
    {#if ancestors.length > 0}
      <a
        href={ancestorHref(ancestors[ancestors.length - 1])}
        onclick={ancestorAction(ancestors[ancestors.length - 1])}
        >← Back to {ancestors[ancestors.length - 1].label}</a
      >
    {:else}
      <a href={safeFallbackHref}
        >{hasExplicitSource
          ? `← Back to ${fallbackLabel}`
          : `← ${fallbackLabel}`}</a
      >
    {/if}
  </p>{/if}
  {#if ancestors.length > 1 || truncated}
    <details class="trail">
      <summary>Your path</summary>
      <ol>
        {#each ancestors.slice(0, -1) as node (node.id)}
          <li>
            <a href={ancestorHref(node)} onclick={ancestorAction(node)}
              >{node.label}</a
            >
          </li>
        {/each}
      </ol>
      {#if truncated}<p class="muted">
          Older path history is unavailable; the immediate link remains
          available.
        </p>{/if}
    </details>
  {/if}
</nav>

<style>
  .path-nav {
    margin: 4px 0 12px;
  }
  :global(.path-focus-target) {
    scroll-margin-top: 72px;
  }
  .back-row {
    margin: 0;
  }
  .back-row a,
  .trail summary,
  .trail a {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    padding: 8px 10px;
    color: var(--accent);
    font-weight: 600;
  }
  .trail {
    margin-top: 2px;
    color: var(--muted);
  }
  .trail ol {
    margin: 0;
    padding-left: 22px;
  }
  .trail .muted {
    margin: 0 10px 8px;
    font-size: 0.88rem;
  }
</style>
