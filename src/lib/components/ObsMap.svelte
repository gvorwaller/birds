<script lang="ts" module>
	export interface ObsPoint {
		lat: number;
		lng: number;
		title: string;
		sub?: string;
		href?: string;
		linkText?: string;
		img?: string;
		kind?: 'need' | 'notable' | 'home' | 'photo';
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { loadGoogleMaps } from '$lib/google-maps';
	import { mapsPlaceUrl, mapsDirectionsUrl } from '$lib/geo';

	let {
		points = [],
		center = null,
	}: { points?: ObsPoint[]; center?: { lat: number; lng: number } | null } =
		$props();

	const API_KEY = env.PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
	const MAP_ID = env.PUBLIC_GOOGLE_MAPS_MAP_ID ?? '';

	const COLORS = {
		need: { background: '#0a5c43', borderColor: '#07472f', glyphColor: '#fff' },
		notable: {
			background: '#842029',
			borderColor: '#58151c',
			glyphColor: '#fff',
		},
		home: { background: '#084298', borderColor: '#052c65', glyphColor: '#fff' },
		photo: {
			background: '#6f42c1',
			borderColor: '#4d2d89',
			glyphColor: '#fff',
		},
	};

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

			const pts = points.filter(
				(p) => Number.isFinite(p.lat) && Number.isFinite(p.lng),
			);
			const start = center ?? pts[0] ?? { lat: 39.5, lng: -98.35 };

			map = new Map(mapEl, {
				center: { lat: start.lat, lng: start.lng },
				zoom: pts.length ? 10 : 6,
				mapId: MAP_ID || undefined,
				gestureHandling: 'greedy',
				zoomControlOptions: { position: gmaps.ControlPosition.RIGHT_BOTTOM },
				streetViewControl: false,
				mapTypeControl: false,
				fullscreenControl: false,
			});
			const info = new gmaps.InfoWindow({ maxWidth: 260 });
			const bounds = new gmaps.LatLngBounds();
			if (center) bounds.extend(center);

			for (const p of pts) {
				const pin = new markerLib.PinElement(COLORS[p.kind ?? 'need']);
				const m = new markerLib.AdvancedMarkerElement({
					map,
					position: { lat: p.lat, lng: p.lng },
					title: p.title,
					content: pin.element,
				});
				m.addListener('click', () => {
					const img = p.img
						? `<img src="${encodeURI(p.img)}" alt="" loading="lazy" style="width:100%;max-width:220px;border-radius:6px;display:block;margin-bottom:6px">`
						: '';
					const link = p.href
						? `<br><a href="${encodeURI(p.href)}" style="color:#084298;font-weight:600">${escapeHtml(p.linkText ?? 'View species →')}</a>`
						: '';
					// Home marker doesn't need "directions to home".
					const maps =
						p.kind === 'home'
							? ''
							: `<div style="margin-top:6px;display:flex;gap:14px;font-weight:600">` +
								`<a href="${mapsPlaceUrl(p.lat, p.lng)}" target="_blank" rel="noopener" style="color:#0a5c43">📍 Map ↗</a>` +
								`<a href="${mapsDirectionsUrl(p.lat, p.lng)}" target="_blank" rel="noopener" style="color:#084298">Directions ↗</a>` +
								`</div>`;
					info.setContent(
						`${img}<b>${escapeHtml(p.title)}</b>${p.sub ? `<br>${escapeHtml(p.sub)}` : ''}${link}${maps}`,
					);
					info.open({ map, anchor: m });
				});
				bounds.extend({ lat: p.lat, lng: p.lng });
			}

			const total = pts.length + (center ? 1 : 0);
			const applyView = () => {
				if (total >= 2) map.fitBounds(bounds, 56);
				else {
					map.setCenter({ lat: start.lat, lng: start.lng });
					map.setZoom(pts.length ? 11 : 6);
				}
			};
			applyView();
			mapReady = true;

			// WebGL vector maps can render blank until composited — nudge on first visibility.
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
		height: 100%;
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
		height: 42vh;
		min-height: 260px;
		max-height: 420px;
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
			height: 100%;
			min-height: 420px;
		}
	}
</style>
