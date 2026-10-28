<script lang="ts">
	/**
	 * The most active birders in a place (td-eec7db Phase 3/4): ranked as the
	 * connector stored them, days out first. Shared by Hotspots & data and
	 * the "Where and when to look" view.
	 */
	import type { ExternalObserver } from '$server/external-sources/reports';

	let { observers, sourceName }: { observers: ExternalObserver[]; sourceName: string } = $props();
</script>

<p class="muted small">
	Ranked by days with reports, then species. A report is one species at one place on one day, so a busy birder has
	thousands. Names are public on {sourceName}.
</p>
<div class="tablewrap">
	<table>
		<thead>
			<tr>
				<th scope="col">Birder</th>
				<th scope="col" class="num">Days</th>
				<th scope="col" class="num">Species</th>
				<th scope="col" class="num">Places</th>
				<th scope="col" class="num">Reports</th>
			</tr>
		</thead>
		<tbody>
			{#each observers as o (o.rank)}
				<tr>
					<td>{o.observer}</td>
					<td class="num">{o.days.toLocaleString('en-US')}</td>
					<td class="num">{o.species.toLocaleString('en-US')}</td>
					<td class="num">{o.localities.toLocaleString('en-US')}</td>
					<td class="num">{o.reports.toLocaleString('en-US')}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.82rem;
	}
	.tablewrap {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.88rem;
	}
	th {
		text-align: left;
		color: var(--muted);
		font-weight: 600;
		font-size: 0.8rem;
		padding: 6px 8px 6px 0;
		border-bottom: 1px solid var(--border);
	}
	td {
		padding: 6px 8px 6px 0;
		border-bottom: 1px solid var(--border);
	}
	tr:last-child td {
		border-bottom: none;
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
</style>
