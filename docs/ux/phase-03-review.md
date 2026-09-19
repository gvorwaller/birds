# Birds UX phase 3 — review record

September 19, 2026 · td-766bfd · td-3d9544 / td-d71bad · parent td-8ff597
Status: released as 334ffff with streaming repair 505382b; authenticated production acceptance passed.

Specification: [recent-report evidence and personal sightings](phase-03-report-evidence.md).

## Responsibilities

The primary agent wrote the detailed contract and owns independent review and
real-data acceptance. The existing lower-cost built-in implementer owns code,
focused tests, Help and About. A handoff is not independent acceptance.
Phase 2B e730c56 is the release baseline; the migration 0049 comment is unrelated.

## Current live evidence

A fresh September 19 direct-provider/test-database probe confirms the owner
still has 227 species. Short-tailed Hawk has a real September 2 first-seen row,
recorded location coordinates and checklist S389149103. That checklist remains
absent from both current nearby species and notable feeds. Personal/public
separation is therefore still necessary; the upstream omission's cause is not
established, and first-seen records are not a complete checklist history.

The Nashville Warbler feed changed since the earlier UX audit: nearby species
now returns the close September 18 record. Notable returns two reports with
identical place/time but distinct checklists S394033260 and S394033262. Both
must survive deduplication. Only identical copies of the same report should
collapse. This supersedes any inference that equal place/time alone proves
a duplicate. Deterministic regression tests must still prove that a closer
notable-only report survives when the species/nearest feed omits it.

Evidence: local task work/birds-ux/audit/phase03-baseline.json and its guarded
read-only script. No credentials were included; no observation rows inserted.

## Independent review during implementation

Primary review identified and returned corrections for caller search budgets,
lazy shared notable fetching, fatal versus ordinary provider failures, cancelled
requests, per-row timestamps, duplicate status/source union, selected-species and
return-link preservation, streamed result query scope, viewer wording, and
active-area personal filtering. This is active review, not acceptance by handoff.

The primary's separate actual-loader tests pass 20/20: invalid controls
before provider work, seen/text-search/no-key paths, shared six-target notable
fetch, closer notable evidence, rolling-window local-date retention, fatal and
ordinary failures, pre-aborted calls, account scope, searched-place radius and
failed-geocode handling. These use deterministic mocked provider/DB boundaries;
they do not establish live eBird behavior or browser correctness.

Primary added two ladder regressions that initially failed: repeated copies in
the direct feed consumed the five-row limit, and conflicting regional copies
lost an explicit unconfirmed status. Both were corrected before acceptance.
Per-row timestamps retain the actual originating cache read. Additional primary
checks cover count/source conflicts, filtering before closest-five selection,
invalid personal dates, and deterministic date-based tests. The focused rerun
passes **125 tests in 15 files**, including previous hotspot-comparison and
Needs-enrichment regressions.

A read-only implementer review of the primary corrections found a settled-wave
edge: a fatal regional error could discard later results from requests that had
already completed. A new regression reproduced it; processing the full settled
wave before stopping future requests fixes it. Cached fatal refreshes also stop
new waves while retaining their evidence. These checks are deterministic mocks.

## Completed validation

- **125 tests / 15 files passed**: identity/status/source/count conflicts,
  actual Home and Nearest loader contracts, regional cancellation/coverage,
  personal dates/coordinates, Needs enrichment and hotspot-comparison regression.
- `npm run check`: **zero errors and zero warnings**. Production web and worker
  build passed after final changes; `git diff --check` passed.
- Chromium at desktop and 390px: actual Hawk first-seen/checklist on Home and
  species; 1-day versus 30-day personal dates; searched Huguenot radius excludes
  the out-of-area personal sighting; personal evidence remains without API key.
- Nearest: both real Nashville Warbler checklists appear once, review status and
  source union are visible, mi/km preserves the canonical 25km bound, and changing
  window retains the selected species. Typed search → species selection → window
  change also passes. Species Nearest retains origin, radius, place and returnTo.
  Invalid supplied controls return 400.
- Real `family` viewer sees the owner's personal record with family wording on
  Home/species. Separate `marcus` account does not inherit it. These are accounts
  present in the isolated test copy; production-only Kim/Paul were not simulated.
