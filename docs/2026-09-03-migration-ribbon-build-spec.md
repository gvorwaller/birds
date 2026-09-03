# Migration ribbon — build spec (td-59c2d0, three child tds)

**Status:** BUILD SPEC rev 3.5 (2026-09-03). Rev 3.5: two re-check P2s (unseed lock, phone hint copy) in the Rev 3.4 ledger. Rev 3.4: CODEX1's TD-C gate (REJECT at 5fbc0d7)
found the mockup oracle itself never carried the owner's P1-7 phone rule (rows own the
band, the scrubber owns the month, 48px rows in every phone view) and ordered the
readout's small-sample line before the zero line; oracle corrected, contract restated
in the Rev 3.4 ledger. Rev 3.3: one stale number in the TD-C geometry test
line (44 → 48 px), caught by the TD-C implementer. Rev 3.2 folds CODEX1's TD-B deploy-gate
REJECT (2 P1 / 3 P2 / 1 P3, each verified by CC1) — chiefly a fourth cell state, `thin`;
see the Rev 3.2 ledger. Rev 3 fixes a P1 CODEX1 found after rev 2
and the gate pins from its TD-A review (see "Rev 3 changes"). Rev 2: Rev 1 was
written by the `planner` agent from the design record rev 9 and the mockup, then
reviewed by CC1. Rev 2 folds CODEX1's unrestricted deep review: verdict on rev 1
was NOT READY, 7 P1 + 12 P2 + 3 P3; every checkable finding was verified by CC1
against the seed, the code and the test file before folding (all CONFIRMED).
The two owner decisions CODEX1 flagged were made 2026-09-03 and match the
defaults written here (obey cs.md; thin countries excluded and the cell hatched).
Nothing in `src/` has changed.

## Rev 3.4 changes (2026-09-03, CODEX1 deploy gate on TD-C: REJECT, all verified)

| # | Finding | Fix |
|---|---|---|
| P1 | Under 640px the pointer surface picked band AND month with 22px rows in World/All, against the owner's P1-7 decision. The mockup oracle had the same defect. | Contract: below 640px (a `phone` flag sampled from `matchMedia('(max-width: 639px)')`, not `!wide`) rows are `ROW_H_TOUCH` in EVERY view and pointer picks are band-only: y→band, month untouched, cont = null in World / the continent under x in All / the single continent. Tablets 640-1023 keep compact rows and cell picking. `geometry(s, avail, wide, phone)`, `pickCell(s, geom, x, y, bandOnly)`. Oracle fixed the same way. |
| P1 | The drill effect served a cached cell before bumping the request generation, so an in-flight fetch for the previous cell could land under the new heading. | Generation is bumped before the cache check; the decision lives in the pure coordinator and the in-flight-A → cached-B race is pinned. |
| P2 | The fixture marker survived `test-db-reset.sh` and was not bound to the database, so seed → reset → prod restore → unseed would delete real rows. | Marker carries the database OID and postmaster start time; unseed refuses on mismatch and verifies in its transaction that the marker's rows are the only contributors; reset removes the marker. |
| P2 | `readout` tested `n < LOW_N` before `f === 0`, printing "0% reporting rate · small sample" for a zero the server classifies `low: false` and the chart fills solid grey. Oracle shared the order. | Branch on the server's `low`; `{f:0,n:39}` reads "0% — surveyed, no reports" under both weightings. Oracle fixed. |
| P2 | `drillNote` / `selectedRegionCode` survived band, continent and species changes. | Cleared whenever the drill identity (species, band, cont) changes; pinned. |
| P2 (re-check) | `unseed` validated and then deleted under READ COMMITTED with no lock, so a concurrent rebuild could add a contributor between the check and the DELETE. | `LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE` on every touched table right after BEGIN with a 5 s `lock_timeout`; the header explains why that makes check-and-delete atomic. |
| P2 (re-check) | The tap hint still read "Tap a square to see that month's reporting rate" on phones, and About said the chart works the same way on a phone as on a desktop. | Hint has two variants on the `phone` flag — phone: "Choose a month with the slider, then tap a latitude row to see its reporting rate and the regions behind it; darker green means it was reported more often."; ≥640px: the original sentence. About names both behaviours. Oracle carries the same two variants. |

## Rev 3.2 changes (2026-09-03, CODEX1 deploy gate on TD-B: REJECT, all verified)

| # | Finding | Fix |
|---|---|---|
| P1 | An equal-weight cell whose every country is under 40 checklists returned `null` — the "nothing loaded" state — so a surveyed thin cell would draw as a slash. The owner's exclude-and-hatch rule did not cover the all-thin case. | Fourth state: `RibbonCell.state: 'reported' / 'zero' / 'thin'`. `thin` = surveyed but no country reached 40: `{ f: 0 (placeholder, never a rate), n: Σ, state: 'thin', low: true, excluded }`. TD-C draws the hatch with no colour bin; readout "Surveyed — too few checklists to rate" + "N countries under 40 checklists". `null` stays nothing-loaded. Under checklist weighting `thin` never occurs. Pinned: all-thin reported / zero / world / mixed. |
| P1 | The 40 KB byte gate was measured on an 8-region fixture (2.2 KB) and cannot be inferred to production. | Measured from production source tables for Rock Pigeon 2026-09-03 (td-c6b113 comment): 455 of 1,728 grid slots occupied; grid-shaped payload raw 100,787 B / gzip 959 B with a repeated cell; fully dense worst case gzip 1,331 B. The byte test measures the widest existing species on a restored cluster instead of hard-failing. |
| P2 | `Number("")` is 0, a valid band, so a missing `band` reached the query. | Reject empty/blank before numeric conversion; route cases for missing and blank. |
| P2 | Region labels are read after the snapshot commits, via the process-wide regions cache. | Contract narrowed honestly: the snapshot covers the two mutable reads; labels are static reference data outside it. |
| P2 | The byte test throws on a prod-restored cluster. | Non-destructive path: measure the widest existing species, never hard-fail. |
| P3 | `ribbonRegions` and the loader's discriminated result were source-review-only. | Direct DB test for ribbonRegions (filter, ALL, n=0 drop, sort, cap, total/capped, makePeer parity) and a loader test. |

## Rev 3 changes (2026-09-03, after TD-A was built)

| # | Finding | Fix |
|---|---|---|
| CODEX1 P1 (post-rev-2) | The antimeridian CASE tested `min_lon > max_lon`, but the seed never encodes a wrap that way: eBird returns a conventional near-global envelope and the generator preserves it (US-AK min_lon −179.15, max_lon 179.77; 0 seeded rows use min>max, 12 have a >180° envelope). The CASE never fired; US-AK stayed EAST; the committed test invented a min>max box. | Wrap = `min_lon > max_lon OR max_lon − min_lon > 180`; lon_eff = complementary-arc midpoint (US-AK → −179.69). Only subnational1 rows of US/CA/MX split; country rows never (`west=false`). Test pinned to the real encoding. Verified on live rows: AK/HI/ND/YT/BC/SON west; NE/NJ/YUC east; US/CA/MX country rows false. |
| CODEX1 gate P2-1 | `/api/health` only proves a fresh heartbeat; it cannot tell the new paused worker from the old one. | Before resuming: authenticated `/api/admin/status` must show `alive=true`, `version=<deployed SHA>`, `state=paused`, `currentJobId=null`, `pauseRequested=true`. Never resume the OLD worker against 0050. If deploy aborts after 0050 is recorded, leave the worker paused and roll forward or use 0051. |
| CODEX1 gate P3-1 | "≤1.5 M rows at world coverage" was a ceiling with no evidence. | Stated as a projection: ~1.8 M by straight-line scaling of 425,820 at 793 contributors. |
| CODEX1 gate P3-2 | The reconciliation test does EXCEPTs against live tables, not the temp-schema copy the spec described. | Acceptance wording matches the test as built; the migration-vs-rebuild agreement is additionally proven by GROK's empirical run at deploy gate. |

## Rev 2 change ledger (CODEX1 review, all verified)

