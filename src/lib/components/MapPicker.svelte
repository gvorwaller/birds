<script lang="ts">
  import { onMount } from "svelte";
  import { env } from "$env/dynamic/public";
  import { loadGoogleMaps } from "$lib/google-maps";

  export interface PickedLocation {
    lat: number;
    lng: number;
    label: string;
    place_id: string | null;
  }

  let {
    selected = $bindable<PickedLocation | null>(null),
    initialLat = null,
    initialLng = null,
  }: {
    selected?: PickedLocation | null;
    initialLat?: number | null;
    initialLng?: number | null;
  } = $props();

  const API_KEY = env.PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  const MAP_ID = env.PUBLIC_GOOGLE_MAPS_MAP_ID ?? "";

  let mapEl: HTMLDivElement;
  let searchQuery = $state("");
  let searching = $state(false);
  let status = $state("");
  let loadError = $state("");

  // Google objects (typed loosely — the SDK is loaded at runtime).
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let map: any = null;
  let marker: any = null;
  let gmaps: any = null;
  let markerLib: any = null;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  async function reverseGeocode(
    lat: number,
    lng: number,
  ): Promise<PickedLocation> {
    try {
      const res = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng }),
      });
      if (res.ok) {
        const data = await res.json();
        return {
          lat,
          lng,
          label: data.name ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
          place_id: data.place_id ?? null,
        };
      }
    } catch {
      /* fall through to coordinate label */
    }
    return {
      lat,
      lng,
      label: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      place_id: null,
    };
  }

  function placeMarker(
    lat: number,
    lng: number,
    label: string,
    placeId: string | null = null,
  ) {
    const pos = { lat, lng };
    if (!marker) {
      marker = new markerLib.AdvancedMarkerElement({
        map,
        position: pos,
        gmpDraggable: true,
      });
      marker.addListener("dragend", async () => {
        const p = marker.position;
        const dLat = typeof p.lat === "function" ? p.lat() : p.lat;
        const dLng = typeof p.lng === "function" ? p.lng() : p.lng;
        const location = await reverseGeocode(dLat, dLng);
        selected = location;
        status = location.label;
      });
    } else {
      marker.position = pos;
    }
    selected = { lat, lng, label, place_id: placeId };
    status = label;
  }

  async function handleSearch(e: SubmitEvent) {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q || !map) return;
    searching = true;
    status = "";
    try {
      const res = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      const data = await res.json();
      if (!res.ok) {
        status = data.error ?? "Search failed.";
        return;
      }
      if (data.bounds) {
        map.fitBounds(
          new gmaps.LatLngBounds(data.bounds.southwest, data.bounds.northeast),
        );
      } else {
        map.setCenter({ lat: data.lat, lng: data.lng });
        map.setZoom(13);
      }
      placeMarker(data.lat, data.lng, data.name, data.place_id ?? null);
    } finally {
      searching = false;
    }
  }

  onMount(async () => {
    if (!API_KEY) {
      loadError =
        "Google Maps key is not configured (PUBLIC_GOOGLE_MAPS_API_KEY).";
      return;
    }
    try {
      const libs = await loadGoogleMaps(API_KEY, ["maps", "marker"]);
      gmaps = (window as unknown as { google: { maps: unknown } }).google.maps;
      markerLib = libs.marker;
      const { Map } = libs.maps as {
        Map: new (el: HTMLElement, opts: unknown) => unknown;
      };

      const hasInitial = initialLat != null && initialLng != null;
      const center = hasInitial
        ? { lat: initialLat as number, lng: initialLng as number }
        : { lat: 39.5, lng: -98.35 }; // continental US fallback

      map = new Map(mapEl, {
        center,
        zoom: hasInitial ? 12 : 4,
        mapId: MAP_ID || undefined,
        gestureHandling: "greedy",
        zoomControl: true,
        zoomControlOptions: { position: gmaps.ControlPosition.RIGHT_BOTTOM },
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: false,
      });

      map.addListener(
        "click",
        async (ev: { latLng: { lat(): number; lng(): number } }) => {
          const lat = ev.latLng.lat();
          const lng = ev.latLng.lng();
          placeMarker(lat, lng, `${lat.toFixed(4)}, ${lng.toFixed(4)}`);
          const location = await reverseGeocode(lat, lng);
          placeMarker(
            location.lat,
            location.lng,
            location.label,
            location.place_id,
          );
        },
      );

      if (hasInitial) {
        placeMarker(
          initialLat as number,
          initialLng as number,
          "Saved home location",
        );
      }
    } catch (err) {
      loadError =
        err instanceof Error ? err.message : "Could not load the map.";
    }
  });
</script>

<div class="picker">
  <form class="search" onsubmit={handleSearch}>
    <input
      type="text"
      bind:value={searchQuery}
      placeholder="Search a place (city, park, address)…"
      aria-label="Search for a location"
    />
    <button type="submit" disabled={searching}
      >{searching ? "Searching…" : "Search"}</button
    >
  </form>

  {#if loadError}
    <p class="err" role="alert">{loadError}</p>
  {/if}

  <div class="map" bind:this={mapEl}></div>

  <p class="status" aria-live="polite">
    {#if selected}
      📍 {status || selected.label}
    {:else}
      Search for a place or tap the map to drop a pin.
    {/if}
  </p>
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .search {
    display: flex;
    gap: 8px;
  }
  .search input {
    flex: 1;
    min-height: 48px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
  }
  .search button {
    min-height: 48px;
    padding: 10px 18px;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .search button:disabled {
    opacity: 0.5;
  }
  .map {
    height: 50vh;
    min-height: 300px;
    max-height: 460px;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: #dde3e8;
  }
  .status {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .err {
    color: var(--danger);
    font-size: 0.85rem;
    font-weight: 600;
  }
  @media (min-width: 1024px) {
    .map {
      height: 420px;
    }
  }
</style>
