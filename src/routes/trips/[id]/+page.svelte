<script lang="ts">
	import { enhance } from '$app/forms';
	import Badge from '$components/Badge.svelte';
	import TripMap, { type MapStop } from '$components/TripMap.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let editing = $state(false);
	let deleteOpen = $state(false);

	let mapStops = $derived<MapStop[]>(
		data.stops
			.filter((s) => s.lat != null && s.lon != null)
			.map((s, i) => ({
				lat: s.lat as number,
				lng: s.lon as number,
				label: s.custom_name ?? s.hotspot_id ?? 'Stop',
				order: i + 1
			}))
	);
	let mapExtra = $derived<MapStop | null>(
		data.hsCenter ? { lat: data.hsCenter.lat, lng: data.hsCenter.lng, label: data.hsCenter.label, order: 0 } : null
	);

	function fmtDates(start: string | null, end: string | null): string {
		if (!start && !end) return 'no dates set';
		const f = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString();
		if (start && end) return start === end ? f(start) : `${f(start)} – ${f(end)}`;
		return f((start ?? end) as string);
	}
</script>

<svelte:head>
	<title>{data.trip.name} — birds</title>
</svelte:head>

<div class="page">
	<header class="page-head">
		<p class="sub"><a href="/trips">← Trips</a></p>
		<div class="title-row">
			<h1>{data.trip.name}</h1>
			<button class="link" onclick={() => (editing = !editing)}>{editing ? 'Close' : 'Edit'}</button>
			<a class="link" href={`/trips/${data.trip.id}/export`} data-sveltekit-reload>⬇ Export</a>
		</div>
		<p class="sub">{fmtDates(data.trip.start_date, data.trip.end_date)} · {data.stops.length} {data.stops.length === 1 ? 'stop' : 'stops'}</p>
		{#if data.trip.notes && !editing}<p class="notes">{data.trip.notes}</p>{/if}
	</header>

	{#if form && 'message' in form && form.message}
		<section class="card"><p class="ok">{form.message}</p></section>
	{/if}
	{#if form && 'error' in form && form.error}
		<section class="card"><p class="err" role="alert">{form.error}</p></section>
	{/if}

	{#if editing}
		<section class="card">
			<h2>Edit trip</h2>
			<form method="POST" action="?/update_trip" use:enhance={() => async ({ update }) => { await update(); editing = false; }}>
				<label class="grow-field"><span>Name</span>
					<input type="text" name="name" value={data.trip.name} required />
				</label>
				<label><span>Start</span><input type="date" name="start_date" value={data.trip.start_date ?? ''} /></label>
				<label><span>End</span><input type="date" name="end_date" value={data.trip.end_date ?? ''} /></label>
				<label class="grow-field"><span>Notes</span>
					<textarea name="notes" rows="2" placeholder="Trip notes…">{data.trip.notes ?? ''}</textarea>
				</label>
				<button type="submit">Save</button>
			</form>
		</section>
	{/if}

	{#if mapStops.length > 0 || mapExtra}
		<section class="card map-card">
			{#key mapStops.map((s) => `${s.lat},${s.lng}`).join('|') + (mapExtra ? `+${mapExtra.lat}` : '')}
				<TripMap stops={mapStops} extra={mapExtra} />
			{/key}
		</section>
	{/if}

	<section class="card">
		<h2>Stops</h2>
		{#if data.stops.length === 0}
			<p class="muted">No stops yet — add one below.</p>
		{/if}
		{#each data.stops as s, i (s.id)}
			<div class="stop">
				<div class="ordnum">{i + 1}</div>
				<div class="grow">
					<div class="name">
						{s.custom_name ?? 'Stop'}
						{#if s.hotspot_id}<Badge kind="seen" label="hotspot" />{/if}
					</div>
					<div class="meta">
						{#if !data.hasApiKey}
							<a href="/settings">add eBird key</a> for needs counts
						{:else if data.needsCounts[String(s.id)] !== undefined}
							{data.needsCounts[String(s.id)]} of your needs reported here · last 14 days, ≤16 km
							{#if data.needsStale}<Badge kind="stale" label="cached" />{/if}
						{:else}
							—
						{/if}
					</div>
					{#if s.notes}<div class="stopnote">{s.notes}</div>{/if}
					<details class="noteedit">
						<summary>{s.notes ? 'Edit note' : 'Add note'}</summary>
						<form method="POST" action="?/save_notes" use:enhance>
							<input type="hidden" name="stop_id" value={s.id} />
							<textarea name="notes" rows="2" placeholder="e.g. scope the lagoon spit at low tide">{s.notes ?? ''}</textarea>
							<button type="submit" class="small">Save note</button>
						</form>
					</details>
				</div>
				<div class="stop-actions">
					<form method="POST" action="?/move_stop" use:enhance>
						<input type="hidden" name="stop_id" value={s.id} />
						<input type="hidden" name="direction" value="up" />
						<button type="submit" class="icon" aria-label="Move up" disabled={i === 0}>↑</button>
					</form>
					<form method="POST" action="?/move_stop" use:enhance>
						<input type="hidden" name="stop_id" value={s.id} />
						<input type="hidden" name="direction" value="down" />
						<button type="submit" class="icon" aria-label="Move down" disabled={i === data.stops.length - 1}>↓</button>
					</form>
					<form method="POST" action="?/remove_stop" use:enhance>
						<input type="hidden" name="stop_id" value={s.id} />
						<button type="submit" class="icon danger" aria-label="Remove stop">✕</button>
					</form>
				</div>
			</div>
		{/each}
	</section>

	<section class="card">
		<h2>Add a stop</h2>
		<p class="muted intro">Search a place to add it directly, or pick a nearby eBird hotspot.</p>
		<form method="GET" class="search">
			<input type="text" name="hs" value={data.hs} placeholder="Search a place — park, town, address…" />
			<button type="submit">Search</button>
		</form>
		{#if data.hsError}<p class="err">{data.hsError}</p>{/if}

		{#if data.hsCenter}
			<div class="result">
				<div class="grow">
					<div class="name">{data.hsCenter.label}</div>
					<div class="meta">Add this exact location as a custom stop</div>
				</div>
				<form method="POST" action="?/add_place" use:enhance>
					<input type="hidden" name="name" value={data.hsCenter.label} />
					<input type="hidden" name="lat" value={data.hsCenter.lat} />
					<input type="hidden" name="lon" value={data.hsCenter.lng} />
					<button type="submit" class="small primary">+ Add</button>
				</form>
			</div>
		{/if}

		{#if data.hotspots.length > 0}
			<h3 class="sub2">eBird hotspots nearby</h3>
			{#each data.hotspots as h (h.locId)}
				<div class="result">
					<div class="grow">
						<div class="name">{h.locName}</div>
						<div class="meta">
							{#if h.numSpeciesAllTime}{h.numSpeciesAllTime} species all-time{/if}
							{#if h.latestObsDt}· last report {h.latestObsDt.slice(0, 10)}{/if}
						</div>
					</div>
					<form method="POST" action="?/add_hotspot" use:enhance>
						<input type="hidden" name="loc_id" value={h.locId} />
						<input type="hidden" name="name" value={h.locName} />
						<input type="hidden" name="lat" value={h.lat} />
						<input type="hidden" name="lon" value={h.lng} />
						<button type="submit" class="small primary">+ Add</button>
					</form>
				</div>
			{/each}
		{/if}
	</section>

	<section class="card">
		<button class="danger-btn" onclick={() => (deleteOpen = true)}>Delete trip…</button>
	</section>

	<p class="attribution">Data from <a href="https://ebird.org" target="_blank" rel="noopener">eBird.org</a></p>
</div>

<!-- Destructive action → modal confirmation (cs.md) -->
{#if deleteOpen}
	<div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="del-title">
		<div class="modal">
			<h3 id="del-title">Delete this trip?</h3>
			<p>“{data.trip.name}” and its {data.stops.length} {data.stops.length === 1 ? 'stop' : 'stops'} will be permanently deleted. Your life list and photos are not affected.</p>
			<div class="actions">
				<button class="btn" onclick={() => (deleteOpen = false)}>Cancel</button>
				<form method="POST" action="?/delete_trip" use:enhance>
					<button type="submit" class="btn danger-solid">Delete trip</button>
				</form>
			</div>
		</div>
	</div>
{/if}

<style>
	.page { max-width: 1100px; margin: 0 auto; padding: 16px; }
	.page-head { margin: 4px 0 16px; }
	.title-row { display: flex; align-items: center; gap: 12px; }
	h1 { font-size: 1.4rem; }
	.sub, .muted { color: var(--muted); font-size: 0.89rem; }
	.intro { margin-bottom: 10px; }
	.notes { margin-top: 6px; }
	.card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 12px; }
	.map-card { padding: 8px; }
	.card h2 { font-size: 1.05rem; margin-bottom: 10px; }
	.sub2 { font-size: 0.9rem; margin: 12px 0 4px; color: var(--muted); }
	button.link { min-height: auto; padding: 4px 0; background: none; border: none; color: var(--link); font-weight: 600; font-size: 0.85rem; text-decoration: underline; }

	form { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; }
	form label { display: flex; flex-direction: column; gap: 4px; font-size: 0.8rem; font-weight: 600; color: var(--muted); }
	.grow-field { flex: 1; min-width: 200px; }
	input, textarea { min-height: 48px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--text); font-family: inherit; }
	.grow-field input, .grow-field textarea { width: 100%; }
	textarea { min-height: 60px; }
	button { min-height: 48px; padding: 10px 20px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; font-weight: 600; }
	button.small { min-height: 40px; padding: 8px 14px; font-size: 0.85rem; }
	button:disabled { opacity: 0.4; }

	.stop { display: flex; gap: 12px; padding: 12px 0; border-top: 1px solid var(--border); align-items: flex-start; }
	.stop:first-of-type { border-top: none; }
	.ordnum { flex: 0 0 28px; width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.85rem; }
	.grow { flex: 1; min-width: 0; }
	.name { font-weight: 700; }
	.meta { color: var(--muted); font-size: 0.83rem; margin-top: 2px; }
	.meta a { color: var(--link); }
	.stopnote { font-size: 0.85rem; margin-top: 4px; font-style: italic; color: var(--text); }
	.noteedit { margin-top: 6px; }
	.noteedit summary { cursor: pointer; color: var(--link); font-size: 0.8rem; min-height: 32px; display: flex; align-items: center; }
	.noteedit form { margin-top: 6px; flex-direction: column; align-items: stretch; }
	.noteedit textarea { width: 100%; }
	.noteedit button { align-self: flex-start; }

	.stop-actions { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; }
	.stop-actions form { display: inline; }
	button.icon { min-height: 36px; width: 36px; padding: 0; background: var(--card); border: 1px solid var(--border); color: var(--text); font-weight: 700; }
	button.icon:hover:not(:disabled) { background: var(--bg); }
	button.icon.danger { color: var(--danger); border-color: #d9a5ab; }

	.result { display: flex; gap: 12px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border); }
	.result:first-of-type { border-top: none; }
	.search input { flex: 1; min-width: 200px; }

	.ok { color: var(--seen-text); font-weight: 600; }
	.err { color: var(--danger); font-weight: 600; }
	.danger-btn { background: var(--card); border: 1px solid #d9a5ab; color: var(--danger); }
	.danger-btn:hover { background: #fdf0f1; }
	.attribution { text-align: center; color: var(--muted); font-size: 0.78rem; padding: 20px 0 8px; }
	.attribution a { color: var(--muted); }

	.modal-overlay { position: fixed; inset: 0; z-index: 2000; background: rgba(33,37,41,0.6); display: flex; align-items: center; justify-content: center; padding: 16px; }
	.modal { background: var(--card); border-radius: 8px; padding: 24px; max-width: 420px; width: 100%; }
	.modal h3 { margin-bottom: 8px; }
	.modal p { color: var(--muted); margin-bottom: 20px; }
	.modal .actions { display: flex; gap: 8px; justify-content: flex-end; }
	.btn { min-height: 48px; padding: 10px 20px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--text); font-weight: 600; }
	.btn.danger-solid { background: var(--danger); border-color: var(--danger); color: #fff; }

	@media (min-width: 640px) {
		.page { padding: 24px; }
		h1 { font-size: 1.6rem; }
	}
</style>
