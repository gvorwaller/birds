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

		<!-- Forecast -->
		<button
			class="toggle"
			class:open={open === 'forecast'}
			aria-expanded={open === 'forecast'}
			onclick={() => toggle('forecast')}
		>
			<span class="ico">📅</span>
			<span class="title">Forecast (best months &amp; places)</span>
			<span class="chev">{open === 'forecast' ? '▾' : '▸'}</span>
		</button>
		{#if open === 'forecast'}
			<div class="body">
				<p class="lead">
					Forecast answers two planning questions from <em>prior years'</em>
					eBird checklists (roughly the last ten complete years), not just the
					last 30 days. The two tabs at the top are the two questions —
					<strong>"What can I see?"</strong> and
					<strong>"Where can I find this bird?"</strong> — and switching tabs
					keeps your month and remembers each side's last place or species.
				</p>
				<h3>What can I see? (place + month)</h3>
				<ul>
					<li>
						Pick a place — type anything ("Nome, Alaska", a park, an address),
						tap <strong>📍 Pick on map</strong>, or leave it blank to use your
						saved home — plus a month. Needed species group into
						<strong>Likely</strong> (on ≥20% of checklists),
						<strong>Possible</strong> (5–19%), and collapsed
						<strong>long shots</strong> (&lt;5%), each with its best specific
						hotspots and a "Where in the state" jump.
					</li>
					<li>
						Species that concentrate at one site say
						<strong>"mostly at …"</strong>; ones you'll bump into anywhere say
						<strong>"widespread"</strong>. A year strip shows which month is
						<strong>richest</strong> in needs at this spot, so you can pick the
						month around the place instead of the other way round.
					</li>
					<li>
						The forecast uses <em>every</em> loaded hotspot in range —
						loading is your choice, and a shared pool: what any user of this
						app loads, everyone benefits from. A first visit to a new area
						needs a one-time <strong>Load hotspot data</strong>; after that it's
						instant and only refreshes about once a year.
					</li>
					<li>
						One obvious entry point: the big
						<strong>Load hotspot data (N)</strong> button under the results
						header opens the pick panel. There, check any set of hotspots (or
						<strong>Select all shown</strong>) and hit
						<strong>Load selected (N)</strong>; outdated hotspots appear in
						their own <strong>refresh</strong> group, and not-yet-loaded rows
						also keep an individual <strong>Load</strong> button.
					</li>
					<li>
						Every load runs <strong>in the background on the server</strong> —
						queue it and walk away. Navigate anywhere, reload, even close the
						tab: the load keeps going, a slim progress chip follows you around
						the app, and <strong>Forecast data</strong> shows every queued,
						running and finished load (with a Cancel button). Temporary eBird
						hiccups retry automatically; only real problems (like a wrong
						eBird password) are surfaced for you to fix.
					</li>
					<li>
						Until an area is fully loaded, an amber note states exactly what
						the numbers rest on — "frequencies reflect only the N loaded of M
						hotspots in range" — so partial coverage is never mistaken for
						the full picture.
					</li>
				</ul>
				<h3>Where can I find this bird? (species + state)</h3>
				<ul>
					<li>
						Species search is bounded to birds actually reported in the
						selected state, most frequent first — type "storm petrel" and you
						get the four Florida ones, not the world's twenty-odd.
					</li>
					<li>
						You get a month-by-month chart with the best month called out —
						plus week-level timing when the data supports it ("peaks late
						April") and the <strong>good window</strong> ("good Dec–Mar"):
						every month within 80% of the peak, since trips rarely land on the
						single best month.
						<strong>Analyze all N counties</strong> queues one background job
						for the whole state (one eBird request per county, cached for the
						year) — results stream in as counties land, and you don't have to
						stay on the page.
					</li>
					<li>
						Tapping a county ranks its top hotspots (picked by species count +
						recent activity, expandable with "analyze 6 more") on a map — gray
						pins are candidates with no data loaded yet. Every hotspot row has
						Map, Directions, its eBird page, <strong>My needs here</strong>
						(jumps to the other tab at that spot), and
						<strong>Add to trip</strong>.
					</li>
				</ul>
				<h3>Reading the numbers</h3>
				<ul>
					<li>
						"34% of checklists (n=1,240)" means the species appeared on 34% of
						the 1,240 checklists submitted there in that month across the
						years — observed frequency, never a fabricated probability.
					</li>
					<li>
						A <strong>†</strong> marks small samples (fewer than 40
						checklists) — treat those numbers loosely; they never decide a
						"best month" or a ranking.
					</li>
					<li>
						<strong>Forecast data</strong> (linked from both tabs) is the
						inventory <em>and</em> the load hub: background loads show at the
						top with live progress, Cancel, and recent history; below, states
						expand to counties, counties expand to their hotspots, each row
						showing its year span, species count, load date, and a Refresh;
						failed loads keep a Retry. Load new states and analyze counties
						from here too. Note: eBird's bar-chart export can't tell
						provisional or escaped-exotic records apart, so those are included
						in frequencies.
					</li>
					<li>
						Species pages show a <strong>Best time of year</strong> chart with
						a "Where should I go?" link, and trip stops link straight to the
						forecast for the trip's month.
					</li>
					<li>
						Loading data signs in to eBird as you, so each user needs their own
						eBird login saved in Settings. Browsing loaded data never contacts
						eBird.
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
			<span class="ico">🏠</span>
			<span class="title">Home &amp; your needs</span>
			<span class="chev">{open === 'targets' ? '▾' : '▸'}</span>
		</button>
		{#if open === 'targets'}
			<div class="body">
				<ul>
					<li>
						<strong>Home</strong> is the app's main screen. It shows species you still
						need, based on what's being reported around a place — your saved home by
						default, or anywhere you search.
					</li>
					<li>
						“Needs” are species not yet on your life list. The app learns your
						life list from your eBird account (add your API key in Settings).
					</li>
					<li>
						<strong>Rare this week</strong> lists eBird's notable reports for the same
						place and window, whether or not they're on your needs list.
					</li>
					<li>
						<strong>Within</strong> starts at your saved search radius (change the
						saved default in Settings). Searching a place or changing the radius on
						the page affects that view only — <strong>Reset home defaults</strong> puts both
						back.
					</li>
					<li>
						Tap any species to open its page — recent sightings around the place you
						were looking at, a map, and your photos of it (if you have a photo
						gallery configured).
					</li>
					<li>
						Older <code>/targets</code> links and bookmarks still work; they land on Home
						with their search intact.
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
						<strong>Home location</strong> — set it once and the planner and Home
						default to your home area when you don't specify a place.
					</li>
					<li>
						<strong>Search radius</strong> — the saved default distance Home searches
						around a place. eBird caps it at 50 km.
					</li>
					<li>
						<strong>Need alerts</strong> — phone pushes when a rare bird you
						still need is reported near home. Setup steps are in the
						<strong>Need alerts</strong> section below.
					</li>
					<li>
						Read-only family accounts don't see Settings — they're along for the
						ride on someone else's data.
					</li>
				</ul>
			</div>
		{/if}

		<!-- Need alerts -->
		<button
			class="toggle"
			class:open={open === 'alerts'}
			aria-expanded={open === 'alerts'}
			onclick={() => toggle('alerts')}
		>
			<span class="ico">🔔</span>
			<span class="title">Need alerts</span>
			<span class="chev">{open === 'alerts' ? '▾' : '▸'}</span>
		</button>
		{#if open === 'alerts'}
			<div class="body">
				<p>
					Every 30 minutes the app checks eBird's <em>notable</em> (rare /
					review-worthy) reports near your home and pushes a notification to
					your phone when one is a species <strong>you still need</strong> —
					"Lifer nearby: Snail Kite · Sweetwater Wetlands · 12 mi from home."
					Delivery uses the free
					<a href="https://ntfy.sh" target="_blank" rel="noopener">ntfy</a>
					app. One-time setup:
				</p>
				<ol>
					<li>
						<strong>Install ntfy on your phone</strong> — search "ntfy" in the
						App Store (iOS) or Play Store (Android). No account needed.
					</li>
					<li>
						<strong>Invent a topic name</strong> — long and random, like
						<code>gv-birds-k8Rx2mQz94</code> (8–64 letters, digits, - or _).
						<strong>Treat it like a password</strong>: ntfy has no logins, so
						anyone who knows the topic can read your alerts. Don't pick
						something guessable.
					</li>
					<li>
						<strong>Subscribe in the ntfy app</strong> — tap +, enter that exact
						topic name, keep the default ntfy.sh server.
					</li>
					<li>
						<strong>Save it here</strong> — Settings → Need alerts → paste the
						topic, pick a radius and a re-alert window, then hit
						<strong>Send test notification</strong>. Your phone should buzz with
						"Need-alerts test." If it stays quiet: check the ntfy app is
						subscribed to that exact spelling, notifications are allowed for
						ntfy, and Focus/Do&nbsp;Not&nbsp;Disturb isn't silencing it.
					</li>
					<li><strong>Tick Enable</strong> and save. Done.</li>
				</ol>
				<ul>
					<li>
						Alerts need your <strong>home location</strong> and
						<strong>eBird API key</strong> set (distances are measured from
						home, and the scan runs under your own eBird account).
					</li>
					<li>
						Each account uses its <strong>own topic</strong> — alerts match each
						person's own life list, so don't share one topic between accounts.
						The same topic on multiple <em>devices</em> is fine (phone + the
						ntfy web app on your Mac, for example).
					</li>
					<li>
						You're alerted about a species at most once per re-alert window
						(default 7 days), at most 5 pushes per scan, and
						"(unconfirmed)" in the title means the report hasn't been reviewed
						yet. Private locations show no place name by design.
					</li>
					<li>
						<strong>Quiet hours</strong> = your phone's Focus schedule. Allow
						ntfy through any Focus you want a rarity to break.
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
	.body p {
		margin: 0 0 8px;
	}
	.body ol {
		margin: 0 0 8px;
		padding-left: 22px;
	}
	.body ol li {
		padding: 4px 0;
	}
	.body ol li::before {
		content: none; /* numbered items keep their numbers, not bullets */
	}
	.body ol li::marker {
		color: var(--accent);
		font-weight: 700;
	}
	.body code {
		font-family: ui-monospace, monospace;
		font-size: 0.85em;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 1px 5px;
		word-break: break-all;
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
