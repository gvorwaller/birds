# Birds UX phase 1 — trustworthy trip location identity

Status: released as `582f665` after independent review · September 18, 2026

See the [review and verification record](phase-01-review.md).
Owner/reviewer: primary Codex agent · Implementer: lower-cost delegated agent
Task: td-d22017 · Parent: td-8ff597 · Source finding: F12 in ../2026-09-18-birds-ux-review.md

## Outcome and phase boundary

An automatically suggested birding stop must be a verified eBird hotspot. Other
reported locations remain visible and can be deliberately added, but are never
labeled as verified hotspots solely because their location id starts with L.
Saved trips, including existing trips, must use the same honest identification.

This is the first small, independently reviewable phase. Do not implement all
of the release-1 proposal at once. Scope here is location identity, automatic
selection and its explanations. All/Need count corrections, comparable saved
count provenance, ranking completeness, personal/public report integration,
location-load recovery, navigation, layout and wider geography are subsequent
phases. The small candidate-preview explanation below acknowledges the known
ranking limitation without pretending this phase repairs that algorithm.

## Verified current behavior

At the audit revision 8ceb97c, the Huguenot plan at lat 30.410, lng -81.419,
25 miles, 30 days, minimum 1, My needs generated 36 candidate locations. It
selected Jax Heights Yard 2 (L35320851) automatically. Huguenot Memorial City
Park (L127286) and Omni Amelia Island Plantation Resort (L3343382) are present
in eBird hotspot metadata; the yard is not. Saved test trip 18 incorrectly
badges the yard as an eBird hotspot. Live report counts change over time, so
acceptance is about these identities/invariants rather than an exact count.

Mechanism:
- query-engine.ts::buildCandidates groups all observation locations.
- assembleTripPreview selects eligible candidates by rank and assigns every
  birding candidate kind "hotspot"; locId is copied to hotspotId.
- The planner's client independently reconstructs curated stops and makes the
  same unconditional assignment.
- The planner's external link and saved trip badge test only for a nonempty id.
- The database column trip_stops.hotspot_id already contains both kinds of ids.
  It must not be treated as a verified classification or destructively cleaned.

## Product decisions (implement, do not reinterpret)

1. Positive hotspot evidence means membership in an actual eBird hotspot
   reference response, obtained through existing cached hotspotsNear, or in
   stored hotspots:/hotspotsRegion: reference responses for saved trips.
   An L-shaped id, an observation, Google Maps match, saved trip field, name,
   locationPrivate=false, or user-supplied boolean is not positive evidence.
2. Missing reference evidence means **unverified**, not "private". Never assert
   a location is private without evidence. A verified hotspot does not imply
   unrestricted public access either.
3. Automatic selection considers only verified hotspot candidates meeting the
   existing minimum-species threshold. It must fill from the remaining verified
   candidates in rank order, then preserve current nearest-neighbor ordering.
   If fewer exist than requested, return fewer with a truthful explanation.
4. All current observation candidates remain accessible, in the existing full
   ranked list, including unverified, offshore and below-minimum locations. No
   cap, filtering-away, or lossy database cleanup is allowed.
5. Adding an unverified candidate is an explicit choice: show its status and
   access explanation beside an **Add reported location** action. No extra modal
   is required. Removal works identically. It must not be preselected.
6. A manually selected unverified location persists with its name, original
   location id, coordinates, map id and notes intact, and stays unverified on
   reload unless actual reference evidence becomes available later.
7. Historical sightseeing stops remain a separate kind and retain the existing
   include/remove behavior. They are not classified as birding hotspots.
8. On reference-fetch failure, continue showing observation candidates; select
   no unverified automatic stops. Explain that hotspot verification is
   unavailable and manual selection remains possible. Stale cached reference
   data may provide positive evidence, but propagate its stale indication.

## Concrete implementation contract

### Engine: src/lib/server/query-engine.ts

- Add an explicit `isVerifiedHotspot: boolean` to PlaceCandidate.
- Extend buildCandidates with a final `verifiedHotspotIds: ReadonlySet<string>`
  input (an empty default is acceptable for older direct callers). Preserve
  candidate grouping, counts, ordering, radius and eligibility semantics.
  `eligible` continues to mean meets minimum, not "is a hotspot".
- runQuery obtains hotspot reference data via cached hotspotsNear for exactly
  the same anchor/radius as the observation query. Do not make per-location HTTP
  requests. Fetch independent dependencies concurrently. Add explicit query
  verification state, e.g. `hotspotVerification: 'available' | 'unavailable'`;
  stale reference evidence contributes to QueryResult.stale.
- Keep observation lookup failure handling unchanged. Catch reference-fetch
  failures only at their boundary so an observation error isn't hidden.
- assembleTripPreview filters automatic birding choices by BOTH eligible and
  isVerifiedHotspot. Change its shortage/empty warnings to name verified
  hotspots. Keep every candidate in QueryResult.candidates.
- Extend PlannedStopKind to include `observation` for manual reported stops.
  The legacy hotspotId field may retain the observation location id for this
  phase; document that kind/classification, not field presence, governs labels.
- Keep the existing planner loader's supplementary metadata; it can reuse the
  cached geo response. Avoid adding a second live HTTP request or per-row calls.

### Planner page: src/routes/trips/plan/+page.svelte

- Server and client stop reconstruction must agree: verified candidates map to
  kind hotspot; other birding candidates map to kind observation.
- Automatic defaultKeys come only from server-selected verified hotspots.
- Manually selected observation stops participate in ordering, the map,
  species totals, remove, save and reload just like other birding stops.
