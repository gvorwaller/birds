# td-c2f2b2 — Durable coordinates for every downloaded hotspot

**Status:** plan, revision 2 (2026-10-12): CODEX1 hostile review of rev 1 folded in (revise before implementation:
3 P1 + 4 P2, all accepted; dispositions at the end). Owner endorsed storing every listed hotspot (2026-10-11). Owner go
required before implementation and again before deploy.

## Problem (measured on prod, read-only, 2026-10-11/12)
eBird returns latitude/longitude for every hotspot (`ref/hotspot/{region}`, `ref/hotspot/geo`,
`ref/hotspot/info/{locId}`). The app fetches them but never keeps them for downloaded hotspots:
- The hotspot sweep (`hotspot-sweep.ts`, `load_hotspots`) fetches the region's full list **with coordinates** and uses
  only `locId` to queue loads.
- Those lists live only in `ebird_cache` (`hotspots:` / `hotspotsRegion:`), which `pruneEbirdCache` (`jobs.ts:845`)
  deletes after **48 hours**.
- The durable table `ebird_locations` (loc_id PK, loc_name, lat, lng NOT NULL + Google place columns) is written only
  by observation feeds (`hydrateEbirdLocationPlaceIds` → `upsertEbirdLocations`) and lifer-location resolution
  (`lifer-locations.ts`, hotspot info).

| Of 7,428 downloaded hotspots (disjoint, prod 2026-10-12) | Count |
|---|---|
| durable coordinates (`ebird_locations`) | 1,669 (22%) |
| no durable row, coordinates only in a list cached in the last 48 h | 4,879 |
| no coordinates anywhere | 880 |

(Rev 1 printed 5,665 for the middle row: that was every cache-covered hotspot, overlapping the durable row.) Missing
durable coordinates fall across 63 of the 65 distinct hotspot `frequency_fetch.region_code` values (1,467 hotspot rows
under a subnational1 code, 5,961 under subnational2; none NULL).

**Who is blind:**
- Field Guide map/radius place — `guide-location.ts` `mapCoverage` joins `ebird_locations` only: always sees ~22% of
  downloaded hotspots (it already counts the rest as "missing").
- Hotspots & data map/radius — `hub-discovery.ts` takes coordinates from cached lists, then `ebird_locations` for
  loaded hotspots (`:339-352`): near-complete right after a list fetch, back to ~22% within 48 h. Intermittent.
- td-a54f8c (Home "nearest downloaded hotspot is N km away") needs this.

## Goal
Every downloaded hotspot that eBird still knows gets **official** durable coordinates during the job that loads it
(sweep, map pick, refresh or retry), existing rows are upgraded to official coordinates by a bounded repair, eBird
moves are followed, and Admin shows the count of any that lack them. No reader changes are needed for the two map
searches: both already fall back to `ebird_locations`.

## Design

### C0. Coordinate provenance on `ebird_locations` (CODEX1 P1-1)
`updated_at` is touched by observation upserts (`location-placeids.ts:80-87`) and by Google results (`:235-248`), so
it cannot order coordinate writes. Migration 0084 adds:
- `coord_source text` — `'official'` (eBird hotspot list or hotspot info) or `'observation'` (observation feeds,
  lifer resolution fallback); existing rows backfilled `'observation'`.
- `coord_fetched_at timestamptz` — when the *source request started* (existing rows: their `updated_at`).

Precedence, enforced in SQL by **every** coordinate writer (one shared `upsertLocationCoordinates(rows, source,
startedAt, run)` helper; the observation upsert and the two lifer/info inserts are rewritten onto it):
- `official` replaces `observation` always; `official` replaces `official` only when `startedAt > coord_fetched_at`.
- `observation` writes coordinates only when the row is absent or still `observation` (and newer); an observation
  never overwrites an official coordinate (it may still refresh `last_seen_at`).
- Name follows the same rule as coordinates. `google_place_*` are never touched by this helper.
- Unchanged values are not rewritten (`IS DISTINCT FROM`), so a daily re-fetch of a 4,000-hotspot list rewrites
  nothing; `updated_at` keeps its existing meaning (any row change) and is never used for ordering.
