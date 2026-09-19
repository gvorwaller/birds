# Birds: an integrated UX roadmap

September 18, 2026 · Integrated roadmap, refined after browser review at `8ceb97c`

**Execution:** the owner approved phase-by-phase specification, lower-cost implementation and independent primary-agent review. See [working agreement and phase queue](ux/implementation-workflow.md) and [phase 1 specification](ux/phase-01-trip-location-identity.md), tracked as td-d22017 under td-8ff597.

**Current stage:** the [broad UX review](2026-09-18-birds-ux-review.md) now includes live eBird workflows and completed worker jobs after repairing the test environment. The [first-release specification](2026-09-18-birds-ux-release-1.md) is ready for discussion. The all-ticket map below remains the single backlog index. Phase 1 is released as `582f665`; [verification record](ux/phase-01-review.md). Phase 2A [count meaning and saved context](ux/phase-02a-trip-count-context.md) is implemented and independently reviewed in test, tracked as td-2c866c; [review evidence](ux/phase-02a-review.md). It is not deployed. Phase 2B retains the comparable-ranking work.

## Recommendation

Make Birds easier to move through before adding more destinations. The first release should let you follow a bird or place several levels deep and return to the exact list you left. Then bring location selection and the choice between **all birds and birds you need** into a consistent workflow. Apply shared page and list conventions as each workflow changes, rather than attempting a separate cosmetic rewrite.

This plan accounts for all **31 open tickets** in the original reviewed snapshot. It combines their intent into work packages without replacing their individual acceptance criteria. The initial backlog/source pass was followed by the linked browser review. The review distinguishes reproduced issues from unverified reports. Production was read only to restore working credentials and the owner life list into isolated test storage, with explicit authorization. No production data changes, application implementation or deployment were performed during that audit; subsequent implementation/release status is recorded above.

The aim is to make the existing depth easier to reach: fewer lost searches and dead ends, predictable controls, and clear explanations of what the data represents. Smaller datasets, hidden limits, and removing advanced features are not success criteria.

## What is already there

- The shared navigation already places **Home, Field guide, Forecast, and Photos** first. Trips, Life list, and Hotspots & data remain in the drawer. Retain this arrangement initially, including frequent Field Guide access; assess discoverability in the later independent audit before moving destinations again.
- Field Guide already groups Browse species, Viewed species, Special interest, and Taxonomy. Forecast already groups “What can I see?”, “Where can I find this bird?”, and Hotspots & data. Extend these existing workspaces.
- Return links exist widely, and Forecast remembers searches per signed-in viewer. However, `returnTrail()` follows only one nested level, and some onward links replace the current context with a bare destination. For example, hotspot-to-species links reconstruct only the hotspot route and selected monthly fields; Nearest-to-species links use bare `/nearest`. These are concrete starting points for continuity work, not a claim that no return navigation exists.
- Taxonomy already accepts a focused species and scrolls to it; species family links supply that focus. Verify the different entry paths, including order links, before rebuilding the behavior requested in the broad UX ticket.
- Field Guide currently offers country and state/region and labels its location filter as historical reports at any time of year. The owner has now confirmed that **county, hotspot, and map/radius choices** are wanted too.
- Admin already contains model selection, change confirmation, and cost reporting. Large-job approval is a distinct requirement; older observability tickets need a remaining-work audit.
- The migration-ribbon refinement parent remains open, although its four feature outcomes have closed implementation tickets. Reconcile the parent's old status notes against the release evidence before scheduling any more implementation.

## Shared UX rules

These are proposed implementation contracts for the tickets below, not a new visual theme.

