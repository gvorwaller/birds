<script lang="ts" module>
	// Structurally matches SimilarSpecies from $server/species-enrichment
	// (kept local to avoid importing a server-only module into client code —
	// same pattern as SpeciesMediaCard.svelte's MediaRow / BestPlaces.svelte's
	// Place / FrequencyChart's ChartMonth).
	export interface SimilarSpeciesRow {
		species_code: string;
		com_name: string;
		sci_name: string;
		basis: 'ebird_slash' | 'genus';
		slash_com_name: string | null;
		note: string | null;
		photo: {
			thumbnail_url: string | null;
			source_url: string;
			creator: string | null;
			license_code: string;
			license_url: string | null;
			width: number | null;
			height: number | null;
		} | null;
		seen: boolean;
	}
</script>

<script lang="ts">
	// Similar species / related species card (plan: docs/2026-08-25-similar-
	// species-plan.md, td-8f0ed8). Placed after Identification, before
	// "Finding this bird" (species page §5). Tier 1 (similar) is eBird's own
	// slash-taxa reporting groups — a sourced confusion claim. Tier 2
	// (related) is same-genus — NOT a confusion claim, just taxonomic
	// closeness. One card, adaptive heading: whichever tier(s) are non-empty
	// decide whether we render a single <h2> or a combined <h2> + two <h3>s.
	// Renders nothing at all when both arrays are empty (silent zero state —
	// every other card on this page is likewise conditionally present).
	import Badge from './Badge.svelte';
	import { speciesLinkHref, type SpeciesLocationContext } from '$lib/species-context';

	let {
		similar,
		related,
		backDays,
		returnTo,
		context = null
	}: {
		similar: SimilarSpeciesRow[];
		related: SimilarSpeciesRow[];
		backDays: number;
		returnTo: string;
		context?: SpeciesLocationContext | null;
	} = $props();

	const hasSimilar = $derived(similar.length > 0);
	const hasRelated = $derived(related.length > 0);
	const hasAiNote = $derived([...similar, ...related].some((item) => item.note != null));
</script>

{#snippet row(item: SimilarSpeciesRow)}
	{@const href = speciesLinkHref(item.species_code, { backDays, returnTo, context })}
	<div class="similar-row">
		{#if item.photo && item.photo.thumbnail_url}
			<div class="photo-col">
				<a class="thumb-frame" href={item.photo.source_url} target="_blank" rel="noopener">
					<img
						src={item.photo.thumbnail_url}
						alt="Reference photo of {item.com_name}"
						loading="lazy"
						decoding="async"
					/>
				</a>
				<p class="credit muted">
					{item.photo.creator ?? 'Unknown'} ·
					<a href={item.photo.source_url} target="_blank" rel="noopener">source ↗</a>
					{#if item.photo.license_url}
						· <a href={item.photo.license_url} target="_blank" rel="noopener"
							>{item.photo.license_code}</a
						>
					{:else}
						· {item.photo.license_code}
					{/if}
				</p>
			</div>
		{:else}
			<div class="photo-placeholder" aria-hidden="true">
				<span class="placeholder-icon">🪶</span>
			</div>
		{/if}

		<div class="info-col">
			<div class="name-line">
				<a class="species-link" {href}>
					<span class="com-name">{item.com_name}</span>
					<em class="sci-name">{item.sci_name}</em>
				</a>
				<Badge kind={item.seen ? 'seen' : 'need'} label={item.seen ? 'Seen' : 'Need'} />
			</div>

			{#if item.note}
				<p class="diff-note">{item.note}</p>
			{/if}

			<p class="basis muted">
				{#if item.basis === 'ebird_slash' && item.slash_com_name}
					eBird reporting group: <em>{item.slash_com_name}</em>
				{:else}
					Same genus — not necessarily a look-alike
				{/if}
			</p>
		</div>
	</div>
{/snippet}

{#if hasSimilar || hasRelated}
	<section class="card">
		{#if hasSimilar && hasRelated}
			<h2>Similar &amp; related species</h2>
			<h3>Similar species</h3>
			<div class="similar-list">
				{#each similar as item (item.species_code)}
					{@render row(item)}
				{/each}
			</div>
			<div class="tier-divider"></div>
			<h3>Related species</h3>
			<div class="similar-list">
				{#each related as item (item.species_code)}
					{@render row(item)}
				{/each}
			</div>
		{:else if hasSimilar}
			<h2>Similar species</h2>
			<div class="similar-list">
				{#each similar as item (item.species_code)}
					{@render row(item)}
				{/each}
			</div>
		{:else}
			<h2>Related species</h2>
			<div class="similar-list">
				{#each related as item (item.species_code)}
					{@render row(item)}
				{/each}
			</div>
		{/if}
		{#if hasAiNote}
			<p class="ai-attrib muted">AI-generated from Wikipedia · verify in the field</p>
		{/if}
	</section>
{/if}

<style>
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
	.card h3 {
		font-size: 0.92rem;
		margin-bottom: 6px;
	}
	.tier-divider {
		border-top: 1px solid var(--border);
		margin: 12px 0;
	}
	.similar-list {
		display: flex;
		flex-direction: column;
	}
	.similar-row {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 12px 0;
		border-top: 1px solid var(--border);
	}
	.similar-row:first-of-type {
		border-top: none;
	}

	.photo-col {
		flex: 0 0 84px;
		max-width: 84px;
	}
	.thumb-frame {
		display: block;
		width: 84px;
		height: 84px;
		border-radius: 6px;
		overflow: hidden;
		background: var(--border);
		border: 1px solid var(--border);
	}
	.thumb-frame img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.thumb-frame:focus-visible {
		outline: 3px solid var(--accent);
		outline-offset: 2px;
	}
	.photo-placeholder {
		flex: 0 0 84px;
		width: 84px;
		height: 84px;
		border-radius: 6px;
		background: var(--bg);
		border: 1px dashed var(--border);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.placeholder-icon {
		font-size: 1.5rem;
		opacity: 0.4;
	}

	.credit {
		font-size: 0.72rem;
		margin: 6px 0 0;
		overflow-wrap: anywhere;
		line-height: 1.25;
	}
	.credit a {
		color: var(--link);
		text-underline-offset: 2px;
	}

	.info-col {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.name-line {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}
	/* Tap target: inline-flex + min-height 48px, align-items: center — the
	   same pattern already used for a.nplace / a.cl in +page.svelte, rather
	   than AGY's baseline-aligned draft (which risked odd vertical alignment
	   against the adjacent Badge). Because the media column already reserves
	   84/96px of row height, growing this link to 48px does not inflate the
	   row's total height in the common case. */
	.species-link {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
		min-height: 48px;
		color: var(--text);
		text-decoration: none;
	}
	.species-link:hover {
		text-decoration: underline;
	}
	.com-name {
		font-weight: 700;
		font-size: 0.98rem;
	}
	.sci-name {
		color: var(--muted);
		font-size: 0.84rem;
		font-style: italic;
	}

	.diff-note {
		font-size: 0.89rem;
		line-height: 1.45;
		color: var(--text);
		margin: 2px 0;
	}

	.basis {
		font-size: 0.78rem;
		margin: 0;
	}
	.ai-attrib {
		font-size: 0.76rem;
		margin: 10px 0 0;
	}
	.muted {
		color: var(--muted);
	}

	@media (min-width: 640px) {
		.photo-col,
		.thumb-frame,
		.photo-placeholder {
			flex: 0 0 96px;
			width: 96px;
			max-width: 96px;
		}
		.thumb-frame,
		.photo-placeholder {
			height: 96px;
		}
	}
</style>
