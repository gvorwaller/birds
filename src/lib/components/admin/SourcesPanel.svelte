<script lang="ts">
	/**
	 * Admin → Sources (td-eec7db Phase 1): external sightings sources. For each
	 * source: connector health, queueing a load for one region, the recent
	 * loads, and unmatched upstream taxa with a "Match species" override.
	 * Server-rendered from the admin page load; every action re-checks admin.
	 */
	import { enhance } from '$app/forms';
	import { tick } from 'svelte';
	import { jobsPoll } from '$lib/job-poll.svelte';
	import type { AdminSource, AdminLoad } from '$server/external-sources/admin';
	import AdminBadge from './AdminBadge.svelte';

	type SourcesForm = { kind: 'sources'; ok: boolean; message: string } | null | undefined;
	let { sources, form }: { sources: AdminSource[] | null; form: SourcesForm } = $props();

	const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'error' | 'neutral' }> = {
		queued: { label: 'Queued', tone: 'neutral' },
		leased: { label: 'Claimed', tone: 'neutral' },
		staging: { label: 'Receiving', tone: 'neutral' },
		done: { label: 'Published', tone: 'ok' },
		superseded: { label: 'Replaced', tone: 'neutral' },
		failed: { label: 'Failed', tone: 'error' }
	};
	const REASON: Record<string, string> = {
		no_match: 'no eBird species with this scientific name',
		ambiguous: 'more than one eBird species has this scientific name',
		override_code_missing: 'its override names a code no longer in the eBird taxonomy'
	};

	function ago(iso: string | null): string {
		if (!iso) return 'never';
		const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
		if (s < 60) return 'just now';
		if (s < 3600) return `${Math.round(s / 60)} min ago`;
		if (s < 86400) return `${Math.round(s / 3600)} h ago`;
		return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}
	function when(iso: string): string {
		return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	}
	function monthYear(day: string): string {
		return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
	}
	function loadStatus(l: AdminLoad): { label: string; tone: 'ok' | 'warn' | 'error' | 'neutral' } {
		if (l.overdue) return { label: 'Connector silent', tone: 'warn' };
		return STATUS[l.status] ?? { label: l.status, tone: 'neutral' };
	}
	const n = (v: number) => v.toLocaleString('en-US');

	// Native modal dialog (as on /viewed): the browser keeps focus inside it,
	// makes the page behind inert, closes on Escape and restores focus.
	let revoke = $state<{ id: number; label: string; source: string } | null>(null);
	let revokeBusy = $state(false);
	let dialog = $state<HTMLDialogElement | null>(null);
	let cancelButton = $state<HTMLButtonElement | null>(null);
	let heading = $state<HTMLHeadingElement | null>(null);
	// Not every engine restores focus when a dialog closes (WebKit doesn't),
	// so it is returned by hand: to the opener, or to the tab heading after a
	// revoke, when the opener has gone with the token.
	let opener: HTMLElement | null = null;
	let revoked = false;

	async function openRevoke(event: MouseEvent, target: { id: number; label: string; source: string }) {
		opener = event.currentTarget as HTMLElement;
		revoked = false;
		revoke = target;
		await tick();
		dialog?.showModal();
		cancelButton?.focus();
	}
	function onDialogClose() {
		revoke = null;
		const target = revoked || !opener?.isConnected ? heading : opener;
		target?.focus();
	}
</script>

