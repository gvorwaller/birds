# Next steps: infrastructure and tightening (non-P4 open td issues)

*Drafted by CC1 on 2026-10-09, revised after CODEX1's review and Gaylon's answers the same day (see "Review changes" and "Owner decisions" at the end).*

## Context
Gaylon considers the user-facing work done for now. There are 19 open non-P4 issues. Most are infrastructure, observability or hardening; a few are user-facing features. main is level with origin/main (97c4e42), and nothing is in progress or in review.

The order is driven by one planning trigger. **eBird publishes its annual taxonomy update in October or November.** That date is a reason to get ready, not a date when something is guaranteed to break. Two open issues make the next sync risky:
- **td-861855:** on prod, taxonomy sync may run past the 30 s transaction cap and fail. Prod job 6985 has already shown droplet timing to be worse than M4 timing.
- **td-b52a90:** after a species split, a life-list import can silently drop seen species.

Sync taxonomy is a manual button (Settings → `sync_taxonomy`).

## Phase 1: Before the eBird taxonomy update (data safety)
1. **td-d425c1 jobs-db tests claim real jobs.** This comes first because every later item's integration gate runs on the shared `birds_test` queue. Scope `claimNextJob`/`reclaimStartupJobs` in `jobs-db.test.ts` to JOBTEST fixtures, and assert that rows outside the fixtures are untouched.
2. **td-861855 replaceTaxonomy vs the 30 s cap.**
   - `taxonomy-sync.ts` runs everything in one exclusive `withTagWriteTx`: delete and reinsert, two snapshots, then `materializeMany(tx, null)` over about 10.9k species while no tags are owned.
   - First, define a safe benchmark of the full path on prod-sized data that writes nothing to production (a droplet-side copy, or a rolled-back transaction against a restored dump).
   - Choose the fix from measured wall time. If there isn't comfortable margin, move the whole-universe rebuild out of the exclusive transaction and into the generation-keyed batched repair. A fast local run, or a single job-history row under 30 s, does not prove there is margin.
3. **td-b52a90, narrowed to split survival.**
   - **How the loss actually happens:** taxonomy replacement itself does not delete `seen_species`. `/life` LEFT JOINs `taxonomy_cache` and keeps retired codes visible (`src/routes/life/+page.server.ts` ~59-73). The loss comes from the next eBird/CSV life-list import. `importLifeList` (`src/lib/server/ebird-account.ts` ~573-627) deletes all `ebird_sync`/`csv_import` rows and reinserts only the names that matched. Any name that doesn't match the current taxonomy is dropped, for example when the life list is imported before the taxonomy is synced, or the other way round.
   - **Fix:**
     - Unmatched or retired synced rows are kept or explicitly reconciled, never silently deleted.
     - An orphan-code audit runs before and after taxonomy sync and is shown to admins.
     - Per-user, per-source and history semantics are preserved.
     - A split is never auto-mapped to one daughter taxon without authoritative, unambiguous evidence.
   - Subspecies, hybrid and spuh roll-up gets its own parked ticket.
4. **td-b99b6d job-queue stale-claim fencing.** `claim_seq` and the claim context already exist, but `job-handlers.ts` and `tag-jobs.ts` still call `recordEvent` without fencing.
   - Fence every durable side effect: external requests, DB writes, enqueues and notifications, and completion.
   - Where possible, put the claim token check in the same transaction as the DB side effect. A separate pre-check still leaves a race after it returns.
   - The single-worker lock reduces normal overlap, but it doesn't make a stale execution safe after a reclaim.

**Gate:** CODEX1 hostile review (high effort for items 2–4). Tests required:
- orphan detection
- failed-sync rollback
- **a life-list import after a split-containing sync**
- fencing under a simulated reclaim

Deploy before anyone presses Sync taxonomy for the 2026 release.

## Phase 1.5: Recovery readiness (new; ops, not code-first)
5. **td-cf46cf Backup and restore drill** (P2).
   - Inspect the actual backup schedule, the last successful verified `pg_dump`, and off-host retention.
   - Do a bounded restore drill into isolated storage.
   - `scripts/backup-pg.sh` checks dump structure, but none of the 19 tickets proves recovery works. The planned System Health backup card has to show a *verified* backup with a freshness threshold.
6. **td-626d50 Dependency and security inventory** (P3): lockfile audit, check the runtime is still supported, prioritized fixes. This is an inventory first, not an automatic upgrade bundle; scope it from the evidence.

## Phase 1.75: WebKit selects (moved up by Gaylon)
7. **td-47179c WebKit selects at 48 px.** A real, measured accessibility defect (23–26 px against the 48 px rule) that every user sees, so it goes ahead of the admin-only pages.
   - Check iOS Mobile Safari on the Simulator before claiming any mobile impact.
   - Use one shared treatment following the Field Guide `.location-fields select` pattern (`src/routes/species/+page.svelte` ~814) across all ~42 selects.
   - Measure heights in both engines. GROK does the UI pass.

## Phase 2: Admin observability (shipped as separate slices, with coherent navigation)
Each slice is reviewed and deployed on its own so it can be rolled back on its own. Admin navigation ties them together.
1. **td-a47c0d System Health page** (`/admin/system-health`, modelled on madonnahist). It's a point-in-time snapshot.
   - Reuse what `/api/admin/status` (`admin-status.ts`) actually provides: the worker, the last 50 jobs, and families.
   - Exact queue counts, DB sizes, `pg_statio` hit ratios (labelled as cumulative), coverage and backup state all need new queries; the 50-job list can't give queue totals.
   - Uses `displayName()` from `job-policy.ts`.
