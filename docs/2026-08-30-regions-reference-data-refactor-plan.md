# Regions as reference data — refactor plan

**Status:** revised after CODEX1 adversarial review (2026-08-30). See *Review history* below.

## Context

A "nearest findable region" feature shipped in `ce88a3e`..`313f26c` but never worked: the
species page showed **"Best time of year — Bornholm"** to a user whose home is Jacksonville FL.

Measured on production (not inferred):

| Fact | Value |
|---|---|
| Regions with barchart data | 3,664 rows (`loc_kind='region'`) |
| — of which country / subnational1 | **205** |
| — of which subnational2 (counties) | **3,459**, across 65 distinct parent states |
| Great Black-backed Gull's candidate pool | 141 regions |
| Rows in `region_centroids` | **30** (28 in that pool) |
| Region codes matching the 1–3 segment grammar | **3,664 / 3,664** (zero malformed) |
| Hotspot codes colliding with that grammar | **0** |

`pickNearestTeaserCandidate` refuses to name a "nearest" if **any** pool member lacks
coordinates, so it fell back to the global pick on every load. The only filler was a lazy warm
capped at 5 eBird HTTP lookups per page load. 141 holes, 5 per visit — it never converged.

**The defect is not the picker. It is that `region_centroids` models static reference data as a
runtime cache.** Region coordinates and names are constants. Fetching them on a read path — with
TTLs, cooldowns, error classification, an in-flight promise map keyed by hashed API key, and a
background warm job — is ~450 lines of accidental complexity around constants. Exploration also
found there is **no country-name table anywhere in the schema**: "Denmark" is obtained by calling
eBird, or grepping JSONB out of `ebird_cache` (`hotspot-page.ts:231-246`), or luck.

**Outcome:** one seeded `regions` table replaces all of it — fixing the teaser, naming regions
with their country, removing eBird calls from three read paths, making the pickers work without
an API key, and letting Postgres anchor every region row to known geography. Separately, the
pages get a navigation progress bar, streamed sections, and latency instrumentation, because
"slow enough to look like a dead link" is the other half of the report.

### Owner decisions
1. Postgres `regions` table (not a JSON module), with a DB-enforced invariant.
2. Coverage: countries + subnational1 only (~4,250 rows). Counties keep using eBird's cached lists.
3. Teaser shows **both picks as equal peers** — "Closest" and "Best overall" — country-qualified names.
4. Progressive loading: global nav progress bar **and** stream all three slow pages.

### Review history

**CODEX1 (backend/DB/deploy axis), 2026-08-30 — 4×P1, 9×P2, 4×P3, all accepted.** Every P1 and
every checkable P2 was independently re-verified against the code or prod before adoption. Material
changes: phase order (the FK now lands *before* the defenses it justifies removing), a stronger FK
design that anchors counties to their parent state instead of NULL-bypassing them, real
stream-completion timing, worker-guard contracts that cannot report false success, and Phase 7
transferred to `td-3bf3a2` rather than claimed as deferred. CODEX1 could **not** run DDL against
`birds_test` (its sandbox denied :15436), so the empirical FK test in Phase 4 remains mandatory.
CODEX1 re-reviewed revision 2 and signed off with no corrections.

**AGY (UX/product axis), 2026-08-30 — advisory, 2×P1 + 4×P2 + 3×P3.** Adopted: tabs instead of a
radiogroup; `within`-scoped labels on country-scoped pages (this *corrects* revision 2, which
qualified all seven `/forecast/species` prose sites); a skeleton primitive with reserved height for
streamed sections; birder-facing copy for excluded regions; breadcrumb overflow behavior; Help/About
wording. **Two AGY recommendations were changed rather than taken verbatim:**
- AGY proposed `z-index: 1100` for the nav progress bar. Verified wrong — `+layout.svelte:304-307`
  already uses 1100 for the drawer **scrim** (`position: fixed; inset: 0`) and 1101 for the drawer.
  A bar at 1100 ties with a full-viewport overlay and paints by DOM order. **Use 1050.**
- AGY proposed moving the pool-size qualifier into the chart footer beside the `†` small-sample note.
  Rejected: the 937bdb8 lesson is that a claim's qualifier belongs *where the claim is made*.
  Instead the qualifier moves **into the row label itself** ("Best of 205 loaded regions"), which
  also resolves AGY's separate complaint about three stacked subtitles — the extra scope line is
  deleted entirely.

---

## Phase 0 — Revert today's uncommitted work; keep the breadcrumb

Nothing is committed or pushed; HEAD (`313f26c`) is what is deployed. **Most of today's diff is
thrown away.**

**Discard** (`git checkout --`): `src/lib/server/jobs.ts`, `job-policy.ts`, `job-handlers.ts`,
`job-handlers.test.ts`, `forecast-db.test.ts`, `forecast.test.ts`, `forecast/data/+page.server.ts`,
`species/[code]/+page.server.ts`, and today's additions to `forecast.ts`.
**Delete**: `backend/db/migrations/0042_warm_centroids_job.sql` (untracked).