- WebKit at 390px: Home/species/Nearest, both distinct Nashville checklists, unit
  controls, source/status disclosure and both Nearest forms passed. A real
  WebKit native-select issue was corrected: every checked input/select/button
  is now 48px high with 16px text, and the search input is 324px wide.
- No horizontal overflow or page errors in the accepted browser runs. Screenshots
  inspected visually. This is browser emulation, not a physical iPhone test.
- Test owner remains **227 species**. DB, worker and gallery health are all `ok`.
  The test API key was temporarily removed for the no-key check and restored in
  `finally`; final presence verified. No observation/trip rows were fabricated
  or changed and no production writes occurred. Temporary browser sessions were
  removed. The unrelated migration 0049 comment remains untouched.

## Test harness and evidence limitations

Streamed pages can expose server-rendered controls before hydration. Acceptance
waits for an interactive unit toggle before editing the species form or leaving
streamed pages. Initial exploratory runs that overlapped source edits captured a
development overlay; those captures were rejected. A pre-hydration navigation
attempt was interrupted, then the hydrated control/navigation flow passed.
The final screenshots and result files come from accepted runs.

Live provider data can change. The current Nashville feed now supplies a nearby
report, so deterministic service/loader regressions establish the missing-feed
case: a closer notable-only report survives alongside a farther engine result.
The live two-checklist pair establishes that equal place/time is not duplicate
identity. The public omission of the Hawk checklist remains unexplained; the
UI exposes the stored first-seen record without inventing public-feed evidence.
These records remain first-seen history only, not every checklist observation.

Local evidence: task `work/birds-ux/audit/phase03-baseline.json`,
`phase03-browser-results.json`, `phase03-accounts.log`, `phase03-webkit-results.json`,
three feature screenshots and the WebKit control screenshot. Repo check logs:
`.local/phase03-primary-focused-tests.log`, `phase03-primary-check.log`, and
`phase03-primary-build.log`.

## Production release — September 19, 2026

Owner authorized deployment and the next phase. Phase 3 was committed as
**334ffff**, then production smoke exposed an existing streaming failure:
nginx withheld the tail of Home's startup script while deferred eBird work
exceeded its 60-second idle timeout. A direct origin/proxy comparison proved
that the app emitted the complete startup script at 265 ms, while nginx never
emitted its end and closed at 60,022 ms. This was not a browser-control issue.

Follow-up **505382b** disables proxy buffering and bounds the complete place-
detail enrichment window at 50 seconds. All base species and arrived detail
responses survive; missing details are explicitly labeled. Late shared requests
can finish populating cache without holding the current response open. The
blocking DB-place hydration uses the remaining window as well. Tests cover
stalled provider/DB work, retained rows and safe late failures. 31 focused
regressions, check with zero errors/warnings, web/worker build and a second source review
passed in an isolated release checkout, excluding in-progress phase 4 changes.

Both releases used the standard deploy script. Live revision is **505382b**;
DB, worker and gallery health are all `ok`. Authenticated production acceptance:

- Home interactive 599 ms after shell; complete response 9,919 ms in this warm run.
- Home and species show the actual personal Hawk first-seen checklist.
- Nearest returns two distinct Nashville checklists with source/review labels,
  preserves date/distance/return context, and rejects invalid windows with 400.
- 390px controls meet 48px height and have no horizontal overflow.
- No JavaScript page errors. Owner life-list snapshot 227; no trip/life-list writes.

The warm timings prove successful delivery, not a universal upstream latency
promise; deterministic stalled-provider tests establish the 50-second bounded behavior.
Evidence: task `work/birds-ux/audit/phase03-production-results.json`, production
phone capture, origin probe log, and `work/birds-ux/release-stream-*` validation
and deployment logs. The unrelated migration 0049 comment remains untouched.

## Disposition

Phase 3 td-766bfd and linked td-3d9544 / td-d71bad are released. The streaming
repair is tracked as td-602a41. Phase 4 **td-c9e804** is implemented and accepted for review from its
[detailed specification](phase-04-load-recovery.md). The parent UX epic remains
in progress; phase 4 has not been committed or deployed.