- Preserve stable selection keys using original location id or coordinates.
  Re-planning reseeds from the new verified defaults; a previous manual
  selection must not become an automatic choice through stale local state.
- Only verified candidates/stops get the eBird hotspot external link/badge.
  Unverified rows and selected preview stops display **Reported location** and
  **Hotspot status unverified. Check access before visiting.**
- Use **Reported places (N)** for the full candidate heading. Supporting copy:
  **Places represented in the current eBird response. Counts are a preview,
  not a complete inventory of each location. Suggested stops use verified
  eBird hotspots; other locations may be private, restricted or offshore.**
- If verification is unavailable, display an inline warning: **Hotspot
  verification is unavailable. No unverified locations were selected
  automatically; you can still add reported locations after checking access.**
- Verified rows retain ordinary Add/Remove. Unverified rows use **Add reported
  location** / Remove; accessible names should identify the location.
- Do not introduce modal/toast frameworks or redesign this page. New/changed
  actions must meet 48px targets and the existing theme/focus conventions.
  At phone widths, keep candidate descriptions full width and put the
  count/distance/action row beneath them; use the side-by-side arrangement
  from 640px upward. The longer explicit action must not squeeze all species
  text into a narrow column. This refinement came from visual review of the
  first implementation, rather than changing which data is displayed.
- Keep viewer behavior read-only and existing authorization intact.

### Saved trips: batch cache verification, server-derived

- Add a reusable server helper, preferably in src/lib/server/hotspots.ts,
  `cachedVerifiedHotspotLocIds(ids: readonly string[]): Promise<Set<string>>`.
  Query the existing public hotspot-reference cache in one batch; restrict to
  hotspots: / hotspotsRegion: keys and exact matching locId values. Handle an
  empty id list without a query. Do not infer from species/frequency tables or
  Google location metadata. Use parameterized SQL. No HTTP fan-out.
- In src/routes/trips/[id]/+page.server.ts, classify the saved stop ids using
  that helper and return an isVerifiedHotspot property per displayed stop.
  Compute from server data, never posted stop booleans. Preserve all stored
  ids/data. No schema migration or destructive backfill is needed in phase 1.
- In src/routes/trips/[id]/+page.svelte, condition the external eBird hotspot
  badge/link on the new verified property, not hotspot_id presence. Existing
  internal location-detail links may remain, since the route also displays
  known observation locations. For an unverified eBird location id, display
  the same Reported location/status text. Do not label custom Google-only or
  historical stops as eBird reported locations when they have no eBird id.
- Read-only viewers and old saved trips receive the same correct labels.
- Preserve export content and trip editing/navigation functionality. Audit any
  changed type usages without changing unrelated behavior or API shapes.

### Documentation

Update Help's trip-planning explanation and add a plain-language About version
history note. Explain automatic verified hotspots versus explicit reported
locations and that hotspot membership is not a guarantee of access. Describe
candidate counts as preliminary; do not claim full ranking repair.

## Verification and acceptance

Use unit fixtures in tests only; do not seed invented observations into the
working test database. Existing live test data and audit trip 18 are available.

1. Pure engine test: an unverified location has the highest matching count, but
   is not auto-selected; lower-ranked verified hotspots are selected instead.
   Assert the unverified location and all its species remain in candidates.
2. Empty/failed verification test: candidates remain, auto selection is empty,
   explicit warning/state is present; no unknown locations promoted to hotspots.
3. Shortage and historical-stop regression: only verified candidates count
   toward automatic requested birding stops; history inclusion/order is retained.
4. Cache helper test: exact ids in correct reference namespaces count; ids only
   in observation caches do not. Empty input returns empty. Test batch behavior
   with injected/mocked query, plus reviewer reads real test cache evidence.
5. Browser at desktop and 390px: live Huguenot query auto-selects verified stops;
   the yard stays in Reported places and is not initially in preview. Explicitly
   add it, save the trip, reload; name/id/notes survive and no false hotspot badge
   appears. Open preexisting trip 18 and verify its yard badge is corrected.
6. Browser: remove/re-add location, re-plan/reset, valid hotspot link, map and
   route, read-only viewer rendering, and no horizontal overflow. Keep the full
   candidate list available. Compare its count against baseline for the same
   cached query, not a hardcoded changing live count.
7. Focused Vitest tests for affected helpers/engine, `npm run check`, and
   `npm run build` must pass. Do not run DB-reset suites against the populated
   audit database. Report actual commands/results, including preexisting errors.

## Working environment and constraints

Checkout: /Users/gaylonvorwaller/birds. Read cs.md and AGENTS.md. Existing
modified migration-0049 comment and untracked UX documents/devlog belong to
prior work: preserve them. Do not commit, push, deploy, reset/stash, or discard
unrelated edits. Only edit this phase's runtime/tests and Help/About; primary
agent owns specification, roadmap and devlog updates during this handoff.

Use running test at http://127.0.0.1:5178 with .env.test and exact guard
PGHOST=127.0.0.1, PGPORT=15436, PGDATABASE=birds_test. Owner explicitly permits
working production eBird credentials in isolated test and test data mutations;
this overrides the older test-credential prohibition. Never print secrets.
Do not touch production, change credentials, reset test data, stop the worker,
or trigger paid enrichment. No environment failure is an excuse to skip the
journey: diagnose it and report concrete repair needs to the primary agent.

The primary agent performs independent diff review and browser/DB acceptance.
Implementation is not accepted based solely on the implementer's test report.

## Implementer handback

Return changed files, behavior delivered, exact checks/results, any spec
ambiguities or departures, and known remaining failures. Do not self-approve
or mark the parent complete. Address reviewer findings before phase closure.