2. **td-67b481 Performance panel.** A separate time-series feature: a `page_timing` table recording only requests over 750 ms, pruned at 30 days, plus a 7-day per-path rollup. It's labelled in the UI as a censored, slow-requests-only sample. It cross-links with System Health.
3. **td-be8674 frequency anomalies table.** An admin-only view of `frequency_anomalies` (migration 0030). It has its own auth and empty-state tests.
4. **td-618181 enrichment observability**, core only:
   - show `wiki_error` and `ai_error` to admins
   - list, edit and delete `species_match_overrides` (a write action, so it needs its own security review)
   - Anthropic token cost accounting, plus detection of `max_tokens` truncation
   - Optional Wikidata/Wikipedia extras stay deferred.
5. **td-009031 eBird traffic metric.** Gaylon's purpose: watch eBird traffic so we can later find cheaper ways to fetch it.
   - `request-timing.ts` can't supply this: it covers page requests only, nothing from the worker.
   - Instrument the eBird network chokepoint (`src/lib/server/ebird.ts`) for both web and worker. Keep daily rollups by endpoint class × origin (web, or worker job type) × outcome (network OK, error/429, cache hit), plus time and bytes. Never log keys or raw query strings.
   - Shown on System Health: top endpoints, cache-hit rate, web vs worker split, trend.
   - No per-user attribution.

**Gate:** CODEX1 review for each slice, plus a GROK UI pass (admin only; 320/390/1200; Chromium and WebKit).

## Phase 3: Tightening
1. **td-b569b5 slow enrichment scope queries.** Run `EXPLAIN (ANALYZE, BUFFERS)` on prod, then index or rewrite if it's confirmed. Afterwards, revert the 60 s test-timeout stopgap.
2. **td-39d567 hotspot metadata audit.** Investigation only: sample `ref/hotspot/info` and report. Build nothing unless the evidence justifies it.
3. **td-8cecc6 bad iNat id (Ninox boobook).** Low priority: it costs about one wasted call a week. The durable fix is correcting P3151 on Wikidata. That is an outward-facing edit, so it needs Gaylon's authorization and an independent check of the ID (979816) first. Build a "bad cross-id" marker only if more cases appear.

## Parked
- User-facing (revisit when feature work resumes):
  - td-327dd6 (P2) no-county hotspots in the Field Guide. A real gap: 1,181 hotspots in the snapshot. It's first in line when user work resumes.
  - td-74b012 collapsible species cards; td-71494e route polylines and venue types; td-f9e34d type-widening; td-9308e2 Birds of the World link.
- Externally gated: td-d04fcf Status & Trends (Cornell data access and license). Do not start it.
- New parked ticket: subspecies, hybrid and spuh roll-up, split out of td-b52a90.
- P4s stay P4. No P4 outranks the Phase 1 data and queue risks. td-57d9fc (antimeridian centroid) is real, but current ribbon logic compensates for it and "nearest" uses the bbox, so it stays parked unless something starts reading `regions.lon` directly.

## Working method (each item)
- `td start`, then implement against `birds_test`. Never seed, unseed or reset while a peer holds a fixture.
- Before `td review`:
  - `npm run check`, `npm run build`, `git diff --check`, focused tests
  - real-DB and browser evidence in proportion to the change (the agent development guide)
- Measure on prod before optimizing (861855, b569b5); never decide from local timings alone.
- Three separate gates:
  - **td review:** CODEX1, plus GROK for UI.
  - **td approval:** Gaylon approves each issue himself.
  - **Release:** push or deploy only on Gaylon's explicit go, via `scripts/deploy-to-DO.sh`.

## Verification
- **td-d425c1:** the jobs-db suite passes with real due jobs in the queue, and rows outside the fixtures are unchanged.
- **td-861855:** a safe full-path benchmark on prod-sized data, before and after the fix, with recorded margin under 30 s. The test-cluster sync still passes, and a forced failure rolls back cleanly.
- **td-b52a90:** a fixture taxonomy containing a split, followed by a life-list import, loses no `seen_species` row. The orphan audit reports the retired codes.
- **td-b99b6d:** a simulated stale claim performs no durable side effect after a reclaim.
- **Backups:** a restore drill completes into isolated storage, and the time and outcome are recorded.
- **Phase 2:** admin-only auth tests, populated and empty-state tests, and a GROK pass for each slice.
- **td-47179c:** measured select heights of at least 48 px in Chromium, WebKit and the iOS Simulator.

## Review changes (CODEX1, 2026-10-09)
1. td-d425c1 moved to the front of Phase 1, because the later gates depend on the shared test queue.
2. td-b52a90's failure path corrected: the loss happens on the next life-list import (`importLifeList` delete and reinsert), not on taxonomy replacement. Verified in code by CC1.
3. td-b99b6d's acceptance sharpened: fence every durable side effect, with the claim token checked in the same transaction.
4. td-009031 parked until clarified. The `request-timing` bucket can't supply worker, endpoint or user counts.
5. Phase 2 split into independently deployed slices. The claim that `/api/admin/status` already supplies everything was corrected.
6. Added Phase 1.5: a backup and restore drill, and a dependency and security inventory (both need new tickets).
7. td-47179c flagged as a candidate to move ahead of the admin polish; td-8cecc6 kept low.
8. The Oct/Nov date reframed as a planning trigger; the td-57d9fc parking rationale recorded.
9. Working-method gates expanded (build, `git diff --check`, real-DB evidence; review, approval and release kept separate).

## Owner decisions (Gaylon, 2026-10-09)
- td-009031: the purpose is monitoring eBird traffic to find more efficient fetching. Kept in Phase 2 with the scope above (ticket description updated).
- td-47179c moved ahead of the admin observability pages (Phase 1.75).
- New tickets created: td-cf46cf (backup verification and restore drill, P2) and td-626d50 (dependency and runtime security inventory, P3).
- Implementation starts with Phase 1, beginning with td-d425c1.
