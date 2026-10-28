<script lang="ts">
	/**
	 * "Where and when to look" (td-eec7db Phase 4, td-b6ddfc). One source's
	 * reports for one region, by month (which species, and where) or by
	 * species (which months, and where), for the whole region or one
	 * municipality. My needs by default, as on the trip planner. Counts of
	 * reports, never likelihoods; a share only in prose beside its total.
	 */
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import PathNavigation from '$components/PathNavigation.svelte';
	import ReportMonthStrip from '$lib/components/external/ReportMonthStrip.svelte';
	import ExternalAttribution from '$lib/components/external/ExternalAttribution.svelte';
	import ObserverTable from '$lib/components/external/ObserverTable.svelte';
	import { jobsPoll } from '$lib/job-poll.svelte';
	import { watchExternalLoads } from '$lib/external-watch.svelte';
	import { mapsPlaceUrl } from '$lib/geo';
	import {
		MONTH_LONG,
		MONTH_SHORT,
		busiestMonths,
		externalRegionHref,
		rankPlaces,
		reportsText,
		speciesInMonth,
		speciesShown,
		tripPlanHref,
		windowLabel
	} from '$lib/external-reports';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	/** Rows shown before "Show all". */
	const FIRST_ROWS = 40;

	const source = $derived(data.state.source);
	const published = $derived(data.state.published);
	const where = $derived(data.place ?? data.regionName);
	const monthName = $derived(MONTH_LONG[data.month - 1]);
	const needsOnly = $derived(data.seen === 'needs');
	const shown = $derived(speciesShown(data.species, needsOnly));

	// A URL parameter, so "Show all" works without JavaScript too (CODEX1 P2).
	const showAll = $derived(page.url.searchParams.get('all') === '1');

	/** This page's URL with some parameters changed (null removes one). */
	function hrefWith(changes: Record<string, string | number | null>): string {
		const p = new URLSearchParams(page.url.searchParams);
		for (const [k, v] of Object.entries(changes)) {
			if (v === null) p.delete(k);
			else p.set(k, String(v));
		}
		const q = p.toString();
		return `${page.url.pathname}${q ? `?${q}` : ''}`;
	}

	const inMonth = $derived(speciesInMonth(shown, data.month));
	const monthSpecies = $derived(data.species.filter((s) => s.months[data.month - 1] > 0).length);
	const monthNeeds = $derived(data.species.filter((s) => !s.seen && s.months[data.month - 1] > 0).length);
	const listed = $derived(data.mode === 'month' ? inMonth : shown);
	const visible = $derived(showAll ? listed : listed.slice(0, FIRST_ROWS));

	const placeRows = $derived(rankPlaces(data.placeRows, data.mode === 'month', needsOnly));

	function mapQuery(...parts: (string | null)[]): string {
		return [...parts.filter(Boolean), data.regionName, source.countryName].join(', ');
	}

	function speciesHref(code: string, month: number | null): string {
		const p = new URLSearchParams({ species: code, region: data.regionCode });
		if (month) p.set('month', String(month));
		return `/forecast/species?${p.toString()}`;
	}

	// A load in progress (anyone's): reload when it ends.
	watchExternalLoads(() => (data.state.active ? [{ sourceId: source.id, regionCode: data.regionCode }] : []));

	const status = $derived.by(() => {
		const live = jobsPoll.external.find(
			(j) =>
				j.sourceId === source.id &&
				j.regionCode === data.regionCode &&
				['queued', 'leased', 'staging'].includes(j.status)
		);
		const s = live ? (live.status === 'queued' ? 'queued' : 'running') : data.state.active?.status;
		if (!s) return null;
		return s === 'queued' ? 'Queued, waiting for the connector.' : 'Loading now.';
	});

	let sending = $state(false);
</script>

<svelte:head>
	<title>Where and when: {data.regionName} · Birds</title>
</svelte:head>

