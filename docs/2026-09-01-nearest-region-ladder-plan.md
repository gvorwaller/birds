# Nearest reports by region ladder — replace the dying eBird endpoint

**Status:** IMPLEMENTED (2026-09-01), with two owner-directed changes after the
first build — recorded here because they replaced plan mandates:

1. **The two strategies RACE; there is no fast-path deadline.** rev 3 waited up
   to 25 s for the direct endpoint before starting the region search, then
   deferred a "remember what failed last time" memo to claw the time back. The
   owner rejected that as a workaround for a design that hadn't been thought
   through. Now the direct call gets a 3 s head start and, if it hasn't
   answered, the region search runs alongside it; first real answer wins.
   Deletes three tuned numbers (25 s / 10 s fast deadlines, the memo) and one
   whole deferred item. Measured: bkcchi **25.9 s → 4.0 s**, stbori unchanged
   at 3.5 s with zero probes, eurrob1 9.7 s → 3.8 s.
2. **Observation cache TTL 30 min → 3 hours** (`OBS_TTL_MIN`), owner's call: an
   area gets a handful of new checklists a day, so re-asking every half hour
   bought nothing. **Rare-bird feeds keep 30 min** (`NOTABLE_TTL_MIN`) — the
   alerts worker reads that same cache to decide whether to push "a rarity was
   just reported near you", and it refuses to notify from a stale row.

Original plan below (rev 3).

---

**Status:** rev 3 (2026-09-01). CODEX1 mechanics review folded (7 P1 / 4 P2);
GROK hostile review folded (5 P1 / 9 P2, verdict on rev 2: "do not implement as
written" — two of CODEX1's accepted fixes were themselves wrong and are
corrected here). Inline as *[CODEX1]* / *[GROK]*. **Awaiting owner go.**

## Context

The species page's "Nearest reports — any distance" section (and the `/nearest`
Nearest-lifers page, which auto-runs up to **6** species through an AWAITED
loader) depend on eBird's `/data/nearest/geo/recent/{sp}` endpoint, which has a
**structural** pathology, measured live 2026-09-01 from the owner's home:

| species from Jacksonville | character | result |
|---|---|---|
| Streak-backed Oriole | rare, Honduras-far | 200 in 3.6s |
| Gyrfalcon | rare, arctic-far | 200 in 0.4s |
| American Robin | common, mid-far | 200 in **23.4s** |
| Black-capped Chickadee | common, far | **500 at 60s, reproducible** |
| European Robin | common, Europe-far | **500 at 60s** |

Cost scales with species record volume × distance-to-nearest-report;
common-far grinds until eBird's own ~60s gateway kills it. Deterministic, not
an outage. The app compounds it: no request deadline anywhere, and nginx
(`deploy/nginx.conf:13`, 60s) cuts the streamed response before the error chunk
ships → infinite phone spinner. Root cause independently confirmed by CODEX1
blind review.

**Replacement primitive:** eBird's region species query
(`/data/obs/{region}/recent/{sp}`) is region-indexed and fast for exactly the
killing inputs — bkcchi in all of NY (2,071 rows) **0.45s**; European Robin in
all of GB (4,288 rows) **0.45s**; empty regions ~0.24s (GROK re-verified live:
0.49s). Driven by our `regions` table (td-a4a3bf) with verified boxes.

## Honesty contract (drives everything below)

The ladder searches OUR seeded coverage, not the globe: 3,621 rows (252
countries + 3,369 sub1); 301 eBird codes excluded for unusable geography; 11
antimeridian-unsafe boxes unsearchable. The claim is **"closest report found in
the regions we searched"** — never a global nearest, and *[GROK P1-4]* never a
**filled-disk radius**: `searched.boundKm` is a lower bound on the next
unsearched region, not a covered circle (coverage has holes: the 301, the 11,
failed rungs, the safety margin). Copy rules in Phase 2 enforce this.

## Phase 0 — the deadline tourniquet (recreated on main, NOT ff-merged)

*[CODEX1 P1-7, GROK P2-7 both CONFIRMED]* Branch `cc2-holding` (0398384) is
stale: 30s value, disproven outage narrative in comments, and a
signal-classification hole. Recreate on main; delete branch + stash after.

- **`ebirdFetch`-global default deadline 45s** — this intentionally covers ALL
  eBird calls (geo feeds, hotspot obs, alerts), not just nearest; *[GROK
  P2-7]* said and tested as such. Clears the 23.4s structural success ~2×,
  beats nginx's 60s.
