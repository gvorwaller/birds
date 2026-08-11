# td-854207 — Bird Forecast by Location and Month

> Revised 2026-08-06 after CODEX1 review (14 findings integrated; see "Review integration notes" at the end).

## Context

Gaylon plans birding trips and needs two questions answered from **prior years' eBird sightings** (not the ≤30-day "recent" windows the app uses everywhere today):

- **Mode A (place + month):** "Which species I still need am I likely to see near place P in month M?"
- **Mode B (species + region):** "Where in a bounded area (e.g., Florida) can I see species S, and which month is best?" — e.g., Crested Caracara: best months, best counties, best specific hotspots.

**Key finding (verified by live probe 2026-08-06):** eBird API v2 has no frequency/historical-aggregate endpoint, but `https://ebird.org/barchartData?r={code}&bmo=1&emo=12&byr=Y1&eyr=Y2&fmt=tsv` — the data behind eBird's own bar charts — returns ALL species × 48 weekly frequency buckets (fraction of checklists) + weekly checklist counts, for region codes (`US-FL`, `US-FL-057`) **and** hotspot locIds (`L123456`), in one call. It 302s to the exact CAS login `src/lib/server/ebird-account.ts` already automates for life-list sync. **User approved building on this logged-in endpoint** (same sanctioned unofficial-interface pattern, fail-soft rules apply).

**Approved scope: Phases 1–3.** Phase 4 (trips/species-page integrations) is NOT implemented now — create a follow-up `td` task for it at the end.

## Architecture decisions

