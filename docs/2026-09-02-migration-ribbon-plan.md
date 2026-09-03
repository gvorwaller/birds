# Migration ribbon (species page) — td-59c2d0

**Status:** PLAN rev 9 (2026-09-03, CC1). Rev 9 adopts CODEX1 P2-2 with the
owner's generalisation (one continent picker everywhere, "All" default on wide
screens) and makes the regions list collapsible. Rev 8 folded CODEX1's usability pass. Rev 8 folds CODEX1's second pass,
usability only, requested by the owner. Rev 7 recorded the four GROK decisions. Rev 7 records the owner's answers to
the four GROK decisions and the North America east/west split they produce.
Rev 6 folded GROK's hostile pass. Rev 6 folds GROK's hostile pass:
four P1s where a number or sentence on screen was false, all fixed and verified.
Rev 5 measured the rollup. Rev 5 replaces blocking item 1 after
measuring the rollup on production: the answer is a materialised ribbon table,
not a wider query. Rev 4 folded the CODEX1 and AGY reviews. Peer review done: CODEX1 (mechanics)
and AGY (UX) both returned. Mockup fixes applied; four items are BLOCKING for the
real build and are listed under "Review findings". Owner's design decisions in
rev 3 all stand. Rev 1
proposed one row per loaded region. The owner then committed to **world-wide coverage**, for education
rather than for chasing birds, which broke that design. Rev 2 replaces it with
fixed latitude bands and continent columns. Mockup built and verified in Safari;
peer review (CODEX1 / AGY / GROK) still deferred until the owner has played with it.

## Context

Yesterday (2026-09-01, session "Set up CC3 in claude-relay") td-59c2d0 "Visual
species location map" was designed and then parked. Sequence: animated dot map
chosen → rejected (one dot per state = polka dots, and the page already links
eBird's real species map) → **migration ribbon** chosen (months across, regions
by latitude down, colour = share of checklists reporting; a migrant draws a
diagonal sweep, a resident a flat band) → parked because coverage is 10 whole
countries and nothing else, so a Neotropical migrant's winter reads as "gone".

Nothing reached the repo or tracker: td-59c2d0 still has only its one-line
description; the research survives only in a plan file
(`~/.claude/plans/ok-i-m-liking-your-expressive-sutton.md`).

Today the owner wants to resume. Ambition: world coverage eventually. Concerns:
AI enrichment cost for ~8,000 not-yet-loaded species, and the effort of loading
every country. Wants the ribbon, a **full-featured HTML mockup** to play with
(made-up data acceptable where it helps judge UI/UX), and then to decide whether
to route it to AGY / GROK / Codex for review.

Owner's decisions today: accept the enrichment coupling and use **Haiku for the
backlog**; mockup uses **real prod curves** for three species; ribbon rows are
**thin per-region rows grouped by country**; **reviews deferred** until the
owner has read this plan and played with the mockup.

## What the research settled today

**Loading coverage costs no money; enrichment does, and it is auto-triggered.**
One region = one `ebird.org/barchartData` GET with the user's CAS session
(`src/lib/server/barchart.ts:137-140`), 500 ms spacing, single worker. A
country-level `?/analyzeCounties` already enqueues every seeded sub1 of that
country as one job (`src/routes/forecast/data/+page.server.ts:723-731`); there
is no all-countries path (would iterate `countriesList()`,
`src/lib/server/regions.ts:159`). All 3,369 sub1 regions are seeded with
centroid + bbox. Enrichment scope is `seen_species ∪ species_frequency ∪
photo_links` (`src/lib/server/species-enrichment.ts:524-536`), so every species
a new region reports becomes AI-due within 15 min (`scan_enrichment`), gated only
by compile-time `AI_STAGE_ENABLED` (`src/lib/server/job-policy.ts:43`).

**Cost.** Measured 2026-08-29: 3,041 species ≈ $38 on Sonnet 5 intro pricing
(≈ $0.0125/species). For ~8,000 new species: Haiku 4.5 ≈ $50, Sonnet 5 (now
$3/$15) ≈ $150, Opus ≈ $250. Caveat for "Haiku for backlog, Sonnet for what I
look at": `app_config` has only two AI purposes (`ai.model.enrichment`,
`ai.model.guidance`, both `claude-sonnet-5` on prod today). A dropdown switch
to Haiku applies to on-demand enrichment too. Either accept that for the
duration of the world load and switch back after, or add a third purpose
(`enrichment-backlog`) — a small code change, deferred to the world-load td.

