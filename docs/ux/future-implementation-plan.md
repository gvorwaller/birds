# Birds UX continuation plan after Phase 7B

September 20, 2026 · Planning only · Parent td-8ff597

## Objective

Continue the successful phase-by-phase UX program without turning the remaining
backlog into one risky rewrite. The next releases should make location, list
scope and trip use feel like one continuous workflow while preserving the full
dataset, honest coverage language and the navigation work already released.

This document is an implementation sequence, not an implementation. It creates
no new child tickets, changes no ticket status or priority and authorizes no
code, data, commit or deployment.

## Current baseline

Phases 1 through 7B are released. They established trustworthy trip-location
identity, explicit count provenance, comparable hotspot evidence, personal and
public report separation, recoverable background loads, preserved journey
context, keyboard-correct shell behavior, compact Field Guide results and
species-page section navigation.

The parent td-8ff597 remains open for the outcomes that were deliberately left
for later:

- choose a place at country, state/region, county, hotspot or map/radius level;
- distinguish recently reported birds from historically expected birds;
- switch complete lists among All, Need and Seen without losing place or path;
- carry a chosen place and list scope through Field Guide, Forecast and trips;
- remember species-card disclosure choices without breaking linked targets;
- make saved trips useful while birding, including checked-off stops;
- expose selected map, route, weather and operational detail in later bounded
  releases.

The owner's forthcoming regression list takes precedence over this queue. A
confirmed regression in a released journey is repaired and released before the
next phase that depends on that journey.

## Working method for every phase

Continue the workflow used for Phases 1–7B:

1. Codex primary reproduces the current behavior with real production-like test
   data and writes a frozen specification with exact examples.
2. Create and start one child td only when that phase is ready to implement.
   Link it to the existing source tickets instead of replacing them.
3. Codex primary sends the frozen specification through Claude Relay to the
   exact `CC1` identity. CC1 is the sole implementation writer and returns a
   concise change and focused-test report. Codex primary reviews the entire
   diff and sends any required corrections back to CC1.
4. Once that review is clean, Codex primary sends a separate read/test-only
   charter through Claude Relay to the exact `GROK` identity. GROK runs the
   relevant automated suite plus the specified Chromium/WebKit desktop and
   390px acceptance journeys, concentrating on UI/UX regressions, accessibility,
   preserved navigation state, account isolation and honest data meaning. GROK
   reports evidence and defects; it does not edit the implementation unless the
   owner explicitly changes that role.
5. CC1 fixes confirmed defects, GROK retests affected journeys, and Codex
   primary performs final diff review and proportionate verification. Only one
   implementation writer is active at a time.
6. Move the child ticket to review. Commit and deploy only after the owner asks.
7. Release through the standard health-gated script, verify the exact revision,
   authenticated changed surfaces and absence of unintended production writes,
   then close only the tickets whose full acceptance criteria were delivered.

Each phase must retain complete result access, existing pagination, streamed
loading, role isolation, source attribution and honest unknown/zero/partial
coverage distinctions. No phase may gain speed or visual simplicity through a
silent row cap, hidden default radius, fallback location or reduced detail.

## Gate 0: regression stabilization

**Trigger:** the owner's list from daily production use.

Before starting a dependent feature phase, turn each reported problem into a
small reproduction record containing page, account role, input URL/state,
action, actual behavior and expected behavior. Classify it as:

- a regression from Phases 1–7B;
- a pre-existing defect exposed by the new flow;
- a design preference that belongs in a later phase; or
- a data/coverage condition whose UI explanation is wrong or missing.

Confirmed workflow regressions receive a focused repair ticket and release.
Preferences are incorporated into the relevant phase specification. The goal
is to protect the improvements that work rather than roll back whole phases.

**Exit:** all blocking regressions are released; lower-severity items are mapped
to a phase with an explicit reason. No speculative fixes are bundled together.

## Gate 1: trustworthy implementation foundation

Complete the narrow reliability work that makes the next data-heavy phases safe
to judge. These are separate support tickets, not a combined rewrite:

