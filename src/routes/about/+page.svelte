<script lang="ts">
	// Collapsible version history — multiple sections can be toggled or all expanded.
	let openVersions = $state<Record<string, boolean>>({
		'v0.1.6': true,
		'v0.1.5': false,
		'v0.1.4': false,
		'v0.1.3': false,
		'v0.1.2': false,
		'v0.1.1': false,
		'v0.1.0': false,
		'v0.0.9': false,
		'v0.0.8': false,
		'v0.0.5': false,
		'v0.0.1': false
	});

	function toggleVersion(ver: string) {
		openVersions[ver] = !openVersions[ver];
	}

	function toggleAll(expand: boolean) {
		for (const key of Object.keys(openVersions)) {
			openVersions[key] = expand;
		}
	}
</script>

<svelte:head>
	<title>About — birds</title>
</svelte:head>

<div class="page">
	<header class="page-head">
		<h1>About birds</h1>
		<p class="sub">
			Personal birding companion, trip planner, and field guide.
		</p>
	</header>

	<section class="card">
		<h2>Overview</h2>
		<p class="lead">
			<strong>birds</strong> is a personal birding application built for Gaylon Vorwaller to
			find target species (“needs” not yet on the life list), plan curated birding trips,
			explore seasonal migration forecasts from ten years of eBird checklists, and research
			species with an enriched field guide.
		</p>

		<div class="info-grid">
			<div class="info-block">
				<h3>🪶 Purpose &amp; Focus</h3>
				<p>
					Tailored around <em>your needs</em> — surfacing the birds you haven't seen yet based
					on real-time sightings, regional abundance, and curated driving routes.
				</p>
			</div>
			<div class="info-block">
				<h3>⚡ Architecture</h3>
				<p>
					Built with SvelteKit 2, Svelte 5 (Runes), TypeScript, Vite, and PostgreSQL with
					an asynchronous background worker for data ingestion and enrichment.
				</p>
			</div>
		</div>
	</section>

	<section class="card">
		<h2>Data Sources &amp; Integrations</h2>
		<ul class="data-sources">
			<li>
				<strong>eBird (Cornell Lab of Ornithology)</strong> — Powers life list sync, nearby
				observations, notable/rare sighting alerts, hotspot directories, and decade-long
				frequency bar charts.
			</li>
			<li>
				<strong>Wikipedia &amp; Wikidata</strong> — Provides global taxonomy mapping, IUCN
				conservation statuses, physical dimensions (mass, wingspan), and natural history
				articles.
			</li>
			<li>
				<strong>Wikimedia Commons &amp; xeno-canto</strong> — Supplies sample reference photos
				and audio recordings (songs and calls) for field guide identification.
			</li>
			<li>
				<strong>gaylon.photos</strong> — Integrates personal bird photography matched to
				species.
			</li>
			<li>
				<strong>OpenStreetMap &amp; Google Maps</strong> — Supplies geographic coordinates,
				satellite views, and turn-by-turn driving directions for trip routes.
			</li>
		</ul>
	</section>

	<section class="card">
		<div class="card-head">
			<h2>Version History</h2>
			<div class="actions">
				<button type="button" class="btn-link" onclick={() => toggleAll(true)}>Expand all</button>
				<span class="sep">·</span>
				<button type="button" class="btn-link" onclick={() => toggleAll(false)}>Collapse all</button>
			</div>
		</div>

		<div class="version-list">
			<!-- v0.1.6 -->
			<div class="version-entry">
				<button
					type="button"
					class="version-toggle"
					class:open={openVersions['v0.1.6']}
					aria-expanded={openVersions['v0.1.6']}
					onclick={() => toggleVersion('v0.1.6')}
				>
					<span class="v-tag current">v0.1.6</span>
					<span class="v-title">Migration Ribbon</span>
					<span class="v-date">September 2026</span>
					<span class="chev">{openVersions['v0.1.6'] ? '▾' : '▸'}</span>
				</button>
				{#if openVersions['v0.1.6']}
					<div class="version-body">
						<ul>
							<li>
								<strong>Where it is through the year</strong> — every species page
								now carries a migration ribbon above Best time of year: latitude
								bands by month, colored by how often the species was reported,
								world-wide by default and switchable to any single continent or
								all of them side by side. An equal-weight average keeps one
								heavily-birded country from drowning out the rest; a by-checklist
								average is one tap away. Tap any cell to see the loaded regions
								behind it, and tap a region there to chart it in Best time of
								year as a third pick alongside the closest and best regions. A
								Play button steps through the year automatically (off under
								reduced motion), and the chart works the same way on a phone as
								on a desktop.
							</li>
						</ul>
					</div>
				{/if}
			</div>

			<!-- v0.1.5 -->
			<div class="version-entry">
				<button
					type="button"
					class="version-toggle"
					class:open={openVersions['v0.1.5']}
					aria-expanded={openVersions['v0.1.5']}
					onclick={() => toggleVersion('v0.1.5')}
				>
					<span class="v-tag">v0.1.5</span>
					<span class="v-title">Trip Field Sheets &amp; Sharing</span>
					<span class="v-date">August 2026</span>
					<span class="chev">{openVersions['v0.1.5'] ? '▾' : '▸'}</span>
				</button>
				{#if openVersions['v0.1.5']}
					<div class="version-body">
						<ul>
							<li>
								<strong>Side-by-side seasonal comparison</strong> — species pages
								now show the closest loaded region with sightings and the most
								findable region overall as two tappable choices, with the chart
								following your pick. Region names include their country where
								that isn't obvious ("Bornholm, Denmark"), and stray codes like
								"[SE-01]" no longer leak into region names. “Closest” now measures
								to the region's reported edge (and recognizes when you're already
								inside it), while the card makes clear that frequency is still a
								whole-region average.
							</li>
							<li>
								<strong>Nearest reports that answer</strong> — asking for the
								closest report of a common bird far from its range used to spin
								for a minute and give up, because eBird's nearest-report search
								cannot answer that shape of question. The app now races that
								endpoint against a search of its own region list outward from
								home, and tells you when the region search won. A search that
								comes up empty says how many regions it covered instead of
								claiming the bird is nowhere.
							</li>
							<li>
								<strong>Home loads in stages</strong> — the needs and rare lists now
								appear as soon as the area reports arrive instead of waiting on a
								per-species lookup for every bird on the page; the place
								breakdowns, place search and per-species counts fill in behind
								them. Needs rows no longer show a location or report count until
								the data that supports it has actually arrived, so a number never
								corrects itself upward a second after you read it.
							</li>
							<li>
								<strong>Faster, key-free region pickers</strong> — country and
								region lists now come from
								built-in reference data instead of live eBird lookups, so they
								load instantly and work even before an eBird API key is set. The
								data-loading country picker is now an alphabetical to-do list:
								countries disappear after a countrywide load or complete regional
								coverage, while forecast browsing remains
								nearest-first when a home is saved.
							</li>
							<li>
								<strong>World data without the wall of rows</strong> — loaded data now
								drills from geographic area to country to state or region, with all
								U.S. states under United States. Closed levels stay out of the page
								until opened, keeping the all-world inventory practical on a phone.
							</li>
							<li>
								<strong>Breadcrumb out of the species forecast</strong> — following
								"Where should I go?" from a species page now leaves a trail back to
								that bird and to the field guide (or wherever the drill started).
							</li>
							<li>
								<strong>Similar species, rebuilt on real misidentifications</strong>
								— confusion pairs now come from iNaturalist observer
								misidentification data instead of eBird reporting groups, so
								obvious look-alike pairs (Great vs. Lesser Black-backed Gull)
								finally appear. Existing distinguishing notes are preserved;
								unmappable partners are listed rather than dropped.
							</li>
							<li>
								<strong>Worker pause control</strong> — Admins can pause long-running
								background loads or enrichment at a safe unit boundary, then resume
								the preserved queue without consuming a retry.
							</li>
							<li>
								<strong>Trip export &amp; sharing</strong> — trips export as a
								self-contained HTML field sheet (needs lists, field tips, map
								links) or Markdown; a new in-app Share panel works safely from
								the home-screen app; and revocable share links let friends view
								a trip's field sheet without an account.
							</li>
						</ul>
					</div>
				{/if}
			</div>

			<!-- v0.1.4 -->
			<div class="version-entry">
				<button
					type="button"
					class="version-toggle"
					class:open={openVersions['v0.1.4']}
					aria-expanded={openVersions['v0.1.4']}
					onclick={() => toggleVersion('v0.1.4')}
				>
					<span class="v-tag">v0.1.4</span>
					<span class="v-title">AI Model Control &amp; Cost Meter</span>
					<span class="v-date">August 2026</span>
					<span class="chev">{openVersions['v0.1.4'] ? '▾' : '▸'}</span>
				</button>
				{#if openVersions['v0.1.4']}
					<div class="version-body">
						<ul>
							<li>
								<strong>AI &amp; Cost admin tab</strong> — Admins can now choose
								which Claude model powers enrichment (batch jobs) and guidance
								(live trip requests) independently, see a live dollars-and-tokens
								usage meter (today / 7-day / 30-day / all-time), and run a
								Compare Lab that benchmarks a species across models side by side.
							</li>
						</ul>
					</div>
				{/if}
			</div>

			<!-- v0.1.3 -->
			<div class="version-entry">
				<button
					type="button"
					class="version-toggle"
					class:open={openVersions['v0.1.3']}
					aria-expanded={openVersions['v0.1.3']}
					onclick={() => toggleVersion('v0.1.3')}
				>
					<span class="v-tag">v0.1.3</span>
					<span class="v-title">Similar Species Links</span>
					<span class="v-date">August 2026</span>
					<span class="chev">{openVersions['v0.1.3'] ? '▾' : '▸'}</span>
				</button>
				{#if openVersions['v0.1.3']}
					<div class="version-body">
						<ul>
							<li>
								<strong>Similar &amp; Related Species</strong> — Field guide pages now link
								to species eBird itself treats as confusable (from its own slash-taxa
								reporting groups) and to same-genus relatives, each with a reference photo,
								Seen/Need badge, and an AI-written note on telling them apart.
							</li>
						</ul>
					</div>
				{/if}
			</div>

			<!-- v0.1.2 -->
			<div class="version-entry">
				<button
					type="button"
					class="version-toggle"
					class:open={openVersions['v0.1.2']}
					aria-expanded={openVersions['v0.1.2']}
					onclick={() => toggleVersion('v0.1.2')}
				>
					<span class="v-tag">v0.1.2</span>
					<span class="v-title">County Hotspot Sweep</span>
					<span class="v-date">August 2026</span>
					<span class="chev">{openVersions['v0.1.2'] ? '▾' : '▸'}</span>
				</button>
				{#if openVersions['v0.1.2']}
					<div class="version-body">
						<ul>
							<li>
								<strong>Load every hotspot in a county</strong> — One action on the forecast
								data page's county rows, and on any hotspot page, queues all of that county's
								eBird hotspots at once instead of loading them a few at a time. Already-loaded
								hotspots are skipped, so re-running only fills gaps.
							</li>
						</ul>
					</div>
				{/if}
			</div>

			<!-- v0.1.1 -->
			<div class="version-entry">
				<button
					type="button"
					class="version-toggle"
					class:open={openVersions['v0.1.1']}
					aria-expanded={openVersions['v0.1.1']}
					onclick={() => toggleVersion('v0.1.1')}
				>
					<span class="v-tag">v0.1.1</span>
					<span class="v-title">International Region Loads</span>
					<span class="v-date">August 2026</span>
					<span class="chev">{openVersions['v0.1.1'] ? '▾' : '▸'}</span>
				</button>
				{#if openVersions['v0.1.1']}
					<div class="version-body">
						<ul>
							<li>
								<strong>International Region Loads</strong> — A Country picker on the forecast
								data and species pages now reaches any of eBird's countries, not just US states;
								countries with coarse or no state-level divisions can load a single "Entire
								{'{Country}'}" whole-country dataset instead.
							</li>
						</ul>
					</div>
				{/if}
			</div>

			<!-- v0.1.0 -->
			<div class="version-entry">
				<button
					type="button"
					class="version-toggle"
					class:open={openVersions['v0.1.0']}
					aria-expanded={openVersions['v0.1.0']}
					onclick={() => toggleVersion('v0.1.0')}
				>
					<span class="v-tag">v0.1.0</span>
					<span class="v-title">Field Guide Media, Life List Map &amp; Universal Search</span>
					<span class="v-date">August 2026</span>
					<span class="chev">{openVersions['v0.1.0'] ? '▾' : '▸'}</span>
				</button>
				{#if openVersions['v0.1.0']}
					<div class="version-body">
						<ul>
							<li>
								<strong>Field Guide Sample Photos &amp; Audio</strong> — Embedded reference
								photos from Wikimedia Commons and native dual-audio players (Song &amp; Call)
								with coordinated single-playback from xeno-canto and Commons.
							</li>
							<li>
								<strong>Life List Map &amp; Milestone Timeline</strong> — Interactive map showing
								all lifetime birding locations with resolved coordinates, plus a year-by-year
								lifer milestone timeline (#100, #200, etc.).
							</li>
							<li>
								<strong>AI Field Craft &amp; Tidal Tags</strong> — Synthesized fieldcraft notes
								explaining how, when, and where to find birds, with specialized tide and habitat
								filter chips.
							</li>
							<li>
								<strong>Universal Species Search</strong> — Zero-empty search covering the full
								eBird taxonomy by common name, scientific name, or four-letter code.
							</li>
						</ul>
					</div>
				{/if}
			</div>

			<!-- v0.0.9 -->
			<div class="version-entry">
				<button
					type="button"
					class="version-toggle"
					class:open={openVersions['v0.0.9']}
					aria-expanded={openVersions['v0.0.9']}
					onclick={() => toggleVersion('v0.0.9')}
				>
					<span class="v-tag">v0.0.9</span>
					<span class="v-title">Hotspot Workspaces &amp; County Forecasts</span>
					<span class="v-date">August 2026</span>
					<span class="chev">{openVersions['v0.0.9'] ? '▾' : '▸'}</span>
				</button>
				{#if openVersions['v0.0.9']}
					<div class="version-body">
						<ul>
							<li>
								<strong>Hotspot Pages</strong> (<code>/hotspots/[locId]</code>) — Dedicated
								workspace for any eBird hotspot with live Recent sightings and Monthly frequency
								breakdowns.
							</li>
							<li>
								<strong>48-Week Migration Timing</strong> — High-resolution weekly frequency
								charts with arrival and departure timing estimates.
							</li>
							<li>
								<strong>Statewide County Ingestion</strong> — One-click background jobs to
								ingest full county frequency data across an entire state.
							</li>
						</ul>
					</div>
				{/if}
			</div>

			<!-- v0.0.8 -->
			<div class="version-entry">
				<button
					type="button"
					class="version-toggle"
					class:open={openVersions['v0.0.8']}
					aria-expanded={openVersions['v0.0.8']}
					onclick={() => toggleVersion('v0.0.8')}
				>
					<span class="v-tag">v0.0.8</span>
					<span class="v-title">Need Alerts &amp; Web Push Notifications</span>
					<span class="v-date">August 2026</span>
					<span class="chev">{openVersions['v0.0.8'] ? '▾' : '▸'}</span>
				</button>
				{#if openVersions['v0.0.8']}
					<div class="version-body">
						<ul>
							<li>
								<strong>Automated Need Scans</strong> — Periodic background check for rare or
								notable eBird reports of needed species within your home radius.
							</li>
							<li>
								<strong>Native Web Push</strong> — Push notifications delivered to installed PWA
								devices (iOS and Android) and desktop browsers.
							</li>
							<li>
								<strong>Alerts History Hub</strong> — Dedicated alerts page with direct links to
								triggering eBird checklists.
							</li>
							<li>
								<strong>Device Management</strong> — Enrolled device inventory in Settings with
								per-device unenrollment controls.
							</li>
						</ul>
					</div>
				{/if}
			</div>

			<!-- v0.0.5 -->
			<div class="version-entry">
				<button
					type="button"
					class="version-toggle"
					class:open={openVersions['v0.0.5']}
					aria-expanded={openVersions['v0.0.5']}
					onclick={() => toggleVersion('v0.0.5')}
				>
					<span class="v-tag">v0.0.5</span>
					<span class="v-title">Trip Planner &amp; Historical Forecasts</span>
					<span class="v-date">July 2026</span>
					<span class="chev">{openVersions['v0.0.5'] ? '▾' : '▸'}</span>
				</button>
				{#if openVersions['v0.0.5']}
					<div class="version-body">
						<ul>
							<li>
								<strong>Interactive Trip Planner</strong> — Multi-stop route builder prioritizing
								hotspots with the highest density of needed species.
							</li>
							<li>
								<strong>Trip Weather &amp; Field Tips</strong> — Location-specific weather
								forecasts and AI-generated field advice per stop.
							</li>
							<li>
								<strong>Forecast Engine</strong> — Dual-mode forecasting (“What can I see?” and
								“Where can I find this bird?”) based on historical eBird checklist frequencies.
							</li>
						</ul>
					</div>
				{/if}
			</div>

			<!-- v0.0.1 -->
			<div class="version-entry">
				<button
					type="button"
					class="version-toggle"
					class:open={openVersions['v0.0.1']}
					aria-expanded={openVersions['v0.0.1']}
					onclick={() => toggleVersion('v0.0.1')}
				>
					<span class="v-tag">v0.0.1</span>
					<span class="v-title">Core Foundation &amp; Sightings</span>
					<span class="v-date">June 2026</span>
					<span class="chev">{openVersions['v0.0.1'] ? '▾' : '▸'}</span>
				</button>
				{#if openVersions['v0.0.1']}
					<div class="version-body">
						<ul>
							<li>
								<strong>Home Target Sightings</strong> — Real-time list of species reported near
								home or searched location, with clear Seen and Need badges.
							</li>
							<li>
								<strong>Life List Integration</strong> — Automatic sync with eBird life lists
								via API key.
							</li>
							<li>
								<strong>Photo Gallery Integration</strong> — Per-species photo strips linked to
								gaylon.photos.
							</li>
							<li>
								<strong>Multi-user Security</strong> — Admin controls and read-only family viewer
								roles.
							</li>
						</ul>
					</div>
				{/if}
			</div>
		</div>
	</section>

	<footer class="about-foot">
		<p>
			Data from <a href="https://ebird.org" target="_blank" rel="noopener">eBird.org</a>
			· species notes from <a href="https://en.wikipedia.org" target="_blank" rel="noopener">Wikipedia</a> (CC BY-SA 4.0).
		</p>
		<p class="muted">
			Designed &amp; built by Gaylon Vorwaller.
		</p>
	</footer>
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
	.card {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 16px;
		margin-bottom: 12px;
	}
	.card h2 {
		font-size: 1.05rem;
		margin-bottom: 10px;
	}
	.card-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 12px;
		flex-wrap: wrap;
		gap: 8px;
	}
	.lead {
		font-size: 0.95rem;
		line-height: 1.6;
		margin-bottom: 12px;
	}
	.info-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 12px;
		margin-top: 12px;
	}
	@media (min-width: 600px) {
		.info-grid {
			grid-template-columns: 1fr 1fr;
		}
	}
	.info-block {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 12px;
	}
	.info-block h3 {
		font-size: 0.92rem;
		font-weight: 700;
		margin-bottom: 6px;
	}
	.info-block p {
		font-size: 0.86rem;
		line-height: 1.5;
		color: var(--text);
		margin: 0;
	}

	.data-sources {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.data-sources li {
		position: relative;
		padding: 6px 0 6px 18px;
		font-size: 0.88rem;
		line-height: 1.55;
	}
	.data-sources li::before {
		content: '•';
		position: absolute;
		left: 2px;
		color: var(--accent);
		font-weight: 700;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.82rem;
	}
	.btn-link {
		background: none;
		border: none;
		color: var(--link);
		cursor: pointer;
		padding: 0;
		font: inherit;
		font-size: inherit;
		text-decoration: underline;
	}
	.btn-link:hover {
		color: var(--accent);
	}
	.sep {
		color: var(--muted);
	}

	.version-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.version-entry {
		display: flex;
		flex-direction: column;
	}
	.version-toggle {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		text-align: left;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text);
		font-family: inherit;
		font-size: 0.9rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s ease;
	}
	.version-toggle:hover {
		background: var(--card);
	}
	.version-toggle.open {
		border-color: var(--accent);
		background: var(--accent-soft);
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
	}
	.v-tag {
		font-size: 0.76rem;
		font-weight: 700;
		padding: 2px 7px;
		border-radius: 10px;
		background: #e9ecef;
		color: #495057;
	}
	.v-tag.current {
		background: var(--accent);
		color: #ffffff;
	}
	.v-title {
		flex: 1;
		font-size: 0.88rem;
		font-weight: 600;
	}
	.v-date {
		font-size: 0.78rem;
		color: var(--muted);
		font-weight: 400;
		margin-right: 4px;
	}
	.chev {
		font-size: 0.78rem;
		color: var(--muted);
		flex-shrink: 0;
	}
	.version-body {
		border: 1px solid var(--accent);
		border-top: none;
		border-radius: 0 0 6px 6px;
		padding: 12px 16px;
		background: var(--card);
		font-size: 0.86rem;
		line-height: 1.6;
	}
	.version-body ul {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.version-body li {
		position: relative;
		padding: 4px 0 4px 16px;
	}
	.version-body li::before {
		content: '–';
		position: absolute;
		left: 0;
		color: var(--accent);
		font-weight: 700;
	}

	.about-foot {
		margin-top: 16px;
		text-align: center;
		font-size: 0.82rem;
		color: var(--muted);
		line-height: 1.6;
	}
</style>