| Area | Consistent behavior |
| --- | --- |
| Where am I? | Use the same page heading, named place/bird context, local section navigation, and action placement. Distinguish the current workspace from the route used to arrive. |
| How do I get back? | Provide a labeled in-app return action and an expandable ancestry trail on deeper journeys. Preserve location, period/month, filters, sort, pagination, and the originating row. Restore scroll/focus when returning. It must work in the iPhone Home Screen app without browser Back. |
| Which location? | Reuse one location-selection vocabulary across Field Guide, Forecast, and hotspot discovery: region hierarchy, named hotspot, or a point with an explicit radius and units. Show the selected boundary; changing a parent clears incompatible child selections. |
| Which birds? | Offer All / Need / Seen where a result set supports it. Keep recent reports, historical reported species, and monthly expected/reported-frequency evidence explicitly distinct. Do not present any one of these as a complete real-world inventory. |
| Whose birds? | Show whose life list supplies Seen/Need, especially when viewing a shared list. Personal viewing history, Special interest, and display preferences continue to belong to the signed-in viewer. Accounts without eBird credentials retain access to permitted stored data. |
| Species lists | Reuse the same name/link, available thumbnail, status cues, and contextual actions. An unavailable image has an honest empty state. Fetch thumbnails in batches; do not introduce per-row requests. Adapt density to the page rather than forcing identical layouts everywhere. |
| Full data access | Pagination or explicit progressive loading must expose the full matching stored result set, with counts/ranges or a clear continuation. A ranked preview must be labeled and offer the wider result/search. An upstream or bounded search limit must be stated; never imply that “no result found” proves absence. |
| Data meaning | Keep unknown, not loaded, sampled zero, thin evidence, stale cache, and request failure distinguishable. Show geographic and time coverage beside the result, with a useful next action where available. |
| Visual and interaction consistency | Use existing theme tokens and component-scoped styles for headings, cards, tabs, filters, badges, empty/error/loading states, and buttons. Preserve 48px targets, 16px inputs, AAA text contrast, keyboard focus, and mobile safe areas. Use inline status and the established confirmation pattern; no toasts. |

Preserving context should not mean recursively encoding larger and larger URLs. In package A, specify flat, validated route context plus per-tab restoration state, bounded by an explicit navigation-history policy. Shareable URLs must retain the actual search and work without browser storage. Missing history gets a clearly labeled contextual destination; it must not silently turn a searched place into Home. Validate local return destinations and isolate saved state between accounts.

## Ordered work packages

### A. Navigate without losing your place — first release

**Refinement after browser review:** include explicit missing-location recovery (a hotspot action must never silently forecast Home), keyboard-correct drawer behavior, a compact Field Guide filter editor with visible search scope, a species section menu, and focus/scroll when opening the map editor. The first-release specification defines these changes. Persistent card preferences remain in C; expanded geography and All/Need/Seen remain in B.

**Anchor:** td-8ff597. Scope its navigation and shared page/list implementation separately from the now-documented browser review.

1. Write a small navigation/context specification using the current routes. Establish heading, return action, breadcrumb, filter summary, species-row, and feedback patterns on two representative journeys before spreading them.
2. Repair context propagation through Home → species → species forecast → hotspot → another species, and through Field Guide → species → taxonomy. Keep exact search state and offer named ancestor destinations, including a clear recovery when restored history is unavailable.
3. Verify existing taxonomy focus behavior on every relevant entry path; fix only demonstrated gaps. A valid targeted link should reveal and scroll to the matching row, not simply open the top of a long page.
4. Add consistent available thumbnails and species status presentation across the affected lists, then extend the same contract to the remaining species-list surfaces. Keep meaningful per-page actions.

**Release proof:** complete both journeys on desktop and at phone width without starting a search again; return to a later result page and the original row; verify refresh, direct link, new tab, unavailable storage, and account switching. Exercise keyboard navigation and actual iPhone Home Screen behavior before claiming physical-device verification. No silent result truncation, query-context loss, or reset to Home.

**Early companion fixes:** investigate the missing own-sighting location (td-3d9544) and expose Nearest days/distance with consistent units (td-d71bad). These need not wait for the entire plan. Reproduce the Home omission before deciding whether its cause is personal-place inclusion, date logic, aggregation, or the result scope; do not invent an explanation. Nearest must carry the chosen bounds through the actual search and return links, not just its controls.

### B. One location workflow, with all birds easy to reach

**Tickets:** td-d2bb08, td-1e86c2, location/all-versus-needs portions of td-8ff597.

