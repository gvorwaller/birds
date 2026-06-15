<script lang="ts">
	import { enhance } from "$app/forms";
	import Badge from "$components/Badge.svelte";
	import MapLink from "$components/MapLink.svelte";
	import TripMap, { type MapStop } from "$components/TripMap.svelte";
	import { formatKm } from "$lib/geo";
	import type { ActionData, PageData } from "./$types";

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let saving = $state(false);

	// Map markers from the previewed (ordered) stops, anchor shown as the start pin.
	let mapStops = $derived<MapStop[]>(
		(data.preview?.stops ?? []).map((s, i) => ({
			lat: s.lat,
			lng: s.lng,
			label: s.name,
			order: i + 1,
		})),
	);
	let mapAnchor = $derived<MapStop | null>(
		data.anchor
			? {
					lat: data.anchor.lat,
					lng: data.anchor.lng,
					label: data.anchor.label,
					order: 0,
				}
			: null,
	);

	// What the Save action persists — exactly the previewed stops (no drift).
	let saveStops = $derived(
		JSON.stringify(
			(data.preview?.stops ?? []).map((s) => ({
				hotspot_id: s.hotspotId,
				name: s.name,
				lat: s.lat,
				lon: s.lng,
				notes: s.note,
				target_count_at_save: s.matchCount,
			})),
		),
	);

	// Which candidate locIds ended up in the trip (to badge them in the full list).
	let chosenIds = $derived(
		new Set(
			(data.preview?.stops ?? [])
				.filter((s) => s.hotspotId)
				.map((s) => s.hotspotId),
		),
	);

	const HISTORICAL_MSG: Record<string, string> = {
		none_found: "No historical/cultural site found near the route.",
		not_configured: "Places API is not configured — historical stop skipped.",
		unavailable: "Places service was unavailable — historical stop skipped.",
	};
</script>

<svelte:head>
	<title>Plan a trip — birds</title>
</svelte:head>

