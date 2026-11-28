<script lang="ts">
	/**
	 * Server health's "Sightings connectors" card body (td-afba28, plan
	 * docs/2026-11-27-connector-health-plan-CC.md §6): one row per source. Times
	 * are measured against the reading's own clock (`now`).
	 */
	import AdminBadge from './AdminBadge.svelte';
	import type { HealthCard } from '$server/system-health';
	import type { ConnectorHealth, ConnectorsCard } from '$server/external-sources/connector-health';
	import { CONNECTOR_STATE_LABEL, CONNECTOR_STATE_TONE, spanWords, versionDiffers } from '$lib/connector-health-policy';
	import { refreshLabel } from '$lib/external-refresh-policy';

	let { card, now, appVersion }: { card: HealthCard<ConnectorsCard>; now: string; appVersion: string } = $props();

	const fmtWhen = (iso: string) =>
		new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

	/** "4 min ago", relative to the reading's clock. */
	function relative(iso: string, now: string): string {
		return `${spanWords(Date.parse(now) - Date.parse(iso))} ago`;
	}

	function connectorBadge(c: ConnectorHealth): { tone: 'ok' | 'warn' | 'error' | 'neutral'; label: string } {
		if (c.state === 'off') return { tone: 'neutral', label: 'Source off' };
		if (c.state === 'no_token') return { tone: 'neutral', label: 'No token' };
		return { tone: CONNECTOR_STATE_TONE[c.state], label: CONNECTOR_STATE_LABEL[c.state] };
	}

	function connectorDoing(c: ConnectorHealth, now: string): string {
		const loads = (n: number) => `${n} ${n === 1 ? 'load' : 'loads'}`;
		const parts = c.loading.map((l) => {
			if (l.expired) return `${l.regionName}: lease expired, awaiting the next check`;
			const p = l.progress;
			const step = p ? `: ${p.phase} ${p.done.toLocaleString()}/${p.total.toLocaleString()}` : '';
			const started = l.startedAt ? `, started ${relative(l.startedAt, now)}` : '';
			return `Loading ${l.regionName}${step}${started}`;
		});
		if (parts.length === 0) parts.push(c.state === 'online' || c.state === 'quiet' ? 'Waiting for work' : 'Not checking in');
		if (c.queued > 0) parts.push(c.loading.length > 0 ? `${c.queued} more queued` : `${loads(c.queued)} queued`);
		return parts.join(' · ');
	}

	function connectorLastLoad(c: ConnectorHealth, now: string): string {
		const l = c.lastLoad;
		if (!l) return 'None yet';
		const how = l.status === 'done' ? 'done' : 'failed';
		return `${l.regionName}, ${how} ${relative(l.finishedAt, now)}${l.origin === 'auto' ? ' (automatic)' : ''}${l.status === 'failed' && l.error ? `: ${l.error}` : ''}`;
	}

	function connectorRefresh(c: ConnectorHealth, now: string): string {
		if (c.refreshDays == null) return 'Off';
		const how = refreshLabel(c.refreshDays);
		return c.oldestLoaded
			? `${how} · oldest ${c.oldestLoaded.regionName} (loaded ${relative(c.oldestLoaded.retrievedAt, now)})`
			: `${how} · no loaded region open for refresh`;
	}

	function outageNotice(n: NonNullable<ConnectorHealth['outage']>['notice'], cc: ConnectorsCard): string {
		switch (n) {
			case 'sent':
				return 'notification accepted by the push service for at least one admin device';
			case 'gave_up':
				return 'the notification could not be delivered';
			case 'dropped':
				return 'no notification was sent';
			default:
				return cc.adminHasDevice ? 'notification pending' : 'no device to notify';
		}
	}
</script>

{#if !card.ok}
	<p class="error">Unavailable: {card.reason}</p>
{:else}
	{@const cc = card.data}
	<p class="muted">
		Each outside source (Norway, Sweden) has its own connector program on the server, which fetches its reports and
		checks in here every 10 s while it waits for work. When one has been silent for 15 minutes you get a notification,
		and another when it is back.
	</p>
	{#if cc.rows.length === 0}
		<p class="muted">No sources are registered.</p>
	{:else}
		<ul class="rows">
			{#each cc.rows as c (c.sourceId)}
				{@const b = connectorBadge(c)}
				<li>
					<div class="qhead">
						<strong>{c.name}</strong>
						<AdminBadge tone={b.tone} label={b.label} />
						{#if c.state !== 'off' && versionDiffers(c.version, appVersion)}
							<AdminBadge tone="warn" label={`Last reported version differs from the app's (${appVersion})`} />
						{/if}
					</div>
					{#if c.state !== 'off'}
						<dl>
							<div><dt>Last check-in</dt><dd>{c.lastSeenAt ? relative(c.lastSeenAt, now) : 'never'}</dd></div>
							<div><dt>Doing</dt><dd>{connectorDoing(c, now)}</dd></div>
							<div><dt>Last load</dt><dd>{connectorLastLoad(c, now)}</dd></div>
							<div><dt>Refresh</dt><dd>{connectorRefresh(c, now)}</dd></div>
							<div>
								<dt>Process</dt>
								<dd>version {c.version ?? 'unknown'} · up since {c.startedAt ? fmtWhen(c.startedAt) : 'unknown'}</dd>
							</div>
						</dl>
						{#if c.outage}
							<p class="bad">Offline since {fmtWhen(c.outage.since)}; {outageNotice(c.outage.notice, cc)}.</p>
						{/if}
					{/if}
					<p class="muted">
						<a href={`/admin?tab=sources#source-${c.sourceId}`} data-sveltekit-reload>Tokens and loads</a>
					</p>
				</li>
			{/each}
		</ul>
	{/if}
{/if}

<style>
	p {
		margin: 6px 0;
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
	a {
		color: var(--accent);
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
		overflow-wrap: anywhere;
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rows li {
		padding: 10px 0;
		border-bottom: 1px solid var(--border);
	}
	.rows li:last-child {
		border-bottom: none;
	}
	.qhead {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 8px;
	}
</style>
