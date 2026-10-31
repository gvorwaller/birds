# Admin → Taxonomy: back up, sync, compare, refresh affected locations (td-6093ae)

*CC1, 2026-10-30. Revision 2, after CODEX1's hostile plan review (see "Review changes" at the end).*

## Context
eBird published its 2026 taxonomy (from Oct 27; eBird's versions API reports 2026 as the latest). Prod is still on the 2025 taxonomy: 17,891 taxa, 11,167 of them species, synced once on 2026-09-11.

Today there is no way to tell which of the 14,157 stored frequency locations (6,717 regions and 7,440 hotspots) a split or lump touches. Willet alone appears in 3,692 locations and Marsh Wren in 4,333.

The sync overwrites `taxonomy_cache`, so the old concepts are lost and nothing records what changed. Only the jobs' result JSON remains, and that is pruned after 90 days.

Gaylon wants a permanent admin feature, not a workaround:
- a dated backup table;
- a "back up and compare" button whose results go to their own table and drive the location refresh;
- all of it in one **Taxonomy refresh** card with clear instructions.

Owner decisions (2026-10-30):
- **Sync from the admin card only.** ⟳ Sync leaves Settings, so a backup always comes first.
- **One button runs back up → sync → compare as a single job.**
- **A new "Taxonomy" admin tab.**

Measured on prod (read-only, 2026-10-30):
- 884 locations were loaded since the last sync (58 regions, 826 hotspots).
- The newest frequency load was 2026-10-18, before eBird switched.
- 5,266 locations have a truncated unmatched-name sample: unmatched names per location are 10 at the median, 67 at p90 and 546 at most, but only the first 20 are stored.

## What the owner sees: Admin → Taxonomy → "Taxonomy refresh" card
1. **Instructions, in plain words:**
   - eBird updates its taxonomy once a year, usually in October or November.
   - When eBird says its update is complete, do these in order:
     1. Press **Back up, sync and compare**.
        - Straight away, the app's species list, names, tags and photo matches switch to the new taxonomy.
        - A species eBird removed stops appearing in forecasts until its locations are reloaded.
     2. Read the list of changes.
     3. Press **Refresh affected locations**. Each listed location's frequencies are reloaded from eBird. This uses your eBird account login, so it must be saved in Settings.
     4. Ask every user to sync their life list in Settings, so their lifers move to the new species.
2. **Status:**
   - "Our taxonomy: N taxa, synced <date>, eBird version <v or unknown>".
   - "eBird's latest: <v>" plus "Update available", from the taxonomy versions endpoint, cached for a day. This is shown only if the Phase 0 probe shows the response can be relied on. Our own version is recorded from the first run on; before that it reads "unknown" and is never inferred.
3. **The run** (the newest, or one chosen from History):
   - Each stage with its state: backed up, new taxonomy applied, compared, finishing.
   - On failure: the stage, the error, and **Try again**, which resumes from the failed stage.
4. **Changes:**
   - Counts by kind: removed, added, moved out of "species", scientific name, common name, reporting-parent (report_as), other details.
   - A fold listing every changed taxon: old → new, its kinds, and its stored-location count.
5. **Locations that need a reload: N.** The breakdown:
   - **Hold a changed species:** X.
   - **Stored names that now match a species:** Y.
   - **Loaded since the last sync, which may have used eBird's new names before we had them:** Z. Included to be safe.
   - **Carried over from an unfinished earlier run:** C.
   - Never phrased as "every affected location". The cost is shown as "about N eBird requests, plus logins and retries".
6. **Refresh affected locations:**
   - Progress: reloaded · queued · failed (with the last error) · unfinished (a job ended without reaching it) · not yet queued.
   - **Retry unfinished** re-queues every failed or unfinished location whose job is no longer active.
7. **Life lists:** "X lifers across Y users use codes eBird removed".
   - Narrow on purpose: a split that keeps a code isn't counted. So every user should still re-sync.
8. **History:** past runs with date, version, counts and outstanding locations, each selectable. Below it, the backups (date, taxa count).

The busy state and per-section results reuse the Sources card pattern (`SourcesPanel.svelte`: `busy`, `act()`, `settle()`, `notice()`, `working()`). Without JavaScript, the actions still work and the page reloads.

## Data: migration `0099_taxonomy_refresh.sql`
- **`taxonomy_runs`:**
  - `id` identity PK
  - `requested_by int REFERENCES users ON DELETE SET NULL`, plus `actor_label text`
  - `job_id bigint`, plain: jobs are pruned at 90 days
  - `stage text CHECK IN ('started','backed_up','applied','after_backed_up','compared','done')`
  - `failed_stage`, `error`
  - `before_id`, `after_id REFERENCES taxonomy_backups ON DELETE RESTRICT`
  - `target_hash`, `target_version`, `applied_at`, `compared_at`, `counts jsonb`
  - `superseded_by REFERENCES taxonomy_runs`, `created_at`
- **`taxonomy_backups`:**
  - `id` identity PK, `taken_at timestamptz UNIQUE`
  - `run_id REFERENCES taxonomy_runs ON DELETE RESTRICT`, `kind CHECK IN ('before_sync','after_sync')`
  - `UNIQUE(run_id, kind)`
  - `taxa int`, `source_fetched_at` (MAX `taxonomy_cache.fetched_at`, as provenance), `ebird_version text NULL`
- **`taxonomy_backup_rows`:** `(backup_id CASCADE, species_code, …)` with every `taxonomy_cache` business column (0001 + 0057), `PK(backup_id, species_code)`.
- **`taxonomy_changes`:** `(run_id CASCADE, taxon_code, kinds text[], old_*/new_* for com_name, sci_name, category, report_as, PK(run_id, taxon_code))`, plus `affects bool` and `locations int`.
- **`taxonomy_refresh_locations`:** `(run_id CASCADE, loc_code, loc_kind, loc_name, region_code, reasons text[], species_codes text[], batch_no int NULL, dispatched_at, last_error, PK(run_id, loc_code))`.
  - Reasons and codes are aggregated per location before insert.
- **`taxonomy_refresh_batches`:** `(run_id CASCADE, batch_no, job_id, requested_by REFERENCES users ON DELETE SET NULL, created_at, PK(run_id, batch_no))`.
  - A batch's location list is fixed once written.
- **Grants:** 0002's default privileges cover tables created by `birds_owner`; a migration test asserts it. The jobs type CHECK is unchanged.
- **Retention:** everything is kept; backups are about 18k rows each, once a year. Nothing cascades from users or jobs.

## Server: `src/lib/server/taxonomy-refresh.ts` (new)
**Run lifecycle.** The `sync_taxonomy` job carries `{runId}`. Each stage is one claim-fenced transaction (`withClaimTx`). Stale claims are rethrown, and no progress is written while a fenced transaction holds the job.
1. **`started` → `backed_up`:** `INSERT … SELECT` from `taxonomy_cache` into a backup with kind `before_sync`. Idempotent via `UNIQUE(run_id, kind)`.
2. **`backed_up` → `applied`:**
   - Fetch the eBird taxonomy, and its version if Phase 0 allows.
   - Validate with `parseTaxonomy`. Compute `target_hash` over the normalized rows.
   - `replaceTaxonomy(payload, requester, { onApplied })`. The only addition inside the exclusive tag transaction is one tiny `UPDATE taxonomy_runs SET stage='applied', target_hash, target_version, applied_at`, so "which replacement committed" is durable together with the replacement.
3. **`applied` → `after_backed_up`:**
   - Never fetches or replaces again.
   - Backs up `taxonomy_cache`, then checks its hash equals `target_hash`. A mismatch fails loudly with "taxonomy changed underneath this run".
4. **`after_backed_up` → `compared`:** compare plus the affected-location workset, written in one transaction. Idempotent: it deletes and rewrites this run's rows. It also carries forward unresolved locations from earlier unfinished runs and marks those runs superseded.
5. **`compared` → `done`:** the existing post-steps: life-list orphan counts, photo re-match, taxonomy summary, family enrichment.

A retry resumes at the recorded stage, so it never compares one taxonomy while installing another. Starting a new run is refused server-side while another run is between `started` and `compared`.

**Comparison (`classifyChanges`, a pure function):**
- It looks at every stored business field: com_name, sci_name, category, family, order_name, family_code, family_sci_name, taxon_order, report_as, extinct, and banding_codes as a sorted set. Comparisons are null-safe.
- Kinds: `removed`, `added`, `category`, `scientific`, `common`, `report_as`, `other`.
- **Affecting species set:**
  - old category 'species' with `removed`, `category`, `scientific` or `common`. Common-name-only changes count on purpose: a split that keeps the old code for one daughter only shows up as a name change.
  - the old and new reporting parents of any `report_as` change.
- Limits, stated in the code and in this doc: a code reused for a new concept with identical fields can't be seen in snapshots. Added species are covered only through their parent's change, or through the "loaded since the last sync" set.

**Affected locations:**
- **changed_species:** DISTINCT `loc_code` from `species_frequency` (indexed on species_code) for the affecting set.
- **now_matches:** `frequency_fetch.unmatched_names` checked with the real barchart matcher (`buildMatcher()` called as `barchart.ts:875` calls it, with the name only), built after the sync, so the live taxonomy is the after-taxonomy. This is positive evidence only: the sample is capped at 20 (`barchart.ts:40`).
- **loaded_since_sync:** `frequency_fetch.fetched_at > before-backup.source_fetched_at`. These loads may have used eBird's new names before we had them. A disclosed superset (884 today).
- **carried_over:** unresolved locations from superseded runs.

**Refresh dispatch (`dispatchRefresh(runId, adminId, mode: 'new'|'unfinished')`):**
- **Prerequisites, checked separately:** the clicking admin has an eBird account login saved. The barchart fetch uses `loginFromStoredCreds(requested_by)`, so an API key alone isn't enough. That admin becomes `requested_by`; nobody else's credentials are used.
- Selects the locations: never-dispatched for `'new'`; failed or unfinished with an inactive job for `'unfinished'`.
- Sorts them and cuts batches of 200. For each batch, in one transaction: `insertJobOn(client, refresh_loc {locs, force:true})`, insert the `taxonomy_refresh_batches` row, and set the locations' `batch_no` and `dispatched_at`.
- The dedup key is `taxonomy_refresh:<run>:<batch>` (`dedupKeys`). A double POST or a partial failure can't requeue a batch that completed.

**Location state (`refreshProgress`), derived with this precedence:**
1. **reloaded:** `frequency_fetch.fetched_at > dispatched_at`
2. **queued:** the batch job is pending, running or in backoff
3. **failed:** `frequency_fetch_attempts.status='error'` and `last_attempt_at > dispatched_at`; the error is kept in `last_error` until a newer outcome
4. **unfinished:** the job is terminal or pruned without reaching the location (credential abort, exhausted 429, cancelled)
5. **not queued**

**Campaign pause:** a credential failure or exhausted 429 in one batch does not stop sibling batches. Instead, the card shows the batch's job error at the top, with "Fix the login in Settings, then Retry unfinished".

**Live status:**
- `GET /api/admin/taxonomy?run=<id>` returns the run stage and per-state counts. It is admin-only (404 otherwise) and bounded: counts plus at most 50 failed rows.
- The panel polls it every 5 s while a run is active or locations are queued, pauses while the tab is hidden, then invalidates the page data when the work ends.

## Job wiring
- **`job-handlers.ts` `sync_taxonomy`:** calls `runTaxonomyRun(job)`, which reads `payload.runId` and loops through the stages. Errors keep the existing credential/transient classification.
- **Label:** "eBird taxonomy: back up, sync and compare".
- **Admin action `taxonomy_sync`:**
  - Needs the admin's API key.
  - Refused while a run is active, or with "an earlier run still has unfinished locations — they will be carried over" (the run is then still created).
  - Creates the run and enqueues with `insertJobOn` in one transaction.

## Admin route and UI
- **`src/routes/admin/+page.svelte`:** add `"taxonomy"` to `ADMIN_TABS`, with its tab and panel.
- **New `src/lib/components/admin/TaxonomyPanel.svelte`:** in a `CollapsibleCard id="taxonomy-refresh"`, with folds for the change list, history and backups.
- **New actions in `src/routes/admin/+page.server.ts`:** `taxonomy_sync`, `taxonomy_refresh`, `taxonomy_retry`. Each re-checks `role==='admin'` and returns a `kind:"taxonomy"` result.
- **`load`:** adds the panel data, bounded and with the run selectable via `?run=`.

## Settings, help and wording
- **Settings:** remove the ⟳ Sync form and the `sync_taxonomy` action. Keep "N taxa · last synced" and add "An admin refreshes it each year (Admin → Taxonomy)".
- **Help:** update `help/+page.svelte` ~262-266, and add an "Admin: Taxonomy refresh" section covering the four steps, what each changes immediately, and what catches up later.
- **`ebird-account.ts`:**
  - ~695, the empty-taxonomy error: "An admin needs to run the taxonomy refresh (Admin → Taxonomy)".
  - `partialImportNote` (~805): the same pointer.
- **`/life`:** its links to the life-list sync stay as they are.
- **About:** a version-history line (cs.md).

## Phase 0 (before code)
- **Probe `/ref/taxonomy/versions` read-only and record the real response.** If it can't reliably name the latest version, drop the status line and `target_version`.
  - **Done 2026-10-30.** One GET with an admin key from `birds_test` returned `200 application/json`: an array of `{"authorityVer": number, "latest": boolean}`, newest first. It starts with `{"authorityVer":2026.0,"latest":true}, {"authorityVer":2025.0,"latest":false}, …` and goes back to 0.9.
  - So the latest version is the one entry with `latest:true`. It is a number: show it as written (2026, 2021.01), never rounded.
  - The status line and `target_version` stay in. A fetch is `cachedFetch` with a one-day TTL. When the response is invalid, or more than one entry or none is `latest`, the status reads "unknown".
- **`EXPLAIN` the affected-set query** on `birds_test` (a prod snapshot).
  - **Done 2026-10-30.** For four common codes (willet1, marwre, sora, killde) it is an index-only scan on `species_frequency_species_idx`: 329,283 rows, 255 ms, with an 8 MB external sort. It runs once per comparison, inside its transaction.
- **Measure a repeated country band-rollup:** `storeFrequencies` rebuilds the whole country band per region reload (`barchart.ts:598-606`). Time a sample of region refreshes before claiming throughput.
  - **Done 2026-10-30.** `rebuildBandRollup`, timed on M4 / `birds_test` inside transactions that were rolled back:
    - US-FL: 631 ms and 544 ms
    - CA-ON: 164 ms
    - NO-18: 76 ms
  - Each region reload adds this on top of its eBird fetch; hotspot reloads skip it. Prod is slower than M4, so these are lower bounds. Real throughput is measured on the first prod run.
- **Pinned taxonomy version (CODEX1 code review #6), probed 2026-10-30** with one-species requests: `/ref/taxonomy/ebird?version=2026&species=willet1` returns the 2026 entry, where willet1 is now `category:"slash"`, "Saltmarsh/Prairie Willet". `version=2025` returns the 2025 entry, still `species`. `version=1999` returns `[]`. A run therefore asks the versions endpoint fresh and fetches the taxonomy AT that version.

## Verification
- **Unit tests:**
  - `classifyChanges`: every field; null-safety; banding treated as a set; common-name-only change; category demotion and promotion; report_as closure; added and removed.
  - The progress precedence.
  - Batch cutting: more than 200 locations, sorted, stable.
- **Matcher fidelity:** punctuation, accents, override precedence, and the scientific name not used, all through the real `buildMatcher`.
- **DB tests on `birds_test`, owned fixtures only, worker stopped:**
  - Fixture backups and runs.
  - Hotspot fixtures `L99…` plus a valid-shaped region code with an owned `regions` row (0045's shape check and FK).
  - Fixture `species_frequency` and `frequency_fetch` rows, with exact-id cleanup in `finally` and the corpus count fingerprinted before and after.
- **What those DB tests cover:**
  - backup idempotency per run and kind;
  - compare and workset rewrite idempotency;
  - a location matched by both changed_species and now_matches aggregated into one row;
  - a truncated sample;
  - carried-over and superseded runs;
  - dispatch in one transaction and dedup on a double POST;
  - unfinished derivation after a credential abort, an exhausted 429, cancellation, and a pruned job;
  - Retry unfinished;
  - the login prerequisite;
  - non-admin 403/404;
  - an account deletion that leaves run history (SET NULL);
  - stale-claim rejection at every new writer.
- **Orchestration:** the run state machine is tested with the sync boundary mocked (no `replaceTaxonomy` on the shared `taxonomy_cache`). It covers crash and resume after every stage commit, a changed upstream between attempts (never refetched once applied), the hash-mismatch guard, an empty taxonomy, and a run with no changes.
  - The real replacement keeps its existing isolated coverage (the `taxonomy-reference.test.ts` TEMP-table pattern), plus one test that `onApplied` runs inside the replacement transaction.
- **Gates:** `npm run check`, `npm run build`, the full `npm test`, and `git diff --check`.
- **Browser pass:** Admin → Taxonomy with Playwright (Chromium and WebKit; 5 themes at 320, 390 and 1200). It covers keyboard use, refresh and Back, JavaScript off, a non-admin, stale and error states, and no hidden result cap. Plus the iOS Simulator.
- **Reviews:** CODEX1 hostile code review at `high`, a GROK or AGY UI pass, then `td review`.
- **Deploy** on Gaylon's go. Then Gaylon runs it on prod. Afterwards, read-only: record the counts, the locations to reload, the run time, and the refresh throughput.

## Not in scope (noted)
- `forecast.ts` (~704) inner-joins `taxonomy_cache` without a category filter, so a code demoted from "species" still appears in forecasts until its location reloads. Separate ticket.
- Storing the full unmatched-name list (not a 20-name sample), so that the "loaded since the last sync" superset can be narrowed later. Separate ticket.

## Review changes (CODEX1, 2026-10-30)
- **P1, retry could compare one taxonomy and install another.** Durable run stages; "applied" is recorded inside the replacement transaction with a target hash; the after-backup is verified against the hash; there is no refetch once applied.
- **P1, the 20-name sample isn't exhaustive.** The sample is positive evidence only. Added the disclosed "loaded since the last sync" superset. The card never claims "every".
- **P2, failed-only retry stranded locations.** Fixed batch lists linked to jobs, with explicit states (unfinished, not queued) and **Retry unfinished**.
- **P2, matcher fidelity.** Uses the real `buildMatcher` with barchart's arguments.
- **P2, the classifier dropped fields.** Every field is classified, with the report_as closure and the stated limits.
- **P2, a second run hid unfinished work.** Run history, carry-over and supersede, and server-side refusal while a run is active.
- **P2, refresh needs the eBird web login, not just the API key.** A separate prerequisite; the clicking admin is the requester.
- **P2, the live poll wouldn't refresh the card.** A targeted admin endpoint plus invalidation.
- **P2, the user FK blocked account deletion.** ON DELETE SET NULL, and backups never cascade.
- **P2, orchestration tests must not replace the shared taxonomy.** The sync boundary is mocked; region fixtures are valid; the worker is stopped.
- **P3, the instructions understated what changes at once.** Rewritten. Also updated the error at `ebird-account.ts` ~695.
