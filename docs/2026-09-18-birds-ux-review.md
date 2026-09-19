# Birds UX review: keep the depth, make the journey predictable

September 18, 2026 · Revised after live eBird and worker verification · Test app at `8ceb97c`

## Decision

Proceed with the **navigation and discovery release**, with a short data-meaning and trip-planning correction pass first. Live testing confirms that the app can fetch recent reports, generate and save routes, sync the life list, and finish historical loads. It also reveals problems the initial review missed: private observation locations presented as hotspots, misleading planner counts, incompatible planned/current comparisons, and incomplete explanations of report coverage. Those deserve attention before visual polish. The original location-continuity and keyboard-navigation fixes still stand.

The application already has a recognizable visual identity, useful geographic coverage explanations, working taxonomy focus, real list pagination, and substantial stored-data functionality. It needs more consistent connections between those pieces, not a replacement interface or a smaller dataset.

This review feeds the existing [integrated roadmap](2026-09-18-birds-ux-roadmap.md). The detailed [first-release specification](2026-09-18-birds-ux-release-1.md) is the next implementation handoff. These are evidence and specification appendices to one roadmap, not competing plans. This is the baseline review. Phase 1 has since addressed F12 in the local test app; see the [independent phase review](ux/phase-01-review.md). The remaining findings are not implied complete.

## What was actually examined

Browsed 20 principal routes at desktop and phone widths: Home; Field Guide; Taxonomy; Viewed species; Special interest; species detail; both Forecast modes; Hotspots & data; Life list; Trips; trip detail; trip planner; Photos; Alerts; Settings; Appearance; Help; About; and Admin. Then exercised populated hotspot pages, county drill-down, filtered lists, account variants, and mutations. Screenshots and structured DOM captures were saved for the review.

The initial pass used WebKit at 1280×900 and 390×844. Focused journeys also used Chromium at 390px width, generally 900px high; Field Guide was additionally checked at 320, 768, and 1280px. Inspected actual screenshots as well as DOM text and control geometry. This is browser emulation, not a physical iPhone/Home Screen test or a complete accessibility certification.

Verified the running server uses Vite's test mode and authenticated against newly created sessions in `birds_test` on port 15436. Database statistics indicated approximately 37.9 million frequency rows, 10,899 enrichment rows, and 10 existing trips at the start. These are snapshot statistics, not production counts.

The initial pass incorrectly stopped at invalid test credentials and an absent worker. Those conditions have now been repaired and the omitted journeys executed. With the owner's explicit authorization, working production eBird API/login credentials were read without modifying production, transferred in memory, and re-encrypted under the test secret. The owner's real 227-species life list and lifer-location metadata replaced the prior fixture. A dedicated detached worker now runs against `127.0.0.1:15436/birds_test`; `/api/health` reports both database and worker `ok`. The existing reference corpus was sufficient, so a full production database copy was unnecessary.

Test-only changes include audit trips 16–18, live response caches, one existing hotspot refresh, a successful previously unloaded hotspot load plus a separate retrying load, and a real life-list sync. Personal list tests were reversible; viewing history accumulated normally. Test push subscriptions are absent, notification scans are disabled for test accounts, and unrelated bulk family/AI enrichment is paused or deferred. eBird jobs remain runnable. Production credentials and data were not modified, and no production deployment or paid AI generation was performed.

### Live workflow results

