<script lang="ts" module>
	/**
	 * Structurally mirrors MonthStat in $server/forecast — duplicated on purpose
	 * so this client component never imports a server module (same pattern as
	 * BestPlaces.svelte / PlaceRanking).
	 */
	export interface ChartMonth {
		month: number; // 1-12
		freq: number; // 0-1, fraction of checklists
		n: number; // total checklists in the month
	}
</script>

<script lang="ts">
	let {
		months,
		highlightMonth = null,
		minMonthN = 40,
		caption
	}: {
		months: ChartMonth[];
		highlightMonth?: number | null;
		minMonthN?: number;
		caption: string;
	} = $props();

	const MONTH_LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

	// SVG geometry (viewBox units; the element itself is fluid-width).
	const W = 480;
	const H = 150;
	const PLOT_H = 110;
	const BASE_Y = 122; // baseline for bars; labels sit below
	const BAR_W = 26;
	const SLOT = W / 12;

	const maxFreq = $derived(Math.max(...months.map((m) => m.freq), 0));
	const lowSampleMonths = $derived(months.filter((m) => m.n > 0 && m.n < minMonthN));

	function barHeight(freq: number): number {
		if (maxFreq <= 0) return 0;
		return Math.max((freq / maxFreq) * PLOT_H, freq > 0 ? 2 : 0);
	}

	function pct(freq: number): string {
		if (freq === 0) return '0%';
		if (freq < 0.01) return '<1%';
		return `${Math.round(freq * 100)}%`;
	}
</script>

<figure class="chart">
	<svg viewBox="0 0 {W} {H}" role="img" aria-label={caption} preserveAspectRatio="xMidYMid meet">
		<defs>
			<pattern id="lown" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
				<rect width="6" height="6" fill="var(--accent-soft, #e3f3ec)" />
				<line x1="0" y1="0" x2="0" y2="6" stroke="var(--accent, #0a5c43)" stroke-width="2" />
			</pattern>
		</defs>
		<line x1="0" y1={BASE_Y} x2={W} y2={BASE_Y} class="axis" />
		{#each months as m, i (m.month)}
			{@const h = barHeight(m.freq)}
			{@const x = i * SLOT + (SLOT - BAR_W) / 2}
			{@const low = m.n > 0 && m.n < minMonthN}
			<g>
				<title
					>{pct(m.freq)} of checklists in month {m.month} (n={m.n}{low
						? ', small sample'
						: ''})</title
				>
				{#if m.n === 0}
					<!-- No checklists at all: mark as "no data", never as zero frequency -->
					<text x={i * SLOT + SLOT / 2} y={BASE_Y - 6} class="nodata" text-anchor="middle">·</text>
				{:else}
					<rect
						{x}
						y={BASE_Y - h}
						width={BAR_W}
						height={Math.max(h, 0.5)}
						class="bar"
						class:hl={m.month === highlightMonth}
						class:low
					/>
				{/if}
				<text x={i * SLOT + SLOT / 2} y={H - 6} class="label" text-anchor="middle"
					>{MONTH_LETTERS[i]}</text
				>
				{#if low}
					<text x={i * SLOT + SLOT / 2} y={BASE_Y - h - 4} class="flag" text-anchor="middle">†</text>
				{/if}
			</g>
		{/each}
	</svg>
	<figcaption>
		{caption}
		{#if lowSampleMonths.length > 0}
			<span class="footnote">
				† small sample (fewer than {minMonthN} checklists): {lowSampleMonths
					.map((m) => `${MONTH_LETTERS[m.month - 1]}=${m.n}`)
					.join(', ')}
			</span>
		{/if}
	</figcaption>
</figure>

<style>
	.chart {
		margin: 0;
	}
	svg {
		display: block;
		width: 100%;
		height: auto;
	}
	.axis {
		stroke: var(--border);
		stroke-width: 1;
	}
	.bar {
		fill: var(--accent);
	}
	.bar.low {
		fill: url(#lown);
	}
	.bar.hl {
		stroke: var(--text);
		stroke-width: 2;
	}
	.label {
		fill: var(--muted);
		font-size: 12px;
	}
	.flag {
		fill: var(--text);
		font-size: 11px;
	}
	.nodata {
		fill: var(--muted);
		font-size: 13px;
	}
	figcaption {
		color: var(--muted);
		font-size: 0.82rem;
		margin-top: 6px;
	}
	.footnote {
		display: block;
		margin-top: 2px;
	}
</style>
