# Hotspot Workspace — consolidated plan (AGY UX doc + CC1 audit + GROK pins)

Sources: docs/2026-08-18-hotspot-forecast-ux-unified-hub-AGY.md (UX pillars),
docs/2026-08-18-hidden-data-audit-CC1.md (data inventory), GROK plan review
2026-08-18 (all pins integrated below — BINDING, like the enrichment
contract). Umbrella td: td-a9f9eb (P1 declutter); absorbs td-d29394,
td-b66416, td-32ca9b; consumes audit items from td-97b22e/td-39d567/
td-71494e where they touch hotspots.

## GROK rulings (binding)

- **NO 3rd Forecast tab — VETOED.** ForecastTabs stays a 2-question
  workspace; at 320px a third tab starves all labels. The hub keeps the
  /forecast/data ROUTE (job chip/Help/deep links intact; NO rename to
  /forecast/hotspots); Phase-3 retitles on-page "Hotspots & data". Primary
  entry = the Phase-2 coverage pill; secondary = existing details link/job
  chip. Do not touch ForecastTabs.svelte in this arc (restore/month-carry/
  identity keys stay).
- **Phase-2 manage panel is INLINE, not modal** (modals are for destructive
  confirm; at 390px a modal hides the forecast numbers that motivate the
  load).
- **Hotspot page uses a NEW two-tab bar** ("Recent" | "Monthly", default
  Recent, ≥48px, AAA tokens borrowed from ForecastTabs, aria-label="Hotspot
  data") — NOT native <details> (Recent is primary content and must not
  start closed), NOT ForecastTabs reuse. Fetch is tab-gated: Monthly-only
  visits never hit eBird.
- **Entry links — SWAP the NAME to /hotspots/[locId]** (keep eBird ↗ badge
  + MapLink external, always): Home BestPlaces + PlaceMatches place-links,
  /forecast loaded-hotspot names, /forecast/species county hotspot names,
  SAVED trip stop names. Inline "mostly at {name}" mentions MAY link.
  **DO NOT SWAP:** trip PLANNER candidates (name = add/select target),
  forecast pick-panel checkbox labels (link would steal the select tap —
  optional separate ≥48px "Open" chevron), map pins/MapLink/Directions
  (always Google), the eBird ↗ badge itself (always ebird.org, new tab).
- **AGY vetoes:** 3-tab nav + route rename; its ForecastTabs code sample;
  GPS coordinates in the header (county/state + Maps action suffice);
  modal option; "Add to trip with locId prefilled" (trips/plan does not
  read locId — reuse the existing addToTripHref place+lat+lng helper;
  planner locId support is a later td).

## Phase 1 — Hotspot detail page (/hotspots/[locId])  ← build first: it is
the link target every other phase points at.

- Loader: locId must match ^L\d+$ else 404 (never 500). Well-formed but
  unknown: render header from cached hotspot payloads when present, else an
  explicit "not in our hotspot cache" empty state — never a forever-spinner.
  Metadata from cached hotspotsInRegion/hotspotsNear payloads +
  frequency_fetch row (loaded status, years, n_species, sample_sizes) +
  ebird_locations Google data + county/state names.
- NEW eBird client fn recentHotspotObs(apiKey, locId, back) →
  /data/obs/{locId}/recent, cachedFetch namespace hotspotObs:{locId}:{back},
  TTL = OBS_TTL_MIN (30). back whitelist: 7 | 14 | 30 ONLY.
- Header: name, county/state, verified-hotspot badge, distance from home.
  NO GPS coordinates (GROK veto). Venue chips ONLY when google_place_status
  is a successful match AND confidence ≥ DEFAULT_MIN_CONFIDENCE, from an
  allowlist of meaningful types (park, natural_feature, campground, …;
  generic establishment/point_of_interest dropped); color+text; skip
  entirely on low-confidence rather than showing junk.
- Action bar: <640px = STACKED full-width ≥48px buttons; 2-col ≥640px only.
  Buttons: Maps/Directions (mapsPlaceUrl prefers stored google_place_id),
  "Forecast my needs here" (/forecast deep link), "Add to trip" via the
  EXISTING addToTripHref helper (place+lat+lng — no locId param), eBird ↗.
- Historical-data card: Loaded 2016–2025 · 242 species · Current/Outdated/
  Not loaded + ONE-CLICK Load/Refresh → single-loc load_hotspots job
  (existing dedup), discloses years/what will fetch; in-place progress is
  the SAME jobsPoll store as the app-wide chip (survives refresh — no
  second progress channel). Viewer role: no enqueue, matching /forecast.