| Journey | Verified result |
| --- | --- |
| Home, 31-mile radius, 30 days | 54 needed species, populated notable reports and 35 ranked places. Expanded both complete lists and the seven-location hawk disclosure. Real reports dated September 18 appeared. Per-species enrichment added location detail. |
| Nearest lifer | Clapper Rail returned nearby reports at 3.6, 8.7 and 12 miles. Nashville Warbler returned three distant reports, the closest at 135 miles, with an incomplete-region-search caveat. A separate closer notable report appeared on Home; direct upstream comparison is explained in F14. |
| Area Forecast, Huguenot, September | 127 of 130 hotspots loaded, 1 likely and 2 possible needed species, 69 long shots, month comparison and county recommendations. The coverage warning and loading affordance are useful. |
| Hotspot recent reports | Huguenot returned 73 species in the 30-day feed, dated and labeled Seen/Need, with checklist links. The page correctly explains that this is the latest report per species. |
| Automated trip, My needs | Huguenot anchor, 25-mile radius, 30 days, minimum 1: 36 candidate places; three selected stops with 11 distinct target species. |
| Automated trip, All species | Same inputs: 60 candidate places; three selected stops with 41 distinct species. Stop badges incorrectly retained “NEEDS”; see F13. |
| Save and reopen generated trip | Trip 18, “UX audit live needs route,” retained all three stops and target notes after reload. Driving route rendered about 64 miles / 1 h 17 min, with weather, tides and navigation links. |
| Refresh loaded historical data | Job 5192, Huguenot: queued → running → succeeded in 37.1 seconds; one refreshed location, zero failed units, no credential problem. |
| Real eBird account login/life-list sync | Job 5193 succeeded in 1.3 seconds: 229 input rows, 227 matched species and two explicitly reported unmatched hybrid/slash entries. |
| First historical load | Lakewood Ranch–Lake Uihlein had no frequency record. Job 5195 succeeded in 0.95 seconds with 103 historical species across 89 checklists from 2016–2025, zero failed units; the September Monthly view rendered 34 species with low-sample markers. |
| Error and retry recovery | Celery Fields initially rejected loading because hotspot metadata was absent. Nearby Forecast discovery repaired that prerequisite. Job 5194 then reached eBird, encountered a 30-second upstream timeout and entered the normal delayed retry queue. The UI displays “Load retrying soon… details”; its recent feed remains usable. This job is separate from the successful refresh and first load above. |

Timings above are worker start-to-finish durations, not estimated performance guarantees. Browser capture scripts deliberately wait for rendering; their wall times are not page-load benchmarks. Evidence is retained in `live-*.json/png`, `live-*-results.json`, the job-event records and `.local/test-worker.log`.

## What should be retained

- **Taxonomy focus works:** a Marbled Godwit family link revealed its row, scrolled to it, and visibly identified it. Do not rebuild this because the original ticket predates it.
- **Field Guide search context survives its direct species round-trip:** country, state, query and pagination are represented in links. Extend this discipline to other entry points.
- **Full monthly lists are reachable:** Myakka River SP initially showed 60 of 110 September species; clicking the explicitly labeled expansion rendered all 110. Preserve that access rather than imposing a new cap.
- **Stored data is useful without an API key:** a normal account could read Florida's species forecast, Huguenot's monthly results, and its 373-entry life list. Filtering the latter to “hawk” yielded 7 of 373 with the filter visible.
- **Special interest works end to end:** save, open the collection, remove. A new trip and edited notes also survived reload.
- **The visual foundation is coherent:** theme, cards, typography and navigation already relate across pages. No horizontal page overflow was found in the captured 390px states; the additional Field Guide width checks also passed. This does not establish every expanded state or every theme.

## Navigation and page findings

### F01 — Returning through a bird can strand you away from your trip

**Priority: high · Reproduced · Existing td-8ff597 · Release 1**

Journey: Trips → Myakka River state park → Myakka River SP → Monthly → Great Egret → in-app Back. The species page links back to the hotspot with month 9, but drops `returnTo=/trips/9`. The returned hotspot offers **“← Home”**. The trip is no longer reachable through the return trail.

Two additional reproduced losses: choosing a county on the species forecast drops the preceding Field Guide/bird breadcrumbs; opening Marbled Godwit from Photos supplies no return context and offers Home. These are separate callers of the same incomplete navigation contract.

**Change:** shared, named return context and ancestry, preserving the actual source list and selected row. Keep canonical query state in URLs and avoid recursively growing return URLs. Test these entire journeys, not just one link helper.

Evidence: `journeys2.json`; hotspot species links in `src/routes/hotspots/[locId]/+page.svelte`; `countyHref()` in `src/routes/forecast/species/+page.svelte`; photo group links in `src/routes/photos/+page.svelte`; `src/lib/return-link.ts`.

### F02 — “Forecast my needs here” can mean the saved home instead

**Priority: high · Reproduced missing-coordinate state · td-8ff597 / location work · Release 1**

