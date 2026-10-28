<script lang="ts">
	/**
	 * forecast/species → "Reported on <source>" (td-eec7db Phase 3): one card
	 * per source covering the region. Report counts per month (never a
	 * percentage in a cell), the share only in the selected month's caption,
	 * where in the region that month, and the latest reports. Wording rules:
	 * never "likely" or "frequency"; "no reports" never means "not there".
	 */
	import { enhance } from '$app/forms';
	import { jobsPoll } from '$lib/job-poll.svelte';
	import { watchExternalLoads } from '$lib/external-watch.svelte';
	import { mapsPlaceUrl } from '$lib/geo';
	import type { ExternalSpeciesCard } from '$server/external-sources/reports';
	import type { ExternalQueued } from '$server/external-sources/queue-action';
	import {
		MONTH_LONG,
		externalRegionHref,
		monthCaption,
		reportDate,
		reportsText,
		windowLabel
	} from '$lib/external-reports';
	import ReportMonthStrip from './ReportMonthStrip.svelte';
	import ExternalAttribution from './ExternalAttribution.svelte';

	let {
		cards,
		speciesName,
		regionCode,
		regionName,
		canLoad,
		monthHref,
		result = null
	}: {
		cards: ExternalSpeciesCard[];
		speciesName: string;
		regionCode: string;
		regionName: string;
		canLoad: boolean;
		/** The page's own URL with ?month= set; keeps every other parameter. */
		monthHref: (month: number) => string;
		result?: { externalQueued?: ExternalQueued; externalError?: string; regionCode?: string | null } | null;
	} = $props();

	let sending = $state<string | null>(null);

	// Loads in progress when the page loaded, anyone's: reload when one ends.
	watchExternalLoads(() => cards.filter((c) => c.active).map((c) => ({ sourceId: c.source.id, regionCode })));

	function liveActive(c: ExternalSpeciesCard) {
		const live = jobsPoll.external.find(
			(j) =>
				j.sourceId === c.source.id &&
				j.regionCode === regionCode &&
				['queued', 'leased', 'staging'].includes(j.status)
		);
		if (live) return live.status === 'queued' ? 'Queued, waiting for the connector.' : 'Loading now.';
		if (c.active) return c.active.status === 'queued' ? 'Queued, waiting for the connector.' : 'Loading now.';
		return null;
	}

	function placeQuery(c: ExternalSpeciesCard, ...parts: (string | null)[]): string {
		return [...parts.filter(Boolean), regionName, c.source.countryName].join(', ');
	}

	/** The source's locality usually names its municipality already ("Finneset, Kabelvåg, Vågan, No"). */
	function whereText(r: { locality: string; place: string | null }): string {
		return r.place && !r.locality.includes(r.place) ? `${r.locality}, ${r.place}` : r.locality;
	}

	function tripHref(r: { locality: string; lat: number; lon: number }): string {
		const p = new URLSearchParams();
		p.set('place', r.locality);
		p.set('lat', r.lat.toFixed(5));
		p.set('lng', r.lon.toFixed(5));
		return `/trips/plan?${p.toString()}`;
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

{#each cards as c (c.source.id)}
	{@const total = c.months ? c.months.reduce((a, b) => a + b, 0) : 0}
	{@const status = liveActive(c)}
	<section class="card" id="ext-reports-{c.source.id}" aria-labelledby="ext-reports-{c.source.id}-title">
		<h2 id="ext-reports-{c.source.id}-title">Reported on {c.source.name}</h2>
		<p class="callout">
			Counts of reports sent to {c.source.name}, not checklist frequency or the chance of seeing this bird.
		</p>

		{#if !c.published || !c.months || !c.monthTotals}
			<p>No {c.source.name} reports are loaded for {regionName} yet.</p>
		{:else}
			{#if total === 0}
				<p>
					No reports of {speciesName} in {regionName} in {windowLabel(c.published.windowStart, c.published.windowEnd)}.
					Some sensitive species are hidden by the source, so this doesn't mean it isn't there.
				</p>
			{:else}
				<p class="lead">
					{reportsText(total)} of {speciesName} in {regionName},
					{windowLabel(c.published.windowStart, c.published.windowEnd)}. Each cell adds up that month across the whole window.
				</p>
				<ReportMonthStrip
					counts={c.months}
					selected={c.month}
					hrefFor={monthHref}
					label="{speciesName} reports in {regionName}, by month"
				/>
				<p class="caption" aria-live="polite">
					{monthCaption(c.months[c.month - 1], c.monthTotals[c.month - 1], c.month, regionName)}
				</p>

				<h3>Where in {MONTH_LONG[c.month - 1]}</h3>
				{#if c.placesScope === 'window'}
					<p class="muted small">
						No reports in {MONTH_LONG[c.month - 1]}. These are the municipalities with the most reports across the
						whole window.
					</p>
				{/if}
				{#if c.places.length > 0}
					<ol class="places">
						{#each c.places as p (p.name)}
							<li>
								<span class="pname">{p.name}</span>
								<span class="pcount">{reportsText(p.reports)}</span>
								<a class="map" href={mapsPlaceUrl({ name: placeQuery(c, p.name) })} target="_blank" rel="noopener"
									>📍 Map</a
								>
							</li>
						{/each}
					</ol>
				{:else if c.placesScope === 'month'}
					<p class="muted small">
						The {MONTH_LONG[c.month - 1]} reports are placed only at county level, with no municipality given.
					</p>
				{:else}
					<p class="muted small">Every report of it is placed only at county level.</p>
				{/if}
			{/if}

			<!-- Shown even with no reports in the window: the latest two weeks
			     lie after it (CODEX1 F1, e.g. a Pine Bunting this October). -->
			<h3>Latest reports</h3>
			{#if c.latest.length > 0}
				<p class="muted small">From the last 14 days with reports when {regionName} was loaded, newest first.</p>
				<ul class="latest">
					{#each c.latest as r (r.id)}
						<li>
							<div class="rline">
								<strong>{reportDate(r.observedOn)}</strong>
								<span>{r.count != null ? `${r.count.toLocaleString('en-US')} counted` : 'count not given'}</span>
							</div>
							<div class="rline">{whereText(r)}</div>
							{#if r.observer}<div class="rline muted">{r.observer}</div>{/if}
							<div class="ractions">
								<a href={r.url} target="_blank" rel="noopener">Sighting ↗</a>
								{#if r.lat != null && r.lon != null}
									<a href={mapsPlaceUrl(r.lat, r.lon)} target="_blank" rel="noopener">📍 Map</a>
									<a href={tripHref({ locality: r.locality, lat: r.lat, lon: r.lon })}>Add to trip</a>
								{:else}
									<a href={mapsPlaceUrl({ name: placeQuery(c, whereText(r)) })} target="_blank" rel="noopener"
										>📍 Map</a
									>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="muted small">None in the last 14 days with reports when {regionName} was loaded.</p>
			{/if}
		{/if}

		{#if status}
			<p class="notice" role="status">{status}</p>
		{:else if c.failed}
			<p class="error">The last load failed{c.failed.error ? `: ${c.failed.error}` : '.'}</p>
		{/if}
		{#if result?.externalError && result.regionCode}
			<p class="error" role="alert">{result.externalError}</p>
		{:else if result?.externalQueued && result.externalQueued.sourceId === c.source.id}
			<p class="notice ok" role="status">
				{result.externalQueued.created ? 'Queued.' : 'Already queued or loading.'} This card fills in when the load
				finishes; progress also shows in
				<a href={externalRegionHref(result.externalQueued.regionCode)}>Hotspots &amp; data</a>.
			</p>
		{/if}
		{#if canLoad && !status}
			{@const key = c.source.id}
			<form method="POST" action="?/queueExternalLoad" use:enhance={submitter(key)}>
				<input type="hidden" name="source_id" value={c.source.id} />
				<input type="hidden" name="region_code" value={regionCode} />
				<button type="submit" class={c.published ? 'secondary' : 'primary'} disabled={sending !== null}>
					{sending === key ? 'Queueing…' : c.published ? `Reload ${regionName}` : `Load ${c.source.name} reports for ${regionName}`}
				</button>
			</form>
		{/if}

		{#if c.source.regionLink}
			<p class="small"><a href={c.source.regionLink} target="_blank" rel="noopener">{regionName} on {c.source.name} ↗</a></p>
		{/if}
		{#if c.published}
			<ExternalAttribution
				source={c.source}
				windowStart={c.published.windowStart}
				windowEnd={c.published.windowEnd}
				retrievedAt={c.published.retrievedAt}
			/>
		{:else}
			<ExternalAttribution source={c.source} />
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
		margin: 0;
	}
	.caption {
		margin: 4px 0 0;
		font-size: 0.92rem;
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.85rem;
		margin: 0 0 6px;
	}
	.places,
	.latest {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.places li {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		padding: 2px 0;
		border-bottom: 1px solid var(--border);
	}
	.places li:last-child,
	.latest li:last-child {
		border-bottom: none;
	}
	.pname {
		flex: 1 1 140px;
		min-width: 0;
	}
	.pcount {
		color: var(--muted);
		font-size: 0.88rem;
		font-variant-numeric: tabular-nums;
	}
	.map,
	.ractions a {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
		padding: 0 4px;
	}
	.latest li {
		padding: 8px 0 0;
		border-bottom: 1px solid var(--border);
	}
	.rline {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		font-size: 0.92rem;
		overflow-wrap: anywhere;
	}
	.ractions {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
		font-size: 0.9rem;
	}
	form {
		margin-top: 12px;
	}
	button.primary,
	button.secondary {
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
	button.secondary {
		background: var(--card);
		color: var(--accent);
		border: 1px solid var(--accent);
		font-size: 0.88rem;
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
