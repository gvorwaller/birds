# Birds UX phase 4 — trustworthy load recovery and job states

September 19, 2026 · Parent td-8ff597 · F15
Status: released and production-verified as 05ba3af — td-c9e804.

Acceptance evidence: [phase 4 review record](phase-04-review.md).

## Outcome and boundary

A hotspot page must be able to recover missing metadata when a user requests a
historical load. A known place name alone must never turn a personal location
into a verified hotspot. Background work must say whether it is running,
queued, paused, waiting for retry, scheduled, cancelled, failed or complete.
A paused family-description job must not imply that every page is loading.

Scope: hotspot metadata resolver and requested-load action; /api/jobs safe
presentation; existing single poller; global chip; local Forecast/hotspot load
status; Forecast Data background-work hub. Preserve worker scheduling, storage,
auth, deduplication and frequency algorithms. No new migration, broad Admin
health dashboard, paid AI calls, prose enrichment, full history redesign,
navigation redesign, commit or deployment. td-39d567 and td-a47c0d are related
research/health work, not tickets this phase claims to complete in full.
Primary owns spec, td, independent review and real test acceptance. Lower-cost
implementer owns application code, focused tests, Help and About.

## Verified data flow and evidence

- hotspots/[locId] loader accepts a title from hotspotFromCache, frequencyMeta
  or hotspotPlace; its action accepts only the first two. This explains F15's
  known page/rejected load. hotspotPlace reads communal ebird_locations, which
  also contains personal L IDs: neither a name nor an L prefix verifies a hotspot.
- hotspotFromCache currently reads raw arrays under hotspots:/hotspotsRegion:.
  Frequency worker consumes supplied LocToEnsure {code,kind,name,regionCode};
  missing metadata recovery belongs before enqueueJob, not in fake payloads.
- Official ref/hotspot/info sample L64040525 returns name, latitude/longitude,
  country/state/county codes/names, isHotspot:true and matching locId/locID;
  locName/lat/lng are aliases. No descriptive prose appeared in this sample.
  The original F15 location L234146 also returned valid official metadata:
  The Celery Fields, 27.3253186/-82.4336821, county US-FL-115.
  L16494455 and L991735 returned empty HTTP200. Empty200 is not verified metadata.
  Initial 10-second probe timed out; later bounded probe succeeded. Failures must remain
  explicit. Evidence: task work/birds-ux/audit/phase04-metadata-baseline.json.
- ebirdFetchOrNull already distinguishes empty 200/404 from 401/403/429, and
  handles internal deadline. Reuse this behavior, not raw unguarded res.json().
- jobs DB statuses remain pending/running/succeeded/failed/cancelled. Retry uses
  progress.phase=waiting_retry plus next_retry_at. Recurring singleton parking
  uses isScheduledSingleton; preserve it as a separate display state.
- workerHealth exposes pauseRequested internally, but /api/jobs drops it.
  claimNextJob also gates enrich_families on family_enrichment_control.paused
  and blocked_until. Family pause is currently true in isolated test while the
  global worker is healthy. Do not resume it or incur paid work for this phase.
- /api/jobs returns all pending/running plus latest 15 terminal jobs. The client
  module provides one generation-protected poll loop and gated invalidation.
  Preserve those concurrency/navigation protections. The global chip uses the
  first active job and prepends Load to any category; displayName doubles a label
  equal to its type name. Forecast shows unrelated family work as queued.

## Metadata recovery contract

1. Keep GET read-only apart from existing normal caches. Monthly GET remains
   DB-only; don't add upstream verification merely to view a page. Share a
   cache-only normalized resolver between display and action.
2. Cache trust: existing official hotspot-list array match is verified evidence.
   Add a per-ID official-info namespace in ebird_cache and read it from the
   shared resolver. A frequency row or ebird_locations alone supplies display
   context but cannot establish hotspot identity. Preserve existing metadata
   such as Google place ID, venue types and frequency rows.
3. Requested load validates ID and authorization first; viewers cannot enqueue
   or trigger verification. Use locals.scopeId, never submitted user IDs. Require
   owner's API key and preserve existing force flag/dedup key/queue contract.
4. If verified usable metadata is cached, enqueue with its exact ID, real name
   and known county/state code. No external call required. Otherwise issue one
   bounded official-info request (internal deadline <=15s), cache/coalesce by
   ID, with no caller abort that cancels another consumer's shared request.
5. Validate before caching/enqueue: object, exact requested locId/locID (if both
   provided they agree), isHotspot===true, nonempty name, finite range-checked
   numeric coordinates. Normalize verified field aliases; never invent name,
   region or coordinates. Region can be null when not supplied. Use a dedicated
   parser with tests against the observed shape. Read cached objects through it
   too, so malformed/incorrect-ID cache rows cannot verify a location.
6. Persist only valid positive official metadata in ebird_cache (30-day TTL for
   official info is sufficient; existing verified list evidence stays usable).
   Prefer that namespace to rewriting ebird_locations. Cache misses/empty 200/
   404/invalid payload are unresolved and must not poison future verification.
   401/403/429/timeout/network errors stay errors, not personal-location verdicts.
   Shared cache fallback may use already validated positive metadata, preserving
   stale/error disclosure. No wrong-ID or name-only fallback.
7. UI provides a clear 'Verify hotspot and load history' action when metadata
   needs verification, including a well-formed unknown-ID page. A verified page
   retains Load/Refresh/Retry load. During verification say what is happening.
   On unresolved response: no job; explain that eBird did not supply verified
   hotspot details and offer eBird and Forecast recovery links. On provider
   failure: inline actionable error and 'Retry verification', not an endlessly
   runnable Retry load with hidden unmet prerequisites. No key: Settings link
   for owner; family viewer wording without credential access.
