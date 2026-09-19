# Birds UX phase 5A — independent review

September 19, 2026 · td-ea384e · Parent td-8ff597
Status: independently accepted; submitted for owner review. Not committed or deployed.
Production remains phase 4, `05ba3af`.

[Detailed specification](phase-05a-navigation-context.md).

## Delivered behavior

Trip, hotspot and species pages now retain a named journey. The prominent return
link goes to the immediate source; **Your path** exposes earlier stops. Ordinary
links carry a safe, nonrecursive fallback for new tabs and JavaScript-disabled
browsers. Content queries, report windows, selected months and fragments remain
part of the destination.

Returning to an expanded hotspot list reveals and focuses the original bird;
returning to a trip reveals its original stop. Nearby-report place names open
the hotspot inside Birds, while their separate eBird badge still opens eBird.
Report-row restoration waits for streamed results, uses distinct IDs across
nearby and nearest sections, and yields to user interaction. Browser Back and
Forward retain native scroll behavior.

Navigation history is tab-scoped and keyed by the actual signed-in account,
including viewers. Reload recovery applies only to an actual document reload;
ordinary arrivals do not revive an unrelated earlier trip. Account changes and
sign-out clear old path state. Missing or blocked history leaves the immediate
link usable and explains when older context is unavailable.

A hotspot with real coordinates sends its actual name, coordinates and month
to Forecast. A hotspot without coordinates opens a blank location chooser;
neither saved Home nor a remembered search can take over. An explicit typed
place or valid pin then uses the existing Forecast workflow. Help and About
explain the changed behavior.

## Independent verification

The lower-cost implementer delivered the code in correction passes. Primary
review added independent policy, adapter and fallback regressions, corrected
remaining integration issues, and exercised the real test application.

| Check | Verified result |
| --- | --- |
| Trip 9 → Myakka → September → expanded list → Common Grackle → returns | Chromium and WebKit at 390px: all 110 birds available, selected bird row focused, then original trip stop focused; no page errors or horizontal overflow. Chromium desktop at 1280px also passed. |
| Refresh, Back/Forward and ordinary ancestor links | Chromium and WebKit retain the named trip/hotspot/bird path; an ancestor opened in a fresh tab retains its immediate named source. |
| Filters and account isolation | October and the 30-day report window survive Recent/Monthly changes and hotspot refresh. Reloading the same browser context as the family viewer clears the owner's navigation namespace. |
| Report → hotspot → another bird → returns | Chromium followed the real Common Grackle report at Myakka, opened another species from its monthly list, and returned through the hotspot to the focused original report. Coordinates and 30-day context survived; no duplicate DOM IDs or page errors. |
| Forecast selection | WebKit and Chromium opened the existing Airdrie—East Airdrie Slough (L10002627) without coordinates, then successfully selected Lakewood Ranch for September. Verified Myakka metadata produces the correctly named coordinate-based Forecast link. |
| Degraded browser modes | Chromium and WebKit: remembered search cannot override the chooser; empty submission does not select Home; JavaScript-disabled and blocked-sessionStorage links retain the named immediate source and content query. |
| Code checks | 83 focused tests across 9 files; framework check: zero errors and zero warnings; production web and worker builds passed; diff whitespace check clean. |

Focused tests use mocked database/provider boundaries, including the actual
Forecast loader. Browser evidence uses real accounts, places, reports and
stored frequencies. No broad fixture-writing suite was run against the restored
production copy. Automation waits for hydration before exercising client-only
controls; it does not replace route data or fabricate observations.

## Review corrections that mattered

- Deferred history registration until the installed SvelteKit router is ready.
- Added a validated reload bridge because SvelteKit clears page state during
  full-document hydration; retained ordinary direct-arrival isolation.
- Fixed account cleanup deleting its own reload bridge, and made the independent
  Storage mock enumerate real keys so that regression cannot hide again.
- Limited repeated-resource reuse to the current journey rather than any prior
  visit to the same hotspot; native tab changes attach the current reference.
- Preserved ancestor fallbacks, query state and named source labels through
  tab changes, forms and new tabs. Oversized safe links degrade to usable native
  navigation without truncating content.
- Wired actual origin IDs, expanded-list restoration, streamed-report readiness
  and user-intent guards; avoided copying a destination's origin onto its child.
- Cleared path state on a fresh logged-out document as well as in-app sign-out.

## Data and release boundary

Myakka's 5,657 species/week rows retain their original SHA-256 fingerprint and
244-species dataset. The owner still has 227 seen species; family enrichment
remains paused. Temporary authentication sessions were removed after browser
runs. Normal provider-cache updates were allowed; no production list, trip,
load or preference mutations were made.

Evidence and executable browser checks are in the task's
`work/birds-ux/audit/phase05-*` files. Repository check logs are
`.local/phase05-final-{tests,check,build}.log`. The unrelated migration 0049
comment edit remains preserved and is outside this phase.

**Next:** owner review and a separate commit/deploy instruction for 5A, then
phase **5B** adopts the shared journey across Field Guide/Taxonomy/Viewed/Special
interest, Photos/Life list, species-Forecast/county and Home/Nearest/Alerts entry
points. Phase 6 handles drawer/map focus and control sizing; phase 7 handles
compact Field Guide controls and species section navigation. The parent epic
remains in progress.
