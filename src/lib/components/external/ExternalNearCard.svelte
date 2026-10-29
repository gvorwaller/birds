<script lang="ts">
	/**
	 * "What can I see?" → "Reported on <source> near <place>" (td-46fff6 rev
	 * B): the stored reports within the radius in the chosen month. Needs
	 * first, most reports first; the places they come from; the county's
	 * "Where and when to look" per municipality. Wording rules: counts of
	 * reports, never "likely" or "frequency". Every fold is a <details>, so the
	 * card works without JavaScript.
	 */
	import { enhance } from '$app/forms';
	import { formatDistance, mapsPlaceUrl } from '$lib/geo';
	import { jobsPoll } from '$lib/job-poll.svelte';
	import { watchExternalLoads } from '$lib/external-watch.svelte';
	import {
		MONTH_LONG,
		NEAR_SPECIES_SHOWN,
		externalRegionHref,
		reportsText,
		tripPlanHref,
		whereWhenHref,
		windowLabel
	} from '$lib/external-reports';
	import type { ExternalNearCard, NearPlaceRef, NearSpecies } from '$server/external-sources/near';
	import type { ExternalRegionState } from '$server/external-sources/reports';
	import type { ExternalQueued } from '$server/external-sources/queue-action';
	import ExternalAttribution from './ExternalAttribution.svelte';

	type Unloaded = ExternalRegionState & { regionCode: string; regionName: string };

	let {
		cards,
		unloaded = [],
		placeLabel,
		radiusKm,
		month,
		canLoad,
		speciesHref,
		result = null
	}: {
		cards: ExternalNearCard[];
		/** Sources covering eBird's region for the point with nothing loaded there. */
		unloaded?: Unloaded[];
		placeLabel: string;
		radiusKm: number;
		month: number;
		canLoad: boolean;
		/** The species page link, with the page's own return and location context. */
		speciesHref: (code: string) => string;
		result?: { externalQueued?: ExternalQueued; externalError?: string; regionCode?: string | null } | null;
	} = $props();

	let sending = $state<string | null>(null);

	// Loads in progress when the page loaded, anyone's: reload when one ends.
	watchExternalLoads(() =>
		unloaded.filter((u) => u.active).map((u) => ({ sourceId: u.source.id, regionCode: u.regionCode }))
	);

	const monthName = $derived(MONTH_LONG[month - 1]);
	const within = $derived(formatDistance(radiusKm, 'mi'));

	/** One card per source: its reports here, and its unloaded region if any. */
	const shown = $derived.by(() => {
		const out: { c: ExternalNearCard | null; u: Unloaded | null; id: string; source: ExternalNearCard['source'] }[] =
			cards.map((c) => ({ c, u: unloaded.find((u) => u.source.id === c.source.id) ?? null, id: c.source.id, source: c.source }));
		for (const u of unloaded) {
			if (!cards.some((c) => c.source.id === u.source.id)) out.push({ c: null, u, id: u.source.id, source: u.source });
		}
		return out;
	});

	function liveActive(u: Unloaded): string | null {
		const live = jobsPoll.external.find(
			(j) =>
				j.sourceId === u.source.id &&
				j.regionCode === u.regionCode &&
				['queued', 'leased', 'staging'].includes(j.status)
		);
		const status = live ? (live.status === 'queued' ? 'queued' : 'running') : u.active?.status;
		if (!status) return null;
		return status === 'queued' ? 'Queued, waiting for the connector.' : 'Loading now.';
	}

	/** The source's locality usually names its municipality already ("Skogsøy, Nesna, No"). */
	function whereText(p: NearPlaceRef): string {
		return p.municipality && !p.locality.includes(p.municipality) ? `${p.locality}, ${p.municipality}` : p.locality;
	}

	function windowText(c: ExternalNearCard): string {
		const labels = [...new Set(c.counties.map((w) => windowLabel(w.windowStart, w.windowEnd)))];
		return labels.length === 1 ? labels[0] : "each county's loaded window";
	}

	function yearsText(s: NearSpecies, c: ExternalNearCard): string | null {
		if (c.monthYears < 2) return null;
		return `in ${s.years} of ${c.monthYears} ${monthName}s`;
	}

	function whereInHref(s: NearSpecies): string {
		const p = new URLSearchParams();
		p.set('species', s.code);
		p.set('region', s.regionCode);
		p.set('month', String(month));
		return `/forecast/species?${p.toString()}`;
	}

	function placeQuery(c: ExternalNearCard, p: NearPlaceRef & { regionCode: string }): string {
		const county = c.counties.find((w) => w.code === p.regionCode)?.name ?? null;
		return [whereText(p), county, c.source.countryName].filter(Boolean).join(', ');
	}

	function submitter(key: string) {
		return () => {
			sending = key;
			return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
				await update({ reset: false });
				sending = null;
				jobsPoll.track(0);
			};
		};
	}
