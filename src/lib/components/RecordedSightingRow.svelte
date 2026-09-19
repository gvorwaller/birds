<script lang="ts">
  import MapLink from "$components/MapLink.svelte";
  import { formatDistance, type DistanceUnit } from "$lib/geo";

  export interface RecordedSightingRowData {
    speciesCode: string;
    comName: string;
    firstSeen: string | null;
    locationName: string | null;
    obsCount: number | null;
    subId: string | null;
    lat: number | null;
    lng: number | null;
    distanceKm?: number | null;
  }

  let {
    row,
    distanceUnit = "mi",
    speciesHref,
  }: {
    row: RecordedSightingRowData;
    distanceUnit?: DistanceUnit;
    speciesHref?: (code: string) => string;
  } = $props();
</script>

<div class="obs recorded-sighting-row">
  <div class="grow">
    <div class="name">
      {#if speciesHref}<a href={speciesHref(row.speciesCode)}>{row.comName}</a>{:else}{row.comName}{/if}
    </div>
    <div class="meta">
      {row.firstSeen ?? "Undated"} · {row.locationName ?? "Location unavailable"}
      {#if row.obsCount != null} · recorded count {row.obsCount}{/if}
      {#if row.subId}
        · <a href={`https://ebird.org/checklist/${row.subId}`} target="_blank" rel="noopener">checklist ↗</a>
      {/if}
    </div>
    {#if row.lat != null && row.lng != null}
      <MapLink lat={row.lat} lng={row.lng} name={row.locationName ?? row.comName} />
    {:else if row.lat == null || row.lng == null}
      <span class="muted">Location unavailable.</span>
    {/if}
  </div>
  {#if row.distanceKm != null}
    <div class="right"><div class="dist">{formatDistance(row.distanceKm, distanceUnit)}</div></div>
  {/if}
</div>

<style>
  .recorded-sighting-row {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 8px 0;
  }
  :global(.recorded-sighting-row + .recorded-sighting-row) {
    border-top: 1px solid var(--border);
  }
  .grow {
    min-width: 0;
    flex: 1;
  }
  .name {
    font-weight: 600;
  }
  .name a {
    color: inherit;
  }
  .meta {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .meta a {
    color: var(--accent);
  }
  .right {
    flex: 0 0 auto;
  }
</style>
