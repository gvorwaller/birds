# td-7162f6 — One maintained "species presence" layer for the whole app

**Revision 2** (2026-10-11): CODEX1 deep hostile review folded in (verdict: needs changes, no P0, 6 P1 + 4 P2;
dispositions at the end). Status: **plan only — no code until the owner has seen the review summary.**

## Saved place
- Prod = 0a7d4d1 (td-de2150: a worker recounts all 13.9 M `species_month_freq` rows, ~38 s, after any load).
- td-7162f6 open/started (P1). The draft new-tables migration was deleted (it duplicated an existing mechanism).
- td-47179c WIP in `git stash` "td-47179c shared select style (WIP)". td-fb6948 filed.

## Context
Gaylon: the amount of data read can impact UX and overall performance depending on how it's updated and
referenced; the Hotspots & data species totals should never need the 13.9 M-row frequency table. td-de2150 moved
that read off the request path but still re-reads everything after any load. A whole-app review (code traces,
prod logs, prod queries, CODEX1 review) found:

1. **The incremental primitive already exists (0053–0055, live since 2026-09):** `species_location_membership`
   (loc → species array; 14,097 rows / 2.33 M pairs) and `species_country_membership` (country, species,
   source_count; 109 k rows), maintained by **database triggers** on `species_frequency` / `frequency_fetch` —
   every write path (old workers mid-deploy, cascades, region remaps, truncates). Only `/viewed` uses it. All
   country counts from it on prod: ~120 ms; world distinct ~240 ms.
2. **Definition drift (measured on prod):** membership = "any weekly row"; page totals, Field Guide place filter
   and forecasts = `species_month_freq.num > 0`. 55/252 countries differ by a few species; world 10,901 vs 10,900.
   Cause (verified on TG): species whose only weekly values are freq 0.0015 in weeks with **sample size 0**.
3. **Readers of the big tables:** whole-table — the 0082 count worker (38 s) and enrichment scope
   `IN_SCOPE_CODES_SQL` (~24 M weekly rows, up to 6× per scan; td-b569b5). Per request, uncached, O(place) —
   Field Guide `searchGuide` (DISTINCT over every location under a country/state; run twice with tags via
   `guideUnknownCount`). Forecast/hotspot/species-page readers are O(location/species) via PKs.