<section class="card" aria-labelledby="sources-heading">
	<h2 id="sources-heading" tabindex="-1" bind:this={heading}>Sources</h2>
	<p class="muted">
		Sightings reports from outside eBird. Each source has its own connector program, which fetches the
		data and sends it here; nothing on this tab contacts the source directly. These are counts of
		reports, never eBird likelihoods.
	</p>
	{#if form?.kind === 'sources'}
		<p class={form.ok ? 'notice' : 'error'} role={form.ok ? 'status' : 'alert'}>{form.message}</p>
	{/if}
</section>

{#if !sources}
	<p class="error" role="alert">Sources are unavailable right now.</p>
{:else if sources.length === 0}
	<p class="muted">No sources are registered.</p>
{:else}
	{#each sources as s (s.id)}
		<section class="card source" aria-labelledby={`source-${s.id}`}>
			<div class="head">
				<h3 id={`source-${s.id}`}>{s.name}</h3>
				<AdminBadge tone={s.active ? 'ok' : 'neutral'} label={s.active ? 'On' : 'Off'} />
			</div>
			<p class="muted">
				{s.publisher} · {s.license} · latest {s.windowMonths} complete months per load · observer names
				{s.storeObservers ? 'stored' : 'not stored'}
			</p>

			<h4>Connector</h4>
			{#if s.connectors.length === 0}
				<p class="muted">No connector token yet. One is created on the server with scripts/connector-token.mjs.</p>
			{:else}
				<ul class="rows">
					{#each s.connectors as c (c.id)}
						<li>
							<div class="line">
								<strong>{c.label}</strong>
								{#if c.revokedAt}
									<AdminBadge tone="neutral" label="Revoked" />
								{:else}
									<AdminBadge tone={c.lastSeenAt ? 'ok' : 'warn'} label={c.lastSeenAt ? 'Active' : 'Never seen'} />
								{/if}
							</div>
							<p class="muted">
								{[`Created ${ago(c.createdAt)}`, `last seen ${ago(c.lastSeenAt)}`, c.revokedAt ? `revoked ${ago(c.revokedAt)}` : null]
									.filter(Boolean)
									.join(' · ')}
							</p>
							{#if !c.revokedAt}
								<button
									type="button"
									class="btn danger"
									onclick={(e) => openRevoke(e, { id: c.id, label: c.label, source: s.name })}
								>
									Revoke token…
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
			{#if s.overdueLeases > 0}
				<p class="warn-line">
					<AdminBadge tone="warn" label="Attention" />
					{s.overdueLeases}
					{s.overdueLeases === 1 ? 'load has' : 'loads have'} a connector that stopped reporting; it goes back
					to the queue automatically.
				</p>
			{/if}
			{#if s.oldestQueuedAt}
				<p class="muted">Oldest queued load waiting since {when(s.oldestQueuedAt)}.</p>
			{/if}

			<h4>Load a region</h4>
			<form
				method="POST"
				action="?/queue_external_load"
				class="inline-form"
				use:enhance={() =>
					async ({ update }) => {
						await update();
						jobsPoll.track(0);
					}}
			>
				<input type="hidden" name="source_id" value={s.id} />
				<label class="field">
					<span>Region</span>
					<select name="region_code" required>
						{#each s.regions as r (r.code)}
							<option value={r.code}>
								{r.name} ({r.code}){r.loadedAt ? ` — loaded ${ago(r.loadedAt)}` : ' — not loaded'}
							</option>
						{/each}
					</select>
				</label>
				<button type="submit" class="btn accent-solid" disabled={!s.active}>Queue load</button>
			</form>
			<p class="muted">
				The connector picks the load up within a minute. A load replaces that region's data only when it
				finishes completely; until then the previous data stays.
			</p>

			<h4>Loads <span class="muted">(latest {s.loads.length})</span></h4>
			{#if s.loads.length === 0}
				<p class="muted">No loads yet.</p>
			{:else}
				<ul class="rows" id={`source-${s.id}-loads`}>
					{#each s.loads as l (l.id)}
						{@const st = loadStatus(l)}
						<li>
							<div class="line">
								<strong>{l.regionName}</strong>
								<AdminBadge tone={st.tone} label={st.label} />
								<span class="muted">attempt {l.attempt} of {l.maxAttempts}</span>
							</div>
							<p class="muted">
								{[
									`Queued ${when(l.createdAt)}${l.requestedByName ? ` by ${l.requestedByName}` : ''}`,
									l.finishedAt ? `finished ${when(l.finishedAt)}` : null,
									l.heartbeatAt && !l.finishedAt ? `last heartbeat ${ago(l.heartbeatAt)}` : null
								]
									.filter(Boolean)
									.join(' · ')}
							</p>
							{#if l.progress && !l.finishedAt}
								<p>{l.progress.phase}: {n(l.progress.done)} of {n(l.progress.total)}</p>
							{/if}
							{#if l.error}
								<p class="error">{l.error}</p>
							{/if}
							{#if l.result}
								<p>
									{monthYear(l.result.window.start)} – {monthYear(l.result.window.end)} · {n(l.result.places)} places
									· {n(l.result.species)} species · {n(l.result.counts.taxon_month ?? 0)} taxon rows · {n(
										l.result.counts.recent ?? 0
									)} recent reports
								</p>
								{#if l.result.unmatched_taxa > 0}
									<p class="muted">
										When loaded, {n(l.result.unmatched_taxa)} upstream {l.result.unmatched_taxa === 1 ? 'taxon' : 'taxa'}
										({n(l.result.unmatched_reports)} reports) matched no species.
									</p>
								{/if}
								{#if l.result.gaps.place_months > 0}
									<p class="muted">
										{n(l.result.gaps.place_months)} place-months have {n(l.result.gaps.reports)} reports not
										accounted for by species or unidentified records.
									</p>
								{/if}
								{#if l.notes.length > 0}
									<details>
										<summary>
											Connector notes: {l.result.diagnostics.map((d) => `${d.code} ${n(d.count)}`).join(' · ')}
										</summary>
										<ul>
											{#each l.notes as d (d.code + '\u0000' + d.detail)}
												<li>{d.code}{d.detail ? ` — ${d.detail}` : ''}: {n(d.count)}</li>
											{/each}
										</ul>
									</details>
								{/if}
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			<h4>Unmatched taxa <span class="muted">({s.unmatched.length})</span></h4>
			{#if s.unmatched.length === 0}
				<p class="muted">Every loaded taxon matched an eBird species.</p>
			{:else}
				<p class="muted">
					Their reports are left out of species counts until matched. Pick the eBird species once; the match
					is remembered for later loads and applied to the loaded data straight away.
				</p>
				<ul class="rows">
					{#each s.unmatched as u (u.upstreamTaxonId)}
						<li>
							<div class="line">
								<strong><i>{u.canonicalName}</i></strong>
								<span class="muted">{n(u.reports)} reports · {u.regions.join(', ')}</span>
							</div>
							<p class="muted">Not matched: {REASON[u.reason] ?? u.reason}.</p>
							<form method="POST" action="?/set_taxon_override" use:enhance class="inline-form">
								<input type="hidden" name="source_id" value={s.id} />
								<input type="hidden" name="upstream_taxon_id" value={u.upstreamTaxonId} />
								<label class="field grow">
									<span class="sr-only">eBird species for {u.canonicalName}</span>
									<input
										type="text"
										name="species"
										placeholder="Exact eBird common name, scientific name, or code…"
										required
									/>
								</label>
								<button type="submit" class="btn">Match species</button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}

			{#if s.overrides.length > 0}
				<details>
					<summary>Saved matches ({s.overrides.length})</summary>
					<ul class="rows">
						{#each s.overrides as o (o.upstreamTaxonId)}
							<li class="line">
								<span><i>{o.canonicalName}</i> → {o.comName ?? o.speciesCode} ({o.speciesCode})</span>
								<form method="POST" action="?/remove_taxon_override" use:enhance>
									<input type="hidden" name="source_id" value={s.id} />
									<input type="hidden" name="upstream_taxon_id" value={o.upstreamTaxonId} />
									<button type="submit" class="btn">Remove match</button>
								</form>
							</li>
						{/each}
					</ul>
				</details>
			{/if}
			<form method="POST" action="?/rematch_source" use:enhance class="inline-form">
				<input type="hidden" name="source_id" value={s.id} />
				<button type="submit" class="btn">Re-match species</button>
				<span class="muted">Use after an eBird taxonomy update; no data is fetched again.</span>
			</form>
		</section>
	{/each}
{/if}

<dialog bind:this={dialog} aria-labelledby="revoke-title" onclose={onDialogClose}>
	{#if revoke}
			<h3 id="revoke-title">Revoke the {revoke.label} token?</h3>
			<p>
				The {revoke.source} connector using this token is refused from its next call, and a load it is in
				the middle of can never be published. This can't be undone; a new token has to be created on the
				server.
			</p>
			<div class="actions">
				<button type="button" class="btn" bind:this={cancelButton} onclick={() => dialog?.close()}>Cancel</button>
				<form
					method="POST"
					action="?/revoke_connector"
					use:enhance={() => {
						revokeBusy = true;
						return async ({ update }) => {
							await update();
							revokeBusy = false;
							revoked = true;
							dialog?.close();
						};
					}}
				>
					<input type="hidden" name="connector_id" value={revoke.id} />
					<button type="submit" class="btn danger-solid" disabled={revokeBusy}>
						{revokeBusy ? 'Revoking…' : 'Revoke token'}
					</button>
				</form>
			</div>
	{/if}
</dialog>

<style>
	.source h3 {
		margin: 0;
	}
	.source h4 {
		margin: 18px 0 6px;
	}
	.head,
	.line {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rows > li {
		padding: 10px 0;
		border-bottom: 1px solid var(--border);
	}
	.rows > li:last-child {
		border-bottom: none;
	}
	.rows p {
		margin: 4px 0;
	}
	.muted {
		color: var(--muted);
	}
	.error {
		color: var(--danger);
	}
	.notice {
		color: var(--accent);
	}
	.warn-line {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}
	.inline-form {
		display: flex;
		align-items: flex-end;
		flex-wrap: wrap;
		gap: 8px;
		margin: 8px 0;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-width: 100%;
	}
	.field.grow {
		flex: 1;
		min-width: min(240px, 100%);
	}
	select,
	input[type='text'] {
		min-height: 48px;
		font-size: 16px;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
		color: var(--text);
		max-width: 100%;
	}
	.btn {
		min-height: 48px;
		padding: 10px 16px;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--card);
		color: var(--text);
		font-weight: 600;
		cursor: pointer;
	}
	.btn.accent-solid {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--on-accent);
	}
	.btn.danger {
		border-color: var(--danger);
		color: var(--danger);
	}
	.btn.danger-solid {
		border-color: var(--danger);
		background: var(--danger);
		color: var(--on-danger);
	}
	.btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	dialog {
		background: var(--card);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 12px;
		width: min(480px, calc(100% - 32px));
		padding: 24px;
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 65%);
	}
	dialog .actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
		flex-wrap: wrap;
	}
</style>
