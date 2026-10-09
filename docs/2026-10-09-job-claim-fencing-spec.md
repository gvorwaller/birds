# td-b99b6d — Job queue: fence every durable side effect to the live claim

**Status:** design spec, revision 3 (no code changed). Written 2026-10-09 from the code at
`6a888e3`; revised twice the same day after CODEX1's design reviews (see Review log, §10).
**Ticket:** td-b99b6d (P3 bug). Acceptance sharpened by CODEX1 on 2026-10-09
(`docs/2026-10-09-infrastructure-tightening-plan.md:28-31, 103, 111`): fence durable side
effects, not only events; check before each external request, DB write, enqueue/notification
and completion; use the claim token in the same transaction for DB side effects where possible.
**Settled upstream design this spec extends:** B5 §3z/§3cc in
`docs/2026-09-30-open-ocean-rules-v2-plan.md:392-451` (`claim_seq`, `AsyncLocalStorage` claim
context, `StaleClaimError`, the "catch blocks rethrow stale first" rule — applied there to the
B5 modules only, and explicitly deferring the existing handlers to this ticket at lines 414 and 451).

---

## 1. Root cause and threat model

### 1.1 What a stale execution is

A *stale execution* is a handler continuation whose claim is no longer the live one:
`jobs.status <> 'running'` or `jobs.claim_seq <> ctx.claimSeq`. Two concrete producers:

1. **Drain requeue + same-process re-claim.** `requeueInterrupted` refunds `attempts`
   (`src/lib/server/jobs.ts:457-474`), the row goes back to pending, `claimNextJob` re-claims it
   at the *same* `attempts` with `claim_seq + 1` (`jobs.ts:266-285`). Any late continuation of
   the first execution now carries a dead claim at the same attempts — the attempts-only CAS
   cannot tell them apart (`jobs-claim-db.test.ts:97-105` proves the refund).
2. **Lost lock session while the process lives.** The worker's single-worker guarantee is a
   session-scoped advisory lock on a dedicated client (`src/worker/index.ts:64-81`). If that
   session dies (Postgres restart, `pg_terminate_backend`, network reset) while the Node process
   keeps running, a new worker acquires the lock, `reclaimStartupJobs` moves the old worker's
   `running` row to pending (`jobs.ts:626-666`) and claims it. The old handler is still executing
   in another process. Nothing today detects it until the old execution's next *fenced* write.
   From the database's point of view this producer is exactly "`reclaimStartupJobs` + a new
   claim while execution A continues"; §6.2 simulates it with the scoped reclaim.

### 1.2 Why fenced transitions/progress are not enough (evidence)

B5 fenced `transition()` and `updateProgress()` (`jobs.ts:293-338`) and `runJob` swallows
`StaleClaimError` at its boundary (`src/lib/server/job-handlers.ts:2613-2617`). The remaining gaps
are between fenced writes, and in catch blocks that swallow the fence:

| # | Gap | Evidence |
|---|-----|----------|
| G1 | `recordEvent` is a plain INSERT, no claim predicate. Every `unit_*`/`progress`/`claimed` event from a stale execution lands in `job_events`. | `jobs.ts:135-148`; 44 call sites in `job-handlers.ts`, 2 in `tag-jobs.ts` (§3.1) |
| G2 | The frequency `onUnit` callback wraps its event + progress write in `try { … } catch {}` — it swallows `StaleClaimError` from `updateProgress`, so a stale load keeps fetching eBird and storing frequencies for the rest of the batch. | `job-handlers.ts:238-254`, and again `job-handlers.ts:270-275` |
| G3 | Need-alert scan: per-user sends happen with only the *budget* `checkpoint()` before them; the first fenced write for a user is the `unit_ok`/`updateProgress` **after** all pushes. The per-user catch records `unit_failed` for any error including a stale one and continues. | sends `job-handlers.ts:753-789`; catch `851-865` |
| G4 | Chunk harness: the per-unit fenced write is `updateProgress` **after** `runUnit` (`job-handlers.ts:1389`), so a stale execution performs one full unit (provider calls + species writes) before detection; per-unit catches call business writers (`markWikiError` etc.) before any fenced write. | `job-handlers.ts:1383-1390`, `1991-2001`, `2185-2201`, `2386-2399` |
| G5 | Family enrichment: every `family_enrichment` / `family_enrichment_control` / diagnostics write is an unfenced autocommit or a `withTransaction` with no claim check; the publish UPDATE fences on `attempts` only (`AND attempts=$8`) — exactly the refunded value a stale claim shares. The big catch writes failure state for any error, including a stale one. The nested source lookup swallows stale errors into a `transport_failure` diagnostic and continues to the next candidate. | `src/lib/server/family-enrichment.ts:413, 424, 439, 460, 474-498, 538, 562-570, 595-608, 641-652`; catch `559-628`; `family-source-discovery.ts:94-103, 185-190` |
| G6 | Handlers enqueue successor/spillover/remediation jobs through `enqueueJob`, which has no claim check. | `job-handlers.ts:2027, 2092, 2216, 2414`, `1099-1146`; `tag-engine/repair.ts:197`; `family-enrichment.ts:271` |
| G7 | Tag ops/consistency/eval/draft write reports, proposals, authoring freezes and engine state via unfenced definers or `withTagWriteTx` transactions that never look at the job row (except `record_tag_preview` and `record_tag_family_reference_for_job`, which do). | §3.3 |
| G8 | A `UPDATE jobs SET label` on the job's own row with no status/claim predicate. | `family-enrichment.ts:413-416` |
| G9 | The `ebird_cache` upsert overwrites `payload` and sets `fetched_at = NOW()` unconditionally, so an old in-flight fetch (stale or merely slow) overwrites a newer stored result. | `ebird.ts:318-323` |

The single-worker advisory lock makes (1) rare and (2) unusual, but neither impossible, and
nothing in the handlers turns "unusual" into "safe".

### 1.3 The invariant to establish (with its explicit exceptions)

> Under a claim context, **no durable side effect commits unless the job row is `running`
> under that claim at commit time** — every DB write, enqueue and job event is checked under a
> `FOR SHARE` lock on the job row inside the transaction or statement that performs it — and
> **no external request or notification is dispatched without a successful claim check
> immediately before it** (residual: the one in-flight request per checkpoint, a TOCTOU no DB
> fence can close, as §3cc already accepts for the B5 provider call). Without a claim context
> (tests, admin pages, scripts), behaviour is unchanged.

**Explicit exceptions (class D), each a truthful record of something that already happened in
the world, never a decision:**
1. `ai_usage` receipts for a provider call already made (`ai-call.ts:86, 99`) — ruling Q2.
2. `need_alerts_sent` + `need_alert_log`, written only **after a confirmed delivered push**
   (`job-handlers.ts:790-828`) — ruling Q1, §3.3.
3. `push_subscriptions` prune of endpoints the push service reported gone (`:836-840`).
4. `ebird_locations` / `lifer_loc_coords` / `lifer_loc_attempts` idempotent caches
   (`lifer-locations.ts:216, 238, 278, 293`) — the dispatch before each is fenced (Q3).
5. `ebird_cache` rows: **not** exempt as such — the upsert gets a freshness-ordering guard
   (§4.8) so an older fetch can never overwrite a newer row; that guard is what makes the
   unfenced write safe (G9).

Nothing else is exempt. Phase A's claim (§8) is scoped to exactly this list.

---

## 2. Existing machinery (what to build on, not re-invent)

| Piece | Where | Note |
|-------|-------|------|
| `jobs.claim_seq bigint NOT NULL DEFAULT 0`, bumped by every claim | `backend/db/migrations/0072_tag_rules_v2.sql:37`; `jobs.ts:271` | never refunded |
| `JobClaim`, `claimContext` (AsyncLocalStorage), `runWithClaim`, `currentClaim(jobId)`, `StaleClaimError`, `isStaleClaim` | `jobs.ts:86-117` | `isStaleClaim` also matches definer `RAISE 'stale claim: …'` text |
| Fenced `updateProgress`, `transition()` (all CAS transitions), `terminalizeAndReschedule` | `jobs.ts:293-338, 499-518` | predicate `status='running' AND claim_seq=$` when a context exists; `StaleClaimError` on miss |
| Fenced event pattern (snapshot-only — see §4.1) | `recordClaimedEvent`, `jobs.ts:156-166` | `INSERT … SELECT … WHERE EXISTS(jobs running AND claim_seq)`; 0 rows → throw |
| Fenced SQL definers (row lock `FOR UPDATE` on `jobs`) | `record_tag_preview` (`0072:248-269`), `record_tag_family_reference_for_job` (`0073:79-94`) | the pattern for "same transaction" fencing |
| `runJob` boundary catch | `job-handlers.ts:2437-2439, 2613-2625` | swallows stale once; `failJob` in the catch is itself fenced |
| Test-only `ClaimScope` for claim/reclaim | `jobs.ts:245-263` | `jobs-db.test.ts:63-66` uses `{ labelLike: 'JOBTEST %' }` |
| Existing stale-claim DB test harness | `src/lib/server/jobs-claim-db.test.ts` | owns `CLAIMTEST <run>` rows, claims with its own UPDATE (`:48-57`), never `claimNextJob`; proves A-refused/B-proceeds for the queue APIs |
| Tag-engine lock order and caps | `src/lib/server/tag-engine/runtime.ts:28, 76-107` | engine advisory xact lock → one fail-key lock → `begin_tag_attempt` → rows; `SET LOCAL lock_timeout 10s / statement_timeout 60s / transaction_timeout 20s|30s`; `TagTxRollback`/`TagTxRefusal` skip failure recording (`:109`) |
| Source-walking test helper | `src/lib/server/tag-guard.test.ts:19-27` (`walk`, `isTestFile`) | reuse for the catch-discovery test (§4.6); no catch-scanning test exists today (grep of `*.test.ts` for `readFileSync` finds only SQL/brand scanners) |
| `job_events.job_id` FK | `0015_job_queue.sql:39` | an INSERT takes only `FOR KEY SHARE` on the parent — does **not** conflict with a transition's `FOR NO KEY UPDATE` (§4.1) |

---

## 3. Inventory of durable side effects reachable from a handler under a claim

Classes: **A** already fenced · **B** fence-able in the same statement/transaction via the
claim token · **C** external / non-transactional → pre-side-effect checkpoint (residual: the one
in-flight effect) · **D** exception from §1.3 (truthful record, left unfenced) · **G** guarded
by freshness ordering instead of a claim (ebird_cache only).

### 3.1 Job events — `recordEvent` call sites (all currently unfenced → become **A** by §4.1)

