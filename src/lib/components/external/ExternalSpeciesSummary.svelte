<script lang="ts">
	/**
	 * Where an external source has reports of a species (td-eec7db Phase 3):
	 * each loaded region with its report count and busiest months, linking
	 * to that region's card on the species forecast. Used on the species
	 * page and on forecast/species when the region is a whole country. The
	 * caller supplies the heading.
	 */
	import type { ExternalSpeciesSummary } from '$server/external-sources/reports';
	import { MONTH_SHORT, busiestMonths, reportsText } from '$lib/external-reports';
	import ExternalAttribution from './ExternalAttribution.svelte';

	let {
		summaries,
		speciesCode,
		speciesName,
		emptyText = null
	}: {
		summaries: ExternalSpeciesSummary[];
		speciesCode: string;
		speciesName: string;
		/** Shown when no source has a report of it; nothing renders when null. */
		emptyText?: string | null;
	} = $props();

	const regionHref = (code: string) =>
		`/forecast/species?species=${encodeURIComponent(speciesCode)}&region=${encodeURIComponent(code)}`;
</script>

{#if summaries.length === 0}
	{#if emptyText}<p class="muted">{emptyText}</p>{/if}
{:else}
	{#each summaries as s (s.source.id)}
		{@const first = s.regions[0]}
		{@const same = s.regions.every((r) => r.windowStart === first?.windowStart && r.windowEnd === first?.windowEnd)}
		<p class="callout">
			Counts of reports of {speciesName} sent to {s.source.name}, not checklist frequency or the chance of seeing it.
			Only regions that have been loaded are listed.
		</p>
		<ul class="regions">
			{#each s.regions as r (r.regionCode)}
				{@const best = busiestMonths(r.months)}
				<li>
					<a href={regionHref(r.regionCode)}>{r.regionName}</a>
					<span class="facts">
						{reportsText(r.reports)}{#if best.length > 0}&nbsp;· most in {best
								.map((m) => MONTH_SHORT[m - 1])
								.join(', ')}{/if}
					</span>
				</li>
			{/each}
		</ul>
		{#if same}
			<ExternalAttribution source={s.source} windowStart={first?.windowStart} windowEnd={first?.windowEnd} />
		{:else}
			<p class="muted small">
				Regions loaded at different times cover different windows; each region's card shows its own.
			</p>
			<ExternalAttribution source={s.source} />
		{/if}
	{/each}
{/if}

<style>
	.callout {
		margin: 0 0 8px;
		padding: 8px 10px;
		border-left: 3px solid var(--info-border);
		background: var(--info-bg);
		color: var(--info-text);
		border-radius: 6px;
		font-size: 0.9rem;
	}
	.regions {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.regions li {
		display: flex;
		align-items: center;
		gap: 4px 10px;
		flex-wrap: wrap;
		min-height: 48px;
		border-bottom: 1px solid var(--border);
	}
	.regions li:last-child {
		border-bottom: none;
	}
	.regions a {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
		font-weight: 600;
	}
	.facts {
		color: var(--muted);
		font-size: 0.88rem;
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.82rem;
	}
</style>
