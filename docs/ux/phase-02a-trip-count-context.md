# Birds UX phase 2A — counts that keep their meaning

September 18, 2026 · Parent td-8ff597 · Source finding F13
Status: released as `0ddf28a` on September 19, 2026. See the [review record](phase-02a-review.md) for independent acceptance and production verification.

## Outcome and phase boundary

A planner set to All species must never label its counts as needs. A saved
planner count must retain what was counted, where, over which window and from
which feed. A 30-day location preview of four species must not be compared as
an increase to a 14-day radius result of 29 needs.

Phase 2 is deliberately split at its data contract. **2A is this executable
work order:** vocabulary, authenticated saved provenance, independent current
nearby counts, and honest legacy handling. **2B remains required:** comparable
per-location ranking, visible progress/completeness and Home Best places.
2A must not claim to fix ranking completeness or increase upstream coverage.
The existing region-feed preview remains explicitly labeled throughout.

## Confirmed mechanism at release 582f665

- `query-engine.ts::runQuery` uses recentNearbyObs or notableNearbyObs and
  groups returned rows by location. The ordinary area feed does not enumerate
  every species at every location. `fetchedAt` belongs to that response.
- `buildCandidates` filters the owner's seen set only in needs mode. Existing
  `minNeedsPerStop` is the minimum matching species in either mode.
- Planner form, stop badges and shortage warnings still hard-code needs.
- Client `saveStops` posts target_count_at_save without its query context.
  `savePlannedTrip` writes stops atomically; `getStops` uses SELECT *.
- `needsCountForStops` fetches a separate 14-day, 16-km area feed around each
  stop, regardless of planner scope. Its count is distinct unseen species.
  The UI incorrectly places `(was N when planned)` beside this different count.
- Existing legacy trips have only an integer; do not infer mode/window from
  notes or current filters. A historical stop has no planner species count.
- Viewer write protection is in hooks; add an explicit save-action role guard
  as defense in depth and cover it in the action tests.

## Product behavior

1. Use `Minimum matching species/stop` in the form (stable before submission).
   The selected Count control remains My needs / All species. Header explains
   that matching species follow the Count setting. Result headings, candidate
   counts, selected-stop badges, route total, zero/shortage messages and min
   validation must agree. Needs singular/plural; species is invariant.
2. Query results use the executed `data.inputs`/query scope, not an unsent
   select value. Changing the form only changes results after Plan.
3. Keep all phase-1 identity safeguards, candidates, manual selection, map,
   ordering, source species and historical stops intact. Do not add a row cap.
4. Saved trip shows TWO separate statements, no numerical delta:
   - `When planned: 4 needs in the area-feed preview at this location · last
     30 days · within 25 mi of Huguenot ... · fetched ...` (All uses species).
   - `Now nearby: 29 life-list needs · last 14 days · within 9.9 mi of this stop`.
   Use the existing distance formatter, show actual recorded values, date/time
   via existing local formatting patterns. Identify rare/notable preview when
   used, and cached/stale provenance explicitly. Brief explanation: planning
   preview and current nearby count have different coverage and aren't a trend.
5. Snapshot must remain visible when current API data is missing/unavailable.
   Current unavailable must say unavailable, not zero. Keep the current actual
   needed-species list reachable; no new fetches for snapshots.
6. Legacy integer with no valid context: `When planned: N matches; original
   scope and window were not recorded.` Do not call it needs or all species.
   NULL count: no snapshot statement. Never fabricate a context backfill.
7. Owner and family viewer get correct labels. Use `life-list needs` for current
   counts so a viewer isn't told the shared owner's list is their own list.
8. Markdown/HTML export and public trip sharing use `near this stop` for the
   radius count and include the same neutral saved-snapshot explanation when
   available. Do not expose internal account ids, signing tokens or credentials.
   Public sharing continues to obey its existing live-needs behavior.
   Review refinement: the existing exporter still emits an external eBird hotspot
   link for every location id. Carry one batched cached hotspot-verification set
   through export and public-share builders, and render that external link only
   for verified ids. Keep internal location-detail links and data intact; no new
   per-stop upstream calls. Add an unverified-location export regression.
9. Touched controls >=48px; readable phone text, no squeezed action column.
   No toast, new modal or design-system expansion needed.

## Persistence and trust contract

Add migration **0061_trip_count_context.sql** with one nullable JSONB column
`trip_stops.planned_count_context`. No default, no backfill, no updates to old
rows. Existing target_count_at_save remains the integer for compatibility.
Use existing migrations runner against `.env.test` only; do not deploy 2A.

Use a shared typed module (`src/lib/trip-count-context.ts`) for serializable
context and pure formatting/validation. Version 1 requires:

- version: 1
- source: `area-recent-preview` or `area-notable-preview`
- seenStatus: `needs` or `all`
- daysBack: validated planner daysBack, 1..30 integer
- anchorLat, anchorLng, radiusKm, anchorLabel: executed query inputs; explain
  that the area endpoint rounds its fetch coordinates to two decimals (store
  actual rounded fetch anchor, preserve display label). Do not label the radius
  as a per-stop radius.