- **Storage:** normalized Postgres, not JSONB blobs — queried both by-species-across-locs and by-loc-across-species. Sparse rows (only weeks with freq > 0).
- **Year range: complete prior years only** — `byr = currentYear − 10`, `eyr = currentYear − 1`. Never include the partial current year (past-month bins would include it while future-month bins can't, making the curve non-comparable). Refresh when `end_year < currentYear − 1` (i.e., annually, once the new year completes) — no short TTL; a manual per-location "Refresh" control covers the rare want-it-sooner case.
- **Fetch policy (politeness / ban-risk control):**
  - GET loaders NEVER hit `ebird.org/barchartData` — barchart data renders only from Postgres. (Official API v2 calls in loaders — hotspot lists, region lists — keep the app's existing lazy `cachedFetch` pattern; that claim is scoped to the unofficial endpoint.)
  - All barchart fetching happens in owner-triggered form actions: **concurrency 1**, ≥500 ms start-to-start spacing, ≤12 fetches per action invocation.
  - **Server-side per-owner single-flight lease** (module-level lock): one active batch per owner; concurrent/overlapping action invocations (extra tabs, double-clicks, the client auto-loop) get "batch already running" instead of parallel fan-out. A soft per-owner daily ceiling (constant, e.g. 200 fetches) backstops runaway loops.
  - **Auth failure aborts the whole batch:** on login-redirect/HTML symptom, stop scheduling immediately, evict the session memo, retry the login once, and if it still fails return `credentialProblem` — never burn remaining calls on a dead session. Only loc-specific failures (one bad TSV) are isolated per-loc.
- **Whose session:** scope owner's stored credentials (`locals.scopeId`), like life-list sync. Viewers (blocked from POSTs by `hooks.server.ts`) see cached data or an explanatory message. No credentials → cached data if any, else message pointing at Settings. Never log credentials.
- **Honest data:** show observed frequency — "reported on 34% of checklists in March (n=1,240)" — never a fabricated probability. Monthly value = checklist-weighted mean of the month's 4 weeks: `Σ(freqᵢ·nᵢ)/Σnᵢ`. **This same weighted formula is used everywhere** — month curves, county ranking, hotspot ranking — never an unweighted `SUM(freq)/4`.
- **Low-sample handling:** months/locations with `Σn` below `MIN_MONTH_N` (~40 checklists) are **excluded from "best month" argmax and from rankings whenever adequately-sampled alternatives exist**, and shown separately with a "small sample" badge (text + color) — a 100% cell with n=1 must not beat 30% with n=2,000. Raw observed freq + n is always displayed.
- **Region bounds (Mode B):** subnational1 (state) `<select>` from a new `subregions()` wrapper — no free-text region codes. Species picked via server-side ILIKE search on `taxonomy_cache` with disambiguation.
- **Action-target authorization:** loc codes submitted to actions are never trusted from the form. The server re-derives/validates targets against cached official data: syntax + kind check, county-under-state membership (from cached `subregions`), hotspot locIds from cached hotspot lists. Forged POSTs for arbitrary regions are rejected.
- Mandatory: "Data from eBird.org" attribution on every forecast page; migrations via `./backend/db/migrate_pg.sh`; component-scoped CSS, no Tailwind, no toasts, WCAG AAA, mobile-first.

## Implementation

### 1. Migration — `backend/db/migrations/0011_species_frequency.sql`

```sql
CREATE TABLE frequency_fetch (
    loc_code     TEXT PRIMARY KEY,          -- 'US-FL' | 'US-FL-057' | 'L123456'
    loc_kind     TEXT NOT NULL CHECK (loc_kind IN ('region', 'hotspot')),
    loc_name     TEXT NOT NULL,
    begin_year   SMALLINT NOT NULL,
    end_year     SMALLINT NOT NULL,
    sample_sizes INTEGER[] NOT NULL,        -- 48 weekly checklist counts
    n_species    INTEGER NOT NULL CHECK (n_species >= 0),
    n_unmatched  INTEGER NOT NULL DEFAULT 0 CHECK (n_unmatched >= 0),
    unmatched_names TEXT[] NOT NULL DEFAULT '{}',  -- representative sample (≤20), surfaced in UI
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (begin_year <= end_year),
    CHECK (cardinality(sample_sizes) = 48)
);
CREATE TABLE species_frequency (
    loc_code     TEXT NOT NULL REFERENCES frequency_fetch(loc_code) ON DELETE CASCADE,
    species_code TEXT NOT NULL,
    week         SMALLINT NOT NULL CHECK (week BETWEEN 1 AND 48),
    freq         DOUBLE PRECISION NOT NULL CHECK (freq > 0 AND freq <= 1),  -- sparse; absent = 0
    PRIMARY KEY (loc_code, species_code, week)
);
CREATE INDEX species_frequency_species_idx ON species_frequency (species_code, loc_code);
-- Attempt bookkeeping, separate from successful-fetch rows so failures are
-- visible after redirects/reloads and can't be mistaken for "not yet loaded":
CREATE TABLE frequency_fetch_attempts (
    loc_code        TEXT PRIMARY KEY,
    last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status          TEXT NOT NULL CHECK (status IN ('ok', 'error')),
    error           TEXT
);
```

Include `birds_app` grants (mirror `0002_grants.sql`). Coerce numerics at the SQL boundary per cs.md.

### 2. `src/lib/server/ebird-account.ts` — surgical refactor (narrow surface)

- Keep `CookieJar`, `fetchWithJar`, `followRedirects`, `casLogin` **module-private** (they are authenticated capabilities; exporting them makes every caller responsible for redirect bounds/cookie scope).
- Export one narrow service instead: `fetchAuthenticatedEbird(userId: number, url: string): Promise<string>` — allowlists `ebird.org` hosts, opens/reuses a memoized CAS session (~15-min memo per user, **single-flighted** so concurrent calls share one login), follows redirects, returns body text; throws a typed error on login failure or login-redirect detection.
- Session-memo invalidation: evict on auth failure and when Settings saves/clears eBird credentials.
- Existing sync functions unchanged. Never log credentials.

### 3. New `src/lib/server/barchart.ts` — fetch / parse / persist

- `BarchartError` (typed; triggers fail-soft, incl. explicit HTML-response detection = login redirect symptom).
- `parseBarchartTsv(tsv): ParsedBarchart` — **pure**; finds "Sample Size:" row, validates 48 value columns, empty cells → 0, fails loudly on structure drift.
- `matchBarchartRows(parsed, matcher, taxonomy)` — pure; names → `species_code` via existing `buildMatcher()` (`species-match.ts`), keep `category='species'` only (drop spuhs/slashes). Duplicate-code policy for lumps/splits: when two source rows map to one code, keep the higher-frequency row per week and count the collision; collect up to 20 unmatched names verbatim (surface, never guess). Known limitation to state in `/help`: barchart aggregates don't carry observation-level provisional/escaped-exotic status — we do not claim to filter those.
- `fetchBarchart(userId, locCode, byr, eyr)` — via `fetchAuthenticatedEbird`.
- **`validateParsedBarchart(parsed, matched, prior?)` — sanity gate before any write:** exactly 48 non-negative integer sample sizes; all freqs finite in (0, 1]; ≥1 matched species; no duplicate `(species_code, week)`; and if a prior `frequency_fetch` row exists, a plausibility check (e.g., new `n_species` ≥ 25% of prior). A valid-looking-but-degenerate TSV (zero matches, drastic row collapse) must **never replace good cached data** — it records an `error` attempt and the stale data keeps serving.
- `storeFrequencies(...)` — `withTransaction`: upsert `frequency_fetch`, delete + 500-row batch insert (pattern from `syncTaxonomy`, `ebird.ts:229`), upsert `frequency_fetch_attempts` status `ok`.
- `ensureFrequencies(userId, locs, {maxFetches=12})` → `{ready, refreshed, failed: {code, error}[], remaining, skipped, credentialProblem}` — fetches only missing/expired (per the annual-refresh rule), **sequentially** (concurrency 1, ≥500 ms spacing), under the per-owner single-flight lease; per-loc try/catch for data errors, **immediate batch abort** on auth errors; records every attempt in `frequency_fetch_attempts`; never throws to callers.

### 4. `src/lib/server/ebird.ts` additions (official API, existing `cachedFetch` pattern)

- `subregions(apiKey, parent, 'subnational1'|'subnational2')` — `/ref/region/list/...`, TTL 30 d.
- `hotspotsInRegion(apiKey, regionCode)` — `/ref/hotspot/{regionCode}?fmt=json`, TTL 24 h.

### 5. New `src/lib/server/forecast.ts` — engine (modeled on `query-engine.ts`: pure functions + BOUNDS + explicit errors, no hidden defaults)

- `FORECAST_BOUNDS` + `validateForecastParams(...)`; `MIN_MONTH_N = 40`.
- Pure: `monthWeeks(month)` (`(m−1)·4+1 … m·4`), `monthlyStat(...)` (checklist-weighted), `monthCurve(...)`, `rankSpeciesForMonth(...)`, `rankLocsForSpeciesMonth(...)`, `nextUncachedCounties(all, cached, failedRecently, batch)` — **excludes counties with a recent `error` attempt** so permanent failures can't block completion; progress is `{done, failed, remaining}` and the batch loop terminates when `remaining === 0`.
- **County/hotspot ranking SQL uses the weighted formula**: unnest `frequency_fetch.sample_sizes WITH ORDINALITY` to get per-week n, left-join sparse `species_frequency` rows, compute `SUM(COALESCE(freq,0) * n) / NULLIF(SUM(n),0)` over the month's weeks (sparse-safe AND sample-weighted; a 1-checklist week can't count like a 10,000-checklist week).
- **Mode A:** `forecastNeedsNear(userId, apiKey, lat, lng, distKm, month)` — `hotspotsNear` → select 8 hotspots as a **deterministic mix: 4 nearest + 4 most-active** (by `numSpeciesAllTime`, when present) to reduce famous-hotspot selection bias → one SQL read of `species_frequency` for those locIds + month weeks joined to `taxonomy_cache` → subtract `seenSet(userId)` (`needs.ts:154`) → per-species **area score** = checklist-weighted aggregate (summed numerator/denominator across analyzed hotspots), with top-3 individual hotspots shown separately; low-n handling per `MIN_MONTH_N`. Coverage is honest: "analyzed 8 of N hotspots in range" + which have data + oldest `fetched_at` + stale flag.
- **Mode B:** `speciesRegionForecast(userId, speciesCode, regionCode, month?)` — state month curve + best month (argmax **over adequately-sampled months only**); county ranking for chosen month (weighted SQL above); coverage counts (`nCached/nTotal/nFailed`); per-county hotspot drill (top 6).

### 6. Routes & UI

- **`src/routes/forecast/species/` (Mode B — Phase 1 entry):** loader reads cached barchart data only (follow the `searchParams.get`-only invariant from `src/routes/+page.server.ts:33`); species search/disambiguation; actions `loadState` (1 fetch), `analyzeCounties` (≤12 uncached-and-not-recently-failed counties per invocation; returns `{done, failed, remaining}`; client `use:enhance` loop with a visible progress bar until `remaining === 0` — server lease makes overlapping loops harmless), `loadHotspots` (county → top-6 hotspot barcharts). All action targets re-validated server-side against cached official lists. **Actions return enhanced result data (no redirect)** so failure detail reaches the UI; persisted attempt status keeps it visible across reloads. Renders 12-month `FrequencyChart` with best-month callout, ranked counties, hotspot drill-down on `ObsMap` + `MapLink`.
- **`src/routes/forecast/` (Mode A):** params `place` (via `geocodePlace`, fallback to home), `month` (defaults to current month — visible, not hidden), `dist`. Action `loadData` → `ensureFrequencies` for the validated hotspot list → returns result data (no redirect). Renders MonthPicker, ranked needs list ("34% of checklists · n=812 · best: Fort De Soto Park"), coverage banner ("No frequency data yet for 6 of 8 analyzed hotspots — Load data"), stale/failure banners with dates.
- **Nav:** add `{ href: '/forecast', label: 'Forecast' }` to `primaryItems` (`src/routes/+layout.svelte:15`) — note this makes **4 primary + "More" = 5 equal-width bottom controls** (the layout CSS comment at `+layout.svelte:323` anticipates this); verify at 320 px and 390 px incl. text zoom. The approved mockups have no forecast surface — sketch the page layout in the PR/devlog for sign-off before polishing.
- **New components:** `MonthPicker.svelte` (12-button grid, ≥48 px targets, modeled on `DatePicker.svelte`'s month grid); `FrequencyChart.svelte` (inline SVG, 48 weekly bars grouped into 12 month blocks, highlight month, low-n marked with pattern + text — never color alone).
- Every forecast page: "Data from eBird.org" attribution link.
- **`/help`:** document the feature, incl. the provisional/exotic-status limitation and data-vintage semantics ("complete years 2016–2025").

### 7. Tests (vitest; pure-function suites AND DB/route integration; no live CAS ever)

Pure:
- `barchart.test.ts` + fixtures `src/lib/server/fixtures/barchart-*.tsv` (capture one real TSV during Phase 1; imported via `?raw`): parse tolerance, sample-size row, spuh filtering, duplicate-code (lump) policy, unmatched collection, HTML → `BarchartError`, bad column count → `BarchartError`, **sanity-gate rejections (zero matches, row collapse) preserve prior data**.
- `forecast.test.ts`: `monthWeeks` boundaries (Jan→1–4, Dec→45–48), weighted `monthlyStat` incl. all-zero-n months and **uneven n (1/1 vs 300/1000)**, weighted county ranking with absent sparse rows over nonzero-n weeks, low-n exclusion from argmax/ranking, Mode A rank/tie-break, seen-set exclusion, `nextUncachedCounties` resumability incl. failed-county exclusion, bounds validation.
- `ensureFrequencies` with injected fetcher: cap enforcement, sequential spacing, per-loc data-failure isolation, **auth failure aborts batch + evicts memo**, single-flight lease (second concurrent call rejected), `credentialProblem` path.

DB/route (against `birds_test`):
- Migration applies; CHECK constraints reject bad rows; `birds_app` grants work.
- `storeFrequencies` atomic replace preserves old rows when the transaction fails mid-way.
- Forecast loaders make **zero** barchart network calls (injected fetcher that throws).
- Owner action uses `locals.scopeId`; viewer POST → 403; forged cross-region/county target → rejected.
- Note: restored-prod-snapshot test DBs can't decrypt stored logins (`EBIRD_KEY_SECRET` mismatch, cs.md:119) — injected-fetcher tests only.

### 8. Delivery order

1. **Phase 1:** migration, `fetchAuthenticatedEbird` refactor, barchart.ts (incl. sanity gate + attempts), `subregions`, `/forecast/species` with state-level month curve only + FrequencyChart + fail-soft. One end-to-end fetch proves CAS reuse/parse/store with minimal risk. Capture the TSV fixture here.
2. **Phase 2:** forecast.ts Mode A, `/forecast` page, MonthPicker, hotspot mix-selection fan-out, nav item.
3. **Phase 3:** resumable county analysis (lease + failure-terminal progress) + county ranking + hotspot drill-down + map.
4. **Wrap-up:** create a `td` task for the deferred Phase 4 (trips link "Forecast near this stop for trip month" + species-detail month sparkline); `td review` this task per workflow; devlog entry.

## Verification

- `npm run build` + `npm run check` (0 warnings) after each phase; `npm run test` for all suites.
- End-to-end on the test stack: `npm run test:db:up`, migrate, run `ANTHROPIC_API_KEY=... npm run dev:test` (port 5178); with real eBird credentials configured in Settings, exercise `/forecast/species`: Crested Caracara + Florida → `loadState` → month curve renders with n-values and low-n months excluded from the best-month callout; run `analyzeCounties` batches → resumable progress reaches terminal state even with a failing county; county ranking (expect central/SW FL counties on top); drill a county → hotspot ranking + map. Then `/forecast` near St. Petersburg for a winter month → needed-species ranking with area scores + "analyzed 8 of N" coverage. Verify viewer account sees cached data read-only; double-tab `analyzeCounties` → second loop gets "batch already running", no duplicate fetches. Attribution present on both pages; mobile layout at 320/390 px with 5 bottom controls.
- Fail-soft checks: no credentials → clear Settings pointer; bad password → batch aborts with `credentialProblem`, stale data keeps serving, no 500.

## Risks

- CAS flow breakage — shared path with life-list sync (one fix heals both); typed errors; stale-serving degradation; sanity gate prevents cache poisoning on drift.
- TSV format drift — strict pure parser + sanity gate fail loudly with "eBird changed the export"; degenerate responses never replace good data.
- Rate/ban — user-triggered only, sequential + spaced, single-flight per owner, daily soft cap, annual refresh ⇒ near-zero steady-state traffic (full FL pass = 67 requests roughly once per year).
- Droplet footprint — sparse rows; revisit pruning only if `species_frequency` exceeds ~1 M rows.

## Review integration notes (CODEX1, 2026-08-06)

All 14 findings integrated except one scope adjustment: finding #3 asked for a strict readCached/refresh split across all eBird wrappers; adopted instead as a precise scoping of the rule — loaders never touch the unofficial `barchartData` endpoint (enforced + tested), while official API v2 calls in loaders keep the app's established lazy `cachedFetch` pattern (as the home loader already does). Full review text is in the relay history (CODEX1, 3 parts, 2026-08-06T20:57Z).
