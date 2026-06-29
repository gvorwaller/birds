<script lang="ts">
  import { browser } from "$app/environment";
  import type { DistanceUnit } from "$lib/geo";

  const STORAGE_KEY = "birds:distanceUnit";

  let { unit = $bindable<DistanceUnit>("mi") } = $props();
  let loaded = $state(false);

  function isDistanceUnit(value: string | null): value is DistanceUnit {
    return value === "mi" || value === "km";
  }

  $effect(() => {
    if (!browser || loaded) return;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isDistanceUnit(saved)) unit = saved;
    loaded = true;
  });

  function setUnit(next: DistanceUnit) {
    unit = next;
    if (browser) localStorage.setItem(STORAGE_KEY, next);
  }
</script>

<div class="unit-toggle" aria-label="Distance units">
  <button
    type="button"
    class:active={unit === "mi"}
    aria-pressed={unit === "mi"}
    onclick={() => setUnit("mi")}>mi</button
  >
  <button
    type="button"
    class:active={unit === "km"}
    aria-pressed={unit === "km"}
    onclick={() => setUnit("km")}>km</button
  >
</div>

<style>
  .unit-toggle {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    padding: 2px;
  }
  .unit-toggle button {
    min-height: 34px;
    min-width: 42px;
    padding: 6px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 0.82rem;
    font-weight: 700;
    cursor: pointer;
  }
  .unit-toggle button.active {
    background: var(--accent);
    color: #fff;
  }
</style>