| File | Lines | Count | Handler |
|------|-------|-------|---------|
| `job-handlers.ts` | 217, 239 | 2 | runFrequencyJob (claimed, unit_*) |
| | 419 | 1 | runSyncJob (claimed) |
| | 488 | 1 | runTagRepairJob (claimed) |
| | 654, 686, 849, 860 | 4 | runNeedAlertScan |
| | 1211 | 1 | runScanEnrichment |
| | 1310 | 1 | claimChunk (shared by 3 chunk handlers) |
| | 1464, 1543, 1635, 1642, 1654, 1662, 1677, 1704, 1732, 1737, 1744, 1753, 1764, 1770, 1773, 1780, 1796, 1801, 1820, 1915, 1921, 2000, 2038, 2103 | 24 | runEnrichSpecies (wiki/AI) |
| | 2161, 2183, 2200, 2228 | 4 | runEnrichSpeciesMedia |
| | 2318, 2369, 2381, 2398, 2424 | 5 | runEnrichSpeciesInat |
| | 2473 | 1 | analyze_counties dispatch |
| **job-handlers.ts total** | | **44** | |
| `tag-jobs.ts` | 93, 258 | 2 | runTagConsistencyJob, runTagOpJob (claimed) |
| `recordClaimedEvent` (snapshot-fenced today; gets the §4.1 locking fix by becoming an alias) | `tag-family-refs.ts:72`, `tag-eval-jobs.ts:257`, `tag-draft-job.ts:191`, `tag-preview-job.ts:81` | 4 | B5 modules |
| `jobs.ts` internal `recordEvent` calls | 352, 353, 371, 372, 387, 411, 416, 447, 448, 471, 472 | 11 | post-transition events: written only by the CAS winner → cannot be stale (**A** by construction), but the row is no longer `running`, so a running-fenced INSERT would refuse them → they use the **unfenced queue-only** writer (§4.1) |
| | 614 | 1 | `requestCancel` (web request, no claim context) → queue-only writer |
| | 658, 660, 662 | 3 | `reclaimStartupJobs` (startup, no claim context) → queue-only writer |
| `jobs.ts` direct `INSERT INTO job_events` | 196 (`insertJobOn`), 226 (`enqueueJob` dedup), 521 + 559 (`terminalizeAndReschedule`) | 4 | 521/559 are inside the fenced txn (**A**); 196/226 become fenced through `enqueueJob` (§4.4) |

### 3.2 Writes to the queue rows themselves

| Site | Statement | Class | Action |
|------|-----------|-------|--------|
| `jobs.ts:293-308` updateProgress | fenced | A | add the misuse guard + lock timeout of §4.3 |
| `jobs.ts:323-474` transitions | fenced CAS | A | same |
| `jobs.ts:491-574` terminalizeAndReschedule | fenced CAS in txn | A | same |
| `family-enrichment.ts:413-416` `UPDATE jobs SET label` | **unfenced**, own row | B | new `setJobLabel(jobId, label)` in jobs.ts, fenced exactly like `updateProgress` (`status='running' AND claim_seq`), 0 rows → `StaleClaimError`; guarded by §4.3 |
| `family-enrichment.ts:259-263` `UPDATE jobs SET next_retry_at` — pull of *another* pending job's timer | unfenced | **B (cadence mutation)** | It changes *when* the family singleton runs; a stale `sync_taxonomy` continuation must not re-time other jobs. Wrap the nudge in `withClaimTx` (no-op without a claim — the worker loop's own nudge at `worker/index.ts:111` and the admin paths keep working). Previously mis-filed as idempotent. |
| `job-handlers.ts:1195-1198` scan timer pull | only from the admin nudge (no claim) | n/a | — |

### 3.3 Handler business writes (DB), per handler

Legend for "shape": *auto* = single autocommit `query()`; *tx* = `withTransaction`; *tagtx* =
`withTagWriteTx` (engine lock); *definer* = SQL SECURITY DEFINER function.

#### Frequency loads (`load_hotspots`, `load_region`, `refresh_loc`, `retry_loc`, `analyze_counties`) — `job-handlers.ts:195-350`
| Write | Where | Shape | Class | Fence |
|-------|-------|-------|-------|-------|
| `storeFrequencies` (frequency_fetch, species_frequency, anomalies, month/band rollups, attempts) | `barchart.ts:515-611` (called `:871`) | tx | B | convert to `withClaimTx` (assert first; §4.3). Cancel-delay measurement per ruling Q4. |
| `recordFailedAttempt` (frequency_fetch_attempts) | `barchart.ts:613-621` (called `:916`) | auto | B | `withClaimTx` |
| Barchart export fetch is uncached (no `ebird_cache` row) | `barchart.ts:845/859` | — | C | §3.5 |

#### `sync_lifelist` — `job-handlers.ts:2507-2536`, `ebird-account.ts:765-858`, `lifer-locations.ts:125-300`
| Write | Where | Shape | Class | Fence |
|-------|-------|-------|-------|-------|
| `importLifeList` (seen_species replace + user_ebird status) | `ebird-account.ts:636-714` | tx | B | `withClaimTx` |
| `life_list_synced_at` | `:819` | auto | B | `withClaimTx` |
| `loc_resolution_status` ok/error | `:838-841`, `:844-847` | auto | B | `withClaimTx`; the catch at `:842` rethrows stale first (then its `.catch(()=>{})` at 847 is harmless) |
| `life_list_status='error'` on failure | `:852-855` (in catch `:850`) | auto | B | catch rethrows `isStaleClaim` first, then `withClaimTx` |
| `ebird_locations`, `lifer_loc_coords`, `lifer_loc_attempts` | `lifer-locations.ts:216, 238, 278, 293` | auto | D (§1.3 item 4) | idempotent caches keyed by (user, loc); **the dispatch before each is fenced** per ruling Q3: `await assertClaimHeld('lifer-hotspot')` immediately before `lookupHotspot` (`:215`) and `await assertClaimHeld('lifer-owner')` before `lookupOwnerHtml` (`:268`). Boundary: a single owner-page dispatch may follow CAS redirects inside `fetchAuthenticatedEbird` (several HTTP legs) — those legs are one residual request from the fence's point of view. The fenced heartbeats at `:188-195` (per loc) and `:248-255` (per subId) remain and are not sufficient on their own because `heartbeat` is optional (`:133`) and the hotspot leg runs with no check between heartbeat and dispatch. The catches at `:224-231` and `:113-122` rethrow anything that is not an eBird error, so a stale throw propagates (verified). |

#### `sync_taxonomy` — `job-handlers.ts:2591-2608`
| Write | Where | Shape | Class | Fence |
|-------|-------|-------|-------|-------|
| `replaceTaxonomy` (taxonomy_cache rewrite, lexicon state, `materializeMany`, `beginTagRepair` → `insertJobOn`) | `taxonomy-sync.ts:96-104` | tagtx (exclusive) | B | fenced centrally inside `withTagWriteTx` (§4.3) — no change in this file |
| `rematchPhotoLinks` (photo_links) | `gallery.ts:81-104` | tx | B | `withClaimTx` |
| `ensureFamilyEnrichment(true)` → nudge + `enqueueJob` | `family-enrichment.ts:253-272` (called `job-handlers.ts:2604`) | auto + tx | B | nudge via `withClaimTx` (§3.2); enqueue via fenced `enqueueJob` (§4.4) |
| `ebird_cache` write by the taxonomy fetch, if cached | `ebird.ts:318-323` | auto | G | freshness-ordering guard §4.8 |

#### `tag_repair` — `job-handlers.ts:481-526`, `tag-engine/repair.ts:122-177`
| Write | Where | Shape | Class | Fence |
|-------|-------|-------|-------|-------|
| each repair batch (`materializeMany`, `complete_tag_repair`) | `repair.ts:138-172` | tagtx (exclusive, ≤1 s) | B | central `withTagWriteTx` fence; `shouldStop` (fenced `updateProgress`) runs *between* batches (`:137`, `job-handlers.ts:511`) — outside the lock, as the §4.3 guard requires |

#### `scan_need_alerts` — `job-handlers.ts:651-900`
| Write | Where | Shape | Class | Fence |
|-------|-------|-------|-------|-------|
| `need_alerts_sent` upsert + `need_alert_log` insert (one writable CTE) | `:805-827` | auto (`queryTimed`, grace-bounded) | **D (ruling Q1)** | Written only after `delivered > 0` (`:790-795`). It is the truthful suppression/history record of a push the user already received; refusing it would turn one straddling push into a duplicate on the next scan. The two rows stay together in one statement. The *send* is fenced by the checkpoint before it (§3.5). Narrow exception, documented in code at the statement, and tested (§6.3 "straddling send"). |
| `push_subscriptions` prune of 404/410 endpoints | `:836-840` | auto (best-effort) | D (§1.3 item 3) | idempotent delete of endpoints the push service declared gone |
| `ebird_cache` write by `notableNearbyObs` | `ebird.ts:316-323` | G | §4.8 |

#### `scan_enrichment` — `job-handlers.ts:1209-1237`
| Write | Where | Shape | Class | Fence |
|-------|-------|-------|-------|-------|
| up to 8 `enqueueJob` per pass | `:1099-1146` via `:1214` | tx | B | fenced `enqueueJob` (§4.4); content-hash dedup already absorbs duplicates, but a stale pass must not *create* work |

#### `enrich_species` (wiki + AI) — `job-handlers.ts:1422-2108`
| Write | Where | Shape | Class | Fence |
|-------|-------|-------|-------|-------|
| `upsertResolution` | `:1925` → `species-enrichment.ts:112-121` | tx | B | `withClaimTx` |
| `markWikiNoArticle` | `:1931, 1941, 1950` → `species-enrichment.ts:245-250` | tagtx (shared) | B | central `withTagWriteTx` fence |
| `upsertWikiOk` | `:1961` → `species-enrichment.ts:206-210` | tagtx (shared) | B | central `withTagWriteTx` fence |
| `markWikiError` | `:1996` → `species-enrichment.ts:272-281` | auto | B | `withClaimTx` |
| `similarCandidatesFor` (persists `species_similar_display`) | `:1556, 1675` → `species-enrichment.ts:1727-1890` (writes at rel. 88-133) | tx | B | `withClaimTx` |
| `reconcileSimilarState` | `:1583` → `species-enrichment.ts:1942-1980` | tx | B | `withClaimTx` |
| `markSimilarDeclined` | `:1674` → `species-enrichment.ts:1890-1941` | tx | B | `withClaimTx` |
| `upsertAiProseData` (field craft + notes) | `:1715` → `species-enrichment.ts:300-477` (tx at 398) | tx | B | `withClaimTx` |
| `UPDATE species_enrichment SET similar_status=NULL…` | `:1726-1731` | auto | B | `withClaimTx` |
| `markAiError` | `:1751, 1816` → `species-enrichment.ts:482-548` | auto ×2 | B | one `withClaimTx` (the two statements become atomic — a pre-existing gap closed incidentally) |
| `ai_usage` receipt for every Anthropic call | `ai-call.ts:86, 99` → `recordUsage` | auto (best-effort) | D (ruling Q2) | never fenced |
| spillover / remediation `enqueueJob` | `:2027, 2092` | tx | B | fenced `enqueueJob` |

#### `enrich_species_media` — `job-handlers.ts:2123-2235`
| Write | Where | Shape | Class | Fence |
|-------|-------|-------|-------|-------|
| `upsertMediaOk` (species_media replace + enrichment status) | `species-enrichment.ts:2615` → `:1284-1336` | tx | B | `withClaimTx` |
| `markMediaError` | `job-handlers.ts:2196` → `species-enrichment.ts:1345-1360` | auto | B | `withClaimTx` |
| spillover `enqueueJob` | `:2216` | tx | B | fenced `enqueueJob` |

#### `enrich_species_inat` — `job-handlers.ts:2265-2429`
| Write | Where | Shape | Class | Fence |
|-------|-------|-------|-------|-------|
| `markInatNoMapping` | `:2366` → `species-enrichment.ts:2378-2419` | tx | B | `withClaimTx` |
| `upsertInatSimilar` | `:2377` → `species-enrichment.ts:2282-2377` | tx | B | `withClaimTx` |
| `markInatError` | `:2394` → `species-enrichment.ts:2420-2450` | auto | B | `withClaimTx` |
| spillover `enqueueJob` | `:2414` | tx | B | fenced `enqueueJob` |

