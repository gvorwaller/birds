<script lang="ts">
	/**
	 * Server health tab, system cards (td-a47c0d): worker, job queue, Postgres,
	 * big tables and loaded data. Fetched from /api/admin/system-health when the
	 * tab opens and every 30 s while it stays open and visible. Each card shows
	 * its own "unavailable" reason; one failed card never hides the others.
	 */
	import { onMount } from 'svelte';
	import CollapsibleCard from '$components/CollapsibleCard.svelte';
	import AdminBadge from './AdminBadge.svelte';
	import type { HealthCard, SystemHealth } from '$server/system-health';

	const REFRESH_MS = 30_000;
	const TABLES_SHOWN = 10;

	let health = $state<SystemHealth | null>(null);
	let loadError = $state<string | null>(null);
	let showAllTables = $state(false);

	onMount(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		let controller: AbortController | null = null;
		let lastLoadedAt = 0;

		async function load() {
			if (timer) clearTimeout(timer);
			timer = null;
			controller?.abort();
			const mine = new AbortController();
			controller = mine;
			try {
				const res = await fetch('/api/admin/system-health', {
					headers: { accept: 'application/json' },
					signal: mine.signal
				});
				if (!res.ok) throw new Error(String(res.status));
				const body = (await res.json()) as SystemHealth;
				if (mine.signal.aborted) return;
				health = body;
				loadError = null;
				lastLoadedAt = Date.now();
			} catch {
				if (mine.signal.aborted) return;
				loadError = health
					? `Could not refresh. Showing the reading from ${fmtTime(health.now)}.`
					: 'System cards are unavailable right now.';
			} finally {
				if (controller === mine) controller = null;
				if (!mine.signal.aborted && document.visibilityState === 'visible') {
					timer = setTimeout(load, REFRESH_MS);
				}
			}
		}

		// Paused while the browser tab is hidden; a stale reading refreshes as
		// soon as it is visible again.
		function onVisibility() {
			if (document.visibilityState !== 'visible') {
				if (timer) clearTimeout(timer);
				timer = null;
			} else if (!controller) {
				if (Date.now() - lastLoadedAt >= REFRESH_MS) void load();
				else timer ??= setTimeout(load, REFRESH_MS - (Date.now() - lastLoadedAt));
			}
		}

		void load();
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			document.removeEventListener('visibilitychange', onVisibility);
			if (timer) clearTimeout(timer);
			controller?.abort();
		};
	});

	const fmtTime = (iso: string) =>
		new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
	const fmtWhen = (iso: string) =>
		new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	const fmtDate = (iso: string) =>
		new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

	function fmtBytes(bytes: number): string {
		const gb = bytes / 1024 ** 3;
		if (gb >= 1) return `${gb.toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
		const mb = bytes / 1024 ** 2;
		if (mb >= 1) return `${Math.round(mb).toLocaleString()} MB`;
		return `${Math.max(0, Math.round(bytes / 1024)).toLocaleString()} kB`;
	}
	const fmtPct = (p: number | null) =>
		p == null ? 'No reads yet' : `${p.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;

	/** "4 min ago" / "in 2 h" relative to the reading's own clock. */
	function relative(iso: string | null, now: string): string {
		if (!iso) return 'never';
		const s = Math.round((Date.parse(iso) - Date.parse(now)) / 1000);
		const a = Math.abs(s);
		const span =
			a < 90 ? `${a} s` : a < 5400 ? `${Math.round(a / 60)} min` : a < 129600 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
		return s >= 0 ? `in ${span}` : `${span} ago`;
	}
	function fmtDuration(ms: number | null): string {
		if (ms == null) return '—';
		if (ms < 1000) return 'under 1 s';
		const s = Math.round(ms / 1000);
		if (s < 90) return `${s} s`;
		const m = Math.round(s / 60);
		return m < 90 ? `${m} min` : `${(m / 60).toLocaleString(undefined, { maximumFractionDigits: 1 })} h`;
	}

	const STATE_WORDS: Record<string, string> = {
		idle: 'Waiting for work',
		working: 'Working',
		paused: 'Paused',
		draining: 'Finishing before a restart'
	};

	const SETTING_NOTES: Record<string, string> = {
		shared_buffers: 'memory Postgres keeps for cached data',
		work_mem: 'memory each sort or hash step may use',
		effective_cache_size: 'how much file cache the planner assumes',
		max_parallel_workers_per_gather: 'helpers one query may use'
	};

	function unavailable<T>(c: HealthCard<T>): string | null {
		return c.ok ? null : c.reason;
	}
</script>

{#if loadError}
	<p class="error" role="alert">{loadError}</p>
{/if}
{#if !health}
	{#if !loadError}<p class="muted">Loading system cards…</p>{/if}
{:else}
	{@const h = health}
	<p class="muted">Read at {fmtTime(h.now)}. These cards refresh every 30 s while this tab is open.</p>

	<CollapsibleCard id="sys-worker" title="Worker">
		{#if !h.worker.ok}
			<p class="error">Unavailable: {unavailable(h.worker)}</p>
		{:else}
			{@const w = h.worker.data}
			<p>
				<AdminBadge
					tone={!w.alive ? 'error' : w.state === 'paused' || w.pauseRequested ? 'warn' : 'ok'}
					label={!w.alive
						? w.heartbeatAt ? 'Not responding' : 'Not started'
						: w.state === 'paused' ? 'Paused' : w.pauseRequested ? 'Pause requested' : 'Running'}
				/>
			</p>
			<dl>
				<div><dt>Last check-in</dt><dd>{w.heartbeatAt ? relative(w.heartbeatAt, h.now) : 'never'}</dd></div>
				<div><dt>{w.alive ? 'Doing' : 'Last reported'}</dt><dd>{(w.state && STATE_WORDS[w.state]) ?? w.state ?? '—'}{w.currentJobId != null ? ` (job ${w.currentJobId})` : ''}</dd></div>
				<div><dt>Started</dt><dd>{w.startedAt ? fmtWhen(w.startedAt) : '—'}</dd></div>
				<div><dt>Process</dt><dd>pid {w.pid ?? '—'} · version {w.version ?? '—'}</dd></div>
			</dl>
			<p class="muted"><a href="#health-heading">Worker memory chart</a> is further down this tab.</p>
		{/if}
	</CollapsibleCard>

	<CollapsibleCard id="sys-queue" title="Job queue">
		{#if !h.queue.ok}
			<p class="error">Unavailable: {unavailable(h.queue)}</p>
		{:else}
			{@const q = h.queue.data}
			{@const running = q.rows.reduce((n, r) => n + r.running, 0)}
			{@const waiting = q.rows.reduce((n, r) => n + r.pending, 0)}
			{@const failed24h = q.rows.reduce((n, r) => n + r.failed24h, 0)}
			<p>
				{running.toLocaleString()} running · {waiting.toLocaleString()} waiting ·
				<span class:bad={failed24h > 0}>{failed24h.toLocaleString()} failed in the last 24 h</span>
			</p>
			<p class="muted">
				Exact counts by job type. Finished jobs are kept {q.retentionDays} days, so “last success” looks back that far.
				Times are for successful runs in the last 7 days. A scheduled check parked until its next run is not counted as waiting; one that is due, overdue or retrying is.
			</p>
			{#if q.rows.length === 0}
				<p class="muted">No jobs in the last {q.retentionDays} days.</p>
			{:else}
				<ul class="queue">
					{#each q.rows as r (`${r.type}-${r.aiOnly}`)}
						<li>
							<div class="qhead">
								<strong>{r.name}</strong>
								{#if r.running > 0}<AdminBadge tone="ok" label={`${r.running} running`} />{/if}
								{#if r.pending > 0}<AdminBadge tone="neutral" label={`${r.pending} waiting`} />{/if}
								{#if r.failed24h > 0}<AdminBadge tone="error" label={`${r.failed24h} failed today`} />{/if}
							</div>
							<p class="qline">
								{#if r.recurring}
									Next run: {r.nextRunAt ? relative(r.nextRunAt, h.now) : r.pending > 0 ? 'due now' : 'not scheduled'} ·
								{/if}
								Last success: {relative(r.lastSucceededAt, h.now)} ·
								7 days: {r.succeeded7d.toLocaleString()} ok, {r.failed7d.toLocaleString()} failed{r.cancelled7d > 0 ? `, ${r.cancelled7d.toLocaleString()} cancelled` : ''}{r.cancelledUndated > 0 ? ` · ${r.cancelledUndated.toLocaleString()} older cancelled with no date` : ''}
								{#if r.medianMs != null}· typical {fmtDuration(r.medianMs)}, longest {fmtDuration(r.worstMs)}{/if}
							</p>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</CollapsibleCard>

	<CollapsibleCard id="sys-postgres" title="Database">
		{#if h.disk.ok}
			{@const d = h.disk.data}
			{@const freePct = d.totalBytes > 0 ? (d.freeBytes / d.totalBytes) * 100 : 0}
			<p>
				Disk: {fmtBytes(d.freeBytes)} free of {fmtBytes(d.totalBytes)}
				{#if freePct < 15}<AdminBadge tone="error" label="Low space" />{/if}
			</p>
			<p class="muted">The server's one disk, shared with the three other apps on it. The database lives here.</p>
		{:else}
			<p class="error">Disk space unavailable: {unavailable(h.disk)}</p>
		{/if}
		{#if !h.postgres.ok}
			<p class="error">Database details unavailable: {unavailable(h.postgres)}</p>
		{:else}
			{@const p = h.postgres.data}
			<dl>
				<div><dt>Database size</dt><dd>{fmtBytes(p.databaseBytes)}</dd></div>
				<div><dt>Table reads from memory</dt><dd>{fmtPct(p.heapHitPct)}</dd></div>
				<div><dt>Index reads from memory</dt><dd>{fmtPct(p.indexHitPct)}</dd></div>
			</dl>
			<p class="muted">
				Read percentages are totals {p.statsResetAt ? `since statistics were reset ${fmtDate(p.statsResetAt)}` : 'since statistics began (never reset)'}.
				A read that misses Postgres's memory may still come from the server's file cache rather than the disk.
			</p>
			<h3>Settings</h3>
			<dl>
				{#each p.settings as s (s.name)}
					<div><dt>{s.name}</dt><dd>{s.value} <span class="muted">· {SETTING_NOTES[s.name] ?? ''}</span></dd></div>
				{/each}
			</dl>
		{/if}
	</CollapsibleCard>

	<CollapsibleCard id="sys-backup" title="Backup">
		{#if !h.backup.ok}
			<p class="error">Unavailable: {unavailable(h.backup)}</p>
		{:else}
			{@const b = h.backup.data}
			{#if b.at}
				<p>
					<AdminBadge tone={b.stale ? 'error' : 'ok'} label={b.stale ? `Stale: over ${b.staleAfterHours} h old` : 'Current'} />
				</p>
				<p>Last backup {fmtWhen(b.at)} ({relative(b.at, h.now)}){b.bytes != null ? ` · ${fmtBytes(b.bytes)} file` : ''}</p>
			{:else}
				<p><AdminBadge tone="error" label="None recorded" /></p>
				<p>No backup has been recorded here yet.</p>
			{/if}
			<p class="muted">
				The nightly backup runs on your Mac and copies the database from the server. It records each
				successful copy here; a backup older than {b.staleAfterHours} hours is flagged as stale.
			</p>
		{/if}
	</CollapsibleCard>

	<CollapsibleCard id="sys-tables" title="Biggest tables" initiallyOpen={false}>
		{#if !h.tables.ok}
			<p class="error">Unavailable: {unavailable(h.tables)}</p>
		{:else}
			{@const t = h.tables.data}
			{@const shown = showAllTables ? t : t.slice(0, TABLES_SHOWN)}
			<p class="muted">Rows are Postgres's own estimate. Memory reads are totals since statistics began, as above.</p>
			<div class="table-scroll">
				<table class="tables">
					<thead>
						<tr><th scope="col">Table</th><th scope="col">Rows (est.)</th><th scope="col">Data</th><th scope="col">Indexes</th><th scope="col">From memory</th></tr>
					</thead>
					<tbody>
						{#each shown as row (row.name)}
							<tr>
								<td>{row.name}</td>
								<td>{row.rowsEstimate == null ? 'Not counted yet' : row.rowsEstimate.toLocaleString()}</td>
								<td>{fmtBytes(row.tableBytes)}</td>
								<td>{fmtBytes(row.indexBytes)}</td>
								<td>{fmtPct(row.heapHitPct)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if t.length > TABLES_SHOWN}
				<button type="button" class="more" aria-expanded={showAllTables} onclick={() => (showAllTables = !showAllTables)}>
					{showAllTables ? `Show the ${TABLES_SHOWN} biggest only` : `Show all ${t.length.toLocaleString()} tables`}
				</button>
			{/if}
		{/if}
	</CollapsibleCard>

	<CollapsibleCard id="sys-coverage" title="Loaded data">
		{#if !h.coverage.ok}
			<p class="error">Unavailable: {unavailable(h.coverage)}</p>
		{:else}
			{@const c = h.coverage.data}
			{@const e = c.enrichment}
			<dl>
				<div><dt>Countries</dt><dd>{c.countries.toLocaleString()}</dd></div>
				<div><dt>States and provinces</dt><dd>{c.states.toLocaleString()}</dd></div>
				<div><dt>Counties</dt><dd>{c.counties.toLocaleString()}</dd></div>
				<div><dt>Hotspots</dt><dd>{c.hotspots.toLocaleString()}</dd></div>
				<div><dt>Species recorded at loaded places</dt><dd>{c.species.toLocaleString()}</dd></div>
			</dl>
			<p class="muted">Places with bar-chart data loaded, as listed on <a href="/forecast/data">Hotspots &amp; data</a>.</p>
			<h3>Species information</h3>
			<p class="muted">{e.eligible.toLocaleString()} species are in scope: seen, photographed, or present at a loaded place. “Done” includes species with nothing to find.</p>
			<dl>
				<div><dt>Wikipedia</dt><dd>{e.wikiComplete.toLocaleString()} done · {e.wikiAttempted.toLocaleString()} tried</dd></div>
				<div><dt>Look-alikes (iNaturalist)</dt><dd>{e.inatComplete.toLocaleString()} done · {e.inatAttempted.toLocaleString()} tried</dd></div>
				<div><dt>AI notes</dt><dd>{e.aiComplete.toLocaleString()} done · {e.aiAttempted.toLocaleString()} tried</dd></div>
				<div><dt>Photos and sounds</dt><dd>{e.mediaComplete.toLocaleString()} done · {e.mediaAttempted.toLocaleString()} tried</dd></div>
			</dl>
		{/if}
	</CollapsibleCard>
{/if}

<style>
	p {
		margin: 6px 0;
	}
	h3 {
		font-size: 0.95rem;
		margin: 14px 0 6px;
	}
	.muted {
		color: var(--muted);
		font-size: 0.85rem;
	}
	.error {
		color: var(--danger);
		font-weight: 600;
	}
	.bad {
		color: var(--danger);
		font-weight: 600;
	}
	a {
		color: var(--accent);
	}
	dl {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 8px 16px;
		margin: 8px 0;
	}
	/* Grid items default to min-width: auto, so one long setting name such as
	   max_parallel_workers_per_gather would widen the whole page. */
	dl > div {
		min-width: 0;
	}
	dt {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.queue {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.queue li {
		padding: 10px 0;
		border-bottom: 1px solid var(--border);
	}
	.queue li:last-child {
		border-bottom: none;
	}
	.qhead {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 8px;
	}
	.qline {
		font-size: 0.88rem;
		margin: 4px 0 0;
	}
	.table-scroll {
		overflow-x: auto;
	}
	.tables {
		border-collapse: collapse;
		width: 100%;
		font-size: 0.9rem;
	}
	.tables th,
	.tables td {
		text-align: left;
		padding: 6px 8px;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
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
