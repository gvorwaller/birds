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
				<p>
					Automatic suggestions use only locations verified in eBird's hotspot
					reference data. Other places reported in the current eBird response stay
					visible as <strong>Reported places</strong> so you can deliberately add
					them after checking access. A hotspot membership label does not guarantee
					public access.
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
						<strong>Minimum matching species/stop</strong> — only suggest a hotspot if
						it has at least this many species matching the selected Count setting.
						Raise it to be picky, lower it to see more options.
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
						Every place represented in the current eBird response is listed, ranked
						by how many matching species were reported there. Counts follow the Count
						setting and are a preview, not
						a complete inventory. Verified hotspots can be added normally; other
						rows use <strong>Add reported location</strong> and show their unverified
						status. <strong>Add</strong> or
						<strong>Remove</strong> any of them — there's no cap, build the trip you
						want.
					</li>
					<li>
						If hotspot verification is unavailable, no unverified location is chosen
						automatically. You can still add a reported location yourself after
						checking access.
					</li>
					<li>
						<strong>Compare hotspots</strong> checks every verified hotspot in the
						selected radius using that hotspot's own recent public reports. It shows
						progress, stale or failed results, and keeps the area-feed preview labeled
						as incomplete. In the planner, press <strong>Use compared ranking</strong>
						explicitly before it changes the suggested route.
					</li>
					<li>
						The map and the “distinct matching species across the route” summary update live
						as you curate, and the stops are ordered into an efficient route from
						your start point.
					</li>
					<li>
						Each stop shows which matching species were reported, when, and the
						hotspot's all-time species count and last report date.
						On a saved trip, “When planned” records the preview feed, window,
						location and fetch time. “Now nearby” is a separate 14-day nearby
						life-list-needs count; the two statements use different coverage and
						are not a trend. Legacy counts whose scope was never saved are labeled
						as matches with unknown scope.
					</li>
				</ul>
				<h3>4. Extras on the saved trip</h3>
				<ul>
					<li>
						<strong>Weather</strong> — a short forecast for the trip area (US
						only).
					</li>
					<li>
						<strong>Tides</strong> — located stops near a NOAA prediction
						station show high and low tide times, heights, the station name,
						and its distance from the stop. An active trip shows the next high
						and low; a future trip shows the full schedule for its first day.
						Finished trips and stops without a nearby station show no tide
						card. Heights are relative to MLLW; these are NOAA CO-OPS
						predictions, not observations, and are not for navigation.
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
						When the map opens, its <strong>Choose a forecast location</strong>
						heading is brought into view. Search or tap to place a draft pin, then
						use <strong>Forecast near …</strong> to apply it. <strong>Cancel</strong>
						leaves the forecast and saved Home unchanged.
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
						needs a one-time <strong>Load all remaining</strong> (or a hand-picked
						load); after that it's instant and only refreshes about once a
						year.
					</li>
					<li>
						A <strong>coverage pill</strong> under the results header always
						shows where you stand — "12 of 18 loaded · 1 outdated". The
						common path is one tap:
						<strong>Load all remaining (N)</strong> queues everything at
						once. To pick instead, tap <strong>Manage</strong>: a panel opens
						right there with a name filter, checkboxes (or
						<strong>Select all shown</strong> +
						<strong>Load selected (N)</strong>), an
						<strong>outdated — refresh</strong> group, per-row
						<strong>Load</strong> buttons, and <strong>suggested</strong> tags
						on the mix of hotspots the app would pick first.
					</li>
					<li>
						Every load runs <strong>in the background on the server</strong> —
						queue it and walk away. Navigate anywhere, reload, even close the
						tab: the load keeps going, a slim progress chip follows you around
						the app, and <strong>Hotspots &amp; data</strong> shows every queued,
						running, paused, scheduled and finished load. The status explains
						whether a worker, retry window or pause is holding it, and available
						loads keep their Cancel control. Temporary eBird hiccups retry
						automatically; only real problems (like a wrong eBird password) are
						surfaced for you to fix.
					</li>
					<li>
						Until an area is fully loaded, an amber note states exactly what
						the numbers rest on — "frequencies reflect only the N loaded of M
						hotspots in range" — so partial coverage is never mistaken for
						the full picture.
					</li>
				</ul>
				<h3>Life list</h3>
				<ul>
					<li>
						<strong>Life list</strong> (menu → 🗺️ Life list) shows every
						lifer two ways: a <strong>map</strong> of where you got each one
						(pin numbers = lifers at that spot; tap a pin for the birds,
						dates, and their eBird checklists) and a
						<strong>timeline</strong> by year with your lifer numbers —
						milestone birds (#100, #200…) are starred. State chips filter
						both views. Location data comes from your eBird life-list sync
						(Settings); locations without coordinates yet resolve a batch at
						a time on each sync, and exotic or not-countable birds are
						labeled, never hidden.
					</li>
					<li>
						Use the <strong>Life list</strong> picker to view lists shared by other
						signed-in Birds users. Their map, dates, locations, and checklist links
						are read-only. Switching lists applies to this page; species pages and
						Seen/Need badges still use your usual life list. Returning from a bird
						page keeps the selected list.
					</li>
					<li>
						To share yours, enable <strong>Share my life list</strong> in
						<a href="/settings#life-list-sharing">Settings → Life-list sharing</a>
						and save. Sharing starts off. Turning it off removes your list from
						other users' picker and blocks new shared-list requests. Existing family
						access remains available; family viewers cannot change the owner's
						sharing setting. There is no public life-list link.
					</li>
				</ul>
				<h3>Hotspot pages</h3>
                <p>Bird links from Field guide, Taxonomy, Viewed species, Special interest,
                Photos, Life list, Home, Nearest reports, Alerts and Forecast keep a named path
                back to the same filtered row. The saved URL includes choices such as search,
                page, place, radius and month. Multi-hop exploration across similar species and hotspots
                keeps the path; use the expandable
                <strong>Your path</strong> trail to return farther back in oldest-first order.
                Opening a page that is already on the path moves it to the end, so Back
                always leads to the page you just left. The path belongs to the browser tab
                and survives a refresh; the bottom menu starts a fresh path. In nearby reports,
                the place name opens its hotspot here; the separate eBird badge opens eBird.
                A location without usable coordinates opens a Forecast location chooser;
                it will not silently use Home or a remembered search.</p>
				<ul>
					<li>
						Tap any <strong>hotspot name</strong> — on Home's best places,
						the forecast lists, or a saved trip stop — to open its own page:
						directions and maps, a one-tap
						<strong>Load/Refresh historical data</strong> button, a
						<strong>Recent</strong> tab showing the latest report of each
						species (one row per species, linking to the eBird checklist it
						came from, with your Need/Seen badges — flagged rarities awaiting
						review are included and marked
						<strong>Unconfirmed</strong>), and a
						<strong>Monthly</strong> tab showing what's likely there each
						month. The <em>eBird ↗</em> badge still opens eBird itself.
					</li>
				</ul>
				<h3>Where can I find this bird? (species + region)</h3>
				<ul>
					<li>
						A <strong>Country</strong> picker sits above the region select — it
						defaults to the US, but any of eBird's countries works. When you
						have a saved home, countries and regions are ordered nearest-first
						(the US remains pinned at the top of the country list). Species
						search is bounded to birds actually reported in the selected
						region, most frequent first — type "storm petrel" and you get the
						four Florida ones, not the world's twenty-odd.
					</li>
					<li>
						You get a month-by-month chart with the best month called out —
						and a <strong>Week</strong> toggle on the chart that shows the
						full week-by-week resolution (48 bars; hatched † bars mean few
						checklists that week), with an effort strip underneath showing
						checklists per week. Migratory species whose data supports it
						also get an <strong>arrives ~… · departs ~…</strong> line — the
						same chart toggle and line appear on each species' own page.
						Plus week-level timing when the data supports it ("peaks late
						April") and the <strong>good window</strong> ("good Dec–Mar"):
						every month within 80% of the peak, since trips rarely land on the
						single best month.
						<strong>Analyze all N counties</strong> (or "regions" outside the
						US) queues one background job for the whole region (one eBird
						request per county, cached for the year) — results stream in as
						counties land, and you don't have to stay on the page.
					</li>
					<li>
						Tapping a county or region ranks its top hotspots (picked by species count +
						recent activity, expandable with "analyze 6 more") on a map — gray
						pins are candidates with no data loaded yet. Every hotspot row has
						Map, Directions, its eBird page, <strong>My needs here</strong>
						(jumps to the other tab at that spot), and
						<strong>Add to trip</strong>.
					</li>
					<li>
						<strong>Load hotspots</strong> on a county row here, or "Load every
						hotspot in …" on any hotspot page, sweeps <em>all</em> of that
						county's eBird hotspots in one background job instead of picking them
						off a few at a time. It skips whatever is already loaded, so
						re-running only fills gaps. Countries without counties sweep by region.
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
						<strong>Hotspots &amp; data</strong> (menu → 📊 Hotspots &amp; data,
						or the third Forecast tab) is the inventory <em>and</em> the
						load hub. The <strong>Find a country, region, county or hotspot</strong>
						section at the top (described just below) finds places by name,
						code or map point — hotspot names there (and throughout the tree)
						open their own page. Background loads show live progress with an
						<strong>Activity</strong> feed per load (which location just
						loaded, which failed and why), Cancel, and recent history; below,
						loaded data drills from geographic area to country, then from
						state/region to smaller regions and hotspots. United States contains
						all of its states; each level stays collapsed until opened. Collapsed
						geographic area, country, and state/region lines show distinct species
						totals across their loaded data, counting shared species only once.
						The Loaded data heading also shows a worldwide total, deduplicated
						across continents and including hotspots without a recorded region.
						These totals include all loaded years and seasons, not a complete range
						checklist; missing areas are not evidence of absence. Counts load
						separately so the controls remain usable, and Reload updates them.
						Each row
						shows its year span, species count (with any unmatched
						bar-chart rows), load date, and a Refresh; failed loads keep a
						Retry. Hotspots can belong directly to a country or region when
						eBird has no smaller subdivisions there. Where smaller subdivisions
						are known, a note identifies hotspots without that more specific
						assignment. Refresh reloads historical bird data; it does not look
						up or repair geographic assignments.
						Load new regions and analyze counties from here too — pick
						a <strong>Country</strong> above the region select to load
						anywhere eBird covers. That picker is alphabetical and only shows
						countries that do not yet have either countrywide coverage or every
						regional location resolved. A location eBird confirms has no checklist
						data—or a location quarantined after repeated unavailable responses—counts as
						resolved, so it does not leave an otherwise completed country in the picker;
						countries with coarse or no state-level
						divisions offer an <strong>Entire {'{Country}'}</strong> whole-country
						load instead (not offered for the US, whose bar-chart export would
						be disproportionate). Note: eBird's bar-chart export can't tell
						provisional or escaped-exotic records apart, so those are included
						in frequencies.
					</li>
					<li>
						<strong>Find a country, region, county or hotspot</strong> — on
						<strong>Hotspots &amp; data</strong>, type a name or code, or choose
						<strong>Choose on map</strong>, pick a place, enter a radius from 1 to
						200 miles and choose <strong>Apply location</strong>. Results show 50
						at a time with an exact total and Previous/Next links, so every match
						is reachable; zero results means nothing local matched, not that the
						place does not exist in eBird. Each result says what it is and how
						it is known: countries and first-level regions are reference
						geography; a county or equivalent is a loaded county; a
						<strong>verified eBird hotspot</strong> has eBird evidence (a loaded
						hotspot, an official hotspot list, or official hotspot information);
						and a <strong>reported location — hotspot status unverified</strong>
						is a place that appeared in a failed load without that evidence. An
						unverified location is never treated as a hotspot, a venue or a
						public-access site. Map results are only verified hotspots with
						recorded coordinates inside the circle, nearest first; the page says
						how many locally known verified hotspots have no coordinates and could
						not be measured, and lists areas represented by nearby verified
						hotspots without claiming your point lies inside them. Selecting a
						result only opens or preselects what is already on this page (a
						section, or the Load form) or opens a hotspot page, with a link back to
						your exact search; it never loads bird data, queues a job or changes
						Home. Typed search and shared map links work without JavaScript;
						picking or moving a map point needs it.
					</li>
					<li>
						For the species page's seasonal charts and recent report lookup,
						see <strong>Field guide</strong> below: “Where it is through the year,”
						“Best time of year,” and “Check nearest reports.”
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
						<strong>Two-stage loading.</strong> Both lists appear as soon as the area
						reports arrive, then fill in as eBird responds with each needed
						species' full place breakdown — the “Show all N places” lists and the
						place search. Until that lands, a <em>needs</em> row shows where its
						latest report was rather than a location or report count, because the
						feed behind it carries only that one sighting per species. Rare reports
						show their counts straight away; that feed lists every notable sighting,
						so its numbers are already complete. If place details take more than 50 seconds,
						the page keeps all area-report species and the details already received,
						and labels the result incomplete. Reload to request the remaining details.
					</li>
					<li>
						Older <code>/targets</code> links and bookmarks still work; they land on Home
						with their search intact.
					</li>
					<li>
						<strong>Map, directions, and eBird checklists.</strong> Each reported
						location provides direct links to view the spot on Google Maps
						(<code>📍 Map</code>), open turn-by-turn navigation (<code>Directions ↗</code>),
						and link directly to the observer's public eBird report (<code>checklist ↗</code>)
						whenever an eBird checklist ID was included with the observation.
					</li>
					<li>
						<strong>Your recorded sightings.</strong> Home also shows first-seen
						life-list records from the selected calendar dates inside your saved-home
						radius. These records are separate from public totals and are not a
						complete checklist history. Missing locations and undated records remain
						available through the Life list.
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
						<strong>Export</strong> — 🔗 Export opens a self-contained field
						sheet in a browser tab (savable, printable, dark-mode aware) with
						your per-stop needs and field tips; ⬇ .md downloads Markdown.
					</li>
					<li>
						<strong>Share text</strong> — opens the trip text in an in-app panel
						with system Share and Copy buttons. Use this on the home-screen app:
						it never navigates away, so you can't get stuck outside the app.
					</li>
					<li>
						<strong>Share link</strong> — creates a private URL anyone can open
						without logging in. They see the full field sheet with your target
						species and tips, but none of the links into your account. Revoke or
						regenerate it anytime from the trip page — the old URL stops working
						immediately.
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
						<strong>Appearance</strong> — choose Light, Dark, Forest, Ocean, or
						Warm Paper in Settings → Choose your theme, then Save theme. Light
						is the default. The choice belongs to your account, follows you across
						devices on the next page load, and never changes another user's view.
						Maps retain their provider's styling; conservation badges retain their
						meaningful colors. Chart labels and intensity ramps adapt to dark mode.
					</li>
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
						Read-only family accounts cannot access private account settings.
						They can use Appearance from the menu
						to choose their own theme without accessing private settings.
					</li>
					<li>
						<strong>Viewer life-list owner (admin)</strong> — in Settings → Users,
						an administrator chooses and can later change which owner account each
						viewer displays. Seen and Need then follow that owner's life list;
						Viewed species, Special interest, appearance, and sign-in remain the
						viewer's own. Viewers cannot choose or change this relationship.
					</li>
				</ul>
			</div>
		{/if}

		<!-- Field guide -->
		<button
			class="toggle"
			class:open={open === 'guide'}
			aria-expanded={open === 'guide'}
			onclick={() => toggle('guide')}
		>
			<span class="ico">📖</span>
			<span class="title">Field guide</span>
			<span class="chev">{open === 'guide' ? '▾' : '▸'}</span>
		</button>
		{#if open === 'guide'}
			<div class="body">
				<p>
					The <a href="/species">Field guide</a> (menu → 📖 Field guide) searches
					the complete current eBird species taxonomy by name or code, and can
					also find loaded Wikipedia text, field notes and tags.
					Wikipedia notes and field craft fill from loaded regions, life lists,
					photos, or an explicit first-time Load on the species page. Each
					enriched species may include article text from Wikipedia, quick facts
					(conservation status, size), and AI-written field craft: when, where,
					and how to actually find the bird.
				</p>
				<ul>
					<li>
						<strong>Search anything</strong> — use the always-visible search for a name ("godwit"), or words
						from how you'd describe a bird ("granary trees", "probes
						mudflats"). With Relevance selected, exact species and banding codes rank before names, then description or field-note matches. Each result says which kind of match it is. Open <strong>Filters and sort</strong> for location, family, tags and other filters.
					</li>
					<li>
						<strong>Filter by location</strong> — open <strong>Filters and sort</strong>
						and use <strong>Location</strong>. Choose a Country, then optionally a
						State / region, a County / equivalent and a Verified hotspot (for
						example United States → Florida → Sarasota County → Myakka River SP).
						Each list offers every loaded choice beneath your previous one, and
						changing a higher level clears the lower ones. Location combines with
						your search text and every selected tag, or works on its own. It
						includes birds reported in any month of the displayed historical
						years. A country, state or county uses the loaded regional, county
						and hotspot data recorded beneath it. A hotspot uses only that exact
						eBird hotspot's own loaded data, so it is narrower than its county.
						This is recorded presence, not a complete range checklist or a
						prediction for today. The page says how many loaded sources and which
						years it used, and whether a whole-area source is loaded; when only
						parts are loaded, places without loaded data are not covered. A
						place with no loaded data shows a coverage message, which does not
						mean there are no birds. Choose Anywhere, or
						<strong>Clear location only</strong>, to remove the location and keep
						your search, family, tags, sort and other options. Filters remain in
						the URL and survive opening a species and returning to the results.
					</li>
					<li>
						<strong>Filter by map and radius</strong> — under Location, choose
						<strong>Choose on map</strong>, search for a place or tap the map, type a
						radius from 1 to 200 miles and choose <strong>Apply location</strong>.
						Cancel closes the map without changing your results. The Field Guide
						then uses only loaded eBird hotspots that have recorded coordinates
						inside that circle. State and county summaries are not counted by their
						centre, and the part of the map you can see never limits the result.
						No radius is chosen for you, and moving the pin changes nothing until
						you apply. The page states how many loaded hotspots were used and how
						many loaded hotspots had no recorded coordinates and could not be
						checked. If none fall inside the circle, coverage is unavailable, not
						zero birds; <a href="/forecast/data">Hotspots &amp; data</a> can load
						more history. Picking or moving a map point needs JavaScript; the
						Country to Hotspot lists, and a shared map link, work without it.
						Choosing a location here does not change your saved Home location and
						does not fetch anything from eBird.
					</li>
					<li>
						<strong>All, Need and Seen</strong> — the three links under the Field Guide
						tabs choose which species the list shows, without changing your search, tags,
						family, sort, Special-interest filter or location. <strong>All</strong> is
						every matching species. <strong>Need</strong> is those matches that are not
						on your life list, and <strong>Seen</strong> is those that are, so Need plus
						Seen always equals All for the same filters and place. The selected item is
						marked and each count names it, for example “Showing 1–100 of 439 Need
						species”. Following All, Need or Seen on the blank page browses the whole
						current taxonomy; links made before these controls existed still show All.
						Seen and Need follow the life list the page displays: a family viewer sees
						the owner's list, and their own Viewed and Special-interest markers stay
						their own. Species retired from the taxonomy are never added to Seen. The
						choice is only how the list is shown — it never changes your life list, loads
						data or contacts eBird — and it is kept when you search, filter, page, clear a
						location or open a bird and return. Choose All to leave Need or Seen. An empty
						Need or Seen result means no matching species are in that group; for a place
						without loaded history the coverage message still says that is not evidence
						that there are no birds there.
					</li>
					<li>
						<strong>Result photos</strong> — reference thumbnails help you scan the
						birds, with creator, source, and license credits below each pictured
						result. A missing or unavailable photo is labeled; it never removes
						a bird from the results.
					</li>
					<li>
						<strong>Or filter by tags</strong> — open a dimension (Habitat,
						Foraging, Tide, Time of day, Movement, Finding) and tap chips.
						Multiple chips must ALL match, so
						<em>habitat: mudflat</em> + <em>Tide: low</em> answers "which
						shorebirds should I look for on a falling tide?" Tap a selected
						chip (or its ✕ in the Active filters row) to remove it.
					</li>
					<li>
						<strong>Tide tags</strong> are the shorebird special:
						AI-annotated tidal species can receive one — the stage when
						it's most findable — and its field craft explains why. When a
						tide-tagged species page has a location, its
						<strong>Finding this bird</strong> card also shows the next high and
						low predictions at the nearest NOAA station, including the
						station's distance from that location.
					</li>
					<li>
						Results always show your <strong>Seen/Need</strong> badge;
						enriched results may also show <strong>tag chips</strong>
						(the ones you filtered by light up), <strong>field craft</strong>,
						and <strong>IUCN status</strong>. Tap through to the full
						species page; the back link returns to your exact search.
					</li>
					<li>
						<strong>Jump to an answer</strong> — the <strong>On this page</strong>
						links below a bird's name list only the sections available for that
						bird. Choose Identification, Similar species, Finding this bird,
						seasonal distribution, Best time, reports, About, or Learn more to
						move directly to it. A closed Similar species or seasonal chart
						reopens automatically. These jumps keep your Field Guide search and
						return path intact.
					</li>
					<li>
						On any species page, the <strong>About</strong> card holds the
						article text (tap section headings to expand) and the
						<strong>Finding this bird</strong> card holds the field craft and
						tags. The field craft is
						<strong>AI-generated from the article — verify in the field</strong>;
						treat it as a knowledgeable friend's hunch, not gospel.
					</li>
					<li>
						The <strong>Identification</strong> card (after Your photos) is a
						representative photo and up to two sounds — song and call when we
						have them. Files stay on
						<a href="https://commons.wikimedia.org" target="_blank" rel="noopener">Wikimedia Commons</a>
						and
						<a href="https://xeno-canto.org" target="_blank" rel="noopener">xeno-canto</a>;
						this app stores only the links, so playback needs a network
						connection.
					</li>
					<li>
						A species page may show a <strong>Similar species</strong> card.
						Its pairs come from
						<a href="https://www.inaturalist.org" target="_blank" rel="noopener">iNaturalist</a>
						misidentification data — species that real observers demonstrably
						confused with this one, ranked by how often it happened. A pair with
						no matching eBird species is still listed in a footnote rather than
						silently dropped. Distinguishing notes are <strong>AI-generated and
						should be verified in the field</strong>. Four states can make the
						card absent or explanatory: <em>no confusions recorded</em> on
						iNaturalist (card hidden — honest empty, not missing data);
						<em>no iNaturalist match</em> for this species (the card says so);
						<em>data fetch failed</em> (the card says so and retries
						automatically); and <em>data still loading</em> for a newly added
						species (card absent until the background fetch lands).
						Tapping a similar species keeps your navigation trail intact,
						so you can explore comparisons and use <strong>Your path</strong> to
						retrace your steps.
					</li>
					<li>
						<strong>Name/code search</strong> covers the complete current eBird
						species taxonomy. Wikipedia notes fill when you load a species
						(or when that bird is already in a loaded region, life list, or
						photos). Loading a forecast area on
						<a href="/forecast/data">Hotspots &amp; data</a> is the big lever —
						a statewide load brings that state's whole avifauna into the
						guide.
					</li>
					<li>
						Any account may perform the <strong>first load</strong> of a
						species' Wikipedia notes; only admins may
						<strong>refresh</strong> existing data. Some species legitimately
						have taxonomy and links but no English Wikipedia article.
					</li>
				</ul>
                <h3>Taxonomy — explore bird relationships</h3>
                <p>The <a href="/taxonomy">Taxonomy</a> tab explains orders, families, genera, species, and reporting categories. Open an order and a family to see its current species and counts. Family labels on species pages link here; species links return to the detail page, preserving your place in the taxonomy browser.</p>
                <p>Classification comes from cached eBird taxonomy. Family descriptions are filled automatically in the background from Animal Diversity Web family accounts where available, otherwise from Wikipedia accounts verified through scientific names and Wikidata identities. Where a family page is sparse, accounts of its living species or genera may supply explicitly scoped natural history. Descriptions using several accounts link each source. These references supply natural history; eBird supplies current classification. AI writes a source-grounded study summary and separately checks its claims against the source. These summaries are not human-reviewed; their source, author attribution and reuse license are linked. ADW adaptations use CC BY-NC-SA 3.0; Wikipedia adaptations use CC BY-SA 4.0. Missing sources and pending descriptions are labeled. Admin → AI &amp; Cost has a separate Family descriptions model setting, defaulting to Sonnet 5 for both writing and checking, with Opus 5 also available. Admin shows coverage and failures, with family-only pause/resume and retry controls, including selecting individual gaps without replacing current descriptions; the main worker pause also applies. Successful descriptions refresh after six months, and changed classifications are rechecked. Failed refreshes keep the previous description. Opening a family does not mark its species Viewed. Your badges remain personal to your account.</p>
                <p>In Browse species, combine the Bird family filter with location, tags, and search. Choose Relevance, Alphabetical, or Taxonomic order. Results are paginated in groups of 100, with totals and Previous/Next links; all matching species remain reachable. Taxonomic ordering awaits a taxonomy refresh if the metadata has not been loaded.</p>
                <p>Browse species, Taxonomy, and Viewed species accept exact banding codes, ignoring case (for example, OSPR for Osprey). Source codes may be ambiguous; all matching species remain available. Codes are taken from eBird, never generated from names. This release does not remap sightings or change Seen/Need calculations after taxonomy changes.</p>
				<h3>Special interest — birds to return to</h3>
                <p>On a species page, select <strong>☆ Special interest</strong> to save it. The filled star and pressed button show it is saved; select again to remove it. Both Seen and Need birds can be saved. Open the <a href="/special-interest">Special interest</a> Field Guide tab to search your collection, sort alphabetically or by recently saved, and remove birds. Selections stay until you remove them and follow your account across devices, including viewer accounts. People sharing a login share its collection.</p>
                <p>In Browse species, choose <strong>Special interest only</strong> to combine your saved birds with search, family, tags and country/region filters. Location filters use loaded historical reports; missing coverage is not absence. Saving a bird does not change your life list, Seen/Need, viewing history, trip stops or rankings, and sends no notifications. Retired codes remain in the collection with an unavailable label and can still be removed. A failed save shows a retry control; account changes require reloading the page.</p>
				<h3>Viewed species — your learning history</h3>
				<p>
					Opening a species page records it in your account's
					<a href="/viewed">Viewed species</a> collection, also available as a Field Guide tab.
					<strong>Viewed in app</strong> means you opened its page;
					<strong>Seen</strong> still means it is on your life list. The viewed
					indicator appears after saving, and also appears in Field Guide results.
				</p>
				<ul>
					<li>Search your collection by name or code, sort by most recent or
						alphabetically, and see first/last viewed dates (shown in UTC).</li>
					<li>Use <strong>Study list</strong> to switch between Viewed species and
						<strong>Not yet viewed</strong>. Not yet viewed means no recorded page visit
						in this account, independently of Seen/Need on your life list. It includes
						visits from before tracking began, while paused, or since cleared.</li>
					<li>Use <strong>Group by → Bird family</strong> for collapsible classification
						groups, or <strong>Country</strong> to study birds reported in a place.
						Countries remain alphabetical. Choose Taxonomic order to put related species together and order families taxonomically. Otherwise families remain alphabetical. Not-yet-viewed species default to alphabetical sorting.</li>
					<li>Only countries containing species in your selected study list and search
						are shown, with distinct species counts before you open them. Country
						groups load their species when you open them, using the app's historical eBird
						reports from any month. Country membership updates automatically when
						report data changes. A bird can appear in several countries. The dates
						and coverage note describe the loaded data, not its complete range or
						current presence. An omitted country does not establish absence;
						birds without mapped reports remain available in the other groupings.</li>
					<li>Large lists show 100 species at a time with <strong>Show 100 more</strong>
						and a visible total. Opening a species preserves the study filters and
						group in its return link. Open and close groups to keep the list manageable.</li>
					<li>History belongs to the signed-in account, including family viewers.
						It follows that account across devices. People sharing a login share
						its history; your owner's shared life list stays separate.</li>
					<li>Only displayed pages count. Hover previews and background refreshes
						do not. History begins with this feature; earlier visits are not reconstructed.
						If saving fails, the page remains usable and offers <strong>Retry</strong>.</li>
					<li><strong>Pause recording</strong> keeps existing history; Resume records
						future visits. <strong>Clear history</strong> asks for confirmation and
						removes your viewing records, leaving your life list unchanged.
						Species removed from the current taxonomy remain listed by code when
						their name is no longer available.</li>
				</ul>
				<h3>Where it is through the year</h3>
				<p>
					Open <strong>Field guide</strong>, choose a species, and scroll to
					<strong>Where it is through the year</strong>, above Best time of year.
					The section starts expanded; tap Hide or its heading to collapse it, then Show to reopen.
					Closing it keeps your chart selections while you stay on this species.
					This chart shows seasonal patterns in loaded historical eBird reports.
					It does not track individual birds or show live sightings.
				</p>
				<ul>
					<li>
						<strong>Read the grid.</strong> Months run left to right, with northern
						latitudes at the top and southern latitudes at the bottom. Darker green
						means a higher share of checklists reported the bird. A band shifting
						north or south across the months suggests seasonal movement; a band
						staying at the same latitude suggests year-round presence. The summary card
						above the chart describes patterns supported by the loaded data.
					</li>
					<li>
						<strong>Choose the geography.</strong> The chart starts with <strong>By continent → All continents</strong> on both phone and desktop. Use <strong>World</strong> for
						the combined view or <strong>By continent</strong> to compare continents.
						The continents selector lets you choose which ones to show.
						<strong>Latitudes → Species range</strong> shows occupied bands with
						a buffer on each side; <strong>Full globe</strong> shows all bands
						from 90°N to 90°S. Regions are assigned by their centre point, so
						the grid is an overview rather than a precise range map. Latitude
						labels and the readout include geographic landmarks for orientation.
					</li>
					<li>
						<strong>Explore a month and place.</strong> Tap a square to see its
						reporting rate and the regions behind that latitude band. On a phone,
						you can also use the month slider or ◀ ▶ buttons. The region list
						shows January–December patterns, sorted by each region's highest
						monthly rate, with up to 40 regions available. Use <strong>Show all</strong>
						to expand the initial eight. Tap a region to show its full-year chart
						in <strong>Best time of year</strong> below.
					</li>
					<li>
						<strong>Find the strongest region this month.</strong> The readout names the
						region with the highest reporting rate among those with at least 40 checklists
						in the selected month. Tap that line to chart its year. This searches the same
						up to 40 regions as the list, chosen by annual peak; another region outside
						those 40 may be stronger this month. “None with 40+ checklists” means the
						available regions lack enough checklists, not that the bird is absent.
					</li>
					<li>
						<strong>Choose the colour scale.</strong> <strong>Absolute</strong> uses fixed reporting-rate
						bands. <strong>Relative</strong> makes seasonal changes easier to see for birds
						with low reporting rates: colours show fractions of this bird's highest grid
						rate under the selected averaging method. The legend names that peak's rate,
						latitude band, continental column and month. The scale covers all loaded
						months and geography, including hidden columns. The grid and region strips
						share it; an individual region can exceed the aggregate peak. Readout rates
						and counts stay absolute. This choice is saved for your account in this browser.
					</li>
					<li>
						<strong>Choose how reports are averaged.</strong> <strong>Equal weight</strong>
						gives each country equal weight within its continent, then each
						continent equal weight in World. Regions within a country are still
						weighted by checklists. <strong>By checklists</strong> gives more weight
						to places with more checklists, so heavily birded places count more.
						The <strong>N of M checklists</strong> line shows the reported and total
						checklist volumes contributing to the selected cell. Reported counts are
						rounded estimates from reporting frequencies and checklist totals. Under
						Equal weight, the percentage can differ from N divided by M; countries
						left out of the average contribute to neither count.
					</li>
					<li>
						<strong>Zero, small samples, and missing data differ.</strong> Grey
						means the bird was not reported in the loaded checklists. A diagonal
						slash means nothing is loaded. A dash marks small samples: in Equal
						weight, one or more countries with fewer than 40 checklists were
						excluded, and the cell cannot be rated if all were excluded. In By
						checklists, the whole cell has fewer than 40 checklists; its rate is
						still available in the readout. Missing data never proves absence.
					</li>
					<li>
						<strong>Check the coverage.</strong> The card identifies what is loaded.
						Each region uses its stored historical years, which may differ from
						other regions. A gap note marks months when every loaded region is
						below 0.5% of checklists; it does not mean the bird is absent worldwide.
					</li>
				</ul>
				<h3>Best time of year</h3>
				<ul>
					<li>
						Species pages show a <strong>Best time of year</strong> card
						comparing the closest loaded region with sightings against the
						region where the bird is most frequent overall (region names
						include their country, like "Bornholm, Denmark"). Tap either
						place to switch the chart. “Closest” measures to the region's
						reported extent — zero when your home is inside it — rather than
						to a distant state or country center. The card's frequencies still
						average the whole named region; use "Where should I go?" for county
						and hotspot detail — it leaves a breadcrumb back to the bird and
						the field guide. Trip stops link straight to the forecast for the
						trip's month.
					</li>
				</ul>
				<h3>Check nearest reports</h3>
				<ul>
					<li>
						Open a bird you still need in <strong>Field guide</strong>, then find
						<strong>Nearest reports</strong> on its species page
						and tap <strong>Check nearest reports</strong>. This searches recent
						reports from your saved home. Choose a 1, 7, 14, or 30-day window and
						any distance or a finite distance. It requires a saved home and an eBird
						API key; it is shown only for species not yet on your life list.
						Results show distance, location, date, source, and a checklist link when available.
					</li>
					<li>
						<strong>How the lookup works.</strong> eBird's own nearest-report
						search struggles with a common bird a long way from where it
						lives — it can run for a full minute and then fail. The app
						asks that endpoint and, if it has not answered within a few
						seconds, searches its own region list <em>at the same time</em>
						— first real answer wins. The region search looks first where
						historical reports place the bird in the months covered by your
						search, then where it has been reported in other seasons.
						Within each group it checks closer regions first. Regions with
						unknown history remain searchable, followed by regions with no
						recorded historical reports. History guides the search; it does
						not guarantee a bird is present or absent today.
						A region search says so: "found by
						searching N regions". Those distances are exact. What that
						search can't claim is the whole world — a few places have no
						usable boundary data — so when it finds nothing it says how many
						regions it checked and links you to eBird's map for the species,
						rather than telling you the bird is nowhere.
					</li>
					<li>
						If a need alert for this bird saved a checklist that the feeds
						checked just now did not return, the species page lists it under
						<strong>From your alerts</strong>, with the place, distance from
						home, and sighting time stored when the alert was sent. That line
						is separate from the live reports: it is not marked accepted or
						unconfirmed, and it is not a map pin. It appears in recent
						reports only when that card is centered on your home and the
						stored distance is inside its radius; a searched place hides it.
						The nearest card repeats it only when it is closer than the live
						nearest rows.
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
					review-worthy) reports near your home and sends a notification when
					one is a species <strong>you still need</strong> — "Lifer nearby:
					Snail Kite · Sweetwater Wetlands · 12 mi from home." Notifications
					come from the birds app itself — no other app needed. One-time
					setup, on each device you want alerted:
				</p>
				<ol>
					<li>
						<strong>On iPhone: use the installed app</strong> — notifications
						only work from the Home-Screen version. If you haven't installed
						it: open the site in Safari → Share → <em>Add to Home Screen</em>.
					</li>
					<li>
						Open Settings → <strong>Need alerts</strong> → tap
						<strong>🔔 Enable notifications on this device</strong> and Allow
						when your phone asks.
					</li>
					<li>
						Tap <strong>Send test notification</strong> — it should appear
						like a normal notification from <strong>birds</strong>.
					</li>
					<li>
						Pick a radius and re-alert window, tick
						<strong>Enable need alerts</strong>, and save. Done.
					</li>
				</ol>
				<ul>
					<li>
						Alerts need your <strong>home location</strong> and
						<strong>eBird API key</strong> set (distances are measured from
						home, and the scan runs under your own eBird account).
					</li>
					<li>
						The <a href="/alerts">Alerts</a> page keeps every alert as sent,
						with a <strong>species page →</strong> link on each row, links to
						the triggering eBird checklists, and each report's own local
						observation time.
					</li>
					<li>
						Each account gets its own alerts (matched to that person's life
						list); enroll as many of your own devices as you like. Settings
						lists every enrolled device by name ("iPhone · Safari") with when
						it was enrolled, marks the one you're holding, and each has a
						<strong>Remove</strong> button to stop its alerts. A device
						enrolled before naming existed shows a generic label — tap
						Enable again on that device to name it.
					</li>
					<li>
						You're alerted about a species at most once per re-alert window
						(default 7 days), at most 5 alerts per scan, and
						"(unconfirmed)" in the title means the report hasn't been
						reviewed yet. Every report alerts with its full location —
						including personal (non-hotspot) locations — and tapping the
						notification opens the eBird checklist that triggered it (or the
						species page when eBird has no checklist link). The
						<a href="/alerts">Alerts page</a> lists every triggering report,
						linked whenever eBird provides the checklist. The time on the
						right of each row is when the alert was sent. For the first 24
						hours it uses minutes or hours; after that it uses local calendar
						days, so older alerts from the same day show the same age. The
						sighting clock stays on the report line.
					</li>
					<li>
						No notification arriving? Check your phone allows notifications
						for the birds app, and that Focus/Do&nbsp;Not&nbsp;Disturb isn't
						silencing it — <strong>quiet hours</strong> = your Focus schedule.
					</li>
					<li>
						Dismissed a notification too fast? Every alert also lands on the
						<a href="/alerts"><strong>Alerts page</strong></a> (menu → 🔔
						Alerts), exactly as it was sent.
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

		<!-- Admin: AI & Cost -->
		<button
			class="toggle"
			class:open={open === 'worker-control'}
			aria-expanded={open === 'worker-control'}
			onclick={() => toggle('worker-control')}
		>
			<span class="ico">⏸</span>
			<span class="title">Admin: Worker control</span>
			<span class="chev">{open === 'worker-control' ? '▾' : '▸'}</span>
		</button>
		{#if open === 'worker-control'}
			<div class="body">
				<p class="lead">
					Admins can pause and resume the background worker from the
					<strong>Status</strong> tab on the Admin page.
				</p>
				<ul>
					<li>
						<strong>Pause is cooperative</strong> — an API request already in flight
						finishes so a paid result is not thrown away. The worker then preserves
						the current job and stops before the next species or location.
					</li>
					<li>
						Queued work remains visible and does not consume retry attempts while
						paused. Choose <strong>Resume worker</strong> to continue the same queue.
					</li>
					<li>
						The pause setting survives worker restarts and deployments until an
						admin explicitly resumes it.
					</li>
				</ul>
			</div>
		{/if}

		<!-- Admin: AI & Cost -->
		<button
			class="toggle"
			class:open={open === 'ai-cost'}
			aria-expanded={open === 'ai-cost'}
			onclick={() => toggle('ai-cost')}
		>
			<span class="ico">🤖</span>
			<span class="title">Admin: AI &amp; Cost</span>
			<span class="chev">{open === 'ai-cost' ? '▾' : '▸'}</span>
		</button>
		{#if open === 'ai-cost'}
			<div class="body">
				<p class="lead">
					Admins only — the <strong>AI &amp; Cost</strong> tab on the Admin page
					controls which Claude model powers each AI surface and shows what
					it's costing.
				</p>
				<ul>
					<li>
						<strong>Model choice is per surface</strong> — Enrichment (worker
						batch jobs) and Guidance (live trip requests) are chosen
						independently. Picking a different model opens a confirmation
						showing the current and new rates and the cost multiplier; the
						change <strong>applies to future calls only</strong> — nothing
						already generated is regenerated.
					</li>
					<li>
						<strong>The meter stores tokens, not dollars</strong> — every AI
						call's token counts are recorded, and dollars are computed at
						read time using the rates in effect when each call ran, so
						historical spend never reprices when rates change. Today /
						7-day / 30-day / all-time totals sit above the model controls.
					</li>
					<li>
						<strong>Compare Lab runs are real spend</strong> — benchmarking a
						species across several models calls each one for real and is
						included in the totals above, same as any other AI call.
					</li>
					<li>
						A call can be <strong>served by a different model than
						requested</strong> when the provider falls back — those rows show
						"requested → served" so the discrepancy is never hidden.
					</li>
					<li>
						The <strong>ledger starts at deploy</strong> — recent calls before
						this feature shipped were not recorded and are not shown.
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
