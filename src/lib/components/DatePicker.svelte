<script lang="ts">
	import { untrack } from 'svelte';

	// Click-only calendar date picker (ported from the trips app). The visible
	// trigger is read-only and the only way to set a value is tapping a day, so a
	// partial/invalid date can't be entered. The chosen value is carried to the
	// surrounding form via a hidden input named `name`, formatted as the
	// YYYY-MM-DD that the trip create/update actions expect.
	let {
		name,
		value = null,
		placeholder = 'Select a date'
	}: { name: string; value?: string | null; placeholder?: string } = $props();

	const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

	function parseYMD(s: string): { y: number; m: number; d: number } | null {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
		if (!m) return null;
		return { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) };
	}
	const pad = (n: number) => String(n).padStart(2, '0');
	const toYMD = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

	// Seed internal state from the prop ONCE (the picker owns the value after mount).
	const initial = untrack(() => value) ?? '';

	let selected = $state(initial);
	let open = $state(false);
	let root = $state<HTMLDivElement | null>(null);

	const now = new Date();
	const today = toYMD(now.getFullYear(), now.getMonth(), now.getDate());

	// Month being viewed in the grid: the selected date's month, else today's.
	const startView = parseYMD(initial) ?? {
		y: now.getFullYear(),
		m: now.getMonth(),
		d: now.getDate()
	};
	let viewYear = $state(startView.y);
	let viewMonth = $state(startView.m); // 0-11

	const display = $derived.by(() => {
		const p = parseYMD(selected);
		if (!p) return '';
		return new Date(p.y, p.m, p.d).toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	});

	const monthLabel = $derived(
		new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, {
			month: 'long',
			year: 'numeric'
		})
	);

	// Calendar cells: leading nulls for the first-of-month weekday offset, then days.
	const cells = $derived.by(() => {
		const startDow = new Date(viewYear, viewMonth, 1).getDay();
		const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
		const out: (number | null)[] = [];
		for (let i = 0; i < startDow; i++) out.push(null);
		for (let d = 1; d <= daysInMonth; d++) out.push(d);
		return out;
	});

	function prevMonth() {
		if (viewMonth === 0) {
			viewMonth = 11;
			viewYear -= 1;
		} else {
			viewMonth -= 1;
		}
	}
	function nextMonth() {
		if (viewMonth === 11) {
			viewMonth = 0;
			viewYear += 1;
		} else {
			viewMonth += 1;
		}
	}
	function pick(d: number) {
		selected = toYMD(viewYear, viewMonth, d);
		open = false;
	}
	function clear() {
		selected = '';
		open = false;
	}
	function toggle() {
		// Re-center the view on the current selection each time it opens.
		if (!open) {
			const p = parseYMD(selected);
			if (p) {
				viewYear = p.y;
				viewMonth = p.m;
			}
		}
		open = !open;
	}

	function onWindowClick(e: MouseEvent) {
		if (open && root && !root.contains(e.target as Node)) open = false;
	}
	function onWindowKey(e: KeyboardEvent) {
		if (open && e.key === 'Escape') open = false;
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKey} />

<div class="dp" bind:this={root}>
	<input type="hidden" {name} value={selected} />
	<button
		type="button"
		class="trigger"
		class:empty={!selected}
		aria-haspopup="dialog"
		aria-expanded={open}
		onclick={toggle}
	>
		<span>{display || placeholder}</span>
		<span class="cal" aria-hidden="true">📅</span>
	</button>

	{#if open}
		<div class="pop" role="dialog" aria-label="Choose a date">
			<div class="nav">
				<button type="button" onclick={prevMonth} aria-label="Previous month">‹</button>
				<strong>{monthLabel}</strong>
				<button type="button" onclick={nextMonth} aria-label="Next month">›</button>
			</div>
			<div class="grid head">
				{#each WEEKDAYS as w (w)}<span class="dow">{w}</span>{/each}
			</div>
			<div class="grid">
				{#each cells as d, i (i)}
					{#if d === null}
						<span class="blank"></span>
					{:else}
						{@const ymd = toYMD(viewYear, viewMonth, d)}
						<button
							type="button"
							class="day"
							class:selected={ymd === selected}
							class:today={ymd === today}
							aria-pressed={ymd === selected}
							onclick={() => pick(d)}>{d}</button
						>
					{/if}
				{/each}
			</div>
			<div class="foot">
				<button type="button" class="clear" onclick={clear}>Clear</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.dp {
		position: relative;
	}
	.trigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		min-height: 48px;
		padding: 0 12px;
		font-size: 16px;
		text-align: left;
		background: var(--card);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 6px;
		cursor: pointer;
	}
	.trigger.empty span:first-child {
		color: var(--muted);
	}
	.cal {
		font-size: 1.1em;
	}
	.pop {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: 100;
		width: 280px;
		max-width: calc(100vw - 32px);
		padding: 12px;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 6px 24px rgba(33, 37, 41, 0.18);
	}
	.nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
	}
	.nav button {
		min-width: 40px;
		min-height: 40px;
		font-size: 1.3rem;
		line-height: 1;
		background: transparent;
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 6px;
		cursor: pointer;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 2px;
	}
	.grid.head {
		margin-bottom: 4px;
	}
	.dow {
		text-align: center;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--muted);
		padding: 2px 0;
	}
	.blank {
		aspect-ratio: 1;
	}
	.day {
		aspect-ratio: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.95rem;
		background: transparent;
		color: var(--text);
		border: 1px solid transparent;
		border-radius: 6px;
		cursor: pointer;
	}
	.day:hover {
		background: var(--bg);
	}
	.day.today {
		border-color: var(--border);
		font-weight: 700;
	}
	.day.selected {
		background: var(--accent);
		color: #fff;
		font-weight: 700;
	}
	.foot {
		display: flex;
		justify-content: flex-end;
		margin-top: 8px;
	}
	.clear {
		min-height: 36px;
		padding: 0 12px;
		font-size: 0.85rem;
		background: transparent;
		color: var(--muted);
		border: 1px solid var(--border);
		border-radius: 6px;
		cursor: pointer;
	}
</style>
