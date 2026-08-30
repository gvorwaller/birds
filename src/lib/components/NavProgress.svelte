<script lang="ts">
  /**
   * Global navigation progress bar (refactor plan Phase 8). Before this,
   * SvelteKit's `navigating` signal was used only as a poller invalidation
   * gate — nothing visual — so a slow server load looked like a dead link.
   *
   * Geometry (verified against +layout.svelte's stacking order): fixed at
   * the very top, z-index 1050 — above .top-nav (1000) and BELOW the drawer
   * scrim (1100; a bar at >=1100 would tie with a full-viewport overlay and
   * paint by DOM order). pointer-events: none, so it can never eat a tap.
   *
   * Width is driven by JS state (nav-progress-core), NOT CSS animation:
   * app.css's reduced-motion block kills all animations !important, which
   * would freeze a keyframe bar at its initial width. See core module.
   */
  import { navigating } from "$app/state";
  import {
    HOLD_AFTER_DONE_MS,
    SHOW_DELAY_MS,
    TICK_MS,
    widthAt,
  } from "$lib/nav-progress-core";

  let visible = $state(false);
  let width = $state(0);
  /** Screen-reader announcement; visually hidden, polite, throttled by the
   * same show-delay as the bar so fast navigations announce nothing. */
  let announcement = $state("");

  $effect(() => {
    if (!navigating.to) return;
    // Navigation started: arm the flash-delay, then trickle until it ends.
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let tick: ReturnType<typeof setInterval> | undefined;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    showTimer = setTimeout(() => {
      visible = true;
      announcement = "Page loading";
      width = widthAt(Date.now() - startedAt);
      tick = setInterval(() => {
        width = widthAt(Date.now() - startedAt);
      }, TICK_MS);
    }, SHOW_DELAY_MS);
    return () => {
      // Navigation ended (or was superseded): finish visibly, then clear.
      clearTimeout(showTimer);
      clearInterval(tick);
      if (visible) {
        width = 100;
        announcement = "Page loaded";
        holdTimer = setTimeout(() => {
          visible = false;
          width = 0;
        }, HOLD_AFTER_DONE_MS);
      }
      // A brand-new navigation's own effect run takes over from here; the
      // hold timer only ever hides an already-finished bar.
      void holdTimer;
    };
  });
</script>

{#if visible}
  <div class="navbar-progress" role="progressbar" aria-label="Page loading">
    <div class="fill" style="width: {width}%"></div>
  </div>
{/if}
<span class="sr-only" aria-live="polite">{announcement}</span>

<style>
  .navbar-progress {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 3px;
    z-index: 1050;
    pointer-events: none;
    background: transparent;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