| # | What was wrong | Fixed where |
|---|---|---|
| P1-1 | Seed has **252** countries, not 251; Côte d'Ivoire (`CI`, 0044:562) was missing from the map. CC1's count used a grep that broke on the doubled apostrophe in `Côte d''Ivoire`. | TD-A map: CI→AF (AF 58, total 252). Completeness test compares the exact code set parsed from 0044, not a count. |
| P1-2 | Three separate `query()` calls are not a snapshot (`src/lib/db.ts:28-35` is pool.query per call; `withTransaction` :104-112 is plain READ COMMITTED). A country rebuild committing between reads publishes a false frequency. | TD-B: all reads for one grid run on a `REPEATABLE READ, READ ONLY` transaction via a new `withReadSnapshot()` in db.ts; same for the drill's two reads. Test: two clients, commit between reads. |
| P1-3 | Migration runs before pm2 reload, so the OLD worker writes during and after the backfill; "quiet moment" is not a lock. | TD-A deploy: admin worker pause (`src/worker/index.ts:140-148`, state=paused, currentJobId=null) held through migrate + new-worker health, then source-vs-rollup reconciliation, then resume. Same for rollback. |
| P1-4 | The Best-time card dereferences `ft` at `+page.svelte:449,451,464,482,493,513,514`; `reduced` does not exist in that file; `getElementById('besth')` can be null before the card exists. | TD-C: every `ft.` use becomes `cardPeers`/`ft?.`; local reduced-motion; `onChartRegion` awaits `tick()`; `best=null` copy; a test for forecastTeaser=null + chart selection. |
| P1-5 | forecast-db.test.ts seeds QZ-A/B/C for the whole describe and QZ/ZZ are fixture countries in `regions`, so "QZ country-only" is never true and `unmappedCountries()` is never empty. | TD-A tests: isolated codes (`QY*`, `ZY*`) with their own setup/teardown; map completeness validated statically against 0044. |
| P1-6 | `west` is materialised globally; NZ-CI (lon -176) is west while the rest of NZ is east, UM likewise, so a same-country pair outside NA would count twice under equal weight. | TD-B: coalesce `(band, column, country)` by Σnum/Σn before any equal averaging; NA halves stay separate (different columns); world merges by country + base continent. OC vector added. |
| P1-7 | 44px rows, a 720px breakpoint and `touch-action: pan-x` (mockup:91) violate cs.md:79-84 (640/1024 only, ≥48px) and trap vertical scroll on a tall phone SVG. | **Owner decided: obey cs.md.** — 640/1024, 48px rows, both-axis native scroll, select on pointerup after a movement threshold. |
| P2-1 | Endpoint grammar `^[a-z0-9]{3,12}$` rejects codes the app accepts (`validSpeciesCode`, wikidata.ts:63: `/^[a-z][a-z0-9-]{1,14}$/`). | TD-B: reuse `validSpeciesCode`. |
| P2-2 | Low-sample from summed n is wrong under equal weight (A: 100 %, n=1; B: 0 %, n=10,000 → "well-sampled 50 %"). | **Owner decided:** a country with n<40 does not vote; if any country was excluded the cell is hatched. |
| P2-3 | `role=group` has no accessible name; `chartAria` computes world cells in continent view and says "reported" for a ≥0.5 % predicate; `aria-live` fires every 750 ms during Play. | TD-C: `aria-labelledby` the card heading; aria over the drawn view with "at least 0.5 %"; live region suppressed for timer-driven changes. |
| P2-4 | Lifecycle: ResizeObserver/debounce/resize fallback not cleaned; AbortError overwrites newer selection; unbounded regionsCache; reduced-motion flipping on mid-play. | TD-C: all cleaned on unmount; generation guard; cache cleared on species change; playing=false on reduced-motion change. |
| P2-5 | Only `band_locs` cascades from `frequency_fetch`; a delete leaves stale aggregates. Raw DROP rollback breaks cs.md's migration rule. | TD-A: deletes of `frequency_fetch` region rows must go through a helper that rebuilds the owning country; rollback is a tracked forward migration under worker pause. |
| P2-6 | `f=0.01` sits in the "<1 %" bin while `pct(0.01)` prints "1 %". | TD-C: exclusive upper bounds (`f < max`); label and colour pinned together in one test. |
| P2-7 | Tests exercise `rebuildBandRollup`, never the migration's backfill copy. | TD-A: post-backfill bidirectional `EXCEPT` reconciliation for all four quantities, run after backfill and as the deploy gate. |
| P2-8 | Payload claim informal; slots are 2×[(18×8×12)+(18×12)] = 3,888. | TD-B acceptance: SSR byte ceiling (≤ 40 KB gzip for the ribbon property) and a shell-latency assertion. |
| P2-9 | All-year gap renders as a 12-name list. | TD-C: "Year-round" copy, tested. |
| P2-10 | Unmapped countries only reach a server log; loader catch-and-null makes "nothing loaded" and "broken" look identical. | TD-B/TD-C: inline "data omitted for …" warning; loader returns a discriminated `{ ok:false, error }` that the card renders as a one-line failure, never as absence. |
| P2-11 | Event-to-reducer wiring unspecified (pointer capture vs scroll, manual month stops Play, Enter, HTTP !ok). | TD-C: wiring table + tests. |
| P2-12 | Help/About "update" too vague. | TD-C: required Help sentences listed; About needs a new `openVersions` key and the `current` badge moved. |
| P3-1 | Mockup `worldCell` still half-averages until Step 0. | Unchanged: Step 0 fixes it before any numeric UI comparison. |
| P3-2 | Rollups erase the year window. | Help sentence: the ribbon combines each region's stored window. |
| P3-3 | Literal 793 drifts. | Deploy check compares `band_locs` to the contributor CTE and reports the diff. |

Also found by CC1 while verifying P1-6: the committed seed has at least one
impossible longitude (`NZ-NTL` Northland at -2.02, real ≈ 174 E). Filed
separately; the split rule must not trust `lon` blindly — see TD-A.

## Context

The design is done and committed (e010c8f): `docs/2026-09-02-migration-ribbon-plan.md`
rev 9 plus the verified mockup `docs/mockups/species-migration-ribbon.html`, after
four review rounds (CODEX1 mechanics, AGY UX, GROK hostile, CODEX1 usability). The
owner was about to shelve the feature and now wants it built.

Workflow the owner chose: the `planner` agent writes a file-by-file spec (done,
below); the `implementer` agent builds each tracker item; CC1 post-reviews each
against the mockup's numbers; CODEX1 + GROK gate the deploy; the owner gives the
deploy word and approves tds himself. Split into three child tds under td-59c2d0,
shipped in order, each independently deployable:

1. **TD-A Data** — migration 0050: three ribbon-grain rollup tables maintained in
   the same transaction as 0049's monthly rollup, backfilled once. Invisible.
2. **TD-B Server** — `speciesRibbon()` grid (both weightings precomputed) in the
   species page loader, plus a GET endpoint for the per-band region list.
3. **TD-C UI** — `MigrationRibbon.svelte` + a pure `migration-ribbon.ts`, card
   above "Best time of year", selected region becomes a third peer tab there.

Out of scope, tracked elsewhere: world loader (one resumable job), td-11aeb7
(centroid grain), td-4b5248 (0049 comment), td-a47c0d (system-health page).

## CC1 review of the planner's spec — decisions (verified 2026-09-03)

The planner corrected my brief in five places; I re-derived each from the fixture
and the code before accepting.

- **World-row equal weight = MERGE, not half-average.** My NA east/west split
  (WORLD_GROUPS in the mockup) silently changed the world row: it averages the two
  NA *column* values, so Osprey 20-30°N Jan reads 9.43 % on screen today, whereas
  the number GROK verified before the split, 16.12 %, treats NA's countries as one
  continent. Re-derived: merge 16.12 % / 5.25 %, half-average 9.43 % / 2.99 %.
  The owner's ruling was "NAW+NAE count as ONE continent for the world row"; a
  column layout must not change the world number. **Build merge. Fix the mockup's
  `worldCell` to match (Step 0), so the oracle and the code agree.**
- **The rollup key carries `west`** (`regions.lon < -100`), because US/CA/MX all
  have regions on both sides of 100°W inside one band; continent stays in a
  static map applied at query time. Accepted; my "apply the split at query time
  from lon" was impossible at (band, country) grain.
- **Country-only countries contribute their country row**; a country with any
  loaded subnational1 contributes only those. Measured: 788 sub1 + 40 country
  rows, 35 overlap, 5 country-only (AQ, AI, AW, AS, AC); 56 childless in the seed.
  Recompute is therefore per COUNTRY, not per location.
- **`reached` column** (regions at ≥0.5 % that month) so the gap note is
  region-grain while `speciesRibbon` reads only band tables. PRESENT is baked in;
  the header says so.
- **`band_locs` table** as the single source for membership and counts.
- Seed has **251** countries (not 252). `parseRegionCode` (`src/lib/region-code.ts`)
  returns `{ level, … }`, so the no-op guard for counties/hotspots is valid.

