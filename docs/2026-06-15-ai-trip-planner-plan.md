# Flexible query engine + trip planner (two-phase)

_Plan — 2026-06-15. Folds in: ad-hoc DB queries (td-62a73b) + AI trip planner (td-d9152d)._

## Context

Two related asks that share one foundation:

- **Ad-hoc queries (was td-62a73b, P1):** flexible queries against the DB, results
  rendered like the current needs/focused views, linking out to locations and bird
  reference sites.
- **AI trip planner (was td-d9152d, P2):** describe a trip in plain English and have the
  app build it — e.g. *"3 hotspots within 5 mi of Blue Hill ME that each have ≥3 of my
  needs in the last week, plus one historical stop on the route, named, with the trigger
  birds noted."*

**Key realization:** an LLM adds no new *capability* here — it's a natural-language skin
over a deterministic query engine. Both a parameterized form and a sentence box bottom
out in the same engine (`geoTargets()` + Places). So the engine is the foundation for
both asks, and the AI is a thin optional layer on top. Build the engine first; add NL
only if the form proves limiting.

This keeps `cs.md`'s sacred rules intact: the LLM never touches eBird data or geography —
all sightings/counts/places come from existing cached, deterministic functions, so the
model cannot fabricate data.

**Decisions locked in:** extraction-first (not a tool-use agent); model
`claude-sonnet-4-6`; historical stop via Google Places Nearby Search.

> **Codex review note — 2026-06-15:** Keep this two-phase shape, but implement Phase 1
> around a typed server engine and a transactional persistence boundary. Do not grow the
> logic primarily inside SvelteKit route actions.

---

## Phase 1 — Deterministic engine + forms (no AI). _Priority: P1_

### 1a. Flexible ad-hoc query engine + UI (the td-62a73b ask)
A parameterized query surface over the existing data: needs / recent obs / hotspots /
rare-this-week, filterable by location + radius, days-back, min-needs, species/family,
seen-vs-unseen, etc. Results rendered in the existing needs/focused style with link-outs
to Google Maps locations and bird reference sites (reuse the current card/list rendering
and `mapsPlaceUrl()` / gallery link patterns).
- **Reuse:** `geoTargets()` / `regionTargets()` / `nearbyNeeds()` and the
  `SpeciesActivity` / `PlaceRanking` shapes in `src/lib/server/needs.ts`;
  `recentNearbyObs` / `notableNearbyObs` / `hotspotsNear` in `ebird.ts`;
  `geocodePlace()` in `geocode.ts`; `haversineKm` / maps helpers in `geo.ts`.
- **Codex change:** add a first-class server module, likely
  `src/lib/server/query-engine.ts`, instead of treating `geoTargets()` as the engine.
  `geoTargets()` is a page-view helper; the shared implementation should expose typed
  engine contracts such as:
  - `TripQueryParams`
  - `QueryFilters`
  - `PlaceCandidate`
  - `TriggerSpecies`
  - `PlannedTripPreview`
  This keeps `/targets`, `/trips`, and any future NL layer thin consumers of the same
  deterministic logic.
- **Codex change:** define input bounds in the engine and enforce them at route/action
  boundaries: radius `1..50 km` (convert miles at the UI boundary), days-back `1..30`,
  stop count `1..10`, min-needs `1..20`. Missing or out-of-range params should surface
  explicit form errors, never hidden defaults that change meaning.
- This is the bulk of the work and the shared foundation for everything below.

### 1b. Trip-builder form (one consumer of the engine)
A form on `/trips`: anchor location (map picker), radius (mi), min-needs-per-stop,
num-stops, days-back, "include a historical/cultural stop" checkbox, rare-only toggle.
Runs the engine, picks the top N qualifying hotspots, finds a historical stop via Google
Places Nearby Search, optimizes the route, shows a preview, and on confirm persists.
- **Historical stop:** add `placesNearby()` to `geocode.ts` (reuses `GOOGLE_GEOCODING_KEY`,
  `type=tourist_attraction|museum|...`). **No match = explicit surfaced condition — never
  invent one.** Requires enabling Places API on the shared GCP key (same pattern as the
  recent Directions API enablement).
- **Codex change:** `placesNearby()` should return a typed result, not `Place[] | null`.
  Distinguish at least `ok`, `not_configured`, `not_found`, `rate_limited`, and
  `upstream_error`. Current `geocodePlace()` collapses missing key / timeout / no match
  into `null`, which is fine for simple search but too opaque for trip planning.
- **Reuse:** `optimizeStopOrder()` / `route.ts`; `createTrip()` + `addStop()` in
  `trips.ts` (`target_count_at_save` snapshots the count).
- **Codex change:** do not persist generated trips by calling `createTrip()` and
  `addStop()` repeatedly from the route action. Add a transactional server function,
  e.g. `savePlannedTrip()` or `createTripWithStops()`, that uses `withTransaction()` and
  writes all stops atomically. Current `addStop()` does **not** populate
  `target_count_at_save`; the new persistence boundary should snapshot the qualifying
  hotspot's `needCount`. Historical/cultural stops should use `NULL` for
  `target_count_at_save`, not a fake `0`.
