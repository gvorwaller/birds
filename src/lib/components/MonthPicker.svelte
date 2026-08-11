<script lang="ts">
	/**
	 * 12-button month grid for GET forms (modeled on DatePicker's month grid).
	 * Each button submits `name=month value=1..12`, so picking a month is a
	 * plain form navigation — no JS required, no hidden state.
	 */
	let {
		value,
		name = 'month'
	}: {
		/** Currently selected month, 1-12. */
		value: number;
		name?: string;
	} = $props();

	const MONTHS = [
		'Jan',
		'Feb',
		'Mar',
		'Apr',
		'May',
		'Jun',
		'Jul',
		'Aug',
		'Sep',
		'Oct',
		'Nov',
		'Dec'
	];
</script>

<div class="months" role="group" aria-label="Month">
	{#each MONTHS as label, i (label)}
		{@const m = i + 1}
		<button type="submit" {name} value={m} class:active={m === value} aria-pressed={m === value}>
			{label}
		</button>
	{/each}
</div>

<style>
	.months {
		display: grid;
		grid-template-columns: repeat(6, 1fr);
		gap: 6px;
	}
	button {
		min-height: 48px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
		color: var(--text);
		font-size: 0.95rem;
		cursor: pointer;
		padding: 8px 0;
	}
	button:hover {
		background: var(--bg);
	}
	button.active {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
		font-weight: 600;
	}
	@media (min-width: 640px) {
		.months {
			grid-template-columns: repeat(12, 1fr);
		}
	}
</style>