1. **td-b29d1c — DB test races.** Remove cross-file fixture interference and
   prove repeated full-suite green runs.
2. **td-c41126 — production-sized test corpus.** Make assertions independent of
   a near-empty database and give measured long-running queries deliberate
   timeouts rather than blanket waivers.
3. **td-96ed83 — upstream payload contracts.** Add boundary validation and
   contract-drift reporting first for the eBird endpoints touched by geographic
   search, then NOAA when weather work begins. Cached last-good data must remain
   usable when validation fails.
4. **td-57d9fc — antimeridian centroids.** Resolve before a global map/radius
   chooser relies on affected centroids. Do not block US-only specification and
   prototype work, but do block worldwide release.

These tickets may release independently. Gate 1 does not include the broad
performance or Admin backlog.

**Exit:** repeated trustworthy database tests, production-sized assertions,
validated geographic API boundaries and correct global coordinate behavior.

## Phase 8: unified geographic discovery

**Source tickets:** td-d2bb08, td-1e86c2, geographic portions of td-8ff597;
conditional dependencies td-f9e34d and td-57d9fc.

### Phase 8A — location contract and Field Guide choices

Define one explicit location selection contract that can represent:

- Anywhere;
- country;
- state or first-level region;
- county or equivalent smaller region;
- a verified eBird hotspot; and
- a map point plus an explicit radius.

Implement it first in Field Guide. The selector must show the selected place,
its type, radius when applicable, source and coverage. URL state must be
canonical and shareable, preserve unknown parameters and retain the exact
result row on a species round trip. Changing a higher geographic level clears
only incompatible lower levels. A map viewport must never silently become the
search radius.

Reuse the existing MapPicker, geocoding and location-context structures. Do not
create a second map stack. Audit td-f9e34d's county grouping before relying on
it; split and implement only the county work actually required here.

**Acceptance journeys:** Florida → county; Florida → verified hotspot; typed
place → map adjustment → 25-mile radius; clear back to Anywhere; reload and
shared URL; owner and viewer; JavaScript-disabled form fallback; global
antimeridian example; exact species-return row.

### Phase 8B — discovery from Hotspots & data

Use the same contract in Hotspots & data so typed search and the map can find
countries, regions, counties and verified hotspots. Selecting a result opens
the existing detail/load workflow with a named return path. Unverified reported
locations remain labeled as such and are not promoted to hotspots.

This phase may use the descriptive-metadata audit td-39d567 to decide what can
truthfully appear in results. It must not invent venue descriptions or public
access claims.

**Exit:** one documented geographic model works in Field Guide and Hotspots &
data without changing result meaning or loading data implicitly.

## Phase 9: explicit list and time scope

**Source:** list-scope portions of td-8ff597.

### Phase 9A — All, Need and Seen

Add a visible list-scope control where species lists are being explored. Begin
with Field Guide and the location results delivered in Phase 8:

- **All** — every species supported by the selected dataset and filters;
- **Need** — All minus the signed-in account's life list;
- **Seen** — the signed-in account's matching life-list species.

Viewer accounts continue using their own configured displayed/owner-list
contract; scope must never leak the signed-in owner's private state into another
account. Counts, empty states, pagination and exports must name the selected
scope. Preserve it through species detail and return navigation.

As these lists are touched, apply one shared species-row hierarchy: reference
thumbnail or an honest unavailable state, common/scientific name, Seen/Need and
other personal badges, result/evidence meaning, and a stable row target. Audit
Home, Field Guide, Forecast, location detail, trips and personal collections;
adopt the pattern in bounded slices rather than silently claiming every list is
uniform after the first release.

### Phase 9B — Recently reported versus historically expected

Make the data question explicit rather than overloading “location”:

- **Reported recently** uses a named window and the applicable current eBird
  feeds, with accepted/unconfirmed and partial-feed evidence retained.
- **Expected historically** uses loaded frequency data for a named month or
  annual view, with checklist/sample coverage and unknown areas disclosed.

