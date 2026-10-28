<script lang="ts">
	/**
	 * Hotspots & data → "Reports from other sources" (td-eec7db Phase 3):
	 * every active source and the regions it covers. Loaded regions show
	 * their status, the month totals and the most active birders; the rest
	 * can be loaded one at a time. Counts of reports, never likelihoods.
	 */
	import { enhance } from '$app/forms';
	import { jobsPoll } from '$lib/job-poll.svelte';
	import { watchExternalLoads } from '$lib/external-watch.svelte';
	import type { ExternalOverviewRegion, ExternalOverviewSource } from '$server/external-sources/reports';
	import type { ExternalQueued } from '$server/external-sources/queue-action';
	import { externalRegionId, pickedRegion, reportsText, whereWhenHref, windowLabel } from '$lib/external-reports';
	import ReportMonthStrip from './ReportMonthStrip.svelte';
	import ExternalAttribution from './ExternalAttribution.svelte';
	import ObserverTable from './ObserverTable.svelte';

	let {
		overview,
		canLoad,
		result = null
	}: {
		/** null when the server couldn't read it. */
		overview: ExternalOverviewSource[] | null;
		canLoad: boolean;
		result?: { externalQueued?: ExternalQueued; externalError?: string; regionCode?: string | null } | null;
	} = $props();

	// Loads in progress when the page loaded, anyone's: reload when one ends.
	watchExternalLoads(() =>
		(overview ?? []).flatMap((s) =>
			s.regions.filter((r) => r.active).map((r) => ({ sourceId: s.source.id, regionCode: r.code }))
		)
	);

	/** "<source>:<region>" of the form being sent. */
	let sending = $state<string | null>(null);
	/** The region picked in each source's "Load another" select. */
	let picked = $state<Record<string, string>>({});

	const PHASES: Record<string, string> = {
		planning: 'starting',
		fetching: 'reading reports',
		sending: 'saving',
		finishing: 'finishing'
	};

	type Active = NonNullable<ExternalOverviewRegion['active']>;

	/**
	 * A load in progress: this user's own from the jobs poll (live; the job
	 * chip is hidden on /forecast pages), else anyone's as the page loaded it.
	 */
	function activeOf(sourceId: string, r: ExternalOverviewRegion): Active | null {
		const live = jobsPoll.external.find(
			(j) => j.sourceId === sourceId && j.regionCode === r.code && ['queued', 'leased', 'staging'].includes(j.status)
		);
		if (live) {
			return {
				status: live.status === 'queued' ? 'queued' : 'running',
				done: live.progress.unitsDone ?? 0,
				total: live.progress.unitsTotal ?? 0,
				phase: live.progress.currentUnit?.name ?? null
			};
		}
		return r.active;
	}

	function statusText(a: Active): string {
		if (a.status === 'queued') return 'Queued, waiting for the connector';
		const phase = (a.phase && PHASES[a.phase]) ?? 'loading';
		return a.total > 0 ? `Loading: ${phase}, ${a.done} of ${a.total}` : `Loading: ${phase}`;
	}

	function loadedOn(iso: string): string {
		return new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
	}

	/** Regions with something to show: published, loading, or failed. */
	const shown = (s: ExternalOverviewSource, r: ExternalOverviewRegion) =>
		Boolean(r.published || r.failed || activeOf(s.source.id, r));
	const shownRegions = (s: ExternalOverviewSource) => s.regions.filter((r) => shown(s, r));
	const otherRegions = (s: ExternalOverviewSource) => s.regions.filter((r) => !shown(s, r));

	function submitter(key: string) {
		return () => {
			sending = key;
			return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
				await update({ reset: false });
				sending = null;
				// The new load joins this user's job chip; the page reloads when it ends.
				jobsPoll.track(0);
			};
		};
	}
</script>

