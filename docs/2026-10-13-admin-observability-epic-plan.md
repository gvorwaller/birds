# Admin observability epic: background operations and metrics

**Epic:** td-dceedc (Admin observability: background operations and metrics). Owner request 2026-10-13: "list tasks that would let me see more about the background operation and metrics", then group them in an epic with this plan.

**Children, in build order:**

| # | td | Slice | Kind |
|---|----|-------|------|
| 1a | td-a47c0d | System health: worker, queue, Postgres, big tables, coverage | snapshot |
| 1b | td-a47c0d | System health: Backup card (waits on Decision 2) | snapshot |
| 2 | td-009031 | eBird traffic metric | daily rollup |
| 3 | td-67b481 | Performance panel (slow requests over 750 ms) | time series |
| ~~4~~ | ~~td-618181~~ | ~~Enrichment observability~~ | closed 2026-10-17: no prod data to show |
| ~~5~~ | ~~td-be8674~~ | ~~Frequency anomalies table~~ | closed 2026-10-17: already shipped |

**Revision 2026-10-17 (owner accepted CC1's recommendations):** td-be8674 is closed because the Hotspots & data page already lists every `frequency_anomalies` row ("Adjusted source values", `src/routes/forecast/data/`). Slice 1 ships as two deploys so the Backup card cannot hold up the rest. Slice 2 can reuse the worker's existing job context. Slices 2 and 3 are built back to back so their tab placement is decided once. td-618181's ticket text is rewritten to the narrowed scope, and its deferred items move to a separate ticket.

This plan supersedes the ordering in Phase 2 of `docs/2026-10-09-infrastructure-tightening-plan.md`, keeps its slice boundaries, and corrects two scope assumptions. Those corrections came from checking the code on 2026-10-13.

## Goal

The owner can see what the app is doing in the background, and how well, from the Admin page on a phone, with no SSH:

- whether the worker is alive and what the queue holds;
- what each job type is doing and when the next scheduled scan fires;
- how the database is holding up;
- how much data is loaded;
- whether backups are current;
- how much eBird traffic the app makes, and from where;
- which pages got slower after a deploy;
- where enrichment is failing.

Today almost every one of these questions is answered by an agent over SSH (`pm2`, `/var/log/pm2/birds.out.log`, `/var/log/nginx/birds.access.log`, `psql`).

## What already exists (do not rebuild)

**Admin tabs** in `src/routes/admin/+page.svelte`: Status, AI & Cost, Tags, Users, Server health.

- **Server health** (td-7739c2, closed):
  - web and worker memory (rss, heap, external, heap limit);
  - uptime and start time;
  - the previous run's peak and how it ended;
  - 7-day memory charts with the PM2 restart limit drawn on;
  - runs table.
  - Source: `src/lib/server/process-health.ts`, migrations 0062/0063, sampled every 5 min, kept 7 days.
- **Status:**
  - the worker heartbeat;
  - the last 50 jobs (`src/lib/server/admin-status.ts`, `/api/admin/status`).
  - It cannot give queue totals: a 50-row window is not a count.
- **AI & Cost** (`ai_usage` ledger, migration 0034):
  - the usage meter (today / 7 days / 30 days / all-time);
  - spend by served model and purpose;
  - stop reasons (including `max_tokens`) and error kinds.
- **Perf instrumentation** (`src/lib/server/request-timing.ts`):
  - per-request db / ebird / google / ai buckets;
  - a stdout perf line for requests over 750 ms (`PERF_LOG_SLOW_MS`) carrying shell/total/bytes/tags and rss/heap.
  - Web only; nothing from the worker.
- `/api/health`: db + worker + gallery + version. It gates deploys and must stay cheap and unauthenticated.

**Decision 1 (recommended): one Admin tab, not a new page.** td-a47c0d was written (2026-09-03) as a separate `/admin/system-health` page modelled on madonnahist. Server health shipped later as an Admin tab and already covers that page's "Web Process" and per-worker memory cards.

- Grow the **Server health** tab into the system-health view, as collapsible cards in the tab's existing style.
- Do not add a second page with overlapping memory numbers.
- The time series (Performance, eBird traffic trend) can be a sixth tab or cards on the same tab. Decide at slice 2 by phone scroll length.

## Cross-cutting rules (every slice)

- **Access:**
  - admin-only on both server and client;
  - a non-admin gets 404 like the rest of `/admin`;
  - tests cover authorization.
- **Read-only:** no provider calls (eBird, Google, Anthropic) from any of these views. The one write action, match-override management in slice 4, gets its own security review.
- **Bounded queries:**
  - every new query has a statement deadline (the Server health precedent is 3 s);
  - a failed card shows "unavailable" with its reason, never a blank or a fake 0;
  - one slow card never blocks the others: load cards in parallel, each with its own error.
- **Honest labels:**
  - a cumulative counter says "since stats reset {date}";
  - a censored sample says so;
  - an estimate says "estimate".
  - Stored counts, never guessed.
- **Retention:**
  - every new table is pruned by the existing prune job, with an owned-fixture prune test (the `process_memory_samples` precedent);
  - growth is measured on prod before shipping.
- **UI:**
  - hand-written scoped CSS, design tokens only, all 5 themes;
  - AAA contrast; 48 px controls;
  - works at 320 / 390 / 1200 px;
  - numbers use `toLocaleString()`;
  - job names come from `displayName()` in `job-policy.ts`.
- **Help and About:** each slice gets a Help entry (what each number means, in plain words) and an About Version History line.
- **Gates (full tier: these touch server data paths and migrations):**
  - `npm run check`;
  - full suite (only the known `searchable-select` failure);
  - CODEX1 hostile review for each slice (write `high` effort for slices 2 and 4);
  - a UI pass: admin only; Chromium, WebKit and the iOS Simulator via axe; 5 themes;
  - owner deploy go; a prod read-back after deploy.

## Slice 1: td-a47c0d System health

Extend the Server health tab with these cards.

1. **Worker:**
   - status from the existing `worker_status` heartbeat, using `AdminWorker.alive` as `adminLiveStatus()` already computes it (not madonnahist's 420 s rule);
   - PID, last poll, `pause_requested`;
   - link to the existing memory chart.
   - No new heartbeat mechanism.
2. **Job queue:**
   - exact counts by job type × status (pending, running, failed in the last 24 h / 7 d, cancelled), via one `GROUP BY` over `jobs`;
   - last completed, per type;
   - for recurring types (`RECURRING_TYPES`): the pending row's `next_retry_at` (the column `decorateAdminJob` already reads), shown as "fires in N min". This is the 2026-09-03 "14.6 h timer" surprise made visible.
3. **Postgres:**
   - database size (`pg_database_size`);
   - the key `pg_settings` (shared_buffers, work_mem, effective_cache_size, max_parallel_workers_per_gather);
   - heap and index cache-hit % from `pg_statio_user_tables`, labelled "since stats reset" with `pg_stat_database.stats_reset`;
   - **free disk** on the data volume.
   - Disk free: `fs.statfs` from the web process on a path it can stat. Verify on prod which mount holds the cluster before choosing the path; `birds_app` may not be able to stat the data directory itself.
4. **Big tables:**
   - rows (`reltuples`, labelled estimate), table and index size, heap hit %;
   - for species_frequency, species_month_freq, loc_month_samples, frequency_fetch, species_enrichment, jobs, ebird_cache, ai_usage, process_memory_samples.
5. **Coverage:**
   - loaded countries / states / counties / hotspots (`frequency_fetch`);
   - distinct species with frequency data;
   - enrichment progress: in scope vs wiki ok / iNat terminal / AI ok / similar ok.
   - Reuse the existing Hotspots & data and enrichment-scope queries where they exist; never re-derive a number differently from the page that already shows it.
6. **Backup:**
   - last successful backup time, flagged stale after 26 h.
   - **Decision 2:** the backup runs on the owner's Mac (`scripts/backup-pg.sh`, Carbon Copy Cloner preflight) and pulls over SSH, so prod has no record of it today.
   - Recommended: on success, the script records the time on prod with one small write. Either a row in a one-row `ops_marker` table through `psql`, or a file the app can read. The card then reads it.
   - The script change is ops, not app code; it needs the owner's go because it adds a write to prod from the Mac.

**Delivery:** cards 1–5 ship first as slice 1a. Card 6 (Backup) ships as slice 1b after the owner approves the script change in Decision 2; until then the tab carries no Backup card rather than an "unknown" one.

**Reuse:** extend `adminLiveStatus()` / `/api/admin/status` for the worker and queue cards so the Status tab and this tab share one source. Cards refresh every 30 s while the tab is open (madonnahist's cadence), paused when hidden.

**Tests:**
- the card queries against owned fixtures (queue counts by type and status; next-run math);
- each card's failure state;
- admin-only access;
- the stats-reset label.

## Slice 2: td-009031 eBird traffic metric

**Purpose (owner, 2026-10-09):** watch eBird traffic so we can later find cheaper ways to fetch it. Diagnostic, not per-user.

**Chokepoints to instrument:** network calls do not all go through one function. Verified call sites:

- `ebirdFetch` / `ebirdFetchOrNull` in `src/lib/server/ebird.ts`: the API 2.0 calls, used by ebird.ts, hotspot-page, lifer-locations and hotspot-coordinate-repair;
- `cachedFetch` in `ebird.ts`: the `ebird_cache` TTL layer, where **cache hits** are counted;
- `src/lib/server/barchart.ts`: `ebird.org/barchartData` through the signed-in session fetcher (the frequency loads, the heaviest traffic);
- `src/lib/server/ebird-account.ts`: web login (CAS) and the life-list CSV;
- `lifer-locations.ts`: checklist HTML through the owner fetcher.

**What to count:**
- **Dimensions:** day × endpoint class × origin × outcome.
  - **Endpoint class:** a fixed allow-list such as `data/obs/recent`, `data/obs/notable`, `ref/hotspot/region`, `ref/hotspot/geo`, `ref/hotspot/info`, `ref/region`, `ref/taxonomy`, `barchartData`, `login`, `lifelist`, `checklist`; unknown paths become `other`.
  - **Origin:** `web` or the worker job type, read from an AsyncLocalStorage context that the job runner sets. This needs care: `request-timing.ts` is a no-op in the worker.
  - The worker already has that context: `runWithClaim()` in `src/lib/server/job-claim.ts` runs every handler inside `claimContext` (job id + claim seq). Adding the job type to `JobClaim` gives the origin without a second AsyncLocalStorage. Verified 2026-10-17.
  - **Outcome:** `network_ok`, `http_error`, `rate_limited` (429), `network_error`/timeout, `cache_hit`, `stale_fallback`.
- **Measures:** calls, total ms, bytes.

**How to store it:**
- An in-memory per-process accumulator, flushed every few minutes and on clean shutdown with an `INSERT … ON CONFLICT DO UPDATE` add into `ebird_traffic_daily`.
- One row per (day, class, origin, outcome, process). Kept 400 days: that is a few thousand rows a year.
- The flush follows the process-health sampler's rules: non-overlapping, with a write deadline. A lost flush on a crash loses at most a few minutes of counts; label the totals "approximate".

**Privacy and safety:**
- The class comes from the path template only.
- Never store query strings, keys, usernames, region codes or IDs.

**UI (Server health tab, or a sixth tab; decided here for slices 2 and 3 together):**
- top endpoint classes by calls, 7 / 30 days;
- cache-hit rate per class;
- web vs worker split, and which job types drive worker traffic;
- 429 and error counts;
- daily trend sparkline.

**Tests:**
- classification (allow-list; `other`; no IDs leak into a class);
- origin context in web and worker;
- the flush adds rather than overwrites, and survives a concurrent flush;
- prune scope.

## Slice 3: td-67b481 Performance panel

As specified in the ticket:

- **Recording:**
  - a `page_timing` table, written only when the perf line already fires (over 750 ms in prod);
  - fire-and-forget, so it never delays a response;
  - pruned at 30 days.
- **Columns:** at, route id (not the raw URL: no IDs or query strings), status, shell/total ms, bytes, tags, the four bucket n/ms, rss/heap, and the deploy version (`/api/health`'s version string), so before/after a deploy is a filter, not a guess.
- **UI:**
  - the last ~50 slow requests;
  - a 7-day per-route rollup: count, worst, median shell, worst bytes.
  - A route that got slower after a deploy shows up as a climbing row.
  - The panel is labelled plainly as "only requests slower than 0.75 s are recorded: this shows what is slow and whether it is getting worse, not how fast the site usually is".
- **Worker jobs:** not in this slice. Job durations already live in `jobs`; slice 1's queue card can show the median and worst duration per type cheaply.

## Slice 4: td-618181 Enrichment observability (closed 2026-10-17)

**Closed by the owner before building.** Measured on prod first: `species_match_overrides` had 0 rows ever, and `species_enrichment` had 0 `wiki_error` / 0 `ai_error` rows, so both remaining features would have shown empty cards. AI cost and `max_tokens` visibility were already live (`ai_usage`: 20 max_tokens, 20,520 end_turn). Reopen if failures or overrides ever appear. The original narrowed scope is kept below for that case.


**Already shipped, so it drops out of scope:**
- Anthropic token cost accounting: the `ai_usage` ledger and AI & Cost meter;
- max_tokens truncation visibility: stop reasons on AI & Cost, and enrichment no longer discards usage on truncation (`ai-enrichment.ts`).

Confirm both on prod at the start of the slice, then record them in the ticket.

**Remaining core:**
- **Enrichment failures:**
  - a card listing `wiki_error` / `ai_error` by error kind, with counts and the newest species for each kind;
  - each species links to its page.
  - Admin only; error text shown as stored (already free of keys).
- **Species match overrides:** list, edit and delete `species_match_overrides`. Today the Photos page can create one but nothing lists or removes them.
  - This is the epic's one write action: form actions with CSRF, an admin check, delete confirmation by modal (no toasts), and an audit line in the job/event log.
  - It needs its own CODEX1 security pass.

At the start of the slice, rewrite td-618181's description to this narrowed scope and file the deferred items below as their own ticket.

**Deferred (unchanged):** Wikidata QID link, AI dropped-tag vocabulary report, Wikipedia Vocalization / lead image, Wikidata extras. These are data-transparency items for later.

## Slice 5: td-be8674 Frequency anomalies (closed 2026-10-17)

Already shipped before this epic, in commit 5a21637: the Hotspots & data page's "Adjusted source values" section lists every `frequency_anomalies` row, with location, species, week, source vs stored frequency, sample size and detection date. The rows are newest first in a deterministic order, with no cap. It is open to every signed-in user rather than admin-only, which fits the app's educational purpose. The owner closed the ticket.

## Order and dependencies

1. Slice 1 first: it is the frame, and slices 2 and 3 link into it.
2. Then slice 2, the metric the owner asked for. It can start in parallel with slice 1, but its UI lands on slice 1's tab.
3. Slice 3 right after slice 2: both are time series, so they share one placement decision and the flush/prune pattern slice 2 builds.
4. Slice 4 last: independent of the others, and it carries the epic's only write action and its own security review.
5. Slice 1b (Backup card) slots in whenever Decision 2 is answered.

Each slice is its own commit series, review, deploy and td review, so any one can be rolled back alone.

## Owner decisions

1. **One Admin tab vs a new page** for system health: **grow Server health** (accepted 2026-10-17).
2. **Backup marker on prod** written by the Mac backup script: recommended; the owner's go on the prod write is confirmed at slice 1b. The Backup card waits for it.
3. **Retention** (accepted 2026-10-17):
   - eBird traffic: 400 days;
   - page_timing: 30 days, per the ticket.

## Verification (epic done)

- Every question in the Goal is answered on Admin on a phone. Checked on prod by the owner.
- The SSH reads used in recent tickets have an in-app equivalent: the worker state, queue counts, slow requests and eBird call counts. An example is td-fb6948's nginx evidence of about 20 region-detail calls.
- No new view makes a provider call. All new tables are pruned; prod growth is measured after a week.