4. **Self-inflicted reloads (prod log):** `src/lib/job-poll.svelte.ts` + `job-poll-core.ts:117` re-run the full
   /forecast/* load (`/forecast/data`: 12 queries, 269 KB, ~1 s) on any terminal job and every 15 s while any job
   progresses. Most of the 61 slow `/forecast/data` loads since the deploy are this.
5. **Out of scope here (separate tickets):** `/api/hub-country` p50 6.4 s, `/api/hotspot-counts` p50 3.5 s,
   `hubInventoryData` whole-table reads per load, home `/` ~97 queries, td-fb6948. **This release does not fix
   all Hotspots & data latency** — only the species-count path and the reload storm.

**Outcome:** species presence is maintained once, at write time, at location / first-level-region / country
grain, under one named definition; consumers move to it in stated phases. The release claim names exactly the
consumers migrated in that release — not "every consumer" until D4/D5 ship.

## Design

### D1. One named definition: *effective presence*
A species is effectively present at a location iff some week has `freq > 0` AND that week's
`frequency_fetch.sample_sizes[week] > 0` — equal to `species_month_freq.num > 0` **given two premises**
(CODEX1 P2-3), which this release enforces/audits:
- `sample_sizes` entries are ≥ 0: add a DB CHECK (`0 <= ALL(sample_sizes)`) after an audit (read-only audit on
  birds_test found 0 negatives; re-run on prod before the migration).
- Month rollups are in sync with weekly rows: pre-migration parity audit (weekly-effective set vs
  `num > 0` set, per location) on prod; any mismatch blocks the migration until explained.

**Every consumer whose semantics change (listed, tested):**
- Hotspots & data totals (D3) — unchanged numbers (already used num > 0).
- `/viewed` study list (`species-study.ts`, via membership) — loses zero-checklist-only species. Intended.
- Enrichment scope, all three readers (D5, CODEX1 P1-4) — one shared predicate.
- `/forecast/species` species picker eligibility (`forecast/species/+page.server.ts:183-203`, CODEX1 P1-5) —
  `EXISTS species_frequency` → effective presence at that location (membership array or `num > 0`); weighted
  ranking unchanged. Ships with D2 (small, keeps picker consistent with the new totals).
- Readers that legitimately need weekly curves (`speciesLocForecast`, `hotspotMonthly`, ribbon drill) keep
  `species_frequency` — they compute values, not presence.

### D2. Extend the existing trigger layer (migration 0083)
Modelled on 0053–0055; the database stays the single writer of presence.
- **Location refresh** — `CREATE OR REPLACE refresh_study_location_membership(loc)`: species from
  `species_frequency` joined to that location's `sample_sizes[week] > 0` (D1). Serialized by
  `FOR NO KEY UPDATE` on `frequency_fetch` (0054).
- **Ordering inside `storeFrequencies`** (`barchart.ts:521-571`): metadata upsert (incl. `sample_sizes`) →
  delete weekly rows → insert in 500-row statements. Today each statement refreshes the location. Adding an
  `UPDATE OF sample_sizes` refresh (needed for a sample-only change) would add another. **Decision:** keep
  statement triggers as the correctness backstop, but make membership refresh *deferred to one per location per
  transaction*: statement triggers only record the touched loc in a transaction-local queue table
  (`species_presence_pending(loc_code)`, ON CONFLICT DO NOTHING); a `DEFERRABLE INITIALLY DEFERRED` constraint
  trigger on that queue refreshes each queued location once at commit, then clears it. Result: one membership
  refresh and **one version bump per location per transaction** (CODEX1 P2-2), for every writer path.
  (Fallback if the review/benchmark rejects deferred triggers: keep per-statement refresh and bump the version
  only when the final species set changes — measured cost reported.)
- **Grain** — add `region_code` (first-level `CC-SUB1`; NULL for country-level/unassigned) to
  `species_location_membership` via IMMUTABLE `study_region_code(kind, loc, region)` mirroring
  `study_country_code`. New `species_region_membership(region_code, species_code, source_count)`, maintained by
  the same delta trigger after country deltas; advisory locks taken in one global sorted order over
  `study-country:*` then `study-region:*` keys. Counties and hotspots need no table: their species come from
  the location arrays (≤ a few thousand rows).
- **Unassigned locations** (CODEX1 P1-3): locations with NULL country stay in the location ledger; world totals
  include them (D3). Today 0 such rows on birds_test and prod.
- **Version** — `species_presence_state(id=1, version bigint, updated_at)`: bumped by the deferred refresh (once
  per changed location per transaction), by `writeTaxonomy` (category drives counts), and by TRUNCATE guards.
  Rolled-back transactions leave it unchanged (it is transactional).
- **TRUNCATE** (CODEX1 P1-2): extend the 0053/0055 guards so truncating `species_frequency`,
  `species_location_membership` or `frequency_fetch … CASCADE` also clears `species_region_membership` and
  bumps the version once; preserve 0055's no-double-truncate behaviour.
- **Retire 0082:** delete pending `refresh_species_counts` rows (type stays in `jobs_type_check` for history);
  keep `species_count_snapshot` one release as the verification reference, drop it later.
- **Rollback file** `backend/db/rollback/0083_*.sql` (reviewed, not auto-applied): drop the region table,
  queue, state, new triggers/column; restore 0054's refresh function.

### D2-ops. Migration runbook (CODEX1 P1-6)
The whole file runs in one transaction (`migrate_pg.sh:170-177`) holding `SHARE ROW EXCLUSIVE` on both source
tables until commit (blocks loads, not reads). **CC1 self-review (implementation):** `ALTER TABLE … ADD
CONSTRAINT` and `DROP TRIGGER` on `frequency_fetch` take ACCESS EXCLUSIVE, which blocks *reads* (nearly every
page) and is held to commit — so 0083 runs them LAST, after the backfill and ANALYZE (read-blocking window =
milliseconds). The `ADD COLUMN` on `species_location_membership` holds ACCESS EXCLUSIVE on the ledger for the
whole migration; only `/viewed` reads it.

**Measured (2026-10-11, prod backup 05:07Z restored to a scratch `birds_bench_0083` on the M4):**
- Full 0083 transaction: ~14.7 s (ledger rebuild 9.3 s, region table 4.1 s, ANALYZE ~1 s). Droplet estimate at
  the observed 5–7× ratio: ~75–105 s of blocked loads (worker paused).
- Store of a 74,461-row location (BR copy, 500-row statements): old triggers 1.8 s first / 2.4–3.7 s reloads;
  new deferred triggers 1.15–1.30 s reloads; exactly one version bump when the set changed, none when identical.
- Equivalence on the clone: 0 differences (3,362 country/region keys, 8 areas, world 10,900 = prod snapshot);
  presence totals 294 ms vs 5,248 ms for the whole-table aggregate. Same on birds_test (0 differences).
- Prod pre-audits: negative sample sizes 0; unassigned locations 0; weekly-effective vs month parity exact.
1. **Pre-measure** the complete 0083 on an isolated production-sized clone (a scratch database restored from
   the latest prod backup — not shared `birds_test`): total lock time, WAL volume, table/index sizes, disk
   headroom on the droplet. Accept only if lock time is minutes, not tens of minutes, and disk headroom ≥ 3×
   the new tables + WAL.
2. **Gate:** request worker pause; wait until `worker_status` reports **paused AND no running job** (not just
   "pause requested"); set the migration's `lock_timeout` above any residual wait, or fail fast and retry.
3. Deploy (`deploy-to-DO.sh` migrates before PM2 reload); record lock wait + migration runtime.
4. Verify on prod (equivalence check below) at the exact deployed revision; then resume the worker.
5. On failure: the transaction rolls back (nothing applied); resume worker; investigate. After commit, the
   rollback file + code revert path.

### D3. Hotspots & data totals read the membership tables
New `src/lib/server/species-presence.ts`, replacing `loaded-species-counts.ts`, the `refresh_species_counts`
handler/ensure/policy wiring and most of `src/lib/species-count-status.ts`.
- `readSpeciesTotals()`:
  - Hit path: read `version` (1 row); return the cached result for exactly that version.
  - Miss path: in **one REPEATABLE READ transaction**, read `version` and compute counts (regions from
    `species_region_membership`, countries from `species_country_membership`, both ⋈ `taxonomy_cache`
    `category='species'`; areas and world as `COUNT(DISTINCT)` over country rows **plus unassigned location
    species** for world/`other` area, `GEOGRAPHIC_AREAS` mapping as today).
  - **Race protocol** (CODEX1 P2-1): in-flight promises are keyed by the version read inside the snapshot; a
    result is published to the cache only if its version ≥ the cached version; a request never accepts a result
    for an older version than the one it read. Tests interleave V1/V2 computations and a taxonomy replacement.
  - Web and worker are separate processes; correctness rests on the DB version, not process memory.
- **Zero vs unknown** (CODEX1 P2-4): a loaded country/region shows **0 species** only when its locations are
  present in the location ledger with empty effective sets. If a loaded place has no ledger rows (ledger
  integrity broken), show "Count unavailable" and log; a cheap integrity probe (count of `frequency_fetch`
  rows with no ledger row) runs on the miss path. Tests: loaded-empty, missing-ledger, non-species-only.
- Page: no "updating / pending / not counted yet" states any more; keep the "count each species once…" note.
  Help/About: remove the background-refresh wording. Worker: remove `ensureSpeciesCountRefresh`; a no-op
  `refresh_species_counts` handler completes without rescheduling.

### D4. Field Guide place filter (separate ticket, next release)
`species-enrichment.ts` `searchGuide` `regional_species` + `guideUnknownCount`: country → country table,
first-level region → region table, county / hotspot / map radius → location arrays. Identical sets by D1;
old-vs-new equality test on fixtures and a prod sample.

### D5. Enrichment scope (td-b569b5, separate release)
One shared SQL predicate `effective_scope(species_code)` used by **all three** readers: `IN_SCOPE_CODES_SQL`
(`species-enrichment.ts:525`), `loadResolvedEdges` in_scope (`:1610-1615`) and `getSimilarSpecies` in_scope
(`:2012-2020`): seen OR photo-linked OR present in the country table OR unassigned location arrays. Tests:
zero-sample-only, seen-only, photo-only, unassigned location. Revert td-b569b5's 60 s test-timeout stopgap.

### D6. Stop self-inflicted reloads (separate small release; CODEX1 P1-1)
Replace "any job on /forecast/*" with a **per-route dependency matrix** in `job-poll-core.ts`:
| Route | Invalidate on |
|---|---|
| `/forecast` (What can I see) | frequency job types, `sync_taxonomy`, `sync_lifelist` |
| `/forecast/species` | frequency job types, `sync_taxonomy`, `sync_lifelist` (verify loader reads) |
| `/forecast/data` | frequency job types, `sync_taxonomy`; `scan_enrichment` **only** for its "Next enrichment scan" line — move that line to the polled jobs data instead of SSR, then drop it from the matrix |
| `/hotspots/[locId]` | jobs touching that loc (existing) |
Never: `scan_need_alerts`, `enrich_*`, `tag_*`, `refresh_species_counts`. Keep the route-arrival latch.
Tests: terminal and progress transitions per route, latch drain on arrival.

## Phasing
1. **Release A — td-7162f6:** D1 (+ audits/CHECK, picker eligibility), D2, D2-ops, D3.
2. **Release B — D6** (new small ticket) after per-route tests.
3. **Release C — D4** (new ticket). 4. **Release D — D5** (td-b569b5).
5. **td-fb6948** (region-detail failure state, timeout, retry, country misfiling) — can ship any time; small.
6. New tickets for `/api/hub-country`, `/api/hotspot-counts`, `hubInventoryData`, home `/` query count.
Then resume td-47179c (stash).

## Critical files
- `backend/db/migrations/0083_*.sql` + `backend/db/rollback/0083_*.sql`; patterns: `0053_*`, `0054_*`, `0055_*`
- `src/lib/server/species-presence.ts` (new); delete `src/lib/server/loaded-species-counts.ts`; shrink/delete
  `src/lib/species-count-status.ts`
- `src/routes/forecast/data/+page.server.ts`, `+page.svelte`; `src/routes/help/+page.svelte`, `src/routes/about/+page.svelte`
- `src/routes/forecast/species/+page.server.ts` (picker eligibility)
- `src/lib/server/job-handlers.ts`, `job-policy.ts`, `jobs.ts`, `src/worker/index.ts` (retire refresh job)
- `src/lib/server/taxonomy-sync.ts` (`writeTaxonomy` bumps version)
- Later releases: `src/lib/job-poll.svelte.ts`, `src/lib/job-poll-core.ts` (D6); `src/lib/server/species-enrichment.ts` (D4/D5)

## Verification
- **Pre-migration audits (prod, read-only):** negative `sample_sizes` = 0; weekly-effective vs `num > 0` parity
  per location = 0 mismatches; unassigned-location count.
- **Equivalence gate:** on the restored clone, old `aggregateSpeciesCounts` SQL vs `readSpeciesTotals()` →
  identical maps for every area, country, region and world. On prod after deploy, against
  `species_count_snapshot` (check `fetched_at > built_at` = 0 first).
- **Trigger DB tests** (own `zz…` fixtures, exact cleanup): store → region/country rows + exactly one version
  bump per location per transaction; zero-sample-week-only species excluded; reload with fewer species
  decrements; delete cascades; region_code change moves counts; sample_sizes-only update refreshes; rollback
  leaves version unchanged; TRUNCATE of each source (incl. CASCADE) clears region rows and bumps once;
  taxonomy write bumps version; concurrent stores in different countries and in one region don't deadlock.
- **Benchmarks:** per-location store cost before/after on a large location (US-FL county); `readSpeciesTotals`
  miss/hit on the clone and the droplet.
- `claim-writers-db.test.ts` / catch-walker updates; remove 0082 tests; job-policy/jobs tests; picker test.
- UI: AGY/GROK pass on /forecast/data (5 themes, 320/390/1200, Chromium + WebKit).
- `npm run check`, full suite (known searchable-select failure only), CODEX1 code review, owner go before deploy.

## CODEX1 review dispositions (2026-10-11)
| Finding | Disposition |
|---|---|
| P1-1 D6 whitelist misses `sync_lifelist` (/forecast seen set) and `scan_enrichment` (data page's next-scan line) | Accepted — per-route matrix; D6 split into its own release |
| P1-2 Region ledger/version drift on TRUNCATE | Accepted — guards extended, version bumped once, 0055 preserved, tests |
| P1-3 World total drops unassigned locations | Accepted — world/`other` include unassigned location species |
| P1-4 D5 leaves two in_scope readers on old semantics | Accepted — one shared predicate for all three |
| P1-5 Forecast species picker admits zero-sample-only species | Accepted — eligibility uses effective presence, ships in Release A |
| P1-6 Migration runbook underspecified (lock held for whole txn) | Accepted — clone pre-measure, paused+idle gate, recorded timings, failure path |
| P2-1 Cache in-flight version race | Accepted — version-keyed promises, publish-if-newer, interleaving tests |
| P2-2 Version hot row / repeated refresh per 500-row batch | Accepted — deferred once-per-location refresh + bump (fallback documented) |
| P2-3 D1 equivalence needs enforced premises | Accepted — CHECK on sample_sizes + parity audit |
| P2-4 Missing entry ≠ 0 | Accepted — ledger-integrity check, "Count unavailable" state |
| Phasing ambiguity (D4 "same release if review agrees") | Accepted — D4/D5/D6 explicitly separate releases |