On the test Myakka River SP monthly page, the action's URL is bare `/forecast` because cached coordinates are missing. Following it opens Forecast with the saved home as its place. The user asked about the hotspot, but the application silently changes the geographic question.

**Change:** only offer a runnable “here” action when its location is known. Otherwise explain that coordinates are unavailable and provide an explicit place-selection step. Existing monthly data remains readable. With known coordinates, carry the correct location parameter, label, month and return context. The current hotspot link uses `label`, while the Forecast loader reads `loc`; reconcile that contract too. Rechecking after restoring live credentials still produced the bare `/forecast` link for Myakka, so this was not caused solely by the invalid test key.

This is a verified code branch and test-state reproduction, not a claim that all production hotspots lack coordinates.

Evidence: `final-checks.json`; hotspot `forecastHref`; Forecast's `parsePin()` inputs in `src/routes/forecast/+page.server.ts`.

### F03 — The navigation drawer looks modal but does not manage keyboard focus

**Priority: high · Reproduced and source-checked · New detail under td-8ff597 · Release 1**

Opening the drawer leaves focus on the underlying Open menu button. Escape does not close it. The markup declares `aria-modal=true`, but the shared layout has no corresponding Escape handler, focus placement or focus containment.

**Change:** give the drawer a complete dialog behavior: focus inside on open, contain Tab/Shift+Tab, close with Escape or its visible control, restore the invoking control on dismiss, and prevent interaction with the obscured page. Preserve destination links and roles.

Evidence: `keyboard.json`; shared layout drawer markup in `src/routes/+layout.svelte`.

### F04 — Finding a result requires scrolling past the search machinery

**Priority: medium-high · Measured · td-8ff597 · Release 1**

For “godwit” in Florida, the first Field Guide result began around **1,435px down** on the 390px layout. The introductory counts, duplicate Viewed entry, section tabs, search, family, sort, geography and tag groups all precede the answer. This is friction even when the search is correct and fast.

The same query produced seven results, including American Barn Owl, Ruff and Willet after the godwits. Source inspection confirms that search intentionally combines name/code matches with descriptive-text/tag matches. The introductory promise says “by name or code,” so the wider results look unexplained.

**Change:** show search, current scope and result count first; place the full filter editor behind a clearly labeled disclosure with active-filter summaries. Keep all filters and all results. Explain broad text search and distinguish name/code matches from descriptive matches; do not remove the valuable prose search.

Evidence: `journey-guide-results.json/png`; `src/routes/species/+page.svelte`; `searchGuide()` in `src/lib/server/species-enrichment.ts`.

### F05 — Species pages need a way to jump to the question being asked

**Priority: medium-high · Measured · td-8ff597 and td-74b012 · Jump links in Release 1**

The captured Marbled Godwit page was about **9,726px tall** on the phone layout. “Finding this bird” began around 3,955px, after photos, reference media and the open Similar species section; “Best time of year” began around 7,454px. The content is valuable, but the page makes the visitor traverse unrelated sections to reach it.

**Change:** a compact “On this page” section menu near the bird header, with identification, finding, seasonal distribution, timing, recent/nearest reports and reference content as applicable. Links reveal collapsed targets and move focus appropriately. Keep content intact. Persistent collapse preferences remain a later, separately specified change because of the existing SSR/localStorage acceptance conflict.

Evidence: `species-phone.json/png`; `SimilarSpeciesCard.svelte` currently renders its disclosure open.

### F06 — Location exploration and data maintenance compete for attention

**Priority: medium-high · Observed · td-1e86c2 / td-d2bb08 / td-8ff597 · Release 2**

Hotspots & data has useful search: “Huguenot” found two stored places with clear names and coverage. But the general browse hierarchy sits below source adjustments, background loads and region-loading controls. Someone exploring birds must pass through operational concerns to find the stored geography.

The no-key account makes this distinction especially important: the default “What can I see?” mode stops at an API-key message, while the neighboring species forecast and loaded hotspot monthly views work. That useful alternative is not offered directly in the error state.