**Table growth (prod, 2026-09-02).** `species_frequency` = 23.8 M rows,
2.9 GB, across 8,532 locations (196 sub1 + counties + hotspots). Average
10,363 rows per sub1 region → the remaining 3,173 regions add ≈ 33 M rows /
≈ 4 GB. Droplet disk: 57 GB free of 77 GB. Feasible; needs index/vacuum
attention and a per-species-page query check (the teaser query scans every
loaded region for one species).

**The ribbon's data already exists.** `pickSpeciesTeaserState`
(`src/lib/server/forecast.ts:1309-1443`) computes a 12-month curve
(`MonthStat {month, freq 0-1, n}`) for every loaded region on each species page
load and discards all but 1–2. Latitude comes from `regions.lat` via
`regionCoordsFor()` (`src/lib/server/regions.ts:246-257`).

**Real data confirms the picture works.** Blackpoll Warbler (bkpwar) on prod:
spring sweep Florida (Apr) → DC (May, 21%) → Yukon/NWT (Jun); breeding peak
Newfoundland (Jun, 22%); autumn departure only on the Atlantic coast (MA/RI/NJ
Sep–Oct) with the interior blank — the transatlantic route; Nov–Apr blank in
every tracked region; Costa Rica surveyed (5–20k lists/month) but 0%. Peaks are
low (median non-zero cell 0.2%), so the colour ramp must use fixed quasi-log
bins, not linear-to-max. Chickadee (bkcchi) and Osprey (osprey) give the
resident and cosmopolitan contrasts. Extract is at
`docs/mockups/ribbon-prod-curves.js` (196 regions × 3 species).

**Chart idiom to mirror.** `src/lib/components/FrequencyChart.svelte`:
hand-rolled SVG, `var(--accent)` fills, 45° hatch pattern for n<40, `·` glyph
for n=0 (never a zero bar), 48 px segmented toggle, footnotes in `figcaption`.
No slider or animation exists anywhere in the app today. Mockup convention
(`docs/2026-08-17-species-enrichment-plan.md:27-56`): sibling static HTML in
`docs/mockups/` linking `mockup.css`, nav chrome copied from
`species-detail-enriched.html`, registered in `index.html`, reviewed in Safari at
390×844 / 320×568 / ≥1024.


## What changed in rev 2, and why

Rev 1 drew one thin row per loaded region, sorted by latitude inside each
country. Two findings killed it.

**Longitude was collapsed into noise.** The ribbon has one spatial axis and rev 1
spent it on latitude. Blackpoll Warbler's autumn route is Atlantic coastal, so
at one latitude band the continent splits in half. Sorted west to east the
September and October figures read 0, 0, 0 through Wyoming, Nebraska and Iowa,
then 7, 4, 6, 5, 3, 6, 6 from Ohio to Rhode Island. Sorted by latitude, which is
what rev 1 drew, the same ten numbers interleave as 0, 6, 6, 0, 6, 3, 0, 4, 7, 5
and read as speckle.

**It did not survive world coverage.** Osprey occupies 190 of the 196 regions
loaded today. At world coverage that is roughly 2,500 rows, a fifteen-thousand
pixel column.

**A continent rollup does not rescue it.** Averaging all of North America into
one Osprey row gives 3 3 5 9 8 8 9 12 9 5 3 3, against Alabama, a genuine
resident, at 5 6 13 16 9 8 10 11 9 11 7 6. The same shape. Gulf winter birds and
Canadian summer birds cancel, so the continent row makes the most interesting
species look like a non-migrant.

**Latitude bands do survive it.** The same data in 10° bands:

| Band | Jan..Dec |
|---|---|
| 60-70N | 0 0 0 2 2 1 2 3 2 0 0 0 |
| 50-60N | 0 0 0 4 6 5 5 8 5 1 0 0 |
| 40-50N | 0 0 2 10 9 8 11 14 9 3 0 0 |
| 30-40N | 3 3 6 8 6 6 7 9 7 5 4 3 |
| 20-30N | 24 22 25 25 20 19 18 18 19 20 22 22 |
| 0-10N | 5 5 4 2 1 1 1 1 2 3 5 5 |
| 20-30S | 8 8 7 7 7 7 7 7 7 8 8 9 |

Osprey becomes a seesaw: northern bands fill April to September, the equatorial
band does the opposite, and a subtropical band never changes. Row count is fixed
at 13 forever, so more coverage improves each band instead of lengthening the
chart.

**Continents belong as columns, not rows.** The flat 20-30N band above is two
opposite populations averaged together. Split by continent in the mockup, North
America reads `@@@@@####@@@`, a resident and wintering population, and Asia reads
`*++------++*`, a winter visitor absent from April to October. The world row
hides both; the column view recovers them. This is also where Blackpoll shows the
Americas populated and every other column empty.

