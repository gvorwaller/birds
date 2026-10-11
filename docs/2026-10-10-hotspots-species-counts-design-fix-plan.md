# Fix species counts on Hotspots & data

**Status:** implementation plan, 2026-10-10. **Scope:** `/forecast/data` species totals only. No deployment or production backfill is authorized by this plan.

## Problem and evidence

The page can show “Counting species…” indefinitely even though the hotspot inventory has loaded. The page streams `loadedSpeciesCounts()` and its `{#await}` branch has no completion deadline (`src/routes/forecast/data/+page.server.ts`, `+page.svelte`). Each uncached request first hashes every `frequency_fetch` and taxonomy row. On a changed hash it starts one global `GROUPING SETS` query with `COUNT(DISTINCT species_code)` over `species_month_freq` (`src/lib/server/loaded-species-counts.ts`). A location refresh changes the hash, so ongoing loads repeatedly discard the value of that in-process cache. Cache state is also separate in each app process.

Read-only production diagnosis on 2026-10-10 found 15 concurrent copies of the species aggregate, with the oldest over five minutes and no lock wait. The monthly rollup was about 13.7 million rows by PostgreSQL estimate; frequency loads were active. Health was otherwise OK. These observations explain the screenshot without blaming Safari or the eBird request. They are a dated snapshot, not a performance baseline for a future release.

This is a design failure: a page render can initiate an unbounded, database-wide exact count, and routine writes can initiate more copies while it runs. Replacing the spinner with a timeout alone would hide the symptom and leave the database work in place.

## Required behavior

1. Opening or reloading `/forecast/data` reads a small, durable, already published count snapshot. It must never start the global count or a revision hash. Rendering the page must not enqueue work.
2. Preserve the current meaning of each number: distinct taxonomy `category = 'species'` with at least one `species_month_freq.num > 0` in a loaded location; overlapping locations count a species once per geographic group. Preserve world, area, country, and subnational1 grouping, `other`, and unassigned-location world behavior. Do not sum hotspot counts or silently cap rows.
3. A successful refresh publishes all geographic counts atomically with `built_at` and a source revision. Until then, show the last successful snapshot with an explicit “updated … / updating” indication. If no snapshot exists, say “Counts being prepared” or “Counts unavailable” as appropriate; never print `0 species` for unknown data. A computed zero remains `0 species`.
4. Changes in loaded frequency data, location geography, or taxonomy eventually produce a new snapshot. If refresh fails or times out, keep the last good snapshot, expose failure to operators, and retry with bounded backoff. Continuous loading must not defer a refresh forever.

## Implementation

### 1. Capture a repeatable baseline

On an isolated production-sized **`birds_test`** snapshot, record the current query plan, wall time, temp-file use, and concurrent-request behavior. Verify the exact current result for world, representative areas/countries/states, overlap, unassigned locations, and a loaded region with zero species. Do not run the global aggregate on production again for benchmarking.

### 2. Maintain per-location presence at write time

Add a compact derived table keyed by `(loc_code, species_code)` for species codes having **any** positive monthly numerator at that location. Do not filter taxonomy in this table; taxonomy changes must take effect at snapshot build time. Add the needed foreign key, indexes, and `birds_app` grants. Extend the existing per-location monthly-rollup rebuild in `src/lib/server/barchart.ts` so replacement of presence rows occurs in the same transaction as replacement of `species_month_freq`; deletion of a frequency location must delete its presence. Confirm every caller of `rebuildMonthRollup`, direct monthly-table writer, and location deletion path follows this contract. A direct monthly-table maintenance operation must either rebuild affected presence rows in that transaction or explicitly schedule reconciliation before publishing a new snapshot.

Do **not** put the initial full-table backfill in the schema migration. Build a resumable, location-keyset backfill with small transactions, progress and error reporting, and an idempotent rerun. New writes during backfill must remain correct: serialize a location's backfill and live replacement with a location-level lock, or choose an equivalent race-free protocol. Mark the presence table complete only after validation against the source rollup.

### 3. Publish an exact snapshot outside requests

Add one durable published-snapshot record (or equivalent small set of rows) containing the complete result, source revision, and build timestamp. Build from location presence joined to `frequency_fetch` geography and current `taxonomy_cache`; retain the existing grouping and deduplication semantics. Run the build in a consistent read transaction, then atomically replace the published snapshot. If a source change commits during the build, the published revision is older and the maintenance loop must build again; it must never label old results current.

Track a durable source revision/dirty state in the database. Cover `frequency_fetch` inserts, updates, deletes, `species_month_freq` changes, and taxonomy replacement—including repair scripts that bypass application helpers. Statement-level database triggers or an equivalently comprehensive transactionally maintained mechanism are acceptable; avoid per-row global revision updates during bulk writes. Document and test the maintenance boundary for direct monthly-table writes so a revision bump cannot publish stale presence data. Avoid the current per-request `md5(string_agg(...))` scan.

