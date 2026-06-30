<script lang="ts">
	// Reference help — a single-open accordion. "Plan a trip" is the showcase
	// feature (it does a lot that isn't obvious), so it opens by default.
	let open = $state('plan');

	function toggle(id: string) {
		open = open === id ? '' : id;
	}
</script>

<svelte:head>
	<title>Help — birds</title>
</svelte:head>

<div class="page">
	<header class="page-head">
		<h1>Help</h1>
		<p class="sub">
			A quick reference for getting around. Tap a section to expand it.
		</p>
	</header>

	<div class="sections">
		<!-- Plan a trip (the showcase) -->
		<button
			class="toggle"
			class:open={open === 'plan'}
			aria-expanded={open === 'plan'}
			onclick={() => toggle('plan')}
		>
			<span class="ico">🗺️</span>
			<span class="title">Plan a trip</span>
			<span class="chev">{open === 'plan' ? '▾' : '▸'}</span>
		</button>
		{#if open === 'plan'}
			<div class="body">
				<p class="lead">
					The trip planner is the heart of the app. Give it a place and a few
					filters and it finds nearby eBird hotspots that have <em
						>the birds you still need</em
					>, ranks them, and builds a driving route — all editable before you
					save.
				</p>
				<h3>1. Pick where to search</h3>
				<ul>
					<li>
						<strong>Near</strong> — type a city, county, park, or address. If you
						leave it blank, the planner uses your saved home location (set it in
						Settings).
					</li>
					<li>
						<strong>📍 Pick on map</strong> — tap the button to open a map, then
						tap anywhere (or drag the pin) to drop your start point on an exact
						spot — handier than typing a place name. Press <strong>Plan</strong> when
						the pin is where you want it.
					</li>
				</ul>
				<h3>2. Tune the search</h3>
				<ul>
					<li><strong>Radius</strong> — how far out to look (5–25 miles).</li>
					<li>
						<strong>Window</strong> — how recently a bird had to be reported
						(last 24 hours, 7 days, 14 days, or 30 days).
					</li>
					<li><strong>Stops</strong> — how many hotspots to aim for.</li>
					<li>
						<strong>Min needs/stop</strong> — only suggest a hotspot if it has at
						least this many of your needs. Raise it to be picky, lower it to see
						more options.
					</li>
					<li>
						<strong>Count</strong> — “My needs” (species not yet on your life
						list) or “All species”.
					</li>
					<li>
						<strong>Rare only</strong> — restrict to species flagged notable/rare
						by eBird.
					</li>
					<li>
						<strong>Add a historical stop</strong> — toss a nearby point of
						interest (a landmark or museum) into the route for a non-birding
						break.
					</li>
				</ul>
				<h3>3. Curate the route</h3>
				<ul>
					<li>
						Every matching hotspot in range is listed, ranked by how many of your
						needs were reported there. <strong>Add</strong> or
						<strong>Remove</strong> any of them — there's no cap, build the trip you
						want.
					</li>
					<li>
						The map and the “distinct needs across the route” summary update live
						as you curate, and the stops are ordered into an efficient route from
						your start point.
					</li>
					<li>
						Each stop shows which of your needs were reported, when, and the
						hotspot's all-time species count and last report date.
					</li>
				</ul>
				<h3>4. Extras on the saved trip</h3>
				<ul>
					<li>
						<strong>Weather</strong> — a short forecast for the trip area (US
						only).
					</li>
					<li>
						<strong>Field tips</strong> — an optional, AI-generated note per stop
						tying your target species to the season and weather. Treat it as a
						hint to verify in the field, not gospel.
					</li>
					<li>
						<strong>Save trip</strong> — give it a name and it's stored under
						Trips, where you can revisit, export, or get driving directions.
					</li>
				</ul>
			</div>
		{/if}

		<!-- Targets -->
		<button
			class="toggle"
			class:open={open === 'targets'}
			aria-expanded={open === 'targets'}
			onclick={() => toggle('targets')}
		>
			<span class="ico">🔭</span>
			<span class="title">Targets &amp; your needs</span>
			<span class="chev">{open === 'targets' ? '▾' : '▸'}</span>
		</button>
		{#if open === 'targets'}
			<div class="body">
				<ul>
					<li>
						<strong>Targets</strong> shows species you still need, based on what's
						being reported near a place or region you choose.
					</li>
					<li>
						“Needs” are species not yet on your life list. The app learns your
						life list from your eBird account (add your API key in Settings).
					</li>
					<li>
						Tap any species to open its page — recent nearby sightings, a map,
						and your photos of it (if you have a photo gallery configured).
					</li>
				</ul>
			</div>
		{/if}

		<!-- Trips -->
		<button
			class="toggle"
			class:open={open === 'trips'}
			aria-expanded={open === 'trips'}
			onclick={() => toggle('trips')}
		>
			<span class="ico">🧭</span>
			<span class="title">Saved trips</span>
			<span class="chev">{open === 'trips' ? '▾' : '▸'}</span>
		</button>
		{#if open === 'trips'}
			<div class="body">
				<ul>
					<li>
						<strong>Trips</strong> lists everything you've saved from the planner.
						Open one to see its stops, map, weather, and field tips.
					</li>
					<li>
						<strong>Directions</strong> — a link opens the full route in Google
						Maps for turn-by-turn navigation.
					</li>
					<li>
						<strong>Export</strong> — download the trip as a Markdown file to keep
						or share.
					</li>
				</ul>
			</div>
		{/if}

		<!-- Photos -->
		<button
			class="toggle"
			class:open={open === 'photos'}
			aria-expanded={open === 'photos'}
			onclick={() => toggle('photos')}
		>
			<span class="ico">📷</span>
			<span class="title">Photos</span>
			<span class="chev">{open === 'photos' ? '▾' : '▸'}</span>
		</button>
		{#if open === 'photos'}
			<div class="body">
				<ul>
					<li>
						If your account has a photo gallery configured, the <strong>Photos</strong>
						tab and per-species photo strips show your own bird shots, matched to
						species.
					</li>
					<li>
						Not every account has a gallery — if yours doesn't, the Photos tab
						simply won't appear, and that's expected.
					</li>
				</ul>
			</div>
		{/if}

		<!-- Settings -->
		<button
			class="toggle"
			class:open={open === 'settings'}
			aria-expanded={open === 'settings'}
			onclick={() => toggle('settings')}
		>
			<span class="ico">⚙️</span>
			<span class="title">Settings</span>
			<span class="chev">{open === 'settings' ? '▾' : '▸'}</span>
		</button>
		{#if open === 'settings'}
			<div class="body">
				<ul>
					<li>
						<strong>eBird API key</strong> — connects the app to your eBird
						account so it knows your life list and can pull recent sightings. Get
						a free key from eBird and paste it here.
					</li>
					<li>
						<strong>Home location</strong> — set it once and the planner and
						targets default to your home area when you don't specify a place.
					</li>
					<li>
						Read-only family accounts don't see Settings — they're along for the
						ride on someone else's data.
					</li>
				</ul>
			</div>
		{/if}

		<!-- Maps & tips -->
		<button
			class="toggle"
			class:open={open === 'maps'}
			aria-expanded={open === 'maps'}
			onclick={() => toggle('maps')}
		>
			<span class="ico">🛰️</span>
			<span class="title">Map tips</span>
			<span class="chev">{open === 'maps' ? '▾' : '▸'}</span>
		</button>
		{#if open === 'maps'}
			<div class="body">
				<ul>
					<li>
						<strong>🛰 Satellite / 🗺 Map</strong> — the toggle on any map flips
						between the road map and a satellite/hybrid view.
					</li>
					<li>
						<strong>Pick on map</strong> — on the planner, tap the map to set your
						start point precisely (see “Plan a trip” above).
					</li>
					<li>
						<strong>Map links</strong> — the little map icons next to a stop or
						sighting open that exact point in Google Maps.
					</li>
				</ul>
			</div>
		{/if}
	</div>

	<p class="foot">
		Bird data from <a href="https://ebird.org" target="_blank" rel="noopener"
			>eBird.org</a
		>. Questions or ideas? Just ask Gaylon.
	</p>
</div>

<style>
	.page {
		max-width: 760px;
		margin: 0 auto;
		padding: 16px;
	}
	.page-head {
		margin: 4px 0 16px;
	}
	h1 {
		font-size: 1.4rem;
	}
	.sub {
		color: var(--muted);
		font-size: 0.89rem;
		margin-top: 4px;
	}
	.sections {
		display: flex;
		flex-direction: column;
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		text-align: left;
		padding: 14px;
		margin-bottom: 6px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
		color: var(--text);
		font-family: inherit;
		font-size: 0.98rem;
		font-weight: 700;
	}
	.toggle:hover {
		background: var(--bg);
	}
	.toggle.open {
		border-color: var(--accent);
		background: var(--accent-soft);
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
		margin-bottom: 0;
	}
	.ico {
		font-size: 1.15rem;
		width: 26px;
		text-align: center;
		flex-shrink: 0;
	}
	.title {
		flex: 1;
	}
	.chev {
		font-size: 0.8rem;
		color: var(--muted);
		flex-shrink: 0;
	}

	.body {
		border: 1px solid var(--accent);
		border-top: none;
		border-radius: 0 0 8px 8px;
		padding: 14px 18px;
		margin-bottom: 6px;
		background: var(--card);
		font-size: 0.9rem;
		line-height: 1.7;
		color: var(--text);
	}
	.body .lead {
		color: var(--muted);
		margin-bottom: 10px;
	}
	.body h3 {
		font-size: 0.92rem;
		font-weight: 700;
		margin: 14px 0 4px;
	}
	.body h3:first-of-type {
		margin-top: 4px;
	}
	.body ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.body li {
		position: relative;
		padding: 4px 0 4px 18px;
	}
	.body li::before {
		content: '•';
		position: absolute;
		left: 2px;
		color: var(--accent);
		font-weight: 700;
	}

	.foot {
		margin-top: 20px;
		padding-top: 14px;
		border-top: 1px solid var(--border);
		text-align: center;
		color: var(--muted);
		font-size: 0.82rem;
	}
	.foot a {
		color: var(--link);
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
