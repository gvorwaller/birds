<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let creating = $state(false);

	function fmtDates(start: string | null, end: string | null): string {
		if (!start && !end) return 'no dates yet';
		const f = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString();
		if (start && end) return start === end ? f(start) : `${f(start)} – ${f(end)}`;
		return f((start ?? end) as string);
	}
</script>

<svelte:head>
	<title>Trips — birds</title>
</svelte:head>

<div class="page">
	<header class="page-head">
		<h1>Trips</h1>
		<p class="sub">{data.trips.length} {data.trips.length === 1 ? 'trip' : 'trips'}</p>
	</header>

	{#if data.canEdit}
		<section class="card">
			<h2>Create a trip</h2>
			{#if form?.error}<p class="err" role="alert">{form.error}</p>{/if}
			<form
				method="POST"
				action="?/create"
				use:enhance={() => {
					creating = true;
					return async ({ update }) => {
						await update();
						creating = false;
					};
				}}
			>
				<label class="grow-field">
					<span>Name</span>
					<input type="text" name="name" placeholder="e.g. Hancock County, Maine" required />
				</label>
				<label>
					<span>Start</span>
					<input type="date" name="start_date" />
				</label>
				<label>
					<span>End</span>
					<input type="date" name="end_date" />
				</label>
				<button type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create trip'}</button>
			</form>
		</section>
	{/if}

	{#if data.trips.length === 0}
		<section class="card"><p class="muted">No trips yet.</p></section>
	{/if}

	{#each data.trips as t (t.id)}
		<a class="card trip" href={`/trips/${t.id}`}>
			<div class="grow">
				<div class="name">{t.name}</div>
				<div class="meta">{fmtDates(t.start_date, t.end_date)} · {t.stop_count} {t.stop_count === 1 ? 'stop' : 'stops'}</div>
			</div>
			<div class="chev">›</div>
		</a>
	{/each}
</div>

<style>
	.page {
		max-width: 1100px;
		margin: 0 auto;
		padding: 16px;
	}
	.page-head {
		margin: 4px 0 16px;
	}
	h1 {
		font-size: 1.4rem;
	}
	.sub,
	.muted {
		color: var(--muted);
		font-size: 0.89rem;
	}
	.card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 16px;
		margin-bottom: 12px;
	}
	.card h2 {
		font-size: 1.05rem;
		margin-bottom: 10px;
	}
	form {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		align-items: flex-end;
	}
	form label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
	}
	.grow-field {
		flex: 1;
		min-width: 200px;
	}
	input {
		min-height: 48px;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
		color: var(--text);
	}
	.grow-field input {
		width: 100%;
	}
	button {
		min-height: 48px;
		padding: 10px 20px;
		border-radius: 8px;
		border: 1px solid var(--accent);
		background: var(--accent);
		color: #fff;
		font-weight: 600;
	}
	button:disabled {
		opacity: 0.5;
	}
	.trip {
		display: flex;
		align-items: center;
		gap: 12px;
		text-decoration: none;
		color: inherit;
	}
	.trip:hover {
		background: var(--bg);
	}
	.grow {
		flex: 1;
		min-width: 0;
	}
	.name {
		font-weight: 700;
		color: var(--text);
	}
	.meta {
		color: var(--muted);
		font-size: 0.83rem;
		margin-top: 2px;
	}
	.chev {
		color: var(--muted);
		font-size: 1.5rem;
	}
	.err {
		color: var(--danger);
		font-weight: 600;
		margin-bottom: 8px;
	}
	@media (min-width: 640px) {
		.page {
			padding: 24px;
		}
		h1 {
			font-size: 1.6rem;
		}
	}
</style>
