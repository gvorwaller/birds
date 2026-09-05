<script lang="ts" module>
	/**
	 * Client-side types, re-exported from the pure logic module — never from
	 * the server layer (FrequencyChart.svelte precedent, `:1-19`).
	 * `migration-ribbon.ts` defines the canonical shapes so both this
	 * component and its test file share one definition; nothing on this page
	 * imports server code.
	 */
	export type {
		RibbonGridClient,
		RibbonCellClient,
		RibbonRegionRowClient,
		RibbonRegionsClient,
		RibbonColumn,
		Weighting
	} from './migration-ribbon';
</script>

<script lang="ts">
	import { tick, untrack } from 'svelte';
	import {
		BANDS,
		COLUMNS,
		COLUMN_NAMES,
		LOW_N,
		ML,
		MSHORT,
		HOME_COLUMN,
		PLAY_MS,
		BINS,
		bandLabel,
		binIndex,
		pct,
		activeBands,
		applyWide,
		beginDrill,
		chartAria,
		drawnColumns,
		drillCacheKey,
		drillHeading,
		fillFor,
		gapText,
		geometry,
		initialState,
		landmarkFor,
		migrationSummary,
		nearestBand,
		pickCell,
		readout,
		reduce,
		scopeText,
		setMonth,
		boundedCacheSet,
		DrillGeneration,
		resolveDrillLoad,
		type Key,
		type RibbonColumn,
		type RibbonGridClient,
		type RibbonRegionRowClient,
		type RibbonRegionsClient,
		type RibbonState,
		type Weighting
	} from './migration-ribbon';

	let {
		grid,
		speciesCode,
		speciesName,
		onchartregion
	}: {
		grid: RibbonGridClient;
		speciesCode: string;
		speciesName: string;
		onchartregion: (row: RibbonRegionRowClient) => void;
	} = $props();

	function stableId(s: string): string {
		let h = 0;
		for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
		return (h >>> 0).toString(36);
	}
	const hatchId = $derived(`rbhatch-${stableId(speciesCode)}`);

	// ---- Breakpoint / reduced-motion sampling (owner decision, CODEX1 P1-7 /
	// P2-5): World under 1024px, By continent at >=1024px, following
	// `matchMedia`, re-sampled once after first paint (Safari can add the
	// scrollbar after this script runs), and never again once the user
	// touches the View toggle. ------------------------------------------------
	let wide = $state(false);
	/** Below 640px (spec rev 3.3 TD-C, P1-1) — sampled independently from
	 * `wide`, NOT derived as `!wide`, since 640-1023px (tablet) must keep the
	 * compact rows and full cell picking that `wide` alone would otherwise
	 * lump in with "phone". Drives `geometry()`'s row height and `pickCell`'s
	 * band-only picking; never touches `ribbonState`, so it needs no
	 * `untrack()` (unlike the `wide` effect below). */
	let phone = $state(false);
	let reducedMotion = $state(false);
	let ribbonState = $state<RibbonState>(initialState(false));
	let fullGlobe = $state(false);
	const currentBands = $derived(activeBands(grid, ribbonState, fullGlobe));
	const summary = $derived(migrationSummary(grid, ribbonState));
	const gutterCol = $derived<RibbonColumn | null>(
		ribbonState.view === 'cont' && ribbonState.contView !== 'ALL' ? ribbonState.contView : null
	);

	$effect(() => {
		const bands = currentBands;
		if (bands.length > 0 && !bands.includes(ribbonState.band as (typeof bands)[number])) {
			ribbonState = { ...ribbonState, band: nearestBand(ribbonState.band, bands) as (typeof BANDS)[number] };
		}
	});

	// `untrack` on every read of `ribbonState` here is load-bearing: this
	// effect only WRITES `ribbonState`, on a matchMedia change or the
	// post-first-paint re-sample, never on `ribbonState` itself changing. A
	// tracked read would make this effect its own dependency — `applyWide`
	// returns a new object each time `viewTouched` is false, so writing that
	// back would re-trigger this same effect forever (found live-testing
	// td-950907: the drill fetch's generation counter span thousands of
	// values a second because this effect looped, so every response arrived
	// "stale" and the drill panel never left "Loading…").
	$effect(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return;
		const mq = window.matchMedia('(min-width: 1024px)');
		const apply = (matches: boolean) => {
			wide = matches;
			ribbonState = applyWide(untrack(() => ribbonState), matches);
		};
		apply(mq.matches);
		const onChange = (e: MediaQueryListEvent) => apply(e.matches);
		mq.addEventListener('change', onChange);
		const raf = requestAnimationFrame(() => apply(mq.matches));
		return () => {
			mq.removeEventListener('change', onChange);
			cancelAnimationFrame(raf);
		};
	});

	$effect(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return;
		const mq = window.matchMedia('(max-width: 639px)');
		const apply = (matches: boolean) => {
			phone = matches;
		};
		apply(mq.matches);
		const onChange = (e: MediaQueryListEvent) => apply(e.matches);
		mq.addEventListener('change', onChange);
		const raf = requestAnimationFrame(() => apply(mq.matches));
		return () => {
			mq.removeEventListener('change', onChange);
			cancelAnimationFrame(raf);
		};
	});

	$effect(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return;
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
		const apply = (matches: boolean) => {
			reducedMotion = matches;
			if (matches && untrack(() => ribbonState.playing)) {
				ribbonState = { ...untrack(() => ribbonState), playing: false };
			}
		};
		apply(mq.matches);
		const onChange = (e: MediaQueryListEvent) => apply(e.matches);
		mq.addEventListener('change', onChange);
		const raf = requestAnimationFrame(() => apply(mq.matches));
		return () => {
			mq.removeEventListener('change', onChange);
			cancelAnimationFrame(raf);
		};
	});

	// ---- Geometry: ResizeObserver on `.rscroll`, 100ms debounced, with a
	// plain `resize` fallback. -------------------------------------------------
	let rscrollEl = $state<HTMLDivElement | null>(null);
	let availWidth = $state(240);

	$effect(() => {
		const el = rscrollEl;
		if (!el) return;
		const update = () => {
			availWidth = Math.max(0, el.clientWidth - 12);
		};
		update();
		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		const debounced = () => {
			clearTimeout(debounceTimer);
			debounceTimer = setTimeout(update, 100);
		};
		let ro: ResizeObserver | null = null;
		if (typeof ResizeObserver !== 'undefined') {
			ro = new ResizeObserver(debounced);
			ro.observe(el);
		} else if (typeof window !== 'undefined') {
			window.addEventListener('resize', debounced);
		}
		return () => {
			clearTimeout(debounceTimer);
			ro?.disconnect();
			if (typeof window !== 'undefined') window.removeEventListener('resize', debounced);
		};
	});

	const drawnCols = $derived(drawnColumns(ribbonState));
	const geom = $derived(geometry(ribbonState, availWidth, wide, phone, currentBands));
	const clipped = $derived(geom.w > availWidth + 1);
	const eqIndex = $derived(currentBands.indexOf(-10 as (typeof currentBands)[number]));

	const monthOverlayXs = $derived.by(() => {
		if (!ribbonState.month) return [] as number[];
		const blocks = geom.cont ? drawnCols.map((_, ci) => ci * 12) : [0];
		return blocks.map((b0) => (b0 + ribbonState.month - 1) * geom.cellW);
	});
	const bandOverlayY = $derived.by(() => {
		const bi = currentBands.indexOf(ribbonState.band as (typeof currentBands)[number]);
		return bi >= 0 ? geom.headH + bi * geom.rowH : null;
	});
	const cellOverlayX = $derived.by(() => {
		if (bandOverlayY == null || !ribbonState.month) return null;
		const ci = geom.cont ? drawnCols.findIndex((c) => c === ribbonState.cont) : 0;
		if (geom.cont && ci < 0) return null;
		return ((geom.cont ? ci * 12 : 0) + ribbonState.month - 1) * geom.cellW;
	});

	const currentReadout = $derived(readout(grid, ribbonState));
	const currentGap = $derived(gapText(grid.gapMonths));
	const currentScope = $derived(scopeText(grid.meta, ribbonState.weight));
	const currentAria = $derived(chartAria(grid, ribbonState, speciesName, currentBands));
	const showToDrill = $derived(!currentReadout.empty && currentReadout.nreg > 0);

	/** Visually-hidden live announcement — updated only on USER-initiated
	 * selection changes, never on a Play timer tick (CODEX1 P2-3: an
	 * aria-live readout firing every 750ms during Play is unusable). */
	let srAnnounce = $state('');
	function applySelection(next: RibbonState) {
		ribbonState = next;
		const r = readout(grid, next);
		srAnnounce = r.empty ? r.line2 : `${r.line1}. ${r.line2}${r.line3 ? `. ${r.line3}` : ''}`;
	}

	// ---- Play: 750ms looping interval, an `$effect` + cleanup (NavProgress
	// pattern), hidden under reduced motion; any manual month change stops it
	// (every handler below that changes month goes through `applySelection`
	// with `playing: false`, never this effect's own direct advance). --------
	$effect(() => {
		if (!ribbonState.playing || reducedMotion) return;
		const id = setInterval(() => {
			ribbonState = { ...ribbonState, month: (ribbonState.month % 12) + 1 };
		}, PLAY_MS);
		return () => clearInterval(id);
	});
	function togglePlay() {
		if (reducedMotion) return;
		ribbonState = { ...ribbonState, playing: !ribbonState.playing };
	}

	// ---- Keyboard (mockup keydown handler, ported to `reduce()`). ----------
	function onRibbonKeydown(e: KeyboardEvent) {
		const res = reduce(ribbonState, e.key as Key, currentBands);
		if (!res) return;
		e.preventDefault();
		applySelection(res.state);
		if (res.action === 'openDrill') {
			void tick().then(() => {
				document
					.getElementById('rbdrill')
					?.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
			});
		}
	}

	// ---- Pointer: select on `pointerup` only after < 8px of travel, no
	// pointer capture, and the native both-axis scroll behavior is left
	// entirely alone — a vertical swipe must scroll the page, never select a
	// cell (cs.md + CODEX1 P1-7). ----------------------------------------------
	let downAt: { x: number; y: number } | null = null;
	function onPointerDown(e: PointerEvent) {
		downAt = { x: e.clientX, y: e.clientY };
	}
	function onPointerUp(e: PointerEvent) {
		if (!downAt) return;
		const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
		downAt = null;
		if (moved >= 8) return;
		const svgEl = rscrollEl?.querySelector('svg');
		if (!svgEl) return;
		const r = svgEl.getBoundingClientRect();
		const next = pickCell(ribbonState, geom, e.clientX - r.left, e.clientY - r.top, phone, currentBands);
		if (next) applySelection(next);
	}
	function onPointerCancel() {
		downAt = null;
	}

	// ---- Scrub row + toolbar. ------------------------------------------------
	function prevMonth() {
		applySelection(setMonth(ribbonState, ribbonState.month === 1 ? 12 : ribbonState.month - 1));
	}
	function nextMonth() {
		applySelection(setMonth(ribbonState, (ribbonState.month % 12) + 1));
	}
	function onSlider(e: Event) {
		applySelection(setMonth(ribbonState, Number((e.currentTarget as HTMLInputElement).value)));
	}
	function selectWorldView() {
		applySelection({ ...ribbonState, viewTouched: true, view: 'world', cont: null });
	}
	function selectContView() {
		applySelection({
			...ribbonState,
			viewTouched: true,
			view: 'cont',
			cont: ribbonState.contView === 'ALL' ? (ribbonState.cont ?? HOME_COLUMN) : ribbonState.contView
		});
	}
	function onContSelect(e: Event) {
		const value = (e.currentTarget as HTMLSelectElement).value as 'ALL' | RibbonColumn;
		applySelection({
			...ribbonState,
			contView: value,
			cont: value === 'ALL' ? ribbonState.cont : value,
			drillExpanded: false
		});
		// drillNote/selectedRegionCode reset happens in the drill effect,
		// keyed on (speciesCode, band, cont) — CODEX1 P2-3.
	}
	function setWeight(weight: Weighting) {
		applySelection({ ...ribbonState, weight });
	}
	function scrollToDrill() {
		ribbonState = { ...ribbonState, drillOpen: true };
		void tick().then(() => {
			document.getElementById('rbdrill')?.scrollIntoView({
				block: 'start',
				behavior: reducedMotion ? 'auto' : 'smooth'
			});
		});
	}

	// ---- Drill fetch: AbortController + a request-generation guard so a
	// late response for a superseded cell never overwrites a newer one
	// (CODEX1 P2-4); cache per (band, column) key, cleared when the species
	// changes, bounded to 32 entries. ------------------------------------------
	const regionsCache = new Map<string, RibbonRegionsClient>();
	const fetchGeneration = new DrillGeneration();
	let drillRows = $state<RibbonRegionRowClient[]>([]);
	let drillTotal = $state(0);
	let drillCapped = $state(false);
	let drillError = $state<string | null>(null);
	let drillLoading = $state(false);
	let drillNote = $state('');
	let selectedRegionCode = $state<string | null>(null);

	$effect(() => {
		void speciesCode;
		regionsCache.clear();
	});

	$effect(() => {
		const species = speciesCode;
		const band = ribbonState.band;
		const cont = ribbonState.cont ?? 'ALL';
		// The drill identity changed: whatever was charted from a PREVIOUS
		// cell's rows no longer applies here (CODEX1 P2-3) — "Now charting…"
		// and the highlighted row must not survive a band/continent/species
		// change. The page already resets its own chartPeer on species
		// change; this clears the ribbon's own leftover feedback for every
		// identity change, species included.
		drillNote = '';
		selectedRegionCode = null;
		const key = drillCacheKey(band, cont);
		// `beginDrill` ALWAYS bumps the generation first, even on a cache
		// hit (CODEX1 P1-2) — otherwise an in-flight fetch for a PREVIOUS
		// cell could settle after this (possibly cached) one is already
		// shown and overwrite it under the wrong heading.
		const begin = beginDrill(key, regionsCache, fetchGeneration);
		if (begin.kind === 'cached') {
			drillRows = begin.regions.rows;
			drillTotal = begin.regions.total;
			drillCapped = begin.regions.capped;
			drillError = null;
			drillLoading = false;
			return;
		}
		const gen = begin.gen;
		const controller = new AbortController();
		drillLoading = true;
		drillError = null;
		(async () => {
			let aborted = false;
			let ok = false;
			let regions: RibbonRegionsClient | undefined;
			try {
				const url = `/api/species-ribbon-regions?species=${encodeURIComponent(species)}&band=${band}&cont=${encodeURIComponent(cont)}`;
				const res = await fetch(url, { signal: controller.signal });
				ok = res.ok;
				if (ok) regions = (await res.json()) as RibbonRegionsClient;
			} catch (err) {
				aborted = err instanceof DOMException && err.name === 'AbortError';
			}
			const result = resolveDrillLoad({ gen, generation: fetchGeneration, aborted, ok, regions });
			if (result.kind === 'ignore') return;
			drillLoading = false;
			if (result.kind === 'error') {
				drillError = result.message;
				drillRows = [];
				drillTotal = 0;
				drillCapped = false;
				return;
			}
			drillError = null;
			boundedCacheSet(regionsCache, key, result.regions);
			drillRows = result.regions.rows;
			drillTotal = result.regions.total;
			drillCapped = result.regions.capped;
		})();
		return () => controller.abort();
	});

	function onDrillRowClick(row: RibbonRegionRowClient) {
		selectedRegionCode = row.locCode;
		drillNote = `Now charting ${row.label} below`;
		onchartregion(row);
	}