Have one worker-owned, deduplicated maintenance loop/job perform refreshes, with a quiet-period debounce **and** a maximum age so frequent writes cannot postpone publication indefinitely. Keep the refresh lower priority than user-requested loads, impose a database statement timeout, and provide bounded retry/backoff. The worker must not run parallel copies. If the presence-based worldwide distinct query still spills heavily or exceeds the agreed refresh budget on production-sized test data, optimize or partition the snapshot build before rollout; do not ship it merely because the UI no longer waits.

### 4. Make the page honest and fast

Replace `streamed(loadedSpeciesCounts())` with a read of the published snapshot and status. Remove the `{#await}` “Counting species…” branch. Show timestamp and stale/updating/error status near the counts in plain language; keep Field Guide links for known positive region counts. A missing count for a specific geography is distinct from an exact zero. Update the relevant `/help` explanation to describe how recent the displayed totals are.

## Verification and release gates

- **Correctness:** compare the published result against the existing aggregate on isolated `birds_test` fixtures and a production-sized test snapshot; test overlap, taxonomy reclassification, monthly numerator becoming zero, location deletion/geography repair, `other`, unassigned world-only entries, empty inventory, and mid-build writes. Test backfill/live-write races and resume after interruption.
- **Page behavior:** prove repeated reloads and concurrent sessions issue only bounded snapshot reads and display a known value or explicit unavailable/preparing state, never an indefinite spinner. Test stale status and refresh failure while preserving last good counts.
- **Performance:** capture `EXPLAIN (ANALYZE, BUFFERS)` and temp-file evidence for refresh on production-sized `birds_test`, plus request timings under concurrent loads. Agree on a page-read target under 200 ms and a bounded refresh target before release; these are gates to measure, not claims already met.
- **Safety:** follow `cs.md` and `docs/agent-development-guide.md`; protect the production-sized test snapshot and unrelated checkout changes. Schema deployment must be safe with no snapshot yet. Run the isolated backfill only after explicit production authorization, verify its completion, then enable snapshot publication. Do not claim live success from a started deploy: verify the exact deployed revision, health, worker, page state, and completed count generation.

## Stop conditions

Stop and revise the design if per-location presence cannot be kept transactionally consistent with the monthly source, if the snapshot build still threatens the load queue/database, or if exact count parity fails. Do not replace exact counts with an undocumented estimate or silently serve stale data as current.

## CC1 critical review and implementation decisions (2026-10-10)

Measured on the production-sized `birds_test` (M4): `frequency_fetch` 12,987 rows (prod 14,097); `species_month_freq` 13.55 M (prod ≈ 13.73 M); distinct `(loc, species)` with `num > 0` 2.23 M. The current exact aggregate, **one copy alone**: 5.4 s, ~350 MB temp spill at `work_mem` 4 MB; 5.35 s and half the spill at `work_mem` 64 MB. The per-request revision hash: 44 ms. Prod had 0 copies running after today's restarts.

The failure is the **request path** (every page load can start the aggregate, and every completed load changes the revision, so copies pile up), not the aggregate's cost when run once. Decisions:

1. **Phase 1 (now): keep the existing exact query; run it only in one worker job.** One copy ≈ 5 s on the M4, so roughly 30 s on the droplet (≈ 5× slower). The per-location presence table (§2) is **deferred**: it adds a migration, a resumable backfill, write-path changes in `barchart.ts` and a consistency contract for a 6× smaller input that the measurements do not yet require. Revisit only if the droplet build exceeds the refresh budget (gate: measured on prod after deploy).
2. **No triggers.** The worker computes the existing revision hash each cycle (≈ 44 ms; 0 per page load), satisfying "avoid the per-request md5 scan" without a revision counter.
3. **Build and publish in separate transactions.** The build runs read-only REPEATABLE READ (revision + aggregate from one snapshot) with `statement_timeout` 10 min and `work_mem` 64 MB, outside any claim-fenced transaction (fenced txns are capped at 120 s; td-b99b6d). Publishing is a short `withClaimTx` upsert. A source change during the build leaves the published revision behind the next cycle's hash, so it rebuilds; old results are never labelled current.
4. **Cadence:** a single recurring, deduplicated worker job. Revision unchanged → check again later. Changed → build when the last frequency write is ≥ 5 min old (quiet period) **or** the published snapshot is ≥ 60 min old (max age, so continuous loading cannot defer it forever). Failures keep the last good snapshot, record the error, and back off with a bound.
5. **Page:** reads the snapshot row (and the refresh job's state) only; shows "updated …", "updating" or "last refresh failed"; "Counts being prepared" when no snapshot exists; never `0 species` for unknown data.