- **Codex change:** clarify route ordering. Use the server-side straight-line optimizer
  (`optimizeStopOrder()` or shared route-order helper) for deterministic preview and
  save. The existing browser helper in `src/lib/route.ts` uses Google DirectionsService
  and can refine order after save when the Maps JS Directions API is available; it should
  not be required for the core server preview.
- Admin-only action; viewers read-only (mirror `hooks.server.ts` role gating). Validate
  inputs at the boundary. UI: component-scoped `<style>`, no Tailwind, no toasts — modal
  preview/confirm per `cs.md`. Keep "Data from eBird.org" attribution.
- **Codex change:** no `hooks.server.ts` edit should be needed for normal form actions.
  Viewer write blocking already happens globally. Only touch `hooks.server.ts` if this
  work adds a new public/API path that truly needs different auth behavior.

**End of Phase 1: a fully working ad-hoc query tool + trip builder, no AI dependency.**

---

## Phase 2 — Natural-language layer (optional / deferred). _Priority: P2_

A thin (~50-line) front-end that turns a sentence into Phase-1 parameters, for both the
query surface and the trip builder. Only worth doing if the forms feel constraining.

1. **Extract constraints (LLM call #1):** `@anthropic-ai/sdk`, `claude-sonnet-4-6`,
   `output_config.format` JSON schema → guaranteed-valid object
   `{ anchor, radiusMiles, minNeedsPerStop, numStops, daysBack, includeHistoricalStop, rareOnly, ... }`,
   server-side defaults for anything implicit. Feeds the exact same engine + persistence
   path as the Phase-1 form.
2. **Name + notes (LLM call #2):** hand the chosen stops + trigger species to the model
   for a trip name and one short "why" note per stop.
3. **New module** `src/lib/server/ai-trip.ts` (orchestration only — no data logic).
4. **Config:** `npm i @anthropic-ai/sdk`; `ANTHROPIC_API_KEY` in `.env` (mode 600) and
   `.env.example`, read via `$env/dynamic/private`, never logged.
5. **Errors, explicit/never silent:** missing/invalid key; Anthropic `refusal` or
   rate-limit; misparse caught at the preview step (user sees parsed constraints before
   anything runs).
- **Codex change:** before implementing Phase 2, re-check current Anthropic TypeScript SDK
  syntax against official docs. As of review, `output_config.format` JSON schema and the
  dateless model ID `claude-sonnet-4-6` are consistent with Anthropic docs, but this is a
  fast-moving dependency and should be verified at implementation time.
- **Codex change:** even with structured outputs, validate the parsed object with local
  TypeScript/runtime guards before feeding the engine. Structured JSON guarantees shape,
  not product policy such as radius caps, allowed stop counts, or whether a vague anchor
  is acceptable.

---

## Critical files
- **New:** Phase-1 query UI + trip-builder UI under `src/routes/`; (Phase 2)
  `src/lib/server/ai-trip.ts`.
- **Codex change — New:** `src/lib/server/query-engine.ts` for deterministic filtering,
  ranking, trigger-species collection, and trip-preview assembly.
- **Reuse:** `src/lib/server/needs.ts`, `src/lib/server/ebird.ts`,
  `src/lib/server/geocode.ts` (add `placesNearby`), `src/lib/server/trips.ts`,
  `src/lib/route.ts`, `src/lib/geo.ts`.
- **Codex change — Edit:** `src/lib/server/trips.ts` should gain transactional planned-trip
  persistence (`savePlannedTrip()` / `createTripWithStops()`) rather than pushing that
  responsibility into route actions.
- **Edit:** `src/routes/trips/+page.server.ts`,
  `.env.example` + `package.json` (Phase 2).
- **Codex change:** remove `hooks.server.ts` from the expected edit list unless a new
  route bypasses the existing authenticated/viewer gating model.

## Verification (end-to-end)
**Phase 1:**
1. Ad-hoc query UI: run a filtered query (e.g. unseen species within 25 km, last 14 days);
   confirm results match a direct `psql -h 127.0.0.1 -p 5436 -U birds_app -d birds` check
   against `seen_species` + cached obs, and link-outs resolve.
2. Trip-builder form with the Blue Hill parameters: each stop has `needCount >= 3`, ≤5 mi,
   ≤3 stops, one historical stop on the path; Save → `trips` + `trip_stops` rows with
   `target_count_at_save` populated.
3. Negative cases: constraints no hotspot meets, no historical site found, nonsense
   anchor → clear surfaced messages, never padded/synthetic data.
4. Engine-level tests/fixtures: given a fixed seen list + recent-observation fixture,
   candidate filtering/ranking returns deterministic `PlaceCandidate` rows, trigger
   species, and rejection reasons without hitting eBird/Google.
5. Persistence test/harness: generated preview saves `trips` + ordered `trip_stops` in
   one transaction, snapshots hotspot `target_count_at_save`, and leaves historical stops
   as `NULL`.
6. `npm run check` (0 errors) + `npm run build`.

**Phase 2 (if built):**
7. Submit the Blue Hill sentence; confirm extracted constraints match intent and the
   generated trip is identical to what the Phase-1 form produces from the same parameters
   (the AI count must equal the deterministic count — no drift). Unset key → clear error.
