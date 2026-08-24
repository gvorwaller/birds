<script lang="ts" module>
	// Structurally matches MediaRow/SampleMedia from $server/species-enrichment
	// (kept local to avoid importing a server-only module into client code —
	// same pattern as BestPlaces.svelte's Place / FrequencyChart's ChartMonth).
	export interface MediaRow {
		media_id: number;
		species_code: string;
		kind: 'photo' | 'sound';
		vocalization_type: string | null;
		rank: number;
		provider: 'wikimedia_commons' | 'xeno_canto';
		provider_id: string;
		media_url: string;
		thumbnail_url: string | null;
		source_url: string;
		title: string | null;
		creator: string | null;
		license_code: string;
		license_url: string | null;
		location: string | null;
		duration_seconds: number | null;
		width: number | null;
		height: number | null;
	}

	export interface SampleMedia {
		photo: MediaRow | null;
		sounds: MediaRow[];
		status: string | null;
		mediaError: string | null;
		audioStatus: 'restricted' | null;
	}
</script>

<script lang="ts">
	// Field-guide sample media (plan: docs/2026-08-23-field-guide-sample-media-
	// CLAUDE.md §10c). Card placed after "Your photos", before "Finding this
	// bird" (species page §11). Non-admin visibility is gated by the caller
	// (media present); admin also sees error/partial/no_media notices here.
	import SpeciesAudioPlayer from './SpeciesAudioPlayer.svelte';

	let {
		media,
		comName,
		isAdmin = false
	}: {
		media: SampleMedia;
		comName: string;
		isAdmin?: boolean;
	} = $props();

	// CLS prevention (spec invariant #11): aspect-ratio from the stored
	// dimensions, 4:3 fallback when they're unknown.
	const aspectRatio = $derived(
		media.photo?.width && media.photo?.height
			? `${media.photo.width} / ${media.photo.height}`
			: '4 / 3'
	);

	function vocalLabel(row: MediaRow): string {
		if (row.vocalization_type === 'song') return 'Song';
		if (row.vocalization_type === 'call') return 'Call';
		return 'Sound';
	}

	const subtitle = $derived(
		media.photo && media.sounds.length > 0
			? 'reference photo & sounds'
			: media.photo
				? 'reference photo'
				: media.sounds.length > 0
					? 'reference sounds'
					: null
	);
	const audioRestricted = $derived(
		media.audioStatus === 'restricted' && media.sounds.length === 0
	);
	const hasBoth = $derived(!!media.photo && (media.sounds.length > 0 || audioRestricted));
	const lastGood = $derived(!!media.photo || media.sounds.length > 0);
</script>

<section class="card">
	<h2>
		Identification
		{#if subtitle}<span class="muted">{subtitle}</span>{/if}
	</h2>
	{#if isAdmin && media.status === 'error'}
		<p class="notice err" role="alert">
			Media refresh failed{media.mediaError ? `: ${media.mediaError}` : '.'}
			{#if lastGood} Showing previously fetched sample media.{/if}
		</p>
	{:else if isAdmin && media.status === 'partial'}
		<p class="notice muted">Partial media — some sources were unavailable.</p>
	{:else if isAdmin && media.status === 'no_media'}
		<p class="notice muted">No sample media found for {comName} yet.</p>
	{/if}
	{#if media.photo || media.sounds.length > 0 || audioRestricted}
		<div class="layout" class:has-both={hasBoth}>
			{#if media.photo}
				<div class="photo-col">
					<a
						class="photo-link"
						href={media.photo.source_url}
						target="_blank"
						rel="noopener"
						style:aspect-ratio={aspectRatio}
					>
						<img
							src={media.photo.thumbnail_url ?? media.photo.media_url}
							alt="Identification photo of {comName}"
							loading="lazy"
							decoding="async"
						/>
					</a>
					<p class="credit muted">
						{media.photo.creator ?? 'Unknown'} ·
						<a href={media.photo.source_url} target="_blank" rel="noopener">source ↗</a>
						{#if media.photo.license_url}
							· <a href={media.photo.license_url} target="_blank" rel="noopener"
								>{media.photo.license_code}</a
							>
						{:else}
							· {media.photo.license_code}
						{/if}
					</p>
				</div>
			{/if}
			{#if media.sounds.length > 0}
				<div class="players">
					{#each media.sounds as s (s.media_id)}
						<SpeciesAudioPlayer
							mediaUrl={s.media_url}
							label={vocalLabel(s)}
							creator={s.creator}
							licenseCode={s.license_code}
							licenseUrl={s.license_url}
							sourceUrl={s.source_url}
							durationSeconds={s.duration_seconds}
						/>
					{/each}
				</div>
			{:else if audioRestricted}
				<div class="audio-unavailable" role="status">
					<strong>Audio unavailable</strong>
					<p>
						xeno-canto does not currently provide downloadable audio for this species.
					</p>
				</div>
			{/if}
		</div>
	{/if}
</section>

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
	.card h2 .muted {
		font-weight: 400;
		font-size: 0.85rem;
	}
	.muted {
		color: var(--muted);
		font-size: 0.89rem;
	}
	.notice {
		margin-bottom: 10px;
	}
	.audio-unavailable {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 14px;
		color: var(--text);
		background: var(--surface-subtle, var(--card));
	}
	.audio-unavailable p {
		margin: 4px 0 0;
		color: var(--muted);
		font-size: 0.89rem;
	}
	.err {
		color: var(--danger);
		font-size: 0.89rem;
	}
	.layout {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	/* Aspect-ratio lives on the frame (not the img) so the reserved box is
	   stable before the bytes arrive (CLS). max-height clamps portraits;
	   object-fit: contain letterboxes inside the frame. */
	.photo-link {
		display: block;
		position: relative;
		width: 100%;
		max-height: 280px;
		overflow: hidden;
		border-radius: 8px;
		background: var(--border);
	}
	.photo-link:focus-visible {
		outline: 3px solid var(--accent);
		outline-offset: 2px;
	}
	.photo-col img {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
	.credit {
		font-size: 0.72rem;
		margin: 6px 0 0;
		overflow-wrap: anywhere;
	}
	.credit a {
		color: var(--link);
		text-underline-offset: 2px;
	}
	.players {
		display: flex;
		flex-direction: column;
	}
	/* Separator between stacked players (spec §10b) — SpeciesAudioPlayer's
	   root element carries this class; :global pierces its component
	   boundary since these are separate instances, not this file's own
	   template elements. */
	.players :global(.player + .player) {
		border-top: 1px solid var(--border);
	}
	@media (min-width: 640px) {
		.layout.has-both {
			flex-direction: row;
			align-items: flex-start;
		}
		.layout.has-both .photo-col {
			flex: 0 0 50%;
			max-width: 50%;
		}
		.layout.has-both .players,
		.layout.has-both .audio-unavailable {
			flex: 1;
			min-width: 0;
		}
		.photo-link {
			max-height: 360px;
		}
	}
</style>
