<script lang="ts">
	import { enhance } from '$app/forms';
	import Badge from '$components/Badge.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let busy = $state('');

	function track(name: string) {
		return () => {
			busy = name;
			return async ({ update }: { update: () => Promise<void> }) => {
				await update();
				busy = '';
			};
		};
	}
</script>

<svelte:head>
	<title>Settings — birds</title>
</svelte:head>

<div class="page">
	<header class="page-head">
		<h1>Settings</h1>
		<p class="sub">eBird credentials, home location, and syncs</p>
	</header>

	{#if form && 'message' in form && form.message}
		<section class="card"><p class="ok">{form.message}</p></section>
	{/if}
	{#if form && 'error' in form && form.error}
		<section class="card"><p class="err" role="alert">{form.error}</p></section>
	{/if}

	<section class="card">
		<h2>
			eBird API key
			{#if data.ebird.api_key_set}<Badge kind="seen" label="saved" />{:else}<Badge
					kind="need"
					label="missing"
				/>{/if}
		</h2>
		<p class="muted">
			Free personal key from
			<a href="https://ebird.org/api/keygen" target="_blank" rel="noopener">ebird.org/api/keygen</a>.
			Stored encrypted; used for taxonomy, recent observations, and notables.
		</p>
		<form method="POST" action="?/save_api_key" use:enhance={track('key')}>
			<input
				type="password"
				name="api_key"
				placeholder={data.ebird.api_key_set ? '•••••••• (saved — enter to replace)' : 'eBird API key'}
				autocomplete="off"
			/>
			<button type="submit" disabled={busy === 'key'}>Save key</button>
		</form>
	</section>

	<section class="card">
		<h2>
			eBird account (life-list sync)
			{#if data.ebird.login_set}<Badge kind="seen" label="saved" />{:else}<Badge
					kind="need"
					label="missing"
				/>{/if}
		</h2>
		<p class="muted">
			Your eBird sign-in, stored encrypted, used only to fetch your life list (the public API has no
			life-list endpoint). This rides eBird's website login — if Cornell changes it, the sync fails
			soft and your last synced list keeps working.
		</p>
		<form method="POST" action="?/save_login" use:enhance={track('login')}>
			<input
				type="text"
				name="ebird_username"
				placeholder="eBird username"
				autocomplete="off"
				autocapitalize="none"
			/>
			<input type="password" name="ebird_password" placeholder="eBird password" autocomplete="off" />
			<button type="submit" disabled={busy === 'login'}>Save credentials</button>
		</form>
		<div class="syncrow">
			<form method="POST" action="?/sync_lifelist" use:enhance={track('lifelist')}>
				<button type="submit" disabled={busy === 'lifelist' || !data.ebird.login_set}>
					{busy === 'lifelist' ? 'Syncing… (logs into eBird)' : '⟳ Sync life list now'}
				</button>
			</form>
			<span class="muted">
				{#if data.ebird.life_list_synced_at}
					last sync {new Date(data.ebird.life_list_synced_at).toLocaleString()}
					{#if data.ebird.life_list_status === 'error'}
						<Badge kind="notable" label="error" /> {data.ebird.life_list_error}
					{/if}
				{:else}
					never synced
				{/if}
			</span>
		</div>
		<details>
			<summary>Fallback: import a CSV instead</summary>
			<p class="muted">
				eBird → My eBird → Download my data, or a life-list export. Replaces the synced list.
			</p>
			<form
				method="POST"
				action="?/import_csv"
				enctype="multipart/form-data"
				use:enhance={track('csv')}
			>
				<input type="file" name="csv" accept=".csv,text/csv" />
				<button type="submit" disabled={busy === 'csv'}>Import CSV</button>
			</form>
		</details>
	</section>

	<section class="card">
		<h2>Home location</h2>
		<p class="muted">Used for distances and the Near Me view.</p>
		<form method="POST" action="?/save_home" use:enhance={track('home')}>
			<input
				type="text"
				name="home_lat"
				inputmode="decimal"
				placeholder="Latitude"
				value={data.home.home_lat ?? ''}
			/>
			<input
				type="text"
				name="home_lon"
				inputmode="decimal"
				placeholder="Longitude"
				value={data.home.home_lon ?? ''}
			/>
			<button type="submit" disabled={busy === 'home'}>Save home</button>
		</form>
	</section>

	<section class="card">
		<h2>Data & syncs</h2>
		<div class="obs">
			<div class="grow">
				<div class="name">eBird taxonomy</div>
				<div class="meta">
					{data.taxonomyCount} taxa cached — needed for species matching. Re-sync quarterly.
				</div>
			</div>
			<form method="POST" action="?/sync_taxonomy" use:enhance={track('tax')}>
				<button type="submit" disabled={busy === 'tax' || !data.ebird.api_key_set}>
					{busy === 'tax' ? 'Syncing…' : '⟳ Sync'}
				</button>
			</form>
		</div>
		<div class="obs">
			<div class="grow">
				<div class="name">Life list</div>
				<div class="meta">
					{#each data.seenBySource as s (s.source)}
						{s.n} via {s.source}&ensp;
					{:else}
						empty
					{/each}
				</div>
			</div>
		</div>
		<div class="obs">
			<div class="grow">
				<div class="name">Gallery links (gaylon.photos)</div>
				<div class="meta">{data.photoTotal} photos, {data.photoMatched} matched to species</div>
			</div>
			<form method="POST" action="?/sync_gallery" use:enhance={track('gallery')}>
				<button type="submit" disabled={busy === 'gallery'}>
					{busy === 'gallery' ? 'Syncing…' : '⟳ Sync'}
				</button>
			</form>
		</div>
	</section>

	<section class="card">
		<h2>Session</h2>
		<form method="POST" action="/login?/logout">
			<button type="submit" class="danger">Sign out</button>
		</form>
	</section>
</div>

<style>
	.page {
		max-width: 720px;
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
	.card h2 {
		font-size: 1.05rem;
		margin-bottom: 8px;
	}
	.card p.muted {
		margin-bottom: 10px;
	}
	form {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		align-items: center;
	}
	input[type='text'],
	input[type='password'],
	input[type='file'] {
		flex: 1;
		min-width: 200px;
		min-height: 48px;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg);
		color: var(--text);
	}
	button {
		min-height: 48px;
		padding: 10px 18px;
		border-radius: 8px;
		border: 1px solid var(--accent);
		background: var(--accent);
		color: #fff;
		font-weight: 600;
	}
	button:disabled {
		opacity: 0.5;
	}
	button.danger {
		background: var(--card);
		border-color: #d9a5ab;
		color: var(--danger);
	}
	.syncrow {
		display: flex;
		gap: 12px;
		align-items: center;
		flex-wrap: wrap;
		margin-top: 12px;
	}
	details {
		margin-top: 12px;
	}
	details summary {
		cursor: pointer;
		color: var(--muted);
		font-size: 0.89rem;
		min-height: 44px;
		display: flex;
		align-items: center;
	}
	details form {
		margin-top: 8px;
	}
	.obs {
		display: flex;
		align-items: center;
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
	.meta {
		color: var(--muted);
		font-size: 0.83rem;
		margin-top: 2px;
	}
	.ok {
		color: var(--seen-text);
		font-weight: 600;
	}
	.err {
		color: var(--danger);
		font-weight: 600;
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
