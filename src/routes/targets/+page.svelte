<script lang="ts">
	import Badge from '$components/Badge.svelte';
	import BestPlaces from '$components/BestPlaces.svelte';
	import MapLink from '$components/MapLink.svelte';
	import ObsMap, { type ObsPoint } from '$components/ObsMap.svelte';
	import { formatKm } from '$lib/geo';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let showAllNeeds = $state(false);
	const NEEDS_PREVIEW = 25;
	let needsShown = $derived(
		data.view ? (showAllNeeds ? data.view.needs : data.view.needs.slice(0, NEEDS_PREVIEW)) : []
	);

	let mapCenter = $derived(data.location ? { lat: data.location.lat, lng: data.location.lng } : null);
	let mapPoints = $derived.by<ObsPoint[]>(() => {
		if (!data.view || !data.location) return [];
		const notableCodes = new Set(data.view.notable.map((n) => n.speciesCode));
		const pts: ObsPoint[] = [
			{ lat: data.location.lat, lng: data.location.lng, title: data.location.label, kind: 'home' }
		];
		for (const n of data.view.notable) {
			pts.push({
				lat: n.lastLat,
				lng: n.lastLng,
				title: n.comName,
				sub: ['Notable', n.locations[0]].filter(Boolean).join(' · '),
				href: `/species/${n.speciesCode}`,
				kind: 'notable'
			});
		}
		for (const n of data.view.needs) {
			if (notableCodes.has(n.speciesCode)) continue;
			pts.push({
				lat: n.lastLat,
				lng: n.lastLng,
				title: n.comName,
				sub: n.locations[0] ?? '',
				href: `/species/${n.speciesCode}`,
				kind: 'need'
			});
		}
		return pts;
	});
</script>

<svelte:head>
	<title>Targets — birds</title>
</svelte:head>