**Keep**: the breadcrumb — `src/lib/return-link.ts` (`returnTrail`, `Crumb`), `return-link.test.ts`,
the `.crumbs` nav + CSS in `forecast/species/+page.svelte`, `forecastHref` in `species/[code]/+page.svelte`.

**Hand-edit** (mixed files): `forecast/species/+page.server.ts` — keep the `returnTrail` import and
`crumbs:` block, revert the two `warmFor:` edits. `about/+page.svelte` and `help/+page.svelte` —
keep the breadcrumb sentences, delete the background-lookup sentences.

Then `npm run test:db:reset && npm run test:db:up` — the local cluster has 0042 applied and a real
`warm_centroids` job row; once the file is gone that cluster is permanently ahead of the tracked
migrations. Capture the full-suite baseline here (`td-c41126` documents 4 pre-existing
`species-enrichment.test.ts` failures on a prod-restored cluster — do not later attribute those to
this work).

**Ship:** one commit, breadcrumb only. Log the pivot on `td-6c3071`; open a replacement task.

---

## Phase 1 — Latency instrumentation

`src/lib/db.ts:27` `query()` has no timing; `hooks.server.ts` has no request timer. Nothing
measures page latency today.

- **`src/lib/server/request-timing.ts`** (new): `AsyncLocalStorage<TimingBag>` from
  `node:async_hooks`, buckets `{db, ebird, google, ai}` each `{n, ms}`.
- Instrument four chokepoints: `db.ts` `query()`/`queryTimed()`; `ebird.ts` `ebirdFetch` (note
  `cachedFetch` hits never reach it — that distinction is the measurement); `geocode.ts`
  place/geocode calls; **and `googlePlacesTextSearch` at `location-placeids.ts:166-182`, which
  issues its own `fetch` at :181** — instrumenting `geocode.ts` alone would miss the exact
  fan-out Phase 7 targets.
- **Shell timing vs body timing are different numbers and must not be conflated.**
  `await resolve(event)` returns a `Response` whose body is a `ReadableStream`; deferred chunks
  drain afterwards. So a log emitted after `resolve()` is **shell time**, not stream-end time.
  - `Server-Timing` header → shell only, labelled as such. Visible forever in the browser Network
    panel, zero infrastructure.
  - For whole-response time, tee/wrap the returned body and emit on stream `close`/`cancel`,
    preserving status and headers. One stdout line when total > 750 ms:
    `perf path=/species/casjay1 shell=310ms total=2140ms db=11/48ms ebird=3/1620ms google=1/310ms`
    — read via `pm2 logs birds`.
- Guards: null-store check (the worker has no request context); never log query params or user ids.
- Optional Tier 2: `?perf=1` admin-only footer rendering the same bag.
- **No `page_timing` table** — no new schema.

**Do not record any baseline until the shell/body split is implemented**, or the before/after
evidence in later phases is false.

---

## Phase 2 — Generator, `regions` table, seed

### `scripts/generate-regions.mjs`
Modeled on **`scripts/generate-county-meta.mjs`** — Node ESM, no repo imports, run manually, and
critically **validates before writing** (`process.exit(1)`, nothing written on mismatch).

- Endpoints: `/ref/region/list/country/world` (1 call), `/ref/region/list/subnational1/{c}` (per
  country), `/ref/region/info/{code}` for coordinates. Names come from the **list** endpoints
  (what the app has always displayed); coordinates from `/ref/region/info`, reusing the validation
  already proven at `ebird.ts:464-496`.
- **Pilot before the full run.** eBird publishes no numeric rate ceiling, and this repo has
  already been burned once by a documented-vs-real limit (iNaturalist: documented 60/min, real
  ceiling ~140 requests then ~30 min of hard 429s). Run a 3-country pilot first and derive pacing
  from it. Honor `Retry-After`, use adaptive backoff and a circuit-break on 403/429/5xx,
  checkpoint every response to `.local/regions-cache.json` (gitignored) so a mid-run failure never
  refetches. Treat "~4,500 calls / ~30 minutes" as an estimate, not a plan fact.
  eBird's terms permit termination for adverse server impact — pace conservatively.
- Key from `EBIRD_API_KEY` env — never printed, never read from the DB.
- Validation gates: ≥240 countries; per-country subnational1 counts for US/CA/AU/NO/DK/IS/SE/FI/CR/IN;
  spot checks (`US-FL`→Florida/US, `DK-05`→Bornholm/DK, `IS`→Iceland/country, `IS-1` single-digit
  code, `SE-AB`→`Stockholms län`); every code matches the **same regex the generated column uses**;
  parents exist; no orphans or duplicates; lat/lon finite, in range, never exactly `(0,0)`; names
  free of `[XX-NN]` suffixes.
- **`backend/db/regions-required-codes.txt`** — committed list of the country/sub1 codes currently
  referenced by prod data (from the Phase 4 pre-flight). Generator exits(1) if any is missing.
  This is the mechanical guarantee that the FK cannot fail.
