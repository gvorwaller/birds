<script lang="ts">
	/**
	 * Admin → Sources (td-eec7db Phase 1): external sightings sources. For each
	 * source: connector health, queueing a load for one region, the recent
	 * loads, and unmatched upstream taxa with a "Match species" override
	 * (td-b856c7: Norwegian names, a suggested species, and "Change a match"
	 * for a wrong automatic match). Every section folds (td-2219df).
	 * Server-rendered from the admin page load; every action re-checks admin.
	 */
	import { enhance } from '$app/forms';
	import type { ActionResult, SubmitFunction } from '@sveltejs/kit';
	import { onMount, tick } from 'svelte';
	import { jobsPoll } from '$lib/job-poll.svelte';
	import type { AdminSource, AdminLoad } from '$server/external-sources/admin';
	import AdminBadge from './AdminBadge.svelte';
	import { findTaxa } from '$lib/taxon-find';

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
	// Owner request (2026-10-23): the background docs, findable from where imports are run.
	const REPO_DOCS = 'https://github.com/gvorwaller/birds/blob/main/';
	const REFERENCE_DOCS = [
		{
			title: 'Sightings sources survey',
			about: 'Where local portals out-record eBird, country by country, and which could get a connector next.',
			path: 'docs/2026-10-22-bird-sightings-sources-survey.md'
		},
		{
			title: 'External sources plan',
			about: 'How it works now: the Norway connector, what is stored and where it shows, then the ingest contract and the history of the plan.',
			path: 'docs/2026-10-21-external-sources-plan-CC.md'
		}
	];
	const REASON: Record<string, string> = {
		no_match: 'no eBird species with this scientific name',
		ambiguous: 'more than one eBird species has this scientific name',
		override_code_missing: 'its override names a code no longer in the eBird taxonomy'
	};

	const METHOD: Record<string, string> = {
		scientific: 'matched by the same scientific name',
		subspecies: 'matched as the species eBird reports this subspecies as',
		override: 'your match'
	};
	// The "Find a taxon" box filters in the browser; without JavaScript the whole list shows.
	let mounted = $state(false);
	onMount(() => (mounted = true));
	let filter = $state<Record<string, string>>({});

	// td-2219df: a match re-derives every loaded region, which takes seconds on
	// prod, and the button used to show nothing meanwhile (the owner tapped it
	// six times). While one action runs its button says so and every button in
	// the panel waits; the result shows in the section it came from.
	let busy = $state<string | null>(null);
	let lastSection = $state<string | null>(null);
	// On 2026-10-29 the phone saved six times but never re-fetched the page
	// data (no request reached the server; not reproduced in the simulator).
	// If the data has not been replaced after a successful save, reload the tab.
	const REFRESH_WAIT_MS = 10_000;

	// What an enhanced form's after-submit callback receives (SvelteKit's type, unexported).
	type Settle = { result: ActionResult; update: () => Promise<void> };

	/**
	 * Wait for the page data after an action, at most REFRESH_WAIT_MS, then
	 * clear the busy state. Returns false when the tab is being reloaded
	 * instead: no refresh at all (page state unknown), or a successful action
	 * whose data was not replaced. Used by every Sources action, revoke too.
	 */
	async function settle(section: string, before: AdminSource[] | null, { result, update }: Settle): Promise<boolean> {
		const refreshed = await Promise.race([
			update().then(
				() => true,
				() => false
			),
			new Promise<boolean>((done) => setTimeout(() => done(false), REFRESH_WAIT_MS))
		]);
		busy = null;
		if (refreshed && !(result.type === 'success' && sources === before)) return true;
		// A full load of this tab at this source. When only the #fragment
		// differs, assigning the URL would just scroll, so reload instead.
		const url = new URL(`/admin?tab=sources#${section.split(':')[0]}`, location.href);
		if (url.pathname + url.search !== location.pathname + location.search) location.assign(url);
		else {
			history.replaceState(history.state, '', url);
			location.reload();
		}
		return false;
	}

	function act(key: string, section: string, after?: () => void): SubmitFunction {
		return () => {
			busy = key;
			lastSection = section;
			const before = sources;
			return async (done) => {
				const shown = await settle(section, before, done);
				after?.();
				if (shown) await reveal(section);
			};
		};
	}
	// A result is shown only once its action has finished, so an earlier
	// result is never shown beside a later, still-running action (CODEX1).
	const shows = (section: string) => busy === null && form?.kind === 'sources' && lastSection === section;

	/**
	 * Open the fold holding a result and bring it into the part of the screen
	 * the fixed top bar and bottom tab bar leave visible, only when it is not.
	 * Measured after layout settles: iOS Safari ignored an immediate scroll
	 * once the matched row had gone.
	 */
	async function reveal(section: string) {
		await tick();
		const el = document.getElementById(`msg-${section}`);
		const fold = el?.closest('details');
		if (fold) fold.open = true;
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				const r = el?.getBoundingClientRect();
				// A hidden bar (the tab bar on a wide screen) measures 0 high.
				const bar = (sel: string) => {
					const b = document.querySelector(sel)?.getBoundingClientRect();
					return b && b.height > 0 ? b : null;
				};
				const top = bar('nav.top-nav')?.bottom ?? 0;
				const bottom = bar('nav.bottom-nav')?.top ?? innerHeight;
				if (r && (r.top < top || r.bottom > bottom)) window.scrollTo({ top: scrollY + r.top - top - (bottom - top) / 3 });
			})
		);
	}

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
	let revoke = $state<{ id: number; label: string; source: string; sourceId: string } | null>(null);
	let dialog = $state<HTMLDialogElement | null>(null);
	let cancelButton = $state<HTMLButtonElement | null>(null);
	let heading = $state<HTMLHeadingElement | null>(null);
	// Not every engine restores focus when a dialog closes (WebKit doesn't),
	// so it is returned by hand: to the opener, or to the tab heading after a
	// revoke, when the opener has gone with the token.
	let opener: HTMLElement | null = null;
	let revoked = false;

	async function openRevoke(event: MouseEvent, target: { id: number; label: string; source: string; sourceId: string }) {
		opener = event.currentTarget as HTMLElement;
		revoked = false;
		revoke = target;
		await tick();
		dialog?.showModal();
		cancelButton?.focus();
	}
	function onDialogClose() {
		revoke = null;
		// After a revoke the page scrolls to its result instead (reveal).
		if (revoked || !opener?.isConnected) heading?.focus({ preventScroll: true });
		else opener.focus();
	}