#### `enrich_families` — `family-enrichment.ts:336-655`
| Write | Where | Shape | Class | Fence |
|-------|-------|-------|-------|-------|
| `reconcileFamilyInputs` (family_enrichment upsert for every family) | `:285-301` (called `:390, 506`) | tx | B | `withClaimTx` (no-op when called from admin/taxonomy paths without a claim) |
| `UPDATE jobs SET label` | `:413-416` | auto | B | `setJobLabel` (§3.2) |
| no_source UPDATE | `:424-435` | auto | B | `withClaimTx` |
| pending_source UPDATE | `:439-442` | auto | B | `withClaimTx` |
| pending_draft/model UPDATE | `:460-463` | auto | B | `withClaimTx` |
| audit_rejected diagnostics INSERT + pending_draft UPDATE | `:474-498` | auto ×2 | B | one `withClaimTx` |
| publish txn | `:507-551`; predicate `:538` is `status='running' AND attempts=$8 AND NOT cancel_requested` | tx | **B (attempts-only today = the refund hole)** | `withClaimTx`; drop `attempts=$8` from the UPDATE predicate (the assert supersedes it), keep `NOT cancel_requested` (product rule). Lock order inside: `LOCK TABLE taxonomy_cache IN SHARE MODE` (`:510`) — put the claim assert **before** that table lock so a stale execution never takes the table lock. |
| insufficient_source diagnostics + UPDATE | `:562-570` | auto ×2 | B | one `withClaimTx`, after the catch rethrows stale first |
| failure txn (status='error', control pause/block) | `:595-608` | tx | B | `withClaimTx`; the catch at `:559` must rethrow `isStaleClaim` first — otherwise a stale claim's `StaleClaimError` from `stop()` is classified as "`<stage>` failed; automatic retry scheduled" and *pauses or blocks the feature* (`:602-607`) |
| source diagnostics INSERT in `finally` | `:641-652` | auto | B | `withClaimTx` (runs even when the body threw stale — the fence refuses it) |

