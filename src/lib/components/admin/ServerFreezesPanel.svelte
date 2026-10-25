<script lang="ts">
	/**
	 * Admin → Metrics, Server freezes (td-b07462, under td-c4a58d): each time
	 * the web process stopped responding for a second or more, and what was
	 * running. While it is frozen every page waits, so Slow pages below marks
	 * the requests that only waited. Read when the tab opens.
	 */
	import { onMount } from 'svelte';
	import CollapsibleCard from '$components/CollapsibleCard.svelte';
	import type { ServerFreezesReport } from '$server/freeze-watch';
	import { describeFreeze } from '$lib/freeze-text';

	let report = $state<ServerFreezesReport | null>(null);
	let loadError = $state<string | null>(null);
	let showAll = $state(false);
	const SHOWN = 10;

	onMount(() => {
		const controller = new AbortController();
		fetch('/api/admin/server-freezes', { headers: { accept: 'application/json' }, signal: controller.signal })
			.then(async (res) => {
				if (!res.ok) throw new Error(String(res.status));
				report = (await res.json()) as ServerFreezesReport;
			})
			.catch(() => {
				if (!controller.signal.aborted) loadError = 'Server freezes are unavailable right now.';
			});
		return () => controller.abort();
	});

	const n = (v: number) => v.toLocaleString();
	function fmtMs(ms: number): string {
		return ms < 1000 ? `${ms.toLocaleString()} ms` : `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
	}
	const fmtWhen = (iso: string) =>
		new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
	const shortVersion = (v: string) => (v.length > 7 ? v.slice(0, 7) : v);

</script>

<CollapsibleCard id="metrics-freezes" title="Server freezes">
	{#if loadError}<p class="error" role="alert">{loadError}</p>{/if}
	{#if !report}
		{#if !loadError}<p class="muted">Loading…</p>{/if}
	{:else}
		{@const r = report}
		<p class="note">
			Each time the server stopped responding for {fmtMs(r.thresholdMs)} or more. While it is stopped, every page for
			everyone waits: requests already running pause, and new ones queue before the server sees them (so they are not
			listed here or in Slow pages). Slow pages below marks the requests whose time includes a freeze. Kept
			{r.retentionDays} days.
		</p>
		<p class="summary">
			Last 7 days: {#if r.count === 0}none{:else}{n(r.count)} {r.count === 1 ? 'freeze' : 'freezes'}, {fmtMs(r.totalMs)} in
				all, the longest {fmtMs(r.worstMs)}{/if}.
		</p>

		{#if r.recent.length}
			<h3>Latest</h3>
			<ul>
				{#each showAll ? r.recent : r.recent.slice(0, SHOWN) as f, i (`${f.startedAt}-${i}`)}
					<li>
						<div class="rhead"><span>{fmtWhen(f.startedAt)}</span><span class="bad">stopped {fmtMs(f.durationMs)}</span></div>
						<p class="line">{describeFreeze(f)}</p>
						<p class="meta">
							{#if f.gcMs}garbage collection {fmtMs(f.gcMs)} of it · {/if}memory {n(f.rssMb)} MB (heap {n(f.heapMb)} MB) ·
							deploy {shortVersion(f.version)}
						</p>
					</li>
				{/each}
			</ul>
			{#if r.recent.length > SHOWN}
				<button type="button" class="more" aria-expanded={showAll} onclick={() => (showAll = !showAll)}>
					{showAll ? `Show the newest ${SHOWN} only` : `Show all ${n(r.recent.length)}`}
				</button>
			{/if}
		{/if}
	{/if}
</CollapsibleCard>

<style>
	p {
		margin: 6px 0;
	}
	h3 {
		font-size: 0.95rem;
		margin: 16px 0 6px;
	}
	.muted,
	.note,
	.meta {
		color: var(--muted);
		font-size: 0.85rem;
	}
	.summary {
		font-weight: 600;
	}
	.error,
	.bad {
		color: var(--danger);
		font-weight: 600;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li {
		padding: 10px 0;
		border-bottom: 1px solid var(--border);
	}
	li:last-child {
		border-bottom: none;
	}
	.rhead {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 4px 12px;
	}
	.line {
		font-size: 0.88rem;
		margin: 4px 0 0;
		overflow-wrap: anywhere;
	}
	.more {
		min-height: 48px;
		margin-top: 8px;
		padding: 0 14px;
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 8px;
		font: inherit;
		cursor: pointer;
	}
</style>