<div class="page">
	<header class="page-head">
		<h1>Targets</h1>
		<p class="sub">Your needs for a place, with live recent activity</p>
	</header>

	<section class="card">
		<form method="GET" class="filters">
			<label class="grow-field">
				<span>Place</span>
				<input
					type="text"
					name="place"
					placeholder="Search a city, county, park, or address…"
					value={data.location?.label ?? ''}
					list="place-suggestions"
				/>
				<datalist id="place-suggestions">
					{#each data.suggestions as s (s)}
						<option value={s}></option>
					{/each}
				</datalist>
			</label>
			<label>
				<span>Within</span>
				<select name="dist">
					{#each [10, 25, 50] as d (d)}
						<option value={d} selected={data.dist === d}>{d} km</option>
					{/each}
				</select>
			</label>
			<label>
				<span>Window</span>
				<select name="back">
					{#each [7, 14, 30] as d (d)}
						<option value={d} selected={data.back === d}>Last {d} days</option>
					{/each}
				</select>
			</label>
			<button type="submit">Search</button>
		</form>
		{#if data.location}
			<p class="muted loc">📍 {data.location.label} · within {data.dist} km · last {data.back} days</p>
		{/if}
	</section>

	{#if data.needsLocation}
		<section class="card">
			<p class="muted">
				Search a place above, or <a href="/settings">set your home location</a> to default to it.
			</p>
		</section>
	{/if}

	{#if data.view && mapCenter}
		<section class="card map-card">
			<ObsMap points={mapPoints} center={mapCenter} />
			<p class="legend">
				<span class="dot need"></span> need
				<span class="dot notable"></span> notable
				<span class="dot home"></span> searched location
			</p>
		</section>
	{/if}

	{#if data.error}
		<section class="card">
			<p class="muted">{data.error} {#if !data.location}<a href="/settings">Settings</a>{/if}</p>
		</section>
	{/if}

	{#if data.view}
		<section class="card">
			<h2>
				Rare this week <Badge kind="notable" label="Notable" />
				{#if data.view.stale}<Badge kind="stale" label="cached" />{/if}
			</h2>
			<p class="muted intro">
				eBird notable reports near {data.location?.label ?? 'here'} — last {data.back} days, whether
				or not they're on your needs list.
			</p>
			{#if data.view.notable.length === 0}
				<p class="muted">No notable reports in this window.</p>
			{/if}
			{#each data.view.notable as n (n.speciesCode)}
				<div class="obs">
					<div class="grow">
						<div class="name">
							<a href={`/species/${n.speciesCode}`}>{n.comName}</a>
							<Badge kind="notable" label="Notable" />
							{#if n.seen}<Badge kind="seen" label="Seen" />{:else}<Badge
									kind="need"
									label="Need"
								/>{/if}
						</div>
						<div class="meta">
							{n.locations.join(' · ')}
							{#if data.hasGallery && n.photoCount > 0}
								· 📷 you have {n.photoCount}
								{n.photoCount === 1 ? 'photo' : 'photos'}{/if}
						</div>
						<MapLink lat={n.lastLat} lng={n.lastLng} />
					</div>
					<div class="right">
						<div class="dist">{n.nReports} ×</div>
						<div class="when">{n.lastObsDt}</div>
					</div>
				</div>
			{/each}
		</section>

		<section class="card">
			<h2>{data.view.needs.length} needs reported here — last {data.back} days</h2>
			{#if data.view.seenCount === 0}
				<p class="muted">
					Your life list is empty, so every species counts as a need. Sync it in
					<a href="/settings">Settings</a>.
				</p>
			{/if}
			{#each needsShown as n (n.speciesCode)}
				<div class="obs">
					<div class="grow">
						<div class="name">
							<a href={`/species/${n.speciesCode}`}>{n.comName}</a>
							<Badge kind="need" label="Need" />
						</div>
						<div class="meta">
							{n.nReports}
							{n.nReports === 1 ? 'report' : 'reports'} · {n.locations.join(' · ')}
							{#if data.hasGallery && n.photoCount === 0}
								· 📷 no photo yet{/if}
						</div>
						<MapLink lat={n.lastLat} lng={n.lastLng} />
					</div>
					<div class="right">
						{#if n.distanceKm != null}<div class="dist">{formatKm(n.distanceKm)}</div>{/if}
						<div class="when">{n.lastObsDt}</div>
					</div>
				</div>
			{/each}
			{#if data.view.needs.length > NEEDS_PREVIEW}
				<button class="more" onclick={() => (showAllNeeds = !showAllNeeds)}>
					{showAllNeeds ? 'Show fewer' : `Show all ${data.view.needs.length} needs`}
				</button>
			{/if}
		</section>

		<BestPlaces places={data.view.bestPlaces} />
	{/if}

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
	.intro {
		margin-bottom: 8px;
	}
	.loc {
		margin-top: 10px;
		font-weight: 600;
	}
	.card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 16px;
		margin-bottom: 12px;
	}
	.card h2 {
		font-size: 1.05rem;
		margin-bottom: 10px;
	}
	.map-card {
		padding: 8px;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		align-items: center;
		font-size: 0.78rem;
		color: var(--muted);
		padding: 8px 4px 2px;
	}
	.dot {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		margin-right: 3px;
		vertical-align: middle;
	}
	.dot.need {
		background: #0a5c43;
	}
	.dot.notable {
		background: #842029;
	}
	.dot.home {
		background: #084298;
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: flex-end;
	}
	.filters label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
	}
	.filters .grow-field {
		flex: 1;
		min-width: 220px;
	}
	.filters input,
	.filters select {
		min-height: 48px;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
		color: var(--text);
	}
	.filters .grow-field input {
		width: 100%;
	}
	.filters button {
		min-height: 48px;
		padding: 10px 20px;
		border-radius: 8px;
		border: 1px solid var(--accent);
		background: var(--accent);
		color: #fff;
		font-weight: 600;
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
	.more {
		margin-top: 12px;
		min-height: 48px;
		padding: 10px 20px;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--card);
		color: var(--text);
		font-weight: 600;
	}
	.more:hover {
		background: var(--bg);
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
