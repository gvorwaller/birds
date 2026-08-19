# Nearest Lifer + Weekly Migration Timing — plan (CC1)

Gaylon 2026-08-18: "do nearest-lifer and weekly timing" (td-a6c322 +
td-af8393), with AGY looped into planning for advisory UI/UX feedback
(suggestions, not mandates), then the normal CODEX1+GROK cycle.

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
