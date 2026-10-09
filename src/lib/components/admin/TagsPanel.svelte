<script lang="ts">
	/**
	 * Admin → Tags tab (td-894144 Release B3; plan "Admin Tags tab" §1, §7).
	 * Overview of every vocabulary tag, the nightly consistency history, and
	 * the taxonomy-change repair status. Per-tag work lives on
	 * /admin/tags/[tag]. Everything here is server-rendered from the page
	 * load; refresh the page for current numbers.
	 */
	import { enhance } from '$app/forms';
	import { dimensionLabel } from '$lib/species-tags';
	import type { TagsHealth, TagsOverview } from '$server/tag-admin';
	import AdminBadge from './AdminBadge.svelte';

	let {
		overview,
		health,
		message = null
	}: {
		overview: TagsOverview;
		health: TagsHealth;
		message?: { ok: boolean; text: string } | null;
	} = $props();

	let busy = $state<string | null>(null);

	const fmtWhen = (iso: string) =>
		new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	const nf = (n: number) => n.toLocaleString();

	const REASON_LABEL: Record<string, string> = {
		lexicon_drift: 'taxonomy names changed',
		repair_target_stale: 'stale repair target',
		input_missing: 'missing tag input',
		pointer_non_member: 'input for a species that no longer qualifies',
		input_text: 'article changed',
		input_order: 'order changed',
		input_family: 'family changed',
		input_focal: 'species names changed',
		input_lexicon: 'other-species names changed',
		input_scanner: 'engine version changed',
		state_missing: 'missing rule result',
		effective_drift: 'displayed tags differed'
	};

	function runTone(r: TagsHealth['runs'][number]): 'ok' | 'warn' | 'error' | 'neutral' {
		if (r.status === 'failed') return 'error';
		if (r.status === 'fixed') return r.bootstrap ? 'ok' : 'warn';
		if (r.status === 'deferred') return 'neutral';
		return 'ok';
	}
	function runLabel(r: TagsHealth['runs'][number]): string {
		if (r.status === 'failed') return 'Failed';
		if (r.status === 'fixed') return r.bootstrap ? 'Initial build' : 'Fixed problems';
		if (r.status === 'deferred') return 'Waited for repair';
		return 'Clean';
	}
	const fixTotal = (f: Record<string, number>) => Object.values(f).reduce((a, b) => a + b, 0);
	const last = $derived(health.runs[0] ?? null);
	const groups = $derived(
		[...new Set(overview.rows.map((r) => r.dimension))].map((d) => ({
			dimension: d,
			rows: overview.rows.filter((r) => r.dimension === d)
		}))
	);
	const ownedCount = $derived(overview.rows.filter((r) => r.owned).length);

	const submit = (name: string) => () => {
		busy = name;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			busy = null;
		};
	};
</script>

