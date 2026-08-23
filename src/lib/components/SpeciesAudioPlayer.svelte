<script lang="ts">
	// Field-guide sample media (plan: docs/2026-08-23-field-guide-sample-media-
	// CLAUDE.md §10b). Custom 48px circular play/pause button driving a hidden
	// native <audio preload="none"> — no autoplay, no service-worker caching,
	// page-level coordination via $lib/stores/playback.svelte so starting one
	// player pauses any other on the page (spec invariant #9).
	import { registerPause, registerPlay } from '$lib/stores/playback.svelte';

	let {
		mediaUrl,
		label,
		creator,
		licenseCode,
		licenseUrl,
		sourceUrl,
		durationSeconds
	}: {
		mediaUrl: string;
		label: string;
		creator: string | null;
		licenseCode: string;
		licenseUrl: string | null;
		sourceUrl: string;
		durationSeconds: number | null;
	} = $props();

	let audioEl: HTMLAudioElement | null = $state(null);
	let playing = $state(false);
	let failed = $state(false);

	function toggle(): void {
		if (!audioEl) return;
		failed = false;
		if (playing) audioEl.pause();
		else audioEl.play().catch(() => {
			playing = false;
			failed = true;
		});
	}

	function onPlay(): void {
		playing = true;
		failed = false;
		if (audioEl) registerPlay(audioEl);
	}

	function onPause(): void {
		playing = false;
		if (audioEl) registerPause(audioEl);
	}

	function onError(): void {
		playing = false;
		failed = true;
	}

	function formatDuration(sec: number | null): string | null {
		if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
		const rounded = Math.round(sec);
		const m = Math.floor(rounded / 60);
		const s = rounded % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
	}
	const durationLabel = $derived(formatDuration(durationSeconds));

	// A player that unmounts mid-playback (e.g. client-side navigating away)
	// must actually STOP the audio — a media element removed from the DOM
	// keeps playing per the HTML spec — and must not leave a stale element
	// pinned as the page's "active" player.
	$effect(() => {
		return () => {
			if (audioEl) {
				audioEl.pause();
				registerPause(audioEl);
			}
		};
	});
</script>

<div class="player">
	<button
		type="button"
		class="playbtn"
		onclick={toggle}
		aria-pressed={playing}
		aria-label={playing ? `Pause ${label}` : `Play ${label}`}
	>
		{#if playing}
			<span class="icon pause" aria-hidden="true">❚❚</span>
		{:else}
			<span class="icon play" aria-hidden="true">▶</span>
		{/if}
	</button>
	<div class="info">
		<div class="row1">
			<span class="badge">{label}</span>
			{#if durationLabel}<span class="duration muted">{durationLabel}</span>{/if}
		</div>
		<p class="credit muted">
			{creator ?? 'Unknown'} ·
			<a href={sourceUrl} target="_blank" rel="noopener">source ↗</a>
			{#if licenseUrl}
				· <a href={licenseUrl} target="_blank" rel="noopener">{licenseCode}</a>
			{:else}
				· {licenseCode}
			{/if}
		</p>
		{#if failed}
			<p class="fail muted" role="status">Couldn't play this recording — try the source link.</p>
		{/if}
	</div>
	<audio
		bind:this={audioEl}
		class="native"
		src={mediaUrl}
		preload="none"
		onplay={onPlay}
		onpause={onPause}
		onended={onPause}
		onerror={onError}
	></audio>
</div>

<style>
	.player {
		position: relative;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 0;
	}
	/* Visually hidden, not display:none — Safari can refuse play() on a
	   display-none <audio>. The custom 48px button is the only control. */
	.native {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}
	.playbtn {
		flex: 0 0 48px;
		width: 48px;
		height: 48px;
		min-width: 48px;
		min-height: 48px;
		border-radius: 50%;
		border: 2px solid var(--accent);
		background: var(--card);
		color: var(--accent);
		font-size: 1.05rem;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}
	.playbtn:focus-visible {
		outline: 3px solid var(--accent);
		outline-offset: 2px;
	}
	/* ▶ sits optically left of center in a circle without a nudge. */
	.icon.play {
		padding-left: 2px;
	}
	.info {
		flex: 1;
		min-width: 0;
	}
	.row1 {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.badge {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 6px;
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		background: var(--accent-soft);
		color: var(--accent);
	}
	.duration {
		font-size: 0.82rem;
	}
	.muted {
		color: var(--muted);
	}
	.credit {
		font-size: 0.72rem;
		margin: 4px 0 0;
		overflow-wrap: anywhere;
	}
	.credit a {
		color: var(--link);
		text-underline-offset: 2px;
	}
	.fail {
		font-size: 0.72rem;
		margin: 4px 0 0;
	}
</style>
