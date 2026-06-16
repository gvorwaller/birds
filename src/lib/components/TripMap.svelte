<script lang="ts">
	import { onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { loadGoogleMaps } from '$lib/google-maps';
	import { mapsPlaceUrl, mapsDirectionsUrl } from '$lib/geo';

	function escapeHtml(s: string): string {
		return s.replace(
			/[&<>"']/g,
			(c) =>
				({
					'&': '&amp;',
					'<': '&lt;',
					'>': '&gt;',
					'"': '&quot;',
					"'": '&#39;',
				})[c]!,
		);
	}

	export interface MapStop {
		lat: number;
		lng: number;
		label: string;
		order: number;
	}

	let {
		stops = [],
		extra = null,
		onSummary,
	}: {
		stops?: MapStop[];
		extra?: MapStop | null;
		/** Reports total driving distance/time of the drawn route, or null if it fell back to a straight line. */
		onSummary?: (s: { km: number; min: number } | null) => void;
	} = $props();

	const API_KEY = env.PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
	const MAP_ID = env.PUBLIC_GOOGLE_MAPS_MAP_ID ?? '';

	let mapEl: HTMLDivElement;
	let loadError = $state('');

	// On-demand satellite view on the existing vector map (no extra API/cost):
	// 'hybrid' = satellite imagery + labels, 'roadmap' = the styled base map.
	/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
	let map: any = null;
	let satellite = $state(false);
	let mapReady = $state(false);
	function toggleSatellite() {
		satellite = !satellite;
		map?.setMapTypeId(satellite ? 'hybrid' : 'roadmap');
	}

	onMount(async () => {
		if (!API_KEY) {
			loadError = 'Google Maps key is not configured.';
			return;
		}
		try {
			const libs = await loadGoogleMaps(API_KEY, ['maps', 'marker', 'routes']);
			/* eslint-disable @typescript-eslint/no-explicit-any */
			const gmaps = (window as any).google.maps;
			const markerLib = libs.marker as any;
			const { Map } = libs.maps as any;
			/* eslint-enable @typescript-eslint/no-explicit-any */

			const pts = stops.filter((s) => s.lat != null && s.lng != null);
			const center = pts[0] ?? extra ?? { lat: 39.5, lng: -98.35 };

			map = new Map(mapEl, {
				center: { lat: center.lat, lng: center.lng },
				zoom: pts.length ? 11 : 6,
				mapId: MAP_ID || undefined,
				gestureHandling: 'greedy',
				zoomControlOptions: { position: gmaps.ControlPosition.RIGHT_BOTTOM },
				streetViewControl: false,
				mapTypeControl: false,
				fullscreenControl: false,
			});
			const info = new gmaps.InfoWindow({ maxWidth: 260 });
			const bounds = new gmaps.LatLngBounds();

			pts.forEach((s) => {
				const pin = new markerLib.PinElement({
					background: '#0a5c43',
					borderColor: '#07472f',
					glyphColor: '#fff',
					glyph: String(s.order),
				});
				const m = new markerLib.AdvancedMarkerElement({
					map,
					position: { lat: s.lat, lng: s.lng },
					title: s.label,
					content: pin.element,
				});
				m.addListener('click', () => {
					info.setContent(
						`<b>${s.order}. ${escapeHtml(s.label)}</b>` +
							`<div style="margin-top:6px;display:flex;gap:14px;font-weight:600">` +
							`<a href="${mapsPlaceUrl(s.lat, s.lng)}" target="_blank" rel="noopener" style="color:#0a5c43">📍 Map ↗</a>` +
							`<a href="${mapsDirectionsUrl(s.lat, s.lng)}" target="_blank" rel="noopener" style="color:#084298">Directions ↗</a>` +
							`</div>`,
					);
					info.open({ map, anchor: m });
				});
				bounds.extend({ lat: s.lat, lng: s.lng });
			});

			if (extra) {
				const pin = new markerLib.PinElement({
					background: '#084298',
					borderColor: '#052c65',
					glyphColor: '#fff',
				});
				new markerLib.AdvancedMarkerElement({
					map,
					position: { lat: extra.lat, lng: extra.lng },
					title: extra.label,
					content: pin.element,
				});
				bounds.extend({ lat: extra.lat, lng: extra.lng });
			}

			const drawStraightLine = () => {
				new gmaps.Polyline({
					map,
					path: pts.map((s) => ({ lat: s.lat, lng: s.lng })),
					strokeColor: '#0a5c43',
					strokeOpacity: 0.8,
					strokeWeight: 3,
				});
			};

			// Draw the REAL road route through the stops (in current order) so the
			// drive is visible — a straight line across a bridgeless bay is a lie.
			// Falls back to the straight line if Directions is unavailable.
			if (pts.length >= 2) {
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
							strokeColor: '#0a5c43',
							strokeOpacity: 0.85,
							strokeWeight: 4,
						},
					});
					const res = await svc.route({
						origin: { lat: pts[0].lat, lng: pts[0].lng },
						destination: {
							lat: pts[pts.length - 1].lat,
							lng: pts[pts.length - 1].lng,
						},
						waypoints: pts.slice(1, -1).map((s) => ({
							location: { lat: s.lat, lng: s.lng },
							stopover: true,
						})),
						travelMode: 'DRIVING',
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

			const multi = pts.length + (extra ? 1 : 0) >= 2;
			const applyView = () => {
				if (multi) map.fitBounds(bounds, 48);
				else {
					map.setCenter({ lat: center.lat, lng: center.lng });
					map.setZoom(pts.length ? 11 : 6);
				}
			};
			applyView();
			mapReady = true;

			// Vector (WebGL) maps can render blank until the container is composited.
			// Nudge a resize + re-apply the view once the map scrolls into view.
			const io = new IntersectionObserver((entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					gmaps.event.trigger(map, 'resize');
					applyView();
					io.disconnect();
				}
			});
			io.observe(mapEl);
		} catch (err) {
			loadError =
				err instanceof Error ? err.message : 'Could not load the map.';
		}
	});
</script>

{#if loadError}
	<p class="err" role="alert">{loadError}</p>
{/if}
<div class="map-wrap">
	<div class="map" bind:this={mapEl}></div>
	{#if mapReady}
		<button type="button" class="sat-toggle" onclick={toggleSatellite}>
			{satellite ? '🗺 Map' : '🛰 Satellite'}
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
		height: 50vh;
		min-height: 300px;
		max-height: 460px;
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
		background: #dde3e8;
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