**Change:** make location search/browse the front of the workspace, with data status and loading as clearly reachable secondary tools. Add direct recovery links to the stored-data views a user can use now. Preserve the complete coverage browser and authorized loading controls. The restored worker completes real loads; discoverability remains an interface issue rather than an environment limitation.

### F07 — “All birds” and “my needs” need explicit, consistent controls

**Priority: medium-high · Observed · td-8ff597 / location tickets · Release 2**

The hotspot monthly chart summarizes **needs** while the list below also includes **seen** birds, ordered after needs. Its explanatory text is present, but the visitor has no matching All / Need / Seen selector to state the desired view. Other pages use different forms of the same distinction. The live trip planner already offers My needs / All species, so it needs consistent labels and semantics, not a duplicate selector (F13).

**Change:** one visible vocabulary for list scope, explicitly tied to the signed-in or viewed list owner. Keep observed reports, historical presence and monthly checklist frequency separate. Make the counts describe the selected scope. Retain access to all 110 results in the tested Myakka example and all stored geographic evidence.

### F08 — Important control sizes vary between pages and browsers

**Priority: medium · Measured · Shared UI work under td-8ff597 · Release 1 touched surfaces**

Trip Edit was approximately 31px high, unit switches 34px, stop move/remove buttons 36px, and field-tip/order actions 41px in Chromium. These are below the repository's 48px target requirement. WebKit also rendered the species-forecast country/region native selectors at roughly 23px, while Chromium rendered larger controls. This warrants explicit cross-browser styling and testing.

**Change:** shared control sizing, text treatment, spacing and focus styles. Measure the actual clickable area; a small checkbox inside a sufficiently large clickable label is not automatically a failure. Preserve compact information density by tightening noninteractive whitespace rather than shrinking targets.

Evidence: `measurements.json`, `find-bird-phone.json/png`, trip captures.

### F09 — “Pick on map” opens content outside the current view

**Priority: medium · Reproduced · Location interaction detail · Release 1**

Clicking the Forecast map picker left focus on “Pick on map” and scroll at zero. In the 900px-high phone test, its newly revealed “Forecast near…” action was at about **1,399px**. The action succeeds in revealing an inline editor, but the first visible screen barely communicates that anything happened.

**Change:** give the expanded picker a heading, move focus to it, and bring it into view. Preserve a usable text alternative and return focus when cancelled. Do not automatically select a map point or change the place merely by opening it.

Evidence: `final-checks.json`; `screen-map-open.png`; Forecast's inline MapPicker rendering.

### F10 — Trips need a field-use view as well as editing tools

**Priority: medium · Observed; save/edit verified · td-40a1b5 / td-71494e / td-bf7cc4 · Release 3**

The five-stop trip was roughly 5,880px high on the phone layout. Sharing, map and weather precede stops; each stop carries useful notes, AI advice, tides and editing controls. This suits preparation, but repeated scrolling and small controls work against use while walking around.

**Change:** a compact stop overview with reversible visited check-off and direct jump to each stop. Keep detailed notes/tides/tips expandable and dates visible, not removed. Distinguish planning and field-use presentation without making separate copies of the trip. Current test notes include older seasonal advice, visibly timestamped; do not present a refresh as guaranteed or automatically spend AI calls.

### F11 — Photos and administration need better local navigation as they grow

**Priority: lower than core journeys · Observed · Partly existing admin tickets · Later slices**

Photos presents a long sequence of species groups—about 9,582px in the captured phone view—with no local species finder. For accounts without a gallery, the primary Photos destination is an explanation-only page. Admin's current tab was roughly 19,900px in its captured phone state, while Settings mixes account, integrations, data operations and user administration.

**Change:** add a species filter/jump index to Photos while preserving every photo; repair its species return links in Release 1. Retain stable primary navigation initially, but make the no-gallery state useful and truthful. Group admin operations by purpose with shared local navigation and compact status summaries; keep detailed job/history data reachable. Do not build a second copy of model/cost controls already present.

## Additional findings from the repaired live environment

### F12 — The trip planner treats observation locations as verified hotspots

**Priority: high · Reproduced and source-checked · Early correction under td-8ff597 / td-71494e / td-39d567**

