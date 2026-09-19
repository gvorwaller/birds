# Birds UX phase 2B — independent review record

September 19, 2026 · td-f730cf under td-8ff597
Status: implementation accepted by primary review; ready for owner release instruction. Not committed or deployed.

Specification: [comparable hotspot rankings](phase-02b-comparable-rankings.md).

## Delivered behavior

Home and the trip planner now offer an explicit **Compare hotspots** action.
The initial area preview remains available. Comparison checks every verified
hotspot in the selected area using each location's own recent or notable feed,
with consistent window and All/Needs filters. Progress distinguishes fresh,
stale, failed and unqueried locations. Reported zero does not mean absence.
Pause, Continue and Retry keep the operation under user control.

Comparison does not change the route. **Use compared ranking** becomes available
only when all reference locations have fresh results. It replaces automatic
choices while retaining manually selected other locations and their original
count evidence. Saved version 2 context records the per-hotspot source, time,
filter and unconfirmed-report policy. Version 1 and legacy trips still work.
Help and About explain the new controls and evidence limits.

## Responsibilities and review corrections

The lower-cost built-in implementer wrote application code and focused tests.
The primary agent wrote the detailed specification, reviewed the actual source,
returned defects for correction, and independently ran the checks below.
Primary also added queued-cancellation/auth/rate-limit tests, corrected the
zero-remaining-slots case with a regression test, and made small clarity and
control-sizing edits. The implementer then performed a read-only review of
those primary corrections and found no blockers; the reviewer roles remain
explicit rather than claiming a separate full review of every edit.

Review caught and corrected first-Apply retaining old automatic selections,
lost manual-location tokens, duplicate recovered location identities, and
repeated-Apply selection drift. It also corrected raw-versus-executed radius
identity, query restart after HTTP409, stale-reference retry, initialization
pause, and navigation cancellation before component teardown. Rate-limit and
auth failures now stop queued scheduling, including stale-cache fallback.
Scientific names, source-specific export wording and reachable species detail
were retained. Missing data and malformed payloads remain distinct from zero.

## Real provider and database acceptance

The isolated test app at 127.0.0.1:5178 used real eBird credentials, the existing
production-copy database, and live caches. No synthetic observations were
inserted. The Huguenot search returned 246 verified hotspot references; all 246
were included in each completed comparison. September 19 snapshot:

| Scope | Fresh / total | Reported zero | Huguenot count | Measured comparison time |
| --- | --- | --- | --- | --- |
| All species | 246 / 246 | 124 | 73 species | 401.4 seconds |
| My needs | 246 / 246 | 188 | 9 needs | 0.355 seconds |
| Rare reports | 246 / 246 | 231 | 3 species | 479.2 seconds |

These are observations, not permanent expected totals. An initial partial run
encountered a transient provider failure at Bogey Creek Preserve. Direct retry
succeeded. That attempt warmed some caches before the successful All run, so
401.4 seconds is a partly cold measurement, not a pristine cold benchmark.
The successful Needs run reused exactly the same observation cache timestamps
as All; its species were independently checked against the owner's actual seen
set. Rare used the separate location notable feed. The original baseline had
no fresh 30-day location feeds; the restarted All run began with 45 cache rows.

Authenticated API acceptance also checked invalid/duplicate/oversized/unknown
batch IDs, comparison-identity mismatch, and an actual family viewer read with
account-bound tokens. No client-supplied scope changed server authorization.

## Automated and adverse-state verification

Primary verification: **91 focused tests across 16 files passed**;
`npm run check` reported **zero errors and zero warnings**;
`npm run build` passed, including the worker build.

Focused coverage includes actual service/handler execution, maximum-four shared
concurrency, cancellation while queued, auth/rate-limit failures stopping queued
work, malformed reports, cache reuse, account/scope token validation, v1/v2
compatibility, planner save, export/share formatting and explicit Apply selection.

Browser failure injection used four genuine hotspot responses as fixtures, with
controlled delay/failure responses. It passed pause during initialization,
HTTP409 restart, partial and stale-reference states, missing-key guidance, and
navigation cancellation. These are simulated adverse states, not claims that
upstream failed in each of those ways during this run.

WebKit at 390px completed all 246 My-needs hotspots, opened the complete species
disclosure, changed distance units without changing route selection, and had
no horizontal overflow or browser script errors. This is browser-engine testing,
not testing on a physical iPhone.

## Browser save and reload acceptance

Chromium exercised actual comparison, mid-run Pause/Continue, all 246 visible
rows, and unchanged route/name until explicit Apply. Applying twice did not
accumulate selections. Test trip 25 was saved through the UI with two v2
hotspot contexts and one retained v1 manual-location context. Its actual JSONB
matched each displayed count and location. Reload and HTML export passed,
including the separate Now nearby counts. Legacy trip 22 retained v1 wording.

The first browser save run wrote trip 24 but timed out navigating while a
production build ran against the same development checkout. An isolated repeat
passed save, navigation, reload and export. No application change was needed
between those runs; overlapping build activity was removed from acceptance.

Home's desktop and 390px browser check also completed all 246 My-needs
hotspots with no horizontal overflow or script errors. The test waits for
hydrated controls rather than `DOMContentLoaded`, since the existing Home
HTML stream remains open while per-species enrichment runs. Live diagnosis
confirmed comparison is interactive and finishes while that stream is open.
The owner's seen list remains **227**, unchanged from before acceptance.
Phone evidence includes clean element captures with fixed navigation hidden
only during capture, so it does not obscure the content being reviewed.

## Evidence and release boundary

Reproducible acceptance scripts and raw results live in the local task's
`work/birds-ux/audit/phase02b-*` files; primary test/check/build logs are in the
repository's `.local/phase02b-primary-*.log`. Credentials and signing tokens
are omitted from evidence files. User-facing HTML copies link from the roadmap.

No schema migration, commit, push or production deployment in this phase.
Production remains phase 2A `0ddf28a`. The unrelated migration 0049 comment was
preserved. The previously accepted 12 broad-suite failures were not rerun;
those are separate from the 91 passing focused checks. Large uncached areas
can take minutes; explicit progress, pausing and cache reuse are essential.

After owner release instruction, deploy this reviewed phase with normal health
and changed-surface checks. Next is phase 3: consistent recent-report source,
time window, review status, deduplication, personal sightings and Nearest.
