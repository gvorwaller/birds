# Birds UX phase 3 — recent-report evidence and personal sightings

September 19, 2026 · Parent td-8ff597 · F14 · td-3d9544 / td-d71bad
Status: implemented and independently accepted for review; see [review evidence](phase-03-review.md). Production remains phase 2B e730c56.

## Outcome and boundary

Public feeds disagree and a life-list record is not complete checklist history.
Home must show the owner's known dated sighting even when public feeds omit it.
Duplicate upstream rows must not inflate activity. Nearest must include nearby
notable evidence, offer explicit window/distance controls, and describe coverage.

Scope: public aggregation, Home, species detail and /nearest. Preserve caching,
streaming, bounded nearest ladder, forecast selection and phase 2B comparison.
No migration, complete checklist import, new provider, production writes,
map/navigation redesign or AI work. No phase 3 commit/deploy until reviewed
and separately authorized. Primary owns spec/review/docs/td; lower-cost
implementer owns app code, focused tests, Help and About.

## Verified paths

- observations.ts::obsKey ignores checklist ID; nearest-ladder uses it before
  its stopping rule. Distinct checklists at identical place/time must survive.
- needs.ts::aggregate sums duplicate upstream rows. Enriched Needs intentionally
  retains base evidence across cache generations; preserve that guarantee and
  bounded four-way fetch scheduling.
- Home loader streams geoTargetsBase enrichment. Initial controls can work
  while HTML remains open; acceptance must await hydration, not DOMContentLoaded.
- seen_species has one first_seen DATE per species plus source, location_name,
  loc_id, sub_id and obs_count. Join ebird_locations and scoped lifer_loc_coords
  for coordinates exactly as routes/life/+page.server.ts does. No new data needed.
- Species nearby merges recent-species/notable but hides a one-sided failure.
  Species Nearest is on-demand, needs-only, from saved home, using page back.
- /nearest hardcodes 14 days. Both callers use the direct/region ladder without
  nearby notable evidence. Direct-empty permits “No reports anywhere”.
- Ladder already caps results at five with essential budget/cancellation/unknown
  history invariants. Preserve those; do not redesign region search.

## Shared identity, status and provenance

Add client-safe pure helpers; no server/DB imports from Svelte components.
Report identity = species + location (locId, else exact finite coordinates) +
observation timestamp + checklist ID when supplied. Distinct nonempty subIds
at one place/time are distinct. Identical copies within/across feeds deduplicate.
Without checklist use species/location/time; don't guess that an anonymous row
matches one of several named checklists. Count/status changes don't create IDs.
Svelte each keys use shared identity, not locId+obsDt.

On conflicting duplicates, primary source supplies count/time, source labels
union, and review status merges conservatively: explicit obsValid=false wins;
true only when no explicit false; missing is unknown without any boolean.
Use Accepted / Unconfirmed / Review status unavailable. obsReviewed alone never
means accepted. Preserve actual eBird local timestamp strings, not guessed UTC.

Deduplicate before aggregate totals and ladder hit counting. Do not invent one
bird for missing howMany in touched UI/aggregates: track known count sum and
reports without a count; label “reported count” plus missing-count disclosure.
Keep existing base-versus-enriched count distinction and full place lists.
Home species/place summaries expose unconfirmed and unknown-status counts.
Row-level source labels distinguish area preview, recent species, notable,
nearest endpoint and regional search. Also show window, fetched time, stale
state. A duplicate found in two feeds retains both labels.

Species Nearby/Nearest use consistent status/source. A one-sided fetch failure
retains good rows with incomplete-source disclosure; both failing is unavailable,
not empty success. Don't add provider calls merely to populate badges.

## Personal recorded sightings

Add a scoped DB-only loader and reusable Home/species card. Scope comes ONLY
from locals.scopeId, never URL user ID; Life remains the explicit cross-owner
picker. Do not change Seen/Need state, public counts/rankings, alerts, hotspot
comparison or nearest-lifer selection.

Home title: Your recorded sightings (own scope), Family list recorded sightings
(viewer of owner). Explain these are first-seen life-list records, not complete
checklist history, and are separate from public totals even when a checklist
also appears publicly. Place near public reports; available without API key.

Filter known coordinates to active Home radius and first_seen to the selected
number of calendar dates including today, using defined UTC calendar date with
injected date in tests. Display “Recorded dates [start]–[end]”; DATE cannot prove
the last 24 hours. Reject future/invalid dates. Window-matching unresolved coordinates
remain reachable under “Location unavailable — not included in this area's
results”. Undated records remain accessible via a labeled Life list link.
No inline geocoding, no fabricated coordinates, no hidden row cap; explicit
Show all allowed.

Join ebird_locations then user-scoped lifer_loc_coords as Life does. Display
species, first-seen date, stored location name, real distance/map when known,
stored checklist link, and obs_count as recorded count only when present.
Never represent personal data as a public accepted eBird report. Species detail
shows its first-seen record regardless of current window, honestly handling
missing date/location, while retaining existing header. Home-to-species links
preserve origin/window/safe return context. No write actions.

