<script lang="ts">
	import { enhance } from '$app/forms';
	import Badge from '$components/Badge.svelte';
	import ObsMap from '$components/ObsMap.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let syncing = $state(false);

	const unmatchedCount = $derived(data.unmatched.reduce((n, u) => n + u.photos.length, 0));
</script>

<svelte:head>
	<title>My Photos — birds</title>
</svelte:head>

<div class="page">
	<header class="page-head">
		<h1>My Photos</h1>
		<p class="sub">
			{data.total} photos synced from
			<a href="https://gaylon.photos/birds" target="_blank" rel="noopener">gaylon.photos/birds</a>
			{#if data.fetchedAt}· refreshed {new Date(data.fetchedAt).toLocaleString()}{/if}
		</p>
	</header>

	<section class="card toolbar">
		{#if data.canEdit}
			<form
				method="POST"
				action="?/refresh"
				use:enhance={() => {
					syncing = true;
					return async ({ update }) => {
						await update();
						syncing = false;
					};
				}}
			>
				<button type="submit" disabled={syncing}>
					{syncing ? 'Syncing…' : '⟳ Refresh from gaylon.photos'}
				</button>
			</form>
		{/if}
		<a class="btn" href="https://gaylon.photos/birds" target="_blank" rel="noopener"
			>View full collection ↗</a
		>
		{#if unmatchedCount > 0}<Badge kind="unmatched" label={`${unmatchedCount} unmatched`} />{/if}
		<span class="muted note"
			>No uploads here — photos live on gaylon.photos. New shots appear after the next sync.</span
		>
	</section>

	{#if form && 'message' in form && form.message}
		<section class="card"><p class="ok">{form.message}</p></section>
	{/if}
	{#if form && 'error' in form && form.error}
		<section class="card"><p class="err" role="alert">{form.error}</p></section>
	{/if}

	{#if data.total === 0}
		<section class="card">
			<p class="muted">
				Nothing synced yet. Hit “Refresh from gaylon.photos” — and make sure the taxonomy is synced
				in <a href="/settings">Settings</a> so species names can be matched.
			</p>
		</section>
	{/if}

	{#if data.photoPoints.length > 0}
		<section class="card map-card">
			<h2 class="map-title">
				🗺️ Where you've shot — {data.photoPoints.length} geotagged {data.photoPoints.length === 1 ? 'photo' : 'photos'}
			</h2>
			<ObsMap points={data.photoPoints} />
		</section>
	{/if}

	{#each data.groups as g (g.speciesCode)}
		<section class="card group">
			<div class="group-head">
				<h3><a href={`/species/${g.speciesCode}`}>{g.comName}</a></h3>
				{#if g.sciName}<span class="sci">{g.sciName}</span>{/if}
				<span class="count">{g.photos.length} {g.photos.length === 1 ? 'photo' : 'photos'}</span>
			</div>
			<div class="grid">
				{#each g.photos as p (p.photo_id)}
					<a href={p.page_url} target="_blank" rel="noopener">
						<img loading="lazy" src={p.thumbnail} alt={g.comName} />
					</a>
				{/each}
			</div>
		</section>
	{/each}

	{#if data.unmatched.length > 0}
		<section class="card">
			<h2>Unmatched photos <Badge kind="unmatched" label="needs your help" /></h2>
			<p class="muted intro">
				These names from gaylon.photos didn't match the eBird taxonomy. Pick the right species once
				— the override is remembered for future syncs.
			</p>
			{#each data.unmatched as u (u.name)}
				<div class="group">
					<div class="group-head">
						<h3>“{u.name}”</h3>
						<span class="count">{u.photos.length} {u.photos.length === 1 ? 'photo' : 'photos'}</span>
					</div>
					<div class="grid small">
						{#each u.photos as p (p.photo_id)}
							<a href={p.page_url} target="_blank" rel="noopener">
								<img loading="lazy" src={p.thumbnail} alt={`Unmatched: ${u.name}`} />
							</a>
						{/each}
					</div>
					{#if u.name === '(no species set)'}
						<p class="muted">
							Best fixed at the source —
							<a href="https://gaylon.photos/birds" target="_blank" rel="noopener"
								>tag them on gaylon.photos ↗</a
							> and re-sync.
						</p>
					{:else if data.canEdit}
						<form method="POST" action="?/override" use:enhance class="override">
							<input type="hidden" name="source_name" value={u.name} />
							<input
								type="text"
								name="species"
								placeholder="Exact eBird common name, scientific name, or code…"
								required
							/>
							<button type="submit">Match species</button>
						</form>
					{/if}
				</div>
			{/each}
		</section>
	{/if}

	<p class="attribution">
		Photos hosted on
		<a href="https://gaylon.photos/birds" target="_blank" rel="noopener">gaylon.photos</a> · species
		data from <a href="https://ebird.org" target="_blank" rel="noopener">eBird.org</a>
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
		margin-bottom: 12px;
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
	.map-title {
		font-size: 1rem;
		margin: 4px 8px 8px;
	}
	.toolbar {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		align-items: center;
	}
	.toolbar button,
	.btn {
		min-height: 44px;
		padding: 8px 14px;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--card);
		color: var(--text);
		font-weight: 600;
		font-size: 0.85rem;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
	}
	.toolbar button:hover,
	.btn:hover {
		background: var(--bg);
	}
	.toolbar button:disabled {
		opacity: 0.5;
	}
	.note {
		font-size: 0.83rem;
	}
	.ok {
		color: var(--seen-text);
		font-weight: 600;
	}
	.err {
		color: var(--danger);
		font-weight: 600;
	}
	.group {
		margin-bottom: 8px;
	}
	.group-head {
		display: flex;
		align-items: baseline;
		gap: 10px;
		margin-bottom: 8px;
		flex-wrap: wrap;
	}
	.group-head h3 {
		font-size: 1rem;
	}
	.group-head h3 a {
		color: var(--text);
	}
	.sci {
		color: var(--muted);
		font-style: italic;
		font-size: 0.83rem;
	}
	.count {
		color: var(--muted);
		font-size: 0.83rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 8px;
	}
	.grid.small {
		max-width: 420px;
	}
	.grid a {
		display: block;
		border-radius: 8px;
		overflow: hidden;
		border: 1px solid var(--border);
		background: #dde3e8;
	}
	.grid img {
		display: block;
		width: 100%;
		aspect-ratio: 4/3;
		object-fit: cover;
	}
	.override {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 8px;
	}
	.override input[type='text'] {
		flex: 1;
		min-width: 240px;
		min-height: 48px;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
		color: var(--text);
	}
	.override button {
		min-height: 48px;
		padding: 10px 16px;
		border-radius: 8px;
		border: 1px solid var(--accent);
		background: var(--accent);
		color: #fff;
		font-weight: 600;
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
		.grid {
			grid-template-columns: repeat(3, 1fr);
		}
	}
	@media (min-width: 1024px) {
		.grid {
			grid-template-columns: repeat(4, 1fr);
		}
	}
</style>
