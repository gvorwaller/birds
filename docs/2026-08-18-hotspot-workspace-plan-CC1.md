# Hotspot Workspace — consolidated plan (AGY UX doc + CC1 hidden-data audit)

Sources: docs/2026-08-18-hotspot-forecast-ux-unified-hub-AGY.md (UX pillars),
docs/2026-08-18-hidden-data-audit-CC1.md (data inventory). Umbrella td:
td-a9f9eb (P1 declutter); absorbs td-d29394, td-b66416, td-32ca9b; consumes
audit items from td-97b22e/td-39d567/td-71494e where they touch hotspots.

## Phase 1 — Hotspot detail page (/hotspots/[locId])  ← build first: it is
the link target every other phase points at.

- Loader: validate locId (^L\d+$); hotspot metadata from cached
  hotspotsInRegion/hotspotsNear payloads + frequency_fetch row (loaded
  status, years, n_species, sample_sizes) + ebird_locations Google data
  (place link, venue-type chips — currently 100% dark) + county/state names.
- NEW eBird client fn recentHotspotObs(apiKey, locId, back) →
  /data/obs/{locId}/recent, cachedFetch namespace hotspotObs:{locId}:{back},
  OBS_TTL. (AGY's sketch, adopted as-is.)
- Header: name, county/state, verified-hotspot badge, distance from home.
  Action bar: Google Maps/Directions (mapsPlaceUrl prefers stored place id),
  "Forecast my needs here" (deep link /forecast?lat=…), "Add to trip" (link
  into planner with locId prefilled — lightweight, no new planner work),
  eBird hotspot link-out.
- Historical-data card: Loaded 2016–2025 · 242 species · Current / Outdated /
  Not loaded + ONE-CLICK Load/Refresh → enqueues the existing load_hotspots
  job (single-loc payload, existing dedup), tracked in-place via jobsPoll
  filtered to this locId (chip continues app-wide as today).
- Tab 1 Recent reports (default): recentHotspotObs with 7/14/30 selector,
  grouped by date → checklist (subId) with ebird.org/checklist links,
  Seen/Need badge per species (scope user), howMany, unconfirmed chip
  (obsValid/obsReviewed — audit Tier-1), full detail incl. private locations
  (no-redaction ruling).
- Tab 2 Monthly likelihood: 12-month FrequencyChart for THIS loc from
  species_frequency + needs breakdown for a selected month (reuse forecast
  helpers); shows sample_sizes-derived confidence. (48-week toggle stays in
  td-af8393 — not this arc.)
- Entry links added where hotspots already render: Home Best Places +
  inline place lists, /forecast loaded-hotspot rows, /forecast/species
  county hotspot rows, trip-stop hotspot names (td-32ca9b folded here).
- Help entry ships in-commit (house rule). Dual review. No schema change.

## Phase 2 — Declutter /forecast (td-a9f9eb proper)

- Replace the bottom checkbox-<details> block with a one-line coverage pill:
  "12 of 18 hotspots loaded · 1 outdated · Manage" → focused panel (inline,
  not modal-first — 390px) with exactly two paths: "Load all remaining (6)"
  (single batch job, count disclosed — no silent caps) and "Choose
  hotspots" (searchable list, distance badges, 48px rows).
- Every hotspot name in "loaded hotspots in use" becomes a /hotspots/[locId]
  link (Phase 1 target).
- The removed view.suggested computation either powers the panel's
  "recommended" ordering or stops being shipped (audit: computed+shipped,
  UI removed).

## Phase 3 — Hotspots & Data hub (/forecast/data → richer)

- Keep the /forecast/data ROUTE (deep links, job chip target) — retitle
  "Hotspots & data"; whether it becomes a visible 3rd Forecast tab is a
  GROK layout question (320px: three long tab labels — may become a
  segmented icon+short-label bar or stay drawer/secondary).
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
word. Mockups optional (AGY unavailable — its UX doc stands in as the
design reference; GROK arbitrates layout questions live).

## Explicitly out of scope

Weekly-resolution charts (td-af8393), detail=full observer/media flags
(td-a893c3), tides (td-6a3d2e), ref/hotspot/info audit (td-39d567 — feeds
Phase 1 later if the endpoint proves useful).
