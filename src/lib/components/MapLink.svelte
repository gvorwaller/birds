<script lang="ts">
	import { mapsPlaceUrl, mapsDirectionsUrl } from '$lib/geo';

	// A compact pair of links for a spotting location: "📍 Map" opens the spot in
	// Google Maps; "Directions ↗" hands off to turn-by-turn from the device's
	// location. Renders nothing if coordinates are missing/invalid.
	let { lat, lng }: { lat?: number | null; lng?: number | null } = $props();

	let ok = $derived(
		typeof lat === 'number' &&
			typeof lng === 'number' &&
			Number.isFinite(lat) &&
			Number.isFinite(lng)
	);
</script>

{#if ok}
	<span class="maplink">
		<a
			href={mapsPlaceUrl(lat as number, lng as number)}
			target="_blank"
			rel="noopener"
			title="Show this spot on Google Maps">📍 Map</a
		>
		<a
			href={mapsDirectionsUrl(lat as number, lng as number)}
			target="_blank"
			rel="noopener"
			title="Directions to this spot in Google Maps">Directions ↗</a
		>
	</span>
{/if}

<style>
	.maplink {
		display: inline-flex;
		gap: 14px;
		margin-top: 4px;
		font-size: 0.8rem;
		font-weight: 600;
	}
	.maplink a {
		color: var(--link);
		text-decoration: none;
		white-space: nowrap;
		min-height: 32px;
		display: inline-flex;
		align-items: center;
	}
	.maplink a:hover {
		text-decoration: underline;
	}
</style>
