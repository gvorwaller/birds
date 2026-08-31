# Home page (`/`) performance — td-d561a8

**Status:** IMPLEMENTED (2026-08-31). Rev 4 folded three critiques — CODEX1 (mechanics,
*[CODEX1]*), AGY (UX, *[AGY]*), GROK (hostile design review, *[GROK]*, verdict on rev 3:
"do not implement as written"). Owner chose **option (a)** (§1e: keep the enriched
re-sort, gated by §1d) on 2026-08-31 and the plan was built as written.

Measured on the local test cluster against live eBird, same account/home:

| | shell | eBird before paint | DB before paint |
|---|---|---|---|
| before (prod) | 2,282 ms | 30 | 128 |
| after, cold | 367–426 ms | 3 | 12–22 |
| after, warm (≤30 min) | **7 ms** | 0 | cache reads only |

§1d verified live on 49 species: every base row claimed "1 location · 1 report"; after
enrichment Eastern Bluebird read 11 locations / 11 reports / 54 birds. **Zero rows saw any
displayed number shrink**, which is the merge contract holding against real payloads.

## Context

Measured on prod: `perf path=/ shell=2282ms total=2283ms db=128/498ms ebird=30/4213ms`.
Owner's stance: eBird calls that buy **data currency** are valid and 2.5 s is acceptable if
that's what they buy; redundant calls on a quick return (~5 min) should be eliminated; other
lurking issues should be tuned.

Exploration closed the arithmetic exactly (N = 27 needed species):

| Source | DB | eBird |
|---|---|---|
| Session + stage-1 user/gallery/key/counts | 8 | 0 |
| Area feed: recent + notable + hotspots (all 30-min/24-h cached) | 6 | 3 |
| Base hydrate + seenSet | 6 | 0 |
| **Per-needed-species fan-out: 27 × (1 eBird + 4 DB)** | **108** | **27** |

**Findings that reframe the request:**

1. **The 5-minute idea already exists, better than asked.** Every obs call sits behind the
   `ebird_cache` table with a **30-minute TTL** (`OBS_TTL_MIN`, `ebird.ts:184`), keyed by
   rounded lat/lng + dist + back. The measured 30 calls were a **cold cache**. A return
   within 30 min re-pays zero eBird calls — but still pays all 128 DB queries and the full
   recompute/serialization.
2. **The currency-buying spend is only 3 calls** (recent, notable, hotspots-near). The other
   27 fetch per-species `places[]` detail that **renders nothing at first paint** — place
   lists appear only on tap/search/focus. It feeds the place-search index and per-species
   places; nothing above the fold waits on it. (`bestPlaces` is base-only — §1a.)
3. **Pathological case:** a user whose life list hasn't synced makes *every* species in the
   feed a "need" → ~150 eBird calls + ~600 queries in one load. Three users now; this will
   happen to the next new account.
4. *[GROK P1-1, upgraded to CONFIRMED by live call 2026-08-31]* **The base area feed is
   one-row-per-species.** `geo/recent` near the owner's home returned 146 rows / 146
   distinct species / max 1 row per species. So the BASE aggregation is degenerate:
   `locationCount`=1, `nReports`=1, `totalCount`=howMany-of-the-single-latest-obs, and
   `distanceKm`=distance to that one obs, for **every** species. The real counts come only
   from the per-species enrichment feeds. This is why the fan-out exists, and it is why the
   first paint must not print those numbers as complete facts (§1d).

**Goal:** first paint in a few hundred ms with real, honest content (not skeletons), the
same features, and the waste removed. *[GROK P2-1]* Not claimed: "identical data currency"
as a user-facing promise — TTLs are unchanged (CONFIRMED), but a warm-cache paint serves an
up-to-29-minute-old feed in 300 ms; the existing "reports as of … ET" timestamp (td-97b22e)
is the honest signal and stays authoritative (§6). The streamed `Streamed<T>` +
retained-last-value pattern from `/species/[code]`, `/forecast`, `/forecast/data` applies,
**with two Home-specific exceptions GROK identified** (§1f, §1g) — it must not be copied
blind.

## Design

### 1. Split the loader at the enrichment boundary (the big win)