#### `tag_consistency` — `tag-jobs.ts:91-117`, `tag-engine/consistency.ts:134-290`
| Write | Where | Shape | Class | Fence |
|-------|-------|-------|-------|-------|
| lexicon step (`lexiconFor rebuild`, `beginTagRepair` → `insertJobOn`) | `consistency.ts:156-194` | tagtx (exclusive) | B | central `withTagWriteTx` fence |
| `ensureTagRepairJob` → `enqueueJob` | `:205` → `repair.ts:192-206` | tx | B | fenced `enqueueJob` |
| per-batch `materializeMany` | `:218-228` | tagtx (exclusive) | B | central fence |
| `record_tag_consistency_run` (success and the catch's "failed" run) | `:259, 276` → `:40-60` | definer, auto | B | `withClaimTx`; the catch at `:269` rethrows stale first; the inner best-effort catch at `:285-287` may swallow a *refused* run record, which is correct (the original error is rethrown at `:288`) |

#### Tag owner ops (`tag_stage`, `tag_benchmark`, `tag_activate`, `tag_retire`, `tag_rollback`) — `tag-jobs.ts:251-342`
| Write | Where | Shape | Class | Fence |
|-------|-------|-------|-------|-------|
| `stageRevision` steps | `activation.ts:178-215` (each `withTagWriteTx('shared')`) | tagtx | B | central fence per step; `onProgress` (fenced `updateProgress`) runs *between* steps (`:213`) — outside the lock ✓ |
| `record_tag_report` (stage, benchmark) | `tag-jobs.ts:239-248` (called `:296, 310`) | definer, auto | B | `withClaimTx` |
| `activateRevision` (dry run / real) | `activation.ts:258-328` | tagtx (exclusive) | B | central fence; a benchmark/dry run always rolls back (`:325`, `TagTxRollback`) so it has no durable effect anyway, but the fence still stops a stale execution from burning ≤10 s under the exclusive lock |
| `retireTagToLegacy`, `rollbackTag` | `activation.ts:349-360, 372-383` | tagtx (exclusive) | B | central fence |

#### `tag_draft_rules` — `tag-draft-job.ts:177-339` (B5 Phase 1; §3cc's fenced definers are **not built** — plan `:564`)
| Write | Where | Shape | Class | Fence |
|-------|-------|-------|-------|-------|
| `freeze_tag_authoring_set` (inserts `tag_authoring_example`) | `:203-207` → `0071_tag_eval.sql:41` (2-arg, unfenced) | definer, auto | B | `withClaimTx` now (no SQL change); §3cc's re-signed definer remains Phase 2 |
| `ai_usage` receipt | via `meteredAiCall` `:229` | auto | D | ruling Q2 |
| `tag_rule_proposal` INSERT | `:318-324` | auto | B | `withClaimTx` (until §3bb's `create_ai_tag_proposal` lands) |

#### `tag_design_simulation`, `tag_eval_create`, `tag_gate_report` — `tag-eval-jobs.ts:254-316`
| Write | Where | Shape | Class | Fence |
|-------|-------|-------|-------|-------|
| `record_tag_report` (simulation, gate) | `:50-62` | definer, auto | B | `withClaimTx` |
| `createBlindTest` → `createEvalSet` | `tag-eval-jobs.ts:150-207` → `tag-engine/eval-sample.ts:95-175` | **tx, REPEATABLE READ** (`withTransaction` at `:103`, `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` at `:104`, definer `create_tag_eval_set` at `:162-173`) | B | **Not a wrapper.** `assertClaimHeldTx(client)` becomes the first *data* statement inside that transaction, immediately after the `SET TRANSACTION` line (which must stay the first statement). Under REPEATABLE READ, a concurrent transition that commits after the snapshot makes the `FOR SHARE` raise `40001` (serialization failure, "could not serialize access due to concurrent update") — map `40001` from the assert to `StaleClaimError`; never retry it into a successful eval set. The misuse guard of §4.3 applies for the whole callback. Use `withClaimTx(fn, { isolation: 'REPEATABLE READ' })` so the ordering (SET TRANSACTION → assert → body) is enforced by the helper, not by convention. |

#### `tag_preview` (`tag-preview-job.ts`) and `tag_family_refs` (`tag-family-refs.ts`)
Already **A** end to end: read-only snapshot + `record_tag_preview` fenced `FOR UPDATE`
(`tag-preview-job.ts:119-302`); `record_tag_family_reference_for_job` fenced per family
(`tag-family-refs.ts:123-137`), preceded by a fenced `updateProgress` (`:94`). Only change: the
centralised `withTagWriteTx` fence runs for the preview store step too (harmless, same row lock
the definer takes anyway).

### 3.4 Enqueues and notifications from handlers

| Site | Mechanism | Class | Fence |
|------|-----------|-------|-------|
| `job-handlers.ts:1099-1146` (scan pass), `2027`, `2092`, `2216`, `2414`; `repair.ts:197`; `family-enrichment.ts:271` | `enqueueJob` → `withTransaction` → `insertJobOn` | B | one change inside `enqueueJob` (§4.4) |
| `repair.ts:78` (`beginTagRepair` inside replaceTaxonomy / consistency) | `insertJobOn` on the tag txn client | B | covered by the central `withTagWriteTx` fence |
| successor rows in `terminalizeAndReschedule` | fenced txn | A | — |
| Web Push `sendWebPush` | `job-handlers.ts:773` | C | `await assertClaimHeld('push')` immediately before each send (next to the budget `checkpoint()` at `:771`) |

### 3.5 External requests (all **C** — checkpoint immediately before; residual = the one in-flight call)

| Provider | Call site | Existing pre-call fenced write? | Checkpoint to add |
|----------|-----------|--------------------------------|-------------------|
| eBird barchart export | `barchart.ts:845` and the 5xx retry `:859` | none (`shouldStop` at `:813/:854` is budget/drain/pause only) | `runFrequencyJob`'s `shouldStop` (`job-handlers.ts:221-227`) calls `assertClaimHeld()` first; `barchart.ts:884` catch rethrows stale first (it otherwise writes `recordFailedAttempt` and classifies the stale error as a unit failure) |
| eBird notable | `job-handlers.ts:706` | none | `assertClaimHeld()` before |
| eBird CAS login + life-list CSV | `ebird-account.ts:780, 787` | heartbeat `hb()` after login (`:784`) is fenced | `assertClaimHeld()` before `casLogin` (`:780`) |
| eBird hotspot info + owner checklist pages (resolver) | `lifer-locations.ts:215, 268` | per-loc/per-subId fenced heartbeats (`:188-195, :248-255`), optional | per ruling Q3: `assertClaimHeld()` before each dispatch; multi-leg redirect boundary documented in §3.3 |
| eBird taxonomy | `job-handlers.ts:2598` (`syncTaxonomy` → `ebird.ts:708`) | `updateProgress` at `:420` precedes `fn()` ✓ | none extra (single request) |
| Wikidata SPARQL | `job-handlers.ts:1444, 1459` | `claimChunk` progress at `:1319` ✓ (first request) | `assertClaimHeld()` before `:1459` (second request); the soft catch at `:1470` rethrows stale first |
| Wikipedia article | `job-handlers.ts:1948` | — | per-unit checkpoint in the harness (§4.5) |
| Anthropic (enrichment) | `job-handlers.ts:1622` and retries `:1644` | — | `assertClaimHeld()` inside `annotate()` before `meteredAiCall` (covers every retry) |
| Wikidata media + Commons + xeno-canto | `species-enrichment.ts:2518, 2523, 2555` | — | per-unit checkpoint; plus `assertClaimHeld()` before each of the three inside `enrichSpeciesMedia`; the xeno-canto soft catch at `:2556-2558` (keeps `xcOk=false` and continues) must rethrow stale first because the assert for `:2555` sits inside its `try` |
| iNaturalist | `job-handlers.ts:2362, 2372` | — | per-unit checkpoint; plus before `:2372` (second request) |
| Animal Diversity Web / Wikipedia / Wikidata (family sources) | `family-source-discovery.ts:79` (ADW), `:111` (Wikidata candidates), `:130` (each article) | `checkpoint()` → `shouldStop` → `stop()` → fenced `updateProgress` (`family-enrichment.ts:360`) before each (`:78, 110, 129`) ✓ | none extra; **both** catches — `:94-103` (top-level ADW) and `:185-190` (nested `lookup()`) — must rethrow `isStaleClaim` before recording `transport_failure` (G5; CODEX1 finding 2) |
| Anthropic (family generate / verify) | `family-enrichment.ts:450, 467` | `stop()` at `:444, 465` precede them ✓ | none extra |
| Anthropic (tag draft) | `tag-draft-job.ts:229` | `recordClaimedEvent` only, then reads | `assertClaimHeld()` before each loop iteration's call (`:219`) |
| Wikipedia family lead | `tag-family-refs.ts:108` | fenced `updateProgress` `:94` ✓ | none |
| Web Push | `job-handlers.ts:773` | — | §3.4 |
| Google | none reachable from a handler (grep of `src/lib/server` for Google calls finds only `/api/geocode` request paths) | — | — |

### 3.6 Catch blocks: full re-sweep of every module reachable from a handler

Rule (§4.6): the first statement of every `catch` that can observe a `StaleClaimError` is
`if (isStaleClaim(err)) throw err;`, or the catch carries a `// stale-safe: <reason>`
annotation that the discovery test accepts. The table lists the sweep result; the test, not
this table, is the enforcement.

| File:line | Today | Required |
|-----------|-------|----------|
| `job-handlers.ts:250-253`, `273-275` | `catch {}` swallows (G2) | rethrow (needs a binding) |
| `job-handlers.ts:439`, `518`, `1224`, `1475`, `1653`, `1740`, `1812`, `1978`, `1991`, `2185`, `2386` | classify/write before any rethrow | rethrow first |
| `job-handlers.ts:604-606` (withBudget) | passes through unless the budget also expired | rethrow before the abort check |
| `job-handlers.ts:851-865` | records `unit_failed`, continues (G3) | rethrow first |
| `job-handlers.ts:1470-1474` (sci-name fallback) | swallows everything | rethrow first |
| `job-handlers.ts:2613-2625` | boundary; already handles stale | — (annotate `stale-safe: boundary`) |
| `tag-jobs.ts:103`, `:336` | fenced transitions follow | rethrow first (uniformity; skips classification) |
| `family-enrichment.ts:559` | failure writes + feature pause (G5) | rethrow first |
| `family-source-discovery.ts:94`, **`:185`** | record `transport_failure`, continue — the nested `lookup()` runs `checkpoint()` at `:110/:129` *inside* this try, so a stale throw is swallowed and the next candidate is fetched (**CODEX1 finding 2**) | rethrow first at **both** |
| `family-enrichment-ai.ts:203` | wraps parse errors; no assert inside its try | annotate `stale-safe: parse only` |
| `barchart.ts:846`, `:884` | `:846` retries 5xx only (rethrows others ✓); `:884` writes `recordFailedAttempt` | `:884` rethrow first |
| `species-enrichment.ts:769` | `enrichOneNow` (no claim) | annotate `stale-safe: no claim path` |
| `species-enrichment.ts:2556` | xeno-canto soft path swallows non-rate-limit errors | rethrow first (assert placed inside the try, §3.5) |
| `ebird-account.ts:190, 237, 249, 371, 788` | wrap transport errors; no assert inside those tries | annotate |
| `ebird-account.ts:842`, `:850` | business writes | rethrow first |
| `lifer-locations.ts:90, 113, 224` | all rethrow non-eBird errors ✓ (verified) | annotate `stale-safe: rethrows non-eBird` |
| `ebird.ts:136, 164, 216, 303, 325, 417, 677` | `:325` turns *any* fetcher error into a stale-cache fallback — safe only because **no assert is placed inside `cachedFetch`** (the handler asserts before calling `notableNearbyObs`); the others wrap transport/schema errors | annotate; add a comment at `:325` that an assert must never be placed inside `cachedFetchUncoalesced` |
| `gallery.ts:115, 126` | not reachable from a handler (`galleryHealth`, `refreshGalleryIfStale`) | annotate |
| `tag-engine/consistency.ts:269`, `:285` | `:269` records a failed run; `:285` best-effort | `:269` rethrow first; `:285` annotate |
| `tag-engine/activation.ts:300`, `:331` | rethrow non-dry-run / non-rollback ✓ | annotate |
| `tag-engine/runtime.ts:108`, `:120` | `:108` records a **materialization failure** for any non-`TagTxRollback` error → change to `if (err instanceof TagTxRollback \|\| isStaleClaim(err)) throw err;`; `:120` best-effort | `:108` rethrow; `:120` annotate |
| `tag-draft-job.ts:247`, `:269`, `:326` | `:247` rethrows unless drain-aborted ✓; `:269` rethrows non-`RulesetError` ✓; `:326` fenced `failJob` follows | `:326` rethrow first; others annotate |
| `tag-eval-jobs.ts:138`, `:305` | `:138` payload parse; `:305` fenced `failJob` follows | `:305` rethrow first; `:138` annotate |
| `tag-preview-job.ts:98, 287, 295, 308` | already stale-aware | annotate / — |
| `tag-family-refs.ts:109`, `:141` | `:109` wraps the fetch; `:141` already rethrows | annotate / — |
| `ai-call.ts:93` | rethrows ✓ (receipt first — ruling Q2) | annotate `stale-safe: receipt then rethrow` |

Modules with no catch: `taxonomy-sync.ts`, `tag-engine/repair.ts`, `materialize.ts`,
`eval-sample.ts` (verified by grep).

---

## 4. Mechanism design

### 4.1 Events: a commit-time fence, not a snapshot fence (CODEX1 finding 1)

`recordClaimedEvent`'s `INSERT … SELECT … WHERE EXISTS(...)` (`jobs.ts:159-165`) evaluates
the EXISTS against the statement's snapshot; the INSERT itself takes only `FOR KEY SHARE` on
the parent `jobs` row (FK, `0015_job_queue.sql:39`), which does **not** conflict with a
transition's `FOR NO KEY UPDATE`. A transition can therefore commit between the EXISTS
evaluation and the INSERT's commit, and the event lands on a row that already left `running`.

**Fix — one statement with a locking CTE:**

```sql
WITH j AS (
  SELECT id FROM jobs
   WHERE id = $1 AND status = 'running' AND claim_seq = $3
   FOR SHARE
)
INSERT INTO job_events (job_id, action, details)
SELECT $1, $2, $4 FROM j
```

`FOR SHARE` on the qualifying row blocks a concurrent `FOR NO KEY UPDATE` (transition,
progress, cancel flag, re-claim) until this statement commits; if such an UPDATE committed
first, READ COMMITTED re-evaluates the row's new version against the WHERE (EvalPlanQual) and
the CTE yields 0 rows → no INSERT → `StaleClaimError`. Either order is now correct.

- `recordEvent(jobId, action, details)` keeps its signature: under `currentClaim(jobId)` it
  runs the CTE above and throws `StaleClaimError(jobId, action)` on `rowCount === 0`;
  otherwise today's plain INSERT. All 46 handler call sites become fenced with no edits.
- `recordClaimedEvent` has the same (snapshot) shape and gets the same fix by becoming
  `recordEvent(jobId, 'claimed', details)` — kept as a one-line alias so the four B5 call
  sites need no edit.
- New `recordQueueEvent(jobId, action, details)` = today's unfenced INSERT, used only by the
  15 internal `jobs.ts` calls (§3.1): the 11 post-transition events are gated by the CAS that
  just won and the row is no longer `running`; `requestCancel`/`reclaimStartupJobs` run with no
  claim. Export it (jobs-db tests may use it); handlers never do (the discovery test in §4.6
  also greps for `recordQueueEvent(` outside `jobs.ts`).
- Not in scope: folding each post-transition event into its transition statement via a
  writable CTE (would close the pre-existing "CAS committed, event lost on crash" gap). Note as
  a follow-up; do not bundle.

**Event race tests (§6.3):** (i) transition tries to overtake — open a txn that holds the row
`FOR NO KEY UPDATE` via a transition started but not committed? Not possible with the
autocommit transition, so model it the other way: hold `FOR SHARE` from a test connection
(simulating the event statement mid-flight), start `requeueInterrupted` on a second
connection, assert it is still pending after 200 ms, release, assert it then completes and
that a *subsequent* fenced `recordEvent` under the old claim throws; (ii) the reverse — commit
the transition first, then run the fenced `recordEvent` under the old claim: 0 rows, throw,
`job_events` unchanged. Both with owned `CLAIMTEST` rows.

### 4.2 Checkpoint before non-transactional effects: `assertClaimHeld()`

```ts
/** The claim this execution holds (any job), or null outside a handler. */
export function heldClaim(): JobClaim | null

/** Throw StaleClaimError unless the held claim is still the live running claim. No-op without a claim. */
export async function assertClaimHeld(where = 'checkpoint'): Promise<void>
// SELECT 1 FROM jobs WHERE id=$1 AND status='running' AND claim_seq=$2   (PK lookup, no lock)
```

- Reads the AsyncLocalStorage store directly (no `jobId` parameter) so library modules
  (`barchart.ts`, `species-enrichment.ts`, `lifer-locations.ts`) can call it before a provider
  request without knowing which job they serve. §3z's "a store for a *different* job →
  unfenced" rule is about *queue* APIs targeting a job id; for a business effect the
  authorisation is simply "this execution holds a live claim".
- Residual race: the claim can die between the SELECT and the network dispatch. Bound: one
  request per checkpoint (one multi-leg owner-page dispatch in the resolver, §3.3).
- Cost: one indexed PK read per external request/unit — negligible against any network call.
- Deliberately a SELECT, not `updateProgress`: it must not change progress/heartbeat semantics
  or be mistaken for a unit boundary. It is allowed inside a fenced transaction (it takes no
  lock and uses the pool only for a read).

### 4.3 Same-transaction fencing with an enforced no-self-deadlock scope (CODEX1 finding 3)

```ts
/** Inside an open transaction on `client`: lock the job row FOR SHARE and verify the held claim. No-op without a claim.
 *  Issues NO SET LOCAL of any kind — it runs inside transactions whose caps are already set
 *  (withTagWriteTx 20 s/30 s, runtime.ts:89-91) and a later SET LOCAL would overwrite them. */
export async function assertClaimHeldTx(client, where?: string): Promise<void>
// SELECT 1 FROM jobs WHERE id=$1 AND status='running' AND claim_seq=$2 FOR SHARE
// 0 rows → StaleClaimError; SQLSTATE 40001 (REPEATABLE READ callers) → StaleClaimError

/** Opens its OWN transaction: BEGIN → SET LOCAL transaction_timeout = '120s' (the holder cap lives here and only here)
 *  → optional SET TRANSACTION → assertClaimHeldTx FIRST, with the fenced-tx scope flag set for fn's lifetime. */
export async function withClaimTx<T>(fn: (client) => Promise<T>, opts?: { isolation?: 'REPEATABLE READ'; where?: string }): Promise<T>
```

**Why `FOR SHARE`:** the check and the business write then commit atomically. Every
transition and `updateProgress` is an `UPDATE jobs` taking `FOR NO KEY UPDATE`, which
**conflicts** with `FOR SHARE` — a requeue/cancel/complete of that row blocks until our
transaction commits or rolls back; it cannot interleave between the check and the commit.
`FOR KEY SHARE` would not block those UPDATEs (rejected); a lock-free `EXISTS` is only a
statement-time snapshot (rejected — the same defect as §4.1).

**Where the assert lives — three owners, no ad-hoc calls:**
1. `withClaimTx` (all `withTransaction` writers in §3.3 convert to it; the assert is its first
   statement after the optional `SET TRANSACTION`).
2. `withTagWriteTx` (`runtime.ts:76-107`): after the fail-key lock (`:98`) and before
   `begin_tag_attempt` (`:99`), i.e. engine lock → fail-key lock → **jobs row FOR SHARE** →
   rows. One place fences every tag transaction (repair, consistency, stage, activate, retire,
   rollback, replaceTaxonomy, upsertWikiOk, markWikiNoArticle, preview store). `:108` lets
   `isStaleClaim` through without recording a materialization failure.
3. `createEvalSet` (`eval-sample.ts:103-175`) converts to `withClaimTx(fn, { isolation:
   'REPEATABLE READ' })` (CODEX1 finding 4) — the helper issues `SET TRANSACTION` first, then
   the assert, then the body.

The discovery test (§4.6) fails on any `assertClaimHeldTx(` call outside these three.

**The self-deadlock invariant, enforced:** while a transaction holds the job row `FOR SHARE`,
a pool-level `UPDATE jobs` on the same row from this execution (`updateProgress`, any
`transition()`, `terminalizeAndReschedule`, `setJobLabel`) would wait for our commit while our
code waits for it — Postgres cannot see that cycle. Mechanism:

- A second AsyncLocalStorage `claimTxContext` holding `{ jobId, where }` is entered by
  `withClaimTx`/`withTagWriteTx` for the callback's lifetime (and only when a claim is held).
- `updateProgress`, `transition`, `terminalizeAndReschedule` and `setJobLabel` check it
  **synchronously before any SQL**: if `claimTxContext.getStore()?.jobId === jobId` they throw
  `ClaimTxMisuseError` (a programmer error, distinct from `StaleClaimError`; `runJob`'s
  boundary lets it reach `failJob` normally once the transaction has rolled back — the throw
  propagates out of the callback, `withTransaction` rolls back and releases the lock, and only
  then does the boundary catch run `failJob`, which is no longer inside the scope).
- `enqueueJob` inside a fenced transaction is allowed: its own assert takes `FOR SHARE` on a
  second connection (share-compatible) and inserts a *new* row.
- `assertClaimHeld()` (read-only) is allowed inside.
- Verified today's callbacks already comply: `stageRevision.onProgress` between steps
  (`activation.ts:213`); repair `shouldStop` between batches (`repair.ts:137`); family
  `stop()`/`finish()` outside its transactions (`family-enrichment.ts:341-357, 507-551`);
  need-alert progress writes outside `queryTimed` statements.
- **Negative test (§6.3):** `withClaimTx(async () => updateProgress(id, …))` under a claim
  rejects with `ClaimTxMisuseError` in well under 100 ms, the transaction is rolled back, the
  row is unchanged — never a hang.

**Holder caps (who may hold the job row FOR SHARE, and for how long):**

| Holder | Cap | Where the cap is set |
|--------|-----|----------------------|
| `withClaimTx` transactions (business writers, `createEvalSet`, `enqueueJob`) | **120 s** | `withClaimTx` itself, right after `BEGIN` (it owns the transaction) |
| `withTagWriteTx` shared / exclusive | 20 s / 30 s | `runtime.ts:91` (`transaction_timeout`), already present; **`assertClaimHeldTx` never issues a `SET LOCAL`** so these are preserved (CODEX1 rev-2 finding 2 — the most recent `SET LOCAL` wins, and rev 2 would have overwritten them with 120 s) |
| `retryFamilyGaps` (admin) — `LOCK TABLE jobs IN SHARE ROW EXCLUSIVE` (`family-enrichment.ts:98-151`) blocks every `UPDATE jobs` for its duration and is the one **uncapped** code-path blocker of a transition | add `SET LOCAL transaction_timeout = '30s'` as its first statement (one line; required for the bound below to be a proof, not a hope) | `family-enrichment.ts:99` |
| single-statement lockers (`claimNextJob`, other transitions, `requestCancel`) | one statement | — |

A `transaction_timeout` expiry terminates the holder's *session*; the pool discards that
client (`db.ts` `guardCheckout`), the lock is released at abort. So every code-path holder
releases within **H = 120 s** of taking the lock. Verification test (§6.3): `SHOW
transaction_timeout` inside `withTagWriteTx('shared')` → `20s`, `('exclusive')` → `30s`, inside
`withClaimTx` → `2min`, and inside a tag transaction *after* the central assert still `20s`/`30s`.

**Competing queue writers (`transition()`, `updateProgress()`, `setJobLabel`, the
`terminalizeAndReschedule` UPDATE, `reclaimStartupJobs`):** each attempt runs the single CAS
UPDATE inside a micro-transaction with `SET LOCAL lock_timeout = '15s'` (a `SET LOCAL` on the
*holder* does nothing for the other pooled connection; a pool-wide `lock_timeout` in the `pg`
client config would govern every web query — rejected). On SQLSTATE `55P03` the attempt is
retried **immediately** (the wait is the lock wait, no backoff) until a total deadline
**D = H + 30 s margin = 150 s** measured from the first attempt (≤ 10 attempts; worst-case
overrun one attempt, ≤ 165 s). Because every code-path holder is bounded by H and no new
holder of *this* row can appear while the writer waits (a stale execution's assert finds no
qualifying row and takes no lock; the live claim's own fenced transactions are excluded by the
misuse guard), **acquisition before D is guaranteed by Postgres terminating the holder** — this
is option (a) from the rev-2 review, with D derived from the caps that actually apply. Both
constants are injectable for tests (`{ lockTimeoutMs, deadlineMs }` on an internal options
object; production values fixed).

What each caller sees:
- `updateProgress` from a per-unit callback that already tolerates telemetry failures
  (`job-handlers.ts:250`, after the stale-rethrow line): unchanged policy — but note the retry
  loop means such a call can now take up to D before failing; that is the price of the bound
  and only occurs under a holder that is itself about to be killed.
- Transitions never throw `55P03` before D. Past D they throw `QueueWriteUnrecoverableError`
  (not `StaleClaimError`, not retried further).

**`runJob` contract: it never returns while its row is `running` with no recovery path.**
Today the loop continues after `runJob` (`worker/index.ts:218-233`), `reclaimStartupJobs`
runs only at startup (`:83`) and `claimNextJob` takes `pending` rows only (`jobs.ts:273-274`),
so a row left `running` by a returned `runJob` is stuck for as long as the worker stays
healthy (CODEX1 rev-2 finding 1; rev 2's "logs and returns" was wrong and is withdrawn).
Design:
1. Every terminal path a handler takes is a transition with the retry-to-D above, so under the
   bound the row always leaves `running` (or the claim is proven stale, in which case the row
   is no longer ours and needs nothing from us).
2. `dispatchJob`'s boundary (`job-handlers.ts:2613-2625`) keeps today's shape: stale → return;
   otherwise `failJob` (itself retry-to-D); a non-stale error from that `failJob` — now only
   `QueueWriteUnrecoverableError` — is **rethrown**, exactly as the code already does at
   `:2622`. It propagates through `runJob` to the worker's unguarded `await runJob`
   (`worker/index.ts:218`) and `main().catch` exits the process with code 1 (`:254-257`).
   PM2 restarts the worker; startup `reclaimStartupJobs` (`:83`) converts the row (it is a
   queue writer with the same retry-to-D; if even it cannot acquire, startup fails and PM2
   restarts again, and `/api/health` reports `worker` unhealthy because `markWorkerStarted`
   never runs — operator-visible). This is the last-resort (b): it is the only path that can
   resolve a row this process provably cannot write, it is reached only when a lock outlived
   every code-path cap (i.e. a holder outside this codebase, such as an operator's session),
   and it is bounded by that external holder's release, which no in-process design can beat.
   Make it explicit in code: a `[birds-worker] FATAL: queue row <id> could not be written for
   <D> s — restarting for startup reclaim` line before the throw, and a `worker_status_history`
   note written best-effort.
3. Tests (§6.3): the scaled contention test (holder 1.2 s, per-attempt 300 ms, D 2 s) proves
   retry-through-the-holder's-full-bound; a real-time test holds `FOR SHARE` from a test
   connection for 70 s with production attempt/deadline values and proves `completeJob`
   resolves at ~70 s with the row `succeeded` (test timeout 100 s, justified by the contract
   under test, not a blind raise); the escalation test drives `runJob` with a transition stub
   that throws `QueueWriteUnrecoverableError` from `failJob` and asserts `runJob` **rejects**
   (never resolves) — the worker-level `process.exit(1)` is existing behaviour at `index.ts:254-257`
   and is asserted by reading that path, not by exiting the test runner.

**Lock-order analysis (no new deadlock):**

| Path | Locks it holds, in order | Can it wait on a jobs row held FOR SHARE? | Does it hold something our txn wants? |
|------|--------------------------|--------------------------------------------|----------------------------------------|
| `transition()`, `updateProgress()`, `setJobLabel`, `reclaimStartupJobs` | one `UPDATE jobs` per attempt inside a `SET LOCAL lock_timeout='15s'` micro-txn, retried to D = 150 s | yes, ≤ D (holder killed at ≤ 120 s) | no — nothing else held |
| `requestCancel`, `claimNextJob` | one `UPDATE jobs` | `requestCancel` waits ≤ H (web request; give it the same 15 s `lock_timeout` micro-txn and surface 'try again' on `55P03` — one line, same helper); `claimNextJob` uses SKIP LOCKED | no |
| `terminalizeAndReschedule` | txn: `SET LOCAL lock_timeout='15s'` → UPDATE jobs → INSERT job_events → INSERT jobs; the whole txn retried to D on `55P03` (nothing durable before the UPDATE) | yes, ≤ D | no (never takes engine or business locks) |
| `withTagWriteTx` callers (ours) | engine xact lock → fail-key lock → **jobs row FOR SHARE** → rows | n/a | the engine lock — nothing that holds a jobs row lock ever waits for the engine lock → no cycle |
| `retryFamilyGaps` (admin) | `SET LOCAL transaction_timeout='30s'` (new) → `LOCK TABLE jobs IN SHARE ROW EXCLUSIVE` → `family_enrichment … FOR UPDATE` | SRE does **not** conflict with ROW SHARE (what FOR SHARE takes on the table), so it never waits on us; we may wait on its family row; it never waits for us → no cycle. Its SRE **does** block every `UPDATE jobs` (ROW EXCLUSIVE) — hence the cap. | — |
| family publish txn (ours) | jobs row FOR SHARE → `LOCK TABLE taxonomy_cache IN SHARE MODE` → family row | `replaceTaxonomy` holds engine lock → taxonomy_cache ROW EXCLUSIVE and never a jobs row of *our* job → no cycle | — |
| `beginTagRepair`/`insertJobOn` inside a tag txn | engine lock → INSERT jobs (new row) | an INSERT never waits on a FOR SHARE of a different row | — |
| `createEvalSet` (REPEATABLE READ) | jobs row FOR SHARE → reads → definer writes | a transition committed after the snapshot → `40001` at the assert → `StaleClaimError` (never a successful set) | — |

**Lock duration:** FOR SHARE is held until COMMIT, so a web `requestCancel` or a competing
queue writer waits for the enclosing transaction: milliseconds for per-species writers, seconds
for `storeFrequencies` (a large region), ≤ `TX_CAP` inside tag transactions, ≤ H = 120 s worst
case (then the holder's session is terminated). Ruling Q4: assert **first** in the initial implementation; measure the region-store
cancel delay on prod-sized data; if material, the fallback is a lock-free precheck at the
start plus the locked assert immediately before COMMIT (test both interleavings). The locked
check is never dropped.

**No-claim behaviour:** every helper returns immediately when `heldClaim()` is null, so
`enrichOneNow` (page action, `species-enrichment.ts:740-780`), admin tag actions
(`tag-admin.ts:733`), `retryFamilyGaps`, the taxonomy admin path and every existing test keep
today's statements and locks exactly.

### 4.4 Enqueues: fence inside `enqueueJob`

`enqueueJob` (`jobs.ts:213-236`) already runs one `withTransaction`; make it `withClaimTx`
(assert first when a claim is held). One change covers every handler enqueue (§3.4).
Worker-loop reconciliation (`ensureNeedAlertScan`, `ensureEnrichmentScan`,
`ensureTagConsistency`, `ensureFamilyEnrichment` from `worker/index.ts`) runs outside any
claim → unchanged. `terminalizeAndReschedule` already fences its successor. `insertJobOn` on a
tag txn client is covered by the central `withTagWriteTx` fence.

### 4.5 Where the checkpoints go (handler shapes)

| Shape | Checkpoint placement |
|-------|---------------------|
| Chunk harness `runChunkLifecycle` (`job-handlers.ts:1359-1414`) | `await assertClaimHeld('unit')` immediately before `opts.runUnit(codes[i])` (`:1383`). Per-request asserts inside units for the 2nd+ request (§3.5). |
| Frequency `shouldStop` (`:221-227`) | first line `await assertClaimHeld('fetch')` → throws through `ensureFrequencies` (`barchart.ts:813` is outside the try; `:854` is inside → the catch rethrow at `:884` is mandatory). |
| Need-alert `processUser` | before `notableNearbyObs` (`:706`) and before each `sendWebPush` (`:773`). |
| Sync jobs | before `casLogin` (`ebird-account.ts:780`); resolver dispatches (`lifer-locations.ts:215, 268`); taxonomy needs none extra. |
| Family | the existing `stop()` calls are fenced progress writes before every provider stage ✓; add nothing except the catch rethrows (both discovery catches) and the `withClaimTx` wrappers. |
| Tag draft | before each `meteredAiCall` iteration (`tag-draft-job.ts:219`). |

### 4.6 Catch rule, enforced by a catch-discovering test (CODEX1 finding 2)

Not a hand-enumerated list. A vitest file walks `src/lib/server` (reuse `walk`/`isTestFile`
from `tag-guard.test.ts:19-33`, excluding tests and `*.test-helper.ts`), and for every
`catch (<id>) {` / `catch {` occurrence requires one of:
- the first non-comment statement is `if (isStaleClaim(<id>)) throw <id>;` (regex over the
  block head, tolerant of whitespace), or
- the `catch` line carries `// stale-safe: <reason>` (a binding-less `catch {}` **must** be
  annotated, since it cannot rethrow).

Self-test cases: a bare `catch {}` without annotation fails; `catch (e) { foo(); if
(isStaleClaim(e)) throw e; }` fails (rethrow not first); the annotated and compliant shapes
pass. The same file also asserts that `assertClaimHeldTx(` appears only in
`job-claim.ts`/`runtime.ts` (§4.3 owners) and `recordQueueEvent(` only in `jobs.ts`.

Cost: every catch under `src/lib/server` is audited once (the §3.6 table is the audit for the
handler-reachable modules; route-only modules get annotations). This is the price of discovery
rather than enumeration, and it is a one-time cost.

Behavioural companion (CODEX1 finding 2): a test that stales the claim exactly at the nested
discovery checkpoint (`family-source-discovery.ts:129`, injected `shouldStop` throwing
`StaleClaimError` on the second call) and asserts no further `deps.article` call, no
`transport_failure` diagnostic, and that `runFamilyEnrichment` performs no failure write.

### 4.7 Module placement (recommended, mechanical)

Move the claim machinery (`JobClaim`, `claimContext`, `claimTxContext`, `runWithClaim`,
`currentClaim`, `heldClaim`, `StaleClaimError`, `ClaimTxMisuseError`, `QueueWriteUnrecoverableError`,
`isStaleClaim`, `assertClaimHeld`, `assertClaimHeldTx`, `withClaimTx`) into
`src/lib/server/job-claim.ts` (imports only `$lib/db`) and re-export from `jobs.ts`. Reason:
`barchart.ts`, `species-enrichment.ts`, `lifer-locations.ts`, `family-source-discovery.ts`,
`eval-sample.ts` and `tag-engine/runtime.ts` must call the helpers; a tiny module keeps every
`vi.mock('$server/jobs')` factory small (§5 item 6). If the implementer keeps everything in
`jobs.ts`, every such factory must add the new exports or the handlers throw `TypeError`.

### 4.8 `ebird_cache` freshness-ordering guard (CODEX1 finding 6, G9)

`cachedFetchUncoalesced` (`ebird.ts:288-345`) captures `const startedAt = new Date()`
immediately before `await fetcher()` (`:317`) and changes the upsert to:

```sql
INSERT INTO ebird_cache (cache_key, payload, fetched_at) VALUES ($1, $2, NOW())
ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = NOW()
WHERE ebird_cache.fetched_at < $3        -- $3 = startedAt
```

A fetch that started before a newer row was stored never overwrites it (stale worker
continuation *or* a slow web request racing a fresh one); a normal refresh (stored row older
than this fetch's start) still writes. The function's return value is unaffected (it returns
the data it fetched, as today). Chosen over a claim fence because the overwrite race is not
claim-specific — the same cache is written by web requests with no claim at all — and the
guard is one `WHERE` clause with no new dependency. Test (§6.3): two overlapping fetches on an
owned `JOBTEST:` cache key; the one that started first completes last and must not overwrite.
The in-flight coalescing map (`:275-281`) is per process and does not cover cross-process or
cross-request ordering, which is why the SQL guard is needed.

---

## 5. Call-site changes, grouped by pattern

1. **`job-claim.ts` / `jobs.ts`** — locking-CTE `recordEvent`; `recordQueueEvent` for the 15
   internal calls; `recordClaimedEvent` alias; `setJobLabel`; `enqueueJob` → `withClaimTx`;
   helpers + `claimTxContext` guard in `updateProgress`/`transition`/`terminalizeAndReschedule`/
   `setJobLabel`; `SET LOCAL lock_timeout='15s'` micro-transactions retried to the 150 s
   deadline for every queue writer incl. `reclaimStartupJobs` and `requestCancel`;
   `QueueWriteUnrecoverableError` past the deadline; `withClaimTx` sets
   `transaction_timeout='120s'` (and only it does). `family-enrichment.ts:99`: one
   `SET LOCAL transaction_timeout='30s'` in `retryFamilyGaps` (the sole uncapped jobs-table
   locker). `job-handlers.ts:2613-2625`: keep the rethrow; add the FATAL log line before it.
2. **`withTransaction` → `withClaimTx`** (no-op without a claim): `barchart.ts:516`;
   `ebird-account.ts:636`; `gallery.ts:90`; `species-enrichment.ts:118, 398, 1335, 1728, 1892,
   1949, 2287, 2379`; `family-enrichment.ts:285, 507 (assert before the table lock), 595`;
   `eval-sample.ts:103` with `{ isolation: 'REPEATABLE READ' }`.
3. **`withTagWriteTx`** (`runtime.ts:98-99`): central assert + `claimTxContext`; `:108-109`
   stale passthrough. No per-callback edits in repair/consistency/activation/taxonomy-sync/
   species-enrichment tag writers.
4. **Autocommit writers wrapped in `withClaimTx`:** `barchart.ts:614`;
   `species-enrichment.ts:273, 483-548 (markAiError), 1346, 2421`; `job-handlers.ts:1726`;
   `family-enrichment.ts:259-263 (nudge), 424, 439, 460, 474-498 (one txn), 562-570 (one txn),
   641`; `ebird-account.ts:819, 838, 844, 852`; `tag-jobs.ts:239-248`;
   `tag-eval-jobs.ts:50-62`; `tag-draft-job.ts:203, 319`; `consistency.ts:40-60`.
   `family-enrichment.ts:413` → `setJobLabel`.
5. **Pre-request checkpoints** per §4.5 / §3.5 (incl. `lifer-locations.ts:215, 268`,
   `species-enrichment.ts:2518, 2523, 2555`).
6. **Catch rethrows / annotations** per §3.6 and the discovery test (§4.6).
7. **`ebird.ts:317-323`** freshness guard (§4.8).
8. **Handler-test mocks**: `job-handlers.test.ts:76-94` (`vi.mock('$server/jobs')`) and the
   other suites that mock `$server/jobs` (`job-handlers-tag-draft.test.ts`,
   `tag-draft-job.test.ts`, `tag-eval-jobs.test.ts` — confirm with grep) gain pass-throughs
   (`assertClaimHeld: async () => {}`, `withClaimTx: (fn) => fn(fakeClient)`, `setJobLabel`),
   plus a controllable `assertClaimHeld` for the §6.3 checkpoint tests.

No signature of any handler or public writer changes (except `withClaimTx` replacing
`withTransaction` internally); no route changes; no Help/About change (internal, no
user-visible behaviour — state this explicitly in the hand-off per
`docs/agent-development-guide.md` §5 Documentation).

---

## 6. Test plan

### 6.1 Ground rules (shared `birds_test`)
- `npm run test:env && npm run test:db:up` first; the local worker must be stopped
  (`agent-development-guide.md` §3 rule 9).
- Fixtures own their rows: label `CLAIMTEST <run>` or `JOBTEST %`; claim with the test's own
  UPDATE (`jobs-claim-db.test.ts:48-57`) or `claimAnyJob({ jobIds: [id] })`; reclaim only with
  `reclaimAnyStartupJobs(note, { jobIds: [id] })`; **never** an unscoped
  `claimNextJob`/`reclaimStartupJobs` (td-d425c1).
- Never seed real provider credentials; every provider call is mocked or injected
  (`ensureFrequencies.fetcher`, `familyDependencies`, `resolveLiferLocations.fetcher/ownerFetcher`).
- Business tables touched by stale-claim tests use owned fixture ids/codes; check FK
  constraints before inventing codes (e.g. `species_enrichment.species_code` → prefer the
  engine fixture helper `tag-engine/engine-fixture.test-helper.ts` for tag tables); delete by
  exact id in `afterAll`/`finally`; snapshot before/after counts of every table touched.

### 6.2 The stale-claim simulation primitives (reuse `jobs-claim-db.test.ts`)
```
A = claim(id)                                              // claim_seq 1
runWithClaim(A, () => requeueInterrupted(id, A.attempts))  // drain: refund → pending
B = claim(id)                                              // same attempts, claim_seq 2
runWithClaim(A, () => <effect>)   → StaleClaimError; no row/event/enqueue/call
runWithClaim(B, () => <effect>)   → succeeds
```
**Lost-lock-session producer (§1.1 item 2):** `A = claim(id)`; then, *without* any transition
by A, `reclaimAnyStartupJobs('lost session', { jobIds: [id] })` (what the new worker does at
`jobs.ts:626-666`), then `B = claim(id)`; A's continuation runs `runWithClaim(A, …)`. This is
the exact database sequence of that producer; the advisory-lock loss itself is infrastructure
and is not simulated. Also the "pending, no B yet" and "terminal" variants
(`jobs-claim-db.test.ts:148-165`).

### 6.3 Per class and per race
| Test | What it proves | Layer |
|------|----------------|-------|
| A events | under A every `recordEvent` action throws and `job_events` is unchanged; under B it lands; no claim → plain insert; `recordQueueEvent` inserts on a non-running row | `jobs-claim-db.test.ts` |
| **Event race, both orders** (§4.1) | (i) a `FOR SHARE` held by connection 1 on the running row makes `requeueInterrupted` on connection 2 wait (pending after 200 ms, completes after release); after it, A's `recordEvent` throws; (ii) transition commits first, then A's fenced `recordEvent` → 0 rows, throw, no event | DB, two clients |
| B writers | for each writer in §5(2)/(4): under A → `StaleClaimError`, target table unchanged; under B → written; no claim → written. At least: `storeFrequencies`, `recordFailedAttempt`, `markWikiError`, `upsertAiProseData`, `markAiError`, `upsertMediaOk`, `upsertInatSimilar`, family failure txn + control pause (must **not** pause the feature under A), `enqueueJob`, `record_tag_report` via `withClaimTx`, `setJobLabel`, the family nudge, one `withTagWriteTx` callback (repair batch on an engine fixture) | real-DB tests beside each module's `*-db.test.ts` |
| **Eval-create A/B** (finding 4) | `createEvalSet` on an engine fixture: under A → `StaleClaimError`, no `tag_eval_set` row; under B → set created; plus the REPEATABLE READ race: start B's `createEvalSet` (deferred inside `buildFrame` via an injected hook), commit a transition on another connection, resume → `40001` → `StaleClaimError`, no set | DB |
| **COMMIT ordering** | holder: `withClaimTx` writes a business row and is parked before COMMIT (deferred promise); writer: `completeJob` on connection 2 is pending; release → the business row is committed **and then** the transition proceeds (row `succeeded`); the business row exists | DB, two clients |
| **Transition-wins ordering** | writer: `requeueInterrupted` commits first; then the (now stale) holder runs `withClaimTx` → the assert's `FOR SHARE` finds 0 qualifying rows → throw → no business row, transaction rolled back | DB |
| **ROLLBACK release** | holder rolls back; the pending writer proceeds; A's later write throws | DB |
| **Self-deadlock guard** (finding 3) | `withClaimTx(() => updateProgress(id, …))` and `withTagWriteTx` callback calling `completeJob` → `ClaimTxMisuseError` in < 100 ms, rolled back, row unchanged | DB |
| **Transaction caps preserved** (finding 2) | `SHOW transaction_timeout` inside `withTagWriteTx('shared')` → `20s`, `('exclusive')` → `30s` (both read *after* the central assert ran), inside `withClaimTx` → `2min`, inside `withClaimTx({ isolation: 'REPEATABLE READ' })` → `2min` with `SHOW transaction_isolation` → `repeatable read` | DB |
| **Retry through the holder's full bound** (scaled) | injectable `{ lockTimeoutMs: 300, deadlineMs: 2000 }`; holder `FOR SHARE` on connection 1 for 1.2 s; `completeJob` on connection 2 makes ≥ 3 attempts (observed via `pg_stat_activity`/an attempt counter) and resolves after the release with the row `succeeded`; never throws | DB, two clients |
| **> 70 s contention, production constants** (finding 1) | holder `FOR SHARE` for 70 s; `completeJob` with the real 15 s / 150 s values resolves at ≈ 70 s, row `succeeded`; test timeout 100 s (justified: it is the bound under test) | DB, two clients |
| **Deadline exhausted** (scaled) | holder outlives `deadlineMs` (test connection without a cap): `completeJob` rejects with `QueueWriteUnrecoverableError` after ≈ D; row still `running`; then release and show a subsequent `reclaimAnyStartupJobs({ jobIds })` converts it | DB |
| **`runJob` never returns with a stuck row** | `runJob` with mocked queue writers where `failJob` throws `QueueWriteUnrecoverableError`: `runJob` **rejects** (not resolves), the FATAL line is logged; with `failJob` throwing `StaleClaimError` it resolves (today's `:2622-2624`) | mocked `$server/jobs` |
| **Holder killed at its cap** (scaled) | `withClaimTx` with an injectable cap of 1 s parked past it: Postgres terminates the session (`57P01`/`25P03`-class error surfaces from the pool), the waiting writer acquires immediately after; nothing committed from the holder | DB |
| C checkpoints | handler-level with mocked providers: stale the claim **between** units/sends (mock `assertClaimHeld` flips to throwing after N calls, or the real DB primitive) and assert the provider mock is called at most once more (the residual) and no further; the `ai_usage` row for the straddling call *is* written | `job-handlers.test.ts` + one real-DB journey per handler shape |
| **Straddling send** (ruling Q1) | need-alert scan: the claim is staled while `sendWebPush` (mock) is in flight; the push resolves; `need_alerts_sent` + `need_alert_log` **are** written (one statement), the next `sendWebPush` is **not** attempted, `unit_ok` is refused | mocked push + real DB |
| **Nested discovery checkpoint** (finding 2) | §4.6 behavioural companion | `family-enrichment.test.ts` style with injected deps |
| **Resolver dispatch fence** (ruling Q3) | `resolveLiferLocations` with injected fetchers: stale at the 2nd loc → no hotspot fetch, no owner fetch, no `lifer_loc_*` row for it | DB + injected fetchers |
| **ebird_cache ordering** (§4.8) | two `cachedFetch` calls on an owned key with injected fetchers: the earlier-started one resolves last → stored payload is the later fetch's; a plain refresh still overwrites | DB |
| Catch discovery | the §4.6 scan + self-test; frequency `onUnit` with `updateProgress` rejecting `StaleClaimError` aborts the load (extend the `["claimed","unit_ok",…]` sequence tests in `job-handlers.test.ts`) | unit |
| No-claim parity | `npm test` green; explicit: `enrichOneNow` and `retryFamilyGaps` write without a claim | existing |
| Worker drain journey | real DB: `JOBTEST` frequency job with an injected fetcher that drains mid-batch; `runJob` requeues; scoped re-claim; the first execution's late continuation (deferred promise in the fetcher) → no `frequency_fetch` row for the late unit, no `unit_*` event from A | `jobs-db.test.ts` style |

### 6.4 Gates
`npx vitest run <changed files>` during iteration; then `npm test` (cross-cutting
worker/queue change), `npm run check`, `npm run build`, `git diff --check`. Confirm the DB
suites actually ran. Report before/after counts for `jobs`, `job_events`, `ebird_cache` and
each business table the tests touched; confirm zero fixture residue.

---

## 7. Risks and open questions (with reviewer rulings)

Rulings below are **CODEX1's (2026-10-09); the owner has not been asked.**

**Q1 — `need_alerts_sent`/`need_alert_log` after a delivered push — ruled:** keep both rows
together, unfenced **only after a confirmed delivered push**, as a truthful
suppression/history record; document as a narrow exception (§1.3 item 2) and test the
straddling-send race (§6.3).

**Q2 — `ai_usage` receipts — ruled:** never fence a receipt for a call already made.

**Q3 — lifer-location resolver — ruled:** add a cheap claim SELECT before each hotspot and
owner-page dispatch (`lifer-locations.ts:215, 268`); the fenced heartbeats at `:188-195` and
`:248-255` do not cover multi-leg fetches/redirects; boundary documented in §3.3.

**Q4 — lock hold time in `storeFrequencies` — ruled:** locked assert first in the initial
implementation; measure the region-store cancel delay on prod-sized data; if material, the
fallback is a lock-free precheck plus the locked assert immediately before COMMIT, testing
both interleavings; never drop the locked final check.

**R1 — Legitimately-late events:** a slow `unit_*` event after a budget yield today still
lands; after this change it throws and the handler stops — every such path already returns
right after the transition, so only orphan events disappear.

**R2 — Tag transaction budgets:** the central assert adds one statement inside the
`runtime.ts:89-91` caps; re-measure the repair-batch lock gate (`repair.ts:22-27`, 1 s) once.

**R3 — Mock drift:** every `vi.mock('$server/jobs')` factory must grow the new exports; a
missed one fails loudly (`TypeError`).

**R4 — (closed in rev 3)** Queue writers now retry to a deadline derived from the holder caps,
so a row cannot be left `running` by a returned `runJob`; the only remaining escalation is the
process exit + startup reclaim for a lock held by something outside this codebase (§4.3).
An in-worker heartbeat-staleness reclaim remains a separate ticket and is no longer load-bearing.

**R7 — Added one-line cap to `retryFamilyGaps`** (`family-enrichment.ts:99`): an admin retry
that holds the jobs table lock for more than 30 s is aborted. Today that transaction only
snapshots and re-pends rows (ms), so no behaviour change in practice; stated so the reviewer
sees it is deliberate scope.

**R5 — One-time catch audit cost** (§4.6): every catch under `src/lib/server` needs the rethrow
or an annotation.

**R6 — Scope creep temptation:** the "CAS committed, event lost" CTE merge, re-signing
`freeze_tag_authoring_set`/`record_tag_report` with claim parameters (§3cc Phase 2), a
`jobs_assert_claim` SQL function, and an in-worker staleness reclaim are adjacent; none is
required. Do not bundle.

---

## 8. Recommended phasing (one ticket, two reviewable commits)

**Phase A — fence what the DB can fence (no provider-path changes):** §4.1 locking-CTE events
+ `recordQueueEvent`; helpers, `claimTxContext` guard, lock timeouts (§4.2/4.3/4.7);
`enqueueJob`; central `withTagWriteTx` fence + stale passthrough; all §5(2)/(4) writers incl.
`createEvalSet`; `setJobLabel`; `ebird_cache` guard (§4.8); catch rethrows/annotations + the
discovery test; tests §6.3 rows A, event race, B writers, eval-create, COMMIT/transition-wins/
ROLLBACK orderings, self-deadlock guard, lock-timeout path, ebird_cache ordering, catch
discovery, no-claim parity. After Phase A, a stale execution can still *dispatch* provider
requests/pushes until its next write, but can no longer **commit** anything outside the §1.3
exceptions.

**Phase B — pre-request checkpoints:** §4.5/§3.5 call sites incl. the resolver and media
provider asserts; controllable `assertClaimHeld` in the handler suites; tests §6.3 rows C,
straddling send, nested discovery checkpoint, resolver dispatch fence, drain journey.

Both phases: `npm test`, `check`, `build`, `git diff --check`; hand off through `td review`;
CODEX1 hostile review at high effort (plan gate for item 4).

---

## 9. Guardrails — what NOT to do

- Do **not** fence the 11 post-transition `recordEvent` calls in `jobs.ts` on `status='running'`
  — they are legitimately written after the row left `running`. Use `recordQueueEvent`.
- Do **not** use a snapshot-only `EXISTS` for any fence (event or transaction); do **not** use
  `FOR KEY SHARE`. Both leave the check-then-commit race (finding 1).
- Do **not** call `assertClaimHeldTx` outside `withClaimTx`/`withTagWriteTx`; do **not** await
  `updateProgress`/any transition/`setJobLabel` inside a fenced transaction — the guard throws
  `ClaimTxMisuseError` by design.
- Do **not** set `lock_timeout` pool-wide in the `pg` client config (it would govern every web
  query); use the scoped `SET LOCAL` micro-transactions.
- Do **not** issue any `SET LOCAL` inside `assertClaimHeldTx` — it runs inside transactions
  whose caps are already set (`runtime.ts:89-91`) and the most recent `SET LOCAL` wins.
- Do **not** let `runJob` resolve while its row is `running` under its own claim: transitions
  retry to the 150 s deadline, and past it the error must propagate (worker exit → startup
  reclaim), never be logged-and-swallowed.
- Do **not** retry a `40001` from the eval-create assert into a successful set.
- Do **not** change `attempts` semantics, `retryDelayMs`, yield/drain refunds, or cancel
  linearization (`jobs.ts:311-317`) — settled (§3z: "`attempts` is unchanged").
- Do **not** fence `ai_usage` receipts or the post-delivery `need_alerts_sent`/`need_alert_log`
  statement; do **not** convert at-least-once push semantics into at-most-once (CODEX1 plan #3
  at `job-handlers.ts:643-650`).
- Do **not** place an `assertClaimHeld` inside `cachedFetchUncoalesced` (`ebird.ts:325` would
  swallow it into a stale-cache fallback); assert in the handler before the call.
- Do **not** add a SQL migration; the TS helpers and the `ebird_cache` `WHERE` need none.
- Do **not** run `test:db:reset`, claim/reclaim unscoped jobs, or touch non-fixture rows on
  `birds_test`; do not run the local worker during the DB tests.
- Do **not** touch `AGENTS.md`; no Help/About edits (internal change) — say so in the hand-off.
- Do **not** commit, push or deploy without an explicit instruction.

---

## 10. Review log

**Rev 1 (2026-10-09, Claude):** initial spec — inventory, EXISTS-style event fence, `FOR SHARE`
transaction fence, enqueue fence, per-request checkpoints, hand-listed catch table, two-phase
plan, four open questions.

**Rev 2 (2026-10-09, after CODEX1 design review — verdict "revise before code"):**
1. P1 event fence → locking CTE (`FOR SHARE` inside the INSERT), both-order race tests;
   `recordClaimedEvent` inherits the fix as an alias (§4.1). Verified: `job_events.job_id` FK at
   `0015_job_queue.sql:39` takes only KEY SHARE.
2. P1 missed swallow → `family-source-discovery.ts:185-190` added (nested `lookup()` with
   `checkpoint()` at `:110/:129` inside its try), rethrow at both `:94` and `:185`; full catch
   re-sweep of every reachable module (§3.6, 22 files); enforcement moved to a
   catch-discovering test with `// stale-safe:` annotations (§4.6); behavioural test at the
   nested checkpoint.
3. P2 self-deadlock → `claimTxContext` scope entered by `withClaimTx`/`withTagWriteTx`;
   queue writers throw `ClaimTxMisuseError` synchronously on same-job misuse; negative test;
   finite bounds on both sides (`SET LOCAL transaction_timeout` on the holder, `SET LOCAL
   lock_timeout` micro-transactions + bounded retry on the writers, `55P03` →
   `QueueLockTimeoutError`, consequences spelled out incl. the stuck-row residual R4) (§4.3).
4. P2 eval-create → `assertClaimHeldTx` as the first data statement inside `createEvalSet`'s
   REPEATABLE READ transaction (`eval-sample.ts:103-104`) via `withClaimTx({ isolation })`;
   `40001` → `StaleClaimError`; A/B + RR race tests (§3.3, §6.3). Verified the transaction shape.
5. P2 race proofs → COMMIT ordering, transition-wins, ROLLBACK release, event race, and the
   lost-lock-session producer simulated with the scoped `reclaimStartupJobs` (§6.2, §6.3).
6. P3 D exceptions → §1.3 lists the five exceptions explicitly and Phase A's claim is scoped to
   them; `ebird_cache` upsert (`ebird.ts:318-323`, verified unconditional) gets a
   freshness-ordering `WHERE` with a test (§4.8); the family nudge reclassified as a cadence
   mutation and fenced via `withClaimTx` (§3.2).
   Rulings Q1–Q4 recorded as CODEX1's (owner not yet asked) (§7); Q3 adds asserts at
   `lifer-locations.ts:215, 268` with the multi-leg boundary documented (§3.3).

**Rev 3 (2026-10-09, after CODEX1's rev-2 review — both P1s closed, two P2 blockers):**
1. P2 stuck-row blocker → verified: `reclaimStartupJobs` only at `worker/index.ts:83`, the loop
   resumes at `:218-233`, `claimNextJob` takes `pending` only (`jobs.ts:273-274`), and the
   boundary at `job-handlers.ts:2619-2624` *rethrows* non-stale `failJob` errors (so rev 2's
   "logs and returns" contradicted the code — today that path crashes the worker via
   `index.ts:254-257`). Design now: option (a) — every queue writer retries its 15 s
   `lock_timeout` attempts to a deadline D = H + 30 s = 150 s, where H = 120 s is the largest
   holder cap (`withClaimTx`); acquisition is guaranteed by `transaction_timeout` killing any
   code-path holder; `retryFamilyGaps` gets a 30 s cap so it stops being the one uncapped
   jobs-table locker. Past D: `QueueWriteUnrecoverableError` propagates (keeping the existing
   rethrow) → worker exit → startup reclaim, as the explicit last resort (b) for a lock held
   outside the codebase. `runJob` contract stated; tests for scaled and real > 70 s contention,
   deadline exhaustion, caps-kill-holder, and `runJob` rejecting (§4.3, §6.3). R4 closed.
2. P2 `SET LOCAL` overwrite → verified `runtime.ts:91` sets `transaction_timeout` before the
   callback and a later `SET LOCAL` wins. `assertClaimHeldTx` now issues no `SET LOCAL`; the
   120 s cap is set only by `withClaimTx` on the transaction it opens; `SHOW
   transaction_timeout` tests in both tag modes and in `withClaimTx` (plain and REPEATABLE
   READ). Bound in #1 recomputed from the caps that actually apply (120 / 30 / 20 / 30 s).

### Rev 3.1 (CC1, 2026-10-09) — CODEX1 rev-3 confirmation
- Exit-and-PM2-restart last resort: accepted (external lock holder only). retryFamilyGaps 30 s cap: accepted; **test cap expiry rolls back the retry work**, not only `SHOW` values.
- P2 fixed here (supersedes §5's "no route changes" for this one path): `requestCancel` runs its UPDATE in the bounded 15 s `lock_timeout` micro-transaction; `src/routes/api/jobs/[id]/cancel/+server.ts` maps `55P03` / `QueueLockTimeoutError` to **503** with a stable body `{ error: 'job_busy', message: 'That job is finishing a step — try cancelling again in a few seconds.' }`; the cancel client (`src/lib/job-poll.svelte.ts` ~176-183) shows that message inline (accessible `role="status"`/`aria-live`) on a non-OK response or network error while polling continues. Route test (503 mapping) + client test (message shown, polling preserved).
- With this, CODEX1: "Phase A is clear."

## Implementation notes (Phase A)

Implemented 2026-10-09 (CC, uncommitted for review). Phase B (pre-request `assertClaimHeld()`
checkpoints, §3.5/§4.5, incl. the Q3 resolver asserts) is NOT in this change; no Phase A item
needed one. Deviations and additions, each with its reason:

1. **`claimFencedQuery(text, params)`** (job-claim.ts) for the §5(4) single autocommit writers:
   no claim → exactly `query()` (today's statement, and the suites that mock `$lib/db` with only
   `query` keep working); under a claim → that statement in its own `withClaimTx`. Multi-statement
   groups (family audit-rejected / insufficient-source) use one `withClaimTx`. `withClaimTx`
   without a claim is `withTransaction` (plus the requested isolation) — used only where the spec
   converts an existing `withTransaction`.
2. **Test bounds** are AsyncLocalStorage-scoped (`withClaimBoundsForTest`), not a mutable options
   object: `{ lockTimeoutMs, deadlineMs, claimTxTimeoutMs, jobsTableLockTxTimeoutMs, onLockTimeout }`;
   production values are the frozen `CLAIM_BOUNDS` (15 s / 150 s / 120 s / 30 s).
3. **`requestCancel`**'s single bounded attempt throws `QueueLockTimeoutError`; the route maps it
   (or a raw `55P03`) to 503 `job_busy` with `retry-after: 5`. The hub shows the message in an
   always-mounted `role="status"` region (`jobsPoll.cancelNotice`), cleared by the next cancel or
   once that job is no longer outstanding; polling continues. No Help/About change: an error
   line, not a workflow change.
4. **Escalation**: a `QueueWriteUnrecoverableError` thrown by the handler's own terminal write
   skips the boundary `failJob` (it would only wait out another deadline) and escalates
   directly: FATAL line + best-effort `recordWorkerHistoryNote` + rethrow. Same for one thrown by
   the boundary `failJob`.
5. **Eval-create RR race test**: once the assert is the first data statement, a transition that
   starts *after* B's snapshot waits on B's `FOR SHARE` instead of committing, so the "commit a
   transition during `buildFrame`" shape cannot occur. The test models the reachable race: the
   transition holds the row uncommitted when B's assert runs, then commits → 40001 → mapped to
   `StaleClaimError`, no set (40001 confirmed in the test cluster's log).
6. **Gate report**: `record_tag_report('gate')` is written by `eval-sample.ts recordGateReport`,
   not `tag-eval-jobs.ts:50-62` (simulation only); both are fenced.
7. **Writer tests**: the "one `withTagWriteTx` callback" row is covered at the runtime level (a
   stale claim never runs the callback and records no materialization failure; the live claim
   runs it) rather than a full repair-batch engine fixture — the fence is in `withTagWriteTx`
   itself, which every repair batch goes through. `record_tag_report` via the generic
   `claimFencedQuery` is covered by the lost-session test (no FK-valid revision fixture needed).
8. `ebird.ts` exports `__cachedFetchUncoalescedForTests` (the coalescing map would otherwise merge
   the two overlapping fetches the §4.8 test races).
9. `markXError(...).catch(() => {})` in the job-handlers unit catches is unchanged: a refused
   mark is followed by the unit's fenced `unit_failed` event, which throws.
10. `tag-engine/rules.ts` is left byte-identical: its bytes are pinned by PREVIEW_SOURCE_HASH (any
    edit needs a migration re-pinning `tag_preview_design`) and by ENGINE_SOURCE_HASH (a new
    `scanner_rev` re-materializes every species). Its one binding-less parse-only catch is listed
    by exact line in the discovery test's PINNED table instead of an inline annotation.
11. Follow-ups not bundled (R6): the "CAS committed, event lost" CTE merge; prod measurement of the
    region-store cancel delay (ruling Q4).

### CODEX1 Phase A review (REVISE) — outcomes

1. **P1 — tag failure record outside the fence (confirmed, fixed).** `withTagWriteTx` rolls back
   (releasing its FOR SHARE) before `record_materialization_failure`, and a lock-phase error
   (engine / fail-key lock) arrives before the central assert ran. Under a claim the record is
   now its own `withClaimTx` (assert first, then the definer on the same client); a stale claim
   records nothing and the call rejects with `StaleClaimError`. Without a claim it is today's
   autocommit statement; the token rule (post if allocated, else pre) is unchanged. Tests
   (`claim-writers-db.test.ts`): (a) failure after the fence + re-claim waiting on the FOR SHARE
   → no row, StaleClaimError; (b) fail-key lock wait cancelled before the fence under a stale
   claim → no row, StaleClaimError; (c) no-claim failure records with the post-attempt token.
   (a) and (b) fail against the unfenced record (mutation check run).
2. **P2 — queue-writer duration not capped (confirmed, fixed).** Each `boundedQueueWrite`
   micro-transaction now also sets `SET LOCAL transaction_timeout = 30s` (`queueTxTimeoutMs`); a
   25P04 kill rolls back like a 55P03 and is retried to the deadline. Bound math: every
   code-path holder of a job row is capped ≤ H = 120 s (withClaimTx 120, tag 20/30,
   retryFamilyGaps 30, queue writer 30), D = 150 s unchanged. `reclaimStartupJobs` now reclaims
   per row in id order (candidate SELECT, then one bounded single-row conditional UPDATE each,
   same CASE logic and events), so it never holds an early row while waiting on a later one.
   Tests (`jobs-claim-db.test.ts`): per-row reclaim commits r1 (and a cancel of r1 proceeds at
   once) while r2 is still held; `SHOW` inside a queue write gives 30s / 15s; a micro-transaction
   that outlives a scaled 300 ms cap is killed, commits nothing, and is retried successfully.
3. **P3 — 70 s test in the default suite (fixed).** Gated by `BIRDS_SLOW_BOUND_TESTS=1`:
   `BIRDS_SLOW_BOUND_TESTS=1 npx vitest run --mode test src/lib/server/jobs-claim-db.test.ts -t "production bounds"`.
   Run once with the flag on 2026-10-09: passed (70.4 s). The scaled contention tests stay in
   the default suite.
