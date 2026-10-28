<script lang="ts">
	/**
	 * Attribution for an external source (td-eec7db Phase 3): one muted line
	 * that names the source, licence and window, and a "Source & license"
	 * fold with the citation, the data-quality note the source's terms ask
	 * for, and the sensitive-species caveat. Modelled on the species page's
	 * Wikipedia "Source & license".
	 */
	import type { ExternalSourceInfo } from '$server/external-sources/reports';
	import { windowLabel } from '$lib/external-reports';

	let {
		source,
		windowStart = null,
		windowEnd = null,
		retrievedAt = null
	}: {
		source: Pick<ExternalSourceInfo, 'name' | 'attribution' | 'license' | 'licenseUrl' | 'homepage'> &
			Partial<Pick<ExternalSourceInfo, 'citation' | 'doi'>>;
		windowStart?: string | null;
		windowEnd?: string | null;
		retrievedAt?: string | null;
	} = $props();

	const retrievedOn = $derived(
		retrievedAt
			? new Date(retrievedAt).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
			: null
	);
</script>

<p class="attrib">
	{source.attribution}{#if windowStart && windowEnd}&nbsp;· {windowLabel(windowStart, windowEnd)}{/if}{#if retrievedOn}&nbsp;·
		retrieved {retrievedOn}{/if}
</p>
<details class="license">
	<summary>Source &amp; license</summary>
	<div class="body">
		{#if source.citation}<p>{source.citation}</p>{/if}
		<p>
			Licensed <a href={source.licenseUrl} target="_blank" rel="noopener">{source.license}</a>.
			{#if source.doi}DOI <a href="https://doi.org/{source.doi}" target="_blank" rel="noopener">{source.doi}</a>.{/if}
			<a href={source.homepage} target="_blank" rel="noopener">{source.name} ↗</a>
		</p>
		<p>
			About the data: these are reports people sent to {source.name}, shown as reported; reports the source rejected
			are not published. The counts follow where and how often people go birding and report, so busy places and
			conspicuous birds get more. They are not checklist frequencies or the chance of seeing a bird.
		</p>
		<p>
			Some sensitive species are hidden by the source, so "no reports" never means a bird isn't there.
		</p>
	</div>
</details>

<style>
	.attrib {
		margin: 10px 0 0;
		font-size: 0.78rem;
		color: var(--muted);
	}
	.license summary {
		display: flex;
		align-items: center;
		min-height: 48px;
		list-style: none;
		cursor: pointer;
		font-size: 0.78rem;
		color: var(--muted);
	}
	.license summary::-webkit-details-marker {
		display: none;
	}
	.license summary::after {
		content: '▸';
		margin-left: 6px;
		color: var(--accent);
	}
	.license[open] summary::after {
		content: '▾';
	}
	.body {
		font-size: 0.82rem;
		color: var(--muted);
	}
	.body p {
		margin: 0 0 8px;
	}
</style>