## Nearest controls and evidence wrapper

Shared parser/control contract for /nearest and species Nearest card:
- back=1|7|14|30, default 14 only when absent.
- nearestKm=any|25|50|100|250|500, default any only when absent.
- Invalid supplied values produce clear 400/inline error BEFORE provider calls;
  do not silently reinterpret them.
- Store km; display distance options via existing formatDistance and mi/km toggle.
  Unit changes preserve geographic scope. Submit explicitly via Check/Search.
- /nearest selected-code, search, auto-run, species and return links retain values.
  Species form retains all existing origin/back/returnTo params, adds nearest=1
  and nearestKm; don't discard navigation trail or retarget Nearby's origin.
- Label selected window and “from saved home”, even before running. Keep existing
  needs-only behavior. Controls >=48px, input font>=16px, semantic colors, no toast.

Introduce one shared server wrapper used by BOTH route loaders:
1. Run existing nearestSpeciesReports with existing caller policy: species
   detail 40 probes/20s ladder, /nearest 8 probes/15s with its page-global gate.
2. In parallel read notableNearbyObs at saved home, same window, radius=min(finite
   selected maximum,50), else 50. /nearest auto-run shares ONE notable promise
   across all six targets. Bounded per-call deadline<=8s via compatible internal
   optional helper option if required; don't cancel another shared cache request.
3. Filter notable rows to species, valid finite coordinates, radius and compatible
   dates. Compare local date strings conservatively, not guessed UTC timestamps;
   date-only uses calendar interpretation. The provider query is authoritative
   for rolling back windows. Unlike personal DATE filtering, retain yesterday
   for back=1; eBird local timestamps have no zone. As a conservative sanity
   guard, allow UTC today minus (back+1) calendar dates through UTC tomorrow,
   rejecting only clearly older/future dates beyond that range. This margin
   accommodates unknown local timezone/date-only precision, not broader-cache
   reuse. Never reuse a broader incompatible window as if it matched.
4. Merge/dedupe all engine/notable rows, sort actual haversine with stable identity
   tie-break, THEN take closest five. Explicitly say “Showing up to five closest
   reports returned by the checked feeds.” Remove /nearest's extra hidden slice
   to three; it should render all five engine results. No reduction elsewhere.
5. Apply finite distance to every returned row. Preserve proven/capped/partial,
   region count/coverage plus separate notable coverage. Notable success doesn't
   prove world coverage or repair unsearched regions. A nearest failure with
   good notable rows remains useful but incomplete, and vice versa. Both failing
   means unavailable. Stale fallback and failed refresh must remain visible.
6. Empty wording: no matching reports returned by checked feeds for selected
   window/distance; other reports may be unavailable. Preserve regional caveats.
   Never “No reports anywhere” or any biological-absence claim.
7. Fatal 401/403/429 stops new fallback scheduling; retain settled evidence with
   incomplete status. Preserve page-global 40s and bounded concurrency. No six
   serial 8s waits or extra unbounded fan-out. Existing zero/unknown occurrence
   candidates remain searchable and ladder budgets/tests remain intact.

Retained streamed results are scoped to their query: Nearby uses species, active
origin, radius and window; Nearest uses species, saved-home origin, window and
maximum distance. Keep good data on same-query invalidation, clear it when scope
changes, and ignore an old promise settling after a newer scope becomes active.
Never display retained rows under a different query window or distance label.

Finite distance is a result filter and nearby-evidence bound, NOT a claim that
all locations within that circle were checked; explain this limitation.

## Required tests and real acceptance

Tests execute actual meaningful pure/service/loader paths:
- duplicate checklist collapse, distinct same-time checklists survive, anonymous
  fallback, source union, status conflict, missing count, stable Svelte keys;
- personal date boundaries/future/undated, coordinates/radius/unresolved, viewer
  scope and cross-account isolation, no writes or public aggregate pollution;
- empty/far engine plus closer notable, dedupe before top 5, window/radius isolation,
  one notable read for six targets, stale/one-sided/fatal/no-key behavior;
- both loaders pass validated controls, preserve URL context, retain needs-only;
  existing nearest ladder regression suite, aggregate/enrichment regression suite.

Run focused affected suites only, npm run check zero errors/warnings, production
web/worker build and diff check. No broad DB suite, no resetting seen fixtures.
Don't build while primary browser acceptance is using the dev checkout.

Primary live acceptance in isolated test: actual Short-tailed Hawk September 2
first-seen/checklist on Home saved-home 30-day view and species page; viewer scoping;
current Nashville Warbler public feed differences; Home-to-species and Nearest
1/30 days, any/finite distance, units/back links. If current feeds no longer show
the missing-notable case, use explicitly labeled injected fixtures for that
regression alongside real live results. Desktop/390px Chromium/WebKit, no page
errors/overflow, owner 227 species preserved, db/worker/gallery healthy. No
synthetic DB rows or production writes. Return exact files, checks, caveats and
remaining concerns; primary reviews before changing ticket to review.