Build a reusable location selection experience, then connect it to existing Field Guide and Forecast/hotspot views. Field Guide gains **county, hotspot, and map/radius** selection in addition to country/state. Hotspots & data gains map-assisted discovery at hotspot level. Keep text search and list results available alongside the map.

Separate geographic selection from the question being answered:

- **Recently reported:** explicit supported date/window and report semantics. The existing hotspot recent feed represents latest reports per species; do not relabel it as a complete checklist history.
- **Reported historically:** the stored-data scope used by Field Guide, with coverage/year range shown.
- **Expected for a month:** the existing frequency-based evidence, with sample/coverage qualifications.

Within each appropriate list, make All / Need / Seen visible and preserve that choice when opening a species and returning. Carry a chosen place into Forecast and trip planning rather than requiring another search. A map viewport is not an implicit radius: show what bounds are actually applied. Label incomplete geographic coverage, and support antimeridian-crossing areas correctly. If new map behavior consumes the incorrect centroid values covered by td-57d9fc, fix that dependency before releasing it.

**Release proof:** use the same county, hotspot, and radius selections across entry points; distinguish no loaded data from loaded data with no matches; prove All is reachable from a needs-first journey; verify unit conversion, URL round-trip, pagination, and viewers without API credentials. No automatic large enrichment as a side effect of browsing.

### C. Make long species pages and trips easier to use

**Tickets:** td-74b012, td-40a1b5; selected parts of td-71494e, td-9308e2, and later td-bf7cc4.

1. Standardize collapsible species cards with remembered per-viewer preferences. Retain open defaults and full content access. Following a link into a closed card must reveal its target before scrolling; the ribbon's sticky behavior must survive close/reopen. Reuse the existing Similar species disclosure.
2. Resolve one acceptance conflict before implementing persistence: localStorage-only preferences cannot generally render saved closed state in server HTML while also guaranteeing no post-hydration layout movement. Choose a documented rendering strategy and amend the ticket if necessary; do not quietly claim both guarantees.
3. Add reversible, persisted stop check-off within a trip. Proposed meaning: “Visited” for this trip, not a global place status or deletion from the itinerary. Preserve stop order and distinguish planned from visited.
4. Improve the existing trip/place view with venue labels, reliable map links, actual route lines and per-leg times. Scope each independently; venue confidence belongs to its data source, and admin resolution controls need not clutter the ordinary trip screen.
5. Extend weather for multi-day planning after the basic trip workflow is consistent. Weather cache changes and source semantics belong to the weather ticket, not a page-styling change. Treat Birds of the World subscription access as a separate provider-capability decision; do not assume password storage or automated login is required or supported.

**Release proof:** complete a trip planning/review journey with both All and Need lists, return from stop/bird detail, check/uncheck a stop and reload, and follow links into collapsed content on mobile and desktop.

### D. Trust, performance, and admin controls — supporting work

This work proceeds alongside the relevant UX packages. It is not a reason to make every UX improvement wait for a broad infrastructure rewrite.

- Retain P0 importance for upstream contract validation (td-96ed83). Apply boundary validation and honest cache/error behavior to touched data paths.
- Repair the known DB test isolation/corpus assumptions (td-b29d1c, td-c41126) so failures can be trusted. Use the isolated test database; mocked tests alone do not establish real query correctness. Gate affected releases on meaningful tests, not a blanket waiver for a previously red suite.
- Use td-3bf3a2 to measure the selected journeys: initial response, filter change, opening detail, and returning. Preserve comparable dataset sizes and distinguish cold/warm cache. Fix measured repeated work, network serialization, or query shape; do not buy speed by dropping results or adding speculative indexes.
- Finish **large enrichment approval before expanding taxonomy-wide enrichment** (td-02fc4a → td-5086cc). Show intended scope, selected model, cost estimate or explicit uncertainty, and existing pause/cancel controls. Current model selection/cost reporting is a starting point, not proof this approval gate exists.
- Organize admin work into linked purposes: AI & Cost; enrichment/data quality; page performance; system health. System Health is a current snapshot, while the performance panel is a history/regression view. Avoid one oversized dashboard and duplicated meters.

