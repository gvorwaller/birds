<script lang="ts">
	/**
	 * Admin → Taxonomy (td-6093ae): the yearly eBird taxonomy refresh. One
	 * button backs up, syncs and compares (a background run, shown step by
	 * step); a second reloads the stored frequency locations the changes
	 * affect. Server-rendered from the admin page load; every action
	 * re-checks admin. While work is under way the card polls
	 * /api/admin/taxonomy and reloads its data when it ends.
	 */
	import { applyAction, enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import type { ActionResult, SubmitFunction } from '@sveltejs/kit';
	import { onDestroy, onMount, tick } from 'svelte';
	import { jobsPoll } from '$lib/job-poll.svelte';
	import AdminBadge from './AdminBadge.svelte';
	import type {
		ChangeKind,
		LocationState,
		RefreshProgress,
		RefreshReason,
		RunStage,
		TaxonomyPanelData
	} from '$server/taxonomy-refresh';

	type TaxonomyForm =
		| { kind: 'taxonomy'; ok: boolean; message: string; section: string; runId: number | null }
		| null
		| undefined;
	let { data, form }: { data: TaxonomyPanelData | null; form: TaxonomyForm } = $props();

	const STEPS: { stage: RunStage; label: string }[] = [
		{ stage: 'backed_up', label: "Back up today's taxonomy" },
		{ stage: 'applied', label: "Fetch and apply eBird's taxonomy" },
		{ stage: 'after_backed_up', label: 'Back up the new taxonomy' },
		{ stage: 'compared', label: 'Compare them and list the locations to reload' },
		{ stage: 'done', label: 'Finish: photo matches, families and tags' }
	];
	const ORDER: RunStage[] = ['started', 'backed_up', 'applied', 'after_backed_up', 'compared', 'done'];
	const KIND_LABEL: Record<ChangeKind, string> = {
		removed: 'Removed (split, lumped or retired)',
		added: 'Added',
		category: 'Changed category (for example no longer a species)',
		scientific: 'Scientific name changed',
		common: 'Common name changed',
		report_as: 'Now reported as a different species',
		other: 'Other details (order, family, banding codes)'
	};
	const KIND_SHORT: Record<ChangeKind, string> = {
		removed: 'removed',
		added: 'added',
		category: 'category',
		scientific: 'scientific name',
		common: 'common name',
		report_as: 'reported as',
		other: 'other details'
	};
	// One location, many locations: [singular, plural].
	const REASON_LABEL: Record<RefreshReason, [string, string]> = {
		changed_species: ['holds a changed species', 'hold a changed species'],
		now_matches: ['has stored names that now match a species', 'have stored names that now match a species'],
		loaded_since_sync: [
			"was loaded since the last sync, so it may have used eBird's new names before this app had them",
			"were loaded since the last sync, so they may have used eBird's new names before this app had them"
		],
		carried_over: [
			'was carried over from an earlier run that did not finish',
			'were carried over from an earlier run that did not finish'
		]
	};
	const REASON_ORDER: RefreshReason[] = ['changed_species', 'now_matches', 'loaded_since_sync', 'carried_over'];
	const KIND_ORDER: ChangeKind[] = ['removed', 'added', 'category', 'scientific', 'common', 'report_as', 'other'];
	const STATE_LABEL: Record<LocationState, string> = {
		reloaded: 'reloaded',
		queued: 'queued',
		failed: 'failed',
		unfinished: 'unfinished',
		not_queued: 'not queued yet',
		removed: 'no longer stored'
	};
	const n = (v: number) => v.toLocaleString('en-US');
	const day = (iso: string | null) =>
		iso ? new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : 'never';
	const when = (iso: string) =>
		new Date(iso).toLocaleString('en-US', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

	// ── busy state and results (the Sources card's pattern) ──────────────
	let busy = $state<string | null>(null);
	let lastSection = $state<string | null>(null);
	const REFRESH_WAIT_MS = 10_000;
	type Settle = { result: ActionResult; update: () => Promise<void> };

	async function settle(section: string, before: TaxonomyPanelData | null, { result, update }: Settle): Promise<boolean> {
		const refreshed = await Promise.race([
			update().then(
				() => true,
				() => false
			),
			new Promise<boolean>((done) => setTimeout(() => done(false), REFRESH_WAIT_MS))
		]);
		busy = null;
		if (refreshed && !(result.type === 'success' && data === before)) return true;
		const url = new URL(`/admin?tab=taxonomy#${section}`, location.href);
		if (url.pathname + url.search !== location.pathname + location.search) location.assign(url);
		else {
			history.replaceState(history.state, '', url);
			location.reload();
		}
		return false;
	}
	function act(key: string, section: string): SubmitFunction {
		return () => {
			busy = key;
			lastSection = section;
			const before = data;
			return async (done) => {
				const runId = done.result.type === 'success' ? (done.result.data as { runId?: number | null } | undefined)?.runId : null;
				// A run started or resumed while an older run is on show: show that run.
				if (key === 'sync' && runId && run?.id !== runId) {
					busy = null;
					await goto(`/admin?tab=taxonomy&run=${runId}`, { invalidateAll: true, noScroll: true, keepFocus: true });
					await applyAction(done.result);
					jobsPoll.track(0);
					await reveal(section);
					return;
				}
				const shown = await settle(section, before, done);
				jobsPoll.track(0);
				if (shown) await reveal(section);
			};
		};
	}
	// Without JavaScript the result arrives with the page: the server names its section.
	const shows = (section: string) =>
		busy === null && form?.kind === 'taxonomy' && (lastSection ?? form.section) === section;
	// Native form posts keep this tab (and the run on show) when the page comes back.
	const selected = $derived(page.url.searchParams.get('run'));
	const actionUrl = (name: string, runId: number | null = null) =>
		`?/${name}&tab=taxonomy${runId ? `&run=${runId}` : ''}`;
	async function reveal(section: string) {
		await tick();
		document.getElementById(`msg-${section}`)?.scrollIntoView({ block: 'nearest' });
	}

	// ── live progress while a run or its reloads are under way ──────────
	type Live = {
		stage: RunStage;
		failed_stage: string | null;
		error: string | null;
		jobActive: boolean;
		progress: RefreshProgress;
	};
	let live = $state<Live | null>(null);
	const run = $derived(data?.run ?? null);
	const stage = $derived(live?.stage ?? run?.stage ?? 'started');
	const failedStage = $derived(live ? live.failed_stage : (run?.failed_stage ?? null));
	const runError = $derived(live ? live.error : (run?.error ?? null));
	const jobActive = $derived(live?.jobActive ?? run?.jobActive ?? false);
	const progress = $derived(live?.progress ?? run?.progress ?? null);
	// Not finished: still to compare, or compared with its finishing still to do.
	const open = $derived(run !== null && stage !== 'done');
	// Polled while this run's job runs (finishing included) or reloads are queued.
	const working = $derived(run !== null && (jobActive || (progress?.counts.queued ?? 0) > 0));
	const POLL_MS = 5_000;
	let timer: ReturnType<typeof setInterval> | null = null;

	async function poll() {
		if (!run || document.hidden) return;
		try {
			const res = await fetch(`/api/admin/taxonomy?run=${run.id}`, { cache: 'no-store' });
			if (!res.ok) return;
			const next = (await res.json()) as Live;
			// A finished step, the job ending, or the last batch ending brings new rows: reload them.
			const ended =
				next.stage !== stage ||
				(jobActive && !next.jobActive) ||
				((progress?.counts.queued ?? 0) > 0 && next.progress.counts.queued === 0);
			live = next;
			if (ended) {
				await invalidateAll();
				live = null;
			}
		} catch {
			/* offline for a moment: the next tick tries again */
		}
	}
	$effect(() => {
		if (working && !timer) timer = setInterval(poll, POLL_MS);
		if (!working && timer) {
			clearInterval(timer);
			timer = null;
		}
	});
	let mounted = $state(false);
	onMount(() => (mounted = true));
	onDestroy(() => timer && clearInterval(timer));

	function stepState(step: RunStage): { tone: 'ok' | 'warn' | 'error' | 'neutral'; label: string } {
		if (ORDER.indexOf(stage) >= ORDER.indexOf(step)) return { tone: 'ok', label: 'Done' };
		if (failedStage === step) return { tone: 'error', label: 'Failed' };
		if (jobActive && ORDER.indexOf(step) === ORDER.indexOf(stage) + 1) return { tone: 'neutral', label: 'Working' };
		return { tone: 'neutral', label: 'Waiting' };
	}
	const updateAvailable = $derived(
		!!data?.latest && (data.current.version === null || data.latest !== data.current.version)
	);
	// Stored as JSON, whose key order is not ours: always this order.
	const changeCounts = $derived(
		run?.counts
			? KIND_ORDER.map((k) => [k, run.counts!.changes[k] ?? 0] as [ChangeKind, number]).filter(([, v]) => v > 0)
			: []
	);
	const reasonCounts = $derived(
		run?.counts
			? REASON_ORDER.map((r) => [r, run.counts!.reasons[r] ?? 0] as [RefreshReason, number]).filter(([, v]) => v > 0)
			: []
	);
	const STATE_ORDER: LocationState[] = ['reloaded', 'queued', 'failed', 'unfinished', 'not_queued', 'removed'];
	const left = $derived(progress ? progress.counts.failed + progress.counts.unfinished : 0);
</script>

{#snippet notice(section: string)}
	{#if shows(section)}
		<p id={`msg-${section}`} class={['msg', form?.ok ? 'notice' : 'error']} role={form?.ok ? 'status' : 'alert'}>{form?.message}</p>
	{/if}
{/snippet}

<section class="card" aria-labelledby="taxonomy-heading">
	<h2 id="taxonomy-heading">Taxonomy refresh</h2>
	<p class="muted">
		eBird updates its taxonomy once a year, usually in October or November: species are split, lumped,
		renamed or added. This app keeps its own copy, so it follows only when you refresh it here.
	</p>
	<details class="sec" open={!run}>
		<summary><h3>What to do when eBird updates</h3></summary>
		<ol class="steps">
			<li>
				Wait until eBird says its update is complete, then press <strong>Back up, sync and compare</strong>.
				Straight away the app's species list, names, tags and photo matches switch to the new taxonomy. A
				species eBird removed stops appearing in forecasts until its locations are reloaded (step 3).
			</li>
			<li>Read the list of changes below.</li>
			<li>
				Press <strong>Refresh affected locations</strong>. Each listed location's frequencies are reloaded
				from eBird, one request each, using your eBird account login (saved in Settings), so forecasts
				show the new species.
			</li>
			<li>
				Ask every user to sync their life list (Settings → Life list), so their lifers move to the new
				species.
			</li>
		</ol>
	</details>
</section>

{#if !data}
	<p class="error" role="alert">The taxonomy refresh is unavailable right now.</p>
{:else}
	<section class="card" aria-labelledby="tax-status" id="tax-sync">
		<h3 id="tax-status">Status</h3>
		<p>
			Our taxonomy: {n(data.current.taxa)} taxa, synced {day(data.current.syncedAt)}, eBird version
			{data.current.version ?? 'not recorded'}.
		</p>
		<p class="line">
			eBird's latest version: {data.latest ?? 'unknown'}
			{#if updateAvailable}<AdminBadge tone="warn" label="Update available" />{/if}
		</p>
		{#if data.current.version === null}
			<p class="muted">This app records the eBird version from its first refresh on.</p>
		{/if}
		{@render notice('tax-sync')}
		{#if busy === 'sync'}<p class="muted" role="status">Working on it; this can take a few seconds.</p>{/if}
		<form method="POST" action={actionUrl('taxonomy_sync')} use:enhance={act('sync', 'tax-sync')}>
			<button type="submit" class="btn accent-solid" disabled={busy !== null || !data.canSync || jobActive}>
				{busy === 'sync' ? 'Queueing…' : jobActive ? 'Running…' : open ? 'Try again' : 'Back up, sync and compare'}
			</button>
		</form>
		{#if open && !jobActive}
			<p class="muted">The latest run has not finished. Try again continues it from the step it reached.</p>
		{/if}
		{#if !data.canSync}
			<p class="muted">Save your eBird API key in Settings first: the sync uses it.</p>
		{/if}
	</section>

	{#if run}
		<section class="card" aria-labelledby="tax-run">
			<div class="head">
				<h3 id="tax-run">Run of {when(run.created_at)}</h3>
				{#if run.superseded_by}<AdminBadge tone="neutral" label="Carried over to a newer run" />{/if}
			</div>
			<p class="muted">
				Started by {run.actor_label ?? 'a former user'}{run.target_version ? ` · eBird version ${run.target_version}` : ''}.
			</p>
			<ol class="stages" aria-live="polite">
				{#each STEPS as s (s.stage)}
					{@const st = stepState(s.stage)}
					<li><AdminBadge tone={st.tone} label={st.label} /> {s.label}</li>
				{/each}
			</ol>
			{#if failedStage && runError}
				<p class="error" role="alert">
					Stopped: {runError}
					{#if !jobActive}Press <strong>Try again</strong> to continue from this step.{/if}
				</p>
			{/if}

			{#if run.counts}
				<details class="sec" open>
					<summary>
						<h4>Changes</h4>
						<span class="muted sum-note">{n(run.changes.length)} taxa changed</span>
					</summary>
					{#if changeCounts.length === 0}
						<p class="muted">Nothing changed: this taxonomy is the same as the one before.</p>
					{:else}
						<ul class="counts">
							{#each changeCounts as [kind, count] (kind)}
								<li>{KIND_LABEL[kind]}: {n(count)}</li>
							{/each}
						</ul>
						<details class="sec">
							<summary><h5>Every changed taxon ({n(run.changes.length)})</h5></summary>
							<ul class="rows">
								{#each run.changes as c (c.taxon_code)}
									<li>
										<div class="line">
											<strong>{c.new_com_name ?? c.old_com_name}</strong>
											<code>{c.taxon_code}</code>
											{#each c.kinds as k (k)}<AdminBadge tone={c.affects ? 'warn' : 'neutral'} label={KIND_SHORT[k]} />{/each}
										</div>
										{#if c.old_com_name && c.new_com_name && c.old_com_name !== c.new_com_name}
											<p class="muted">Was {c.old_com_name}</p>
										{/if}
										{#if c.old_sci_name && c.new_sci_name && c.old_sci_name !== c.new_sci_name}
											<p class="muted"><i>{c.old_sci_name}</i> → <i>{c.new_sci_name}</i></p>
										{/if}
										{#if c.old_category !== c.new_category && c.old_category && c.new_category}
											<p class="muted">Category {c.old_category} → {c.new_category}</p>
										{/if}
										{#if c.old_report_as !== c.new_report_as}
											<p class="muted">Reported as {c.old_report_as ?? 'itself'} → {c.new_report_as ?? 'itself'}</p>
										{/if}
										{#if c.locations > 0}
											<p class="muted">Held by {n(c.locations)} stored {c.locations === 1 ? 'location' : 'locations'}</p>
										{/if}
									</li>
								{/each}
							</ul>
						</details>
					{/if}
				</details>

				<details class="sec" open id="tax-refresh">
					<summary>
						<h4>Locations to reload</h4>
						<span class="muted sum-note">{n(run.counts.locations.total)}</span>
					</summary>
					{#if run.counts.locations.total === 0}
						<p class="muted">No stored location needs a reload.</p>
					{:else}
						<p>
							{n(run.counts.locations.total)} stored {run.counts.locations.total === 1 ? 'location' : 'locations'}
							({n(run.counts.locations.regions)} {run.counts.locations.regions === 1 ? 'region' : 'regions'},
							{n(run.counts.locations.hotspots)} {run.counts.locations.hotspots === 1 ? 'hotspot' : 'hotspots'}). A
							location can have more than one reason:
						</p>
						<ul class="counts">
							{#each reasonCounts as [reason, count] (reason)}
								<li>{n(count)} {REASON_LABEL[reason][count === 1 ? 0 : 1]}</li>
							{/each}
						</ul>
						<p class="muted">
							Reloading takes about one eBird request per location, plus sign-ins and any retries. It runs
							in the background in batches of 200, one request at a time.
						</p>
						{#if progress}
							<p aria-live="polite">
								{#each STATE_ORDER.map((st) => [st, progress.counts[st]] as [LocationState, number]).filter(([, v]) => v > 0) as [state, count], i (state)}
									{i > 0 ? ' · ' : ''}{n(count)} {STATE_LABEL[state]}
								{/each}
							</p>
						{/if}
						{@render notice('tax-refresh')}
						{#if busy === 'refresh' || busy === 'retry'}
							<p class="muted" role="status">Working on it; this can take a few seconds.</p>
						{/if}
						{#if run.superseded_by}
							<p class="muted">
								A newer run carried these locations over. <a href={`/admin?tab=taxonomy&run=${run.superseded_by}`}>Open that run</a>.
							</p>
						{:else}
							{#if progress && progress.counts.not_queued > 0}
								<form method="POST" action={actionUrl('taxonomy_refresh', selected ? run.id : null)} use:enhance={act('refresh', 'tax-refresh')}>
									<input type="hidden" name="run_id" value={run.id} />
									<button type="submit" class="btn accent-solid" disabled={busy !== null || !data.canRefresh}>
										{busy === 'refresh' ? 'Queueing…' : `Refresh affected locations (${n(progress.counts.not_queued)})`}
									</button>
								</form>
							{/if}
							{#if left > 0}
								<form method="POST" action={actionUrl('taxonomy_retry', selected ? run.id : null)} use:enhance={act('retry', 'tax-refresh')}>
									<input type="hidden" name="run_id" value={run.id} />
									<button type="submit" class="btn accent" disabled={busy !== null || !data.canRefresh}>
										{busy === 'retry' ? 'Queueing…' : `Retry unfinished (${n(left)})`}
									</button>
								</form>
							{/if}
							{#if !data.canRefresh}
								<p class="muted">Save your eBird account login in Settings first: the reloads sign in to eBird with it.</p>
							{/if}
						{/if}
						{#if progress?.batchError}
							<p class="error" role="alert">
								A batch stopped: {progress.batchError}. Fix the cause (for example the eBird login in Settings),
								then press <strong>Retry unfinished</strong>.
							</p>
						{/if}
						{#if progress && progress.problems.length > 0}
							<details class="sec">
								<summary>
									<h5>Failed or unfinished ({n(left)}{left > progress.problems.length ? `, first ${progress.problems.length} shown` : ''})</h5>
								</summary>
								<ul class="rows">
									{#each progress.problems as p (p.loc_code)}
										<li>
											<strong>{p.loc_name}</strong> <code>{p.loc_code}</code>
											<AdminBadge tone={p.state === 'failed' ? 'error' : 'warn'} label={STATE_LABEL[p.state]} />
											{#if p.error}<p class="muted">{p.error}</p>{/if}
										</li>
									{/each}
								</ul>
							</details>
						{/if}
					{/if}
				</details>
			{/if}
		</section>
	{/if}

	<section class="card" aria-labelledby="tax-life">
		<h3 id="tax-life">Life lists</h3>
		<p>
			{#if data.orphans === null}
				<span class="error">The count is unavailable right now.</span>
			{:else if data.orphans.rows > 0}
				{n(data.orphans.rows)} {data.orphans.rows === 1 ? 'lifer' : 'lifers'} across {n(data.orphans.users)}
				{data.orphans.users === 1 ? 'user' : 'users'}
				{data.orphans.rows === 1 ? 'uses a species code' : 'use species codes'} eBird removed.
			{:else}
				No lifer uses a species code eBird removed.
			{/if}
		</p>
		<p class="muted">
			This counts removed codes only: a split that keeps the old code is not counted. After a refresh, every
			user should sync their life list (Settings → Life list), so eBird's conversions reach this app.
		</p>
	</section>

	<section class="card" aria-labelledby="tax-history">
		<details class="sec">
			<summary>
				<h3 id="tax-history">
					History ({n(data.history.length)} {data.history.length === 1 ? 'run' : 'runs'}, {n(data.backups.length)}
					{data.backups.length === 1 ? 'backup' : 'backups'})
				</h3>
			</summary>
			{#if data.history.length === 0}
				<p class="muted">No refresh has run yet.</p>
			{:else}
				<ul class="rows">
					{#each data.history as h (h.id)}
						<li>
							<div class="line">
								<a href={`/admin?tab=taxonomy&run=${h.id}`} aria-current={run?.id === h.id ? 'true' : undefined}>Run of {when(h.created_at)}</a>
								<AdminBadge
									tone={h.failed_stage ? 'error' : h.stage === 'done' ? 'ok' : 'neutral'}
									label={h.failed_stage ? 'Stopped' : h.stage === 'done' ? 'Finished' : 'In progress'}
								/>
								{#if h.superseded_by}<AdminBadge tone="neutral" label="Carried over" />{/if}
							</div>
							<p class="muted">
								{h.target_version ? `eBird ${h.target_version} · ` : ''}{h.counts
									? `${n(h.counts.taxaAfter)} taxa · ${n(h.counts.locations.total)} locations to reload · ${n(h.outstanding)} not reloaded yet`
									: 'not compared yet'}
							</p>
						</li>
					{/each}
				</ul>
			{/if}
			<h4>Backups</h4>
			{#if data.backups.length === 0}
				<p class="muted">No backup yet. Each refresh keeps one from before and one from after its sync.</p>
			{:else}
				<ul class="rows">
					{#each data.backups as b (b.id)}
						<li>
							{when(b.taken_at)} · {b.kind === 'before_sync' ? 'before the sync' : 'after the sync'} ·
							{n(b.taxa)} taxa{b.ebird_version ? ` · eBird ${b.ebird_version}` : ''}
						</li>
					{/each}
				</ul>
			{/if}
		</details>
	</section>
{/if}
{#if mounted && working}<span class="sr-only" role="status">Updating every few seconds.</span>{/if}

<style>
	.card {
		padding: 1rem;
		margin-block: 1rem;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	h3,
	h4,
	h5 {
		margin: 0;
	}
	.card > h3 {
		margin-bottom: 8px;
	}
	.head,
	.line {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}
	.steps,
	.stages {
		margin: 8px 0;
		padding-left: 1.4rem;
	}
	.steps li,
	.stages li {
		margin: 6px 0;
	}
	.stages {
		list-style: none;
		padding-left: 0;
	}
	.counts {
		margin: 4px 0 8px;
		padding-left: 1.2rem;
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
	.rows a {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
		font-weight: 600;
	}
	code {
		font-size: 0.85rem;
		color: var(--muted);
		overflow-wrap: anywhere;
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
	.msg {
		margin: 8px 0 12px;
		font-weight: 600;
	}
	form {
		margin: 8px 0;
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
		max-width: 100%;
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
	.btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	details.sec {
		margin: 8px 0 0;
		border-top: 1px solid var(--border);
	}
	details.sec > summary {
		flex-wrap: wrap;
		gap: 4px 8px;
		padding: 4px 0;
	}
	details.sec > summary :is(h3, h4, h5) {
		font-size: 1rem;
	}
	details.sec[open] {
		padding-bottom: 8px;
	}
	.sum-note {
		font-weight: 400;
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
</style>