- Any code with no usable coordinate is reported and exits(1) — an owner decision, never a
  fabricated coordinate (cs.md).

### Delivery: generated SQL, applied by the existing runner
`backend/db/migrate_pg.sh` sorts `*.sql`, tracks exact filenames, wraps each file and its tracking
INSERT atomically (`:156-163`), and supports `--dry-run`. Generated SQL fits it with no new deploy
step and no prod/test drift path.

- **First seed** (`0044_regions_seed_YYYYMMDD.sql`): full snapshot, ~4,250 rows emitted as
  **chunked multi-row INSERTs** (~500 rows each), not 4,250 separately parsed statements.
- **Subsequent regenerations emit a DELTA migration**, not another full snapshot. A full snapshot
  every time is append-only bloat that every `test:db:reset` replays in full, and it restamps
  `source_at` on unchanged rows. `source_at` is the **upstream snapshot date** and only changes
  when the row's data does. The generator diffs against a committed manifest
  (`backend/db/regions-manifest.json`) and emits only additions, renames, and coordinate changes.
- **Retirement is never automatic.** Codes dropped upstream are reported as warnings; removing one
  requires an explicit migration after proving no FK references it.

Cache invalidation is free: `deploy-to-DO.sh` migrates (`:116-117`) then `pm2 startOrReload`
(`:135-137`), so the deploy that changes the data restarts the process holding it. A manual
`npm run migrate` must be followed by `pm2 restart birds birds-worker`.

### `0043_regions.sql`
```sql
CREATE TABLE regions (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL CHECK (btrim(name) <> ''),
    level       TEXT NOT NULL CHECK (level IN ('country','subnational1')),
    parent_code TEXT REFERENCES regions(code),
    lat         DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lon         DOUBLE PRECISION NOT NULL CHECK (lon BETWEEN -180 AND 180),
    source_at   DATE NOT NULL,
    CHECK (code ~ '^[A-Z]{2}(-[A-Z0-9]+)?$'),
    CHECK ((level = 'country') = (parent_code IS NULL))
);
GRANT SELECT ON regions TO birds_app;
```
- **`GRANT SELECT` only.** The app never writes this table; seeds run as `birds_owner`
  (`migrate_pg.sh:4,101-104`). DML grants would contradict "static reference data".
- **No index.** The accessor loads all ~4,250 rows once per process and filters in memory, so no
  query would use one. `td-3bf3a2` explicitly warns against reflexive indexes on tiny resident
  tables. Add one only if `EXPLAIN` later proves a caller needs it.
- The range CHECKs reject `NaN` for free (verified live, documented in `0041`).

**New migrations contain no `BEGIN`/`COMMIT`.** The runner already wraps each file; 0039–0042 open
their own, so the inner `COMMIT` ends the runner's transaction early and its final `COMMIT` warns —
observed as `WARNING: there is no transaction in progress` when 0042 was applied. Follow 0011/0013.
The runner itself needs no change for ordinary DDL/data migrations.

**Phase 2 is inert** — no code reads `regions` yet. Deploy alone; verify row counts on prod.

---

## Phase 3 — Accessor, label formatter, validation collapse, worker guards

### `src/lib/server/regions.ts` (new)
Process-lifetime memoized index — one query per process:
```ts
let indexP: Promise<RegionIndex> | null = null;
export async function regionIndex() {
  return (indexP ??= load().catch((err) => { indexP = null; throw err; }));
}
```
The `.catch` reset is **not optional**: `indexP ??= load()` caches a *rejected* promise forever, so
one DB blip during bootstrap would fail every region lookup until PM2 restart. Memoizing the
promise (not the value) still gives concurrent-first-call dedup — the lesson the deleted 80-line
`inFlightCentroidFetches` map learned the hard way, in four lines. ~4,250 rows ≈ 300 KB resident.
Export `__resetRegionsCacheForTests()`.

Surface: `getRegion`, `regionLabel(code, {within?})`, `regionLabels(codes)`, `countriesList()`,
`subnational1Of(country)`, `regionCoords(code)`, `validateRegionCode(raw)`.

**Label rule** (documented in the module header — the one place the render sites look):
country → `"Denmark"`; subnational1 → `"Bornholm, Denmark"`; `within: 'DK'` → bare `"Bornholm"`;
**unknown code → `null`, never a guess** (callers fall back to `countyMeta()` / `loc_name` / raw
code explicitly). Sort with `localeCompare` (`Åland`, `Östergötlands län` are real data).

Add `region.label` **alongside** `region.name`, never mutating it — `region.name` feeds
`countyMapQuery(...)` at `forecast/species/+page.server.ts:369`, and `county-meta.ts:41-47` appends
the supplied state name, so a qualified label would silently turn a Maps query into
`"Alachua County, Florida, United States"`.