</script>

{#snippet speciesRow(s: NearSpecies, c: ExternalNearCard)}
	{@const years = yearsText(s, c)}
	<li>
		<div class="sp">
			<a href={speciesHref(s.code)} class="name">{s.name}</a>
			<span class="freq">{reportsText(s.reports)}{#if years}&nbsp;· {years}{/if}</span>
		</div>
		<div class="best">
			{#each s.where as p, i (p.key)}{i > 0 ? ' · ' : ''}{whereText(p)} ({reportsText(
					p.reports
				)}, {formatDistance(p.km, 'mi')}){/each}
		</div>
		<div class="actions">
			<a href={whereInHref(s)}>Where in {s.regionName}</a>
		</div>
	</li>
{/snippet}

{#each shown as { c, u, id, source } (id)}
	{@const status = u ? liveActive(u) : null}
	<section class="card" id="ext-near-{id}" aria-labelledby="ext-near-{id}-title">
		<h2 id="ext-near-{id}-title">Reported on {source.name} near {placeLabel}</h2>
		<p class="callout">
			Counts of reports sent to {source.name}, not checklist frequency or the chance of seeing a bird.
		</p>

		{#if c && c.reports > 0}
			{@const needs = c.species.filter((s) => !s.seen)}
			{@const seen = c.species.filter((s) => s.seen)}
			<p class="lead">
				{#if needs.length > 0}
					<strong>{needs.length}</strong>
					{needs.length === 1 ? 'species you still need was' : 'species you still need were'} reported within {within} in
					{monthName}, {windowText(c)} ({c.reports.toLocaleString('en-US')} bird reports in all).
				{:else}
					None of the {c.species.length} species reported within {within} in {monthName}, {windowText(c)}, are ones you
					still need ({c.reports.toLocaleString('en-US')} bird reports in all).
				{/if}
			</p>

			{#if needs.length > 0}
				<ol class="needs">
					{#each needs.slice(0, NEAR_SPECIES_SHOWN) as s (s.code)}
						{@render speciesRow(s, c)}
					{/each}
				</ol>
				{#if needs.length > NEAR_SPECIES_SHOWN}
					<details class="fold">
						<summary>Show all {needs.length}</summary>
						<ol class="needs" start={NEAR_SPECIES_SHOWN + 1}>
							{#each needs.slice(NEAR_SPECIES_SHOWN) as s (s.code)}
								{@render speciesRow(s, c)}
							{/each}
						</ol>
					</details>
				{/if}
			{/if}
			{#if seen.length > 0}
				<details class="fold">
					<summary>{seen.length} species you've already seen</summary>
					<ul class="seen">
						{#each seen as s (s.code)}
							<li><a href={speciesHref(s.code)}>{s.name}</a> <span class="freq">{reportsText(s.reports)}</span></li>
						{/each}
					</ul>
				</details>
			{/if}

			{#if c.places.length > 0}
				<h3>Busiest places near here in {monthName}</h3>
				<p class="muted small">All birds, most reports first.</p>
				<ol class="places">
					{#each c.places as p (p.key)}
						<li>
							<div class="sp">
								<span class="pname">{whereText(p)}</span>
								<span class="freq">{reportsText(p.reports)} · {formatDistance(p.km, 'mi')}</span>
							</div>
							<div class="actions">
								{#if p.lat != null && p.lon != null}
									<a href={mapsPlaceUrl(p.lat, p.lon)} target="_blank" rel="noopener">📍 Map</a>
									<a href={tripPlanHref(p.locality, p.lat, p.lon)}>Add to trip</a>
								{:else}
									<a href={mapsPlaceUrl({ name: placeQuery(c, p) })} target="_blank" rel="noopener">📍 Map</a>
								{/if}
							</div>
						</li>
					{/each}
				</ol>
			{/if}

			{#if c.municipalities.length > 0}
				<h3>Where and when to look</h3>
				<p class="munis">
					{#each c.municipalities as m, i (m.regionCode + '\u0000' + m.name)}{i > 0 ? ' · ' : ''}<a
							href={whereWhenHref(source.id, m.regionCode, { month, place: m.name })}>{m.name}</a
						>{/each}
				</p>
			{/if}
		{:else if c?.nearest}
			<p>
				No {source.name} reports within {within} in {monthName}, {windowText(c)}. The nearest is
				{whereText(c.nearest)}, {formatDistance(c.nearest.km, 'mi')} away.
			</p>
		{/if}

		{#if u}
			<p class="unloaded">No {source.name} reports are loaded for {u.regionName} yet.</p>
			{#if status}
				<p class="notice" role="status">{status}</p>
			{:else if u.failed}
				<p class="error">The last load failed{u.failed.error ? `: ${u.failed.error}` : '.'}</p>
			{/if}
			{#if result?.externalError && result.regionCode === u.regionCode}
				<p class="error" role="alert">{result.externalError}</p>
			{:else if result?.externalQueued && result.externalQueued.sourceId === source.id}
				<p class="notice ok" role="status">
					{result.externalQueued.created ? 'Queued.' : 'Already queued or loading.'} This card fills in when the load
					finishes; progress also shows in
					<a href={externalRegionHref(result.externalQueued.regionCode)}>Hotspots &amp; data</a>.
				</p>
			{/if}
			{#if canLoad && !status}
				<form method="POST" action="?/queueExternalLoad" use:enhance={submitter(id)}>
					<input type="hidden" name="source_id" value={source.id} />
					<input type="hidden" name="region_code" value={u.regionCode} />
					<button type="submit" class="primary" disabled={sending !== null}>
						{sending === id ? 'Queueing…' : `Load ${source.name} reports for ${u.regionName}`}
					</button>
				</form>
			{/if}
		{/if}

		{#if c && c.counties.length === 1}
			<ExternalAttribution source={source} windowStart={c.counties[0].windowStart} windowEnd={c.counties[0].windowEnd} />
		{:else}
			<ExternalAttribution source={source} />
		{/if}
	</section>
{/each}

<style>
	.card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 16px;
		margin-bottom: 16px;
	}
	h2 {
		font-size: 1.05rem;
		margin: 0 0 10px;
		overflow-wrap: anywhere;
	}
	h3 {
		font-size: 0.95rem;
		margin: 16px 0 6px;
	}
	.callout {
		margin: 0 0 10px;
		padding: 8px 10px;
		border-left: 3px solid var(--info-border);
		background: var(--info-bg);
		color: var(--info-text);
		border-radius: 6px;
		font-size: 0.9rem;
	}
	.lead {
		margin: 0 0 8px;
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.85rem;
		margin: 0 0 6px;
	}
	.needs,
	.places {
		margin: 0;
		padding-left: 1.6em;
	}
	.needs li,
	.places li {
		padding: 6px 0;
		border-bottom: 1px solid var(--border);
	}
	.needs li:last-child,
	.places li:last-child {
		border-bottom: none;
	}
	.sp {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 10px;
	}
	.name {
		font-weight: 600;
	}
	.pname {
		overflow-wrap: anywhere;
	}
	.freq {
		color: var(--muted);
		font-size: 0.88rem;
		font-variant-numeric: tabular-nums;
	}
	.best {
		color: var(--muted);
		font-size: 0.86rem;
		margin-top: 2px;
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
		font-size: 0.9rem;
	}
	.actions a,
	.munis a,
	.seen a {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
	}
	.fold {
		margin: 8px 0 0;
	}
	/* The same marker as "Where and when to look": display:flex hides the native one. */
	.fold summary {
		display: flex;
		align-items: center;
		min-height: 48px;
		list-style: none;
		cursor: pointer;
		color: var(--accent);
	}
	.fold summary::-webkit-details-marker {
		display: none;
	}
	.fold summary::after {
		content: '▸';
		margin-left: 6px;
	}
	.fold[open] summary::after {
		content: '▾';
	}
	.seen {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.seen li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 10px;
		border-bottom: 1px solid var(--border);
	}
	.seen li:last-child {
		border-bottom: none;
	}
	.munis {
		margin: 0;
		line-height: 1.2;
	}
	.unloaded {
		margin: 12px 0 0;
	}
	form {
		margin-top: 12px;
	}
	button.primary {
		min-height: 48px;
		padding: 6px 14px;
		border-radius: 8px;
		cursor: pointer;
		max-width: 100%;
		border: none;
		background: var(--accent);
		color: var(--on-accent);
		font-size: 0.95rem;
	}
	button:disabled {
		opacity: 0.6;
		cursor: default;
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