### E. Reconcile completed work and keep explicit deferrals

Review td-1775b4 against the closed count, strongest-region, relative-colour, and multi-continent tickets and release evidence. It appears to need parent-ticket reconciliation, not another ribbon implementation. The closed monthly-rollup epic td-81a92d is outside this open backlog.

Keep the latitude-band precision change, deeper taxonomy changes, licensed abundance overlays, and BirdNET/media upload work outside this UX program unless their stated owner triggers occur. Preserve their tickets; do not let “single plan” erase intentionally deferred ideas.

## Complete open-ticket disposition

Priorities below are the existing td priorities, not newly assigned priorities. Packages indicate recommended execution sequence. “Audit remaining” means verify current code before estimating or rebuilding a feature.

| Ticket | Priority | Package / disposition |
| --- | --- | --- |
| td-8ff597 — UX flow | P1 | A/B umbrella: review includes live recent-data and worker verification; implementation of return continuity, shared patterns and all/needs access remains outstanding. |
| td-d71bad — Nearest days/distance | P1 | A companion: configurable actual search bounds, units, and preserved return context. |
| td-3d9544 — Own sightings missing on Home | P1 | A companion: live-reproduced; own checklist exists in the synced list but is absent upstream from public recent feeds. Specify personal/public provenance and inclusion (review F14). |
| td-d2bb08 — Field Guide location search | P1 | B: owner-confirmed county, hotspot, and map/radius choices. |
| td-1e86c2 — Location search from map | P1 | B: shared map/list selector and hotspot-level discovery; coordinate with preceding ticket. |
| td-40a1b5 — Trip stop check-off | P2 | C: reversible per-trip visited state. |
| td-74b012 — Remember species card state | P3 | C: shared disclosures, reveal linked targets, resolve SSR/persistence requirement. |
| td-71494e — Places/maps and route detail | P3 | B/C: split selector-relevant map/link metadata from later trip polylines, leg times, and admin resolution details. |
| td-9308e2 — Birds of the World link | P3 | C optional: decide subscription/login capability before implementing account handling. |
| td-bf7cc4 — Weather expansion | P4 | C later: multi-day/hourly usefulness with required cache/source changes. |
| td-f9e34d — Exotic flags, counties, gallery fields | P3 | B/D: audit remaining; separate Seen/Need eligibility correctness, Home grouping, and optional gallery metadata. |
| td-39d567 — Hotspot metadata audit | P3 | B/C supporting: confirm real upstream fields before adding descriptive content. |
| td-1775b4 — Ribbon refinements parent | P3 | E: likely completion reconciliation; verify all four outcomes rather than reimplementing closed children. |
| td-11aeb7 — Tall-region ribbon centroid blur | P3 | E deferred: retain explicit owner instruction to act only if sufficiently problematic. |
| td-02fc4a — Approve large enrichments | P1 | D early: job-level scope/model/cost approval; prerequisite to expanded bulk enrichment. |
| td-3bf3a2 — Performance deep dive | P1 | D across A–C: measured journey bottlenecks; no hidden caps or speculative broad rewrite. |
| td-96ed83 — Upstream schema validation | P0 | D urgent reliability lane; validate touched upstream/cache contracts. |
| td-c41126 — Tests assume small database | P1 | D early: realistic corpus-independent assertions and justified timeout scope. |
| td-b29d1c — Cross-file test races | P1 | D early: isolated fixtures/execution, retaining the ticket's repeated-green-suite acceptance. |
| td-618181 — Enrichment observability/cost | P3 | D: audit remaining against existing AI & Cost; split error/override work from optional extra content. |
| td-009031 — eBird fetch metric | P3 | D admin: specify cache-hit versus actual outbound calls and time window before implementation. |
| td-67b481 — Page performance panel | P3 | D admin: historical timing/regression view, linked from System Health. |
| td-be8674 — Frequency anomalies UI | P3 | D admin: authorized, deterministic, paginated access to complete anomaly records. |
| td-a47c0d — System Health | P4 | D admin later: snapshot of workers, queue, resources, database, coverage, and backup status; reuse existing status sources. |
| td-4e870b — Update models | P4 | D maintenance: validate available models per purpose when taken up; ticket wording is not current model evidence. |
| td-5086cc — Enrich whole taxonomy | P2 | D after approval controls: preserve useful content, backoff and pause/cancel; separately authorize/verify production backfill. |
| td-b52a90 — Deeper taxonomy/split survival | P3 | E deferred until actual taxonomy drift triggers it; keep life-list preservation requirements. |
| td-8cecc6 — Bad iNaturalist identifier retry loop | P3 | D quality fix: resolve invalid identifier/fallback persistence; independent of navigation redesign. |
| td-57d9fc — Antimeridian centroids | P4 | B dependency if the new map path uses affected values; otherwise retain focused correctness work. |
| td-d04fcf — Licensed abundance overlays | P4 | E gated: owner reopening and licensed product access required; not ordinary eBird API work. |
| td-bd06d6 — BirdNET sound upload | P4 | E gated: requires reopening the no-media-storage product decision. |

