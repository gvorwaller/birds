<script lang="ts">
	/**
	 * Twelve month cells showing a REPORT COUNT each, never a percentage
	 * (td-eec7db Phase 3 [A-P1-4]). Modelled on the hotspot page's monthly
	 * strip: with `hrefFor`, each cell is a link that selects its month (a
	 * plain navigation, the server reads ?month=); without it, the cells only
	 * show the counts.
	 */
	import { MONTH_LONG, MONTH_SHORT, reportsText } from '$lib/external-reports';

	let {
		counts,
		label,
		selected = null,
		hrefFor = null
	}: {
		/** Jan…Dec. */
		counts: readonly number[];
		/** What the counts are, for screen readers: "Willow Ptarmigan reports in Nordland". */
		label: string;
		selected?: number | null;
		hrefFor?: ((month: number) => string) | null;
	} = $props();

	const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
	const shown = (n: number) => (n >= 10_000 ? compact.format(n) : n.toLocaleString('en-US'));
</script>

<div class="strip" role="list" aria-label={label}>
	{#each MONTH_SHORT as name, i (name)}
		{@const m = i + 1}
		{@const n = counts[i] ?? 0}
		<div role="listitem">
			{#if hrefFor}
				<a
					class="cell"
					class:on={m === selected}
					class:none={n === 0}
					href={hrefFor(m)}
					aria-current={m === selected ? 'true' : undefined}
					aria-label="{MONTH_LONG[i]}: {reportsText(n)}"
					data-sveltekit-noscroll
				>
					<span class="mname">{name}</span><span class="mcount">{shown(n)}</span>
				</a>
			{:else}
				<span class="cell" class:none={n === 0}>
					<span class="mname" aria-hidden="true">{name}</span><span class="mcount" aria-hidden="true"
						>{shown(n)}</span
					><span class="sr">{MONTH_LONG[i]}: {reportsText(n)}</span>
				</span>
			{/if}
		</div>
	{/each}
</div>

<style>
	.strip {
		display: grid;
		/* 4 columns on a phone keeps every cell at least 48px wide at 320px. */
		grid-template-columns: repeat(4, 1fr);
		gap: 6px;
		margin: 8px 0;
	}
	@media (min-width: 640px) {
		.strip {
			grid-template-columns: repeat(12, 1fr);
		}
	}
	.cell {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 48px;
		padding: 4px 2px;
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--text);
		text-decoration: none;
		background: var(--card);
	}
	/* Hover only where a pointer really hovers: iOS Safari keeps :hover on
	   the tapped link, which painted the chosen month's light text on the
	   page background (iOS Simulator, 2026-10-27). */
	@media (hover: hover) {
		a.cell:not(.on):hover {
			background: var(--bg);
		}
	}
	.cell.none .mcount {
		color: var(--muted);
	}
	.cell.on {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}
	.cell.on .mcount {
		color: var(--on-accent);
	}
	.mname {
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.02em;
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	.mcount {
		font-size: 0.85rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
</style>