**Effort weighting is a real distortion.** Florida alone is 72% of all checklists
in the 20-30N band, so a checklist-weighted world row is largely one state. The
mockup therefore defaults to averaging *by place*: each country counts once
inside its continent, each continent once in the world row. A *by effort* toggle
shows the raw alternative, and the caption always says which is active.

## Plan

### Step 1 — Record the research where it will be found

1. `td comment td-59c2d0` with a compact version of the "What the research
   settled" section above (coverage facts, cost, growth, decisions, pointers).
   Do **not** `td close`; leave it `open` — it is now active again.
2. Write `docs/2026-09-02-migration-ribbon-plan.md` (the artifact reviewers will
   later read by path): context, decisions, measured facts, the mockup's UX
   contract (Step 2), the open UX questions, and the follow-on work (Step 4).
   Rev 1; later review passes become revs 2+ with `[CODEX1]`/`[AGY]`/`[GROK]`
   annotations, per the established pattern.

### Step 2 — The mockup (BUILT)

`docs/mockups/species-migration-ribbon.html` plus `ribbon-prod-curves.js`,
registered in `docs/mockups/index.html`. Real production curves for Osprey,
Blackpoll Warbler and Black-capped Chickadee across all 196 loaded regions.

- **Rows:** 13 fixed 10° latitude bands, 70-80°N down to 40-50°S. Never grows.
- **Columns:** 12 months in the World view; 6 continents × 12 months in the
  By continent view, which scrolls horizontally inside its own container with the
  band labels pinned, so the page itself never scrolls sideways.
- **Averaging:** By place (default) or By effort, with the caption naming which.
- **Drill:** selecting a cell lists every region inside that band and continent,
  sorted by peak, each with its own 12-month strip. Tapping one charts it in the
  existing "Best time of year" card below.
- **Month scrubber and Play**, honouring `prefers-reduced-motion`.
- **Coverage preview:** hand-authored rows for Mexico, Colombia, Brazil, Senegal,
  Kenya and South Africa, dashed and badged "PREVIEW · NOT LOADED", excluded from
  the gap note. With it on, the Osprey seesaw completes into the tropics.
- **Honesty:** no-data cells are drawn as empty dashed outlines, never as zero.
  Continents with nothing loaded read "no data", not "absent". The scope caption
  names what is loaded and what is not.
- **Accessibility:** one tab stop, arrow keys for month and band, Page keys for
  continent, generated `aria-label` per view, all controls at least 48px.

### Step 3 — Hand it to the owner to play with

- Serve `docs/mockups/` at `http://127.0.0.1:8431/` (`python3 -m http.server
  8431` from that directory; cs.md pins that origin) and send the URL, or
  `SendUserFile` the HTML if preferred.
- Owner reviews in Safari at 390×844, 320×568, and desktop, and answers the
  open UX questions (below). Reviews by CODEX1 / AGY / GROK happen only if the
  owner then says so; the brief pattern (direct `to:`, path + git ref,
  findings-only banner for AGY/GROK, "no ack — first reply is the critique")
  is ready to use, with CODEX1 → AGY → GROK sequential as the default.

Open UX questions for the owner while playing:
1. Country order: pure north→south, or home country first?
2. Fixed bins, or also a "stretch to this species' peak" toggle?
3. Should non-US groups stay expanded across species switches?
4. 6 px rows at 320 — legible, or default 8 px and accept a taller US block?
5. Does ribbon selection replace the "Best time" peer tabs or add a third tab?
6. Play speed and loop-vs-stop at December.
7. Is the coverage-preview toggle worth shipping in the real app, or mockup-only?

### Step 4 — Follow-on work (separate tds, not built in this plan)

