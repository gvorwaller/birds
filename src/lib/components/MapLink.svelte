<script lang="ts">
  import { mapsPlaceUrl, mapsDirectionsUrl } from "$lib/geo";

  // A compact set of links for a spotting location: "📍 Map" opens the spot in
  // Google Maps; "Directions ↗" hands off to turn-by-turn from the device's
  // location; "checklist ↗" opens the eBird report if subId is provided.
  // Renders nothing if coordinates and subId are missing/invalid.
  let {
    lat,
    lng,
    name = null,
    placeId = null,
    googlePlaceId = null,
    subId = null,
  }: {
    lat?: number | null;
    lng?: number | null;
    name?: string | null;
    placeId?: string | null;
    googlePlaceId?: string | null;
    subId?: string | null;
  } = $props();

  let ok = $derived(
    (typeof lat === "number" &&
      typeof lng === "number" &&
      Number.isFinite(lat) &&
      Number.isFinite(lng)) ||
      !!placeId ||
      !!googlePlaceId,
  );

  let place = $derived({
    name,
    lat,
    lng,
    place_id: placeId,
    google_place_id: googlePlaceId,
  });
</script>

{#if ok || subId}
  <span class="maplink">
    {#if ok}
      <a
        href={mapsPlaceUrl(place)}
        target="_blank"
        rel="noopener"
        title="Show this spot on Google Maps">📍 Map</a
      >
      <a
        href={mapsDirectionsUrl(place)}
        target="_blank"
        rel="noopener"
        title="Directions to this spot in Google Maps">Directions ↗</a
      >
    {/if}
    {#if subId}
      <a
        class="cl"
        href={`https://ebird.org/checklist/${encodeURIComponent(subId)}`}
        target="_blank"
        rel="noopener"
        title="Open eBird checklist">checklist ↗</a
      >
    {/if}
  </span>
{/if}

<style>
  .maplink {
    display: inline-flex;
    flex-wrap: wrap;
    max-width: 100%;
    gap: 0 14px;
    margin-top: 4px;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .maplink a {
    color: var(--link);
    text-decoration: none;
    white-space: nowrap;
    min-height: 48px;
    display: inline-flex;
    align-items: center;
  }
  .maplink a:hover {
    text-decoration: underline;
  }
  .maplink a.cl {
    color: var(--accent);
  }
</style>
