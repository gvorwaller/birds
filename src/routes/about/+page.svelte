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
							<li><strong>Parts of a Bird</strong> — a new Field Guide tab with drawings of a songbird, a shorebird, a duck and a gull. Tap a part on a drawing, or its name below it, to highlight it and see what to look for there; "All feather groups" adds the wing and tail feather groups. Each bird is a section you can open or close, and a link can point straight to one part, such as the gull's mirrors.</li>
							<li><strong>Parts of a Bird in flight</strong> — every bird is also drawn with its wings spread, from above and from below. Pick a part, such as the greater coverts or a duck's speculum, then switch views to see where the same feathers sit on the open wing. The flight views add the wing linings, the "wingpits" (axillaries) and other parts that only show in flight, and "One wing, larger" enlarges the drawing on a phone.</li>
							<li><strong>Part links stay on the bird's own drawing</strong> — on a species page, "wing coverts" on a songbird now opens the songbird drawing (it used to open the shorebird), "tarsus" on a songbird opens its legs, and "rectrices" (tail feathers) opens the bird's own tail where its drawing has one (a grebe has almost no tail, so its pages use the songbird's). Marks only some birds show, such as wing bars or a duck's speculum, still open the drawing that shows them.</li>
							<li><strong>Five more drawings in Parts of a Bird</strong> — a woodpecker (an adult male Downy Woodpecker clinging to a trunk, with a close-up of its two-forward, two-back foot), a hummingbird (an adult male Ruby-throated Hummingbird with its red gorget), a gamebird (an adult male Ruffed Grouse showing its crest, comb, ruff and banded fan tail), a loon (an adult Common Loon in breeding plumage, with its necklace and checkered back) and a grebe (an adult Horned Grebe in breeding plumage, with its golden "horns" and a close-up of a lobed foot), each standing, perched or swimming and in flight from above and below. Their text compares the small marks that tell look-alikes apart, such as a Downy's and a Hairy's bill and outer tail feathers, the gorgets of Anna's, Black-chinned and Rufous Hummingbirds, grouse and ptarmigan tails, including the Black Grouse's lyre, the Red-throated and Arctic Loons, and the Eared and Red-necked Grebes. Species pages in those groups now link their part names to them, and new words such as gorget, eye comb, ruff and ear tufts become links on those pages.</li>
							<li><strong>A tubenose in Parts of a Bird</strong> — a ninth drawing, an adult Sooty Shearwater swimming and in flight, with a close-up of its bill. It shows the nostril tubes that give tubenoses their name and the hooked tip, one of the horny plates the bill is made of, plus the silvery stripe along the underwing. The text compares bills, head patterns, underwings, rumps and tails across shearwaters, the Northern Fulmar, the Black-footed Albatross and storm-petrels. Species pages for albatrosses, shearwaters, petrels, fulmars and storm-petrels now link their part names to it.</li>
							<li><strong>An auk in Parts of a Bird</strong> — an eighth drawing, an adult Common Murre (Common Guillemot) in breeding plumage, standing upright on a rock and in flight. It shows the dark head and neck meeting the white breast, the streaked flanks, and the webbed feet, which show beside the short tail from below in flight. The text compares the bill, face and wing patterns of look-alikes: the Thick-billed Murre, the Razorbill, puffins, the Rhinoceros Auklet and the Black and Pigeon Guillemots. Species pages for murres, guillemots, puffins, auklets and murrelets now link their part names to it.</li>
							<li><strong>A cormorant in Parts of a Bird</strong> — a seventh drawing, an adult Double-crested Cormorant in breeding plumage, perched and in flight. It adds the bare orange gular skin (throat pouch) and lores, the breeding crests, the hooked bill, the scaly back and wing coverts, and the webbed feet, with all four toes joined. The text compares the throat skin, bill and tail of look-alikes: the Neotropic, Great and Brandt's Cormorants and the Anhinga. Species pages for cormorants, the Anhinga, gannets, boobies, pelicans and frigatebirds now link their part names to it.</li>
							<li><strong>A heron in Parts of a Bird</strong> — a sixth drawing, an adult Great Blue Heron in breeding plumage, standing and in flight. It adds the head, breast and back plumes, the bare lores, the streaked foreneck, the flank stripe, the red-brown thighs, and the bare tibia and tarsus of a long-legged wader. The flight views show the neck folded back into an S and the legs trailing past the tail, the way herons fly (storks, ibises and cranes stretch their necks out). Species pages for herons, egrets, bitterns, storks, ibises, spoonbills and cranes now link their part names to it.</li>
							<li><strong>A raptor in Parts of a Bird</strong> — a fifth drawing, an adult Red-tailed Hawk, perched and soaring. It adds the parts used for hawks and other birds of prey: the cere, the bare or feathered tarsus, the belly band, the patagial bar and carpal patch under the wing, the spread "fingers" of the wingtip, the tail's subterminal band, and where the folded wingtips fall against the tail. Species pages for hawks, eagles, falcons, vultures and owls now link their part names to it.</li>
							<li><strong>Birds of the World link for subscribers</strong> — tick <em>I subscribe to Birds of the World</em> in Settings, and every species page shows a Birds of the World ↗ link under Learn more, straight to that bird's full account. You sign in there with your Cornell Lab (eBird) account; the app stores no password for it. Hybrids, forms and other groups that Birds of the World doesn't cover show no link.</li>
							<li><strong>Slow pages for admins</strong> — Admin's Metrics tab now lists every request slower than 0.75 seconds for 30 days: per page, how many were slow this week against the week before, typical and worst times, and whether the page got slower; a deploy picker shows whether a release made a page slower, and the latest slow requests show where their time went. Fast requests are not recorded, so it shows what is slow, not how fast the site usually is.</li>
							<li><strong>eBird traffic for admins</strong> — a new Admin tab, Metrics, counts every request the app makes to eBird over the last 7 and 30 days: which kinds of request, how often saved eBird data answered instead, typical time and data size, rate limits and failures, which page or background job asked, and a bar for each day. It is the starting point for making eBird fetching cheaper. Only the kind of request is stored, never a place, species or account.</li>
							<li><strong>System health for admins</strong> — Admin's Server health tab now opens with cards that refresh every 30 seconds: whether the background worker is running, exact job-queue counts for every kind of job (running, waiting, recent failures, last success, run times, and when each scheduled check next runs), free disk space and database size and settings, when the nightly backup last ran (flagged once it is over 26 hours old), the biggest tables, and how much bar-chart data and species information is loaded. If one card can't be read it says why, and the rest still show.</li>
							<li><strong>Part names link to Parts of a Bird</strong> — on a species page, technical part names such as supercilium, tertials, wing bars or speculum, in the Similar species notes and in the About card's Description section, are now links with a dotted underline. A link opens Parts of a Bird with that part highlighted on the drawing for the bird's group (songbird, shorebird, duck or gull, or another drawing when the bird's own lacks that part), and Back returns to the same place on the species page. Everyday words such as crown, back or tail are not linked.</li>
							<li><strong>Nearest reports for every bird</strong> — a species page's Nearest reports card and its “Check nearest reports” button now appear for birds already on your life list, not only for ones you still need. When you see a bird out of season or outside its usual range, it shows where else it is being reported right now.</li>
							<li><strong>Hotspot page: eBird's About section and checklist count</strong> — a hotspot's eBird button now reads "About this hotspot on eBird ↗": eBird's own page has the birder-written description, how to bird there, and parking, restrooms and fees, which eBird doesn't make available to other apps. Next to eBird's all-time species count the page also shows its all-time checklist count, a sense of how heavily the place is birded.</li>
							<li><strong>Hotspots with no county in the Field Guide</strong> — eBird records some hotspots directly under a state or region, with no county: most loaded hotspots in Norway, Iceland, Sweden and Moscow, and Everglades NP in Florida. They can now be chosen under Verified hotspot once the state is chosen (with no county), and their species counts on Hotspots &amp; data, in Find results and on their hotspot page now open their Field Guide list.</li>
							<li><strong>Delete an account (admin)</strong> — in Settings → User admin, an administrator can delete another account by typing its username to confirm. Its life list, trips, eBird sign-in, alerts, and Viewed and Special interest lists go with it; jobs it already ran stay in the job history as "a deleted account". An account a viewer displays, an account whose job is running, and the account that runs the scheduled background jobs can't be deleted.</li>
							<li><strong>Species totals on Hotspots &amp; data open at once</strong> — the distinct-species totals for each area, country, state and the whole world are now kept up to date as each load finishes, instead of being counted when the page opens, so the page no longer waits on "Counting species…" and the totals always include everything loaded so far. A species counts when it was reported in a week that had checklists, the same rule the Field Guide and the forecasts use. A place whose total can't be worked out says "count unavailable", never a guessed "0 species".</li>
							<li><strong>Trip start &amp; end point</strong> — give a trip a start and end, such as your hotel, chosen from your saved home, one of its stops, or a place on the map. The map then draws and totals the real day's drive, from there through the stops and back, and Optimize order plans the best loop from it. On the trip's dates Navigate starts from where your phone is and finishes back there; on other days (planning at home) it starts at the start &amp; end point too. Your exports name it; share links never show it.</li>
							<li><strong>Check off trip stops</strong> — each stop on a saved trip has a box to tick once you've been there. A checked stop is struck through and marked Visited, its map pin turns grey, the Stops heading and the Trips list count how many are visited, and Navigate goes only through the stops left. Exports and share links mark visited stops. The owner and the owner's family viewers share the check-offs; it is the only trip change a viewer can make.</li>
							<li><strong>Pick the Home search area on a map</strong> — beside View a different area, 📍 Pick on map opens the same map used elsewhere in the app. Search for a place or tap the map, then choose Search near … and Home searches around that exact point with your current Within and Window. Typing a place still works as before, and a shared link keeps the point.</li>
							<li><strong>Home remembers your last search</strong> — coming back to Home reopens the place or map point, Within and Window you last searched, on any device you sign in to. Reset home defaults goes back to your saved home location and radius but keeps the Window you chose; saving a new home location in Settings forgets the whole search. Without a saved home, Clear this search forgets all of it. Each login, including a family viewer, keeps its own.</li>
							<li><strong>All, Need and Seen on Home</strong> — the needs list on Home has the same three choices as the Field Guide: every species reported around your place in the chosen window, only your needs (still the default), or only birds already on your life list. Seen birds show their latest report; needs keep their full place breakdown. Switching does not contact eBird again.</li>
							<li><strong>Faster pickers and clearer user administration</strong> — type directly in the Species forecast Country picker and the Field Guide Bird family picker to find a choice. Settings has a separate User admin tab with account usage, provisioning, and viewer-owner controls for administrators.</li>
							<li><strong>AI no longer assigns species tags</strong> — tags such as <em>Habitat: open ocean</em> or a tide stage will come only from checkable rules that read each species' Wikipedia text, with the sentence that justifies each tag. As a first step, AI stopped producing tags entirely. Existing tags stay as they were until each one is replaced by a rule that has passed a blind accuracy test. Species added from now on show "Tags not yet available" rather than looking untagged, and a tag filter says how many species could not be checked yet. Field craft and similar-species notes are unchanged.</li>
							<li><strong>Collapsible Home with saved hotspot comparisons</strong> — every Home section opens expanded and can be folded to shorten the page. Compare hotspots results return after navigation or reload for the same account and exact search, with an explicit Refresh action when a new run is wanted.</li>
							<li><strong>Admin-assigned viewer life lists</strong> — Settings now lets an administrator choose and later change which owner account a read-only viewer displays. The viewer's Seen and Need results follow that owner, while Viewed, Special interest, appearance, and sign-in remain personal to the viewer.</li>
							<li><strong>Safer maintenance</strong> — eBird, NOAA tide, and National Weather Service payloads are checked for missing or renamed fields before they are cached, shared-database tests run without cross-file fixture races, and a manual enrichment run now shows its scope and chosen model and requires approval before work is queued.</li>
							<li><strong>All, Need and Seen in the Field Guide</strong> — three links under the Field Guide tabs show every matching species, only those not on your life list, or only those that are. The choice combines with your search, tags, family, Special-interest filter and any country, state, county, hotspot or map area, keeps exact counts and 100-species pages, and follows the life list the page displays (a family viewer sees the owner’s list, with their own Viewed and Special-interest markers). Results now share one species-row layout: thumbnail, names, Seen or Need with any personal markers, then match evidence. Choosing a list never changes your data or contacts eBird.</li>
							<li><strong>Find places on Hotspots &amp; data by name or map</strong> — search countries, first-level regions, loaded counties and verified eBird hotspots, or choose a point on the map and a radius from 1 to 200 miles. Results are complete, 50 per page with an exact total, and say how each place is known; a failed load without hotspot evidence stays labeled “reported location — hotspot status unverified.” Selecting a result opens the existing section, the Load form or the hotspot page with a link back to your search. Searching and selecting never load bird data or change Home.</li>
							<li><strong>Field Guide by county, hotspot or map</strong> — narrow the guide to a county or county-equivalent, one verified eBird hotspot, or a circle of 1 to 200 miles around a point you choose on the map. Each choice says exactly which loaded eBird history it uses, how many sources and years it covers, and when coverage is unavailable rather than empty. Choosing a place does not fetch new bird data from eBird, saves nothing and leaves your Home location alone, and your search, tags and shared-link options are kept.</li>
							<li><strong>Server health for admins</strong>: a new Admin tab shows current memory, a 7-day memory chart with restart limits, and each run of the web app and worker, so restarts can be spotted without server access.</li>
							<li><strong>From a species count to the list</strong> — on Hotspots &amp; data, country, state, county and hotspot species counts have a Field Guide link wherever the same loaded place can be selected there, already set to that place and All, ready for Need, Seen or tags. Back returns to the same row. A hotspot page links both its loaded count and, with the distinct wording <em>see loaded history</em>, its eBird all-time count. A hotspot's list needs its county loaded too; county lists can include loaded hotspot records beyond the county export's displayed count.</li>
							<li><strong>Field Guide filters wait for Apply</strong> — changes in Filters and sort are now a draft: nothing searches until you choose Apply filters, the panel shows when changes aren't applied yet, and Discard changes puts back what's applied. Place comes first, and each Place field (country, state, county and hotspot) is searchable as you type, ignoring case and accents, with every loaded choice reachable. The next list fills in straight from stored data, without reloading the page or contacting eBird. A map point is added with Use this point and applied with everything else.</li>
							<li><strong>Faster species-page navigation</strong> — an On this page menu lists the sections available for that bird and jumps directly to the answer. It reopens closed Similar species and seasonal sections when needed, keeps keyboard focus visible, and preserves the Field Guide search and return path.</li>
							<li><strong>Clearer Field Guide results</strong> — search results now appear before the detailed filter editor, show the active scope, preserve a shared link's extra options, and identify whether each match came from a name/code or from loaded descriptive notes.</li>
							<li><strong>Keyboard-ready navigation and map picking</strong> — the menu now behaves as a modal drawer: it moves focus to Close, keeps keyboard focus inside, closes with Escape, and returns you to the menu button when dismissed. Forecast’s map chooser opens at a named heading; Cancel discards its draft pin without changing the current forecast.</li>
							<li><strong>More named return paths</strong> — Field guide, taxonomy, collections, photos, life lists, Home, Nearest reports, Alerts and Forecast now keep the filtered page and selected row when you open a bird or hotspot. Multi-hop exploration through similar species and hotspots keeps the path, with an expandable oldest-first trail to return to any earlier step. Revisiting a page already on the path moves it to the end, so Back always leads to the page you just left. Life-list paths remain private to the signed-in viewer, even while a shared list is displayed.</li>
							<li><strong>Clear background-load recovery</strong> — hotspot history requests verify the exact eBird location before they enter the queue, while the shared status view distinguishes running, paused, scheduled, retrying, waiting for a worker, cancelled and completed work. Failed verification and incomplete coverage keep their recovery guidance visible.</li>
							<li><strong>Home stays usable during slow report loading</strong> — controls become available with the page, while place details load separately. Slow detail requests finish with clearly marked partial coverage, keeping all area-report species and details already received.</li>
							<li><strong>Recent-report evidence</strong> — Home and species pages now keep duplicate public reports from inflating totals, retain distinct checklist evidence, and label accepted, unconfirmed, and unavailable review status. Home also shows your scoped first-seen life-list records separately from public reports. Nearest reports offer explicit date and distance controls, merge recent and notable evidence, and disclose incomplete feed coverage.</li>
							<li><strong>Trip count context</strong> — planner counts now say whether they are My needs or All species, and saved stops retain the preview feed, window, location, fetch time and cached status. Saved trips show that planning snapshot separately from the current nearby life-list-needs count; legacy integer counts keep an unknown-scope label. Planning counts remain an area-feed preview, not a complete inventory of each location.</li>
							<li><strong>Comparable hotspot rankings</strong> — Compare hotspots checks each verified location's own recent public reports using the selected window, All or My needs scope, and notable filter. Results show progress and stale or failed coverage, pace live requests against eBird's limits, and visibly resume after a short rate-limit pause. The planner changes its route only after you choose Use compared ranking.</li>
							<li><strong>Trustworthy trip location identity</strong> — automatic trip suggestions now use only locations verified in eBird's hotspot reference data. Other reported places remain available for an explicit manual add and are labeled unverified; hotspot membership is not a guarantee of access.</li>
							<li><strong>Named navigation paths</strong> — trip, hotspot and species links preserve the place, report window and month you were using, with a visible return path and an explicit location choice when a hotspot has no usable coordinates for Forecast.</li>
							<li><strong>Relative colour for seasonal patterns</strong> — switch the ribbon between fixed reporting-rate colours and colours relative to the bird's peak. The legend identifies the peak; readout numbers stay absolute. Your choice is remembered for your account in this browser.</li>
							<li><strong>Checklist counts in the seasonal chart</strong> — the readout now shows how many of the contributing checklists reported the bird, alongside the rate. Counts are rounded estimates; equal-weight percentages still give countries and continents equal weight.</li>
							<li><strong>Strongest region this month</strong> — the seasonal chart now names the region with the highest reporting rate for your selected month, among the available regions with 40 or more checklists. Tap it to chart the region’s year. When the search is limited to 40 regions, the readout says so.</li>
							<li><strong>Special interest species</strong> — save birds you want to find, photograph or revisit. Your personal collection follows your account across devices, supports search and removal, and can filter Field Guide results. It stays separate from your life list and viewing history.</li>
							<li><strong>Family description gaps</strong> — improved scientific-name and redirect matching, scoped species/genus sources for sparse family pages, complete source attribution, and retries for selected gaps that preserve current descriptions.</li>
							<li><strong>Taxonomy for study</strong> — explore orders, families, and species in a new Field Guide tab, with two-way species links and personal Viewed badges. Filter by family, search banding codes, and choose taxonomic sorting. Browse species now shows result totals and pages of 100 so every match stays reachable. Family descriptions now populate automatically from Animal Diversity Web or matched Wikipedia sources, with Sonnet 5 drafting and checking, reliable passage-based evidence, source-specific attribution, automatic retries and refreshes, and separate Admin model and pause/resume controls.</li>
                            <li>
								<strong>Seasonal detail shown immediately</strong> — “Where it is through the year”
								starts expanded on each species page, showing all continents on phone and desktop. World remains available for a combined view. Use Hide to collapse it and Show
								to reopen it; your chart selections are preserved.
							</li>
							<li>
								<strong>Share your life list</strong> — opt in from Settings so other
								signed-in Birds users can explore your map and timeline. Use the
								Life list picker to browse shared lists. Sharing starts off and
								can be turned off at any time.
							</li>
							<li>
								<strong>Organize your bird study</strong> — Viewed species is now a
								Field Guide tab. Switch to Not yet viewed, browse collapsible bird
								families, or open countries to explore species reported there in
								the app's loaded historical data.
								Country groups show only matches for your selected list and search,
								with species counts before expanding. Country counts and expanded
								lists now load faster, including the full Not yet viewed list.
							</li>
							<li>
								<strong>Your species learning history</strong> — species pages now
								remember that you viewed them, separately from your life list.
								Open Viewed species from Field Guide to search your history and see
								first/last viewed dates. History is personal to each account, with
								pause and clear controls.
							</li>
							<li>
								<strong>Clearer Field Guide help</strong> — Help now explains how to
								read and explore “Where it is through the year” alongside the other
								species-page tools. Nearest lifers has been removed from the menu;
								use “Check nearest reports” on a needed species' page.
							</li>
							<li>
								<strong>Smarter nearest reports</strong> — searches now look first
								in regions where the bird has been reported at this time of year,
								helping find birds whose range is far from home. Regions with
								missing history or no historical reports remain searchable;
								results still say when closer regions could not be checked.
							</li>
							<li>
								<strong>Your own theme</strong> — choose Light, Dark, Forest, Ocean,
								or Warm Paper in Settings → Appearance. Preferences are saved per
								account and applied before the page appears. Read-only viewers have
								their own appearance control without access to private settings.
							</li>
							<li>
								<strong>Direct eBird checklist links on Home</strong> — each reported
								location for needed and notable species now includes an inline <code>checklist ↗</code>
								link to open the observer's eBird submission in a new tab when available,
								matching the Field Guide species view and avoiding extra page navigation.
								Expanded locations show the location name before Map, Directions, and checklist links.
							</li>
							<li>
								<strong>Species totals at a glance</strong> — Hotspots &amp; data now
								shows a deduplicated worldwide species total in the Loaded data heading,
								plus distinct species counts on collapsed geographic area, country,
								and state/region lines, without double-counting birds shared by loaded
								locations. Totals describe loaded historical data, not complete ranges.
							</li>
							<li>
								<strong>Field guide location search and photos</strong> — combine a
								country or state/region with names and tags to find birds reported
								there in any season of the stored historical years. Results now include
								reference thumbnails with photo credits. Missing geographic coverage
								and unavailable photos are clearly labeled.
							</li>
							<li>
								<strong>Clearer hotspot geography</strong> — hotspots filed directly
								under regions such as Suðurland no longer show a missing-region
								warning when eBird lists no smaller subdivisions. Notes for known
								subdivisions now distinguish the recorded parent from a missing
								more specific assignment, without suggesting Refresh will repair it.
							</li>
							<li>
								<strong>Cleaner worldwide loading</strong> — the country picker now removes
								countries whose remaining regional locations were conclusively resolved as
								no-data or quarantined after repeated unavailable responses, while temporary
								failures and active retries remain visible.
							</li>
							<li>
								<strong>Where it is through the year</strong> — every species page
								now carries a migration ribbon above Best time of year: latitude
								bands by month, colored by how often the species was reported. A
								seasonal summary card derives latitudinal shifts and geographic
								landmarks directly from monthly reporting data, hedging when
								observations span partial months. The chart automatically crops to
								the species' occupied latitudinal range with a Latitudes toggle for
								the full globe. Latitude rows feature geographic landmark anchors on
								larger viewports and in the readout. It opens to World view on a phone
								or tablet and to All continents (starting on the species' data-derived primary column) at
								desktop widths, and is switchable to any combination of continents via the multi-select dropdown. An equal-weight average keeps one heavily-birded
								country from drowning out the rest; a by-checklist average is one
								tap away. Under equal weighting, a neutral dash marks cells where one or more countries below 40 checklists were excluded from the average (or where every country fell below 40, leaving the cell too thin to rate); under checklist weighting, a dash marks cells where the aggregate sample itself is under 40 checklists (with its reporting rate still available in the readout). Cells with nothing loaded show a diagonal slash. Pick a band and month to see the loaded regions behind
								them, and tap a region there to chart it in Best time of year as a
								third pick alongside the closest and best regions. Use the month slider or step buttons to
								browse the full year. On a
								phone, tap any square or use the slider; on larger screens tap any square.
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
		background: var(--bg);
		color: var(--muted);
	}
	.v-tag.current {
		background: var(--accent);
		color: var(--on-accent);
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