Do not merge these into one unexplained ranking. A species may appear in both;
the UI should explain why rather than deduplicate away the evidence. Missing
historical coverage is unknown, not absence. No fresh eBird load happens merely
because a user changes a display filter.

**Acceptance journeys:** one Florida county and one hotspot in All/Need/Seen;
recent 7/30-day versus historical month; a no-coverage location; a species that
is Seen but recently reported; owner/viewer isolation; pagination beyond the
first 100; exact return URL and row.

**Exit:** the user can answer “what is here?”, “what do I still need?”, “what
have I seen?” and “is this current or historical?” without guessing.

## Phase 10: carry place and scope through the app

**Source:** remaining td-8ff597 continuity work and td-caea82 where account
selection affects viewer behavior.

### Phase 10A — Forecast and Home

Adopt the Phase 8/9 location and list-scope contract in Forecast and the
appropriate Home entry points. A chosen county, hotspot or map/radius selection
must open Forecast without silently reverting to saved Home. Forecast retains
its frequency meaning; Home retains its recent-report meaning. The transition
must state when the destination cannot represent the source scope exactly.

### Phase 10B — trip planning handoff

From a scoped species list, start a trip with the same place, radius, report
window and All/Need choice where the planner supports it. Do not silently turn a
county into its centroid plus a default radius. Preserve the source list and row
as the return path. Trip candidate evidence and verified-hotspot rules from
Phases 1–2B remain unchanged.

### Phase 10C — viewer account owner selection (td-caea82)

Implement td-caea82 as a required Phase 10 slice: allow authorized viewer setup
to choose which owner life list the viewer account displays, while personal
Viewed/Special interest state remains attached to the signed-in viewer. The
selector must list only owners the administrator is authorized to assign; it
must not expose unrelated accounts. Audit authorization, account creation,
existing-viewer migration and owner-change behavior before adding the control.

**Acceptance journeys:** create a viewer and select its owner; edit an existing
viewer to select a different authorized owner; sign in as that viewer and prove
the chosen owner's life list drives Seen/Need; prove Viewed/Special interest
remain the viewer's own; prove an unauthorized owner cannot be discovered or
assigned; reload and sign in again to prove persistence.

**Exit:** place, time scope and list scope travel as far as each destination can
truthfully support, and any conversion is visible.

## Phase 11: species-page working preferences

**Source tickets:** td-74b012; optional td-9308e.

Extend the Phase 7B disclosure contract so selected cards can be collapsed and
their state remembered. Specify storage and SSR behavior before coding:

- preferences are account-scoped in the browser unless cross-device storage is
  explicitly approved;
- default-open behavior remains useful for first visits and no-JS pages;
- an On this page link always reveals its target regardless of preference;
- migration-ribbon and Similar-species internal state survives closing;
- preferences reset or migrate safely if cards or IDs change;
- absent cards do not leave dead menu links or preference controls.

Treat the Birds of the World link as a separate optional slice. Implement it
only after verifying current authentication/link behavior and deciding whether
the app stores any account login information; a plain external link must not
pretend to provide subscription access.

**Exit:** long species pages are personally manageable without weakening the
fast section navigation or hiding content unexpectedly.

## Phase 12: trips in the field

**Source tickets:** td-40a1b5; selected portions of td-71494e and td-bf7cc4.

### Phase 12A — stop check-off

Add reversible per-trip visited state modeled on the Trips app behavior. Show
progress without removing unvisited stops or changing route order. Define
owner/viewer permissions, offline/retry behavior, reset semantics and export
representation. Checking a stop must not imply that every target bird was seen.

### Phase 12B — route detail

Use the actual directions overview polyline and show per-leg travel times after
measuring API cost, cache behavior and mobile readability. Retain straight-line
or pin-only fallback only when labeled as unavailable, never as if it were the
actual route. Venue-type chips or parking/access metadata require the
td-39d567 source audit and explicit evidence.

### Phase 12C — weather that changes a birding decision