{#snippet loadResult()}
	{#if form?.externalError}
		<p class="error" role="alert">{form.externalError}</p>
	{:else if form?.externalQueued}
		<p class="notice ok" role="status">
			{form.externalQueued.created ? 'Queued.' : 'Already queued or loading.'} This page fills in when the load finishes.
		</p>
	{/if}
{/snippet}

{#snippet loadForm(label: string, kind: 'primary' | 'secondary')}
	<form
		method="POST"
		action="?/queueExternalLoad"
		use:enhance={() => {
			sending = true;
			return async ({ update }) => {
				await update({ reset: false });
				sending = false;
				jobsPoll.track(0);
			};
		}}
	>
		<input type="hidden" name="source_id" value={source.id} />
		<input type="hidden" name="region_code" value={data.regionCode} />
		<button type="submit" class={kind} disabled={sending}>{sending ? 'Queueing…' : label}</button>
	</form>
{/snippet}

<div class="page">
	<PathNavigation
		accountId={data.accountId}
		label="Where and when to look: {data.regionName}"
		fallbackHref={externalRegionHref(data.regionCode)}
		fallbackLabel="Hotspots & data"
	/>

	<h1>Where and when to look: {data.regionName}</h1>
	<p class="callout">
		Counts of reports sent to {source.name}, not checklist frequency or the chance of seeing a bird. They follow where
		and how often people report, and some sensitive species are hidden by the source, so a species missing here may
		still be there.
	</p>

	{#if !published}
		<section class="card">
			<p>No {source.name} reports are loaded for {data.regionName} yet.</p>
			{#if status}
				<p class="notice" role="status">{status}</p>
			{:else if data.state.failed}
				<p class="error">The last load failed{data.state.failed.error ? `: ${data.state.failed.error}` : '.'}</p>
			{/if}
			{@render loadResult()}
			{#if data.canLoad && !status}
				{@render loadForm(`Load ${source.name} reports for ${data.regionName}`, 'primary')}
			{/if}
			<ExternalAttribution {source} />
		</section>
	{:else}
		<section class="card controls" aria-label="What to show">
			<div class="seg" role="group" aria-label="View">
				<a href={hrefWith({ view: null })} aria-current={data.mode === 'month' ? 'page' : undefined} data-sveltekit-noscroll
					>By month</a
				>
				<a
					href={hrefWith({ view: 'species' })}
					aria-current={data.mode === 'species' ? 'page' : undefined}
					data-sveltekit-noscroll>By species</a
				>
			</div>
			<div class="seg" role="group" aria-label="Species">
				<a href={hrefWith({ seen: null })} aria-current={needsOnly ? 'page' : undefined} data-sveltekit-noscroll
					>My needs</a
				>
				<a href={hrefWith({ seen: 'all' })} aria-current={!needsOnly ? 'page' : undefined} data-sveltekit-noscroll
					>All species</a
				>
			</div>
			<form method="GET" class="placepick" data-sveltekit-noscroll>
				{#if data.mode === 'species'}<input type="hidden" name="view" value="species" />{/if}
				{#if !needsOnly}<input type="hidden" name="seen" value="all" />{/if}
				<input type="hidden" name="month" value={data.month} />
				<label for="place-pick">Place</label>
				<div class="pickrow">
					<select
						id="place-pick"
						name="place"
						value={data.place ?? ''}
						onchange={(e) => e.currentTarget.form?.requestSubmit()}
					>
						<option value="">All of {data.regionName}</option>
						{#each data.places as p (p.name)}
							<option value={p.name}>{p.name}</option>
						{/each}
					</select>
					<noscript><button type="submit" class="secondary">Show</button></noscript>
				</div>
			</form>
			{#if data.place}
				<p class="small">
					<a class="maplink" href={mapsPlaceUrl({ name: mapQuery(data.place) })} target="_blank" rel="noopener"
						>📍 {data.place} on the map</a
					>
				</p>
			{/if}
		</section>

		<section class="card">
			{#if data.mode === 'month'}
				<h2>{monthName} in {where}</h2>
				<ReportMonthStrip
					counts={data.monthTotals}
					selected={data.month}
					hrefFor={(m) => hrefWith({ month: m })}
					label="All bird reports in {where}, by month"
				/>
				<p class="caption" aria-live="polite">
					{#if data.monthTotals[data.month - 1] > 0}
						{reportsText(data.monthTotals[data.month - 1])} of {monthSpecies} species in {where} in {monthName},
						{windowLabel(published.windowStart, published.windowEnd)}; {monthNeeds}
						{monthNeeds === 1 ? 'is a need' : 'are needs'} (not on your life list).
					{:else}
						No bird reports in {where} in {monthName}, {windowLabel(published.windowStart, published.windowEnd)}.
					{/if}
				</p>
			{:else}
				<h2>Species in {where}, by month</h2>
				<p class="caption">
					{data.species.length} species reported in {where},
					{windowLabel(published.windowStart, published.windowEnd)}; {data.species.filter((s) => !s.seen).length} are
					needs (not on your life list). Open a species for its months{data.place ? '' : ' and municipalities'}.
				</p>
			{/if}

			{#if !data.place && placeRows.length > 0}
				<details class="fold">
					<summary
						>Municipalities{data.mode === 'month' ? ` in ${monthName}` : ''} ({placeRows.length})</summary
					>
					<p class="muted small">
						{data.mode === 'month' ? `Bird reports in ${monthName}` : 'Bird reports in the whole window'}, most
						{needsOnly ? 'needs' : 'species'} first. Pick one to see its species and places.
					</p>
					<div class="tablewrap">
						<table>
							<thead>
								<tr>
									<th scope="col">Municipality</th>
									{#if needsOnly}<th scope="col" class="num">Needs</th>{/if}
									<th scope="col" class="num">Species</th>
									<th scope="col" class="num">Reports</th>
								</tr>
							</thead>
							<tbody>
								{#each placeRows as r (r.name)}
									{@const month = data.mode === 'month'}
									<tr>
										<td><a href={hrefWith({ place: r.name })}>{r.name}</a></td>
										{#if needsOnly}<td class="num">{(month ? r.monthNeeds : r.needs).toLocaleString('en-US')}</td>{/if}
										<td class="num">{(month ? r.monthSpecies : r.species).toLocaleString('en-US')}</td>
										<td class="num">{(month ? r.monthReports : r.reports).toLocaleString('en-US')}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</details>
			{/if}

			{#if data.place && data.localities.length > 0}
				<details class="fold">
					<summary>Places in {data.place} with the most reports ({data.localities.length})</summary>
					<p class="muted small">All birds, the whole window. A place gets a map pin only when its reports agree on where it is.</p>
					<ol class="rows">
						{#each data.localities as l (l.rank)}
							<li>
								<div class="rline">
									<span class="rname">{l.locality}</span>
									<span class="rcount">{reportsText(l.reports)}</span>
								</div>
								<div class="ractions">
									{#if l.lat != null && l.lon != null}
										<a href={mapsPlaceUrl(l.lat, l.lon)} target="_blank" rel="noopener">📍 Map</a>
										<a href={tripPlanHref(l.locality, l.lat, l.lon)}>Add to trip</a>
									{:else}
										<a href={mapsPlaceUrl({ name: mapQuery(l.locality, data.place) })} target="_blank" rel="noopener"
											>📍 Map</a
										>
									{/if}
								</div>
							</li>
						{/each}
					</ol>
				</details>
			{/if}

			{#if data.observers.length > 0}
				<details class="fold">
					<summary>Most active birders in {where} ({data.observers.length})</summary>
					<ObserverTable observers={data.observers} sourceName={source.name} />
				</details>
			{/if}

			<h3>
				{needsOnly ? 'Needs' : 'Species'}{data.mode === 'month' ? ` reported in ${monthName}` : ''} ({listed.length})
			</h3>
			{#if listed.length === 0}
				<p class="muted">
					{#if data.mode === 'month'}
						No {needsOnly ? 'needs are' : 'species is'} reported in {where} in {monthName}.
					{:else}
						No {needsOnly ? 'needs are' : 'species is'} reported in {where}.
					{/if}
				</p>
			{:else if data.mode === 'month'}
				<p class="muted small">Most reports first.{data.place ? '' : ' “Most in” names the municipalities with the most.'}</p>
				<ul class="rows">
					{#each visible as s (s.code)}
						<li>
							<div class="rline">
								<a class="rname" href={speciesHref(s.code, data.month)}>{s.name}</a>
								{#if !needsOnly && s.seen}<span class="tag">seen</span>{/if}
								<span class="rcount">{reportsText(s.months[data.month - 1])}</span>
							</div>
							{#if !data.place && s.whereMonth.length > 0}
								<div class="rwhere">
									Most in {#each s.whereMonth as w, i (w.name)}{i > 0 ? ', ' : ''}<a href={hrefWith({ place: w.name })}
											>{w.name}</a
										>{/each}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="muted small">In taxonomic order.</p>
				<ul class="rows">
					{#each visible as s (s.code)}
						{@const best = busiestMonths(s.months)}
						<li>
							<!-- Rendered on the server, so a row opens without JavaScript too (CODEX1 P2). -->
							<details class="sp">
								<summary>
									<span class="rname">{s.name}</span>
									{#if !needsOnly && s.seen}<span class="tag">seen</span>{/if}
									<span class="rcount"
										>{reportsText(s.reports)}{#if best.length > 0}&nbsp;· most in {best
												.map((m) => MONTH_SHORT[m - 1])
												.join(', ')}{/if}</span
									>
								</summary>
								<ReportMonthStrip counts={s.months} label="{s.name} reports in {where}, by month" />
								{#if !data.place && s.whereWindow.length > 0}
									<p class="small">
										Most reports in {#each s.whereWindow as w, i (w.name)}{i > 0 ? ', ' : ''}<a
												href={hrefWith({ place: w.name })}>{w.name}</a
											>
											({w.reports.toLocaleString('en-US')}){/each}.
									</p>
								{/if}
								<p class="small">
									<a class="more" href={speciesHref(s.code, best[0] ?? null)}>Where to find it in {data.regionName} ›</a>
								</p>
							</details>
						</li>
					{/each}
				</ul>
			{/if}
			{#if listed.length > FIRST_ROWS}
				<a class="button secondary showall" href={hrefWith({ all: showAll ? null : 1 })} data-sveltekit-noscroll>
					{showAll ? `Show the first ${FIRST_ROWS}` : `Show all ${listed.length}`}
				</a>
			{/if}

			{#if status}
				<p class="notice" role="status">{status}</p>
			{:else if data.state.failed}
				<!-- The counts above stay the last good load's (CODEX1 P2). -->
				<p class="error">
					The last reload failed{data.state.failed.error ? `: ${data.state.failed.error}` : '.'} These counts are from the
					load before it.
				</p>
			{/if}
			{@render loadResult()}
			{#if data.state.failed && data.canLoad && !status}
				{@render loadForm(`Reload ${data.regionName}`, 'secondary')}
			{/if}
			<ExternalAttribution
				{source}
				windowStart={published.windowStart}
				windowEnd={published.windowEnd}
				retrievedAt={published.retrievedAt}
			/>
		</section>
	{/if}
</div>

<style>
	.page {
		max-width: 760px;
		margin: 0 auto;
		padding: 16px;
	}
	@media (min-width: 640px) {
		.page {
			padding: 24px;
		}
	}
	h1 {
		font-size: 1.35rem;
		margin: 8px 0 10px;
	}
	h2 {
		font-size: 1.05rem;
		margin: 0 0 6px;
	}
	h3 {
		font-size: 0.95rem;
		margin: 16px 0 4px;
	}
	.card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 16px;
		margin-bottom: 16px;
	}
	.callout {
		margin: 0 0 12px;
		padding: 8px 10px;
		border-left: 3px solid var(--info-border);
		background: var(--info-bg);
		color: var(--info-text);
		border-radius: 6px;
		font-size: 0.9rem;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		align-items: flex-end;
	}
	.seg {
		display: inline-flex;
		border: 1px solid var(--accent);
		border-radius: 8px;
		overflow: hidden;
	}
	.seg a {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
		padding: 0 14px;
		color: var(--accent);
		background: var(--card);
		text-decoration: none;
		font-size: 0.9rem;
	}
	.seg a + a {
		border-left: 1px solid var(--accent);
	}
	.seg a[aria-current='page'] {
		background: var(--accent);
		color: var(--on-accent);
	}
	@media (hover: hover) {
		.seg a:not([aria-current='page']):hover {
			background: var(--bg);
		}
	}
	.placepick {
		flex: 1 1 220px;
		min-width: 0;
	}
	.placepick label {
		display: block;
		font-size: 0.85rem;
		color: var(--muted);
		margin-bottom: 4px;
	}
	.pickrow {
		display: flex;
		gap: 8px;
	}
	.pickrow select {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 48px;
	}
	.maplink {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
	}
	.controls .small {
		flex-basis: 100%;
		margin: 0;
	}
	.caption {
		margin: 4px 0 8px;
		font-size: 0.92rem;
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.85rem;
		margin: 0 0 6px;
	}
	.fold summary {
		display: flex;
		align-items: center;
		min-height: 48px;
		list-style: none;
		cursor: pointer;
		font-size: 0.92rem;
	}
	.fold summary::-webkit-details-marker,
	.sp summary::-webkit-details-marker {
		display: none;
	}
	.fold summary::after {
		content: '▸';
		margin-left: 6px;
		color: var(--accent);
	}
	.fold[open] summary::after {
		content: '▾';
	}
	.tablewrap {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.88rem;
	}
	th {
		text-align: left;
		color: var(--muted);
		font-weight: 600;
		font-size: 0.8rem;
		padding: 6px 8px 6px 0;
		border-bottom: 1px solid var(--border);
	}
	td {
		padding: 0 8px 0 0;
		border-bottom: 1px solid var(--border);
	}
	td a {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
	}
	tr:last-child td {
		border-bottom: none;
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rows > li {
		border-bottom: 1px solid var(--border);
		padding: 2px 0;
	}
	.rows > li:last-child {
		border-bottom: none;
	}
	.rline,
	.sp summary {
		display: flex;
		align-items: center;
		gap: 4px 10px;
		flex-wrap: wrap;
		min-height: 48px;
	}
	.sp summary {
		list-style: none;
		cursor: pointer;
	}
	.sp summary::before {
		content: '▸';
		color: var(--accent);
	}
	.sp[open] summary::before {
		content: '▾';
	}
	.rname {
		flex: 1 1 140px;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	a.rname {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
	}
	.rcount {
		color: var(--muted);
		font-size: 0.88rem;
		font-variant-numeric: tabular-nums;
	}
	.tag {
		font-size: 0.75rem;
		color: var(--muted);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0 6px;
	}
	.rwhere {
		font-size: 0.85rem;
		color: var(--muted);
		padding-bottom: 6px;
	}
	.rwhere a,
	.sp .small a {
		display: inline-block;
		padding: 6px 0;
	}
	.ractions {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
		font-size: 0.9rem;
	}
	.ractions a,
	a.more {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
	}
	button.primary,
	button.secondary,
	a.button {
		min-height: 48px;
		padding: 6px 14px;
		border-radius: 8px;
		cursor: pointer;
		max-width: 100%;
	}
	button.primary {
		border: none;
		background: var(--accent);
		color: var(--on-accent);
		font-size: 0.95rem;
	}
	a.button {
		display: inline-flex;
		align-items: center;
		text-decoration: none;
	}
	button.secondary,
	a.button.secondary {
		background: var(--card);
		color: var(--accent);
		border: 1px solid var(--accent);
		font-size: 0.88rem;
	}
	button:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.showall {
		margin-top: 8px;
	}
	.notice {
		margin: 8px 0;
		color: var(--muted);
	}
	.notice.ok {
		color: var(--accent);
	}
	.error {
		color: var(--danger);
		font-weight: 600;
		margin: 8px 0;
	}
</style>