- Valid rows only: `^L[0-9]+$` for official, finite lat in [-90, 90], lng in [-180, 180]; chunks of ≤2,000 rows.

### C1. Store every listed official hotspot where it arrives (owner-endorsed scope)
Every **live** fetch (not a cache hit, not a stale fallback) of `hotspotsInRegion`, `hotspotsNear` and official
hotspot info passes its rows to the helper as `official` with the request's start time. ~112,600 distinct listed
hotspots today → `ebird_locations` grows from 6,898 rows/3.1 MB to roughly 15–25 MB. Not identity evidence:
`hub-discovery.ts:9-17,287-293` uses the row for coordinates only (CODEX1 confirmed). No Google Places cost: lookups
run only for loc ids a page passes to `hydrateEbirdLocationPlaceIds`, capped (`location-placeids.ts:264-327`; CODEX1
confirmed).

**Claim safety (CODEX1 P1-2):** the cache helpers take an explicit `remember` option instead of writing implicitly:
- Web/request paths (`remember: 'plain'`): after the cache row is stored, write coordinates with a plain query;
  an ordinary DB failure is logged and swallowed (the response is still returned).
- Worker paths under a claim (`remember: 'caller'`): the fetch helper writes nothing; it returns the rows plus
  `live: true` and the start time, and the **caller** writes them with `withClaimTx` (assert-held first, atomic with
  the write). `StaleClaimError` is never inside `cachedFetch`'s stale-fallback catch and always propagates. A plain
  write is never used while `heldClaim()` is set — the helper asserts this (ClaimTxMisuse-style guard).
- Official info (`hotspot-page.ts:177-183` web path → plain; `lifer-locations.ts:216` runs under the lifelist claim →
  fenced) follows the same split.

### C2. During every load (CODEX1 P1-3)
At the single frequency store site (`barchart.ts:876`, after `storeFrequencies` succeeds for a `hotspot`), if the
hotspot has no `official` coordinate:
1. The sweep path already wrote the region list's coordinates (caller-written, fenced, before queuing loads), so
   this normally finds nothing to do.
2. Otherwise (map pick, `refresh_loc`, `retry_loc`): one official hotspot-info request with the job's own
   requester key, paced like the load's other eBird calls, written fenced. 404 → a miss row (C4). A failed lookup
   never fails the load; it leaves the gap to the repair.
Objective: a hotspot loaded after this ships has official coordinates when its load finishes, or a recorded miss.