Open questions the planner raised, decided here (none needs the owner):
attribution ships as "Data from eBird.org" (band tables carry no year range);
`rangeNote` is omitted (no source in the app); loader failure is catch-and-null
with a server log, matching the page's streamed-error philosophy.

## Owner decisions (from CODEX1's review) — DECIDED 2026-09-03, both as the defaults

1. **cs.md compliance for the chart (P1-7).** Rev 1 used 44 px rows, a 720 px
   breakpoint and `touch-action: pan-x`. cs.md allows only 640/1024 and ≥ 48 px, and
   the touch rule traps vertical scrolling on a phone. CODEX1 recommends obeying
   cs.md; so does CC1. Default in this spec: obey. Alternative: an explicit waiver
   for this chart, recorded in the design record.
2. **Low-sample rule under Equal weight (P2-2).** Summed n hides a one-checklist
   country that owns half the estimand. Default in this spec: a country with fewer
   than 40 checklists that month does not vote, and the cell is hatched if any
   country was excluded. Alternative: include it and hatch the whole cell.

## Step 0 — mechanics once this plan is approved (CC1, not the implementer)

1. Fix the mockup: `worldCell` in `docs/mockups/species-migration-ribbon.html`
   must merge NAW+NAE countries before averaging continents (build
   `CountryCellInput` groups by base continent), so the on-screen world row
   returns to 16.12 % / 5.25 %. Also set its country count to 252, remove
   `touch-action: pan-x`, and apply the two owner decisions once made. Re-verify
   with the fixture. No numeric UI comparison goes to the implementer before this
   commit lands (CODEX1 P3-1).
1b. File a P3 td: the 0044 seed's centroid longitude is wrong for every region
   whose bounding box crosses 180° (`US`, `US-AK`, `NZ`, `NZ-NTL`, `FJ`, `FJ-N`,
   `FJ-E`, `AQ` measure ≈ 0). CC1 earlier said `US-AK` 0.31 came from its fixture
   export; that was wrong — it is in the committed seed. Fix the generator's
   centroid for wrapped boxes and re-emit a delta; the TD-A CASE guards until then.
2. Place this spec at `docs/2026-09-03-migration-ribbon-build-spec.md` (rev 1,
   status header in the house style), regenerate nothing.
3. Create the three child tds with `--parent td-59c2d0`, `--depends-on` chain
   (B→A, C→B), `--acceptance-file -` from the Acceptance blocks below,
   `--labels ribbon,...`; `td link` the files listed per td; `td comment`
   td-59c2d0 pointing at the spec.
4. Commit docs + tracker changes (no src/ changes; `npm run check` first).
5. Hand TD-A to `implementer` with the spec path and the td id.

---

# The spec

Design record: `docs/2026-09-02-migration-ribbon-plan.md` (rev 9). Oracle:
`docs/mockups/species-migration-ribbon.html` inline script (after Step 0's
worldCell fix). Vectors: `docs/mockups/ribbon-prod-curves.js`.

Cells with nothing loaded / no checklists that month are serialised as `null`, not
`{state:'empty'}` (at world coverage most of 3,456 cells × 2 modes are empty).

---

## TD-A — Data: ribbon rollup tables (migration 0050)

**td:** `td create "Ribbon rollup tables: species_band_month_freq / band_month_samples / band_locs (0050)" --type feature --priority P2 --parent td-59c2d0 --labels ribbon,db,migration`

### Files

**CREATE `backend/db/migrations/0050_species_band_rollup.sql`** — shape of 0049: prose header (WHY: plan blocking item 1, 120-365 ms per page load, 394,466 rows measured at 788 regions; WHAT: three tables; WHY NOT: no matview, no species-leading index on `species_month_freq`; note PRESENT baked into `reached`; record the ACTUAL backfill count after the prod EXPLAIN — the 0049 "~364 K" lesson), **no BEGIN/COMMIT** (`backend/db/migrate_pg.sh:155-163` wraps), explicit GRANTs, backfill in-file, ANALYZE.

```sql
CREATE TABLE band_locs (
    band     SMALLINT NOT NULL CHECK (band BETWEEN -90 AND 80 AND band % 10 = 0),
    country  TEXT     NOT NULL REFERENCES regions(code),
    west     BOOLEAN  NOT NULL,            -- regions.lon < -100 (NA east/west split)
    loc_code TEXT     NOT NULL REFERENCES frequency_fetch(loc_code) ON DELETE CASCADE,
    PRIMARY KEY (band, country, west, loc_code)
);
CREATE TABLE band_month_samples (
    band    SMALLINT NOT NULL CHECK (band BETWEEN -90 AND 80 AND band % 10 = 0),
    country TEXT     NOT NULL REFERENCES regions(code),
    west    BOOLEAN  NOT NULL,
    month   SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
    n       DOUBLE PRECISION NOT NULL CHECK (n >= 0),   -- Σ loc_month_samples.n
    PRIMARY KEY (band, country, west, month)
);
CREATE TABLE species_band_month_freq (
    species_code TEXT     NOT NULL,
    band         SMALLINT NOT NULL CHECK (band BETWEEN -90 AND 80 AND band % 10 = 0),
    country      TEXT     NOT NULL REFERENCES regions(code),
    west         BOOLEAN  NOT NULL,
    month        SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
    num          DOUBLE PRECISION NOT NULL CHECK (num >= 0),  -- Σ species_month_freq.num
    reached      SMALLINT NOT NULL CHECK (reached >= 0),      -- regions with num/n >= 0.005
    PRIMARY KEY (species_code, band, country, west, month)
);
-- The per-country rebuild deletes by country; the PK is species-leading for the
-- page read, so without this the DELETE is a seq scan that grows with coverage
-- (~1.5 M rows at world load). band_month_samples/band_locs are ≤ 60 K rows: PK only.
CREATE INDEX species_band_month_freq_country_idx ON species_band_month_freq (country);
GRANT SELECT, INSERT, UPDATE, DELETE ON band_locs, band_month_samples, species_band_month_freq TO birds_app;
```

**Prod pre-flight, measured 2026-09-03 (read-only EXPLAIN ANALYZE, 788 sub1 + 5
country-only contributors):** the `species_band_month_freq` backfill SELECT runs in
**5.07 s** and produces **425,820 rows** (the earlier 394,466 was the coarser
`(species, band, country, month)` grain; the extra rows are the `west` split and the
country-only countries); `band_month_samples` **0.20 s, 996 rows**; `band_locs`
793. The big statement SPILLED to temp files under this cluster's 4 MB `work_mem`,
so the migration must start with `SET LOCAL work_mem = '256MB';` (legal inside the
wrapper transaction, scoped to it). Write the measured 425,820 into the header —
and re-measure at deploy time, since coverage is still growing.

Backfill (identical arithmetic to `rebuildBandRollup`, unparameterised; preceded by `SET LOCAL work_mem = '256MB';`):

```sql
WITH sub1 AS (
  SELECT ff.loc_code, r.parent_code AS country, r.lat, r.lon
    FROM frequency_fetch ff JOIN regions r ON r.code = ff.loc_code
   WHERE ff.loc_kind = 'region' AND r.level = 'subnational1'),
country_only AS (
  SELECT ff.loc_code, r.code AS country, r.lat, r.lon
    FROM frequency_fetch ff JOIN regions r ON r.code = ff.loc_code
   WHERE ff.loc_kind = 'region' AND r.level = 'country'
     AND NOT EXISTS (SELECT 1 FROM sub1 s WHERE s.country = r.code)),
contrib AS (
  SELECT loc_code, country,
         GREATEST(-90, LEAST(80, floor(lat / 10) * 10))::smallint AS band,
         (lon < -100) AS west
    FROM (SELECT * FROM sub1 UNION ALL SELECT * FROM country_only) u)
INSERT INTO band_locs (band, country, west, loc_code)
SELECT band, country, west, loc_code FROM contrib;

INSERT INTO band_month_samples (band, country, west, month, n)
SELECT bl.band, bl.country, bl.west, lms.month, SUM(lms.n)::float8
  FROM band_locs bl JOIN loc_month_samples lms ON lms.loc_code = bl.loc_code
 GROUP BY 1, 2, 3, 4;

INSERT INTO species_band_month_freq (species_code, band, country, west, month, num, reached)
SELECT smf.species_code, bl.band, bl.country, bl.west, smf.month,
       SUM(smf.num)::float8,
       COUNT(*) FILTER (WHERE lms.n > 0 AND smf.num / lms.n >= 0.005)::smallint
  FROM band_locs bl
  JOIN species_month_freq smf ON smf.loc_code = bl.loc_code
  JOIN loc_month_samples lms ON lms.loc_code = smf.loc_code AND lms.month = smf.month
 GROUP BY 1, 2, 3, 4, 5;

ANALYZE band_locs; ANALYZE band_month_samples; ANALYZE species_band_month_freq;
```