{#if message}
	<p class={message.ok ? 'notice' : 'error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p>
{/if}

{#if health.repair?.pending}
	{@const job = health.repair.job}
	<section class="card repair" aria-labelledby="tag-repair-heading">
		<h2 id="tag-repair-heading">Taxonomy change being applied <AdminBadge tone="warn" label="Repair pending" /></h2>
		<p>
			An eBird taxonomy update changed species or family names, so every species' tag inputs are being re-checked in small
			batches (generation {health.repair.generation}). Until it finishes, activating a rule set
			or rolling back to an earlier one waits. <strong>Retire to legacy</strong> still works.
		</p>
		{#if job && (job.status === 'pending' || job.status === 'running')}
			<p class="muted">
				Repair job #{job.id} is {job.status}{#if job.progress?.unitsTotal}: {nf(job.progress.unitsDone ?? 0)} of
					{nf(job.progress.unitsTotal)} species{/if}.
			</p>
		{:else}
			<p class="muted">No repair job is active{job ? ` (the last one was ${job.status})` : ''}.</p>
			<form method="POST" action="?/resume_tag_repair" use:enhance={submit('resume')}>
				<button type="submit" disabled={busy !== null}>{busy === 'resume' ? 'Starting…' : 'Resume repair'}</button>
			</form>
		{/if}
	</section>
{/if}

<section class="card" aria-labelledby="tag-consistency-heading">
	<h2 id="tag-consistency-heading">
		Nightly consistency check
		{#if last}<AdminBadge tone={runTone(last)} label={runLabel(last)} />{/if}
	</h2>
	<p class="muted">
		Every night the worker re-derives every species' tags from its stored article and taxonomy and fixes anything
		that differs. A fix means some code path missed an update, so any fix or failure is worth a look.
	</p>
	{#if last}
		<p>
			Last run {fmtWhen(last.startedAt)}: {nf(last.checked)} species checked{#if last.durationMs != null} in
				{(last.durationMs / 1000).toFixed(1)} s{/if}{#if fixTotal(last.fixed) > 0} · {nf(fixTotal(last.fixed))}
				{last.bootstrap ? 'built' : 'fixed'}{/if}{#if last.failures.length} · {last.failures.length} integrity
				problem{last.failures.length === 1 ? '' : 's'}{/if}.
		</p>
	{:else}
		<p>No check has run yet.</p>
	{/if}
	<p class="muted">
		{#if health.running}A check is running now.{:else if health.nextRunAt}Next check {fmtWhen(health.nextRunAt)}.{:else}No
			check is scheduled; the worker schedules one when it next starts or idles.{/if}
	</p>
	<form method="POST" action="?/run_tag_consistency" use:enhance={submit('run')}>
		<button type="submit" disabled={busy !== null || health.running}>
			{busy === 'run' ? 'Starting…' : 'Run now'}
		</button>
	</form>

	{#if health.unclearedCount > 0}
		<h3>Unresolved write failures <AdminBadge tone="error" label={`${health.unclearedCount} open`} /></h3>
		<p class="muted">A tag update failed and has not succeeded since. The nightly check repairs the data; the error shows what broke.</p>
		<ul class="plain">
			{#each health.uncleared as f (f.key)}
				<li><code>{f.key}</code> · {f.entryPoint} · {f.at ? fmtWhen(f.at) : 'time unknown'}<br /><span class="muted">{f.error}</span></li>
			{/each}
		</ul>
	{/if}

	{#if health.runs.length}
		<h3>Recent checks</h3>
		<div class="table-scroll">
			<table>
				<thead>
					<tr><th scope="col">When</th><th scope="col">Result</th><th scope="col">Checked</th><th scope="col">Details</th></tr>
				</thead>
				<tbody>
					{#each health.runs as r (r.id)}
						<tr>
							<td>{fmtWhen(r.startedAt)}</td>
							<td><AdminBadge tone={runTone(r)} label={runLabel(r)} /></td>
							<td>{nf(r.checked)}</td>
							<td>
								{#each Object.entries(r.fixed) as [k, n] (k)}
									<span class="fix">{REASON_LABEL[k] ?? k}: {nf(n)}</span>
								{/each}
								{#each r.failures.slice(0, 5) as f, i (i)}
									<span class="fail">{f.kind}: {f.detail}</span>
								{/each}
								{#if r.failures.length > 5}<span class="fail">…and {r.failures.length - 5} more</span>{/if}
								{#if fixTotal(r.fixed) === 0 && r.failures.length === 0}<span class="muted">—</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<section class="card" aria-labelledby="tag-overview-heading">
	<h2 id="tag-overview-heading">Tags</h2>
	<p class="muted">
		{ownedCount === 0
			? 'Every tag still comes from the earlier AI annotations (legacy).'
			: `${ownedCount} of ${overview.rows.length} tags come from approved rules; the rest are legacy.`}
		{nf(overview.universe)} species have a stored article and can be evaluated by rules; {nf(overview.noLegacyBaseline)}
		species have no legacy tags at all. Open a tag to see its rules, history, proposals and reports.
	</p>
	{#each groups as g (g.dimension)}
		<h3>{dimensionLabel(g.dimension)}</h3>
		<div class="table-scroll">
			<table>
				<thead>
					<tr>
						<th scope="col">Tag</th>
						<th scope="col">Source</th>
						<th scope="col" class="num">Carrying</th>
						<th scope="col" class="wide">Last change</th>
					</tr>
				</thead>
				<tbody>
					{#each g.rows as r (r.tag)}
						<tr>
							<td>
								<a href="/admin/tags/{encodeURIComponent(r.tag)}">{r.value}</a>
								{#if r.owned}
									<span class="sub">
										{nf(r.assigned ?? 0)} yes · {nf(r.notAssigned ?? 0)} no{#if r.unevaluated}
											· {nf(r.unevaluated)} not evaluated{/if}{#if r.unknown}
											· <strong>{nf(r.unknown)} unknown</strong>{/if}
									</span>
								{/if}
							</td>
							<td>
								{#if r.owned}<AdminBadge tone="ok" label={`Rules r${r.owned.revisionId}`} />{:else}<AdminBadge
										label="Legacy"
									/>{/if}
							</td>
							<td class="num">{nf(r.carrying)}</td>
							<td class="wide">
								{#if r.lastActivation}{r.lastActivation.action === 'to_legacy'
										? 'Retired'
										: r.lastActivation.action === 'rollback'
											? 'Rolled back'
											: 'Activated'}
									{fmtWhen(r.lastActivation.at)}{:else}<span class="muted">Never</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/each}
</section>

<style>
	.card {
		padding: 1rem;
		margin-block: 1rem;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.card h2 {
		font-size: 1.1rem;
		margin: 0 0 0.75rem;
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}
	.card h3 {
		font-size: 0.95rem;
		margin: 1.1rem 0 0.4rem;
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}
	.card p {
		margin: 0.6rem 0;
		line-height: 1.5;
	}
	.repair {
		border: 2px solid var(--need-text);
	}
	.muted {
		color: var(--muted);
	}
	button {
		min-height: 48px;
		padding: 10px 16px;
		font-size: 1rem;
		font-weight: 600;
		border: 1px solid var(--accent);
		border-radius: 8px;
		background: var(--accent);
		color: var(--on-accent);
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.table-scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.88rem;
	}
	th {
		text-align: left;
		color: var(--muted);
		font-weight: 600;
		font-size: 0.8rem;
		padding: 6px 10px 6px 0;
	}
	td {
		padding: 8px 10px 8px 0;
		border-bottom: 1px solid var(--border);
		vertical-align: middle;
	}
	td a {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
		color: var(--accent);
		font-weight: 600;
	}
	.sub {
		display: block;
		font-size: 0.82rem;
		color: var(--muted);
		padding-bottom: 4px;
	}
	.num {
		text-align: right;
	}
	/* Phones: tag, source and count only; history is on the tag page. */
	.wide {
		display: none;
	}
	@media (min-width: 640px) {
		.wide {
			display: table-cell;
		}
	}
	.fix,
	.fail {
		display: block;
	}
	.fail {
		color: var(--danger);
	}
	.plain {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.plain li {
		padding: 8px 0;
		border-bottom: 1px solid var(--border);
		overflow-wrap: anywhere;
	}
	.notice {
		padding: 10px 12px;
		border-radius: 8px;
		background: var(--accent-soft);
		color: var(--accent);
	}
	.error {
		padding: 10px 12px;
		border-radius: 8px;
		background: var(--danger-soft);
		color: var(--danger);
	}
</style>