### C3. Bounded repair for existing rows (CODEX1 P2-4, P2-5)
`repair_hotspot_coords` — a **one-shot, cancellable** job (not in `RECURRING_TYPES`), enqueued by an ensure step at
worker start and on the idle tick **only when** gaps exist, no repair job is outstanding, and the last finished
repair is older than 24 h. Cancelling it stops it until the next daily check; Admin says so ("runs again
tomorrow"). Gap = a downloaded hotspot with no row, or a row whose `coord_source` is not `official`, and no live miss.
1. From cached `hotspots:`/`hotspotsRegion:`/`hotspotInfo:` payloads (zero eBird calls), using each cache row's
   `fetched_at` as `startedAt`.
2. One `hotspotsInRegion` per remaining `region_code` (≤65 calls on the first prod run).
3. Official info per remaining hotspot, ≤200 per run; 404 → miss.
All writes fenced (`withClaimTx`), units reported, cancellable between units.
**Credential:** the job is enqueued for the first admin (by id) whose stored eBird key decrypts and is non-empty; the
key is read at run time via `getEbirdApiKey(job.requested_by)`, never put in the payload. No such admin → no job;
Admin shows "needs an admin eBird key". A 401/403 mid-run stops the job (no misses recorded) and the next daily check
re-selects the credential.

### C4. Misses and visible integrity
- `hotspot_coord_misses(loc_code PK REFERENCES frequency_fetch ON DELETE CASCADE, reason text, checked_at)`;
  re-tried after 30 days; deleted when an official coordinate arrives.
- Admin → existing data status area: "Downloaded hotspots without eBird coordinates: N" (0 normally), last repair
  time/outcome, credential state, and the miss list (name, code, reason) — owner-readable, no CLI.
- `mapCoverage` keeps its existing "missing" count.

### C5. Migration 0084 (CODEX1 P2-7)
`SET LOCAL lock_timeout = '5s'` first. Adds the two `ebird_locations` columns (nullable, no rewrite; backfill
`UPDATE` of 6.9 k rows) and the misses table, and swaps `jobs_type_check` to add `repair_hotspot_coords` (same
pattern as 0082:26-33). A lock timeout aborts the whole transaction (nothing applied) and `deploy-to-DO.sh` stops
before the PM2 reload; retry the deploy. Measure the lock waits and runtime on `birds_test` first, with the worker
running a load.

## Tests (own `zz`/fixture ids, exact cleanup, shared `birds_test` etiquette)
- C0: precedence matrix (official/observation × newer/older × absent); observation never overwrites official;
  Google write between fetch start and store does not block an official write; unchanged rows untouched; Google
  columns preserved; invalid ids/coordinates skipped; 2,000-row chunking.
- C1: live list fetch stores; cache hit and stale fallback store nothing; plain-path DB failure swallowed; caller
  mode writes nothing itself; plain write under a held claim throws; **lost claim during the caller's write and
  during the info fallback propagates `StaleClaimError` and writes nothing**.
- C2: map-pick/refresh/retry load gets coordinates from info; sweep load needs no info call; 404 → miss; lookup
  failure leaves the load ok; lost claim mid-lookup stops the load.
- C3: cache stage makes zero eBird calls; region stage; info cap; credential selection (first admin with a key,
  none → no job + Admin state); 401 stops without misses; cancel → not recreated until the next daily check;
  idempotent second run no-op; ensure does nothing with no gaps.
- Readers: Field Guide map place and Hotspots & data map find a downloaded hotspot **after its list cache row is
  deleted** (the regression this ticket is about).
- Migration 0084 on `birds_test`; `jobs_type_check`; job policy/handler wiring tests.

## Rollout
1. `npm run check`, affected tests, full suite (known searchable-select failure only), CODEX1 code review, owner go.
2. Deploy per C5 (lock_timeout; on timeout nothing is applied and the deploy stops before reload — retry).
3. On prod after deploy: the first repair run; then read-only check — downloaded hotspots without coordinates → 0 or
   a named list of misses; Field Guide map near Sandnessjøen (50 km) now counts Søvik ferjekai, Salsvatnet,
   Leirfjord, Tjøtta, Hestøya, Stokkvågen, Lovund, Onøy ferge (8 downloaded).
4. Then td-a54f8c (P2) builds on it.

## As built (2026-10-12, td-c2f2b2)
- `src/lib/server/hotspot-coordinates.ts` — the one coordinate writer (`upsertLocationCoordinates`), the best-effort
  `rememberOfficialHotspots`, gaps, misses, cache copy. The observation upsert (`location-placeids.ts`) and the
  life-list hotspot lookup (`lifer-locations.ts`: info with `isHotspot: true` → official, else observation) now go
  through it; no other code writes `ebird_locations` coordinates.
- **Claim mode is chosen inside the writer** (`heldClaim()` → `claimFencedQuery`, else plain) instead of a
  `remember: 'plain' | 'caller'` option: same guarantee — fenced under any claim, `StaleClaimError` always propagates,
  and the write runs after `cachedFetch` returns (never inside its stale-fallback catch). `CachedResult.live` marks a
  live response; `hotspotsInRegion` / `hotspotsNear` store it; official info on the hotspot page stores it.
- Observation rows: no time ordering among themselves (last write wins, as before); `coord_fetched_at` is NULL for
  them (the 0084 CHECK pins official ⇔ non-NULL). A newer official answer always records its request time; the rest
  of the row (and `updated_at`) moves only when the values changed.
- `src/lib/server/hotspot-coordinate-repair.ts` — per-load lookup (`ensureLoadedHotspotCoordinates`, wired through
  `ensureFrequencies`' new `afterHotspotStore`, outside the unit try/catch, before `onUnit`), the repair run, the
  credential choice, Admin status. Dedicated pacer (2/s, burst 4, keeps the hourly reserve, ≤30 s wait).
- Scheduler: the worker idle tick, at most every 10 min; queues only when gaps exist, nothing is outstanding and no
  repair finished in 24 h. The cache stage orders each copied row by its cache row's `fetched_at`.
- Admin → Status tab → "Hotspot coordinates" card (count, last check, credential state, misses).
- Migration 0084 applied to `birds_test` in ~2.5 s end to end (script included). Not measured under a concurrent
  load (no local worker with eBird credentials); the 5 s `lock_timeout` bounds the risk.
- First prod run expectation: every downloaded hotspot is a gap (existing rows are `observation`), ~5.6 k fill from
  the cache, ≤65 region lists, ≤200 info lookups, the rest the next day.
- Tests: `hotspot-coordinates-db.test.ts` (18, real SQL: precedence matrix, claims, live/cache/stale list fetch,
  repair stages/misses/cap/cancel/401/upstream, Admin status, Field Guide map), `job-handlers.test.ts` (+7: load
  hook, repair handler, scheduler), `barchart.test.ts` (+1: hook order).

## CODEX1 review of rev 1 (2026-10-12): revise before implementation → dispositions
| Finding | Disposition |
|---|---|
| P1-1 Freshness guard used `updated_at`, which observation and Google writes also move; observation upserts could overwrite official coordinates; repair only filled absent rows | Accepted — C0 provenance columns + precedence in every writer; repair also upgrades non-official rows |
| P1-2 Implicit writes inside cachedFetch would run unfenced under a worker claim and swallow StaleClaimError | Accepted — C1 `remember: 'plain' \| 'caller'`; worker callers write via `withClaimTx`; guard against plain writes under a claim; lost-claim tests |
| P1-3 "Within minutes" goal not met for refresh/retry/map loads (daily repair only) | Accepted — C2 per-load info lookup at the single store site |
| P2-4 Recurring job credential undefined (lowest admin may have no key) | Accepted — C3 first admin with a usable key; no-key and 401 states |
| P2-5 Recurring + cancellable contradicts the queue contract | Accepted — C3 one-shot cancellable job, daily conditional ensure, truthful Admin text |
| P2-6 Coordinate buckets overlapped (sum 8,214 ≠ 7,428) | Accepted — recomputed disjoint on prod: 1,669 / 4,879 / 880 |
| P2-7 0084 constraint swap needs a bounded lock plan | Accepted — C5 lock_timeout, abort-and-retry, measured on birds_test under load |
| Scope: store all listed hotspots | Kept — CODEX1: coherent for sweep timing, not identity evidence, no Places sweep; owner endorsed |

## CODEX1 code review of 958b91e (2026-10-12): revise → dispositions
| Finding | Disposition |
|---|---|
| P1 Repair counted coordinates whose write had failed (best-effort writer swallowed DB errors) and could finish "complete" | Fixed — the repair fetches lists with `remember: false` and writes with the throwing writer; hotspot-info lookups write with it too; a DB error fails the run; only eBird/payload errors end it as `upstream` |
| P2 An identical newer answer left `coord_fetched_at` old, so a delayed different answer could win | Fixed — every newer official answer records its request time; values/`updated_at` move only on change; T10/T30/T20 test |
| P2 Scheduler only on idle ticks, not at startup | Fixed — worker startup and every loop pass (busy or idle), throttled to 10 min |
| P2 A stale cached region list hid a 401/403 | Fixed — stale list: 401/403 throws, 429 defers, other statuses end as `upstream` |
| P2 Admin miss list silently capped at 100; "without eBird coordinates" inaccurate | Fixed — total shown, "the first 100 by name"; wording says official coordinates, plus how many have none at all |
| P2 Info cap reported "complete" and waited 24 h | Fixed — outcome `capped`; capped, deferred and upstream runs are due again after 1 h (`recentHotspotCoordinateRepair`) |

