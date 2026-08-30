<script lang="ts">
  /**
   * Determinate progress bar — the one visual formerly duplicated (with
   * drifting margins) across /forecast, /forecast/data, and twice in
   * /forecast/species (refactor plan Phase 8; AGY P2-6 counted the sites).
   * Colour pair is the established --accent on --accent-soft; a progress
   * bar is a non-text graphic (WCAG 1.4.11's 3:1, not the 7:1 text rule).
   * Margin varies per call site via the --pb-margin custom property.
   */
  let { value, max }: { value: number; max: number } = $props();
  const pct = $derived(max > 0 ? (value / max) * 100 : 0);
</script>

<div
  class="progressbar"
  role="progressbar"
  aria-valuenow={value}
  aria-valuemin={0}
  aria-valuemax={max}
>
  <div class="fill" style="width: {pct}%"></div>
</div>

<style>
  .progressbar {
    height: 8px;
    background: var(--accent-soft, var(--border));
    border-radius: 4px;
    overflow: hidden;
    margin: var(--pb-margin, 8px 0);
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.4s ease;
  }
</style>
