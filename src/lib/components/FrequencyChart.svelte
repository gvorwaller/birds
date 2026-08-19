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

	/** Mirrors WeekStat in $server/forecast (same no-server-import rule). */
	export interface ChartWeek {
		week: number; // 1-48
		freq: number;
		n: number;
	}
</script>

<script lang="ts">
	let {
		months,
		weeks = null,
		showEffort = false,
		highlightMonth = null,
		minMonthN = 40,
		minWeekN = 10,
		caption
	}: {
		months: ChartMonth[];
		/** 48-week resolution — enables the Month|Week toggle (td-af8393). */
		weeks?: ChartWeek[] | null;
		/** Effort sparkline under the weekly bars (/forecast/species only — GROK pin). */
		showEffort?: boolean;
		highlightMonth?: number | null;
		minMonthN?: number;
		minWeekN?: number;
		caption: string;
	} = $props();

	// Client-only view state: Month default; deliberately NOT in the URL or
	// localStorage and never synced across surfaces (GROK pin 7).
	let mode = $state<'month' | 'week'>('month');

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

	// ---- Weekly mode (AGY 320px math, GROK-pinned): 48 slots in the same
	// 480-unit viewBox → 10/slot with 6-wide bars ≈ 4px bars + 2px gaps at a
	// 320px viewport. Month letters at group centers, gridlines between
	// month groups.
	const WSLOT = W / 48;
	const WBAR = 6;
	const maxWeekFreq = $derived(weeks ? Math.max(...weeks.map((w) => w.freq), 0) : 0);
	const lowSampleWeeks = $derived(
		weeks ? weeks.filter((w) => w.n > 0 && w.n < minWeekN).length : 0
	);
	const maxWeekN = $derived(weeks ? Math.max(...weeks.map((w) => w.n), 0) : 0);
	// Effort strip geometry (only drawn in week mode with showEffort).
	const EFFORT_H = 22;
	const effortActive = $derived(showEffort && mode === 'week' && !!weeks);
	const svgH = $derived(effortActive ? H + EFFORT_H + 14 : H);

	function weekBarHeight(freq: number): number {
		if (maxWeekFreq <= 0) return 0;
		return Math.max((freq / maxWeekFreq) * PLOT_H, freq > 0 ? 2 : 0);
	}

	function barHeight(freq: number): number {
		if (maxFreq <= 0) return 0;
		return Math.max((freq / maxFreq) * PLOT_H, freq > 0 ? 2 : 0);
	}

	function weekOfMonthLabel(week: number): string {
		const month = MONTH_SHORT[Math.ceil(week / 4) - 1];
		const slot = ['early', 'mid', 'mid-late', 'late'][(week - 1) % 4];
		return `${slot} ${month}`;
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
	{#if weeks}
		<div class="modes" role="group" aria-label="Chart resolution">
			<button
				type="button"
				class:on={mode === 'month'}
				aria-pressed={mode === 'month'}
				onclick={() => (mode = 'month')}>Month</button
			>
			<button
				type="button"
				class:on={mode === 'week'}
				aria-pressed={mode === 'week'}
				onclick={() => (mode = 'week')}>Week</button
			>
		</div>
	{/if}
	<svg viewBox="0 0 {W} {svgH}" role="img" aria-label={caption} preserveAspectRatio="xMidYMid meet">
		<defs>
			<pattern id={hatchId} width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
				<rect width="6" height="6" fill="var(--accent-soft, #e3f3ec)" />
				<line x1="0" y1="0" x2="0" y2="6" stroke="var(--accent, #0a5c43)" stroke-width="2" />
			</pattern>
		</defs>
		<line x1="0" y1={BASE_Y} x2={W} y2={BASE_Y} class="axis" />
		{#if mode === 'week' && weeks}
			<!-- Month-group gridlines + letters for mental alignment (AGY). -->
			{#each MONTH_LETTERS as letter, gi (gi)}
				{#if gi > 0}
					<line x1={gi * 4 * WSLOT} y1={BASE_Y - PLOT_H - 8} x2={gi * 4 * WSLOT} y2={BASE_Y} class="grid" />
				{/if}
				<text x={gi * 4 * WSLOT + 2 * WSLOT} y={H - 6} class="label" text-anchor="middle">{letter}</text>
			{/each}
			{#each weeks as w, i (w.week)}
				{@const h = weekBarHeight(w.freq)}
				{@const low = w.n > 0 && w.n < minWeekN}
				<g>
					<title
						>Week {w.week} ({weekOfMonthLabel(w.week)}): {pct(w.freq)} of checklists (n={w.n}{low
							? ', small sample'
							: ''})</title
					>
					{#if w.n === 0}
						<text x={i * WSLOT + WSLOT / 2} y={BASE_Y - 4} class="nodata wk" text-anchor="middle">·</text>
					{:else}
						<rect
							x={i * WSLOT + (WSLOT - WBAR) / 2}
							y={BASE_Y - h}
							width={WBAR}
							height={Math.max(h, 0.5)}
							class="bar"
							style:fill={low ? `url(#${hatchId})` : undefined}
						/>
						{#if low}
							<text x={i * WSLOT + WSLOT / 2} y={BASE_Y - h - 3} class="wflag" text-anchor="middle">†</text>
						{/if}
					{/if}
				</g>
			{/each}
			{#if effortActive && weeks}
				<!-- Effort strip: checklists per week, 1:1 under the bars. -->
				{#each weeks as w, i (w.week)}
					{@const eh = maxWeekN > 0 ? Math.max((w.n / maxWeekN) * EFFORT_H, w.n > 0 ? 1 : 0) : 0}
					<rect
						x={i * WSLOT + (WSLOT - WBAR) / 2}
						y={H + 8 + (EFFORT_H - eh)}
						width={WBAR}
						height={eh}
						class="effort"
					>
						<title>Week {w.week}: {w.n.toLocaleString()} checklists</title>
					</rect>
				{/each}
			{/if}
		{/if}
		{#each mode === 'week' ? [] : months as m, i (m.month)}
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
		{#if mode === 'week'}
			{#if lowSampleWeeks > 0}
				<span class="footnote">
					† hatched weeks: fewer than {minWeekN} checklists — a hint, not a trend.
				</span>
			{/if}
			{#if effortActive}
				<span class="footnote">Lower strip: checklists per week (effort).</span>
			{/if}
		{/if}
		{#if mode === 'month' && windowLabel}
			<span class="footnote">Good window: {windowLabel}</span>
		{/if}
		{#if mode === 'month' && lowSampleMonths.length > 0}
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
	/* Month|Week segmented toggle (≥48px segments — GROK pin 7). */
	.modes {
		display: inline-flex;
		gap: 0;
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
		margin-bottom: 6px;
	}
	.modes button {
		min-height: 48px;
		min-width: 64px;
		padding: 8px 16px;
		border: none;
		background: var(--card);
		color: var(--text);
		font-weight: 600;
		cursor: pointer;
	}
	.modes button + button {
		border-left: 1px solid var(--border);
	}
	.modes button.on {
		background: var(--accent);
		color: #fff;
	}
	.grid {
		stroke: var(--border);
		stroke-width: 0.5;
	}
	.wflag {
		fill: var(--text);
		font-size: 8px;
	}
	.nodata.wk {
		font-size: 9px;
	}
	.effort {
		fill: var(--muted);
		opacity: 0.55;
	}
</style>