The default three-stop needs route selected **Jax Heights Yard 2** beside two real hotspots. The wider candidate list included backyard, restricted-access and offshore pelagic observation locations, while its explanation promised “Every hotspot in range.” After saving, the yard received an **EBIRD HOTSPOT** badge. A location id beginning with `L` is not proof that a location is an eBird hotspot or publicly accessible.

Source: `runQuery()` groups all nearby observations; `assembleTripPreview()` assigns `kind: "hotspot"` to every selected candidate and copies its observation location id into `hotspotId`. The live hotspot metadata lookup does not gate that selection.

The saved route was inspected at desktop and phone widths; the mistaken hotspot badge persisted after reload.

**Change:** verify hotspot identity before labeling or automatically selecting a hotspot. Keep all observation locations accessible in a separately explained reports view, with explicit opt-in to add a non-hotspot stop. Do not equate a verified hotspot with unrestricted public access; show known restrictions and leave unknown access honest. Test a real hotspot, a private observation location and an offshore report. Retain manual stop entry.

### F13 — Counts change meaning between planning and using a trip

**Priority: high · Reproduced and source-checked · Early correction under td-8ff597**

Three related problems appeared with live data:

- **All species still says NEEDS.** Its 41-species route labels individual stops “14 NEEDS,” “15 NEEDS” and “12 NEEDS.” The form also keeps “Min needs/stop.”
- **Ranked candidates are not full hotspot inventories.** The planner uses the area feed's latest location for each species. Huguenot received 10 species in All mode, although its own 30-day recent feed contained 73. The candidate copy says “Every hotspot … with species reported,” making this incomplete allocation look like a complete search/ranking. Home's Best places also derives from the base feed rather than the expanded species-place evidence.
- **The saved comparison is not like-for-like.** Huguenot immediately showed “29 of your needs … last 14 days, ≤9.9 mi (was 4 when planned).” Four meant selected reports at that location in the planner's 30-day query; 29 meant species in a radius around the stop over 14 days. It is not evidence of a rise from four to 29.

**Change:** use All/Need terminology throughout, carry the source/window/geographic scope with saved target counts, and compare counts only when those scopes match. Label the initial regional feed as a candidate preview; use appropriate per-location or per-species reports to establish comparable rankings, with visible progress and completeness. Keep the complete candidate list reachable and document upstream limits. Do not present arbitrary caps as full coverage. This is a data-contract correction, not just a copy edit.

Evidence: `live-plan-all`, `live-hotspot-recent`, `live-trip-reloaded`; `query-engine.ts`, `needs.ts`, `trips.ts::needsCountForStops()`, and planner/trip Svelte labels.

### F14 — Recent reports need explicit source, review status and time window

**Priority: high for trust · Reproduced against live responses · td-3d9544 / td-d71bad**

**Own sighting:** the September 2 Short-tailed Hawk at the owner's home is present in the synced life list with its checklist/location ids. Home still shows seven notable locations, with the nearest at about half a mile. A direct current nearby-species request returned nine locations, including other private locations and provisional reports, but omitted the owner's checklist; the notable feed omitted it too. This rules out a blanket Birds exclusion of private locations in this example. It does not establish why eBird omits that particular checklist, nor does a first-seen life-list record represent every personal observation.

**Nearest discrepancy:** Home showed a provisional Nashville Warbler report 1.5 miles away, while Nearest's first result was 135 miles away. The current nearby species endpoint returned zero Nashville Warblers even with `includeProvisional=true`; the Florida species feed also omitted the nearby notable row. The app is consuming inconsistent upstream feed coverage. Nearest disclosed its partial regional search, but did not display its fixed **14-day** window, while Home was set to 30 days. This particular nearby sighting was today, so the window difference does not explain its omission.

**Report counts:** the notable payload contained duplicate rows for the same Nashville Warbler checklist/location/time; Home rendered two reports/two birds. Its aggregate currently sums rows without a report identity deduplication step. Preserve truly distinct observations while preventing duplicate upstream rows from looking like independent evidence.

