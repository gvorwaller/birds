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
	const hatchId = $derived(`lown-${stableId(caption)}`);

	function stableId(s: string): string {
		let h = 0;
		for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
		return (h >>> 0).toString(36);
	}
	const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

	// SVG geometry (viewBox units; the element itself is fluid-width).
	const W = 480;
	const H = 162;
	const PLOT_H = 110;
	const BASE_Y = 134; // baseline for bars; labels sit below
	const BAR_W = 26;
	const SLOT = W / 12;

	const maxFreq = $derived(Math.max(...months.map((m) => m.freq), 0));
	const lowSampleMonths = $derived(months.filter((m) => m.n > 0 && m.n < minMonthN));
	const windowMonths = $derived.by(() => {
		const sampled = months.filter((m) => m.n >= minMonthN && m.freq > 0);
		const peak = Math.max(...sampled.map((m) => m.freq), 0);
		const trough = Math.min(...sampled.map((m) => m.freq), peak);
		// Skip a "window" when the curve is too rare or too flat to mean anything.
		if (peak < 0.05 || peak < trough * 1.25) return [] as number[];
		return sampled.filter((m) => m.freq >= peak * 0.8).map((m) => m.month);
	});
	const windowLabel = $derived.by(() => formatMonthWindow(windowMonths, MONTH_SHORT));

	function barHeight(freq: number): number {
		if (maxFreq <= 0) return 0;
		return Math.max((freq / maxFreq) * PLOT_H, freq > 0 ? 2 : 0);
	}

	function pct(freq: number): string {
		if (freq === 0) return '0%';
		if (freq < 0.01) return '<1%';
		return `${Math.round(freq * 100)}%`;
	}

	/** Single range, including wrap-around (Sep–May). Multiple gaps stay as a list. */
	function formatMonthWindow(months: number[], names: readonly string[]): string {
		if (months.length < 2) return '';
		const set = new Set(months);
		const starts = months.filter((m) => !set.has(m === 1 ? 12 : m - 1));
		if (starts.length !== 1) return months.map((m) => names[m - 1]).join(', ');
		const start = starts[0];
		let end = start;
		for (let i = 0; i < 11; i++) {
			const next = end === 12 ? 1 : end + 1;
			if (!set.has(next)) break;
			end = next;
		}
		return `${names[start - 1]}–${names[end - 1]}`;
	}
</script>

<figure class="chart">
	<svg viewBox="0 0 {W} {H}" role="img" aria-label={caption} preserveAspectRatio="xMidYMid meet">
		<defs>
			<pattern id={hatchId} width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
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
						style:fill={low ? `url(#${hatchId})` : undefined}
					/>
				{/if}
				<text x={i * SLOT + SLOT / 2} y={H - 6} class="label" text-anchor="middle"
					>{MONTH_LETTERS[i]}</text
				>
				{#if m.freq > 0 && (m.month === highlightMonth || h > 28)}
					<text
						x={i * SLOT + SLOT / 2}
						y={Math.max(10, BASE_Y - h - 4)}
						class="pct"
						class:hlpct={m.month === highlightMonth}
						text-anchor="middle">{pct(m.freq)}{low ? "†" : ""}</text
					>
				{:else if low}
					<text x={i * SLOT + SLOT / 2} y={BASE_Y - h - 4} class="flag" text-anchor="middle">†</text>
				{/if}
			</g>
		{/each}
	</svg>
	<figcaption>
		{caption}
		{#if windowLabel}
			<span class="footnote">Good window: {windowLabel}</span>
		{/if}
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
	.pct {
		fill: var(--muted);
		font-size: 10px;
	}
	.pct.hlpct {
		fill: var(--text);
		font-weight: 700;
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
