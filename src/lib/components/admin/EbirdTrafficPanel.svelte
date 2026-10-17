<script lang="ts">
	/**
	 * Admin → Metrics, eBird traffic (td-009031): how many requests the app
	 * makes to eBird, to which endpoints, from where, and how many the saved
	 * copies (ebird_cache) answered instead. Read from the daily totals when the
	 * tab opens; Refresh reads them again. Never calls eBird.
	 */
	import { onMount } from 'svelte';
	import CollapsibleCard from '$components/CollapsibleCard.svelte';
	import AdminBadge from './AdminBadge.svelte';
	import type { TrafficReport } from '$server/ebird-traffic';

	let report = $state<TrafficReport | null>(null);
	let readAt = $state<string | null>(null);
	let loadError = $state<string | null>(null);
	let busy = $state(false);
	let controller: AbortController | null = null;

	async function load() {
		controller?.abort();
		const mine = new AbortController();
		controller = mine;
		busy = true;
		try {
			const res = await fetch('/api/admin/ebird-traffic', {
				headers: { accept: 'application/json' },
				signal: mine.signal
			});
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as TrafficReport;
			if (mine.signal.aborted) return;
			report = body;
			readAt = new Date().toISOString();
			loadError = null;
		} catch {
			if (mine.signal.aborted) return;
			loadError = report
				? 'Could not refresh. Showing the earlier reading.'
				: 'eBird traffic is unavailable right now.';
		} finally {
			if (controller === mine) {
				controller = null;
				busy = false;
			}
		}
	}

	onMount(() => {
		void load();
		return () => controller?.abort();
	});

	const n = (v: number) => v.toLocaleString();
	function fmtBytes(bytes: number): string {
		const mb = bytes / 1024 ** 2;
		if (mb >= 1024) return `${(mb / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
		if (mb >= 1) return `${mb.toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
		return `${Math.round(bytes / 1024).toLocaleString()} kB`;
	}
	function fmtMs(ms: number | null): string {
		if (ms == null) return '—';
		return ms < 1000 ? `${ms.toLocaleString()} ms` : `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
	}
	/** Share of requests the saved copies answered, of all asked for. */
	function cacheShare(network: number, hits: number): string {
		const total = network + hits;
		return total === 0 ? '—' : `${Math.round((hits / total) * 100)}%`;
	}
	const fmtDay = (day: string) =>
		new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

	// Daily trend: one bar per day, network requests only.
	const CHART_W = 600;
	const CHART_H = 80;
</script>

<CollapsibleCard id="metrics-ebird" title="eBird traffic">
	{#if loadError}<p class="error" role="alert">{loadError}</p>{/if}
	{#if !report}
		{#if !loadError}<p class="muted">Loading…</p>{/if}
	{:else}
		{@const r = report}
		{@const net7 = r.endpoints.reduce((s, e) => s + e.network7d, 0)}
		{@const net30 = r.endpoints.reduce((s, e) => s + e.network30d, 0)}
		{@const hits30 = r.endpoints.reduce((s, e) => s + e.cacheHits30d, 0)}
		{@const limited30 = r.endpoints.reduce((s, e) => s + e.rateLimited30d, 0)}
		{@const errors30 = r.endpoints.reduce((s, e) => s + e.errors30d, 0)}
		{@const most = Math.max(0, ...r.days.map((d) => d.network))}
		{@const peak = Math.max(1, most)}
		<div class="head">
			<p class="muted">
				{r.since ? `Counting since ${fmtDay(r.since)}.` : 'Nothing counted yet.'}
				Approximate: each app process saves its counts every minute, so a crash can lose the last minute.
			</p>
			<button type="button" class="refresh" onclick={load} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh eBird traffic'}</button>
		</div>
		{#if readAt}<p class="muted">Read at {new Date(readAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.</p>{/if}

		<dl>
			<div><dt>Requests to eBird, 7 days</dt><dd>{n(net7)}</dd></div>
			<div><dt>Requests to eBird, 30 days</dt><dd>{n(net30)}</dd></div>
			<div><dt>Answered from saved copies, 30 days</dt><dd>{n(hits30)} ({cacheShare(net30, hits30)})</dd></div>
			<div>
				<dt>Rate limited / failed, 30 days</dt>
				<dd>
					{n(limited30)} / {n(errors30)}
					{#if limited30 > 0}<AdminBadge tone="error" label="Rate limited" />{/if}
				</dd>
			</div>
		</dl>

		<h3>Requests per day, last 30 days</h3>
		<svg class="trend" viewBox="0 0 {CHART_W} {CHART_H}" preserveAspectRatio="none" role="img"
			aria-label={`Requests to eBird per day over the last 30 days: ${n(net30)} in all, most in one day ${n(most)}.`}>
			{#each r.days as d, i (d.day)}
				{@const w = CHART_W / r.days.length}
				{@const h = d.network === 0 ? 0 : Math.max(2, (d.network / peak) * (CHART_H - 4))}
				<rect x={i * w + 1} y={CHART_H - h} width={Math.max(1, w - 2)} height={h} rx="2">
					<title>{fmtDay(d.day)}: {n(d.network)} requests, {n(d.cacheHits)} from saved copies</title>
				</rect>
			{/each}
			<line class="base" x1="0" x2={CHART_W} y1={CHART_H - 0.5} y2={CHART_H - 0.5} />
		</svg>
		<p class="muted axis"><span>{r.days.length ? fmtDay(r.days[0].day) : ''}</span><span>most {n(most)} a day</span><span>Today</span></p>

		<h3>By endpoint, 30 days</h3>
		{#if r.endpoints.length === 0}
			<p class="muted">No eBird requests or saved-copy answers recorded yet.</p>
		{:else}
			<div class="table-scroll">
				<table>
					<thead>
						<tr>
							<th scope="col">Endpoint</th>
							<th scope="col">Requests 7 d</th>
							<th scope="col">Requests 30 d</th>
							<th scope="col">Saved copy</th>
							<th scope="col">Typical time</th>
							<th scope="col">Data</th>
							<th scope="col">Limited / failed</th>
						</tr>
					</thead>
					<tbody>
						{#each r.endpoints as e (e.endpoint)}
							<tr>
								<td>{e.label}</td>
								<td>{n(e.network7d)}</td>
								<td>{n(e.network30d)}</td>
								<td>{cacheShare(e.network30d, e.cacheHits30d)}</td>
								<td>{fmtMs(e.avgMs)}</td>
								<td>{fmtBytes(e.bytes30d)}</td>
								<td class:bad={e.rateLimited30d + e.errors30d > 0}>{n(e.rateLimited30d)} / {n(e.errors30d)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="muted">
				“Saved copy” is the share of asks the app answered from its own saved eBird data instead of a request.
				A stale saved copy shown after a failed request counts as a failure, not a saved-copy answer.
				Typical time is the average per request.
			</p>
		{/if}

		<h3>Who asked, 30 days</h3>
		{#if r.origins.length === 0}
			<p class="muted">No requests recorded yet.</p>
		{:else}
			<ul class="origins">
				{#each r.origins as o (o.origin)}
					<li><span>{o.label}</span><span>{n(o.network30d)} <span class="muted">({n(o.network7d)} in 7 d)</span></span></li>
				{/each}
			</ul>
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
	.muted {
		color: var(--muted);
		font-size: 0.85rem;
	}
	.error,
	.bad {
		color: var(--danger);
		font-weight: 600;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 12px;
	}
	.head p {
		flex: 1 1 240px;
	}
	.refresh {
		min-height: 48px;
		padding: 0 14px;
		background: var(--bg);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 8px;
		font: inherit;
		cursor: pointer;
	}
	dl {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 8px 16px;
		margin: 8px 0;
	}
	dl > div {
		min-width: 0;
	}
	dt {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
	}
	dd {
		margin: 0;
	}
	.trend {
		display: block;
		width: 100%;
		height: 80px;
	}
	.trend rect {
		fill: var(--accent);
	}
	.trend .base {
		stroke: var(--border);
		stroke-width: 1;
	}
	.axis {
		display: flex;
		justify-content: space-between;
		gap: 8px;
	}
	.table-scroll {
		overflow-x: auto;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		font-size: 0.9rem;
	}
	th,
	td {
		text-align: left;
		padding: 6px 8px;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}
	.origins {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.origins li {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
	}
	.origins li:last-child {
		border-bottom: none;
	}
</style>