From td-bf7cc4, first specify the smallest useful release: likely trip-day
alerts, gusts and enough periods for multi-day trips. Add NOAA schema validation
from td-96ed83 before changing the cached payload. Hourly/current/detail views
remain later unless the field journey proves they are needed.

**Exit:** a saved trip can be used and updated during the outing, with route and
weather claims matching their real sources.

## Phase 13: cost controls, observability and measured performance

This is a supporting product lane after the core UX continuation, except where
a ticket is an explicit prerequisite.

### Phase 13A — safe enrichment expansion

Implement td-02fc4a before td-5086cc. Every large enrichment action must show
scope, selected model, cost estimate or explicit uncertainty, existing coverage
and pause/cancel controls, then require deliberate approval. Only after that
gate is proven should “enrich every current taxonomy species” expand the
universe. Preserve last-good content, terminal outcomes, retry/backoff and
provider safeguards. Fold td-8cecc6's invalid iNaturalist identifier repair into
this lane before a large run can retry it indefinitely.

### Phase 13B — operations visibility

Sequence the Admin work so each source is implemented once:

1. td-009031: actual outbound eBird fetch counts, distinct from cache hits;
2. td-a47c0d: point-in-time system, database, worker, queue and coverage health;
3. td-67b481: historical page-performance/regression view;
4. td-be8674: complete deterministic frequency-anomaly access; and
5. td-618181: enrichment errors, overrides and cost accounting not already
   covered by AI & Cost.

### Phase 13C — measured performance

Use td-3bf3a2 against the final Phase 8–12 journeys. Measure network
serialization, repeated work, `species_frequency` access and payload width on
production-sized data. Rank frequency × cost. Do not add indexes to small
in-memory tables or remove data for microsecond wins.

**Exit:** expensive work is owner-approved, runtime health is visible, and
performance changes have before/after evidence tied to real journeys.

## Reconciliation and explicit deferrals

- Reconcile td-1775b4 against already released ribbon work. Close only the
  requirements already proven; retain genuinely new refinements.
- Keep td-11aeb7 deferred until the latitude-centroid blur is troublesome
  enough to justify changing the model.
- Keep td-b52a90 outside this UX sequence until a real taxonomy split requires
  deeper preservation work.
- Keep td-d04fcf gated on licensed Status & Trends access.
- Keep td-bd06d6 gated on an explicit reversal of the no-media-storage product
  decision.
- Treat td-4e870b as maintenance after verifying currently available models;
  never update model names from ticket wording alone.

These deferrals are deliberate. They should remain visible without delaying
the location, scope, species and trip improvements above.

## Recommended execution order

1. Owner regression list and Gate 0 stabilization.
2. Gate 1 test trust and geographic boundary prerequisites.
3. Phase 8A Field Guide location choices.
4. Phase 8B map-based Hotspots & data discovery.
5. Phase 9A All/Need/Seen.
6. Phase 9B recent versus historical meaning.
7. Phase 10A–B Forecast/Home/trip continuity.
8. Phase 10C td-caea82 viewer account owner selection.
9. Phase 11 remembered species disclosures.
10. Phase 12A trip stop check-off, followed by separately justified route and
    weather slices.
11. Phase 13 cost, operations and measured-performance releases.
12. Reconcile/defer the remaining gated tickets.

The first implementation specification after regressions should be **Phase 8A
only**. It is large enough to deliver a meaningful new capability and small
enough to test deeply without simultaneously changing list meaning, Forecast or
trip planning.

## When the umbrella can close

Close td-8ff597 only when the released app provides:

- stable nested return paths for the principal journeys;
- consistent list presentation and thumbnails where the design calls for them;
- explicit All/Need/Seen access;
- county, hotspot and map/radius discovery;
- visible recent-versus-historical meaning and coverage;
- a place/scope handoff into Forecast and trip planning; and
- documented disposition of the owner's regression list.

Admin observability, enrichment expansion, advanced route/weather work and the
explicitly gated ideas do not have to close with the UX umbrella unless their
scope becomes necessary for one of those outcomes.