<section class="card" id="external-sources" aria-labelledby="external-sources-title">
	<h2 id="external-sources-title">Reports from other sources</h2>
	<p class="callout">
		Counts of reports people sent to these sources, not eBird checklist frequency or the chance of seeing a bird. Each
		region is loaded on its own and takes a few minutes.
	</p>

	{#if overview === null}
		<p class="error" role="alert">Couldn't read the reports from other sources. Reload the page to try again.</p>
	{:else if overview.length === 0}
		<p class="muted">No other sources are switched on.</p>
	{:else}
		{#each overview as s (s.source.id)}
			{@const loaded = s.regions.filter((r) => r.published).length}
			<div class="source">
				<h3>{s.source.name} <span class="muted">· {s.country.name}</span></h3>
				<p class="muted">
					{loaded} of {s.regions.length} regions loaded ·
					<a href={s.source.homepage} target="_blank" rel="noopener">{s.source.name} ↗</a>
				</p>

				{#if shownRegions(s).length > 0}
					<ul class="regions">
						{#each shownRegions(s) as r (r.code)}
							{@const key = `${s.source.id}:${r.code}`}
							{@const active = activeOf(s.source.id, r)}
							<li class="region" id={externalRegionId(r.code)} tabindex="-1">
								<div class="rowhead">
									<div class="what">
										<strong
											>{r.name}{#if r.link}&nbsp;<a class="rlink" href={r.link} target="_blank" rel="noopener"
													>{s.source.name} ↗</a
												>{/if}</strong
										>
										{#if r.published}
											<span class="facts">
												{reportsText(r.published.reports)} · {r.published.species} species ·
												{windowLabel(r.published.windowStart, r.published.windowEnd)} · loaded
												{loadedOn(r.published.finishedAt)}
											</span>
										{/if}
										{#if active}
											<span class="state" role="status">{statusText(active)}</span>
										{:else if r.failed}
											<span class="state err">Last load failed{r.failed.error ? `: ${r.failed.error}` : '.'}</span>
										{/if}
									</div>
									{#if canLoad && !active}
										<form method="POST" action="?/queueExternalLoad" use:enhance={submitter(key)}>
											<input type="hidden" name="source_id" value={s.source.id} />
											<input type="hidden" name="region_code" value={r.code} />
											<button type="submit" class="secondary" disabled={sending !== null}>
												{sending === key ? 'Queueing…' : r.published ? 'Reload' : 'Try again'}
											</button>
										</form>
									{/if}
								</div>
								{#if result?.regionCode === r.code && result.externalError}
									<p class="error" role="alert">{result.externalError}</p>
								{:else if result?.externalQueued?.regionCode === r.code && result.externalQueued.sourceId === s.source.id}
									<p class="notice ok" role="status">
										{result.externalQueued.created ? 'Queued.' : 'Already queued or loading.'} Progress shows here.
									</p>
								{/if}
								{#if r.published}
									<details class="fold">
										<summary>Bird reports by month</summary>
										<ReportMonthStrip counts={r.published.monthTotals} label="All bird reports in {r.name}, by month" />
										<p class="muted small">
											All bird species together; each cell adds up that month across the whole window. {r.published.places} municipalities.
										</p>
									</details>
									<p class="where">
										<a href={whereWhenHref(s.source.id, r.code)}>Where and when to look in {r.name} ›</a>
									</p>
									{#if r.observers.length > 0}
										<details class="fold">
											<summary>Most active birders ({r.observers.length})</summary>
											<ObserverTable observers={r.observers} sourceName={s.source.name} />
										</details>
									{/if}
								{/if}
							</li>
						{/each}
					</ul>
				{/if}

				{#if canLoad && otherRegions(s).length > 0}
					{@const others = otherRegions(s)}
					{@const choice = pickedRegion(picked[s.source.id], others)}
					{@const key = `${s.source.id}:${choice}`}
					<form class="loadother" method="POST" action="?/queueExternalLoad" use:enhance={submitter(key)}>
						<input type="hidden" name="source_id" value={s.source.id} />
						<label for="ext-pick-{s.source.id}">{shownRegions(s).length > 0 ? 'Load another region' : 'Load a region'}</label>
						<div class="pickrow">
							<select
								id="ext-pick-{s.source.id}"
								name="region_code"
								value={choice}
								onchange={(e) => (picked[s.source.id] = e.currentTarget.value)}
							>
								{#each others as r (r.code)}
									<option value={r.code}>{r.name}</option>
								{/each}
							</select>
							<button type="submit" class="primary" disabled={sending !== null}>
								{sending === key ? 'Queueing…' : 'Load reports'}
							</button>
						</div>
						{#if result?.externalError && (!result.regionCode || others.some((r) => r.code === result?.regionCode))}
							<p class="error" role="alert">{result.externalError}</p>
						{/if}
					</form>
				{/if}

				<ExternalAttribution source={s.source} />
			</div>
		{/each}
	{/if}
</section>

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
		font-size: 1rem;
		margin: 16px 0 4px;
	}
	.callout {
		margin: 0 0 8px;
		padding: 8px 10px;
		border-left: 3px solid var(--info-border);
		background: var(--info-bg);
		color: var(--info-text);
		border-radius: 6px;
		font-size: 0.9rem;
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.82rem;
	}
	.source + .source {
		border-top: 1px solid var(--border);
		margin-top: 16px;
	}
	.regions {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
	}
	.region {
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
	}
	.region:last-child {
		border-bottom: none;
	}
	.region:focus-visible {
		outline-offset: 2px;
	}
	.rowhead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		flex-wrap: wrap;
	}
	.what {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.facts,
	.state {
		font-size: 0.85rem;
		color: var(--muted);
	}
	.rlink {
		font-weight: 400;
		font-size: 0.85rem;
	}
	.state.err {
		color: var(--danger);
	}
	.fold summary {
		display: flex;
		align-items: center;
		min-height: 48px;
		list-style: none;
		cursor: pointer;
		font-size: 0.92rem;
	}
	.fold summary::-webkit-details-marker {
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
	.where {
		margin: 0;
	}
	.where a {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
		font-size: 0.92rem;
	}
	.loadother {
		margin-top: 12px;
	}
	.loadother label {
		display: block;
		font-size: 0.9rem;
		margin-bottom: 4px;
	}
	.pickrow {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.pickrow select {
		flex: 1 1 180px;
		min-width: 0;
	}
	button.primary,
	button.secondary {
		min-height: 48px;
		padding: 6px 14px;
		border-radius: 8px;
		cursor: pointer;
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
	.error {
		color: var(--danger);
		font-weight: 600;
		margin: 8px 0;
	}
	.notice {
		margin: 8px 0;
		font-size: 0.9rem;
	}
	.notice.ok {
		color: var(--accent);
	}
</style>
