# Background eBird Worker + Job Queue (td-c6fe5e, td-ca32f0, td-17d291, td-eb9e1d)

> Rev 2, 2026-08-15: incorporates the parallel design reviews — CODEX1 (7 findings:
> state-machine/validation boundaries) and GROK (20 findings: Safari/browser reality,
> UX invariants, ops guards). All accepted; annotated inline as (CODEX1 #n) / (GROK #n).
> Trace note: GROK #19 was confirmations of existing choices (dedup-hash length,
> retention numbers, singleton PK, no-Tailwind/toasts, attribution, Phase 3 syncs stay
> in Phase 3) — no plan change required, hence no inline annotation.

## Context

All eBird data loading currently runs inside HTTP actions driven by long-lived client
fetch loops — any dropped connection, tab sleep, 401, or proxy hiccup surfaces the
"Load interrupted — network error" Gaylon keeps hitting (origin:
`src/lib/forecast-load.svelte.ts:92-95`, mislabeled into the credential slot). Fix at
the root: a dedicated PM2 worker (`birds-worker`) fed by a durable Postgres job queue;
clients enqueue and poll; poll failures are visible-but-calm, never fatal-looking.
**Model synthesis (Gaylon's directive):** madonnahist's durable substrate (Postgres job
table, `FOR UPDATE SKIP LOCKED`, stale reclaim, separate PM2 app) + BTC-dashboard's rich
observability (append-only event log with JSONB details, per-unit progress, tri-state
failure policy, change-triggered worker-status history, health panel with adaptive
polling) — BTC's actual queue is in-memory/IPC; take only its narration. Add what
neither has: dedup keys + persisted `next_retry_at` backoff.

**Confirmed rulings:** worker handles DATA loads only (barchart/frequency, whole-state
county analysis, life-list sync, taxonomy sync); cache-first reference reads
(hotspotsNear/subregions/recentObs) stay in-path. All 3 phases this round. Atomic
cutover (no legacy path). Communal pool/per-user-creds rulings untouched. No daily cap
reintroduction. Concurrency stays 1 with 500ms spacing (politeness).

**End-state invariant:** user-visible error/warning states are exactly: (1) enqueue-time
validation failures; (2) terminal job failures (credential / retries exhausted); (3)
"Worker not running — loads will wait" from a stale server-side heartbeat; (4)
**"Progress may be stale — connection lost" when THIS TAB hasn't successfully polled
recently (GROK #3)** — a muted color+text line, cleared on the next good poll, never
credential-worded. Everything transient is absorbed.

## 1. Migration `backend/db/migrations/0015_job_queue.sql`

Four tables (grants auto via 0002 default privileges; all TIMESTAMPTZ):
- **jobs**: identity PK; `type` CHECK in (load_hotspots, load_region, analyze_counties,
  refresh_loc, retry_loc, sync_lifelist, sync_taxonomy); `payload JSONB` (NEVER
  credentials); `status` CHECK in (pending, running, succeeded, failed, cancelled);
  `dedup_key TEXT`; `requested_by INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT`
  (GROK #16); `label TEXT`; `attempts`/`max_attempts` (default 4, CHECK attempts >= 0);
  `next_retry_at`; `cancel_requested BOOL`; `progress JSONB`; `result JSONB`;
  `error TEXT`; enqueued/started/finished/heartbeat timestamps.
  Indexes: partial claim idx on (enqueued_at) WHERE pending; **partial UNIQUE on
  (dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('pending','running')**;
  recent idx (enqueued_at DESC).
- **job_events**: append-only (job_id FK cascade, at, action CHECK in the verb list,
  details JSONB). Actions: enqueued|deduped|claimed|unit_ok|unit_failed|unit_skipped|
  progress|retry_scheduled|reclaimed|interrupted|completed|failed|cancelled.
  **Index (job_id, at)** (GROK #16 — PG doesn't index FKs).
- **worker_status**: single row (BOOLEAN PK DEFAULT TRUE CHECK(id)) — pid, version
  (GIT_SHA), state idle|working|draining, current_job_id, started_at, heartbeat_at.
  **Seed the singleton row in the migration** (GROK #16).
- **worker_status_history**: change-triggered snapshots + note.

`frequency_fetch` / `species_frequency` / `frequency_fetch_attempts` untouched.
Retention (worker housekeeping): job_events >30d after finish; finished jobs >90d;
history capped 500.

## 2. Worker build — esbuild bundle

Import graph verified clean (no `$app/*` in src/lib/server). New files:
- `src/worker/index.ts` (entry), `src/worker/env-shim.ts` (`export const env = process.env`)
- `scripts/build-worker.mjs` (~30 lines): esbuild, bundle, platform node, ESM,
  outfile `build/worker.js`, `external: ['pg','argon2']`, alias `$env/dynamic/private`
  → env-shim, `$lib` → src/lib, `$server` → src/lib/server; define `__GIT_SHA__`.
- package.json: esbuild devDep; `"build": "vite build && node scripts/build-worker.mjs"`
  (AFTER vite build — adapter-node cleans build/); `"worker:dev:test":
  "node scripts/build-worker.mjs && node --env-file=.env.test build/worker.js"`.
- **Do NOT refactor db.ts/crypto.ts off `$env/dynamic/private`** (breaks dev:test).
- Worker's pg pool sets `application_name: 'birds-worker'` (GROK #17) — one small
  override, not a db.ts fork (pass via env var read by db.ts, or a worker-local Pool
  wrapper around the same module; decide in implementation, keep db.ts single-source).

## 3. Queue modules

**`src/lib/server/jobs.ts`** (shared web+worker):
- `enqueueJob` — **single transaction, bounded retry loop (CODEX1 #5):** INSERT … ON
  CONFLICT with the partial-index inference predicate DO NOTHING RETURNING id; if no
  row, SELECT the active row by dedup_key; if it finished in between, retry the insert
  (max 3 loops). Returned `{jobId, deduped}` + the enqueued/deduped event refer
  atomically to the winning row.
- `claimNextJob` — **ONE SQL statement** (GROK #7; SKIP LOCKED is per-connection):
  `UPDATE jobs SET status='running', started_at=NOW(), attempts=attempts+1,
  heartbeat_at=NOW() WHERE id = (SELECT id FROM jobs WHERE status='pending' AND NOT
  cancel_requested AND (next_retry_at IS NULL OR next_retry_at <= NOW()) ORDER BY
  enqueued_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`.
- **All transitions compare-and-set (CODEX1 #4):** terminal/requeue UPDATEs carry
  `WHERE id=$1 AND status='running' AND attempts=$expected` — a raced
  cancel/complete/requeue can never double-fire or resurrect a terminal row.
  `requestCancel`: pending→cancelled atomically (with event); running → sets flag only;
  terminal rows untouched.
- `recordEvent`; `updateProgress` (one query: progress + heartbeat, RETURNING
  cancel_requested); `completeJob`/`failJob`/`cancelJob`/`scheduleRetry`;
  `reclaimStartupJobs` (running rows at boot: attempts < max → pending + 'reclaimed'
  event w/ crash inference; else failed) — **only ever runs holding the advisory lock**
  (§5); `pruneHistory`; `listJobs`/`jobEvents`/`workerHealth` (alive = heartbeat < 60s).

**`src/lib/server/job-policy.ts`** (pure + tests):
- `classifyFailure`: EbirdLoginError|BarchartAuthError → credential (terminal);
  EbirdUpstreamError 429 → rate_limited; 5xx/504 → transient; BarchartError/other →
  unit. **Classification happens INSIDE ensureFrequencies where the typed error is in
  hand (CODEX1 #2):** `EnsureResult.failed` becomes `[{code, error, kind:
  'credential'|'rate_limited'|'transient'|'unit'|'cooldown'}]`; jobOutcome consumes
  structured kinds, never message-parsing. Mixed unit+transient batches retry only
  what's retryable.
- `retryDelayMs`: transient [16min, 45min, 120min] (≥ the 15-min cooldown — property
  test); rate_limited flat 30min; **cooldown-only remainder → retry at actual cooldown
  expiry, not counted as a failed attempt (CODEX1 #6)**.
- `jobOutcome(ensureResult, attempts, max)` → complete|retry|fail + message. A job
  whose remainder is entirely cooldown-skips completes-with-explanation or schedules
  the expiry retry — never a generic fail (GROK #11j).
- Dedup keys: `load_region:US-ME`, `analyze_counties:US-ME`, `refresh_loc:L123`,
  `retry_loc:L123`, `sync_lifelist:u<id>`, `sync_taxonomy:global`,
  `load_hotspots:<sha256(sorted codes)[0..16]>`.
- `JobProgress` {phase starting|fetching|waiting_retry, unitsTotal/Done/Failed/Skipped,
  currentUnit{code,name}, lastError, round}.
- Decoration helpers (displayName, durationMs, statusColor) pure.

## 4. barchart.ts changes

Keep: fetch/parse/match/validate/store, 500ms spacing, one 5xx retry (4s), 429 stop,
15-min cooldown (force bypasses), attempts bookkeeping, typed errors. Change:
1. **Delete the in-memory lease** (activeBatch/LEASE_MAX_MS) and `busy` from
   EnsureResult — queue concurrency 1 + the advisory lock (§5) are the serialization.
2. EnsureOptions: `onUnit(loc, {status ok|failed|skipped, kind?, error?})` — **invoked
   OUTSIDE the fetch/parse try/catch (CODEX1 #6): a failed progress write must never
   convert a stored row into a barchart failure**; `shouldStop(): 'no'|'cancel'|'drain'`
   (**reports WHY — cancel and drain take different exits, GROK #6**), **checked
   between units AND around the 4s 5xx-retry sleep**; unclamp `maxFetches`
   (default 12; worker passes Infinity — **the `Math.min(…, FETCH_BATCH_MAX)` at
   barchart.ts:524 must be fully removed; a load-bearing test proves >12 units are
   attempted with Infinity, GROK #8**); `timeBudgetMs` opt (default 4min; worker
   Infinity).
3. `EnsureResult.failed` gains `kind`; expose `rateLimited`; cooldown entries are
   kind 'cooldown', status 'skipped' — not fresh failures.
One ensureFrequencies call per job attempt covers the whole set → **delete
`src/lib/forecast-load.svelte.ts` + `src/lib/forecast-load-core.ts` (+test)** at
cutover. **Cutover invariant test (CODEX1 #7): a repo-grep test asserts
ensureFrequencies/analyzeCountyBatch have NO callers under src/routes — worker
handlers only.**

## 5. Worker entry `src/worker/index.ts` + `src/lib/server/job-handlers.ts`

Entry sequence:
1. Env assertions: PG*, EBIRD_KEY_SECRET present. **Environment guards (GROK #7):
   refuse reserved ports 5433-5435 always; refuse port 5436/db `birds` unless
   `BIRDS_ENV=production`; `worker:dev:test` requires `BIRDS_ENV=test`** (mirrors the
   test-db guard scripts — a misloaded env must not aim a dev worker at prod).
2. **Acquire `pg_advisory_lock` on a dedicated connection (CODEX1 #3) — PM2
   `instances:1` is not a concurrency lock.** If unavailable: log + exit (PM2 restart
   backs off). Reclaim/heartbeat/claim only ever run while holding it. Two-worker DB
   test proves the loser can neither reclaim nor claim.
3. `reclaimStartupJobs('worker startup')` + `pruneHistory()`; worker_status upsert
   (pid, version, idle) + history 'startup'.
4. Poll loop: claim → dispatch → loop; 2s idle sleep. 10s heartbeat timer.
5. **Termination is ONE path per cause (GROK #6):** SIGTERM/SIGINT → draining state;
   `shouldStop` returns 'drain'; handler returns; worker performs the SINGLE
   running→pending transition ('interrupted' event, next_retry_at NOW, **attempts−1**)
   and does NOT call jobOutcome. Cancel (`cancel_requested` seen via updateProgress or
   shouldStop 'cancel') → `cancelJob` terminal, no jobOutcome. Crash/kill -9 → startup
   reclaim only (attempts already incremented — no additional −1). PM2
   `kill_timeout: 45000` > one unit (30s timeout + 4s retry pause + spacing).

Handlers:
- Frequency runner (load_hotspots/load_region/refresh_loc/retry_loc): payload carries
  **resolved, action-validated `locs: LocToEnsure[]`** + force. claimed event →
  ensureFrequencies(requested_by, locs, {force, maxFetches: Infinity, timeBudgetMs:
  Infinity, onUnit, shouldStop}) → jobOutcome → complete/scheduleRetry/fail.
- `analyze_counties`: **enqueue-time resolution (CODEX1 #1)** — the ACTION runs
  validateState + `subregions(regionCode,'subnational2')` and writes the resolved
  county list `[{code,name}...]` into the payload; the worker consumes that snapshot
  (recomputing only coverage/cooldowns over it), never re-deriving or re-authorizing
  targets. One job analyzes the whole state with per-county progress. Delete
  analyzeCountyBatch + both client loops after cutover. Payload-tampering +
  forged-but-regex-valid-state tests prove no row inserted / nothing unvalidated
  fetched.
- `sync_lifelist` / `sync_taxonomy` (Phase 3): as before; results carry today's counts.
- **Sacred rule: no credentials/ciphertext in payload/progress/result/events/errors —
  red-team assertion in job-handlers tests (GROK #15).**

## 6. Actions → thin enqueuers

Every action keeps its validation prelude VERBATIM (analyze_counties actions GAIN the
official-state + county-list resolution per CODEX1 #1), replaces ensureFrequencies with
enqueueJob, returns `{queued: {jobId, deduped, label}}` — **`{queued}` REPLACES
`form.ensure` everywhere; the old ensure/busy/stalled banner branches are deleted, or
they'll lie (GROK #9)**. **8 actions total (CODEX1 #7):** forecast ?/loadData; species
?/loadState, ?/analyzeCounties, ?/loadHotspots; data ?/loadRegion, ?/analyzeCounties,
?/refresh, ?/retry. Settings ?/sync_lifelist + ?/sync_taxonomy in Phase 3;
?/test_login stays synchronous. requested_by = scopeId (barchart) / user.id (syncs).
A deduped enqueue ATTACHES to the existing job (returns its id; UI tracks it and shows
its state, e.g. "retrying at HH:MM") rather than reporting busy. No-JS POSTs still
enqueue; progress is visible after refresh on /forecast/data (state that in UI copy).

## 7. Status API + polling client

### Endpoints
- **`/api/*` JSON contract (GROK #1 — load-bearing):** hooks.server.ts currently 303s
  unauthenticated GETs to the login page; the poller would parse login HTML forever.
  Change hooks: unauthenticated GET to `/api/*` (except public paths) returns **401
  JSON**, not a redirect. `GET /api/jobs` → {worker, jobs: DecoratedJob[]} (active +
  last 15), sets `Cache-Control: private, no-store` explicitly (GROK #12).
  `GET /api/jobs/[id]/events`. `POST /api/jobs/[id]/cancel` — **any non-viewer may
  cancel (communal pool, GROK #14); hub shows requested_by so it isn't mysterious.**
- Jobs are communal: visible to every logged-in account; viewers watch, can't act.

### `src/lib/job-poll.svelte.ts` (app-level runes manager) + pure `job-poll-core.ts`
- **Safari-real resume (GROK #2):** poll immediately on `document.visibilitychange` →
  visible AND `window.pageshow` (including `persisted` bfcache restores); no wall-clock
  stop condition — stop only after a successful poll returns zero active jobs (one
  grace poll); `track()`/any enqueue restarts a stopped poller immediately (GROK #11h).
- Adaptive: 2.5s while active; **back off to 15s (or wake at next_retry_at) when the
  only active jobs are `waiting_retry` (GROK #13)**.
- **Failure visibility (GROK #3):** poll failures keep last state AND set a
  `staleSince` timestamp; UI shows the muted "Progress may be stale — connection lost"
  line when stale > ~10s; cleared on next success. 401 JSON OR non-JSON/redirect
  response → quiet stop (session gone; jobs continue server-side) — tested (GROK #1).
- **Refresh discipline (GROK #4):** NEVER invalidateAll on heartbeat/phase ticks.
  Invalidate on terminal transitions, and on unit-progress at ≥15s throttle — and only
  while the relevant page is open. Checkbox selections, MonthPicker state, and scroll
  must survive a running job (Safari charter item).

### Page wiring
- **/forecast**: all three load CTAs (suggested, bulk selected, per-row) become
  enqueue+track through the SAME path (GROK #9); progress banner fed by jobsPoll;
  per-row Load disabled while an active job covers those locs.
- **/forecast/species**: delete analyzeEnhance loop; **single CTA "Analyze all N
  counties"** (GROK #18), disabled while that region's job is pending/running,
  **with an on-page progress bar** (not hub-only — Texas must not look dead).
- **/forecast/data** = load hub (Phase 1 ships: worker-down line, active jobs with
  progress + **Cancel**, recent history — GROK #5 moved these out of Phase 2).
- **+layout.svelte chip (GROK #10):** in the content column below the top nav/viewer
  banner — NOT in nav chrome, NOT overlapping bottom nav/safe-area; ≥48px target;
  links to /forecast/data; color+text. Verify 390px portrait AND landscape.
- **/help updated in Phase 1** (GROK #20) — it currently documents the client
  auto-loop/12-per-click model.

## 8. UX polish (Phase 2, td-17d291)

Remove the redundant suggested-load button; ONE prominent "Load hotspot data (N)"
button near the results header; mobile polish pass. (Cancel/worker-down/chip already
shipped in Phase 1.)

## 9. Admin `/admin` (Phase 3, td-eb9e1d MVP)

As before: worker health panel (+ crash-cluster banner), decorated jobs + expandable
event log, frequency_fetch_attempts view, cache stats.

## 10. PM2 / deploy / health

ecosystem.config.cjs: append `birds-worker` (script build/worker.js,
node_args --env-file=.env, cwd /opt/birds, fork, instances 1 — NEVER more,
kill_timeout 45000, max_memory_restart 300M, own logs). /api/health: add
`worker: ok|stale|never` (no throw on missing row). deploy-to-DO.sh gate: require db
AND worker ok, **fail loudly if birds-worker is absent from `pm2 jlist` (GROK #17)**;
retry loop 6→12 × 5s.

## 11. Tests

Existing suites stay green (update barchart lease/busy cases). New:
1. job-policy.test.ts — classify/delays (≥cooldown property)/outcome matrix incl.
   cooldown-only remainder/dedup keys/decoration.
2. jobs-db.test.ts (birds_test) — enqueue+dedup incl. concurrent-enqueue-while-winner-
   completes (CODEX1 #5) and finished-doesn't-block; claim order + next_retry_at
   gating; two-client SKIP LOCKED; **two-worker advisory-lock exclusion (CODEX1 #3)**;
   CAS races: cancel vs claim, complete vs cancel, SIGTERM-requeue vs completion
   (CODEX1 #4); reclaim both branches; prune.
3. job-handlers.test.ts (injected fetcher) — happy path events+rows; credential
   terminal; 429 → 30min retry; **typed-5xx units → kind 'transient' → retry succeeds
   round 2 (CODEX1 #2)**; mixed unit+transient; cancellation mid-job AND during the
   4s retry sleep; drain requeue attempts−1 with NO jobOutcome (GROK #6); unit failure
   recorded in result + frequency_fetch_attempts; **red-team: no credential material
   in any payload/event/error (GROK #15)**; **Infinity actually attempts >12 units
   (GROK #8)**.
4. job-poll-core.test.ts — intervals incl. waiting_retry backoff; terminal detection;
   silent-failure sets staleSince; 401-JSON and HTML-response both quiet-stop;
   visibility/pageshow triggers; track() restarts.
5. Action tests — validation rejects BEFORE any job row (incl. forged-but-regex-valid
   state, payload tampering); **cutover grep-invariant: no ensureFrequencies/
   analyzeCountyBatch callers under src/routes (CODEX1 #7)**.
6. `npm run check` 0/0; `npm run build` (web + worker bundle).

## 12. Delivery order (each phase: gates → CODEX review → GROK review/Safari →
Gaylon's explicit push+deploy word)

- **Phase 1**: migration; jobs/policy/handlers (4 frequency types); barchart changes;
  worker entry + advisory lock + guards + build; PM2/health/deploy; hooks /api/* 401
  JSON; /api/jobs + cancel; job-poll manager; rewire 8 frequency actions + 3 pages
  (incl. hub Cancel + worker-down line + layout chip + /help); delete old loop files;
  tests 1-6.
- **Phase 2**: td-17d291 obvious-button + mobile polish.
- **Phase 3**: sync_lifelist/sync_taxonomy + settings wiring; /admin; retention.

## Verification (end-to-end, test cluster) — expanded per GROK #11

`npm run test:db:up` → migrate → `worker:dev:test` + `dev:test`. Matrix:
kill -9 mid-job → reclaim + resume; **SIGTERM (not -9) → 'interrupted', attempts
unchanged net, resumes**; cancel mid-job → cooperative terminal cancel with partial
result; enqueue-after-poller-stopped → immediate first poll; two tabs + marcus/viewer
(communal progress visible; viewer cancel hidden/403); 429 → "retrying at HH:MM" (a
clock time, not a spinner); all-units-cooldown → explicit explanation; credential
failure → terminal, no retry; worker stopped → hub banner + health 'stale'; deploy
gate fails when worker absent. GROK Safari charter additionally: lock phone 30s →
return → one poll, bar advances; /help + swipe-back (bfcache) with chip live; airplane
mode mid-job → muted stale line (NOT "network error", NOT credential wording); expire
session → quiet stop, no HTML-parse spin; 227-selection: checkboxes/month/scroll
survive polling; 390px portrait + landscape + 1024px.

## Risks

esbuild shim drift (boot smoke test); cooldown-vs-backoff property test; first-deploy
`worker: never` must not fail the health endpoint itself; second pg pool (max 10) fine
— don't raise; payload snapshots currency-checked per unit; hooks /api/* change is
small but touches auth — test the 401 JSON contract explicitly.

## Do NOT

Move loader cachedFetch reads; touch frequency_* schemas; refactor db/crypto off $env;
reintroduce any daily cap; revisit communal-pool rulings; put credentials anywhere near
the queue; exceed concurrency 1; Tailwind/toasts; td close (use td review); push/deploy
without explicit word after both reviews.
