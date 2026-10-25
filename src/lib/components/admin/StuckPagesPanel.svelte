<script lang="ts">
	/**
	 * Admin → Metrics, Stuck pages (td-1cb094, under td-c4a58d): what browsers
	 * report about their own navigations. Slow pages above only sees the
	 * server; a phone that hangs after the server has answered shows up here
	 * instead, including a hang that ended with the app being killed (reported
	 * the next time the app opens). Read when the tab opens.
	 */
	import { onMount } from 'svelte';
	import CollapsibleCard from '$components/CollapsibleCard.svelte';
	import { FREEZE_MS, SLOW_NAV_MS, STALL_KIND_LABEL, describeStall as describe, deviceLabel, type StallKind } from '$lib/client-stalls';
	import type { ClientStallsReport } from '$server/client-stalls';

	let report = $state<ClientStallsReport | null>(null);
	let loadError = $state<string | null>(null);
	let showAllRecent = $state(false);
	const RECENT_SHOWN = 10;

	onMount(() => {
		const controller = new AbortController();
		fetch('/api/admin/client-stalls', { headers: { accept: 'application/json' }, signal: controller.signal })
			.then(async (res) => {
				if (!res.ok) throw new Error(String(res.status));
				report = (await res.json()) as ClientStallsReport;
			})
			.catch(() => {
				if (!controller.signal.aborted) loadError = 'Stuck pages are unavailable right now.';
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

	const KIND_LABEL = STALL_KIND_LABEL;
</script>

<CollapsibleCard id="metrics-stuck" title="Stuck pages">
	{#if loadError}<p class="error" role="alert">{loadError}</p>{/if}
	{#if !report}
		{#if !loadError}<p class="muted">Loading…</p>{/if}
	{:else}
		{@const r = report}
		<p class="note">
			Reported by the browser or installed app itself, so this covers what the server can’t see: a page that took more than
			{fmtMs(SLOW_NAV_MS)} to finish opening, one that never finished, and a page with no heartbeat for {fmtMs(FREEZE_MS)} or
			more while on screen. When the app had to be closed, the report arrives the next time it is opened. These are
			timings, not causes. Kept {r.retentionDays} days.
		</p>

		<h3>By page, last 7 days</h3>
		{#if r.routes.length === 0}
			<p class="muted">No stuck pages reported in the last 7 days.</p>
		{:else}
			<ul class="routes">
				{#each r.routes as row (row.route)}
					<li>
						<div class="rhead"><code>{row.route}</code><span>worst {fmtMs(row.worstWaitedMs)}</span></div>
						<p class="line">
							{n(row.total)} reported ·
							{(Object.keys(KIND_LABEL) as StallKind[])
								.filter((k) => row.byKind[k] > 0)
								.map((k) => `${KIND_LABEL[k].toLowerCase()} ${n(row.byKind[k])}`)
								.join(' · ')}
						</p>
					</li>
				{/each}
			</ul>
		{/if}

		<h3>Latest reports</h3>
		{#if r.recent.length === 0}
			<p class="muted">None reported yet.</p>
		{:else}
			<ul class="recent">
				{#each showAllRecent ? r.recent : r.recent.slice(0, RECENT_SHOWN) as q, i (`${q.occurredAt}-${i}`)}
					<li>
						<div class="rhead">
							<code>{q.toPath ?? q.toRoute ?? '(unknown page)'}</code><span class:bad={q.kind !== 'slow'}>{KIND_LABEL[q.kind]}</span>
						</div>
						<p class="line">{describe(q)}</p>
						{#if q.errors.length}
							<p class="line">Errors while it was loading: {q.errors.join(' · ')}</p>
						{/if}
						<p class="meta">
							{fmtWhen(q.occurredAt)} · {q.user} · {deviceLabel(q.device, q.standalone)}{q.online ? '' : ' · offline'}
							{#if q.fromRoute}· from <code>{q.fromRoute}</code>{/if} · deploy {shortVersion(q.version)}
						</p>
					</li>
				{/each}
			</ul>
			{#if r.recent.length > RECENT_SHOWN}
				<button type="button" class="more" aria-expanded={showAllRecent} onclick={() => (showAllRecent = !showAllRecent)}>
					{showAllRecent ? `Show the newest ${RECENT_SHOWN} only` : `Show all ${n(r.recent.length)}`}
				</button>
			{/if}
			{#if r.recent.length === 50}
				<p class="muted">Only the newest 50 are listed. The summary by page above covers the last 7 days.</p>
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
	code {
		overflow-wrap: anywhere;
		font-size: 0.9rem;
	}
	.meta code {
		font-size: 0.85rem;
	}
	.line {
		font-size: 0.88rem;
		margin: 4px 0 0;
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