8. Successful recovery stores metadata before enqueue and refreshes the page
   through existing enhanced action flow. Its title, hotspot badge, map, region
   and subsequent reload use recovered metadata; recent reports remain available
   through failure. Existing frequency data remains untouched until the worker
   executes the explicitly requested job.

## One job presentation contract

Add a client-safe pure presentation helper and tests; use it from API/poller and
all touched surfaces instead of independently branching on status strings.
Keep raw DB status, IDs, payload projection, cancel semantics and scheduled flag
compatible. /api/jobs additionally supplies worker.pauseRequested and safe
per-job presentation: state, label, optional explanation/next action and next
eligible time. Never expose provider credentials, raw payloads or private pause
reason strings. Read category control once per jobs request, not per job.

State precedence and meaning:
- Terminal raw states stay Complete/Failed/Cancelled, unaffected by current pause.
- Running stays Running even if pause is requested; add 'pause requested; stops
  after current work' for applicable global/category pause. Cancel requested
  wins its running presentation: Cancelling, not already cancelled.
- Pending cancellation: Cancelling; don't pretend it can start.
- Pending explicitly blocked by global/category pause: Paused, naming the cause.
  A family-only pause never pauses or labels frequency jobs. Worker unavailability
  is a separate warning; do not call a healthy worker down merely for category pause.
- Pending family blocked_until in future: Waiting until [time] (temporary category
  backoff), not manually paused or running. If manually paused too, pause wins.
- Pending retry with future next_retry_at: Retry scheduled [time], retain attempts
  and error details. A due retry returns Queued; old phase text alone cannot say
  retrying soon forever. Future recurring singleton: Scheduled [time]. Other
  explicit future next_retry_at: Scheduled [time], not runnable queue.
- Otherwise pending: Queued, or Waiting for worker when heartbeat is unavailable.
  Running with a dead heartbeat must also disclose that worker availability is
  unconfirmed. Snapshot time is server-provided for consistent display/testing.

Do not modify claimNextJob, job DB status machine or pause/resume semantics just
to change a label. Existing admin actions remain the only pause/resume authority.
A missing/unreadable category control cannot be presented as confidently queued;
fail the snapshot or expose state unavailable, preserving client stale handling.

## Rendering and polling

- Keep outstanding pending/running jobs reachable in the hub and available to
  per-location dedup/disable checks, including paused ones. Do not redefine a
  paused pending job as terminal/recent or lose it from duplicate prevention.
- Global chip prioritizes real running work, then runnable queued work, then
  retry work. Paused/scheduled-only jobs don't create a permanent global loading
  banner. A quiet text/link to the hub may show waiting work; no loading spinner.
  Name each job once: displayName must not append an identical label. Preserve
  meaningful distinct label text and AI-only distinctions.
- Hub groups/discloses paused and scheduled work, shows cause/time and existing
  progress/events/cancel controls where authorized, and keeps terminal history
  discoverable. Label the existing latest 15 terminal window explicitly; no
  silent new cap. Provide an anchor for Background work and link chips/details
  to it. Admin users may get an Admin control link; viewers never get mutations.
- Hotspot progress is scoped by existing locCodes; Forecast/species remains
  scoped by target. Area Forecast must omit unrelated family/taxonomy/media
  jobs from its local loading banner. Show relevant frequency jobs using loaded/
  candidate location codes or matching region/target, with a general hub link
  for other work. Avoid substituting unrelated job counts for this page's data.
- On hotspot terminal completion, refresh its data once, without navigation
  interruption; preserve current tab/month/window/returnTo and use the existing
  invalidation latch/generation pattern. No new per-page polling loops.
- Poll running/runnable work at existing active cadence; paused/backoff/scheduled
  only work at a calm bounded cadence (15s), so resume/due transitions are observed
  without manual reload. Preserve auth-stop, stale-last-snapshot, bfcache wake,
  generation guard and no invalidateAll during navigation. No timer-only render
  falsely declaring a job actually started.
- Inline status text, semantic colors plus labels, 48px controls, 16px inputs,
  no toast, no overflow at 390px. Update Help and About.

## Acceptance and handoff

Focused tests must exercise real resolver/action/presentation/poller paths with
DB/provider boundaries mocked where appropriate. Cover valid cache without live
fetch; exact real-info normalization; missing cache recovery then enqueue; empty
200/404/non-hotspot/wrong-ID/malformed coordinates; auth/429/timeout failures with
no enqueue or negative poison; no-key/viewer/invalid-ID before work; dedup/force;
GET monthly no new provider calls; state precedence, category isolation, future
and due retries/singletons, label dedup, running without unit totals, terminal
history, paused outstanding identity, poll cadence/invalidation/navigation.
Keep existing job-policy/job-poll, hotspot and phase 3 regression behavior.
Do not run broad DB suites or synthetic fixture writers against real shared data.

Primary live acceptance in isolated test: preserve 227 owner species and family
pause; remove only selected real hotspot cache evidence reversibly to reproduce
missing metadata, use real official verification, enqueue one real load/refresh
and observe worker progress/terminal behavior. Validate failure/personal-ID path
creates no job. Show healthy-worker/paused-family truth in hub, absent misleading
chip/local Forecast banner; verify actual paused global state reversibly if no
unrelated job would be disrupted. Injected browser responses may cover rare
state combinations but must be labeled separately from actual worker proof.
Desktop and 390px Chromium/WebKit; no JS errors/overflow. No production writes,
paid enrichment or full DB copy needed. Run focused suites, check zero warnings,
production web/worker build, diff check. Announce build completion before primary
browser acceptance; don't edit/build concurrently with that browser run.

Handoff with changed paths, executed checks and unresolved concerns. Primary
reviews, returns defects, then marks this phase review. No phase 4 commit/deploy.