`geoTargets` (`needs.ts:435-479`) has a natural seam: `buildView(...)` produces a complete
base view from the 3 area calls; `enrichNeedsWithSpeciesReports` then overwrites needs with
per-species data (`{...need, ...detailed}`, `needs.ts:342` — *[GROK]* this **replaces, not
merges**: counts, `lastObsDt`, `lastLat/lastLng`, `distanceKm`, `locations`, `places` all
change, and a non-empty-but-smaller detailed payload can make counts DROP; only the
empty-payload case keeps base, `needs.ts:335-340`).

**a. Server split.** `src/lib/server/needs.ts`: fast phase (area calls → hydrate →
`seenSet` → `buildView`) returns the base view; `enrichGeoTargets(view, …)` wraps the
existing fan-out. *[CODEX1 P1-1]* `bestPlaces` is built from the BASE recent feed only
(`needs.ts:386-395`) and never rebuilt from enrichment — it belongs to the AWAITED base
view, complete at first paint; no pending hint for it anywhere. Parallelize the fast-phase
internals: `verifiedHotspotLocIds` and `seenSet` join the obs `Promise.all`
(`needs.ts:446-455`). *[CODEX1]* Base `stale` must include `hotspots.stale` before first
paint (today folded in only at `needs.ts:473-477`).

**b. No Google on either critical path.** *[CODEX1 P1-2]* The base hydrate runs
`resolveMissing: false` (today's inline resolution = up to five SERIAL Google searches at
5 s deadlines, ~25 s worst case, on the shell). *[GROK P1-4]* And it must NOT simply move
onto the streamed enrichment promise either — the same 5×5 s worst case would then define
when `places[]`/search/focus appear, and it bites exactly when new locIds show up. The
streamed payload is **eBird fan-out + batched hydrate with `resolveMissing: false`** only;
Google-ID resolution runs as a third, non-blocking follow-up (fire-and-forget after the
stream resolves, populating the DB for the next load) — MapLink already works on lat/lng.

**c. Loader/client shape.** `+page.server.ts`: await the base view; return enrichment as a
streamed top-level promise via `streamed()` (never rejects; per-species failures resolve a
partial view; the EbirdError ladder covers only whole-phase surprise). `+page.svelte`:
retained-last-value keyed by `location+dist+back` — but see §1f for the Home-specific
overlay semantics.

**d. Honest first paint — field-level gating.** *[GROK P1-1, the 937bdb8 class]* The
current meta line prints `locationCount`/`totalCount`/`nReports`/"nearest {distanceKm}" as
precise facts (`+page.svelte:747-757`, `:807-815`). With the base feed confirmed
one-row-per-species, at first paint those are uniformly "1 location · N birds · 1 report" —
wrong-er numbers that visibly inflate ~2 s later. And "nearest" is doubly dishonest:
`distanceKm` is distance to the MOST RECENT obs (`needs.ts:197-204,244-249`), while
`nearestDistanceKm()` mins over `places[]` (`needs-sort.ts:26-32`) — two different numbers,
both labeled "nearest" (pre-existing on prod; the split would make it a 2-second flicker).
Contract:

- First paint MAY claim: species identity, Need/Notable badges, the area-feed place name,
  MapLink to that record's coords, `lastObsDt` labeled as the latest area report, and the
  distance to that report labeled **"last report"** (not "nearest").
- First paint may NOT claim `locationCount`/`totalCount`/`nReports` or "nearest D". The
  quantitative meta appears when enrichment lands.
- Enrichment MERGES, not replaces: union `places[]` by locKey; if the detailed payload is
  non-empty but smaller than base knowledge, keep the larger claim + `enrichPartial` rather
  than letting a precise number drop in place.
- "nearest" label always uses `nearestDistanceKm` over the enriched `places[]`; the
  "last report" distance may persist alongside under its honest label. (This also fixes the
  pre-existing two-nearests bug.)

**e. Ordering/settle — OWNER DECISION, reframed.** Rev 3 presented AGY's option (b) (pin
base order) on the premise that base order "already ranks by real area activity." *[GROK]*
That premise is WRONG — with a one-row-per-species feed, `sortNeedsByActivity` at base
collapses to howMany-of-the-single-latest-obs, a weak rank. Corrected options:

- **(a) keep the enriched re-sort:** rows may reorder ONCE ~2 s after paint (a settle), and
  the final rank is the meaningful enriched-activity order the page has always shown. With
  §1d's gating, the pre-settle rows are honest (no fake counts), so the settle corrects
  order only, not printed facts. Mis-tap exposure is the one settle window.