- `EBIRD_TIMEOUT_MS` env override for tests — *[GROK]* NEW hook (nothing by
  that name exists on main today; rev 2's "stays" was wrong).
- *[CODEX1 P2-3]* Per-call deadlines are **internal policy** (`opts.deadlineMs`
  building `AbortSignal.timeout` inside the fetcher closure) so single-flight-
  coalesced callers share one policy; caller `opts.signal` only ever stops
  scheduling (the needs.ts:432-456 rule), never cancels a shared fetch.
- Timeout → 504-class EbirdError, distinct from "unreachable" and from caller
  cancellation. *[GROK P2-6]* 504 is for user-facing copy; ladder control flow
  treats timeout/5xx/unreachable identically.

Independently deployable if the rest waits.

## Phase 1 — the ladder engine

### `recentSpeciesInRegion` (inside `src/lib/server/ebird.ts` — cachedFetch/
ebirdFetch/OBS_TTL_MIN module-private, CONFIRMED)

Template `recentObs` (ebird.ts:229). Path
`/data/obs/{region}/recent/{sp}?back={b}&includeProvisional=true&maxResults=10000`:
- *[CODEX1 P2-2]* `includeProvisional=true` pinned (region endpoint defaults
  false; old endpoint passed it — dropping it silently changes which reports
  count).
- *[GROK P2-3]* `maxResults=10000` pinned; a rung returning exactly 10,000 rows
  is SATURATED → marked partial (`proven:false` if it matters) — eBird's row
  order is not distance order, so truncation can hide the closest report.
- Clamp `back` 1..30 before URL AND cache key. Key `spReg:{region}:{sp}:{b}`,
  `OBS_TTL_MIN` (30 min), existing single-flight.
- **Mandatory internal 8s probe deadline built in the wrapper** — *[GROK
  P2-1]* not inherited from the 45s global (a forgotten wiring there recreates
  the 640s-class bug: 3 hung probes × 45s = 135s > nginx).

### Candidate set — `allProximityRegions()` in `src/lib/server/regions.ts`

*[GROK P1-1, fix A]* **Unsafe-box regions are EXCLUDED from the ladder
entirely** (the 11: FJ, FJ-E/N, KI, NZ, NZ-NTL, RU, RU-CHU, UM, US, US-AK per
level rules), documented as unsearchable coverage exactly like the 301. Rev 2
had them at bound 0, which was doubly broken: the stop condition (`next bound >
5th-best`) could never fire while any remained, and on /nearest's 8-probe
budget Fiji+Alaska would consume the budget before Florida was probed. Their
rare-far species still have the fast path (Gyrfalcon 0.4s). Schema-NULL boxes
(zero today, allowed by 0047): sortKey = centroid haversine, pruneBound = 0
(never justifies stopping), unprobed → `proven:false`. **pruneBound is never
the sort key.**

*[GROK P1-2]* Incomplete-coverage countries: rev 2's derivation ("seeded sub1
also in excluded list") is the EMPTY SET — the generator deletes excluded codes
from the seed (`generate-regions.mjs:401-402`), so seeded ∩ excluded = ∅.
Correct rule: **countries with ≥1 seeded sub1 AND ≥1 child in
`backend/db/regions-excluded-codes.txt`** (rev 2's `scripts/` path was also
wrong → ENOENT → silent gap) — 24 countries today (HU with 22 excluded
counties, LV with 112, MD 29, …) get a country-level probe. Childless countries
(56, incl. KI-if-not-unsafe) come via the other union arm. Unit test pins HU
and LV in the set and pins the literal-intersection formula OUT.

