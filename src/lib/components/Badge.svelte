<script lang="ts">
	let {
		kind,
		label
	}: { kind: 'need' | 'seen' | 'notable' | 'unmatched' | 'stale'; label: string } = $props();
</script>

<span class="badge {kind}">{label}</span>

<style>
	/* Status = color + text label, never color alone (cs.md). */
	.badge {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 6px;
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		vertical-align: middle;
	}
	.need {
		background: var(--need-bg);
		color: var(--need-text);
	}
	.seen {
		background: var(--seen-bg);
		color: var(--seen-text);
	}
	.notable,
	.unmatched {
		background: var(--notable-bg);
		color: var(--notable-text);
	}
	.stale {
		background: var(--need-bg);
		color: var(--need-text);
	}
</style>
