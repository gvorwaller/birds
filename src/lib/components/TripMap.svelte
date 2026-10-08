<script lang="ts">
  import { onMount } from "svelte";
  import { env } from "$env/dynamic/public";
  import { loadGoogleMaps } from "$lib/google-maps";
  import { mapsPlaceUrl, mapsDirectionsUrl } from "$lib/geo";
  import { MAX_DIRECTIONS_WAYPOINTS } from "$lib/route";

  function escapeHtml(s: string): string {
    return s.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
  }

  export interface MapStop {
    lat: number;
    lng: number;
    label: string;
    order: number;
    googlePlaceId?: string | null;
    /** The trip stop's id, when the stop is saved (keys the caller's remount). */
    id?: number;
    /** Checked off on the trip (td-40a1b5): drawn as a faded pin. */
    visited?: boolean;
  }

  let {
    stops = [],
    extra = null,
    anchor = null,
    onSummary,
  }: {
    stops?: MapStop[];
    extra?: MapStop | null;
    /** The trip's start & end point (td-0f3c63): the drawn route and its
     * summary loop anchor -> stops -> anchor. */
    anchor?: { lat: number; lng: number; label: string } | null;
    /** Reports total driving distance/time of the drawn route, or null if it fell back to a straight line. */
    onSummary?: (s: { km: number; min: number } | null) => void;
  } = $props();

  const API_KEY = env.PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  const MAP_ID = env.PUBLIC_GOOGLE_MAPS_MAP_ID ?? "";

  let mapEl: HTMLDivElement;
  let loadError = $state("");
  let routeNote = $state("");

  // On-demand satellite view on the existing vector map (no extra API/cost):
  // 'hybrid' = satellite imagery + labels, 'roadmap' = the styled base map.
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  let map: any = null;
  let satellite = $state(false);
  let mapReady = $state(false);
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  let markerLib: any = null;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const markers: Array<{ order: number; marker: any }> = [];

  // Visited stops fade to light grey with a dark number (11:1) and sit under
  // the ones still to visit.
  function pinFor(s: MapStop) {
    return new markerLib.PinElement(
      s.visited
        ? {
            background: "#ced4da",
            borderColor: "#868e96",
            glyphColor: "#212529",
            glyph: String(s.order),
          }
        : {
            background: "#0a5c43",
            borderColor: "#07472f",
            glyphColor: "#fff",
            glyph: String(s.order),
          },
    );
  }
  const markerTitle = (s: MapStop) => (s.visited ? `${s.label} (visited)` : s.label);

  // A check-off changes only `visited`, which doesn't remount the map (the
  // caller keys it on stop ids + positions, so `order` names the same stop
  // for this mount's lifetime); restyle the existing pins in place.
  $effect(() => {
    const byOrder = new Map(stops.map((s) => [s.order, s]));
    if (!mapReady) return;
    for (const { order, marker } of markers) {
      const s = byOrder.get(order);
      if (!s) continue;
      marker.content = pinFor(s).element;
      marker.title = markerTitle(s);
      marker.zIndex = s.visited ? 0 : 1;
    }
  });
  function toggleSatellite() {
    satellite = !satellite;
    map?.setMapTypeId(satellite ? "hybrid" : "roadmap");
  }

  onMount(async () => {
    if (!API_KEY) {
      loadError = "Google Maps key is not configured.";
      return;
    }
    try {
      const libs = await loadGoogleMaps(API_KEY, ["maps", "marker", "routes"]);
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const gmaps = (window as any).google.maps;
      markerLib = libs.marker as any;
      const { Map } = libs.maps as any;
      /* eslint-enable @typescript-eslint/no-explicit-any */

      const pts = stops.filter((s) => s.lat != null && s.lng != null);
      const center = pts[0] ?? anchor ?? extra ?? { lat: 39.5, lng: -98.35 };

      map = new Map(mapEl, {
        center: { lat: center.lat, lng: center.lng },
        zoom: pts.length || anchor ? 11 : 6,
        mapId: MAP_ID || undefined,
        gestureHandling: "greedy",
        zoomControlOptions: { position: gmaps.ControlPosition.RIGHT_BOTTOM },
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: false,
      });
      const info = new gmaps.InfoWindow({ maxWidth: 260 });
      const bounds = new gmaps.LatLngBounds();

      pts.forEach((s) => {
        const m = new markerLib.AdvancedMarkerElement({
          map,
          position: { lat: s.lat, lng: s.lng },
          title: markerTitle(s),
          content: pinFor(s).element,
          zIndex: s.visited ? 0 : 1,
        });
        markers.push({ order: s.order, marker: m });
        m.addListener("click", () => {
          // Read the current prop: the stop may have been checked off since.
          const visited = stops.find((x) => x.order === s.order)?.visited;
          info.setContent(
            `<b>${s.order}. ${escapeHtml(s.label)}</b>` +
              (visited ? `<div style="margin-top:4px">✓ Visited</div>` : "") +
              `<div style="margin-top:6px;display:flex;gap:14px;font-weight:600">` +
              `<a href="${mapsPlaceUrl({ name: s.label, lat: s.lat, lng: s.lng, google_place_id: s.googlePlaceId })}" target="_blank" rel="noopener" style="color:#0a5c43">📍 Map ↗</a>` +
              `<a href="${mapsDirectionsUrl({ name: s.label, lat: s.lat, lng: s.lng, google_place_id: s.googlePlaceId })}" target="_blank" rel="noopener" style="color:#084298">Directions ↗</a>` +
              `</div>`,
          );
          info.open({ map, anchor: m });
        });
        bounds.extend({ lat: s.lat, lng: s.lng });
      });

      if (anchor) {
        // "S" for start & end, in a colour no stop or search pin uses.
        const pin = new markerLib.PinElement({
          background: "#4a2c82",
          borderColor: "#2f1b55",
          glyphColor: "#fff",
          glyph: "S",
        });
        const am = new markerLib.AdvancedMarkerElement({
          map,
          position: { lat: anchor.lat, lng: anchor.lng },
          title: `Start & end: ${anchor.label}`,
          content: pin.element,
          zIndex: 2,
        });
        am.addListener("click", () => {
          info.setContent(
            `<b>Start &amp; end: ${escapeHtml(anchor.label)}</b>` +
              `<div style="margin-top:6px;font-weight:600">` +
              `<a href="${mapsDirectionsUrl({ name: anchor.label, lat: anchor.lat, lng: anchor.lng })}" target="_blank" rel="noopener" style="color:#084298">Directions ↗</a>` +
              `</div>`,
          );
          info.open({ map, anchor: am });
        });
        bounds.extend({ lat: anchor.lat, lng: anchor.lng });
      }

      if (extra) {
        const pin = new markerLib.PinElement({
          background: "#084298",
          borderColor: "#052c65",
          glyphColor: "#fff",
        });
        new markerLib.AdvancedMarkerElement({
          map,
          position: { lat: extra.lat, lng: extra.lng },
          title: extra.label,
          content: pin.element,
        });
        bounds.extend({ lat: extra.lat, lng: extra.lng });
      }

      // With an anchor the day is a loop: anchor -> stops -> anchor.
      const loop = anchor ? { lat: anchor.lat, lng: anchor.lng } : null;
      const path = [
        ...(loop ? [loop] : []),
        ...pts.map((s) => ({ lat: s.lat, lng: s.lng })),
        ...(loop ? [loop] : []),
      ];
      const drawStraightLine = () => {
        new gmaps.Polyline({
          map,
          path,
          strokeColor: "#0a5c43",
          strokeOpacity: 0.8,
          strokeWeight: 3,
        });
      };

      // Draw the REAL road route through the stops (in current order) so the
      // drive is visible — a straight line across a bridgeless bay is a lie.
      // Falls back to the straight line if Directions is unavailable.
      if (path.length - 2 > MAX_DIRECTIONS_WAYPOINTS) {
        // Google can't route this many stops in one request: say so rather
        // than silently drop the drive total.
        drawStraightLine();
        onSummary?.(null);
        routeNote = `Driving route and total unavailable: Google routes at most ${MAX_DIRECTIONS_WAYPOINTS} stops between the start and the end. Showing straight lines.`;
      } else if (pts.length >= 1 && path.length >= 2) {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const routesLib = libs.routes as any;
        /* eslint-enable @typescript-eslint/no-explicit-any */
        try {
          const svc = new routesLib.DirectionsService();
          const renderer = new routesLib.DirectionsRenderer({
            map,
            suppressMarkers: true,
            preserveViewport: true,
            polylineOptions: {
              strokeColor: "#0a5c43",
              strokeOpacity: 0.85,
              strokeWeight: 4,
            },
          });
          const res = await svc.route({
            origin: path[0],
            destination: path[path.length - 1],
            waypoints: path.slice(1, -1).map((p) => ({
              location: p,
              stopover: true,
            })),
            travelMode: "DRIVING",
          });
          renderer.setDirections(res);
          let meters = 0;
          let seconds = 0;
          for (const leg of res?.routes?.[0]?.legs ?? []) {
            meters += leg.distance?.value ?? 0;
            seconds += leg.duration?.value ?? 0;
          }
          onSummary?.({ km: meters / 1000, min: Math.round(seconds / 60) });
        } catch {
          drawStraightLine();
          onSummary?.(null);
        }
      } else {
        onSummary?.(null);
      }

      const multi = pts.length + (extra ? 1 : 0) + (anchor ? 1 : 0) >= 2;
      const applyView = () => {
        if (multi) map.fitBounds(bounds, 48);
        else {
          map.setCenter({ lat: center.lat, lng: center.lng });
          map.setZoom(pts.length || anchor ? 11 : 6);
        }
      };
      applyView();
      mapReady = true;

      // Vector (WebGL) maps can render blank until the container is composited.
      // Nudge a resize + re-apply the view once the map scrolls into view.
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          gmaps.event.trigger(map, "resize");
          applyView();
          io.disconnect();
        }
      });
      io.observe(mapEl);
    } catch (err) {
      loadError =
        err instanceof Error ? err.message : "Could not load the map.";
    }
  });