**Where the qualified form is actually used** (corrected after AGY review): only where the country is
*not* already established. `/forecast/species` is explicitly scoped by its own country picker, so its
seven prose sites (`:342,346,369,375,402,451,503`) pass `within: data.country` and render bare
**"Florida"** — `"Species reported in Florida, United States"` is redundant on a page whose country
selector reads "United States", and it wraps on a 320–360 px viewport. The **teaser card keeps the
qualified form**, because its two rows can name regions in different countries and the country is the
whole point of the comparison. `forecast/data`'s failed-loads label (`:1223`) also stays qualified —
that list mixes countries.

**Other changes:** `forecast/data/+page.server.ts` country/sub1 name maps; `forecast.ts:775-787`. For `hotspot-page.ts regionNames()` (`:231-246`) note it has no branch today
— it resolves any code from cached JSON, and the hotspot loader asks it for **both** county and
state (`hotspots/[locId]/+page.server.ts:70-120`). Specify: resolve country/sub1 from `regions`,
resolve only the remaining sub2 codes from `ebird_cache`, merge. Decide explicitly whether
`hotspot-sweep.ts:94-140,167` (which validates and labels a subnational1 from live eBird) should
also use the canonical formatter.
**Left alone:** `/forecast/+page.svelte:890,930` (always the user's own country), region `<option>`
lists (already country-scoped), all county naming (`county-meta.ts` owns it).

### Collapse three copies of region validation
`forecast/species/+page.server.ts:512-524` and the inline duplicates at
`forecast/data/+page.server.ts:654-660` and `:713-718` all become `validateRegionCode()`. They lose
their `fail(502, "Could not verify the region against eBird")` branches — a local lookup has no
network failure mode — and the loader's three-level "if the country list is unavailable, fall back
to syntax-valid" ladder disappears.

**Retires from read paths:** `ebirdCountries()` ×5 and `subregions(…,'subnational1')` ×8 call sites.
Honest accounting: these are 30-day `cachedFetch`, so most are already DB reads. The real wins are
no cache-miss stampede on a request path, an N-country fan-out collapsing to one memoized map, and
**the pickers no longer requiring an eBird API key** (today a key-less user or viewer gets empty
pickers and `regionError`).

### Worker guards — **must land here, not later**
`analyze_counties` on a *country* parent snapshots eBird's live subnational1 list
(`forecast/data/+page.server.ts:692-745`), so a code added upstream after the seed can enter a job.
These guards must exist **before** the FK and long before any missing-coordinate fallback is
deleted:

- **`analyzeCountiesLocs` (`job-handlers.ts:359-376`) returns `{ locs, excluded: [{code,name}] }`**,
  not a bare `LocToEnsure[]`. Today it cannot report an exclusion at all.
- **The all-excluded branch must not report success.** `runJob` currently completes with
  `ready: payload.counties.length` when `locs.length === 0` (`job-handlers.ts:2402-2412`) — with
  filtering added, that would report every filtered child as *ready*, which is exactly the silent
  false success cs.md forbids. Excluded children are recorded as **skipped**, with an actionable
  summary and event.
- **Filter at enqueue** (immediate operator feedback) **and again at claim** (stale durable payloads).
- **Classify SQLSTATE `23503` where the typed error still exists** — in `ensureFrequencies` /
  `storeFrequencies` (`barchart.ts:735-753`), *not* in `recordFailedAttempt`, which receives only a
  string (`barchart.ts:464-471`).

**Two audiences, two messages** (AGY): the job feed and failed-loads list on `/forecast/data` are
read by a birder; `scripts/generate-regions.mjs` is not birder language.
- **User-facing** — badge `⚠️ Skipped — region not supported yet` (colour *and* text label per
  cs.md), detail: *"{name} ({code}) is a region eBird knows about but this app's region data
  doesn't cover yet."* Note it deliberately does **not** promise "available in a future update" —
  nothing makes that true automatically, and this app's primary user is also its operator.
- **Operator-facing** — the actionable command goes to the server log and the admin-only job event
  (`canViewJobEvents` already gates non-frequency job events to admins):
  `[job:analyze_counties] excluded unseeded region {code} ({name}) — run scripts/generate-regions.mjs and deploy`.

---

## Phase 4 — The invariant (`0045_frequency_region_ref.sql`)

Lands **before** Phase 5 deletes the defenses it makes unnecessary. Until this is live on prod,
"unreachable by construction" is not true and no fallback may be removed.

```sql
ALTER TABLE frequency_fetch
  ADD CONSTRAINT frequency_fetch_region_shape
    CHECK (loc_kind <> 'region' OR loc_code ~ '^[A-Z]{2}(-[A-Z0-9]+){0,2}$');

ALTER TABLE frequency_fetch ADD COLUMN region_ref TEXT GENERATED ALWAYS AS (
    CASE
      WHEN loc_kind <> 'region' THEN NULL
      WHEN loc_code ~ '^[A-Z]{2}(-[A-Z0-9]+)?$'  THEN loc_code                        -- country / sub1: itself
      WHEN loc_code ~ '^[A-Z]{2}(-[A-Z0-9]+){2}$' THEN substring(loc_code from '^[A-Z]{2}-[A-Z0-9]+')  -- county: its state
    END) STORED;

ALTER TABLE frequency_fetch ADD CONSTRAINT frequency_fetch_region_fk
    FOREIGN KEY (region_ref) REFERENCES regions(code);   -- no action clause, deliberately
```

**Why counties anchor to their parent rather than bypassing via NULL.** The original design
returned NULL for all 3,459 county rows and for any malformed region code, so the FK covered 205 of
3,664 rows — which does not support the claim that a region cannot have data without coordinates.
Anchoring a county to its state covers **all 3,664**, while still not pretending a county has its
own centroid. Verified on prod: 3,664/3,664 region codes match the 1–3 segment grammar (zero
malformed, so the shape CHECK adds cleanly), the 3,459 counties have 65 distinct parents (all
seeded subnational1 codes), and **0** hotspot codes match the region grammar, so hotspots still
yield NULL and pass.

- **No `ON DELETE`/`ON UPDATE` clause.** PG17 rejects certain referential *actions* on constraints
  containing generated columns; default `NO ACTION` is legal and is the semantics we want.
- `textregexeq` is `provolatile=i` in PG17's catalog, so the regex is legal in a generated column.
- `ADD COLUMN … STORED` **rewrites the table under `AccessExclusiveLock`** — at ~8,400 rows this is
  sub-second, but state it rather than discover it.
- **First implementation step: prove it empirically on `birds_test`** (add column, add both
  constraints, confirm a bad insert raises `23503`). CODEX1's sandbox could not reach :15436, so
  this is unverified by review. **`NOT VALID` is not a fallback** — it postpones scanning existing
  rows, it does not legalize an unsupported constraint. If the FK is rejected outright, the fallback
  is a `BEFORE INSERT OR UPDATE` trigger.
- **Pre-flight against prod immediately before this deploy**, must return zero rows, and regenerates
  `regions-required-codes.txt`:
  ```sql
  SELECT DISTINCT region_ref_expr FROM frequency_fetch WHERE loc_kind='region'
    AND <region_ref expression> NOT IN (SELECT code FROM regions);
  ```
- Existing DB fixtures (`TESTX-DEL`, `TESTX-BAD`, `TEST-OK`) don't match `^[A-Z]{2}-`, so no existing
  test needs a `regions` row.

---

## Phase 5 — Teaser as equal peers + delete the centroid machinery

Only after Phase 4 is live on prod.

`pickSpeciesTeaserState` returns both picks with **both curves** — already built for every candidate
in `built[]`, so this costs ~120 numbers of payload and zero extra queries; switching needs no round trip.

```ts
interface TeaserPeer { kind: 'closest'|'best'|'both'; locCode: string; label: string;
  distanceKm: number|null; curve: MonthStat[]; weeks: WeekStat[]; migration: string|null;
  best: BestMonth|null; peakPhrase: string|null; good: number[]; }
interface SpeciesTeaserPick { peers: TeaserPeer[]; defaultLocCode: string; poolSize: number; hasOrigin: boolean; }
```

Card heading `Best time of year`. **The honesty qualifier lives in the row label, not in a separate
subtitle** — "Best overall" across 205 of ~4,250 world regions is a false claim unqualified
(`937bdb8` is this repo's prior lesson), and a qualifier only counts where the claim is made:

```
Closest with sightings      Florida, United States    280 mi away · peaks late April
Best of 205 loaded regions  Bornholm, Denmark         peaks late May · good Apr–Jun
```

This replaces revision 2's extra muted scope line, which stacked a third subtitle above a chart that
already carries its own caption (`FrequencyChart.svelte:29`), good-window line, and `†` small-sample
footnote.

**A tablist, not a radiogroup.** A radiogroup selects a *value*; this selects which region's data a
panel displays — that is the tab pattern. `role="tablist"` with two `role="tab"` ≥48 px controls,
`aria-selected`, roving tabindex, arrow-key navigation, and `aria-controls` pointing at a
`role="tabpanel"`. Selection shown by colour **and** a text/state cue, never colour alone (cs.md).

**The chart, its caption, and the "Where should I go?" link all live INSIDE the tabpanel.** The link
target changes with the selection (a change from today, which always used `ft.regionCode`); if it sat
outside `aria-controls`, a screen-reader user would never be told it changed. Distance via the
existing `formatDistance`.

**Edge cases:** same region → one static row, `kind:'both'`; no origin → single "best" row plus
*"Set a home location in Settings to see the closest region with sightings"* (**never a "Closest"
row with a null distance**); one-region pool → same as `'both'`; no usable pick → card absent.
The teaser becomes pure-DB, so it now works for key-less users and viewers.

### Deletions (exact symbols, all in `src/lib/server/forecast.ts` at HEAD)
`CENTROID_NEGATIVE_TTL_DAYS`, `CENTROID_TRANSIENT_COOLDOWN_DAYS`, `CentroidErrorClass`,
`classifyCentroidError`, `inFlightCentroidFetches`, `inFlightCentroidKey`, `persistCentroidOutcome`,
`fetchAndPersistCentroid`, `ensureRegionCentroids` — plus the now-dead `createHash` and `EbirdError`
imports (`forecast.ts:15-18`).
Also `fetchRegionCentroid` (`ebird.ts:464-496`) and `src/lib/server/ebird-region.test.ts`.
**Only `strictBody` (`ebird.ts:74,108-118`) loses its last caller.** `ebirdFetchOrNull` and `nullOn`
are still used by `lifer-locations.ts:86-89` — do not remove them.

`pickNearestTeaserCandidate` loses its "bail if any pool member lacks a centroid" branch;
`sortByProximity` loses its `Infinity` fallback; `pickSpeciesTeaserState` loses `apiKey` and
`centroidBudget`. These are unreachable **because Phase 4 is already live** — that ordering is the
justification.

**Do not drop `region_centroids` here.**

### Docs (cs.md requires both)
`help/+page.svelte:329-340` — the "Best time of year" bullet, in birder language:
> *"Species pages show a **Best time of year** card comparing the closest loaded region with
> reliable sightings against the region where the bird is most frequent overall. Tap either place to
> switch the chart, or use 'Where should I go?' for county and hotspot detail."*

`help/+page.svelte:255-258` — the picker-ordering bullet loses its "we fetch region locations in the
background" caveat; ordering is simply nearest-first now.

`about/+page.svelte` version history — side-by-side seasonal comparison; region names now include
their country where that isn't already obvious; forecast pickers work without an eBird key; region
names no longer show barchart artifacts like `[SE-01]`; smoother page transitions. **Keep these
under the current `v0.1.5` entry unless the owner cuts a new version** — AGY's draft invented a
`v0.1.6` heading; version numbering is the owner's call, not a side effect of a refactor.

Also update the breadcrumb's `.crumbs` rule (`forecast/species/+page.svelte`) with
`overflow-x: auto; white-space: nowrap;` so a long common name ("Black-throated Green Warbler")
scrolls in its own container instead of wrapping to three broken lines on mobile — consistent with
cs.md's rule that wide content scrolls inside itself. `/forecast/data` does **not** get a breadcrumb;
it is reached from tabs, not from a drill.

---

## Phase 6 — `0046_drop_region_centroids.sql`, its own later deploy

Only after Phase 5's code is confirmed live. `deploy-to-DO.sh` builds (`:113-114`), migrates
(`:116-117`), reloads PM2 (`:135-137`) under `set -euo pipefail` (`:103`). A failed migration aborts
before reload, so dropping the table in the same deploy that introduces new code can strand the
already-running old process against a missing relation.

Scoped blast radius (narrowed from an earlier overstatement): the affected surfaces are
`/forecast/species`, `/forecast/data`, and `/species/[code]` **when an origin is set** — not the
main `/forecast` route, which never touched centroids.

```sql
DROP TABLE IF EXISTS region_centroids;
```
No rollback needed; it held a cache.

---

## Phase 7 — Loader parallelization → **owned by `td-3bf3a2`**

Changing execution order, batching N+1s, and parallelizing two `species_frequency` queries *is*
`td-3bf3a2`'s stated scope ("query shape, repeated work, execution order"). Ownership transfers
there rather than being claimed as deferred. **The regions work does not depend on it.** Findings
handed over, with corrections:

- `species/[code]/+page.server.ts`: fold `verifiedHotspotLocIds` (`:160`, no data dependency) into
  the `Promise.allSettled` at `:131`. The loop at `location-placeids.ts:293-304` is **5 live Google
  calls + 5 result writes** (not 10 writes), wrapped by a bulk upsert and three reads at `:307-325`.
  Blind `Promise.allSettled` preserves call volume but **raises burst rate** against Google and
  concurrent DB use — use a small explicit concurrency limit, preserve per-location status writes,
  and measure.
- `forecast/species/+page.server.ts`: `rankLocsForSpeciesMonth` (`:358`) and `bestMonthsByLoc`
  (`:364`) are independent, back-to-back, and both hit the 1.47 GB `species_frequency`.
- `forecast/data/+page.server.ts`: fold `nextScan` (`:190`), `credsRow` (`:199`), `homeRow` (`:209`)
  into the existing `Promise.all` (`:160-186`); batch the per-group `frequencyMeta`/`attemptMeta`
  (`:456-499`).
- `forecast/+page.server.ts`: `geocodePlace` (`geocode.ts:99`) is uncached live Google, 2 sequential
  calls at 10 s timeouts, gating everything. Cannot be streamed away (the header needs the resolved
  name) — a caching candidate.

---

## Phase 8 — Navigation progress bar

- **`src/lib/components/ProgressBar.svelte`** — determinate. There are **four render sites across
  three route components**, not two: `forecast/+page.svelte:768`, `forecast/data/+page.svelte:1018`,
  and **two** in `forecast/species/+page.svelte:548` and `:567`, with a third duplicated CSS block at
  `forecast/species/+page.svelte:1079`. Refactor all four or do not claim deduplication.
- **`src/lib/components/NavProgress.svelte`** — indeterminate, mounted once in `+layout.svelte`.
  Driven by `navigating` from `$app/state`, which today is imported **only** at
  `job-poll.svelte.ts:19` and used only as an invalidation gate (`:149`, `:209`) — no UI uses it,
  which is precisely why a slow load reads as a dead link. 150 ms delay before appearing, 200 ms
  hold after completion.
- **Geometry, against the layout's real stacking order** (verified in `+layout.svelte`):
  `position: fixed; top: 0; left: 0; right: 0; height: 3px; pointer-events: none;` with
  **`z-index: 1050`**. `.top-nav` is fixed at `z-index: 1000` (`:188-194`, `height: var(--nav-h)`
  = 56 px), and the drawer **scrim** already occupies `z-index: 1100` with `inset: 0` (`:304-307`),
  the drawer 1101. 1050 is above the nav and below the scrim; anything ≥1100 ties with a
  full-viewport overlay and paints by DOM order. `.job-chip` is flow content inside `<main>`
  (`:168-170`), not fixed, so it cannot collide. `.bottom-nav` (`z-index: 1000`, `:408-413`) is
  untouched — the bar stays at the top on mobile, above the safe-area inset.
- **Reduced motion is a correctness issue**: `app.css:60-64` sets `animation:none !important` and
  `transition:none !important` globally, so a CSS-keyframe bar would **freeze at its initial width**
  — a stuck bar is worse than none. Drive width from `$state` on a JS interval; the CSS transition
  is polish the global block may correctly remove.
- `role="progressbar"`, `aria-label="Page loading"`, **no `aria-valuenow`** (correct for
  indeterminate), plus a throttled visually-hidden `aria-live="polite"` "Loading"/"Loaded".
- **`src/lib/nav-progress-core.ts`** — delay/trickle as pure functions, unit-tested without a DOM,
  mirroring the existing `job-poll.svelte.ts` / `job-poll-core.ts` split.

---

## Phase 9 — Streaming the three pages

Zero `{#await}` blocks exist in the repo — establish the pattern deliberately, once.
Installed SvelteKit is **2.65.0**.

**Error contract.** Rejected deferred values pass through `handleError`
(`data_serializer.js:33-39,154-180`); this repo exports no `handleError`, so an unexpected error
reaches the client as `{message:'Internal Error'}`. **Therefore `{:catch}` cannot carry a safe
domain message**, and every streamed promise resolves to a discriminated result and never rejects:
```ts
type Streamed<T> = { ok: true; data: T } | { ok: false; error: string };
```
The loader attaches its own `.catch()` using the same `err instanceof EbirdError ? err.message : "…"`
ladder that already produces `nearbyError` / `statesError` / `countyError` / `hotspotError`.
`{:catch}` remains only as a last-resort generic.

Two corrections to the earlier rationale: the serializer attaches its own catches, so a streamed
server-load promise is **not** left as a Node unhandled rejection; and devalue's replacer detects
promises **recursively** in 2.65.0, so top-level-only is a design convention here, not a runtime
limitation. Streamed data is still unavailable during SSR, so nothing in `<svelte:head>` may depend
on it (the `<title>` uses `data.taxon`, which stays awaited).

**Reserved space is mandatory, not polish.** The repo has **no skeleton or spinner vocabulary** —
`src/lib/components/` has 15 components and none is a loading primitive. Streaming `countyAnalysis`
or `nearby`/`tide` into empty nothingness drops the footer and every card below by several hundred
pixels mid-read. Every `{#await}` pending branch renders a **`.skeleton` placeholder with a
`min-height` matching its settled content's typical height**, so the shell's final layout is the
streamed layout. One small primitive (`src/lib/components/Skeleton.svelte` + a shared class), used
by all three pages. Under `prefers-reduced-motion` it must be a **static** block with a visible
border — `app.css:60-64` kills the pulse with `animation: none !important`, which would otherwise
freeze it at whatever the keyframe's initial state happens to be.

**Failure granularity.** Secondary sections (`tide`, `nearest`) fail as a muted inline notice, in
the same register as today's `nearbyError`. Primary sections (`countyAnalysis`, `childTotals`) get a
visible inline error card with the actionable reason. A failed section never blanks the page and
never fails silently.

- **`/species/[code]`** — shell keeps `taxon`, `seen`, `photos`, `enrichment`, **and the teaser**
  (pure DB after Phase 5, and it is the card the page exists for). Stream `nearby`, `nearest`, `tide`.
- **`/forecast/species`** — shell keeps pickers, search, region header, main chart. Stream
  `countyAnalysis` and `countyHotspots`.
- **`/forecast/data`** — shell keeps the inventory query (`:160`). Stream `childTotals`,
  `corrections`, `failed`.
- **`invalidateAll()` interaction:** `jobsPoll` invalidates on job completion, re-running loaders and
  resetting streamed sections to pending; `/forecast/data` is both the page it affects most and the
  one with the most to stream. Hold the last resolved value in `$state` and swap only when the new
  promise resolves. Verify by queueing an `analyze_counties` job and watching a full poll cycle.

---

## Ordering

| # | Phase | Depends on | Ships alone | Rollback |
|---|---|---|---|---|
| 0 | Revert + breadcrumb | — | yes | `git revert` |
| 1 | Instrumentation | — | yes | revert |
| 2 | Generator + `0043`/`0044` | — | yes (inert) | migration `DROP TABLE regions` |
| 3 | Accessor + labels + validation + **worker guards** | 2 | yes | revert; table stays unused |
| 4 | `0045` shape CHECK + generated column + FK | 2, 3 | yes | migration dropping constraints + column |
| 5 | Teaser peers + delete centroid machinery | **4 live on prod** | yes | revert |
| 6 | `0046` drop `region_centroids` | **5 live on prod** | **must be its own deploy** | none needed |
| 7 | Parallelization | — | **transferred to td-3bf3a2** | — |
| 8 | Progress bar | — | any time | revert |
| 9 | Streaming | 8 | yes | revert |

The two hard sequencing rules: **the FK precedes the deletions it justifies**, and **the drop is its
own deploy**. Everything else is order-flexible.

**Worker risk:** `warm_centroids` never reached prod, so no prod job rows exist. Phase 5's only
worker touchpoint is deleted in Phase 0. Phase 4's residual risk — an `analyze_counties` job hitting
the FK — is covered by the Phase 3 guards, which land first by design.

---

## Verification

**Every phase:** `npm run check` at 0 errors, `npm run build`, full suite against the Phase 0 baseline.

**Tests that die:** `ebird-region.test.ts` (whole file); `forecast.test.ts` centroid + warm-job
describes and the `fetchRegionCentroid` mock plumbing; `job-handlers.test.ts` `warm_centroids`
describe; the centroid-constraint and `warm_centroids` cases in `forecast-db.test.ts`.

**Rewritten:** `pickNearestTeaserCandidate` tests keep nearest-wins and tie-breaks, re-pointed at a
coordinate map; delete the "bails when a pool member lacks a centroid" and `excluded` cases,
replaced by one test documenting why they became unreachable. `sortByProximity` loses its
unknown-distance case.

**New unit:** `regions.test.ts` — label rules incl. unknown → `null`; `validateRegionCode` accepts
country/sub1 and rejects sub2/unknown; concurrent first callers issue exactly one query; **a
rejected first load is not cached — a retry succeeds**; `localeCompare` ordering.
`teaser-view.test.ts` — peer assembly, same-region collapse, no-origin single row, never a
null-distance "Closest". `nav-progress-core.test.ts` — incl. width advancing with transitions disabled.
Worker: `analyzeCountiesLocs` returns exclusions; **the all-excluded branch reports skipped, not
ready**; `23503` is translated to the actionable message.

**New DB-gated** (`regions-db.test.ts`, reusing the skip-if-down harness at `forecast-db.test.ts:44-52`):
countries ≥ 240, total ≥ 4,000; every subnational1 parent exists and is a country; no NULL
coordinates; spot checks (`US-FL`, `DK-05`, `IS`, `IS-1`, `SE-AB` = `Stockholms län`, pinning the
`[SE-01]` artifact fix). **The invariant on restored prod data:** pre-flight returns zero rows;
`('ZZ-QQ','region')` rejected with `23503`; `('US-FL-999','region')` **accepted** (parent seeded);
`('ZZ-QQ-999','region')` **rejected** (parent not seeded — this is the case the old NULL-bypass
design would have let through); a malformed `('US-FL-1-2-3','region')` rejected by the shape CHECK;
a hotspot row accepted.

**Manual, on `npm run dev:test` at :5178** (no loader test harness exists — do not invent one):
walk `/species/gbbgul`, `/forecast/species`, `/forecast/data`, `/hotspots/[locId]`. Confirm two
teaser tabs with country-qualified names, `/forecast/species` prose showing **bare** "Florida",
pickers working **with the eBird key removed**, `Stockholms län` without `[SE-01]`, and streamed
sections surviving a `jobsPoll` invalidation.

**Accessibility and layout checks** (the parts unit tests cannot reach):
- Teaser tabs: arrow-key navigation, roving tabindex, `aria-selected` tracking, and the "Where
  should I go?" link announced as part of the panel when the tab changes.
- Nav bar with **reduced motion forced** — it must still advance (a frozen bar is worse than none).
- Nav bar **with the drawer open** — it must sit above `.top-nav` and below the scrim.
- Streamed sections at 320 px width: measure scroll position before and after each section settles.
  **Any visible downward jump means the skeleton's `min-height` is wrong.**
- Breadcrumb with a long common name at 320 px: scrolls inside `.crumbs`, does not wrap or push
  the page horizontally.

**Objective record:** the Phase 1 `perf` line (shell **and** body-complete) before and after Phases
3 and 9, written to `docs/devlog/`. Claim no improvement that is not in those numbers.

**Prod:** deploy per phase via `scripts/deploy-to-DO.sh` (health-gated), owner's explicit go each
time, CODEX/GROK review gate before each deploy per repo convention. Phase 6 is its own deploy.
