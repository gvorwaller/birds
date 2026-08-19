# Nearest Lifer + Weekly Migration Timing — plan (CC1)

Gaylon 2026-08-18: "do nearest-lifer and weekly timing" (td-a6c322 +
td-af8393), with AGY looped into planning for advisory UI/UX feedback
(suggestions, not mandates), then the normal CODEX1+GROK cycle.

## GROK rulings (binding) — 2026-08-19

Design-only review of this doc at `b4447c3`. AGY is advisory; these pins
are the binding layer. No code in this turn.

### A — Nearest lifer

1. **Route + nav.** Keep `/nearest`. Drawer-only item **Nearest lifers**
   (Field guide / Help pattern) — not a 5th primary tab, not
   `ownerMenuItems` (that list is Settings/Alerts). Viewer sees it:
   read-only of the scope-owner's needs + saved home + API key, same as
   Home / species / forecast. No writes exist on this page.

2. **Optional entry points — VETO both.** No Home needs-row `nearest ↗`.
   Home already answers in-radius nearest; the species name already
   reaches the on-demand species-page card. No `/forecast/species`
   chip — that page is historical frequency, not "where is it right
   now" (category error + re-clutter of a just-decluttered surface).
   v1 entries are the drawer item + the species-page disclosure only.

3. **Auto-run N = 6 (cap), not 8.** Source: `forecastNeedsNear` at the
   owner's **saved home** (never Home's searched/focused origin) for
   the current calendar month; **likely band, needs-first, skip
   `lowSample`**. Do **not** pad with possible/longshot to hit 6.
   Disclose the **actual** count: "Checking 4 highest-probability
   targets for August near home (cached 30 min)" when only 4 likely
   exist. `/nearest` back is locked to **14** in v1 (no extra selector).

   Empty states (one sentence + the single next action):
   - No home / no API key — same copy as species nearby (viewer vs owner).
   - Zero likely-band needs this month — **do not auto-run**. Point at
     the search box and Forecast (to load data).
   - Per-species zero reports — keep the name; "No reports in the last
     14 days".
   - Partial fetch failure — keep successes; per-species error line;
     never fail the whole page.
   - Search of a **seen** species — **no eBird call**; "You already
     have {name}" + species-page link. Search is needs-only.
   - Unknown code — 400, no eBird call.

4. **Rows / places.** CONFIRM Phase-1 swap for this new surface:
   `locId` matching `^L\d+$` → `/hotspots/[locId]`. Do **not** use
   `verifiedHotspotLocIds(origin, dist)` — nearest is unbounded and a
   distant L-id will not be in the local set. Non-`L\d+` (personal
   `P…` etc.): locName as **text** + existing `personal location` chip
   when `locationPrivate` + `MapLink`. checklist ↗ stays
   `ebird.org/checklist/{subId}` (new tab). No extra eBird-hotspot ↗
   badge on these rows. **Out of scope:** do not retarget the existing
   species-page "Recent reports near X" card in this arc.

5. **Fetch / cache (skip-review pins).**
   - New `nearestObsOfSpecies` as specified; `includeProvisional=true`;
     Unconfirmed on `!obsValid` only (species-nearby / hotspot Recent
     convention — **not** the alerts `!obsValid || !obsReviewed` formula).
   - Cache key + `OBS_TTL_MIN` as specified. Coords in the key via
     `toFixed(2)` (match `recentNearbyObs`).
   - Do **not** pass `dist` (unbounded is the feature). Do **not** pass
     `hotspot=true` (would hide personal locations; contradicts
     ALL-reports).
   - If the API accepts `maxResults`, pass **5**. Render closest **3**
     on `/nearest`, closest **5** on the species card. Sort by **our**
     haversine, do not trust API order.
   - Species-page card: **NEED species only**; `?nearest=1` SSR; default
     loader never fetches. Inherits the page's `backDays`.
   - `/nearest` auto-run: `Promise.allSettled`, never a waterfall.
   - DistanceUnitToggle on both surfaces. No new map on `/nearest`.

### B — Weekly timing

6. **Migration-window annotation — SENTENCE-ONLY.** Veto AGY's
   span/bracket for v1. 4px bars cannot carry a readable bracket at
   320px; month mode already has figcaption "Good window"; a weekly
   bracket can fight the emit-only-when-supported sentence.

7. **Toggle state.** Client-only, Month default. **Not** URL, **not**
   localStorage, **not** synced between the species teaser and
   `/forecast/species`. Segments ≥48px.

8. **weekCurve / truthfulness.** 48 `WeekStat` analog of `monthlyStat`.
   `n === 0` → nodata dot, never a 0% bar. `n < MIN_WEEK_N` (10) →
   hatch + † **and** excluded from arrival/departure. Inadequate weeks
   are neither presence nor absence. Sparkline: `/forecast/species`
   only (~20px, 1:1, labeled "checklists per week", no interaction) —
   **not** on the species teaser. Teaser loader **does** ship
   `weekCurve` so the toggle works there. AGY 320px math (48×~4px +
   2px = 288px, 12 letter ticks, month-group gridlines) adopted.

9. **Help + tests + sequencing.** Help in-commit for both features.
   Tests: `weekCurve`; arrival/departure emit/suppress matrix
   (year-round, vagrant, wrap-around winter absence, low-n ignored);
   nearest whitelist/cache key; `L\d+` link vs personal text; empty
   states; `N = min(6, likely)`. Two commits (A then B); dual review;
   no deploy without Gaylon's word.

## Feature A — Nearest lifer (td-a6c322)

The question: "what's the closest bird I've never seen, right now?"
eBird endpoint (unused): `/data/nearest/geo/recent/{speciesCode}?lat&lng`
— nearest recent observations of ONE species, no radius cap. One call
per species; responses are EbirdObs rows (subId, locName, obsDt, coords).