Candidate set = safe sub1 ∪ safe childless countries ∪ the 24 incomplete-
coverage countries. Observations deduped across country/sub1 probes by the
EXISTING `obsKey` (observations.ts:10-13 — *[GROK P2-4]* reuse, don't fork),
**before the hit count feeds the stop condition** (else 5 copies of one obs via
a country probe stop the search while closer distinct places wait).

### Bound

```
ladderBoundKm(home, region):
  box present & safe → max(0, distanceToBoxKm(home, box) − BOUND_MARGIN_KM)
  box NULL (schema-possible, zero today) → pruneBound 0, sortKey centroid
```
`BOUND_MARGIN_KM = 25` hedges the unproven obs-within-region-box invariant
(obscured/sensitive coordinates); Phase 3's live audit gates ever reducing it.
Export `boxSupportsProximity` from geo.ts (*[GROK P3-3]* real work, currently
private).

### `src/lib/server/nearest-ladder.ts`

Lift `mapWithConcurrency` (needs.ts:291, one call site :436) into
`src/lib/server/concurrency.ts`.

```
nearestSpeciesReports(apiKey, sp, home, back, opts
    {fastDeadlineMs, probeBudget, ladderDeadlineMs, signal}):
  1. FAST PATH: nearestObsOfSpecies({deadlineMs: fastDeadlineMs}).
     Success → {rows, stale, via:'nearest'}.
     EbirdError classification gates fallback *[CODEX1 P1-4]*:
       401/403/429 → rethrow (no probe storm from an auth/quota error);
       timeout/5xx/unreachable → ladder.
     *[GROK P2-6]* Breakers apply only to errors that ESCAPE cachedFetch —
     a stale-row fallback (stale:true, no throw) is cs.md-correct and is
     treated as success.
  2. LADDER: candidates sorted by sortKey ascending; waves of 3, whole wave
     awaited before the stop check (max 2 wasted probes, never a wrong
     result); final wave truncated to remaining budget.
     STOP *[CODEX1 P1-1]*: distinct hits ≥ 5 AND next pruneBound > 5th-best
     distance. (<5 → continue to budget/deadline/exhaustion.)
     BREAKERS: 401/403/429 from any rung → abort ladder; 3 CONSECUTIVE
     timeout/5xx rungs → abort; ladderDeadlineMs checked between waves
     (in-flight 8s probes may overshoot it — documented, bounded).
     *[CODEX1 P2-4 + GROK P3-5]* failedRegions[] recorded; proven:false iff a
     failed/unprobed candidate's pruneBound < 5th-best (or < ∞ when rows<5) —
     the hedge copy says "some CLOSER regions couldn't be checked", scoped, not
     a blanket disclaimer about Fiji.
  3. → { rows: raw EbirdObs[] top-5 by haversine *[CODEX1 P2-1 — callers
       hydrate placeIds + build speciesObservationDetails as today]*,
       stale, via, searched:{regions, boundKm}, capped, partial, proven }
```

### Deadlines — one policy, split by call site *[GROK P2-1]*

| | fast path | probe | ladder | page wall |
|---|---|---|---|---|
| species page (STREAMED) | **25s** | 8s | 20s | streamed; worst ≈ 25+20+8 overshoot = 53s < nginx 60 |
| /nearest (AWAITED) | **10s** | 8s | shares page wall | page wall **40s** total (fast 10 + ladder ~25 + overshoot) < 60 |

The species page being streamed can afford a 25s fast path — which **catches
the measured 23.4s robin-class structural successes** instead of aborting a
call that would have answered (GROK's honesty point about presenting a ladder
subset when eBird's own endpoint knew the answer at t=11s; a 25s fast path
shrinks that window to genuinely-dying calls). /nearest cannot, and its 10s
abort is a policy choice the copy must not disguise. The 45s global default
never fires on production nearest paths after Phase 2 — it is the tourniquet
and the safety net for every OTHER eBird call. *[GROK P1-5]* /nearest budgets
(24 page / 8 species, semaphore 3 TOTAL) are healthy-path numbers (probes
measured 0.24-0.49s → 24 probes ≈ 4s); under HUNG probes the page wall, not
the budget, is the guarantee, and the ladder degrades to ~1 wave — documented,
accepted. /nearest keeps `slice(0,3)` (*[GROK]* engine's top-5 is the species
page's number; no silent product change).

### Cache prune — key-family-aware, NOT blanket *[GROK P1-3]*

Rev 2's blanket 48h `DELETE` would have evicted FRESH rows of every 30-day
family and destroyed their stale-fallback: `regions:*` (REGION_TTL_MIN 43,200
— also feeds hotspot-page county names via `LIKE 'regions:%'`),
`tideStations:*` (~2MB), `tidePred:*` (both 43,200, tides.ts:60-61). Corrected
job (worker, daily): delete rows older than 48h **only for short-TTL
prefixes** — `spReg|obs|notable|geo|geonote|geosp|hotspotObs|nearestObs|
weather|hotspots` — never `regions:`/`tideStations:`/`tidePred:`. Test: a
7-day-old `regions:subnational2:US-FL` row SURVIVES the job; a 3-day-old
`spReg:` row does not.

## Phase 2 — wire the two call sites (SAME PR as the engine — *[GROK P1-5]*
the /nearest empty-state fix cannot trail)

### species `+page.server.ts` (loadNearest :197-221)
Swap in `nearestSpeciesReports` (fastDeadlineMs 25_000, budget 40, ladder
20s). Keep hydrate(resolveMissing:false) + speciesObservationDetails +
slice(0,5) + `streamed()` + EbirdError ladder untouched.

### species `+page.svelte` (:644-719) — copy per the honesty contract *[GROK P1-4]*
- Rows unchanged.
- capped/exhausted, 0 rows → **"No reports found in the {n} regions we
  searched"** + `https://ebird.org/map/{sp}` link-out (`↗` convention).
  NO kilometre disk claim; optional muted "farthest region searched starts
  ~{formatDistance(boundKm)} away", labeled as a bound.
- via 'ladder' + rows → muted "found by searching {n} regions" (**not
  "nearby"**), and the section keeps rendering distances as facts (they are
  exact) but never re-frames as "any distance" proven-global.
- proven:false (rows or 0-row branch BOTH) → "some closer regions couldn't be
  checked."

### `/nearest` `+page.server.ts` + `+page.svelte`
Engine with fastDeadlineMs 10_000, per-species budget 8, page budget 24,
page-global semaphore 3, page wall 40s. `NearestTarget` gains
via/searched/capped/partial/proven; `targetCard` (:34-35 today renders ANY
empty rows as "No reports in the last N days") distinguishes true-empty from
capped/partial with the same copy rules. Per-target try/catch stays.
Follow-up td filed (not blocking): stream /nearest like the species page.

### Help + About (cs.md)
Help: "when eBird's direct lookup **times out or errors**" (*[GROK]* not
"fails" — a 10s abort is our policy, not eBird's failure), the app searches
its seeded regions outward; a capped search names how many regions it checked
and links to eBird's map. About: one release-note line.

## Phase 3 — verification

- **Unit** (`nearest-ladder.test.ts`, mocked wrapper + fixture regions):
  top-5 stop (1-4 early hits continue; the 100km-hit/110km-bound/4×120-150km
  case surfaces all 5); five-hits-in-first-region stops (*[GROK P2-5]*
  CONFIRMED correct); **JAX-home-not-starved test: 5 US-FL hits under budget 8
  with US-AK/FJ-* present — must NOT probe unsafe regions at all** (fix-A
  pin); NULL-box sorts by centroid + proven:false when unprobed; margin
  straddle; dedupe-before-hit-count as a STOP test (5 dup obs ≠ 5 hits);
  saturation → partial; 401/403/429 breaker fast+rung; stale-fallback rung
  does NOT trip the breaker; 3-consecutive-5xx; ladder deadline with hung
  probes (fake-timer via EBIRD_TIMEOUT_MS); waves ≤3; budgets; incomplete-
  coverage set contains HU+LV and NOT the empty-intersection formula; correct
  excluded-codes path (backend/db/...).
- **ebird.ts**: wrapper key/clamps/pins; internal 8s; deadlineMs shared under
  coalescing; 45s global fires for a non-nearest call (geo feed) when hung.
- **/nearest**: semaphore ≤3 under 6 targets; page wall honored; capped/partial
  copy renders; still 3 rows.
- **Prune job**: 30-day families survive; short-TTL families pruned.
- **Suite**: `npm run check` 0; full vitest (2 known races, td-b29d1c).
- **Live (dev:test, real key), from Jacksonville**: bkcchi → NC/TN rows ≲3s +
  "searching N regions" note; eurrob1 → capped honest copy + map link;
  stbori → fast path, no note; amerob → fast path answers ~23s on the STREAMED
  species page (no ladder); norcar → nearby section unchanged. **Live audit:**
  every obs from probed rungs within its region's box + margin (gates margin
  reduction). Prod: count null/unsafe boxes (expect 0/11).
- **Cache growth**: ebird_cache rows + pg_total_relation_size before/after a
  eurrob1 cap-out; prune removes spReg >48h.
- **Prod after deploy**: bkcchi from the owner's phone — total in single-digit
  seconds; /nearest resolves all targets < 40s.

## Deferred (explicit)
- Frequency prefilter (measure PROD coverage first — own td).
- Streaming /nearest (own td, filed at implementation).
- Antimeridian-unsafe regions unsearchable via ladder (fast path still covers
  them); the 301 excluded codes partially covered via the 24 country probes.
- Cross-process single-flight (td-3bf3a2). Fast-path circuit-memo ("skip a
  known-dying (species,home) fast path for N minutes" — GROK P2-2 suggestion)
  — nice-to-have, not blocking.

## Files touched
- `src/lib/server/ebird.ts` — Phase-0 global 45s deadline + EBIRD_TIMEOUT_MS,
  `recentSpeciesInRegion` (8s internal), `nearestObsOfSpecies` opts.deadlineMs
- `src/lib/geo.ts` — export `boxSupportsProximity`
- `src/lib/server/regions.ts` — `allProximityRegions()` (+ fix stale "~4,250"
  comment, *[GROK P3-2]*)
- `src/lib/server/concurrency.ts` (new); needs.ts import updated
- `src/lib/server/nearest-ladder.ts` (new)
- `src/lib/server/job-handlers.ts` — family-scoped ebird_cache prune
- `src/routes/species/[code]/+page.server.ts` / `+page.svelte`
- `src/routes/nearest/+page.server.ts` / `+page.svelte`
- `src/routes/help/+page.svelte`, `src/routes/about/+page.svelte`
- Tests: `nearest-ladder.test.ts` (new), `ebird-cache.test.ts` additions

## Process
Both reviews folded. GROK explicitly does NOT block on: streaming /nearest,
frequency prefilter, or the 25km margin. Phase 0 independently deployable.
**Next: owner go → implement → post-implementation review cycle → deploy.**