`JOIN regions r ON r.code = ff.loc_code` is the whole source-row rule: counties (`US-FL-001`) and hotspots (`L…`) have no `regions` row, so they never match; no regex needed. `regions` is SELECT-able by `birds_app` (`0043:37-38`).

**`west` guard (rev 3):** eBird's centroid for any region whose extent crosses
180° is near 0, and the seed keeps eBird's conventional near-global envelope
rather than a min>max wrap (US-AK: min_lon −179.150558, max_lon 179.773408).
```sql
-- effective longitude: the complementary-arc midpoint when the box wraps by
-- EITHER encoding (0 seeded rows use min>max; 12 use a >180° envelope)
CASE WHEN r.min_lon IS NOT NULL AND (r.min_lon > r.max_lon OR r.max_lon - r.min_lon > 180)
     THEN ((r.min_lon + r.max_lon + 360) / 2 + 540)::numeric % 360 - 180
     ELSE r.lon END AS lon_eff
-- only subnational1 rows of US/CA/MX split; a country row never does
west = is_sub1 AND country IN ('US','CA','MX') AND lon_eff < -100
```
US-AK → −179.69 → west. Bands use `lat`, which the bug does not affect.
td-57d9fc fixes the generator; this CASE is the guard until then.

**Deleting a loaded region (CODEX1 P2-5):** only `band_locs` cascades from
`frequency_fetch`; `band_month_samples` and `species_band_month_freq` do not, so a
raw `DELETE FROM frequency_fetch` leaves stale aggregates. Add
`deleteFrequencyLocation(locCode)` in barchart.ts that deletes inside
`withTransaction` and then calls `rebuildMonthRollup` + `rebuildBandRollup` for the
owning country; grep the repo for direct `DELETE FROM frequency_fetch` (admin
refresh/retry paths, tests) and route them through it.

**CREATE `src/lib/server/data/continents.json`** — `{ "US": "NA", … }`, all **252** seeded countries (0044 has 252 `level='country'` rows; count them with a parser that tolerates `''` in names, not a naive grep). Assignment follows the GeoNames `countryInfo` continent column (Central America + Caribbean in NA, Russia/Cyprus in EU, Türkiye/Caucasus in AS, sub-Antarctic islands in AN). Validated against the 0044 seed: 252/252, no duplicates:

- **NA (42):** AG AI AW BB BL BM BQ BS BZ CA CP CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT US VC VG VI
- **SA (14):** AR BO BR CL CO EC FK GF GY PE PY SR UY VE
- **EU (52):** AD AL AT BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK
- **AF (58):** AO BF BI BJ BW CD CF CG **CI** CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW
- **AS (51):** AE AF AM AZ BD BH BN BT CN GE HK ID IL IN IO IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE
- **OC (30):** AC AS AU CC CK CS CX FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS
- **AN (5):** AQ BV GS HM TF

**MODIFY `src/lib/server/regions.ts`** — after `regionCoords` (`:268-271`):

```ts
import continentsJson from './data/continents.json';
export type Continent = 'NA' | 'SA' | 'EU' | 'AF' | 'AS' | 'OC' | 'AN';
export type RibbonColumn = 'NAW' | 'NAE' | 'SA' | 'EU' | 'AF' | 'AS' | 'OC' | 'AN';
export const NA_SPLIT_LON = -100;
/** null for an unmapped country — callers must surface it, never drop it silently (CODEX1 P1). */
export function continentOf(country: string): Continent | null;
/** Column for a (country, west) pair: NA splits at 100°W, everything else is its continent. */
export function ribbonColumnOf(country: string, west: boolean): RibbonColumn | null;
/** Countries in `regions` (level='country') absent from the map. Empty on a healthy seed. */
export async function unmappedCountries(): Promise<string[]>;
```
In `load()` (`:49-107`), after building `countries`: compute the unmapped list and `console.error('[regions] countries missing from continents.json: …')` when non-empty. Log, do not throw; the test makes it a CI failure.

**MODIFY `src/lib/server/barchart.ts`**:
- Extend the doc contract at `:376-386`: "…must call `rebuildMonthRollup` AND `rebuildBandRollup`."
- Add after `rebuildMonthRollup` (`:415`):

```ts
/**
 * Rebuild the 0050 band rollups for the COUNTRY that owns `locCode`. Country
 * grain, not location grain: a country's contribution flips from its country
 * row to its subnational1 rows the moment the first state loads, so the only
 * safe recompute is the whole country. No-op for counties and hotspots.
 */
export async function rebuildBandRollup(
  locCode: string,
  run: (sql: string, params: unknown[]) => Promise<unknown> = (sql, params) => query(sql, params)
): Promise<void>
```
Body: `const p = parseRegionCode(locCode); if (!p || p.level === 'subnational2') return; const country = p.country;` then `DELETE FROM species_band_month_freq WHERE country = $1`, `DELETE FROM band_month_samples WHERE country = $1`, `DELETE FROM band_locs WHERE country = $1`, then the three INSERTs above with `sub1` filtered `AND r.parent_code = $1`, `country_only` filtered `AND r.code = $1` (NOT EXISTS stays), and the two aggregate INSERTs filtered `WHERE bl.country = $1`. Import `parseRegionCode` from `$lib/region-code` (`src/lib/region-code.ts:28`).
- Call site: `storeFrequencies` `:500`, immediately after `rebuildMonthRollup(...)`: `await rebuildBandRollup(p.locCode, (sql, params) => client.query(sql, params));` — same transaction, reads the month rollup just rebuilt.

Cost note: a US state store recomputes 51 regions ≈ 200 K `species_month_freq` rows via PK nested loop; worker path only, sub-second.

### Tests (extend `src/lib/server/forecast-db.test.ts`; do not add a new file that seeds `regions` — td-b29d1c is exactly that cross-file race)

CODEX1 P1-5: the existing `beforeAll` (`:157-175`) keeps `QZ-A/B/C` LOADED for the
whole describe, and `QZ`/`ZZ` are fixture countries in `regions`. So the band tests
use their OWN reserved countries — `QY` (60, −105) and `ZY` (−75, 0) with sub1s
`QY-W45` (45, −110), `QY-E45` (42.5, −80), `ZY-S35` (−33, 20) — in a nested
`describe('band rollup')` whose `beforeEach` deletes every `QY%`/`ZY%` row from
`frequency_fetch` (+ attempts) and the three band tables, and whose `afterAll` drops
the `QY`/`ZY` regions via the owner client. Extend `seedFixtureRegions` (`:79-90`)
with `FIXTURE_COORDS` and change its `ON CONFLICT (code) DO NOTHING` (`:83-86`) to
`DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon` so an interrupted prior run
cannot leave stale coordinates. `refreshRollup` (`:132-135`) must call both rebuilds.
Because `QY`/`ZY` are US-assigned codes outside `continents.json`, the band tests
pass a test `columnOf`; they never assert on `unmappedCountries()`.

- `band rollup reproduces Σnum / Σn exactly` — `QY-W45` janSamples(10,1000,7,0), weeks 1.0/0.3/0.5 (the 313.5 / 1017 vector at `:394-429`): `species_band_month_freq` (40, QY, west=false — QY is not US/CA/MX, month 1) num=313.5, `band_month_samples` n=1017, `reached`=1.
- `band rollup REPLACES, never accumulates` — rebuild twice, one row.
- `two countries in one band stay separate rows`.
- `west is true only for US/CA/MX west of 100W` — seed a temporary `US-QQW` (45, −110) and `US-QQE` (45, −80) under the existing `US-QQ` fixture parent: west=true / false; a `QY` row at −110 stays west=false.
- `an antimeridian NA region is west, using the REAL seed encoding` — seed `US-QQX` with lon 0.311425, min_lon −179.150558, max_lon 179.773408 (copied from US-AK in 0048): west=true. A second row with the 0047 min>max encoding (min_lon 172, max_lon −130) is also west. A NZ-shaped row with the same envelope is west=false (not NA). The US country row, if country-only, is west=false.
- `a hotspot and a county never touch band tables` — `US-QQ-001` and `L999` → zero band rows.
- `country-only country contributes its country row` — `frequency_fetch` row `'QY'` only → `band_locs` (60, QY, false, 'QY').
- `first subnational1 evicts the country row` — then store `QY-W45` → QY's `band_locs` is exactly `{QY-W45}`; `'QY'` gone from every table.
- `both loaded contributes ONLY sub1 rows` — `ZY` + `ZY-S35` → only `ZY-S35`.
- `reached counts regions at region grain` — region A f=0.006, region B f=0.001, same cell → reached=1.
- `deleting a loaded region rebuilds its country` — `deleteFrequencyLocation('QY-W45')` → no stale `QY` aggregate rows (P2-5).
- `backfill and rebuild agree` — after seeding, run the migration's three backfill SELECTs (as a test-local string copied verbatim from 0050) against a temp schema and `EXCEPT` both ways against the live tables for `band_locs`, `n`, `num`, `reached`: zero rows (P2-7).
- **CREATE `src/lib/server/continents.test.ts`** (pure, STATIC — never against the DB, whose fixtures include the deliberately unmapped QZ/ZZ): parse `backend/db/migrations/0044_regions_seed_20260831.sql` with a regex that tolerates `''` in names, collect every `level='country'` code, and assert `new Set(keys(continents.json))` equals that set exactly (both directions), values in the 7-set, no lowercase keys; `ribbonColumnOf('US', true) === 'NAW'`, `('US', false) === 'NAE'`, `('PF', true) === 'OC'`, `('CI', false) === 'AF'`, `('QZ', false) === null`. (P1-1, P1-5)