- **(b) pin base order:** zero movement, but the PERMANENT rank becomes
  howMany-of-latest-obs — a real product downgrade, not a loading detail.
- *[GROK]* Whichever is chosen, the pin/allow split is field-level, not a vibe: map default-
  pin coordinates and the collapsed MapLink stay pinned to base `lastLat/lastLng` (the
  spread would otherwise move pins even under (b)); `places[]` and the §1d metadata always
  fill in; the client-side "Nearest" toggle MAY always reorder — that's what the control is
  for. No unit test bakes in either option before the owner's call (rev 3's "without
  reordering" test is deleted).

GROK's recommendation by implication, and mine: **(a) + §1d gating** — one honest settle
beats a permanently weakened rank. Owner decides.

**f. Home-specific retained overlay — do NOT copy forecast's blanking.** *[GROK P1-5]*
`forecast/+page.svelte:31-48` blanks to skeleton on key change — correct there (the
streamed section IS the content), destructive here (the awaited base IS the content). Home
rule: on key mismatch (dist/back/place change), render the NEW awaited base immediately —
no old overlay, no skeleton; on same-key invalidation (jobsPoll `invalidateAll`), keep the
last overlay until the new stream settles. Copy the alive-flag cleanup
(`species/[code]/+page.svelte:86-105`) so a promise resolving after unmount/key-change
writes nothing. The derived chain this must survive, named:
`needsAll → placeIndex → placeHits/focused → needsMatched → needsSorted → needsShown →
mapPoints`, plus the focus self-heal `$effect` (§1g) and the ObsMap points `$effect`.

**g. Freeze the focus self-heal across the swap.** *[GROK P1-2]* `+page.svelte:132-134`
auto-clears a live focus the moment `focusKey && !focused` — correct for a stale shared
`?loc=` on a fully-loaded view, wrong for a two-phase index: enrichment rebuilding
`placeIndex` (locId-vs-coord key changes, `place-search.ts:111-118,156-188`) could clear a
focus the user just set, with a `replaceState`, ~2 s after paint. Rule: while the stream is
pending, do not auto-clear; after it settles, keep the focus if the key (or a reconciled
memberKeys hit) survives, and only then self-heal if it's genuinely gone.

**h. Map must not snap.** *[AGY P1, GROK P2-4]* `ObsMap.renderMarkers` re-runs `fitBounds`
on every points update (`ObsMap.svelte:141`, `$effect` at `:197-200`) — pinned default-pin
coords are not enough, since search/focus/expand still change `mapPoints`. Add a
caller-controlled prop (e.g. `fit="first"` / viewport-lock) rather than Home-only state
inside ObsMap (forecast may still want refit-on-filter). Implementation trap: `fitBounds`
itself fires `bounds_changed`; detect user interaction via `dragstart`/gesture
`zoom_changed`, never `bounds_changed`.

