# Birds UX phase 4 — review and acceptance

September 19, 2026 · td-c9e804 · Parent td-8ff597
Status: independently accepted and submitted for review; not committed or deployed.

## Delivered behavior

Hotspot pages can recover missing official metadata when historical data is
requested. A personal location name cannot establish hotspot identity. The
resolver checks the exact ID, official hotspot flag, name and coordinates,
caches only verified positive results and preserves explicit provider errors.
The page retains the current month, report window and return destination after
verification or loading. Monthly viewing does not itself call eBird.

Background work now distinguishes running, queued, paused, scheduled, retry,
worker unavailable, cancellation and terminal states. Paused family descriptions
do not imply that an unrelated Forecast is loading. All outstanding jobs remain
available for duplicate prevention; the shared poller uses a calm cadence while
work waits and refreshes relevant hotspot data when a real job completes.
The background-work hub discloses its latest 15 terminal jobs and retains error,
activity and authorized cancellation controls. Help and About explain the changes.

Full contract: [phase 4 specification](phase-04-load-recovery.md).

## Independent review and corrections

The primary wrote the specification; the existing lower-cost implementer wrote
code and focused tests. The first handoff was returned for incomplete polling
and invalidation, state precedence, category isolation, cache freshness, action
context and verification coverage. Later review corrected unrelated frequency
jobs being omitted from the general background-work link, category-control
failure handling and running-state explanations. Browser review also identified
repeated explanations, missing retry attempt counts and a submission receipt
that continued saying queued after completion. These were corrected and rechecked before review.

The worker scheduler, queue state machine, frequency algorithms and database
schema are unchanged. No paid family enrichment was resumed. The unrelated
migration 0049 comment is preserved.

## Real test-app evidence

The isolated test copy uses working eBird credentials and a running worker.
These checks used genuine locations and upstream responses, with no fabricated
observations or forced successful job states:

- **Missing metadata recovered:** only cached official evidence for L234146 was
  temporarily removed. The Celery Fields remained recognizable from place data
  and offered **Verify hotspot and load history**. The actual official endpoint
  restored its name, coordinates and Sarasota county code US-FL-115, then
  queued real job **5425**. The temporary cache changes were restored afterward.
- **Paused means paused:** with the otherwise idle global worker temporarily
  paused, job 5425 appeared as Paused in both the API and hotspot page. Resuming
  the worker changed it to Running. The original global pause flag was restored.
- **Actual retry, not a claimed success:** Celery's historical download timed out
  at eBird on two attempts. Job 5425 entered its normal retry schedule. The UI
  showed Retry scheduled with its real eligible time and error in the hub.
  Official metadata recovery succeeded; Celery history has not successfully
  loaded. Its original six-minute completion test therefore failed and is not
  counted as a successful completion check.
- **Successful worker completion and automatic refresh:** a separate requested
  refresh of Lakewood Ranch--Lake Uihlein (L4940474), real job **5427**, passed
  Pending → Running → Succeeded. The database fetch timestamp advanced to
  September 19 at 20:13:00 UTC with **103 species**. The already-open browser
  issued another hotspot data request after completion without a manual reload;
  month 9, monthly tab, 30-day window and Forecast return link were retained.
- **Preserved state:** the owner's life list remains **227 species**; family
  enrichment remains paused. No production trip or life-list data was modified.

Primary evidence lives in the task's `work/birds-ux/audit/`:
`phase04-live.log`, cache backup, paused/before screenshots,
`phase04-completion-results.json`, retry/completion screenshots and final state
snapshot. The completion file separates Celery's retry evidence from Lake
Uihlein's successful refresh.

## Browser state coverage and automated checks

Chromium and WebKit at 390px exercised seven explicitly injected API display
states: running without totals, cancelling, waiting for worker, retry scheduled,
paused, scheduled and category backoff. These establish labels, chip behavior,
background-work links, overflow and absence of JavaScript errors. They are
**display tests, not additional real worker runs**. No fake jobs were inserted.
The initial WebKit interception attempt was rejected because its service worker
bypassed the harness response; the accepted run blocks service workers in the
browser test context only.

Primary ran **131 focused tests in 13 files**, all passing, covering resolver,
action, API, policy, polling and retained Home/Forecast/hotspot behavior.
Framework checks reported **zero errors and zero warnings**; production web and
worker builds passed. After final display polish, framework checks again reported zero errors/warnings;
web and worker builds passed, and the affected WebKit phone layouts were rechecked.

Final WebKit checks found 49px refresh controls, no horizontal overflow or page
errors, one copy of each explanation and restored retry attempt counts. A real
Jacksonville Forecast showed only the general background-work link for unrelated
Celery and family jobs. Test DB, worker and gallery health all returned `ok`.

Viewer and native-form acceptance passed in **both Chromium and WebKit**.
The family viewer could read monthly data, had no load/verify/cancel controls,
and its load request returned 403 without creating a job. With JavaScript disabled,
the owner submitted the personal ID L16494455 through the actual form: it returned
422, showed the exact unresolved-details alert, retained all query context and
created no job. The preliminary API-only form probe was not accepted as native
form proof; the corrected browser runs replaced those provisional result files.
Evidence: `phase04-permissions-native-{chromium,webkit}.json`,
`phase04-final-browser-webkit.json` and `phase04-forecast-scope.json`.

## Validation bookkeeping

One implementer command initially included the existing DB-backed
`hotspot-page.test.ts` gateway suite. Its temporary fixture seed/cleanup cases
ran; later suites use mocked DB/provider boundaries or focused pure-test filters.
The primary audited the actual test copy afterward: both temporary cache keys,
location L999999901, taxonomy hptst1/hptst2 and their frequency rows are absent.
The owner retains 227 species. Evidence: `phase04-fixture-audit.json`.
This cleanup audit establishes current state; it does not turn the earlier run
into a mocked-only check.

## Disposition and next phase

Production remains the verified phase 3 release plus streaming repair **505382b**.
Phase 4 **td-c9e804** is accepted for review, uncommitted and undeployed. Related hotspot prose ticket td-39d567 and
broader Admin health ticket td-a47c0d remain outside this phase's completion claim.
The parent UX epic remains in progress. Next is **phase 5: shared navigation
context and place-preserving links**, after owner review and a separate release
instruction.