- **World load td** (now the owner's stated direction): switch
  `ai.model.enrichment` to Haiku for the backlog, or add an `enrichment-backlog`
  purpose so on-demand work stays on Sonnet; add an "all countries" job that
  iterates `countriesList()` and enqueues one `analyze_counties` per country;
  measure eBird's tolerance on the first few countries before committing;
  watch `species_frequency` growth of roughly 33 M rows and 4 GB against 57 GB
  free, and vacuum/index accordingly; then switch the model back.
- **Ribbon build td**: widen `pickSpeciesTeaserState` to return all `built[]`
  curves with `regions.lat` and `parent_code`, aggregate into bands and
  continents server-side, and add a `MigrationRibbon.svelte` mirroring the
  mockup in a new card above "Best time of year". A country-to-continent
  mapping is needed; `regions` has no continent column today.
- **Open question deferred to build time**: with world coverage the main
  objection to an animated map (coverage holes that lie about absence) largely
  dissolves. Worth re-testing the ribbon against a map once loading is done.

## Verification (done 2026-09-02, Safari, scripted)

- td-59c2d0 is in progress and carries the research as a comment.
- Mockup driven in Safari at 336, 390 and 1300 px: no page-level horizontal
  scroll at any width, no console errors, 13 bands render, the continent view
  scrolls inside its container with band labels pinned, and the chart sits above
  the fold on a phone.
- Rendered cell colours were read back out of the DOM and matched against the
  source data. Osprey draws the seesaw; the By continent view separates North
  America's resident population from Asia's winter visitor in the 20-30°N band;
  coverage preview fills the tropics; Blackpoll leaves every non-American
  column empty.
- `npm run check` is unaffected, static files only, but run it before committing
  per CLAUDE.md.

## Decided by the owner (2026-09-02 survey)

| Question | Decision |
|---|---|
| Band grain | **10 degrees**, 13 rows. 5-degree bands would be thin until the world is loaded; revisit after. |
| Default view | **World.** Fits a phone with no sideways scrolling and gives the fastest read. |
| Default averaging | **By place.** Each country counts once inside its continent, each continent once in the world row. |
| Continent order | **Geographic**, fixed. A stable axis is what makes two species comparable. |
| Drill panel | **Cap at 40** by peak, stating how many were left out. |
| Play | **750 ms per month, looping.** A year in nine seconds. |
| Coverage preview | **Mockup only.** It argues for loading the world; once that is done it has no job, and invented rows do not belong on a live page. |
| No-data marking | **Diagonal slash** (see below). |

### The no-data fix

While quietening the unloaded cells so they stopped drowning the data, I pushed
them too close to the "0%, surveyed but not reported" grey. White against
`#eceff1` measures **1.15:1**, against a 3:1 floor for a non-text distinction,
and in the continent view at 8px cells there was no dot either. That collapsed
the single most important distinction in the design: "we know nothing here"
against "this bird was looked for and not found."

Fixed structurally rather than tonally: every unloaded cell now carries a thin
diagonal slash on white, legible at any cell size and in any lighting, with a
matching legend swatch. The three states are now:

- **Coloured** — reported at that rate.
- **Solid light grey** — regions loaded and birded, species never reported.
  This is real evidence of absence.
- **White with a slash** — nothing loaded. No claim about birds at all.

Verified: 70-80°N and 0-10°S hold zero loaded regions of any country, so those
rows are correctly slashed end to end. Loaded latitudes run 69.8°N to 41.5°S.

## Next

Peer review is the remaining gate, and is the owner's call to trigger. The
established pattern is CODEX1 for mechanics, then AGY for UX, then GROK as the
hostile pass, each addressed directly by name, given
`docs/2026-09-02-migration-ribbon-plan.md` and
`docs/mockups/species-migration-ribbon.html` by path plus a git ref, with
findings-only banners for AGY and GROK. After that, the two follow-on tds in
Step 4: the world load, and the real Svelte build.


## Review findings (2026-09-03)

CODEX1 (mechanics) and AGY (UX) reviewed the plan and the mockup in parallel,
findings-only. Every claim below was independently verified before acting.

### Rollup arithmetic (Gaylon asked for the math, 2026-09-03)

`species_frequency` is sparse: a row exists only where frequency is above zero,
so a month collapses four weeks only when all four weeks have a row.

| Weeks backing one rollup row | Rollup rows | Share |
|---|---|---|
| 1 | 2,287,540 | 24.0% |
| 2 | 1,368,439 | 14.3% |
| 3 | 1,228,754 | 12.9% |
| 4 | 4,661,983 | 48.8% |

Weighted out, 2,287,540 + 2,736,878 + 3,686,262 + 18,647,932 = 27,358,612, which
is exactly the `species_frequency` row count. So real compression is 2.87:1, not
4:1, giving 9,546,716 rollup rows. Even perfect 4:1 compression floors at 6.84 M,
so 0049's "~364 K" claim is impossible by a factor of nineteen against the floor.
`loc_month_samples` is 109,860 rows = 9,155 locations × 12.

### Fixed in the mockup

| # | Who | Finding | Verified | Fix |
|---|---|---|---|---|
| 1 | CODEX1 P1 | Preview rows were averaged into cells that also held real data, then presented as eBird figures. Mixed cells existed in the fixture at 10-20°N and 20-30°N North America. | CONFIRMED | Real data now wins a cell outright; preview only ever fills a cell with no real data. Cells with real data are byte-identical preview on or off. The readout names any preview regions held back. |
| 2 | CODEX1 P1 | `bandOf` clamped every latitude below 50°S into the 40-50°S row. The seed already holds seven regions further south, Antarctica at -75.3 among them, all mislabelled. | CONFIRMED | Bands now run 80-90°N to 80-90°S, 18 fixed rows, no clamp except at the literal poles. Antarctica added as a seventh continent column. |
| 3 | AGY P1 | The no-data slash was too faint against the 0% grey. AGY measured 1.93:1; actual is 2.07:1, against a 3:1 floor. | CONFIRMED | Stroke darkened to `#6c757d`, measured 4.69:1. AGY's suggested `#595959` measures 7.0:1, too heavy given how much of a world grid is unloaded. |
| 4 | AGY P2 | On a phone the legend sat after a 40-row drill panel, pushing it off-screen. | CONFIRMED | Legend moved above the drill panel. Fixing this exposed a grid bug that made the drill panel overlap the chart on desktop; also fixed. |
| 5 | AGY P2 | No cue that continent columns were clipped off-screen on a phone. | CONFIRMED | Right-edge fade when the grid is wider than its container. |
| 6 | AGY P2/P3 | Copy: "lists" for checklists, "loaded band" where a birder thinks region, no reading key, no equator benchmark. | Accepted | Reading key added to the subtitle. Equator drawn and labelled on the grid. Copy corrected throughout. |
| 7 | CODEX1 P2 | "By place" named an estimand it does not compute: regions inside a country are still checklist-weighted. | CONFIRMED | Toggle renamed **Equal weight / By checklists**, and the caption now states exactly what is equalised. |

**Rejected:** AGY proposed replacing "By effort" because it reads as jargon.
"Effort" is already this app's own user-facing word — `FrequencyChart.svelte:256`
says "checklists per week (effort)". The label was changed for CODEX1's accuracy
reason instead, not AGY's vocabulary reason.

### BLOCKING for the real build (not mockup problems)

1. **Materialise the grid. Do not query either table per page load.**
   (Rev 5, measured 2026-09-03 after Gaylon questioned the row count.)
   `species_month_freq` has PK `(loc_code, species_code, month)` and one index
   `(month, loc_code)`. There is **no species-leading index**, so the naive shape
   `WHERE species_code = ?` is a Parallel Seq Scan reading 68,575 buffers
   (~536 MB). The weekly table is better indexed for this access pattern: it has
   `species_frequency_species_idx (species_code, loc_code)`.
   Driving instead from the loaded-region list uses the rollup PK by nested loop
   and avoids the scan, but is still too slow to block a page:

   | query shape | Osprey | Blackpoll |
   |---|---|---|
   | rollup, region-driven | 120 ms | 365 ms |
   | weekly, same answer | 411 ms | 392 ms |

   At 788 loaded regions. The world load takes that to ~3,369, roughly four times
   the index lookups. **The fix is a third rollup at the ribbon's own grain:
   `(species_code, band, country, month)` measures 394,466 rows today, 24x
   smaller than `species_month_freq` and keyed by species, turning a page load
   into one short index scan.** Maintain it in the same transactional path that
   already maintains the monthly rollup, so it cannot drift. Adding a
   species-leading index to `species_month_freq` instead would cost ~370 MB
   (its PK is 369 MB) and would still leave a per-request aggregation.
   (Ownership note: migration 0049 was written by a Claude session on
   2026-08-31, commit 8b642aa. The "~364 K rollup rows" figure in its header is
   our own estimate, made before the backfill ran and never corrected against
   the 9.55 M rows it actually produced. Not a third party's mistake — ours.
   I previously guessed it might have described a band grain; I could not
   establish that and have withdrawn the guess. See td for the correction.)

   Original finding, still true: migration 0049 already maintains
   `species_month_freq` and `loc_month_samples`, which is closer to the ribbon's
   grain than the weekly table. The rev 2 plan proposed widening the weekly query in
   `pickSpeciesTeaserState`; CODEX1 is right that it should query the rollup and
   aggregate the fixed grid server-side instead of serialising ~2,500 curves into
   the page shell. Measured on prod: `species_month_freq` is 9.55 M rows / 1,016 MB.
   Note migration 0049's own header comment claims "~364 K rollup rows", which is
   wrong by a factor of 26 — worth a separate td to correct the comment.
2. **The world loader must not be 252 independent jobs.** `analyze_counties`
   rejects a country with no seeded sub1, and 56 countries have none, so those
   cannot load that way at all. Worse, claim order is FIFO, so ~252 country jobs
   would put life-list sync, need alerts and enrichment behind up to ~16.8 hours
   of first slices. Build one resumable world-load job that yields its remainder
   to the tail, over a resolved list of sub1s plus direct country rows.
3. **A complete country-to-continent mapping is required.** The mockup maps only
   its 16 fixture countries. In production a region whose country is unmapped
   would silently vanish from every column rather than erroring.
4. **Disclose centroid assignment, or change the geography.** Each region's
   frequency covers the whole region but is placed in one band by its centroid.
   Measured on prod: of 788 loaded sub1 regions, **228 (29%) straddle a 10-degree
   band boundary** and 37 span more than 10 degrees, the widest being Nunavut at
   31.7 degrees. That can shift or manufacture part of a sweep. Either say so
   plainly in the caption, or use finer geography.

### Corrected in this plan

The rev 2 text said a newly loaded species becomes "AI-due within 15 minutes".
CODEX1 flagged it and it is wrong. The lanes gate each other: wiki must land,
then iNaturalist, and only then can the AI lane run, because `aiDueCodes`
requires `wiki_status='ok'` and a terminal `inat_similar_status`. A new species
therefore needs three separate scan cycles, and the similar-species notes ride in
the same billed AI call as the tags and field craft.

### Not adopted

CODEX1's shape verdict is that bands and continent columns are defensible only as
a coarse region-centroid picture, not literal bird latitude. That is a fair
description rather than an objection, and item 4 above is the honest response.


## GROK hostile review (2026-09-03) — the third and last pass

GROK recomputed every cell independently from the fixture and drove the live
mockup in Safari at 336, 390, 430, 1024 and 1280 px. It did not re-run CODEX1's
or AGY's ground. Four findings were sentences or numbers that were false on
screen. All four verified independently before fixing.

| # | Finding | Verified | Fix |
|---|---|---|---|
| P1-1 | The "real data wins" rule existed inside a continent but not across them, so preview-only continents leaked into world cells that already held real data. Osprey 10-20°N January went from 3.16% to 8.83% with preview on, still flagged as real. 60 such cells per species. | CONFIRMED | Real wins across continents too. Re-measured: **0** of 132 cells in real-data bands now move when preview flips, while 12 genuinely empty cells still fill. |
| P1-2 | That leak also silenced the gap note when preview was on. | CONFIRMED | Fixed by P1-1 and by P1-3. |
| P1-3 | The gap note made a region-level claim from a band average, and was false with no preview involved. Blackpoll November: the note read "not reported in any loaded region" while New Jersey had it on 0.60% of 76,684 checklists, contradicting the readout on the same screen. 37 regions reported it that month. | CONFIRMED, reproduced exactly | Computed at region grain over real regions only, and the sentence now states what is computed: "below 0.5% of checklists in every loaded region." Blackpoll's window correctly narrowed from Nov-Mar to Dec-Mar. |
| P1-4 | Equal weight is a mean of means, but the readout labelled it "% of checklists" beside a checklist count that is not its denominator. Osprey 20-30°N January showed 16% equal-weight and 24% checklist-weighted, both captioned the same way over n=439,972. | CONFIRMED, reproduced exactly | Equal weight now reads "16% equal-weight mean · N checklists in the mix". |

Also fixed from GROK's P2s: the equator label was covering seven columns of North
America at 7px cells and moved to the gutter; the World view inner-scrolled at a
real 336px Safari width despite the plan claiming it fits, so the cell floor
gives way to fitting; a small sample of *zero* reports was drawn with the green
hatch, reading as faint presence, and is now the 0% grey; the drill panel listed
regions behind a slashed cell when a preview row had no curve for that species.
Added a caption line for GROK finding 9, that reporting frequency also tracks
detectability, so a band can dim without the bird moving.

### Owner decisions GROK raised and nobody has asked

**A. Intra-continent east-west smear.** Accepted centroid straddling is one
thing; this is the failure that killed rev 1, returning by another door. Blackpoll
40-50°N North America September reads 5.25% as one cell, mixing Nova Scotia 8.49,
Ohio 7.47 and Michigan 7.15 with Washington 0.02, Oregon 0.03 and Idaho 0.02.
Continent columns separate Africa from the Americas, not Ohio from Wyoming. Drill
shows the truth; the picture does not. Options: accept and disclose; split North
America into east and west columns; or drop the continent view and keep World
plus drill.

**B. Should Equal weight equalise regions inside a country?** Today it does not.
In the 20-30°N North America cell only the United States is loaded, so Florida is
93% of that cell's January checklists and equal weight is identical to checklist
weight there. The scope copy claims heavily birded places do not dominate; at the
continent grain they do.

**C. World as default, reconfirm.** The 20-30°N Osprey split is the demo that
sells this feature, and the World view is exactly the average that flattens it
(29 down to 16). The owner chose World for phone legibility before that was known.

**D. Is this a subnational-1 product permanently?** Queensland, Texas, Alaska and
Nunavut are not ten-degree organisms. Counties, at least for the United States,
are the real alternative to a centroid footnote.


## Will the world load choke the app? (audit, 2026-09-03)

Gaylon asked whether world coverage is a fool's errand. Measured rather than
guessed. Short answer: data volume is not the risk; seven query sites are, and
only one of them is user-facing.

### Volume

| | |
|---|---|
| `species_frequency` today | 27.4 M rows, 3.3 GB |
| of which from the 788 loaded sub1 regions | 5.0 M (the rest is US counties and hotspots) |
| rows per region in the countries loaded today | ~5,700 (earlier estimate of 10,363 was skewed by the US) |
| remaining sub1 regions | 2,581, so roughly +14.7 M rows, plus ~250 country rows |
| projected total | ~46 M rows, ~5.5 GB, against 57 GB free |
| cache hit ratio, big tables | 96-99% |

Growth is real but ordinary. Postgres does not care.

### What actually scales with loaded regions

Every non-test query touching the frequency tables was classified. Forecast,
nearest, hotspots, region detail, species search and best-time-of-year are all
scoped to a place the user chose and do not care how much of the world is loaded.
Seven sites do, ranked:

1. **`forecast.ts:1323` `pickSpeciesTeaserState`** — every species-page load, no
   cache, no rollup, scans every loaded country/sub1 row. **The only user-facing
   one.** Already the thing the ribbon's materialised table replaces.
2. `/forecast/data:171` — the admin data hub reads the whole `frequency_fetch`
   table and groups it in JS on every load. Payload was bounded in td-3bf3a2; the
   server work was not.
3. `/forecast/data:187` — unbounded anomaly join with a sort, no LIMIT. Grows
   with total loaded barcharts.
4. `/forecast/data:178` — unbounded failed-attempts scan feeding a serial label
   loop.
5. `species-enrichment.ts:527` — worker only, no page latency, but a full
   DISTINCT over `species_frequency` on every enrichment scan.
6. `region-detail.ts:187` hub search — on demand, leading-wildcard ILIKE forces a
   full scan per request.
7. `/admin:87` — LIMIT 50 but sorts the whole attempts table; missing index on
   `last_attempt_at`.

Sites 2-4 and 7 are Gaylon's own admin tooling. Sites 5-6 are worker or
on-demand. Site 1 is the species page and is already planned away.

### The risk nobody had named: the box

The droplet has 3.9 GB RAM shared with madonnahist (~1.1 GB across its
processes), gaylonphotos, two giftlist apps, and three Postgres 17 clusters.
The birds cluster runs with **`shared_buffers` = 128 MB**, the Postgres default,
against tables already at 4.3 GB. The 96% hit ratio comes from the OS page cache
(2 GB), not from Postgres. As tables outgrow that cache the ratio will drop and
every query slows, world load or not. Raising `shared_buffers` to ~1 GB is a
config change on a shared box and is Gaylon's call, not a code change.
`work_mem` is 4 MB, which forces the ribbon aggregations to spill.

### Verdict

Not a fool's errand. The world load threatens one user-facing query, which is
already being replaced, and four admin pages that can be bounded with LIMITs and
one index. The unaddressed risk is memory on a shared 4 GB droplet, and that
exists with or without the world.


## Decided by the owner (2026-09-03, the four GROK decisions)

| | Decision | Why |
|---|---|---|
| A | **Split North America into east and west columns** at about 100°W, labelled as such. Other continents stay whole. | The Blackpoll September cell mixed Nova Scotia 8.5 and Ohio 7.5 with Washington 0.02 and Oregon 0.03 into "5%". Unlike centroid straddling, no caption repairs a number that is wrong for both halves. A one-off special case on the continent the owner reads. |
| B | **Equal weight stays country-level.** Regions inside a country remain checklist-weighted. | That is what eBird means by a region's frequency; equalising 51 states would make Wyoming count as much as Florida. The caption already says so. |
| C | **Responsive default: World on phones, By continent on wider screens.** | World was chosen for phone fit before it was known that World is the average that flattens the Osprey demo (NA 29, Asia 3, World 16). |
| D | **Stay at subnational-1 grain with the on-screen disclosure.** Revisit in td-11aeb7 (P3). | Load the world and build the feature first; decide finer geography with real coverage in view. US county data already exists if that day comes. |

### Verified after the split (Safari, 2026-09-03)

Blackpoll, September, 40-50°N, equal weight — the cell GROK named:

| Column | Reads | Regions |
|---|---|---|
| North America, west of 100°W | under 1% | 7 |
| North America, east of 100°W | 6% | 19 |
| World row | 3% | 26 |

The single "5%" cell is gone; the coast and the interior are now separate
numbers. Alaska (fixture longitude corrected from a bad 0.31 to -152.5) sits in
the west column with Yukon and the Northwest Territories. The world row treats
the two halves as one continent for equal weighting, so the split does not
double North America's vote. Responsive default confirmed: a 1300px load opens
By continent with the east column selected; a 390px load opens World. The page
never scrolls sideways at either width; the eight-column view scrolls inside its
own container on a phone.


## CODEX1 usability pass (2026-09-03) — the fourth review

Owner asked for a second CODEX1 look, this time on usability. No P1s. Every
finding was re-measured in Safari before acting; two fixes needed a second
attempt because the first verified wrong.

| # | Finding | Measured | Applied |
|---|---|---|---|
| P2-1 | On a phone the tap's feedback lands off-screen: readout above, drill below. | CONFIRMED. At 390px, readout bottom at -116px, drill top at 1374px in a 731px viewport. | Phone order is now scrubber, ribbon, readout, "See the N regions behind this" jump, toggles, then the rest. `.rmain` is flattened with `display: contents` under 720px so its children order alongside the readout. Methodology text folded under "How these numbers are calculated", open by default on wide screens. Permanent tap instruction under the subtitle. After the fix the readout sits at 444-587px, in view. |
| P2-3 | Scrubber breaks at 336px, next-arrow marooned; Play is the strongest object. | CONFIRMED. Rows at 1014 / 1070 / 1126. | Four fixed grid columns so the four scrubber controls never separate; Play moved to its own row as a plain button, relabelled "Play the year". Verified intact at 336. |
| P2-4 | Drill handoff is ~2,000px with no feedback. | CONFIRMED. 40 rows, 2,300px to the Best time heading, no scroll on tap. | Eight rows, then "Show all 40 (of N)"; region tap announces "Now charting X below" and scrolls the Best time card into view, honouring reduced motion. The announcement is kept in state because the resize observer's re-render was wiping it from the DOM. Verified: heading lands at the top of the viewport. |
| P2-5 | Initial view disagrees with the CSS breakpoint around 1024. | CONFIRMED and worse: at 1024 and 1040 Safari's `innerWidth` counts the scrollbar and the media query does not, so the continent view opened on a stacked layout. A one-time `matchMedia` sample at parse still failed, because the scrollbar arrives after first paint. | The view now **follows** the media query: `change` listener plus a re-sample after first paint, both suppressed once the user touches the toggle. Verified agreeing at 1024, 1040 and 1054. |
| P3-1 | Readout wraps to 4 lines and puts method before result. | CONFIRMED and worse: 6 lines at 390, 9 at 336 once split into three spans, because the suggested method clause is itself too long for a phone. | Three lines: where, result alone ("2% average reporting rate"), then "equal weight · 50 regions · 96K checklists" with the exact count and the equal-weight definition in `title` attributes. Phone font 0.9rem. |
| P3-2 | The only tap instruction was an idle hint that the default selection replaces instantly. | True by construction. | Permanent hint: "Tap a square to see that month's reporting rate and the regions behind it; darker green means it was reported more often." |

### Open, owner's call (CODEX1 P2-2)

The By continent view on a phone: 96 columns at 6px, continent names only at
the top of a 430px-tall grid, so after scrolling to southern bands the user no
longer knows which continent they are in, and a 6×22px cell is a guess to hit.
CODEX1 proposes that below 720px "By continent" opens a picker (NA west, NA east,
Europe, ...) and draws ONE continent's 12-month grid at full width, with each
latitude row a 48px tap target and the scrubber owning month selection. That is
a design change and is not built.


## Decided by the owner (2026-09-03, after the usability pass)

| | Decision | Built as |
|---|---|---|
| CODEX1 P2-2 | **Adopted.** On a phone, By continent must not be a 96-column grid at 6px. | A continent picker. Choosing one continent draws its 12-month grid at full width; on a phone each latitude row is a 44px tap target. |
| Owner's generalisation | **The same picker on every screen size**, with an **"All continents"** option that draws the eight-column grid. Default: All on wide screens, the home continent (North America, east of 100°W) on a phone. | One control, one mental model. "All" on a phone is still selectable, still scrolls inside its container, just no longer the default. Page Up / Page Down step through continents when one is shown. |
| Owner | **The regions list under the chart is collapsible.** | A `<details>` whose summary is "Inside 40-50°N, North America, east of 100°W · 19 regions". Open by default; its state survives re-renders, and the phone jump link opens it before scrolling. |
