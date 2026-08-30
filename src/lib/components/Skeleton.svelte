<script lang="ts">
  /**
   * Reserved-space placeholder for a streamed section (refactor plan Phase 9;
   * AGY P1). The min-height is the point, not the shimmer: a streamed section
   * that renders into nothing drops the footer and every card below it by
   * hundreds of pixels mid-read. Size each use to its settled content's
   * typical height so the shell's layout IS the final layout.
   *
   * Under prefers-reduced-motion the pulse is removed by app.css's global
   * animation:none !important — the visible border keeps it legible as a
   * static "content coming" block rather than a half-frozen animation.
   */
  let {
    minHeight = "120px",
    label = "Loading…",
  }: { minHeight?: string; label?: string } = $props();
</script>

<div class="skeleton" style="min-height: {minHeight}" aria-hidden="false" role="status">
  <span class="skeleton-label">{label}</span>
</div>

<style>
  .skeleton {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px dashed var(--border);
    border-radius: 8px;
    background: var(--card);
    animation: skeleton-pulse 1.6s ease-in-out infinite;
  }
  .skeleton-label {
    color: var(--muted);
    font-size: 0.9rem;
  }
  @keyframes skeleton-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.55;
    }
  }
</style>