## How to execute and track this

Use **td-8ff597 as the plan index**, retaining its original requests. Link this roadmap and describe the A/B slices in its log; do not close it merely because the plan exists. Keep the existing tickets for their specific outcomes. Split mixed tickets into small child work only when implementation is about to start, with links back to the original; avoid creating another parallel backlog now.

Recommended start: **a short correctness pass from review F12–F15**, then A navigation/context implementation and two end-to-end journeys, alongside Nearest controls. The pass must verify hotspot identity before trip selection, fix All/Need labels and incompatible count comparisons, define complete ranking evidence, explain/merge compatible report sources, and make historical-load recovery actionable. Do not defer these behind visual polish. Then B location selection and All/Need/Seen access; then C long-page and trip improvements. Carry the shared visual rules through every package. Run only the supporting D work needed by that release, while preserving independent priority for urgent reliability and cost controls.

Each implementation handoff should name the routes changed, retained data scope, exact acceptance journey, remaining uncertainty, appropriate automated tests, and browser/device evidence. Update Help for changed workflows and About for meaningful releases. Commit/deployment remains a separate owner instruction.

The broad browser review has now tested these journeys and the principal pages at desktop and phone widths. Its findings refine package A as described above. Review the linked first-release specification and HTML concept before beginning the application changes. Live recent-data and worker journeys have now run successfully and exposed F12–F15. Physical iPhone/PWA and other unexecuted checks remain explicit release gates. Repeat the live journeys against each changed implementation.

## Evidence and boundaries

Reviewed all 31 open td descriptions/acceptance criteria and relevant closed ribbon children. Inspected the current shared layout, Forecast and Field Guide tabs, return-link helpers and call sites, taxonomy focus implementation, Field Guide location controls, Nearest loader, and Admin model/cost UI. The follow-up used working live eBird access, real account login and a running worker. Home returned 54 needs; Forecast used 127 loaded hotspots; both planner scopes produced routes; trip 18 persisted; jobs 5192/5193/5195 succeeded for refresh, life-list sync and first load; job 5194 exercised an upstream-timeout retry. The own-sighting symptom was reproduced and traced to upstream public-feed absence. Real-device behavior remains to be checked.

Repository references:

- `cs.md`, `AGENTS.md`, `docs/birds-app-design-V2-Fable-revision-plan.md`, and the mockup catalog.
- `src/routes/+layout.svelte`; `src/lib/components/FieldGuideTabs.svelte`; `src/lib/components/ForecastTabs.svelte`.
- `src/lib/return-link.ts`; `src/lib/taxonomy.ts`; `src/routes/taxonomy/+page.svelte`; species, hotspot, Forecast and Nearest link call sites.
- `src/routes/species/+page.svelte`; `src/routes/nearest/+page.server.ts`; `src/routes/admin/+page.svelte`.
- Existing Home consolidation and hotspot workspace plans, plus the hidden-data audit and release devlog. Older proposals are background: current code and later owner decisions take precedence, including the now-existing third Forecast tab.

No backlog priorities, parents, or statuses were changed for this planning pass. Existing uncommitted migration-comment work was preserved.
