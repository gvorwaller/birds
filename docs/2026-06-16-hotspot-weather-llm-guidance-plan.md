# Hotspot context + weather + LLM field-guidance (3-phase)

_Plan — 2026-06-16. Priority P2. Tracking: see the td task referencing this doc._

## Context

The deterministic trip planner is shipped. Next: enrich the app with per-hotspot
*context* and *weather*, topped with an LLM layer that **correlates** those (plus the
target species' natural history and time-of-day) into short, hedged field guidance —
e.g. "your target hunts at night → try dusk"; "15 kt onshore wind → good for a seawatch".
This is the one genuinely LLM-shaped use we landed on: synthesis over unstructured
facts, not form-filling.

### KEY FINDING (researched 2026-06-15) — reframed the premise
The original gate was "if eBird exposes hotspot and species notes." It does **not**:
- `ref/hotspot/info` → structured metadata only (id, name, lat/lng, region codes,
  `latestObsDt`, `numSpeciesAllTime`). No description/habitat/notes.
- eBird species data → taxonomy only. No behavior/life-history.
Free-text hotspot descriptions live only on the eBird **website** (editor-contributed),
not the API; scraping is against this app's link-out ethos.

### Decisions locked in
- **Species traits come from the LLM's own knowledge**, hedged + "verify" — not eBird,
  not a Wikipedia ingestion. Basic bird natural history (nocturnal, coastal, pelagic,
  diel pattern) is well-established and the model is reliable on it. This drops any
  species-ingestion work; the traits enter at the Phase-3 correlation step.
- **Weather** from NWS `api.weather.gov` (US, free, no key) by lat/lng; OpenWeather as a
  keyed fallback. Deterministic ingestion + cache.
- **Model** `claude-sonnet-4-6`; shared `ANTHROPIC_API_KEY` (already used by
  BTC-dashboard, madonnahist, gaylonphotos), read via `$env/dynamic/private`.
- **Priority P2** — build after the current trip-planner work is approved.

## Phases (each useful on its own; build in order)

### Phase 1 — Hotspot enrichment + display (deterministic, no LLM)
Cache and surface what eBird *does* give per hotspot. Add a `hotspots` cache table for
`ref/hotspot/info` metadata; show species count + last-activity on trip stops, the
planner candidate list, and hotspot search rows.
- New: `hotspotInfo(locId)` in `src/lib/server/ebird.ts` (mirror `hotspotsNear`'s
  TTL-cache pattern); a migration for the hotspots cache; display wiring.
- Set expectations in the UI: this is metadata, not the free-text notes first imagined.

### Phase 2 — Weather (deterministic ingestion + display)
- `src/lib/server/weather.ts`: fetch current + short forecast by lat/lng from NWS,
  cached like eBird (TTL, fall back to stale on error). Show on trip stops / hotspot view.

### Phase 3 — LLM field-guidance (the LLM-shaped part)
Per stop/target, give the model: the user's needs reported there (existing engine data)
+ hotspot metadata (Phase 1) + weather + local time-of-day (Phase 2) — and have it emit
**short, hedged guidance**, drawing the species' natural history from its own knowledge.
- New: `src/lib/server/ai-guidance.ts` (orchestration only — no fabricated *facts*; the
  eBird/weather inputs stay authoritative; the model adds interpretation, clearly hedged).
- `@anthropic-ai/sdk`, structured output, `claude-sonnet-4-6`. Frame strictly as
  "suggestions to verify"; state which input each tip is based on.
- Surface on the trip detail page and/or planner stop rows, opt-in (a button or section),
  so a model call only happens when asked.

## Critical files (high-level)
- **eBird**: `src/lib/server/ebird.ts` (+ `hotspotInfo`); new migration in
  `backend/db/migrations/` (hotspots cache).
- **New**: `src/lib/server/weather.ts`; `src/lib/server/ai-guidance.ts` (Phase 3).
- **Display**: `src/lib/components/TripMap.svelte`, the planner candidate list / stop
  rows, the trip detail page.
- **Config (Phase 3)**: `package.json` (`@anthropic-ai/sdk`),
  `.env` / `.env.test` / `.env.example` (`ANTHROPIC_API_KEY`).

## Verification (per phase)
- P1: `hotspotInfo` returns/caches metadata; stop rows show species count + last activity;
  matches a direct eBird call for a known `locId`; cache hit within TTL.
- P2: weather shows for a stop's lat/lng and matches the provider; caches (no refetch
  within TTL); stale fallback on provider error.
- P3: for a stop with a nocturnal target + relevant weather, guidance is sensible, hedged,
  cites the input it used; unset key / refusal / rate-limit → clear surfaced error, no
  crash; no model call unless the user opts in.
- All: `npm run check` (0 errors), `npm run build`, `npm test` green before commit.