</script>

<p class="sub" style="margin-bottom:6px">
	Share of eBird checklists reporting it, by latitude band and month. North at the top, so a
	diagonal sweep means the bird moves with the seasons and a flat band means it stays put.
</p>
<!-- Two variants driven by the same `phone` flag (CODEX1 P2-2): below
     640px a tap only ever picks a band (P1-1) — the month comes from the
     slider — so the hint must say that, not describe whole-cell picking. -->
{#if phone}
	<p class="sub hint" style="margin-bottom:10px">
		Choose a month with the slider, then tap a latitude row to see its reporting rate and the
		regions behind it; darker green means it was reported more often.
	</p>
{:else}
	<p class="sub hint" style="margin-bottom:10px">
		Tap a square to see that month's reporting rate and the regions behind it; darker green means
		it was reported more often.
	</p>
{/if}

{#if summary.hasData}
	<div class="mig-summary">
		<div class="mig-header">
			<span class="mig-badge">{summary.headline}</span>
			{#if summary.span}
				<span class="mig-timing">{summary.span}</span>
			{/if}
		</div>
		<p class="mig-details">{summary.details}</p>
	</div>
{/if}

<div class="rlayout">
	<div class="readout" id="rbreadout">
		<span class="r1">
			{currentReadout.line1}
			{#if currentReadout.landmark}
				<span class="rland">({currentReadout.landmark})</span>
			{/if}
		</span>
		<span class="r2">{currentReadout.line2}</span>
		{#if currentReadout.line3}
			<span class="r3" title={currentReadout.title3}>{currentReadout.line3}</span>
		{/if}
	</div>
	<span class="sr-only" aria-live="polite">{srAnnounce}</span>

	{#if showToDrill}
		<button type="button" class="btn todrill" onclick={scrollToDrill}>
			See the {currentReadout.nreg} region{currentReadout.nreg === 1 ? '' : 's'} behind this ↓
		</button>
	{/if}

	<div class="rmain">
		<div class="scrub">
			<div class="scrub-row">
				<button type="button" class="btn" aria-label="Previous month" onclick={prevMonth}>◀</button>
				<div class="range">
					<input
						type="range"
						min="1"
						max="12"
						step="1"
						value={ribbonState.month}
						aria-label="Month"
						oninput={onSlider}
					/>
				</div>
				<span class="mlabel">{MSHORT[ribbonState.month - 1]}</span>
				<button type="button" class="btn" aria-label="Next month" onclick={nextMonth}>▶</button>
			</div>
			<div class="scrub-play">
				{#if !reducedMotion}
					<button type="button" class="btn" aria-pressed={ribbonState.playing} onclick={togglePlay}>
						{ribbonState.playing ? '⏸ Pause' : '▶ Play the year'}
					</button>
				{:else}
					<span class="rm-note">Auto-play off (reduced motion); use ◀ ▶.</span>
				{/if}
			</div>
		</div>

		<div class="toolbar">
			<div>
				<span class="seg-label" id="rbviewLbl">View</span>
				<div class="seg" role="group" aria-labelledby="rbviewLbl">
					<button type="button" aria-pressed={ribbonState.view === 'world'} onclick={selectWorldView}
						>World</button
					>
					<button type="button" aria-pressed={ribbonState.view === 'cont'} onclick={selectContView}
						>By continent</button
					>
				</div>
			</div>
			{#if geom.cont}
				<div>
					<span class="seg-label" id="rbcpLbl">Continent</span>
					<select id="rbcontSel" aria-labelledby="rbcpLbl" value={ribbonState.contView} onchange={onContSelect}>
						<option value="ALL">All continents</option>
						{#each COLUMNS as col (col)}
							<option value={col}>{COLUMN_NAMES[col]}</option>
						{/each}
					</select>
				</div>
			{/if}
			<div>
				<span class="seg-label" id="rbrangeLbl">Latitudes</span>
				<div class="seg" role="group" aria-labelledby="rbrangeLbl">
					<button
						type="button"
						aria-pressed={!fullGlobe}
						onclick={() => {
							fullGlobe = false;
							ribbonState = { ...ribbonState, fullGlobe: false };
						}}>Species range</button
					>
					<button
						type="button"
						aria-pressed={fullGlobe}
						onclick={() => {
							fullGlobe = true;
							ribbonState = { ...ribbonState, fullGlobe: true };
						}}>Full globe</button
					>
				</div>
			</div>
			<div>
				<span class="seg-label" id="rbwLbl">Average</span>
				<div class="seg" role="group" aria-labelledby="rbwLbl">
					<button
						type="button"
						aria-pressed={ribbonState.weight === 'equal'}
						onclick={() => setWeight('equal')}>Equal weight</button
					>
					<button
						type="button"
						aria-pressed={ribbonState.weight === 'checklists'}
						onclick={() => setWeight('checklists')}>By checklists</button
					>
				</div>
			</div>
		</div>

		<!-- Composite widget (spec TD-C): role="group" + aria-roledescription make this a
		     keyboard-driven custom control (arrow keys/Home/End/Enter/Space via onkeydown), not a
		     static container — tabindex and the keydown handler are the point, not an oversight. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			class="ribbon"
			tabindex="0"
			role="group"
			aria-roledescription="migration ribbon"
			aria-describedby="rbreadout rbkeys"
			aria-labelledby="ribh"
			onkeydown={onRibbonKeydown}
		>
			<span id="rbkeys" class="sr-only"
				>Left and right arrows change month, up and down change latitude band, Page Up and Page
				Down change continent, Home and End jump to January and December, Enter opens the regions
				inside the selected cell, Space plays or pauses.</span
			>
			<div class="ribwrap" class:clipped>
				<div class="rgut" style="padding-top:{geom.headH + 4}px">
					{#each currentBands as band (band)}
						<div class="bl" class:on={band === ribbonState.band} style="height:{geom.rowH}px">
							<span class="b-deg">{bandLabel(band)}</span>
							{#if landmarkFor(band, gutterCol)}
								<span class="b-land">{landmarkFor(band, gutterCol)}</span>
							{/if}
						</div>
					{/each}
					{#if eqIndex > 0}
						<span class="eqmark" style="top:{geom.headH + 4 + eqIndex * geom.rowH}px">EQUATOR</span>
					{/if}
				</div>
				<!-- Pointer surface for the same composite widget (spec TD-C): selection fires on
				     pointerup after a movement threshold (cs.md + CODEX1 P1-7), so this needs the raw
				     pointer events rather than a native interactive element's click semantics. -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="rscroll"
					bind:this={rscrollEl}
					onpointerdown={onPointerDown}
					onpointerup={onPointerUp}
					onpointercancel={onPointerCancel}
				>
					<svg width={geom.w} height={geom.h} viewBox="0 0 {geom.w} {geom.h}" role="img" aria-label={currentAria}>
						<defs>
							<pattern id={hatchId} width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
								<rect width="6" height="6" fill="var(--accent-soft)" />
								<line x1="0" y1="0" x2="0" y2="6" stroke="var(--accent)" stroke-width="2" />
							</pattern>
						</defs>

						{#if geom.cont}
							{#each drawnCols as col, ci (col)}
								{@const x0 = ci * 12 * geom.cellW}
								{@const blockW = 12 * geom.cellW}
								{#if ci > 0}
									<line class="csep" x1={x0} y1="0" x2={x0} y2={geom.h} />
								{/if}
								<text class="ctext" x={x0 + blockW / 2} y="12" text-anchor="middle"
									>{blockW >= 92
										? blockW >= 200
											? COLUMN_NAMES[col]
											: COLUMN_NAMES[col].replace(', west of 100°W', ' W').replace(', east of 100°W', ' E')
										: col}</text
								>
								{#each ML as letter, m (m)}
									<text
										class="mtext"
										class:on={m + 1 === ribbonState.month}
										x={x0 + m * geom.cellW + geom.cellW / 2}
										y={geom.headH - 5}
										text-anchor="middle">{blockW >= 120 ? letter : m % 3 === 0 ? letter : ''}</text
									>
								{/each}
							{/each}
						{:else}
							{#each ML as letter, m (m)}
								<text
									class="mtext"
									class:on={m + 1 === ribbonState.month}
									x={m * geom.cellW + geom.cellW / 2}
									y={geom.headH - 6}
									text-anchor="middle">{letter}</text
								>
							{/each}
						{/if}

						{#each currentBands as band, bi (band)}
							{@const y = geom.headH + bi * geom.rowH}
							{@const origBi = BANDS.indexOf(band as (typeof BANDS)[number])}
							{#if geom.cont}
								{#each drawnCols as col, ci (col)}
									{@const colIdx = COLUMNS.indexOf(col)}
									{#each ML as _m, m (m)}
										{@const cell = grid.modes[ribbonState.weight].cols[origBi][colIdx][m]}
										{@const x = (ci * 12 + m) * geom.cellW}
										{@const fill = fillFor(cell, hatchId)}
										{#if fill === 'slash'}
											<rect
												x={x + 0.5}
												y={y + 0.5}
												width={Math.max(1, geom.cellW - 1)}
												height={Math.max(1, geom.rowH - 1)}
												fill="var(--card)"
											/>
											<line
												x1={x + 1.5}
												y1={y + geom.rowH - 2}
												x2={x + geom.cellW - 2}
												y2={y + 2}
												stroke="var(--rb-slash)"
												stroke-width="1.1"
											/>
										{:else}
											<rect
												{x}
												{y}
												width={Math.max(1, geom.cellW - 1)}
												height={Math.max(1, geom.rowH - 1)}
												fill={fill}
											/>
										{/if}
									{/each}
								{/each}
							{:else}
								{#each ML as _m, m (m)}
									{@const cell = grid.modes[ribbonState.weight].world[origBi][m]}
									{@const x = m * geom.cellW}
									{@const fill = fillFor(cell, hatchId)}
									{#if fill === 'slash'}
										<rect
											x={x + 0.5}
											y={y + 0.5}
											width={Math.max(1, geom.cellW - 1)}
											height={Math.max(1, geom.rowH - 1)}
											fill="var(--card)"
										/>
										<line
											x1={x + 1.5}
											y1={y + geom.rowH - 2}
											x2={x + geom.cellW - 2}
											y2={y + 2}
											stroke="var(--rb-slash)"
											stroke-width="1.1"
										/>
									{:else}
										<rect
											{x}
											{y}
											width={Math.max(1, geom.cellW - 1)}
											height={Math.max(1, geom.rowH - 1)}
											fill={fill}
										/>
									{/if}
								{/each}
							{/if}
						{/each}

						{#each monthOverlayXs as x0 (x0)}
							<rect
								x={x0}
								y={geom.headH}
								width={Math.max(1, geom.cellW - 1)}
								height={geom.h - geom.headH}
								fill="#212529"
								opacity="0.10"
								pointer-events="none"
							/>
						{/each}
						{#if bandOverlayY != null}
							<rect
								x="0.5"
								y={bandOverlayY - 0.5}
								width={geom.w - 1}
								height={geom.rowH}
								fill="none"
								stroke="#212529"
								stroke-width="1"
								pointer-events="none"
							/>
						{/if}
						{#if bandOverlayY != null && cellOverlayX != null}
							<rect
								x={cellOverlayX - 1}
								y={bandOverlayY - 1}
								width={geom.cellW + 1}
								height={geom.rowH + 1}
								fill="none"
								stroke="#212529"
								stroke-width="2.5"
								pointer-events="none"
							/>
						{/if}
						{#if eqIndex > 0}
							{@const ey = geom.headH + eqIndex * geom.rowH}
							<line x1="0" y1={ey} x2={geom.w} y2={ey} stroke="#495057" stroke-width="1" stroke-dasharray="4 3" />
						{/if}
					</svg>
				</div>
			</div>
		</div>

		<details class="how" open={wide}>
			<summary>How these numbers are calculated</summary>
			<p class="peer-scope" id="rbscope">{currentScope}</p>
			{#if grid.meta.unmappedCountries.length > 0}
				<p class="muted">
					Data omitted for {grid.meta.unmappedCountries.length} countries not yet assigned to a
					continent: {grid.meta.unmappedCountries.join(', ')}.
				</p>
			{/if}
		</details>
		{#if currentGap}
			<p class="gapnote"><strong>{currentGap.window}:</strong> {currentGap.text}</p>
		{/if}
		<p class="muted" style="margin:0">Data from <a href="https://ebird.org">eBird.org</a>.</p>
	</div>

	<div class="legend" aria-label="Legend">
		{#each BINS as bin, i (bin.label)}
			<span class="l"><span class="sw" style="background: var(--rb-{i})"></span>{bin.label}</span>
		{/each}
		<span class="l"><span class="sw hatch"></span>small sample (under {LOW_N} checklists)</span>
		<span class="l"><span class="sw nodata"></span>no data (nothing loaded here)</span>
	</div>

	<div class="drill" id="rbdrill">
		<details class="drilld" bind:open={ribbonState.drillOpen}>
			<summary>
				<h3>{drillHeading(ribbonState)}</h3>
				<span class="dcount">{drillTotal} region{drillTotal === 1 ? '' : 's'}</span>
			</summary>
			{#if drillError}
				<p class="dsub">{drillError}</p>
			{:else}
				<p class="dsub">
					{drillCapped ? 'The 40 with the highest peak shown, ' : ''}Jan to Dec, sorted by peak. Tap
					a region to chart its full year in "Best time of year" below.
				</p>
				<p class="dnote" aria-live="polite">{drillNote}</p>
				{#if drillLoading}
					<p class="dsub">Loading…</p>
				{:else if drillRows.length === 0}
					<p class="dsub">
						No regions loaded in this band{ribbonState.cont ? ` for ${COLUMN_NAMES[ribbonState.cont]}` : ''} yet.
					</p>
				{:else}
					{#each (ribbonState.drillExpanded ? drillRows : drillRows.slice(0, 8)) as row (row.locCode)}
						<button
							type="button"
							class="drow"
							class:on={row.locCode === selectedRegionCode}
							onclick={() => onDrillRowClick(row)}
						>
							<span class="dn">{row.label}</span>
							<svg viewBox="0 0 240 14" preserveAspectRatio="none" aria-hidden="true">
								{#each row.curve as c, m (m)}
									{@const cw = 240 / 12}
									{@const x = m * cw}
									{#if c.n === 0}
										<rect x={x + 0.5} y="0.5" width={cw - 1} height="13" fill="var(--card)" stroke="var(--rb-slash)" stroke-dasharray="2 2" />
									{:else}
										<rect {x} y="0" width={cw - 1} height="14" fill="var(--rb-{binIndex(c.freq)})" />
									{/if}
								{/each}
							</svg>
							<span class="dp">{pct(row.peak)}</span>
						</button>
					{/each}
					{#if drillRows.length > 8 && !ribbonState.drillExpanded}
						<button type="button" class="btn more" onclick={() => (ribbonState.drillExpanded = true)}>
							Show all {drillRows.length}{drillCapped ? ` (of ${drillTotal})` : ''}
						</button>
					{/if}
				{/if}
			{/if}
		</details>
	</div>
</div>

<style>
	.mig-summary {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 14px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
		margin-bottom: 12px;
	}
	.mig-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		flex-wrap: wrap;
	}
	.mig-badge {
		display: inline-flex;
		align-items: center;
		padding: 3px 8px;
		border-radius: 4px;
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		background: var(--accent-soft);
		color: var(--accent);
		border: 1px solid var(--accent);
	}
	.mig-timing {
		font-size: 0.82rem;
		color: var(--muted);
		font-weight: 500;
	}
	.mig-details {
		margin: 0;
		font-size: 0.92rem;
		line-height: 1.4;
		color: var(--text);
	}

	.rlayout {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.rmain {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
	}
	.readout {
		min-height: 48px;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: stretch;
		padding: 8px 12px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		font-size: 0.95rem;
	}
	.readout .r1 {
		display: block;
		font-weight: 700;
	}
	.readout .rland {
		font-weight: 400;
		color: var(--accent);
		margin-left: 4px;
	}
	.readout .r2 {
		display: block;
	}
	.readout .r3 {
		display: block;
		color: var(--muted);
		font-size: 0.85rem;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	.scrub {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.scrub-row {
		display: grid;
		grid-template-columns: 48px minmax(0, 1fr) auto 48px;
		gap: 8px;
		align-items: center;
	}
	.btn {
		min-height: 48px;
		min-width: 48px;
		padding: 0 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
		color: var(--text);
		font-weight: 600;
		cursor: pointer;
	}
	.range {
		display: flex;
		align-items: center;
		min-height: 48px;
		min-width: 0;
	}
	input[type='range'] {
		width: 100%;
		height: 48px;
		margin: 0;
		accent-color: var(--accent);
	}
	.mlabel {
		min-width: 2.6em;
		font-weight: 700;
		text-align: center;
	}
	.scrub-play {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.rm-note {
		color: var(--muted);
		font-size: 0.83rem;
	}

	.toolbar {
		display: flex;
		align-items: flex-end;
		gap: 12px;
		flex-wrap: wrap;
	}
	.seg-label {
		display: block;
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--muted);
		margin-bottom: 2px;
	}
	.seg {
		display: inline-flex;
		flex-wrap: wrap;
		max-width: 100%;
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
	}
	.seg button {
		flex: 1 1 auto;
		min-height: 48px;
		min-width: 60px;
		padding: 8px 14px;
		border: none;
		background: var(--card);
		color: var(--text);
		font-weight: 600;
		cursor: pointer;
	}
	.seg button + button {
		border-left: 1px solid var(--border);
	}
	.seg button[aria-pressed='true'] {
		background: var(--accent);
		color: #fff;
	}
	select {
		min-height: 48px;
		max-width: 100%;
		padding: 0 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
		color: var(--text);
		font-size: 1rem;
	}

	.ribbon {
		outline: none;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
	}
	.ribbon:focus-visible {
		box-shadow:
			0 0 0 3px var(--accent-soft),
			0 0 0 5px var(--accent);
	}
	.ribwrap {
		display: flex;
		align-items: flex-start;
		position: relative;
	}
	.rgut {
		flex: 0 0 auto;
		padding: 4px 0 4px 6px;
		position: relative;
	}
	.rgut .bl {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		justify-content: center;
		padding-right: 6px;
		color: var(--muted);
		white-space: nowrap;
		line-height: 1.05;
	}
	.rgut .bl .b-deg {
		font-size: 0.68rem;
		line-height: 1.1;
	}
	.rgut .bl .b-land {
		display: none;
	}
	.rgut .bl.on .b-deg {
		color: var(--text);
		font-weight: 700;
	}
	.rgut .eqmark {
		position: absolute;
		left: 0;
		right: 4px;
		text-align: right;
		font-size: 0.55rem;
		font-weight: 700;
		line-height: 1;
		color: var(--muted);
		background: var(--card);
		transform: translateY(-50%);
	}
	.rscroll {
		flex: 1 1 auto;
		overflow-x: auto;
		overflow-y: hidden;
		padding: 4px 6px 4px 0;
	}
	.ribwrap.clipped::after {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: 24px;
		pointer-events: none;
		background: linear-gradient(to right, rgba(255, 255, 255, 0), var(--card));
	}
	.ribwrap.clipped .rscroll {
		scrollbar-width: thin;
	}
	.rscroll svg {
		display: block;
	}
	.rscroll :global(.mtext) {
		fill: var(--muted);
		font-size: 11px;
		font-weight: 600;
	}
	.rscroll :global(.mtext.on) {
		fill: var(--text);
		font-weight: 800;
		text-decoration: underline;
	}
	.rscroll :global(.ctext) {
		fill: var(--text);
		font-size: 11px;
		font-weight: 700;
	}
	.rscroll :global(.csep) {
		stroke: var(--border);
		stroke-width: 1;
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 12px;
		font-size: 0.8rem;
		color: var(--muted);
	}
	.legend .l {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-height: 24px;
	}
	.legend .sw {
		width: 18px;
		height: 12px;
		border: 1px solid var(--border);
		display: inline-block;
	}
	.legend .sw.hatch {
		background: repeating-linear-gradient(45deg, var(--accent-soft) 0 2px, var(--accent) 2px 3px);
	}
	.legend .sw.nodata {
		border: 1px solid var(--border);
		background:
			linear-gradient(
					to top right,
					transparent calc(50% - 0.8px),
					var(--rb-slash) calc(50% - 0.8px),
					var(--rb-slash) calc(50% + 0.8px),
					transparent calc(50% + 0.8px)
				)
				var(--card);
	}

	.peer-scope {
		color: var(--muted);
		font-size: 0.85rem;
		margin: 0;
	}
	.how summary {
		min-height: 48px;
		display: flex;
		align-items: center;
		cursor: pointer;
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--muted);
	}
	.how[open] summary {
		margin-bottom: 4px;
	}
	.todrill {
		min-height: 48px;
		width: 100%;
		text-align: left;
		padding: 0 12px;
	}
	@media (min-width: 640px) {
		.todrill {
			display: none;
		}
		.rgut .bl .b-land {
			display: block;
			font-size: 0.54rem;
			line-height: 1.05;
			color: var(--muted);
			max-width: 130px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.rgut .bl.on .b-land {
			color: var(--accent);
			font-weight: 600;
		}
	}
	.gapnote {
		margin: 0;
		font-size: 0.9rem;
	}
	.gapnote strong {
		color: var(--accent);
	}

	.drill {
		border-top: 1px solid var(--border);
		margin-top: 4px;
		padding-top: 10px;
	}
	.drill .more {
		min-height: 48px;
		width: 100%;
		margin-top: 6px;
	}
	.drill .dnote {
		color: var(--accent);
		font-size: 0.9rem;
		font-weight: 600;
		min-height: 1.4em;
		margin: 4px 0 0;
	}
	.drill h3 {
		font-size: 0.95rem;
		margin: 0;
		display: inline;
	}
	.drilld summary {
		min-height: 48px;
		display: flex;
		align-items: center;
		gap: 10px;
		cursor: pointer;
		list-style: none;
	}
	.drilld summary::-webkit-details-marker {
		display: none;
	}
	.drilld summary::before {
		content: '▸';
		color: var(--muted);
		width: 1em;
	}
	.drilld[open] summary::before {
		content: '▾';
	}
	.drilld summary .dcount {
		color: var(--muted);
		font-size: 0.85rem;
		margin-left: auto;
	}
	.drill .dsub {
		color: var(--muted);
		font-size: 0.83rem;
		margin-bottom: 8px;
	}
	.drow {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 48px;
		padding: 4px 6px;
		border: none;
		border-top: 1px solid var(--border);
		background: none;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}
	.drow:hover {
		background: var(--bg);
	}
	.drow.on {
		background: var(--accent-soft);
	}
	.drow .dn {
		flex: 0 0 34%;
		min-width: 0;
		font-size: 0.85rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.drow svg {
		flex: 1 1 auto;
		height: 14px;
	}
	.drow .dp {
		flex: 0 0 auto;
		font-size: 0.8rem;
		font-weight: 700;
		color: var(--accent);
		min-width: 3.2em;
		text-align: right;
	}

	.muted {
		color: var(--muted);
		font-size: 0.89rem;
	}
	.sub {
		color: var(--muted);
		margin: 0 0 8px;
	}
	.sub.hint {
		font-size: 0.9rem;
	}

	/* Colour tokens (build spec): --rb-5 IS --accent, so the darkest bin and
	   the app's accent are always the same green. Slash colour sits on white
	   at 4.69:1 (mockup verified). Declared once on the top-level layout and
	   inherited by every descendant that reads them (.ribwrap, .legend,
	   .drill, .drow). */
	.rlayout {
		--rb-0: #eceff1;
		--rb-1: #cfe9dc;
		--rb-2: #9fd0b8;
		--rb-3: #63ad8b;
		--rb-4: #2f855f;
		--rb-5: var(--accent);
		--rb-slash: #6c757d;
	}

	/* Phone: chart first, right after the scrubber; view/average toggles and
	   the legend follow (mockup CODEX1 P2-1, unchanged reasoning — feedback
	   for a tap must land where the thumb is). Two breakpoints only, per
	   cs.md; native scroll behavior is never restricted, so a vertical swipe
	   always scrolls the page. */
	@media (max-width: 639px) {
		.rmain {
			display: contents;
		}
		.rlayout > .rmain > .scrub {
			order: 1;
		}
		.rlayout > .rmain > .ribbon {
			order: 2;
		}
		.rlayout > .readout {
			order: 3;
			/* CC1 P2 (Safari drive of bbc9426, 390x731): 18 bands at the phone's
			   48px touch row make the World chart 20 + 18*48 = 884px tall, so
			   the readout (in normal flow, order 3, below the chart) sat ~800px
			   below the viewport after a tap -- a real user saw nothing change,
			   failing "readout visible after a tap on a phone". Pin it to the
			   bottom of the viewport, above the bottom nav, while the chart
			   scrolls; it returns to normal flow once the page scrolls past it.
			   CODEX1 re-check: `--nav-h` (56px) is the TOP nav; the fixed
			   phone nav is `.bottom-nav` (+layout.svelte), sized by
			   `--bottomnav-h` (64px, app.css) plus its own safe-area padding
			   and z-index 1000 -- using the wrong token left the readout's
			   bottom 8px behind the bottom nav. `--bottomnav-h` is the
			   correct clearance. */
			position: sticky;
			bottom: calc(var(--bottomnav-h) + env(safe-area-inset-bottom, 0px));
			z-index: 2;
			background: var(--card);
			box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.06);
		}
		.rlayout > .todrill {
			order: 4;
		}
		.rlayout > .rmain > .toolbar {
			order: 5;
		}
		.rlayout > .rmain > .gapnote {
			order: 6;
		}
		.rlayout > .rmain > .how {
			order: 7;
		}
		.rlayout > .rmain > .muted {
			order: 8;
		}
		.rlayout > .legend {
			order: 9;
		}
		.rlayout > .drill {
			order: 10;
		}
		.seg button {
			padding: 8px 10px;
		}
		.readout {
			font-size: 0.9rem;
			line-height: 1.4;
		}
	}

	@media (min-width: 1024px) {
		.rlayout {
			display: grid;
			grid-template-columns: minmax(0, 1fr) 330px;
			gap: 12px 16px;
			align-items: start;
		}
		.rlayout > .rmain {
			grid-column: 1;
			grid-row: 1;
		}
		.rlayout > .drill {
			grid-column: 1;
			grid-row: 2;
		}
		.rlayout > .readout {
			grid-column: 2;
			grid-row: 1;
			position: sticky;
			top: calc(var(--nav-h) + 12px);
			align-self: start;
		}
		.rlayout > .legend {
			grid-column: 2;
			grid-row: 2;
			align-self: start;
		}
	}
</style>