Known flakes for the reviewer: td-b29d1c (regions row-count race), td-c41126 (prod-restored test DB timing). Neither is touched.

### Acceptance
- 0050 applies on a fresh `test:db:reset && test:db:up` and on a prod-restored `birds_test`; no BEGIN/COMMIT; GRANTs present.
- Prod pre-flight recorded in the td: `EXPLAIN ANALYZE` of the three backfill SELECTs (read-only) with wall time and row counts; the actual `species_band_month_freq` count written into the migration header before deploy.
- `storeFrequencies` rebuilds both rollups in one transaction; `rebuildBandRollup` is a no-op for counties/hotspots; `deleteFrequencyLocation` is the only delete path.
- All new DB tests pass; the static map test passes against 0044 (252 codes); `npm run check` 0 errors.
- Post-backfill reconciliation (below) reports zero drift.
- No product code reads the new tables yet (independently deployable).

### Deploy notes (CODEX1 P1-3, P2-5, P3-3)
Migrate runs BEFORE pm2 reload (`scripts/deploy-to-DO.sh:116-136`), so the OLD
worker is live during the backfill and until reload; its commits between the
three `INSERT…SELECT` statements, or after backfill and before reload, would leave
the rollup silently inconsistent. Procedure:
1. Admin → pause worker (`set_worker_pause`); wait until `/api/admin/status` shows
   `state=paused` and `currentJobId=null` (`src/worker/index.ts:140-148`).
2. Deploy (migrate + reload). The migration transaction is short (~6 s measured
   for the backfill on 2026-09-03 coverage) but the pause must still span it and
   the reload. Before resuming, `/api/admin/status` (authenticated) must show
   `worker.alive=true`, `worker.version` = the deployed SHA, `state=paused`,
   `currentJobId=null`, `pauseRequested=true` — `/api/health` alone cannot tell
   the new paused worker from the old one (CODEX1 gate P2-1). If the deploy
   aborts after 0050 is recorded, leave the worker paused; roll forward or apply
   0051. Never resume the old worker against 0050.
3. Reconcile: run the contributor CTE from 0050 against `band_locs` both ways
   with `EXCEPT`, and recompute `n`/`num`/`reached` for a sample of 20 countries
   against the live rows; report row counts and the diff (not a literal 793).
4. Resume the worker.
Rollback is a tracked forward migration `0051_drop_species_band_rollup.sql`
(cs.md: migrations only, never raw psql) applied with the worker paused, plus the
barchart.ts hook revert in the same deploy.

### CC1 post-review checks
`west` uses the sub1's lon for sub1 rows and the country's lon for country rows; `NOT EXISTS` in `country_only` looks at `frequency_fetch` (loaded), not `regions` (seeded); DELETE order and filters all by `country`; hook placed after `rebuildMonthRollup`; `parseRegionCode` (not a regex) decides the no-op.

---

## TD-B — Server: grid aggregation, loader, drill endpoint

**td:** `td create "Ribbon server: speciesRibbon grid + ribbonRegions drill + species page loader" --type feature --priority P2 --parent td-59c2d0 --depends-on <TD-A> --labels ribbon,server`

### Files

**CREATE `src/lib/server/ribbon.ts`**

```ts
import type { MonthStat, WeekStat, BestMonth } from '$server/forecast';
export const BANDS = [80,70,60,50,40,30,20,10,0,-10,-20,-30,-40,-50,-60,-70,-80,-90] as const;
export const COLUMNS = ['NAW','NAE','SA','EU','AF','AS','OC','AN'] as const;
export const WORLD_GROUPS: RibbonColumn[][] = [['NAW','NAE'],['SA'],['EU'],['AF'],['AS'],['OC'],['AN']];
export const LOW_N = 40; export const PRESENT = 0.005;
export type Weighting = 'equal' | 'checklists';

export interface RibbonCell { f: number; n: number; state: 'reported' | 'zero' | 'thin'; low: boolean; excluded: number }
// 'thin' (rev 3.2): surveyed, but under equal weight no country reached LOW_N, so
// nothing voted. f is 0 as a PLACEHOLDER and must never be read as a rate; low is
// true; excluded counts the countries left out. Never null (null = nothing loaded).
/** null = nothing loaded, or no checklists that month (the mockup's `empty`). */
export type RibbonCellOrNull = RibbonCell | null;
export interface RibbonMode {
  cols: RibbonCellOrNull[][][];   // [bandIndex][columnIndex][month-1]
  world: RibbonCellOrNull[][];    // [bandIndex][month-1]
}
export interface RibbonGrid {
  speciesCode: string;
  modes: Record<Weighting, RibbonMode>;
  regionCounts: number[][];       // [bandIndex][columnIndex], the readout's "N regions"
  gapMonths: number[];            // surveyed somewhere, below PRESENT in every loaded region
  meta: {
    regions: number;              // band_locs rows (country row counts once for country-only countries)
    countries: number;
    columnsLoaded: RibbonColumn[];
    columnsMissing: RibbonColumn[];
    unmappedCountries: string[];  // surfaced, never dropped silently
  };
}
export interface RibbonRegionRow {
  locCode: string; label: string; country: string; column: RibbonColumn; band: number;
  curve: MonthStat[]; weeks: WeekStat[];
  peak: number;                   // max curve.freq, no n gate (mockup peakOf)
  best: BestMonth | null; peakPhrase: string | null; good: number[]; migration: string | null;
}
export interface RibbonRegions { rows: RibbonRegionRow[]; total: number; capped: boolean }  // rows ≤ 40

export interface CountryCellInput { country: string; column: RibbonColumn; num: number; n: number }
export function equalWeightCell(rows: CountryCellInput[]): RibbonCellOrNull;   // one column: mean over countries of num/n (n>0 only)
export function checklistCell(rows: CountryCellInput[]): RibbonCellOrNull;     // Σnum/Σn
export function worldEqualCell(rows: CountryCellInput[]): RibbonCellOrNull;    // MERGE: group by base continent (NAW+NAE→NA), mean over countries, mean over continents
export function classify(f: number, n: number): RibbonCell;                    // zero iff f===0; low = f>0 && n<LOW_N
export function gapMonthsFrom(samples: {month:number;n:number}[], reached: {month:number;reached:number}[]): number[];
export function bandIndexOf(band: number): number;

export async function speciesRibbon(speciesCode: string, deps?: { columnOf?: typeof ribbonColumnOf }): Promise<RibbonGrid | null>;
export async function ribbonRegions(speciesCode: string, band: number, column: RibbonColumn | 'ALL'): Promise<RibbonRegions>;
```