</script>

{#if loadError}
  <p class="err" role="alert">{loadError}</p>
{/if}
{#if routeNote}
  <p class="note">{routeNote}</p>
{/if}
<div class="map-wrap">
  <div class="map" bind:this={mapEl}></div>
  {#if mapReady}
    <button type="button" class="sat-toggle" onclick={toggleSatellite}>
      {satellite ? "🗺 Map" : "🛰 Satellite"}
    </button>
  {/if}
</div>

<style>
  .map-wrap {
    position: relative;
  }
  .sat-toggle {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 2;
    min-height: 0;
    padding: 6px 10px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 0.8rem;
    font-weight: 600;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
    cursor: pointer;
  }
  .sat-toggle:hover {
    background: var(--bg);
  }
  .map {
    color-scheme: light;
    color: #212529;
    --card: #ffffff;
    --text: #212529;
    height: 50vh;
    min-height: 300px;
    max-height: 460px;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--placeholder-bg);
  }
  .note {
    color: var(--muted);
    font-size: 0.85rem;
    margin-bottom: 8px;
  }
  .err {
    color: var(--danger);
    font-size: 0.85rem;
    font-weight: 600;
    margin-bottom: 8px;
  }
  @media (min-width: 1024px) {
    .map {
      height: 420px;
    }
  }
</style>