**i. Header badge + place-search pending states.** *[AGY P2]* The section-header `cached`
badge reflects the THREE area calls at first paint; enrichment must not toggle it later
(today one `view.stale` ORs everything, `needs.ts:476` — the split payload keeps them
separate). *[AGY P2 + GROK P2-3]* While enrichment is pending and
`searching && placeHits.length === 0`: show "Checking all places in range…" — but KEEP the
"or search it as a location" geocode escape hatch visible during pending (blocking it for
the stream's duration on a typed city name is worse than the flash); the definitive "No
place in the loaded reports matches…" only after settle.

Expected: cold shell ≈ 300–500 ms for the saved-home path (3 parallel eBird calls, no
Google anywhere near a critical path); a typed `?place=` still pays live geocoding (up to
2×10 s, tracked on td-3bf3a2). Warm return: shell with zero eBird calls.

### 2. Single-flight + abort — IN THIS TICKET, not deferred

*[GROK P1-3, reclassifying CODEX1's P3]* "Pre-existing, unchanged by this work" is wrong as
a classification: today overlapping `geoTargets` runs are rare because the page blocks for
~2.3 s; post-split the shell returns in ~400 ms and the 27-call fan-out is unabortable
server-side, so a user changing dist/back 3–4 times launches that many overlapping
fan-outs, and cold overlapping misses duplicate upstream calls — a cs.md politeness
regression the split itself CREATES. Tap-preload (§5) makes cancelled presses another
source. In this PR:

- Copy the existing per-process coalescer pattern (`species-enrichment.ts:663-678`
  `inFlight` Map, td-0753d0) into `cachedFetch`, keyed by `cache_key`. Per-PM2-worker is
  enough for the same-user overlap the fast shell invents; cross-worker stays on td-3bf3a2.
- Pass the load event's `AbortSignal` into the enrichment phase: a superseded navigation
  stops scheduling NEW per-species calls (in-flight HTTP may finish and warm the cache —
  fine; starting the next 23 is not).

### 3. De-loop the fan-out's DB work (54 queries → 2)

Inside `enrichNeedsWithSpeciesReports`: stop calling `hydrateEbirdLocationPlaceIds` per
species. Collect every species' `result.data`, then one batched hydrate after
`mapWithConcurrency` completes — **`resolveMissing: false`** (*[GROK P1-4]* Google moved to
the post-stream follow-up, §1b) — and pass the placeIds map into `aggregate()` per species.
*[CODEX1 P1-4]* The map is keyed by locId only, so one union pass is equivalent for
successful data — but the batch gets its own catch: a failed batch aggregates the fetched
observations with an EMPTY placeIds map (lat/lng MapLinks stay valid) rather than rejecting
the stream. Test the batch-failure path, not just equivalence.

### 4. Guard the unsynced-life-list case

*[CODEX1 P1-3]* The guard keys on **`life_list_synced_at IS NULL`** (never synced), not
`seenSet.size === 0` (a successful import can legitimately match zero rows): skip
enrichment, resolve the stream with base needs + `enrichPartial: true`, copy that says the
place index is deliberately incomplete pending a sync — never that calls failed. A
genuinely-zero-lifer synced account enriches normally. Viewer scoping is safe as-is
(`scopeOwnerId`).

*[AGY P1 — copy, GROK P1-6 — mutual exclusion]* The new strings collide with the existing
`seenCount === 0` note ("Your life list is empty, so every species counts as a need,"
`+page.svelte:719-723`) — a never-synced account satisfies both conditions. Gate:
**unsynced → §4 copy only; synced-and-zero → existing empty-list copy only.** Strings
(owner-editable): owner — "Your life list is not synced yet. Showing area-level needs until
synced. Sync in Settings →"; viewer — "Life list not synced. Showing area-level needs.";
place-search empty state while unsynced — "Place breakdown is limited until your life list
is synced in Settings"; focus bar — "area-level reports (sync life list for full
breakdown)". None of it may read as a failure.

### 5. Remove the duplicate queries (cheap, mechanical)

- Merge the two `user_ebird` reads into one select; keep `getEbirdApiKey` for other
  callers, decrypt from the merged row here.
- Merge the two `users` reads; pass `gallery_url` into `galleryContext`.
- *[CODEX1 P2-2]* Load `seenSet` ONCE in stage 1, independent of eBird/location state
  (`seen.size` feeds the at-a-glance count in EVERY state), and pass the same Set into the
  fast phase and the enrichment guard; the standalone `COUNT(*)` goes away.
- `location-placeids.ts`: skip the second `googlePlaceIdsForLocIds` when the resolve loop
  performed zero lookups (`:327`).

### 6. Currency story — what the fast paint honestly claims

*[GROK P2-1]* `stale:true` is a FAILURE indicator (fail-soft after TTL expiry,
`ebird.ts:154-178`), not an age indicator — never present it as freshness. The as-of
timestamp stays `recent.fetchedAt` (area feed), rendered as today (td-97b22e); enrichment
must never mutate it (per-species `geosp:` keys have independent 30-min clocks — mixed
generations are expected and are why row `lastObsDt` shouldn't imply the header's clock).
Optional copy tweak: "area reports as of {asOf}". Do NOT change as-of to "now" because
paint got fast. §1d's gating removes the mixed-age precise-count overwrite by construction.

### 7. Stop hover-preloading the whole loader

`app.html` sets `data-sveltekit-preload-data="hover"` globally. *[CODEX1 P2-3, verified on
Kit 2.65]*: a preload of a STREAMED route launches the deferred server work immediately and
a discarded preload does not abort it. Add `data-sveltekit-preload-data="tap"` to all
**four** rendered Home anchors (*[GROK P2-5, verified]* brand `+layout.svelte:106`, top-nav
`:108-110`, drawer `:131-138`, bottom-nav `:179-182`; the drawer brand is a span). The
invariant test scans persistent chrome (layout + app.html) only — a repo-wide
`href="/"` grep would trip on `targets/+page.svelte`'s redirect. *[GROK P2-6]* tap is a
reduction, not a close — a cancelled mousedown still fires the loader; §2's single-flight
makes a cancelled tap + real tap coalesce. "off" only if measurement shows cancelled taps
are common.

### Deliberately NOT doing

- **Not touching the 3 area calls or any TTL** — that's the currency spend the owner
  endorses, and the 30-min cache already exceeds the 5-min dedup ask (report as "already
  satisfied").
- **Not capping the fan-out for synced users** — it feeds the place-search index and
  per-species `places[]`; typical N≈27 is fine off the critical path. (§4 covers the
  pathological case.)
- **Not adding HTTP/browser caching** — `private, no-store` is a correctness choice.
- **Not doing cross-worker single-flight or Google-lookup dedup/caching** — td-3bf3a2
  (per-process single-flight and enrichment abort moved INTO this ticket, §2).
- *[GROK P3-1]* Not converting the streamed payload to a delta shape — §1d already shrinks
  what rows display until settle; not worth new machinery now.
- *[GROK P3-3]* Notable card stays area-level (never enriched, pre-existing); with §1d the
  Needs card's first paint matches it, which is the honest state.

## Files

- `src/lib/server/needs.ts` — split `geoTargets`; merge-not-replace enrichment (§1d);
  batch hydrate `resolveMissing:false`; synced_at guard
- `src/lib/server/ebird.ts` — `cachedFetch` per-process single-flight (§2)
- `src/routes/+page.server.ts` — fast/streamed split, AbortSignal into enrichment, merged
  stage-1 queries
- `src/routes/+page.svelte` — field-gated meta (§1d), Home overlay semantics (§1f), focus
  freeze (§1g), pending states (§1i), copy exclusivity (§4)
- `src/lib/components/ObsMap.svelte` — viewport-lock prop (§1h)
- `src/lib/server/location-placeids.ts` — skip redundant second select
- `src/routes/+layout.svelte` — `data-sveltekit-preload-data="tap"` on the four Home links
- Reuse as-is: `$lib/streamed.ts`, TTLs in `ebird.ts`, `mapWithConcurrency`

## Verification

- **Unit** (needs.test.ts + new): base view completeness without enrichment; enrichment
  MERGE semantics — `places[]` union by locKey, counts never drop in place, base kept on
  smaller payload (§1d); synced_at-keyed guard (not set-size); batch-hydrate equivalence
  AND failure path (empty placeIds map, stream resolves); base `stale` includes hotspot
  staleness; `cachedFetch` single-flight (two concurrent cold gets → one upstream call);
  four-Home-anchor preload invariant (persistent chrome scan); unsynced/empty-list copy
  mutual exclusion. No test pins Activity-order behavior until the §1e decision.
- **Suite**: `npm run check` 0 errors/warnings; full vitest (known guideCounts race
  excluded).
- **Live (dev:test)**: `/` renders honest base rows before enrichment lands; place search &
  per-species places populate when it does; `?loc=` focus survives the swap (§1g);
  dist/back change mid-stream shows the new base immediately, no skeleton, and stops
  scheduling old fan-out calls (§1f, §2); `home-loader-url-tracking.test.ts` stays green.
- **Prod, before/after perf lines** (the acceptance measure):
  - cold, saved-home path: `shell` ~2,280 ms → ≤ 500 ms; `total` may stay ~2.3 s
    (enrichment unchanged, now streamed); `db` 128 → ~75 cold; eBird 30 cold.
  - warm return (≤30 min): `ebird=0`; `db` → ~45 (*[CODEX1 P2-1]* cold INSERTs disappear).
  - rapid dist/back double-change: eBird call count must NOT double (§2).
- Walk the new-user path (viewer or fresh never-synced account): no fan-out, §4 copy only.
- *[AGY]* Phone-viewport interaction checks: pan the map during the enrichment window (no
  snap); type a fan-out-only place name immediately (pending copy, geocode hatch stays);
  watch section headers when enrichment lands (no badge pop).
- *[AGY P3]* Help: Home section explains area reports render immediately with place
  breakdowns streaming in behind. About: one release-note line. (After §1e is decided.)
