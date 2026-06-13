<div class="page">
	<header class="page-head">
		<h1>Trips</h1>
		<p class="sub">Trip planning lands in Phase 2.</p>
	</header>
	<section class="card">
		<p class="muted">
			The schema is already in place (trips + stops). Coming next: create a trip, add hotspots or
			custom pins, per-stop notes, and "how many of my needs were reported here this week".
		</p>
	</section>
</div>

<style>
	.page {
		max-width: 1100px;
		margin: 0 auto;
		padding: 16px;
	}
	.page-head {
		margin: 4px 0 16px;
	}
	h1 {
		font-size: 1.4rem;
	}
	.sub,
	.muted {
		color: var(--muted);
		font-size: 0.89rem;
	}
	.card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 16px;
	}
	@media (min-width: 640px) {
		.page {
			padding: 24px;
		}
		h1 {
			font-size: 1.6rem;
		}
	}
</style>