</script>

{#snippet notice(section: string)}
	{#if shows(section)}
		<p id={`msg-${section}`} class={['msg', form?.ok ? 'notice' : 'error']} role={form?.ok ? 'status' : 'alert'}>{form?.message}</p>
	{/if}
{/snippet}
{#snippet working(key: string)}
	{#if busy === key}
		<p class="muted working" role="status">Working on it; this can take a few seconds.</p>
	{/if}
{/snippet}

<section class="card" aria-labelledby="sources-heading">
	<h2 id="sources-heading" tabindex="-1" bind:this={heading}>Sources</h2>
	<p class="muted">
		Sightings reports from outside eBird. Each source has its own connector program, which fetches the
		data and sends it here; nothing on this tab contacts the source directly. These are counts of
		reports, never eBird likelihoods.
	</p>
	<details class="sec">
		<summary><h3>Reference</h3></summary>
		<ul class="refs">
			{#each REFERENCE_DOCS as d (d.path)}
				<li>
					<a href={`${REPO_DOCS}${d.path}`} target="_blank" rel="noopener">{d.title} ↗</a>
					<span class="muted">{d.about}</span>
					<code>{d.path}</code>
				</li>
			{/each}
		</ul>
	</details>
	{#if busy === null && form?.kind === 'sources' && lastSection === null}
		<p class={form.ok ? 'notice' : 'error'} role={form.ok ? 'status' : 'alert'}>{form.message}</p>
	{/if}
</section>

{#if !sources}
	<p class="error" role="alert">Sources are unavailable right now.</p>
{:else if sources.length === 0}
	<p class="muted">No sources are registered.</p>
{:else}
	{#each sources as s (s.id)}
		{@const at = `source-${s.id}`}
		{@const active = s.connectors.filter((c) => !c.revokedAt)}
		{@const typed = (filter[s.id] ?? '').trim()}
		{@const found = findTaxa(s.matched, typed, (m) => [m.localName, m.canonicalName, m.comName, m.speciesCode])}
		<section class="card source" aria-labelledby={at}>
			<div class="head">
				<h3 id={at}>{s.name}</h3>
				<AdminBadge tone={s.active ? 'ok' : 'neutral'} label={s.active ? 'On' : 'Off'} />
			</div>
			<p class="muted">
				{s.publisher} · {s.license} · latest {s.windowMonths} complete months per load · observer names
				{s.storeObservers ? 'stored' : 'not stored'}
			</p>

			<details class="sec">
				<summary>
					<h4>Connector</h4>
					<span class="muted sum-note">
						{active.length === 0
							? 'no active token'
							: `last seen ${ago(active.map((c) => c.lastSeenAt).filter(Boolean).sort().at(-1) ?? null)}`}
					</span>
				</summary>
				{@render notice(`${at}:connector`)}
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
										disabled={busy !== null}
										onclick={(e) => openRevoke(e, { id: c.id, label: c.label, source: s.name, sourceId: s.id })}
									>
										Revoke token…
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</details>
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

			<details class="sec" open>
				<summary><h4>Load a region</h4></summary>
				{@render notice(`${at}:load`)}
				<form
					method="POST"
					action="?/queue_external_load"
					class="inline-form"
					use:enhance={act(`${at}:load`, `${at}:load`, () => jobsPoll.track(0))}
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
					<button type="submit" class="btn accent-solid" disabled={!s.active || busy !== null}>
						{busy === `${at}:load` ? 'Queueing…' : 'Queue load'}
					</button>
				</form>
				<p class="muted">
					The connector picks the load up within a minute. A load replaces that region's data only when it
					finishes completely; until then the previous data stays.
				</p>
			</details>

			<details class="sec" open>
				<summary><h4>Loads <span class="muted">(latest {s.loads.length})</span></h4></summary>
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
										)} recent reports{#if l.result.counts.observers}
											· {n(l.result.counts.observers)} observer rows{/if}
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
			</details>

			<details class="sec">
				<summary><h4>Unmatched taxa <span class="muted">({s.unmatched.length})</span></h4></summary>
				{@render notice(`${at}:unmatched`)}
				{#if s.unmatched.length === 0}
					<p class="muted">Every loaded taxon matched an eBird species.</p>
				{:else}
					<p class="muted">
						Their reports are left out of species counts until matched. Pick the eBird species once; the match
						is remembered for later loads and applied to the loaded data straight away.
					</p>
					<ul class="rows">
						{#each s.unmatched as u (u.upstreamTaxonId)}
							{@const sug = `${at}:sug:${u.upstreamTaxonId}`}
							{@const typed = `${at}:set:${u.upstreamTaxonId}`}
							<li>
								<div class="line">
									<strong>{#if u.localName}{`${u.localName} · `}{/if}<i>{u.canonicalName}</i></strong>
									<span class="muted">{n(u.reports)} reports · {u.regions.join(', ')}</span>
								</div>
								<p class="muted">Not matched: {REASON[u.reason] ?? u.reason}.</p>
								{#if u.suggestion}
									<form
										method="POST"
										action="?/set_taxon_override"
										use:enhance={act(sug, `${at}:unmatched`)}
										class="inline-form"
									>
										<input type="hidden" name="source_id" value={s.id} />
										<input type="hidden" name="upstream_taxon_id" value={u.upstreamTaxonId} />
										<input type="hidden" name="species" value={u.suggestion.code} />
										<span>Suggested: {u.suggestion.comName} <i class="muted">({u.suggestion.sciName})</i></span>
										<button type="submit" class="btn accent" disabled={busy !== null}>
											{busy === sug ? 'Matching…' : `Match to ${u.suggestion.comName}`}
										</button>
									</form>
									{@render working(sug)}
								{/if}
								<form
									method="POST"
									action="?/set_taxon_override"
									use:enhance={act(typed, `${at}:unmatched`)}
									class="inline-form"
								>
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
									<button type="submit" class="btn" disabled={busy !== null}>
										{busy === typed ? 'Matching…' : 'Match species'}
									</button>
								</form>
								{@render working(typed)}
							</li>
						{/each}
					</ul>
				{/if}
			</details>

			<details class="sec">
				<summary><h4>Saved matches <span class="muted">({s.overrides.length})</span></h4></summary>
				{@render notice(`${at}:saved`)}
				{#if s.overrides.length === 0}
					<p class="muted">None yet. A match you pick in Unmatched taxa or Change a match is listed here.</p>
				{:else}
					<ul class="rows">
						{#each s.overrides as o (o.upstreamTaxonId)}
							{@const rm = `${at}:rm:${o.upstreamTaxonId}`}
							<li>
								<div class="line">
									<span
										>{#if o.localName}{`${o.localName} · `}{/if}<i>{o.canonicalName}</i> → {o.comName ?? o.speciesCode} ({o.speciesCode})</span
									>
									<form method="POST" action="?/remove_taxon_override" use:enhance={act(rm, `${at}:saved`)}>
										<input type="hidden" name="source_id" value={s.id} />
										<input type="hidden" name="upstream_taxon_id" value={o.upstreamTaxonId} />
										<button type="submit" class="btn" disabled={busy !== null}>
											{busy === rm ? 'Removing…' : 'Remove match'}
										</button>
									</form>
								</div>
								{@render working(rm)}
							</li>
						{/each}
					</ul>
				{/if}
			</details>
			<details class="sec">
				<summary><h4>Change a match <span class="muted">({n(s.matched.length)} matched taxa)</span></h4></summary>
				{@render notice(`${at}:change`)}
				{#if s.matched.length === 0}
					<p class="muted">No loaded taxon is matched to an eBird species yet.</p>
				{:else}
					<p class="muted">
						Every loaded taxon that counts as an eBird species. Change one when the automatic match is wrong
						for the region: kråke (<i>Corvus corone</i>) is the Hooded Crow in Norway, not the Carrion Crow.
					</p>
					{#if mounted}
						<label class="field find">
							<span>Find a taxon</span>
							<input
								type="search"
								placeholder="Norwegian, scientific or eBird name"
								autocomplete="off"
								autocorrect="off"
								autocapitalize="off"
								spellcheck="false"
								value={filter[s.id] ?? ''}
								oninput={(e) => (filter[s.id] = e.currentTarget.value)}
							/>
						</label>
						{#if found.mode === 'close'}
							<p class="find-note" role="status">
								No taxon contains “{typed}”. Closest {found.shown.size === 1 ? 'match' : `${found.shown.size} matches`}:
							</p>
						{:else if found.mode === 'none'}
							<p class="find-note" role="status">No taxon matches “{typed}”. Try fewer letters.</p>
						{/if}
					{/if}
					<ul class="rows">
						{#each s.matched as m (m.upstreamTaxonId + '\u0000' + m.canonicalName)}
							{@const chg = `${at}:chg:${m.upstreamTaxonId}\u0000${m.canonicalName}`}
							<li
								hidden={!found.shown.has(m)}
							>
								<div class="line">
									<strong>{#if m.localName}{`${m.localName} · `}{/if}<i>{m.canonicalName}</i></strong>
									<span>→ {m.comName ?? m.speciesCode}</span>
								</div>
								<p class="muted">{n(m.reports)} reports · {METHOD[m.method] ?? m.method}</p>
								<details>
									<summary>Change</summary>
									<form
										method="POST"
										action="?/set_taxon_override"
										use:enhance={act(chg, `${at}:change`)}
										class="inline-form"
									>
										<input type="hidden" name="source_id" value={s.id} />
										<input type="hidden" name="upstream_taxon_id" value={m.upstreamTaxonId} />
										<label class="field grow">
											<span class="sr-only">eBird species for {m.localName ?? m.canonicalName}</span>
											<input
												type="text"
												name="species"
												placeholder="Exact eBird common name, scientific name, or code…"
												required
											/>
										</label>
										<button type="submit" class="btn" disabled={busy !== null}>
											{busy === chg ? 'Matching…' : 'Match species'}
										</button>
									</form>
									{@render working(chg)}
								</details>
							</li>
						{/each}
					</ul>
				{/if}
			</details>
			<details class="sec">
				<summary><h4>Re-match species</h4></summary>
				{@render notice(`${at}:rematch`)}
				<form
					method="POST"
					action="?/rematch_source"
					use:enhance={act(`${at}:rematch`, `${at}:rematch`)}
					class="inline-form"
				>
					<input type="hidden" name="source_id" value={s.id} />
					<button type="submit" class="btn" disabled={busy !== null}>
						{busy === `${at}:rematch` ? 'Re-matching…' : 'Re-match species'}
					</button>
					<span class="muted">Use after an eBird taxonomy update; no data is fetched again.</span>
				</form>
				{@render working(`${at}:rematch`)}
			</details>
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
						const section = `source-${revoke?.sourceId}:connector`;
						busy = section;
						lastSection = section;
						const before = sources;
						return async (done) => {
							const shown = await settle(section, before, done);
							revoked = true;
							dialog?.close();
							if (shown) await reveal(section);
						};
					}}
				>
					<input type="hidden" name="connector_id" value={revoke.id} />
					<button type="submit" class="btn danger-solid" disabled={busy !== null}>
						{busy !== null ? 'Revoking…' : 'Revoke token'}
					</button>
				</form>
			</div>
	{/if}
</dialog>

<style>
	/* td-2219df: each source its own card, as on the Tags tab, now that its sections fold. */
	.card {
		padding: 1rem;
		margin-block: 1rem;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.refs {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.refs li {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 4px 0 8px;
	}
	.refs a {
		align-self: flex-start;
		display: inline-flex;
		align-items: center;
		min-height: 48px;
		font-weight: 600;
	}
	.refs code {
		font-size: 0.85rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.source h3 {
		margin: 0;
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
	input[type='text'],
	input[type='search'] {
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
	.btn.accent {
		border-color: var(--accent);
		color: var(--accent);
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
	/* td-2219df: every section folds; the heading stays in the summary so it is still a heading. */
	details.sec {
		margin: 8px 0 0;
		border-top: 1px solid var(--border);
	}
	details.sec > summary {
		flex-wrap: wrap;
		gap: 4px 8px;
		padding: 4px 0;
	}
	details.sec > summary :is(h3, h4) {
		margin: 0;
		font-size: 1rem;
	}
	details.sec[open] {
		padding-bottom: 8px;
	}
	.sum-note {
		font-weight: 400;
	}
	.msg {
		margin: 8px 0 12px;
		font-weight: 600;
	}
	.find-note {
		margin: 8px 0 0;
		font-weight: 600;
	}
	.working {
		margin: 0 0 8px;
	}
	.field.find {
		margin: 12px 0 4px;
	}
	details summary {
		display: flex;
		align-items: center;
		min-height: 48px;
		cursor: pointer;
		font-weight: 600;
	}
	details summary::-webkit-details-marker {
		display: none;
	}
	details summary::before {
		content: '▸';
		margin-right: 8px;
	}
	details[open] > summary::before {
		content: '▾';
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
