<script lang="ts">
	import Badge from '$components/Badge.svelte';
	import BestPlaces from '$components/BestPlaces.svelte';
	import MapLink from '$components/MapLink.svelte';
	import ObsMap, { type ObsPoint } from '$components/ObsMap.svelte';
	import { formatKm } from '$lib/geo';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let homeCenter = $derived(data.home ? { lat: data.home.lat, lng: data.home.lon } : null);
	let mapPoints = $derived<ObsPoint[]>([
		...(data.home ? [{ lat: data.home.lat, lng: data.home.lon, title: 'Home', kind: 'home' as const }] : []),
		...data.needs.map((n) => ({
			lat: n.lastLat,
			lng: n.lastLng,
			title: n.comName,
			sub: [n.locations[0], n.distanceKm != null ? formatKm(n.distanceKm) : null]
				.filter(Boolean)
				.join(' · '),
			href: `/species/${n.speciesCode}`,
			kind: 'need' as const
		}))
	]);
</script>

<svelte:head>
	<title>Near Me — birds</title>
</svelte:head>

<div class="page">
	<header class="page-head">
		<h1>Near Me</h1>
		<p class="sub">
			{#if data.home}
				Home: {data.home.lat.toFixed(3)}, {data.home.lon.toFixed(3)} · radius {data.distKm} km ·
				<a href="/settings">change</a>
			{:else}
				No home location saved — <a href="/settings">set it in Settings</a>
			{/if}
		</p>
	</header>

	{#if data.home && data.hasApiKey && !data.needsError}
		<section class="card map-card">
			<ObsMap points={mapPoints} center={homeCenter} />
		</section>
	{/if}

	{#if !data.hasApiKey}
		<section class="card">
			<h2>Get set up</h2>
			<p class="muted">
				Add your eBird API key in <a href="/settings">Settings</a> to see your needs reported nearby.
			</p>
		</section>
	{:else if data.needsError}
		<section class="card">
			<h2>Your needs reported nearby</h2>
			<p class="muted">{data.needsError}</p>
		</section>
	{:else if data.home}
		<section class="card">
			<h2>
				Your needs reported nearby — last {data.backDays} days
				{#if data.stale}<Badge kind="stale" label="cached" />{/if}
			</h2>
			{#if data.needs.length === 0}
				<p class="muted">
					No unseen species reported within {data.distKm} km this week.
					{#if data.seenCount === 0}Import your life list in <a href="/settings">Settings</a> first —
						otherwise everything counts as a need.{/if}
				</p>
			{/if}
			{#each data.needs as n (n.speciesCode)}
				<div class="obs">
					<div class="grow">
						<div class="name">
							<a href={`/species/${n.speciesCode}`}>{n.comName}</a>
							<Badge kind="need" label="Need" />
						</div>
						<div class="meta">
							{n.locations.join(' · ')} · {n.nReports}
							{n.nReports === 1 ? 'report' : 'reports'} · {n.totalCount} birds
						</div>
						<MapLink lat={n.lastLat} lng={n.lastLng} />
					</div>
					<div class="right">
						{#if n.distanceKm != null}<div class="dist">{formatKm(n.distanceKm)}</div>{/if}
						<div class="when">{n.lastObsDt}</div>
					</div>
				</div>
			{/each}
		</section>
	{/if}

	<BestPlaces places={data.bestPlaces} title="Best places near you" limit={6} />

	<section class="card">
		<h2>At a glance</h2>
		<div class="obs">
			<div class="grow">
				<div class="name">Life list</div>
				<div class="meta">
					{#if data.lifeListSyncedAt}
						synced from eBird {new Date(data.lifeListSyncedAt).toLocaleString()}
						{#if data.lifeListStatus === 'error'}<Badge kind="notable" label="sync error" />{/if}
					{:else}
						not synced yet — <a href="/settings">Settings</a>
					{/if}
				</div>
			</div>
			<div class="right"><div class="dist">{data.seenCount}</div></div>
		</div>
		{#if data.hasGallery}
			<div class="obs">
				<div class="grow">
					<div class="name">Photos on gaylon.photos</div>
					<div class="meta"><a href="/photos">My Photos</a></div>
				</div>
				<div class="right"><div class="dist">{data.photoCount}</div></div>
			</div>
		{/if}
	</section>

	<p class="attribution">
		Data from <a href="https://ebird.org" target="_blank" rel="noopener">eBird.org</a>
	</p>
</div>

<style>
	.page {
		max-width: 1100px;
		margin: 0 auto;
		padding: 16px;
	}
	.page-head {
		margin: 4px 0 16px;
	}
	h1 {
		font-size: 1.4rem;
	}
	.sub,
	.muted {
		color: var(--muted);
		font-size: 0.89rem;
	}
	.card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 16px;
		margin-bottom: 12px;
	}
	.map-card {
		padding: 8px;
	}
	.card h2 {
		font-size: 1.05rem;
		margin-bottom: 10px;
	}
	.obs {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 12px 0;
		border-top: 1px solid var(--border);
	}
	.obs:first-of-type {
		border-top: none;
	}
	.grow {
		flex: 1;
		min-width: 0;
	}
	.name {
		font-weight: 700;
	}
	.name a {
		color: var(--text);
		text-decoration: none;
	}
	.name a:hover {
		text-decoration: underline;
	}
	.meta {
		color: var(--muted);
		font-size: 0.83rem;
		margin-top: 2px;
	}
	.right {
		text-align: right;
		flex-shrink: 0;
	}
	.dist {
		font-weight: 700;
		color: var(--accent);
		white-space: nowrap;
	}
	.when {
		color: var(--muted);
		font-size: 0.78rem;
	}
	.attribution {
		text-align: center;
		color: var(--muted);
		font-size: 0.78rem;
		padding: 20px 0 8px;
	}
	.attribution a {
		color: var(--muted);
	}
	@media (min-width: 640px) {
		.page {
			padding: 24px;
		}
		h1 {
			font-size: 1.6rem;
		}
	}
</style>
