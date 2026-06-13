<script lang="ts">
	import { onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { loadGoogleMaps } from '$lib/google-maps';

	export interface MapStop {
		lat: number;
		lng: number;
		label: string;
		order: number;
	}

	let { stops = [], extra = null }: { stops?: MapStop[]; extra?: MapStop | null } = $props();

	const API_KEY = env.PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
	const MAP_ID = env.PUBLIC_GOOGLE_MAPS_MAP_ID ?? '';

	let mapEl: HTMLDivElement;
	let loadError = $state('');

	onMount(async () => {
		if (!API_KEY) {
			loadError = 'Google Maps key is not configured.';
			return;
		}
		try {
			const libs = await loadGoogleMaps(API_KEY, ['maps', 'marker']);
			/* eslint-disable @typescript-eslint/no-explicit-any */
			const gmaps = (window as any).google.maps;
			const markerLib = libs.marker as any;
			const { Map } = libs.maps as any;
			/* eslint-enable @typescript-eslint/no-explicit-any */

			const pts = stops.filter((s) => s.lat != null && s.lng != null);
			const center = pts[0] ?? extra ?? { lat: 39.5, lng: -98.35 };

			const map = new Map(mapEl, {
				center: { lat: center.lat, lng: center.lng },
				zoom: pts.length ? 11 : 6,
				mapId: MAP_ID || undefined,
				gestureHandling: 'greedy',
				zoomControlOptions: { position: gmaps.ControlPosition.RIGHT_BOTTOM },
				streetViewControl: false,
				mapTypeControl: false,
				fullscreenControl: false
			});
			const info = new gmaps.InfoWindow({ maxWidth: 260 });
			const bounds = new gmaps.LatLngBounds();

			pts.forEach((s) => {
				const pin = new markerLib.PinElement({
					background: '#0a5c43',
					borderColor: '#07472f',
					glyphColor: '#fff',
					glyph: String(s.order)
				});
				const m = new markerLib.AdvancedMarkerElement({
					map,
					position: { lat: s.lat, lng: s.lng },
					title: s.label,
					content: pin.element
				});
				m.addListener('click', () => {
					info.setContent(`<b>${s.order}. ${s.label}</b>`);
					info.open({ map, anchor: m });
				});
				bounds.extend({ lat: s.lat, lng: s.lng });
			});

			if (extra) {
				const pin = new markerLib.PinElement({
					background: '#084298',
					borderColor: '#052c65',
					glyphColor: '#fff'
				});
				new markerLib.AdvancedMarkerElement({
					map,
					position: { lat: extra.lat, lng: extra.lng },
					title: extra.label,
					content: pin.element
				});
				bounds.extend({ lat: extra.lat, lng: extra.lng });
			}

			if (pts.length >= 2) {
				new gmaps.Polyline({
					map,
					path: pts.map((s) => ({ lat: s.lat, lng: s.lng })),
					strokeColor: '#0a5c43',
					strokeOpacity: 0.8,
					strokeWeight: 3
				});
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
			loadError = err instanceof Error ? err.message : 'Could not load the map.';
		}
	});
</script>

{#if loadError}
	<p class="err" role="alert">{loadError}</p>
{/if}
<div class="map" bind:this={mapEl}></div>

<style>
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
