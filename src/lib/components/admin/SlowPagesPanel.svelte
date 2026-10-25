<script lang="ts">
	/**
	 * Admin → Metrics, Slow pages (td-67b481): requests slower than the perf-log
	 * threshold, kept 30 days. A 7-day rollup per page with the 7 days before
	 * it beside it, so a page that got slower after a deploy stands out; a deploy
	 * picker narrows everything to one version. Read when the tab opens.
	 */
	import { onMount } from 'svelte';
	import CollapsibleCard from '$components/CollapsibleCard.svelte';
	import type { PageTimingReport } from '$server/page-timing';

	let report = $state<PageTimingReport | null>(null);
	let loadError = $state<string | null>(null);
	let version = $state('');
	let busy = $state(false);
	let showAllRecent = $state(false);
	const RECENT_SHOWN = 10;
	let controller: AbortController | null = null;

	async function load() {
		controller?.abort();
		const mine = new AbortController();
		controller = mine;
		busy = true;
		try {
			const q = version ? `?version=${encodeURIComponent(version)}` : '';
			const res = await fetch(`/api/admin/page-timing${q}`, {
				headers: { accept: 'application/json' },
				signal: mine.signal
			});
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as PageTimingReport;
			if (mine.signal.aborted) return;
			report = body;
			loadError = null;
		} catch {
			if (mine.signal.aborted) return;
			if (report) {
				// Put the picker back on what is actually shown, and say which that is.
				version = report.version ?? '';
				loadError = `Could not load that deploy. Still showing ${report.version ? `deploy ${shortVersion(report.version)}` : 'all deploys'}.`;
			} else {
				loadError = 'Slow pages are unavailable right now.';
			}
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
	function fmtMs(ms: number | null): string {
		if (ms == null) return '—';
		return ms < 1000 ? `${ms.toLocaleString()} ms` : `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
	}
	function fmtBytes(b: number): string {
		const kb = b / 1024;
		return kb >= 1024 ? `${(kb / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB` : `${Math.round(kb).toLocaleString()} kB`;
	}
	const fmtWhen = (iso: string) =>
		new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	const shortVersion = (v: string) => (v.length > 7 ? v.slice(0, 7) : v);
	/** "slower" when the typical time grew by a quarter or more. */
	function trend(r: PageTimingReport['routes'][number]): string {
		if (r.previousMedianTotalMs == null) return 'new this week';
		const ratio = r.medianTotalMs / r.previousMedianTotalMs;
		if (ratio >= 1.25) return `slower (was ${fmtMs(r.previousMedianTotalMs)})`;
		if (ratio <= 0.8) return `faster (was ${fmtMs(r.previousMedianTotalMs)})`;
		return `about the same (was ${fmtMs(r.previousMedianTotalMs)})`;
	}
	/** The buckets a slow request spent its time in, biggest first. */
	function where(r: PageTimingReport['recent'][number]): string {
		const parts = (
			[
				['database', r.db],
				['eBird', r.ebird],
				['Google', r.google],
				['AI', r.ai]
			] as const
		)
			.filter(([, b]) => b.n > 0)
			.sort((a, b) => b[1].ms - a[1].ms)
			.map(([name, b]) => `${name} ${fmtMs(b.ms)} (${n(b.n)})`);
		return parts.length ? parts.join(' · ') : 'no outside calls';
	}
</script>

<CollapsibleCard id="metrics-slow" title="Slow pages">
	{#if loadError}<p class="error" role="alert">{loadError}</p>{/if}
	{#if !report}
		{#if !loadError}<p class="muted">Loading…</p>{/if}
	{:else}
		{@const r = report}
		<p class="note">
			Only requests slower than {fmtMs(r.thresholdMs)} are recorded. This shows what is slow and whether it is
			getting worse, not how fast the site usually is. Kept {r.retentionDays} days.
		</p>
		<div class="controls">
			<label for="slow-version">Deploy</label>
			<select id="slow-version" bind:value={version} onchange={load} disabled={busy}>
				<option value="">All deploys</option>
				{#each r.versions as v (v.version)}
					<option value={v.version}>{shortVersion(v.version)} · from {fmtWhen(v.firstSeen)} · {n(v.count)} slow</option>
				{/each}
			</select>
		</div>

		<h3>By page, last 7 days</h3>
		{#if r.routes.length === 0}
			<p class="muted">No slow requests in the last 7 days{r.version ? ' for this deploy' : ''}.</p>
		{:else}
			<ul class="routes">
				{#each r.routes as row (row.route)}
					<li>
						<div class="rhead"><code>{row.route}</code><span class:bad={row.previousMedianTotalMs != null && row.medianTotalMs / row.previousMedianTotalMs >= 1.25}>{trend(row)}</span></div>
						<p class="line">
							{n(row.count)} slow ({n(row.previousCount)} the week before) · typical {fmtMs(row.medianTotalMs)} · worst {fmtMs(row.worstTotalMs)}
							· first part ready in {fmtMs(row.medianShellMs)} · largest {fmtBytes(row.worstBytes)}
						</p>
						{#if row.frozenCount > 0}
							<p class="line frozen">
								{n(row.frozenCount)} of them overlapped a server freeze: their time includes it, whether they caused it or waited on it.
							</p>
						{/if}
					</li>
				{/each}
			</ul>
			<p class="muted">
				“First part ready” is when the server sent the start of the page; the rest can stream in after it.
				The week before always covers every deploy.
			</p>
		{/if}

		<h3>Latest slow requests</h3>
		{#if r.recent.length === 0}
			<p class="muted">None recorded{r.version ? ' for this deploy' : ''}.</p>
		{:else}
			<ul class="recent">
				{#each showAllRecent ? r.recent : r.recent.slice(0, RECENT_SHOWN) as q, i (`${q.at}-${i}`)}
					<li>
						<div class="rhead"><code>{q.method === 'GET' ? '' : `${q.method} `}{q.route}</code><span>{fmtMs(q.totalMs)}</span></div>
						<p class="line">
							{fmtWhen(q.at)} · status {q.status} · {fmtBytes(q.bytes)} · {where(q)} · deploy {shortVersion(q.version)}
						</p>
						{#if q.freezeMs != null}
							<p class="line frozen">
								Overlapped a {fmtMs(q.freezeMs)} server freeze: its time includes it, whether it caused it or waited on it.
							</p>
						{/if}
					</li>
				{/each}
			</ul>
			{#if r.recent.length > RECENT_SHOWN}
				<button type="button" class="more" aria-expanded={showAllRecent} onclick={() => (showAllRecent = !showAllRecent)}>
					{showAllRecent ? `Show the newest ${RECENT_SHOWN} only` : `Show all ${n(r.recent.length)}`}
				</button>
			{/if}
			<p class="muted">
				{r.recent.length === 50
					? 'Only the newest 50 are listed. The summary by page above covers the last 7 days.'
					: `All ${n(r.recent.length)} kept${r.version ? ' for this deploy' : ''} are listed.`}
			</p>
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
	.note {
		color: var(--muted);
		font-size: 0.85rem;
	}
	.error,
	.bad {
		color: var(--danger);
		font-weight: 600;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		margin: 8px 0;
	}
	.controls label {
		font-weight: 600;
	}
	select {
		min-height: 48px;
		max-width: 100%;
		font-size: 16px;
		padding: 0 10px;
		background: var(--card);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 8px;
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
	.line {
		font-size: 0.88rem;
		margin: 4px 0 0;
	}
	.frozen {
		color: var(--text);
		font-weight: 600;
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
