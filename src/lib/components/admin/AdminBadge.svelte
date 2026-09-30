<script lang="ts">
	/**
	 * Admin status badge (the /admin `.badge[data-color]` look, shared so the
	 * Tags tab and tag pages match it). Status = color + text, never color alone.
	 */
	let { tone = 'neutral', label }: { tone?: 'ok' | 'warn' | 'error' | 'neutral'; label: string } = $props();
</script>

<span class="badge" data-tone={tone}>{label}</span>

<style>
	.badge {
		display: inline-block;
		font-size: 0.75rem;
		font-weight: 700;
		border-radius: 6px;
		padding: 2px 8px;
		background: var(--bg);
		color: var(--muted);
		white-space: nowrap;
	}
	.badge[data-tone='ok'] {
		background: var(--accent-soft);
		color: var(--accent);
	}
	.badge[data-tone='warn'] {
		background: var(--need-bg);
		color: var(--need-text);
	}
	.badge[data-tone='error'] {
		background: var(--danger-soft);
		color: var(--danger);
	}
</style>