<div class="page">
	<header class="page-head">
		<p class="sub"><a href="/trips">← Trips</a></p>
		<h1>Plan a trip</h1>
		<p class="sub">
			Find hotspots near a place that have enough of your needs, and build a
			route.
		</p>
	</header>

	<section class="card">
		<form method="GET" class="filters">
			<label class="grow-field">
				<span>Near</span>
				<input
					type="text"
					name="place"
					placeholder="City, county, park, or address…"
					value={data.inputs.place}
				/>
			</label>
			<label>
				<span>Radius</span>
				<select name="radius">
					{#each [5, 10, 15, 25] as mi (mi)}
						<option value={mi} selected={data.inputs.radiusMi === mi}
							>{mi} mi</option
						>
					{/each}
				</select>
			</label>
			<label>
				<span>Window</span>
				<select name="back">
					{#each [7, 14, 30] as d (d)}
						<option value={d} selected={data.inputs.back === d}
							>Last {d} days</option
						>
					{/each}
				</select>
			</label>
			<label>
				<span>Stops</span>
				<select name="stops">
					{#each [2, 3, 4, 5] as n (n)}
						<option value={n} selected={data.inputs.stops === n}>{n}</option>
					{/each}
				</select>
			</label>
			<label>
				<span>Min needs/stop</span>
				<select name="minneeds">
					{#each [1, 2, 3, 5] as n (n)}
						<option value={n} selected={data.inputs.minNeeds === n}>{n}</option>
					{/each}
				</select>
			</label>
			<label>
				<span>Count</span>
				<select name="seen">
					<option value="needs" selected={data.inputs.seenStatus === "needs"}
						>My needs</option
					>
					<option value="all" selected={data.inputs.seenStatus === "all"}
						>All species</option
					>
				</select>
			</label>
			<label class="check">
				<input
					type="checkbox"
					name="rare"
					value="1"
					checked={data.inputs.rareOnly}
				/>
				<span>Rare only</span>
			</label>
			<label class="check">
				<input
					type="checkbox"
					name="hist"
					value="1"
					checked={data.inputs.includeHistorical}
				/>
				<span>Add a historical stop</span>
			</label>
			<button type="submit">Plan</button>
		</form>
		{#if data.anchor}
			<p class="muted loc">
				📍 {data.anchor.label} · {data.inputs.radiusMi} mi · last {data.inputs
					.back} days
			</p>
		{/if}
	</section>

	{#if form?.error}
		<section class="card"><p class="err" role="alert">{form.error}</p></section>
	{/if}

	{#each data.errors as e (e)}
		<section class="card"><p class="err" role="alert">{e}</p></section>
	{/each}

	{#if data.needsLocation}
		<section class="card">
			<p class="muted">
				Enter a place above, or <a href="/settings">set your home location</a> to
				default to it.
			</p>
		</section>
	{/if}

	{#if data.preview}
		{#if mapStops.length > 0}
			<section class="card map-card">
				{#key mapStops.map((s) => `${s.lat},${s.lng}`).join("|")}
					<TripMap stops={mapStops} extra={mapAnchor} />
				{/key}
			</section>
		{/if}

		<section class="card">
			<div class="preview-head">
				<h2>Trip preview</h2>
				{#if data.preview.stale}<Badge kind="stale" label="cached" />{/if}
			</div>

			{#each data.preview.warnings as w (w)}
				<p class="warn">{w}</p>
			{/each}

			{#if data.preview.stops.length === 0}
				<p class="muted">
					No stops to build a trip from. Loosen the filters and try again.
				</p>
			{:else}
				<p class="muted summary">
					{data.preview.stops.length}
					{data.preview.stops.length === 1 ? "stop" : "stops"} ·
					{data.preview.totalMatchSpecies} distinct {data.inputs.seenStatus ===
					"needs"
						? "needs"
						: "species"} across the route
				</p>

				{#each data.preview.stops as s, i (s.name + i)}
					<div class="stop">
						<div class="ordnum" class:hist={s.kind === "historical"}>
							{i + 1}
						</div>
						<div class="grow">
							<div class="name">
								{s.name}
								{#if s.kind === "historical"}<Badge
										kind="notable"
										label="history"
									/>{:else}<Badge
										kind="seen"
										label="{s.matchCount} needs"
									/>{/if}
							</div>
							{#if s.triggerSpecies.length}
								<div class="meta">
									{s.triggerSpecies.map((t) => t.comName).join(", ")}
								</div>
							{/if}
							<div class="stopnote">{s.note}</div>
							<MapLink lat={s.lat} lng={s.lng} />
						</div>
					</div>
				{/each}

				{#if data.canEdit}
					<form
						method="POST"
						action="?/save"
						class="save"
						use:enhance={() => {
							saving = true;
							return async ({ update }) => {
								await update();
								saving = false;
							};
						}}
					>
						<input type="hidden" name="stops" value={saveStops} />
						<label class="grow-field">
							<span>Trip name</span>
							<input
								type="text"
								name="name"
								value={data.preview.suggestedName}
								required
							/>
						</label>
						<button type="submit" disabled={saving}
							>{saving ? "Saving…" : "Save trip"}</button
						>
					</form>
				{/if}
			{/if}
		</section>
	{/if}

	{#if data.query && data.query.candidates.length > 0}
		<section class="card">
			<h2>All matching places ({data.query.candidates.length})</h2>
			<p class="muted intro">
				Every hotspot in range with {data.inputs.seenStatus === "needs"
					? "your needs"
					: "species"} reported, ranked. Chosen stops are marked.
			</p>
			{#each data.query.candidates as c (c.locId ?? c.locName)}
				<div class="obs">
					<div class="grow">
						<div class="name">
							{c.locName}
							{#if c.locId && chosenIds.has(c.locId)}<Badge
									kind="seen"
									label="in trip"
								/>{/if}
							{#if !c.eligible}<Badge kind="stale" label="below min" />{/if}
						</div>
						<div class="meta">
							{c.triggerSpecies.map((t) => t.comName).join(", ")}
						</div>
						<div class="links">
							<MapLink lat={c.lat} lng={c.lng} />
							{#if c.locId}
								<a
									href={`https://ebird.org/hotspot/${c.locId}`}
									target="_blank"
									rel="noopener">eBird hotspot ↗</a
								>
							{/if}
						</div>
					</div>
					<div class="right">
						<div class="count">{c.matchCount}</div>
						<div class="when">{formatKm(c.distanceKm)}</div>
					</div>
				</div>
			{/each}
		</section>
	{/if}

	<p class="attribution">
		Data from <a href="https://ebird.org" target="_blank" rel="noopener"
			>eBird.org</a
		>
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
	.summary {
		margin-bottom: 10px;
		font-weight: 600;
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
	.preview-head {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 6px;
	}
	.preview-head h2 {
		margin-bottom: 0;
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
		min-width: 200px;
	}
	.filters .check {
		flex-direction: row;
		align-items: center;
		gap: 6px;
		min-height: 48px;
	}
	.filters .check input {
		min-height: 0;
		width: 18px;
		height: 18px;
	}
	.filters input,
	.filters select {
		min-height: 48px;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
		color: var(--text);
		font-family: inherit;
		font-size: 16px;
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

	.warn {
		color: var(--danger);
		font-size: 0.85rem;
		margin: 4px 0;
	}
	.err {
		color: var(--danger);
		font-weight: 600;
	}

	.stop {
		display: flex;
		gap: 12px;
		padding: 12px 0;
		border-top: 1px solid var(--border);
		align-items: flex-start;
	}
	.stop:first-of-type {
		border-top: none;
	}
	.ordnum {
		flex: 0 0 28px;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--accent);
		color: #fff;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		font-size: 0.85rem;
	}
	.ordnum.hist {
		background: #842029;
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
	.stopnote {
		font-size: 0.85rem;
		margin-top: 4px;
		font-style: italic;
		color: var(--text);
	}
	.links {
		display: flex;
		gap: 14px;
		flex-wrap: wrap;
		margin-top: 4px;
	}
	.links a {
		color: var(--link);
		font-size: 0.83rem;
		font-weight: 600;
	}

	.save {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
		display: flex;
		gap: 8px;
		align-items: flex-end;
		flex-wrap: wrap;
	}
	.save label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
	}
	.save .grow-field {
		flex: 1;
		min-width: 200px;
	}
	.save input {
		min-height: 48px;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
		color: var(--text);
		width: 100%;
		font-size: 16px;
	}
	.save button {
		min-height: 48px;
		padding: 10px 20px;
		border-radius: 8px;
		border: 1px solid var(--accent);
		background: var(--accent);
		color: #fff;
		font-weight: 600;
	}
	.save button:disabled {
		opacity: 0.5;
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
	.right {
		text-align: right;
		flex-shrink: 0;
	}
	.count {
		font-weight: 700;
		color: var(--accent);
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