**Change:** display window, source and provisional/review status consistently. Merge compatible known nearby notable evidence into nearest searches before claiming the closest available answer, retaining completeness caveats. Distinguish **Your recorded sightings** from **Public recent reports** and allow access to the owner's known dated/checklisted sighting without pretending the personal dataset is complete. Define and test deduplication identity. Keep td-3d9544 open for the personal/public integration fix; its symptom and upstream boundary are now reproduced, rather than awaiting credentials.

### F15 — Loading actions and status depend on hidden metadata and job state

**Priority: medium-high · Reproduced, with successful recovery · td-8ff597 / td-39d567 / td-a47c0d**

Celery Fields displayed its name, recent observations and a **Retry load** button, but submitting returned “This location is not in our hotspot cache yet.” Its title could come from stored place metadata; the load action only accepted hotspot-cache or frequency metadata. Visiting nearby Forecast populated real hotspot metadata, after which the same action queued successfully. Its download later entered the normal retry queue on an upstream timeout; the UI displayed “Load retrying soon… details” while recent reports stayed usable. A user should not have to discover that repair path.

Separately, deliberately paused family enrichment appeared globally as “Load queued — Family descriptions — Family descriptions,” and inside Forecast as “waiting in queue.” That banner persisted while independent eBird jobs completed. The global worker was healthy; this was a paused job category, not a stopped worker.

**Change:** on a requested load, resolve/validate missing hotspot metadata or give an actionable recovery; do not offer a runnable retry whose prerequisites the page knows are absent. Distinguish paused, scheduled, queued, running and terminal states, naming the relevant work once. Keep active-job progress local and make completed/failed history discoverable. Preserve the working worker queue and real refresh flow.


## Revised release sequence

| Release | Outcome | Relevant findings / tickets |
| --- | --- | --- |
| 0 — Trustworthy trip/report meaning | Correct hotspot identity, scope labels/comparisons, report provenance and load recovery before expanding these journeys. | F12–F15; linked UX, location-metadata, Home and Nearest tickets. |
| 1 — Reliable movement and visible answers | Keep your path and location; accessible navigation; reach results and species sections quickly. | F01–F05, F08–F09; td-8ff597. Only jump/reveal behavior from the card work, not persistent collapse preferences. |
| 2 — Explore a place consistently | County, hotspot and map/radius selection; All / Need / Seen; stored-data browsing and honest coverage. | F06–F07; td-d2bb08, td-1e86c2 and remaining td-8ff597 location work. |
| 3 — Use it in the field | Trip stop progress and overview; species disclosure preferences; focused map/route improvements. | F05 remaining, F10; td-74b012, td-40a1b5, relevant td-71494e work. |
| Supporting lane | Fix measured correctness/performance and reliable tests; approve costly enrichment before wider runs. | Existing roadmap package D; td-3d9544 now has live reproduction and a verified personal/public-feed boundary (F14). |
| Later / gated | Photo discovery, admin organization, weather expansion, and explicit owner-gated ideas. | F11 and existing roadmap dispositions. No lost tickets or implicit reopening. |

The concrete first release is specified separately. Existing all-31-ticket mapping remains authoritative; findings refine its order and acceptance criteria. No ticket should be declared implemented because this review or specification exists.

## Remaining checks and follow-through

- Recent Home, Nearest, area Forecast, hotspot feeds, generated/saved trips, real external account login, life-list sync and historical worker completion were exercised with working eBird access. Findings describe the tested source revision and changing live dataset; they do not prove every region or account.
- Real push delivery, public sharing delivery and paid AI calls were not exercised; these are outside the omitted recent-data/worker journeys. Test notifications remain disabled.
- WebKit automation stalled on Settings; the Settings/Appearance/Help/About/Admin pass completed in Chromium. A physical Safari/iPhone pass remains a release gate, not a claimed result.
- Reviewed one theme in the main visual pass, with additional account variants; all-theme contrast and screen-reader testing remain implementation checks.
- Recorded page heights describe these specific content/state combinations. They support navigation improvements, not fixed limits on content length.
- Scripts, screenshots, route captures, and mutation records are retained in the task's `work/birds-ux/audit` directory. Selected screenshots are included with the HTML deliverable. The completed tests demonstrate the observations above, not that the proposed release has been implemented or passed.