- Tab bar (new small component): "Recent" (default) | "Monthly".
  Recent: recentHotspotObs, 7/14/30 selector, grouped date → checklist
  (subId) with ebird.org/checklist links, Seen/Need via existing Badge
  tokens, howMany, "Unconfirmed" chip (color+text, never color-alone),
  full detail incl. private locations (no-redaction ruling).
  Monthly: 12-month FrequencyChart for THIS loc + needs breakdown for a
  selected month (reuse forecast helpers + existing † low-sample
  convention); ONE sentence of sample_sizes confidence, no new widget.
  (48-week toggle stays td-af8393.)
- Empty states, each one sentence + the single next action: no recent
  reports (→ widen 7→14→30) / not loaded (→ Load) / job failed (→ retry).
- Entry links per the GROK swap list ONLY (Best Places, PlaceMatches,
  forecast loaded rows, forecast/species county rows, saved trip stops);
  planner candidates + pick-panel labels untouched. eBird ↗ badge always
  remains beside swapped names (wraps at 320, never dropped).
- eBird attribution footer on the new page (sacred). Help entry in-commit.
  Dual review. No schema change. Phase 2/3 NOT in this PR.

### Phase 1 acceptance (GROK)

- /hotspots/L\d+ renders header + stacked actions + historical card at
  320 and 390.
- Recent tab shows grouped checklists with ebird.org/checklist/{subId},
  Seen/Need, Unconfirmed.
- Load/Refresh enqueues, in-place bar tracks via jobsPoll, survives refresh.
- Name taps from Best Places, PlaceMatches, forecast loaded rows,
  forecast/species county rows open the page; eBird ↗ and MapLink still
  leave the app.
- Planner candidates and pick-panel checkbox labels do NOT navigate.
- npm run check clean. Help updated.

## Phase 2 — Declutter /forecast (td-a9f9eb proper)

- Replace the bottom checkbox-<details> block with the coverage pill:
  "12 of 18 loaded · 1 outdated · Manage" (counts never truncated; ≤2 lines
  at 320px; Manage ≥48px). "Load all remaining (N)" lives ON/adjacent to
  the pill — the common path needs NO panel; N excludes job-covered rows
  (actionable count, like today's loadcta), disclosed, no silent caps.
  "Choose hotspots" expands an INLINE panel below the pill (GROK-pinned:
  not a modal): search + distance badges + 48px rows, reusing today's
  pick-panel semantics (checkboxes, Select all shown, Load selected (N),
  outdated vs not-loaded groups, queued flags); collapses on second tap or
  successful queue. jobsPoll banner stays the one progress channel.
- Every hotspot name in "loaded hotspots in use" becomes a /hotspots/[locId]
  link (Phase 1 target).
- The removed view.suggested computation either powers the panel's
  "recommended" ordering or stops being shipped (audit: computed+shipped,
  UI removed).

## Phase 3 — Hotspots & Data hub (/forecast/data → richer)

- Keep the /forecast/data ROUTE (GROK-pinned — no rename, no 3rd tab);
  retitle on-page "Hotspots & data"; reached via the Phase-2 pill + the
  existing secondary entries.
- Add: hotspot/county search box → status rows linking to /hotspots/[locId];
  collapsible state→county tree with counts + outdated markers + batch
  actions; prominent active-job cards (existing jobsPoll data incl. the
  currently-fetching unit); failed-loads list gains per-row last-attempt
  status (audit: ok-after-fail invisible) and 1-click retry (exists).
- Surface per-unit job narration (unit_ok/failed/skipped events) to
  non-admin users here for THEIR loads (audit item; API endpoint already
  unguarded-but-unused beyond admin).

## Sequencing & gates

Phase 1 → 2 → 3; each: gates green → CODEX1 + GROK review → Gaylon deploy
word. AGY unavailable; its UX doc + GROK's pins are the design reference.
Phase-2 note: view.suggested either orders the Choose list or stops being
shipped — no dead payload (GROK).

## Explicitly out of scope

Weekly-resolution charts (td-af8393), detail=full observer/media flags
(td-a893c3), tides (td-6a3d2e), ref/hotspot/info audit (td-39d567 — feeds
Phase 1 later if the endpoint proves useful).

## Post-review correction (2026-08-18, CODEX1 blocker on 84a1c4b)

eBird's `/data/obs/{locId}/recent` returns only the **latest observation per
species** — it is not a checklist feed, and most checklists in the window
never appear in it. The Recent tab therefore must not present subId groups
as "checklists with N species" (that claim is materially false). Amended
contract: the Recent tab shows **the most recent report of each species**,
grouped by day, one row per species, each row linking to the checklist that
report came from (Need/Seen badges + Unconfirmed chips unchanged). The
acceptance item "grouped checklists" is superseded by this row contract.
A true checklist feed (`/product/lists`) is a separate future td if wanted.