**Snapshot consistency (CODEX1 P1-2):** `query()` is `pool.query` per call
(`src/lib/db.ts:28-35`) and `withTransaction` opens a plain READ COMMITTED
transaction (`:104-112`), so three separate reads can straddle a country rebuild
and combine old `n` with new `num`. Add to `src/lib/db.ts`:
```ts
/** Run read-only statements on ONE snapshot (REPEATABLE READ, READ ONLY). */
export async function withReadSnapshot<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T>
```
(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` … `COMMIT`, release in finally).
`speciesRibbon` and `ribbonRegions` run ALL their statements inside it.

`speciesRibbon` runs three queries on one snapshot, all on the 0050 tables: `SELECT band, country, west, month, n FROM band_month_samples`; `SELECT band, country, west, month, num, reached FROM species_band_month_freq WHERE species_code = $1`; `SELECT band, country, west, count(*) FROM band_locs GROUP BY 1,2,3`. `Number()` on everything (cs.md; `count(*)` returns a string). Returns `null` when `band_locs` is empty. Each `(band, country, west)` group → `CountryCellInput` with `num` from the species row or 0, `n` from samples; groups with `n === 0` that month are skipped (mockup `weighted` requires `c.n > 0`). **Before any equal averaging, coalesce by `(band, column, country)` with Σnum/Σn** (CODEX1 P1-6): with the TD-A `west` guard only US/CA/MX can split, and their halves land in different columns, but the coalesce is still required so the invariant "one country, one vote per column" holds by construction, not by data.

**All-thin cells (rev 3.2, CODEX1 gate P1):** when at least one country was surveyed that month but none reached `LOW_N`, `equalWeightCell`/`worldEqualCell` return `state: 'thin'` (see the type), never `null`.

**Low-sample under equal weight (CODEX1 P2-2 — owner decided 2026-09-03):** a country whose coalesced `n < LOW_N` for that month does not vote in `equalWeightCell`/`worldEqualCell`; if at least one country was excluded, the cell carries `low: true` (hatched) and the readout says "small sample: N of M countries under 40 checklists". `checklistCell` keeps the summed-n rule. `RibbonCell` gains `excluded: number`. `cols[b][c][m]` = mode function over that column's groups; `world[b][m]` = `worldEqualCell` / `checklistCell` over all groups in the band. `gapMonths`: month m is a gap iff Σ samples.n > 0 and Σ reached = 0. Unmapped countries: excluded from cells, listed in `meta.unmappedCountries`, `console.error` once per call.

`ribbonRegions`: `SELECT loc_code, country, west FROM band_locs WHERE band = $1`, filtered in TS by `ribbonColumnOf(country, west) === column` (or all for `'ALL'`); then one query in the shape of `pickSpeciesTeaserState` (`forecast.ts:1322-1327`) restricted to `ff.loc_code = ANY($2)` — `frequency_fetch.loc_name, sample_sizes` LEFT JOIN `species_frequency` (index `species_frequency_species_idx (species_code, loc_code)`, `0011:41`). Build `monthCurve`/`weekCurve`/`bestMonth`/`goodMonths`/`peakWeekPhrase`/`migrationSentence` exactly as `makePeer` does (`:1384-1409`); drop rows whose every month has n=0; sort by `peak` desc then `locCode`; `total` = rows before cap; cap 40. Label via `regionLabel(locCode) ?? loc_name`.

**MODIFY `src/routes/species/[code]/+page.server.ts`**: at `:131` add `const ribbonP = speciesRibbon(code).then((g) => ({ ok: true as const, grid: g }), (e) => { console.error('[species] ribbon', e); return { ok: false as const, error: 'ribbon' }; });` beside `teaserP`; at `:249` `const ribbon = await ribbonP;`; add `ribbon,` to the return block (`:273-300`). Awaited, not streamed. The discriminated shape (CODEX1 P2-10) lets the page tell "nothing loaded" (`ok, grid: null`) from "broken" (`ok: false`), which renders as a one-line "The migration chart could not be loaded." — never as absence.

**CREATE `src/routes/api/species-ribbon-regions/+server.ts`** — copy `src/routes/api/region-detail/+server.ts` structure: `if (!locals.scopeId) throw error(401, 'Unauthorized')`; `species` required (trim; validate with the app's own `validSpeciesCode` from `src/lib/server/wikidata.ts:63`, `/^[a-z][a-z0-9-]{1,14}$/` — CODEX1 P2-1 — else 400); `band` integer in `BANDS` else 400; `cont` in `COLUMNS` or `'ALL'` else 400; `return json(await ribbonRegions(species, band, cont))`. Viewers GET freely (`hooks.server.ts:88`); `cache-control: private, no-store` inherited (`:105-107`).

### Tests

**CREATE `src/lib/server/ribbon.test.ts`** (pure; `vi.mock('$lib/db', …)` as `forecast.test.ts:19-22`). Build inputs from `ribbon-prod-curves.js` at test time (`readFileSync` + `new Function('window', src)`), converting each region to `{country, column, num: f*n, n}` per month using the fixture's `RIBBON_CONTINENT_OF` and `lon < -100`.
- Osprey, band 20, Jan: `equalWeightCell(NAE)` f=0.3099 n=332,904; `equalWeightCell(AS)` f≈0.033305 (21 IN regions) n=82,979; `checklistCell(all)` = **0.240800** n=439,972; `worldEqualCell` = **0.161167** (merge). Comment: the pre-fix mockup half-average was 0.094278.
- Blackpoll, band 40, Sep: NAW equal f=0.001646 (7 regions) → `<1%`; NAE equal f=0.058071 (CA 0.063628, US 0.052514; 19 regions); world equal (merge) = **0.052527**, pre-fix mockup half-average 0.029859; `checklistCell` world = 0.044615, n=1,963,647.
- `classify`: (0, 500) → zero/low=false; (0.2, 39) → reported/low=true; (0, 39) → zero/low=false; `checklistCell([])` → null; rows with n=0 only → null.
- `same country in both west buckets counts once` (P1-6): synthetic OC input with `NZ` west=true n=100 f=0.5 and `NZ` west=false n=900 f=0.1 → `equalWeightCell` treats NZ as one country at Σ/Σ = 0.14.
- `equal weight excludes countries under 40 checklists and hatches` (P2-2 default): A n=1 f=1.0, B n=10,000 f=0 → f=0, excluded=1, low=true.
- `reads share one snapshot` (P1-2, DB test): open a second client, commit a QY rebuild between the samples read and the species read inside a patched `withReadSnapshot` → the result reflects the pre-commit state for both.
- `gapMonthsFrom` on Blackpoll region grain → `[1,2,3,12]`; NJ November (0.006 × 76,684) counts as reached, so 11 is NOT a gap.
- **DB test** in `forecast-db.test.ts`: after the TD-A fixtures, `speciesRibbon('testsp', { columnOf })` with a test `columnOf` (QY→NAW/NAE, ZY→SA — the band-grain reserved countries, not the file's long-lived QZ/ZZ; rev 3.1 typo fix); assert cell (40, NAW, Jan) f=313.5/1017, `regionCounts`, `meta.regions`, `gapMonths`.
- **Route test** `src/routes/api/species-ribbon-regions/ribbon-regions.test.ts` in the `src/routes/species/[code]/species-media.test.ts` style: 401 without `scopeId`; 400 for missing species, band 45, cont `XX`; 200 shape `{rows,total,capped}` with `$server/ribbon` mocked.

### Acceptance
- `speciesRibbon` issues exactly three SELECTs on ONE `withReadSnapshot` client, none against `species_frequency`/`species_month_freq`/`loc_month_samples` (assert via the mocked client call list).
- Vectors pass to 1e-6.
- Species page SSR payload carries `ribbon` as `{ok, grid|error}`; page renders correctly for `grid: null` and for `ok: false`.
- SSR byte gate (CODEX1 P2-8, rev 3.2): the serialised `ribbon` property ≤ 40 KB gzipped. The local test measures the widest species the fixture DB holds (or, on a restored cluster, the widest existing species) and never hard-fails on pre-existing data. The PRODUCTION figure for Rock Pigeon was measured from the source tables 2026-09-03 (gzip ≈ 1 KB, see the Rev 3.2 ledger) and is re-recorded on the td at deploy; shell latency for `/species/osprey` on `dev:test` ≤ the pre-ribbon baseline + 50 ms, measured manually at deploy (no recorded baseline exists to automate against).
- Endpoint returns ≤40 rows sorted by peak with `total`; 401/400 per tests.
- `npm run check` 0 errors.

### Deploy notes
Depends on 0050 applied; no schema change. Rollback: revert.

### CC1 post-review checks
Merge semantics in `worldEqualCell`; n=0 groups skipped before averaging; unmapped countries surfaced; `Number()` on `count(*)`; loader catch-and-null with a log.

---

## TD-C — UI: `MigrationRibbon.svelte` + card

**td:** `td create "Ribbon UI: MigrationRibbon component, species-page card, Best-time third peer" --type feature --priority P2 --parent td-59c2d0 --depends-on <TD-B> --labels ribbon,ui`

### Files

**CREATE `src/lib/components/migration-ribbon.ts`** (pure; no DOM, no `$server`). Duplicated client types `RibbonGridClient`, `RibbonCellClient`, `RibbonRegionRowClient` structurally equal to TD-B's (FrequencyChart precedent `:1-19`).

```ts
export const BANDS, COLUMNS, COLUMN_NAMES /* 'North America, west of 100°W', … */, COLUMN_SHORT /* 'NA-W', … */,
  MONTHS, MSHORT, ML, LOW_N, PRESENT, HOME_COLUMN = 'NAE', PLAY_MS = 750, ROW_H = 22, ROW_H_TOUCH = 48;
// OWNER DECIDED (CODEX1 P1-7): obey cs.md: breakpoints 640/1024 only,
// every tap target ≥ 48px. Under 640px a single-continent row is 48px; World and
// All-continents cells stay small but are NOT tap targets there — the scrubber owns
// the month and each 48px band ROW owns the band (tap anywhere in the row).
export const BINS = [ {max:0,label:'0% — surveyed, no reports'}, {max:0.01,label:'<1%'}, {max:0.03,label:'1–3%'},
  {max:0.10,label:'3–10%'}, {max:0.25,label:'10–25%'}, {max:Infinity,label:'25%+'} ];
export function binIndex(f: number): number;                    // 0..5; f === 0 → 0, else first bin with f < max (EXCLUSIVE upper bound, CODEX1 P2-6: 0.01 prints "1%" so it is bin 2)
export function pct(f: number): string;                         // '0%' | '<1%' | 'NN%'
export function compact(n: number): string;                     // 1.2M | 96K | 1,017
export function bandLabel(lo: number): string;                  // '40–50°N' | '30–40°S'
export interface RibbonState { view:'world'|'cont'; contView:'ALL'|RibbonColumn; cont:RibbonColumn|null;
  weight:'equal'|'checklists'; band:number; month:number; playing:boolean; viewTouched:boolean;
  drillExpanded:boolean; drillOpen:boolean }
export function initialState(wide: boolean): RibbonState;       // wide: cont/ALL/NAE; phone: world/NAE/null; band 40, month 7
export function applyWide(s: RibbonState, wide: boolean): RibbonState;   // no-op when viewTouched
export function drawnColumns(s: RibbonState): RibbonColumn[];
export function geometry(s, availWidth: number, wide: boolean, phone: boolean): { cont; single; cols; cellW; rowH; headH; w; h };  // mockup geom(); phone → rowH ROW_H_TOUCH in every view (rev 3.4)
export function cellAt(grid, s): RibbonCellClient | null;
export type Key = 'ArrowLeft'|'ArrowRight'|'ArrowUp'|'ArrowDown'|'PageUp'|'PageDown'|'Home'|'End'|'Enter'|' ';
export function reduce(s: RibbonState, key: Key): { state: RibbonState; action?: 'openDrill' } | null;  // mockup keyboard
export function pickCell(s, geom, x: number, y: number, bandOnly: boolean): RibbonState | null;  // mockup pick(); bandOnly (phones) leaves month to the scrubber (rev 3.4)
export function readout(grid, s): { line1; line2; line3; title3?; nreg: number; empty: boolean };  // mockup readout, verbatim copy
export function chartAria(grid, s, speciesName: string): string;            // mockup chartAria
export function scopeText(meta, weight): string;                            // mockup scope caption verbatim
export function gapText(gapMonths): { window: string; text: string } | null;
export function formatWindow(ms: number[]): string;                         // same algorithm as FrequencyChart :115-128
export function drillHeading(s): string;                                    // 'Inside 40–50°N, North America, east of 100°W'
export function fillFor(cell, hatchId): string;                             // 'url(#…)' | 'var(--rb-0)'…'var(--rb-5)'
```

**CREATE `src/lib/components/MigrationRibbon.svelte`** — `<script lang="ts" module>` exports client types; `$props()`: `{ grid: RibbonGridClient; speciesCode: string; speciesName: string; onchartregion: (row: RibbonRegionRowClient) => void }`. State: `$state(initialState(wide))`, `regionsCache = new Map<string, RibbonRegions>()`, `drillRows`, `drillNote`, `hatchId = 'rbhatch-' + stableId(speciesCode)` (FrequencyChart `:49-53`).
- `matchMedia('(min-width: 1024px)')` in `onMount`: sample, `change` listener, and `requestAnimationFrame` re-sample (mockup); cleanup removes listener. `prefers-reduced-motion` sampled the same way → hides Play, shows "Auto-play off (reduced motion); use ◀ ▶."; if it flips ON while playing, `playing = false` (CODEX1 P2-4).
- Play: `$effect(() => { if (!playing) return; const t = setInterval(() => month = month % 12 + 1, PLAY_MS); return () => clearInterval(t); })` (NavProgress pattern; app.css `:60-65` kills CSS animation only). Any manual month change (slider, ◀ ▶, cell/row tap, Home/End) sets `playing = false` — tested.
- Live region (CODEX1 P2-3): the readout element is `aria-live="polite"` ONLY for user-initiated changes; timer-driven month changes update the text but set `aria-live="off"` for that render (or write to a separate visually-hidden status only on selection/play-state changes). The `.ribbon` group gets `aria-labelledby="ribh"` (the card heading); `chartAria` is computed over the DRAWN view (world or the drawn columns) and reads "at least 0.5% in N of 18 bands".
- Touch (CODEX1 P1-7, owner decided): NO `touch-action: pan-x`; both-axis native scrolling stays. Selection fires on `pointerup` only if the pointer moved < 8 px since `pointerdown`; no pointer capture. Under 640px, tapping a row selects the band (the row is 48px in single-continent mode); the month comes from the scrubber.
- Drill fetch: `$effect` keyed on `(speciesCode, band, cont)` → `fetch('/api/species-ribbon-regions?species=&band=&cont=' + (cont ?? 'ALL'))` with an `AbortController` cancelled on re-run and a request generation counter so an aborted/late response never overwrites a newer selection (AbortError ignored); `!res.ok` → inline "Could not load the regions for this cell." (no toast); cache per key, cleared when `speciesCode` changes (SvelteKit reuses the component), bounded to 32 entries.
- Cleanup on unmount (CODEX1 P2-4): matchMedia listeners, Play interval, ResizeObserver (`disconnect()`), its 100 ms debounce timer, the `resize` fallback listener, and the in-flight AbortController.
- Markup order/classes exactly as the mockup minus the preview checkbox/caption/legend swatch: readout (`aria-live="polite"`), `.todrill` (phone only), `.rmain` (scrub row, Play row, toolbar with View seg / Continent `<select>` / Average seg, `.ribbon tabindex="0" role="group" aria-roledescription="migration ribbon" aria-describedby`, `<details class="how">` open on wide, gap `<p>`, attribution `<p>`), `.legend`, `.drill` with `<details class="drilld" bind:open={drillOpen}>` summary `Inside … · N regions`, `.dsub`, `.dnote aria-live`, ≤8 `.drow` buttons then "Show all 40 (of N)". Region tap → `onchartregion(row)`, `drillNote = 'Now charting {label} below'`.
- SVG from `geometry()`; `<svg role="img" aria-label={chartAria(...)}>`; `<pattern id={hatchId}>`; empty cell = white rect + slash `stroke="var(--rb-slash)"`; equator line + gutter `EQUATOR`; month overlay, band outline, cell outline; `.ribwrap.clipped` fade when `w > clientWidth + 1` (ResizeObserver on `.rscroll`, 100 ms debounce).
- Tokens in the scoped `<style>`: `--rb-0:#eceff1; --rb-1:#cfe9dc; --rb-2:#9fd0b8; --rb-3:#63ad8b; --rb-4:#2f855f; --rb-5: var(--accent); --rb-slash:#6c757d;` (mockup `#0a5c43` → `--accent #0a5940`; slash is on white so 4.69:1 stands). Legend swatches use the same tokens.
- Styles: mockup's `<style>` copied into the scoped block EXCEPT its breakpoints and touch rule; `.seg` 48 px; `select` per `src/routes/forecast/species/+page.svelte:974-983`; `summary` per `:1199-1207`; the phone ordering block (`.rmain{display:contents}`) under `@media (max-width: 639px)`; `.todrill{display:none}` at `@media (min-width: 640px)`; `@media (min-width: 1024px)` grid `minmax(0,1fr) 330px`. Two breakpoints only (cs.md:79-84).
- Unmapped countries (CODEX1 P2-10): when `grid.meta.unmappedCountries.length > 0`, render under the scope caption: "Data omitted for N countries not yet assigned to a continent: …" (list codes). Test it.
- Gap copy (CODEX1 P2-9): `gapText([1..12])` → window "Year-round", text "below 0.5% of checklists in every loaded region all year"; `formatWindow` handles the full set before falling back to the 12-name list. Copy verbatim from the mockup: subtitle, tap hint, key legend, "Play the year", reduced-motion note, legend labels, readout lines, scope caption, gap note, drill heading/sub, "Show all".

**MODIFY `src/routes/species/[code]/+page.svelte`** (rewritten after CODEX1 P1-4 — the live card dereferences `ft` at `:449, :451, :464, :482, :493, :513, :514` and the page has no `reduced` identifier):
- Imports: `MigrationRibbon` + `RibbonRegionRowClient` type; `import { tick } from 'svelte'`.
- `let chartPeer = $state<CardPeer | null>(null);` with `type PeerRow = NonNullable<PageData['forecastTeaser']>['peers'][number]; type CardPeer = Omit<PeerRow,'kind'> & { kind: PeerRow['kind'] | 'chart' }`. Reset to null in the species-change `$effect` (`:117-120`).
- `const cardPeers = $derived<CardPeer[]>(...)` = `(data.forecastTeaser?.peers ?? [])` + `chartPeer` when its `locCode` is not already present. `selectedPeer` (`:121-125`) and `onPeerTabKeydown` (`:145`) read `cardPeers`. **Every** `ft.` in the card becomes either `cardPeers` (`:449 :451 :513 :514` → `cardPeers.length > 1` / `cardPeers`) or `ft?.` with a fallback (`:464 :482` → `peerKindLabel(kind, ft?.poolSize ?? 0)`; `:493` → `{#if ft && !ft.hasOrigin}`).
- `peerKindLabel` (`:126-141`): add `if (kind === 'chart') return 'From the chart';`.
- `const reducedMotion = $derived(browser && matchMedia('(prefers-reduced-motion: reduce)').matches)` — local to the page (nothing named `reduced` exists there).
- `async function onChartRegion(r)`: build `chartPeer` `{kind:'chart', locCode, containsHome:false, label, distanceKm:null, curve, weeks, migration, best, peakPhrase, good}`; `selectedTeaserCode = r.locCode`; `await tick()` (the card may not exist yet when there was no server teaser); then `document.getElementById('besth')?.scrollIntoView({ block:'start', behavior: reducedMotion ? 'auto' : 'smooth' })`.
- Season line (`:518-527`): when `selectedPeer.best == null` render "not reported in any month" instead of nothing.
- New card ABOVE `:441`: `{#if data.ribbon.ok && data.ribbon.grid}<section class="card" aria-labelledby="ribh"><h2 id="ribh">Where it is through the year</h2><MigrationRibbon grid={data.ribbon.grid} … /></section>{:else if !data.ribbon.ok}<section class="card"><h2>Where it is through the year</h2><p class="muted">The migration chart could not be loaded.</p></section>{/if}` — `ok && grid === null` renders nothing (nothing loaded is not an error).
- Best-time gate `:441` → `{#if selectedPeer}`; `ft` nullable throughout; add `id="besth"` to the `<h2>`.
- **Help** (`src/routes/help/+page.svelte:265` section) must state, in plain words: each region is placed by its centre point; "Equal weight" counts each country once inside its continent and each continent once in the world row, while regions inside a country are weighted by checklists; grey means surveyed with no reports and a slash means nothing loaded; the gap note uses a fixed 0.5 % threshold; coverage is partial and names what is loaded; the region list shows the 40 highest; Play advances monthly and is off under reduced motion; the ribbon combines each region's stored year window (CODEX1 P2-12, P3-2).
- **About** (`src/routes/about/+page.svelte`): add the new version key to `openVersions` (`:3-14`, open by default), insert the entry above v0.1.5 (`:104-125`), and MOVE the `v-tag current` badge (`:114`) to it.

### Tests

**CREATE `src/lib/components/migration-ribbon.test.ts`** (`bottom-nav.test.ts` style):
- `binIndex` (exclusive upper bounds): 0→0, 0.0099→1, 0.01→2, 0.0299→2, 0.03→3, 0.0999→3, 0.1→4, 0.2499→4, 0.25→5; and `pct(f)` for each pinned to the bin label in the same test (P2-6).
- Event wiring (P2-11): slider `input`, ◀, ▶, cell/row tap, Home, End each set `playing=false`; Enter opens the details AND scrolls to it; a fetch returning `!res.ok` renders the inline error; an AbortError renders nothing; a late response for a stale generation is discarded.
- `fillFor`: `{f:0.2,n:39,low:true}` → hatch url; `{f:0,n:39,low:false}` → `--rb-0`; `{state:'thin'}` → hatch url with NO bin colour (binIndex never called); null → slash marker.
- `readout` six branches: null → 'No data — nothing loaded here'; thin → 'Surveyed — too few checklists to rate' + 'N countries under 40 checklists · …'; low → '20% reporting rate · small sample'; zero → '0% — surveyed, no reports'; equal → '16% average reporting rate' + line3 'equal weight · 2 regions · 440K checklists' with title '439,972 checklists'; checklists → '24% of checklists reported it'. Never "of checklists" in the equal branch.
- `reduce`: ArrowLeft at 1 → 12; ArrowRight at 12 → 1; ArrowUp at 80 stays; ArrowDown at -90 stays; PageDown in world view → unchanged; PageDown in single-continent mode moves `cont` and `contView`; Home/End; Space toggles playing; Enter → openDrill; unknown → null.
- `initialState(true)` = cont/ALL/NAE; `initialState(false)` = world/NAE/null; `applyWide` no-op once `viewTouched`.
- `geometry`: world at avail 300 → cellW 25, w 300; ALL at avail 300 → cellW 6, w 576; single on phone → rowH 48 (ROW_H_TOUCH; the 44 here until rev 3.3 was a stale carry-over from a mockup comment — cs.md's ≥48px rule and owner decision P1-7 govern); single wide → 22; headH 34 in cont view else 20.
- `formatWindow([12,1,2,3])` → 'Dec–Mar'; `[1,3]` → 'Jan, Mar'.
- `chartAria` one reported cell → contains 'reported in 1 of 18 bands, strongest 40–50°N in September at 6%'.

**CREATE `src/lib/components/migration-ribbon-markup.test.ts`** (readFileSync on the .svelte): contains `role="group"`, `aria-roledescription="migration ribbon"`, `aria-live="polite"`, `aria-label={` on `<svg`, `<details`, `Data from <a href="https://ebird.org">eBird.org</a>`, `prefers-reduced-motion`, `(min-width: 1024px)`; no `#0a5c43`, no `$server`, no `preview`.

### Acceptance
- Card renders above "Best time of year" only when `data.ribbon` is non-null.
- Safari at 336/390/639/640/641/1024/1040/1300 px: no page-level horizontal scroll; 1300 px opens All continents with NAE selected; 390 px opens World; readout visible after a tap on a phone; resizing across 1024 flips the view until the user touches the toggle; a vertical swipe over the chart scrolls the page (no scroll trap); every tap target ≥ 48 px (P1-7).
- Tapping a drill region adds a "From the chart" tab, charts it, scrolls to `#besth`; arrow keys cycle three tabs.
- Play at 750 ms, loops, hidden under reduced motion; pauses on any manual month change.
- Two hatch pattern ids on the page are distinct.
- Help and About updated; `npm run check` 0 errors; unit tests green.

### Deploy notes
No schema. Rollback = revert the commit.

### CC1 post-review checks
`display: contents` ordering block present; `$effect` cleanup for interval, listener, AbortController; no `$server` import; readout copy byte-for-byte against the (fixed) mockup; `low` only when `f > 0`; `regionCounts` (not fetched rows) drive "N regions"; `<details>` keeps state via `bind:open`.

---

## Verification (end to end, after all three land)

- `npm run test:db:reset && npm run test:db:up` applies 0050; full `npm test` green except the two known races (td-b29d1c, td-c41126); `npm run check` 0 errors; `npm run build` clean.
- `npm run dev:test` on 5178: open `/species/osprey`, `/species/bkpwar`, `/species/bkcchi`; compare readouts against the (fixed) mockup for the vectors above; drive at 336/390/1300 in Safari as the mockup was.
- Prod pre-flight for TD-A: read-only `EXPLAIN ANALYZE` of the backfill SELECTs and the recorded row count; deploy TD-A alone first; `SELECT count(*) FROM band_locs` matches expectation; then TD-B, then TD-C, each behind CODEX1 + GROK and the owner's word.