### Client
- `nearestObsOfSpecies(apiKey, code, lat, lng, back)` in ebird.ts:
  back whitelisted 7|14|30 (default 14), `includeProvisional=true`
  (ALL-reports ruling; rows chip Unconfirmed on !obsValid), cache key
  `nearestObs:{code}:{lat.toFixed(2)}:{lng.toFixed(2)}:{back}`,
  OBS_TTL_MIN. Distance computed OURS-side (haversine from home/origin
  — the API returns coords, not distances).

### Surfaces (UI/UX input wanted — options, not decisions)
1. **Species page card** ("Nearest reports"): for a NEED species,
   show the closest current reports — beyond Home's radius. Each row:
   place name (→ /hotspots/[locId] when hotspot), distance, date/time,
   ×count, Unconfirmed chip, checklist ↗. Fetch policy OPTIONS:
   (a) on-demand (a button/details that adds ?nearest=1 and reloads —
   zero extra eBird calls for non-users of the feature), or
   (b) always in the loader for need-species only.
   CC1 leans (a): species pages are high-traffic; the extra call
   should be user-initiated.
2. **"Nearest lifers" page** (route TBD: /nearest): the marquee. The
   per-species cost means a bounded target set. OPTIONS:
   (a) auto-run the TOP N of this month's forecast targets near home
   (likely band, needs-first) with N disclosed (~5-8 calls/view,
   cached 30 min), plus a species search box for any single need;
   (b) search-box only (1 call per lookup, zero ambient cost);
   (c) user-curated "watchlist" of needs (persisted), auto-run on
   open. CC1 leans (a)+search: instant value on open, bounded and
   disclosed, no new storage.
3. **Entry points**: Home needs rows ("nearest ↗" affordance?),
   forecast species view, menu/drawer item for the page. UX input
   welcome on where this earns placement without clutter.

### Non-goals
- Multi-locId "my patches" feed (td note "natural companion") — separate.
- No schema (option 2c would need one — argument against for v1).

## Feature B — Weekly migration timing (td-af8393)

species_frequency stores 48 weeks/year; every chart collapses to 12
months. peakPhrase ("peaks late April") already derives from weekly
bins — this feature renders the full resolution.

### Pieces
1. **weekCurve()** in forecast.ts: 48 WeekStat {week, freq, n} (the
   single-week analog of monthlyStat; sampleSizes gives per-week n).
2. **FrequencyChart weekly mode**: optional `weeks` prop + a
   Month|Week toggle (≥48px, client state, month stays default).
   Weekly bars keep the existing low-sample (†) convention per bar
   (n < threshold rendered distinctly — color+pattern/text, not
   color-alone). Surfaces: /forecast/species per-state chart and the
   species-page teaser chart.
3. **Arrival/departure phrasing**: for migratory shapes — present
   part-year with adequately-sampled presence/absence — a sentence:
   "arrives ~early April · departs ~late October" (reusing the
   existing weekly-bin phrase helper). Emit ONLY when the data
   supports it: threshold freq ≥ FREQ_POSSIBLE across ≥2 consecutive
   adequate weeks, absent (freq<threshold) ≥8 consecutive winter or
   summer weeks; year-round and vagrant shapes get no sentence
   (never a fabricated migration story). Surfaces: species page +
   /forecast/species meta line.
4. **Effort sparkline**: /forecast/species already ships the 48-week
   sample_sizes histogram unrendered — draw a small effort strip
   ("N checklists behind this curve") under the chart.

### Truthfulness pins (self-imposed, review will verify)
- Weekly bars with n below the adequacy threshold must be visually
  distinct AND excluded from arrival/departure inference.
- No caps: the toggle shows all 48 weeks; sparkline shows all weeks.
- eBird attribution unchanged; Help updated in-commit for BOTH
  features (house rule).

## Sequencing
One branch/range, two commits (A then B), gates + live SSR E2E each,
CODEX1+GROK dual review of the range, hold for Gaylon's deploy word.

## AGY feedback (2026-08-19, advisory) — integrated

AGY endorsed both CC1 leans and added specifics, adopted as follows:

**A (nearest lifer):**
- Species-page fetch: ON-DEMAND confirmed (AGY + CC1 agree) — a
  disclosure/button triggers the fetch; species pages stay snappy.
- /nearest page: auto-run TOP 6-8 month targets (likely band,
  needs-first) + a species search box; the bounded check is DISCLOSED
  in AGY's suggested shape: "Checking N highest-probability targets
  for {Month} near {home} (cached 30 min)".
- Row layout (320px): two-line structure — line 1 = distance HERO
  (bold) + place name (hotspot link); line 2 = date/time · ×count ·
  Unconfirmed chip · checklist ↗. All targets ≥48px.
- Entry points, tiered: (adopted) drawer item "Nearest lifers";
  (optional, GROK to rule) Home needs-row "nearest ↗" inline action
  and a /forecast/species on-demand chip — both flagged as potential
  re-clutter of just-decluttered surfaces.

**B (weekly timing):**
- Toggle: segmented Month|Week control in the chart header, ≥48px per
  segment, Month default. Adopted.
- 320px legibility: AGY's math adopted — 48 bars ≈ 4px + 2px gap =
  288px inside a 320 viewport; 12 single-letter month ticks with
  month-group gridlines; low-sample bars get hatch/outline + †
  (never color alone).
- Arrival/departure: sentence ADOPTED; AGY also suggested a chart
  window annotation (span/bracket) — marked OPTIONAL, GROK to rule
  (complexity vs value).
- Effort sparkline: ~20px strip aligned 1:1 under the 48 columns,
  labeled "checklists per week". Adopted.