- locationId: string or null; locationLat/locationLng bind the selected stop
- count: nonnegative integer, same as target_count_at_save
- fetchedAt: actual observation response ISO timestamp
- plannedAt: server ISO timestamp when assembling the preview
- stale: whether the observation feed itself was served stale (not the separate
  hotspot-reference state). Add a separate observationStale in QueryResult if
  needed; existing aggregate stale remains for the overall preview.

Server creates context from query result + candidate, not from form claims.
Protect each birding candidate's context with an HMAC token using configured
AUTH_SECRET (read dynamic private env; no fallback secret). Use a separate
`src/lib/server/trip-count-token.ts`; domain separate its signature from other
uses (`birds:trip-count:v1`). Token payload binds the actual logged-in account
id AND scope owner id, the context, and an expiry 24h after plannedAt. Sign the
serialized payload bytes; verify the exact bytes with timingSafeEqual and
strict structure checks. Invalid, expired, cross-user, changed location, or
count mismatch is an explicit 400 re-plan message, never silent downgrade.
No token/secret logging. If AUTH_SECRET is absent, an explicit configuration
error must prevent issuing a falsely valid snapshot; owner will repair config.

The loader can return a token map by the existing candidate key; all candidates
(including unverified explicitly addable locations) get tokens. Client passes
selected candidate token beside each stop. Historical stops carry neither
count nor token; reject a count without a token for birding stops in this new
save flow. Missing token from an old open planner tab says re-plan. Do not
re-fetch eBird on Save: persist the exact signed context, preserving the preview
that the user actually selected even if the cache changes in the meantime.

At the action boundary: reject null/non-object stop entries cleanly, non-finite
or out-of-range coords, negative/fractional counts, duplicate candidate identities
and token binding failures before inserting. Keep existing 11-stop save bound
visible/action error; this work does not change that established limit. Preserve
custom names/notes/Google ids within existing length limits. Token binds identity
and coordinates, not user-editable name/notes. Transaction stays all-or-nothing.
Historical stops require null hotspot id and null count/context. Existing manual
(non-planner) add/edit paths remain usable and produce null context.

Read path: unknown version, malformed JSONB, or count/context disagreement means
unknown legacy context (do not crash or trust malformed data). Do not mutate
stored metadata on ordinary note editing, reorder, load or export. If a stop's
location is changed by an existing update action, clear its snapshot/context
atomically rather than associating an old count with a new place; first inspect
whether the current actions support this, and report the result.

## Implementation boundaries

Likely changes: query-engine.ts and its tests; planner page/server; trips.ts;
trip detail page/server as needed; trip-export.ts and tests; new context/token
modules + tests; migration 0061; Help/About. Reuse existing return/context links,
notes normalization and authorization. Avoid renaming legacy internal fields
unless needed; comments should explain All-mode meaning.

Primary owns docs/devlog/td and independent browser acceptance. Implementer
owns runtime/tests/migration/Help/About. Do not commit, push, deploy, reset test
DB, change credentials or stop workers. Test server is already live at 5178;
DB must be 127.0.0.1:15436/birds_test. User explicitly authorized real eBird access
and test mutations; this overrides cs.md's older fixture-only rule for this work.
All secrets remain private. Preserve the unrelated migration 0049 comment.

## Required verification and handback

- Unit/runtime tests for needs/all badges/copy/warnings/count contract, ordinary
  vs notable source, stale observations independent of stale hotspot reference.
- Token tests: tampering, wrong account/scope, expiry, negative/fractional count,
  malformed context, loc/coordinate mismatch; valid manual unverified candidate.
- Save-action tests: actual loader-token to selected-stop flow, rejection before
  transaction, null input, viewer 403, historical null, legacy open-tab 400.
- Persistence tests must inspect actual SQL context binding and atomic rollback
  behavior with the existing transaction helper; primary will also save/reload
  real test trips and inspect JSONB, not rely solely on mocked DB assertions.
- Formatting/export tests: needs/all/rare/stale, legacy context unknown, snapshot
  survives current unavailable, no `(was N)` comparison, public labels neutral.
- Existing phase 1 tests plus planner-note/trip-export/share-route regressions.
- `npm run check` zero errors/warnings; `npm run build`; diff whitespace check.
- Apply 0061 via supported runner to test only after inspecting environment guards.
  No synthetic DB observation rows; use existing real test data for browser work.

Primary live acceptance: plan identical Huguenot 30-day queries in Needs and All;
verify correct badges and warnings, manual yard selection still allowed; save
and reload both, inspect provenance JSONB and independent 14-day nearby labels;
check legacy trip 18, family viewer and export; no-key/missing live data variant
without permanently removing credentials; 390px and desktop visual inspection.
Report changes, commands/results, migration state and any decisions needing
review. Phase 2B must remain explicitly open after 2A acceptance.
