<script lang="ts" module>
	// Structurally matches the shapes from $server/species-enrichment (kept
	// local to avoid importing a server-only module into client code — same
	// pattern as SpeciesMediaCard.svelte's MediaRow).
	export interface SimilarSpeciesRow {
		species_code: string;
		com_name: string;
		sci_name: string;
		misid_count: number | null;
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
	export interface UnresolvedSimilarRow {
		inat_sci_name: string;
		inat_com_name: string | null;
		misid_count: number;
	}
	export type InatSimilarStatus = 'pending' | 'ok' | 'none' | 'no_mapping' | 'error';
</script>

<script lang="ts">
	// Similar species card (td-460b1c Phase B, plan: docs/2026-08-27-similar-
	// species-inat-plan.md). One tier: confusion pairs sourced from iNaturalist
	// observer misidentification data, resolved and selected by the worker's
	// reconcile step. Render predicate (GROK G5/G8): the card shows when there
	// are rows OR unresolved entries OR an honest data-state to explain
	// (no_mapping/error — Gaylon 2026-08-28: "I'm the primary user, and I want
	// to know"). 'none' and 'pending' stay hidden (decision 7).
	import Badge from './Badge.svelte';
	import { speciesLinkHref, type SpeciesLocationContext } from '$lib/species-context';

	let {
		similar,
		unresolved,
		inatStatus,
		backDays,
		returnTo,
		context = null
	}: {
		similar: SimilarSpeciesRow[];
		unresolved: UnresolvedSimilarRow[];
		inatStatus: InatSimilarStatus;
		backDays: number;
		returnTo: string;
		context?: SpeciesLocationContext | null;
	} = $props();

	const showCard = $derived(
		similar.length > 0 ||
			unresolved.length > 0 ||
			inatStatus === 'no_mapping' ||
			inatStatus === 'error'
	);
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
				{#if item.misid_count !== null}
					Misidentified for each other {item.misid_count} time{item.misid_count === 1
						? ''
						: 's'} on iNaturalist
				{:else}
					Flagged confusable from this species&rsquo; own confusion data
				{/if}
			</p>
		</div>
	</div>
{/snippet}

{#if showCard}
	<section class="card">
		<h2>Similar species</h2>
		{#if similar.length > 0}
			<div class="similar-list">
				{#each similar as item (item.species_code)}
					{@render row(item)}
				{/each}
			</div>
		{/if}
		{#if inatStatus === 'no_mapping'}
			<p class="state-note muted">
				This species couldn’t be matched to iNaturalist’s taxonomy, so no
				misidentification data is available for it.
			</p>
		{:else if inatStatus === 'error'}
			<p class="state-note muted">
				Couldn’t load misidentification data for this species; it will retry
				automatically.
			</p>
		{/if}
		{#if unresolved.length > 0}
			{#if unresolved.length <= 2}
				<p class="unresolved muted">
					iNaturalist observers also confuse this species with
					{#each unresolved as u, i}{i > 0 ? '; ' : ''}<em>{u.inat_sci_name}</em
						>{#if u.inat_com_name}&nbsp;({u.inat_com_name}){/if}{/each} — no matching eBird
					species here.
				</p>
			{:else}
				<details class="unresolved-details">
					<summary class="unresolved muted"
						>{unresolved.length} more confusion partners with no matching eBird species</summary
					>
					<ul class="unresolved-list muted">
						{#each unresolved as u (u.inat_sci_name)}
							<li>
								<em>{u.inat_sci_name}</em>{#if u.inat_com_name}&nbsp;({u.inat_com_name}){/if} —
								{u.misid_count} misidentification{u.misid_count === 1 ? '' : 's'}
							</li>
						{/each}
					</ul>
				</details>
			{/if}
		{/if}
		<p class="ai-attrib muted">
			Confusion data from
			<a href="https://www.inaturalist.org" target="_blank" rel="noopener">iNaturalist</a>
			observer misidentifications · notes AI-generated · verify in the field
		</p>
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
	.state-note {
		font-size: 0.86rem;
		margin: 4px 0 0;
		line-height: 1.4;
	}
	.unresolved {
		font-size: 0.8rem;
		margin: 10px 0 0;
		line-height: 1.4;
	}
	.unresolved-details {
		margin: 10px 0 0;
	}
	.unresolved-details summary {
		cursor: pointer;
	}
	.unresolved-list {
		font-size: 0.8rem;
		margin: 6px 0 0;
		padding-left: 18px;
		line-height: 1.5;
	}
	.ai-attrib a {
		color: var(--link);
		text-underline-offset: 2px;
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
