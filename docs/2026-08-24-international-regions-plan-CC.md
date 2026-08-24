# td-f1d6da — Support international region loads (non-US countries)

## Context

The forecast data page (`/forecast/data`) and species page (`/forecast/species`) only accept US states: region codes are gated by `STATE_CODE_RE = /^US-[A-Z]{2}$/`, counties by `/^US-[A-Z]{2}-\d{3}$/`, grouping derives state from `code.slice(0, 5)`, and the parent country `"US"` is hard-coded into every `subregions()` call. Upcoming trips (Norway, Iceland, Germany) need frequency data for non-US regions.

**Key finding — no schema migration needed.** Every region column (`frequency_fetch.loc_code`/`region_code`, `species_frequency.loc_code`, `frequency_fetch_attempts.*`) is unconstrained `TEXT`; `NO-03`, `MX-ROO`, `GB-ENG-102` all fit today. The barchart export (`barchartUrl`, `ensureFrequencies`, `storeFrequencies` in `src/lib/server/barchart.ts`) treats the loc code as opaque and works for any eBird region. Reusing the existing `load_region`/`analyze_counties` job types avoids the jobs-type CHECK migration (the CHECK is re-stated in migrations 0016/0020/0028; new types need a migration, reused ones don't — verified `analyzeCountiesLocs` at `src/lib/server/job-handlers.ts:326` consumes a generic `{code,name}[]` snapshot and never inspects code shape). All US-only assumptions live in TS regexes/slices, SQL patterns, and the UI picker.

**eBird code structure** (the rule everything generalizes onto): codes are dash-delimited — 1 segment = country (`US`, `IS`), 2 = subnational1 (`US-FL`, `NO-03`, `MX-ROO`, `GB-ENG`), 3 = subnational2 (`US-FL-057`, `GB-ENG-102`). Segment lengths vary by country; never assume 2-letter states or 3-digit counties. Some countries lack subnational2 or even subnational1; `/ref/region/list/...` returns `[]` for missing levels.

## Design decisions (adjust at approval if desired)

1. **Country picker, not free text**: a Country `<select>` (from eBird's `/ref/region/list/country/world`) drives the existing region select. Default `US` — the current US flow is visually unchanged.
2. **Whole-country loads supported for non-US countries**: region select gets an "Entire {Country}" option (value = country code, e.g. `IS`). Not offered for US (a whole-US barchart export is disproportionate). Required for countries with no/coarse subnational1.
3. **Flat grouping, no nested country sections**: a country-level row is its own sibling group ("Iceland — countrywide"); subnational1 groups are labeled "Oslo · Norway". US groups sort first, then by country name. Keeps the US display byte-identical and the diff reviewable.

## Implementation

### 1. New utility: `src/lib/region-code.ts` (+ colocated `region-code.test.ts`)

Client-safe pure module (pattern: `src/lib/loc-id.ts`).

```ts
export type RegionLevel = "country" | "subnational1" | "subnational2";
export interface ParsedRegion {
  code: string; country: string; level: RegionLevel; parent: string | null;
}
export function parseRegionCode(raw: string | null | undefined): ParsedRegion | null;
export function regionLevel(code: string): RegionLevel | null;
export function parentOf(code: string): string | null;   // "US-FL-057" → "US-FL"
export function countryOf(code: string): string | null;  // "GB-ENG-102" → "GB"
export function isCountry / isSubnational1 / isSubnational2(code: string): boolean;
export function childLevel(level: RegionLevel): RegionLevel | null;
```

Validation: `/^[A-Z]{2}(-[A-Z0-9]+){0,2}$/` — 2-letter country, then up to two non-empty alphanumeric segments. Hotspot ids (`L602509`) fail naturally. SQL equivalent for "any 1–2 segment region": `^[A-Z]{2}(-[^-]+)?$`.

### 2. `src/lib/server/ebird.ts` — add `countries()`

Next to `subregions()` (:364-376), same `cachedFetch` + `REGION_TTL_MIN` (30-day) machinery:
`cachedFetch("regions:country:world", REGION_TTL_MIN, () => ebirdFetch("/ref/region/list/country/world?fmt=json", apiKey))`. Leave `subregions()` signature alone.

### 3. `src/routes/forecast/data/+page.server.ts`

**Loader:**
- New `?country=` GET param, default `"US"`; validate syntax (`isCountry`) + membership in `countries()` (syntax-only fallback if the list fetch fails, mirroring species/+page.server.ts:124-126).
- Fetch `countries()` → `countryName` map; `subregions(selectedCountry, "subnational1")` for the picker; plus cached subnational1 lists for each distinct country appearing in stored rows (for group display names). All cache-first — respects cs.md pacing.
- **Grouping (:176-231)**: delete `STATE_RE`/`COUNTY_RE`; classify via `parseRegionCode`:
  - region @ subnational1 → own group (as today); region @ subnational2 → block under `parentOf(code)` (replaces `slice(0,5)` at :211); region @ country → own sibling group keyed by country code, row in the `state` slot; unparseable → `orphanHotspots` (surface, don't hide — unchanged).
  - hotspots: parse `region_code` — subnational2 → block, subnational1/country → group's `stateHotspots`, else orphan.
- `StateGroup` gains `countryCode`, `countryName`, `level: "country" | "subnational1"`; keep existing field names (`stateCode`/`stateName`/`countyBlocks`) to avoid churning the svelte file.
- **Sub-region totals (:248-281)**: child list = `subregions(g.stateCode, childLevel(g.level))` — subnational2 for subnational1 groups (unchanged), subnational1 for country groups. Empty list already degrades (analyze button hidden).
- **Failed-row label (:294-299)**: replace regex + `slice(0,5)` with parse (subnational2 → "{child}, {parent}"; subnational1 → region map; country → country map).
- Sort: US groups first, then countryName, then name. Return additions: `countries`, `selectedCountry`, `states` = unloaded subnational1 of selected country, `wholeCountryLoaded`.

**`loadRegion` action (:327-367)**: replace `STATE_CODE_RE` gate with parse — accept country or subnational1 level; validate membership (country → `countries()`; subnational1 → `subregions(countryOf(code), "subnational1")`, replacing hard-coded `"US"` at :344). Payload unchanged. Error copy: "eBird doesn't list that region."

**`analyzeCounties` action (:375-419)**: same gate; children = `subregions(code, childLevel(level))` (subnational1 children for a country target). Payload/dedup unchanged → no worker or migration changes. Labels: "counties" for US states, "regions" otherwise.

**`refresh`/`retry`**: no changes (already code-agnostic).

### 4. `src/routes/forecast/data/+page.svelte`

- "Load a state" card (:649-688) → "Load a region": Country select above the region select; changing country does `goto('?country='+code, { keepFocus: true, noScroll: true })` so the loader supplies that country's list (no client-side eBird calls, no new endpoint). US pinned first.
- Region select: for non-US, prepend "Entire {Country}" (unless `wholeCountryLoaded`), then unloaded subnational1 regions. US content unchanged.
- Group summary: append "· {countryName}" when `countryCode !== "US"`; country-level groups render "{countryName} — countrywide". "counties" vs "regions" wording per group. De-US-ify headings/placeholders/empty-state copy. `forecast-data-open-states` localStorage keeps working (codes are unique keys).

### 5. `src/routes/forecast/species/+page.server.ts` + `+page.svelte`

- Drop `STATE_CODE_RE`/`COUNTY_CODE_RE` (:31-32). `validateState` (:392-399) → `validateRegion`: parse; country → `countries()` membership; subnational1 → parent-country `subregions` membership.
- Loader: `?country=` param (default `countryOf(regionParam) ?? "US"`) drives the region list; `?region=` accepts country or subnational1 level.
- Stored-data county fallback (:229-231): `LIKE '${region.code}-___'` → `LIKE '${region.code}-%'` **plus TS filter `parentOf(loc_code) === region.code`** (prefix alone would mix subnational1 and subnational2 under a country-level region).
- `countyParam` gate (:311) and actions `loadState`/`analyzeCounties`/`loadHotspots` (:408-571): parse-based gates + `validateRegion`; the existing `startsWith(`${regionCode}-`)` checks (:517, hidden input :186) are dash-safe and stay. Error copy de-US-ified.
- Svelte: "State" label → "Region", add country select (same pattern as data page).

### 6. `src/lib/server/forecast.ts`

- **:767** majority-region gate: `/^US-[A-Z]{2}$/` → `isSubnational1(rawRegion)`; **:771** `subregions(apiKey, countryOf(regionCode), "subnational1")`.
- **`rankCountiesForNeeds` :1023-1029**: gate → `isSubnational1(code) || isCountry(code)`; `LIKE '${regionCode}-___'` → `LIKE '${regionCode}-%'` + TS filter to direct children (`parentOf(loc_code) === regionCode`) — prevents grandchild double-counting under country codes; identical behavior for US states.
- **`pickSpeciesTeaserState` :1187**: SQL `loc_code ~ '^US-[A-Z]{2}$'` → `~ '^[A-Z]{2}(-[^-]+)?$'` (any subnational1 or countrywide row feeds the teaser); update doc comment :1170-1172.

### 7. Explicitly no changes (verified)

- **Migrations/schema**: none. 0013/0014 US-only patterns were one-time backfills.
- **barchart.ts**: code-agnostic; only a one-word doc-comment touch-up at :545.
- **job-policy.ts / job-handlers.ts**: dedup keys interpolate codes verbatim; handlers generic.
- **county-meta.ts**: non-US codes miss the US-FIPS map → null seat, map query falls back to eBird name + region name ("Miesbach, Bavaria") — the designed fallback.
- **life/+page.svelte:81**: leave (`NO-03` displays verbatim; stripping country would give ambiguous "03").

### Edge cases (spec)

1. Country with no subnational1: select shows only "Entire {Country}"; after load, "— countrywide" group; analyze never appears (empty child list).
2. Country loaded whole + subnational1 later: sibling groups; "Analyze remaining regions" on the country group enqueues subnational1 children, which appear as sibling groups.
3. Mixed US + international on one page: US first as today; international labeled "{Region} · {Country}"; orphan bucket unchanged.
4. Hotspots in countries lacking subnational1: `majorityRegionCode` → null → county-needs section absent (existing null path).

## Verification

1. `npm test` — new `region-code.test.ts` (US-FL / US-FL-057 / NO / NO-03 / MX-ROO / GB-ENG / GB-ENG-102 parse; L602509 / "" / "US-" / lowercase / 4-segment → null); extend `forecast-db.test.ts` for `rankCountiesForNeeds` with variable-width fixture codes asserting grandchild exclusion under a country-level code.
2. `npm run check` — 0 errors.
3. Live smoke on test DB (`npm run test:db:up`, `npm run dev:test`, port 5178, real eBird creds): Norway → load **NO-03** (Oslo); Iceland → "Entire Iceland" (**IS**); Germany → **DE-BY** then "Analyze regions" (DE has subnational2 Landkreise). Check group rendering mixed with existing US data, failed-row labels, species forecast scoped to NO-03, `/species/[code]` teaser able to pick IS. Watch `n_unmatched` counts on first international loads (local forms/hybrids may miss the taxonomy — already surfaced in UI).

## Risks

- Whole-country barchart TSVs are larger (~500–700 taxa for NO/DE — comparable to California); one credentialed request each, existing 500 ms pacing applies. Whole-US deliberately not offered.
- Overlapping coverage (country + its subnational1 both loaded) → duplicate-ish groups and teaser candidates; benign, documented in comments.
- If a real eBird code ever violates the `[A-Z0-9]+` segment charset, the row lands visibly in "Other hotspots" rather than disappearing — self-diagnosing.

## Gating of AGY review (CC, 2026-08-24)

Accepted into the plan:
1. **Region select resets on country change** — after `goto('?country=...')`, the region select renders the new country's options with a "Choose a region…" prompt selected (no stale carry-over).
2. **Country dropdown sorted by display name** (not ISO code), US pinned first via `<optgroup>` or divider.
3. **`parseRegionCode` normalizes input** — `raw.trim().toUpperCase()` before validation; `ParsedRegion.code` carries the normalized form. Tests updated accordingly ("us-fl" now parses to "US-FL").

Declined:
- Visual badge/tag for non-US or countrywide groups — the "· {Country}" and "— countrywide" text labels already distinguish these; a badge adds UI churn without new information.
- Teaser regex charset swap — `[^-]+` and `[A-Z0-9]+` are equivalent against stored codes; keeping the plan's version.

Everything else in AGY's review affirms the plan as written; no other changes.

## AGY review (advisory)

### 1. UI/UX Feedback

- **Country Picker & Navigation Flow:**
  - The `?country=` query param + `goto(..., { keepFocus: true, noScroll: true })` approach is clean and avoids bespoke client-side fetch state.
  - **Reset Behavior:** When the user switches countries, ensure the region `<select>` resets to an empty/prompt state (e.g., `"Select a region..."` or auto-selects `"Entire {Country}"`) to avoid stale subnational selections from the previous country.
  - **Country Dropdown Usability:** The eBird world country list contains ~250 entries. Pinning `US` to the top (with a divider or separate `<optgroup>`) followed by alphabetically sorted countries is great. Ensure country names are sorted by display name rather than ISO code (e.g. `Germany (DE)` before `Norway (NO)`).
- **"Entire {Country}" Option:**
  - Excellent design for countries like Iceland or small territories where subnational divisions are coarse or unnecessary.
  - Preventing whole-country loads for the US (`wholeCountryLoaded` / US exclusion) is a wise guardrail against massive barchart TSV downloads.
- **Grouping & Layout (Flat Sibling Groups):**
  - Keeping flat grouping with `"Oslo · Norway"` and `"{Country} — countrywide"` is much simpler and less brittle than nested accordions.
  - Consider adding a subtle visual badge/tag for non-US country names (or countrywide tags) so users can easily distinguish a countrywide aggregate from subnational regions in long lists.
- **Copy & Terminology:**
  - Dynamically switching between `"counties"` (for US) and `"regions"` or `"sub-regions"` (for international) across card titles, button labels (`"Analyze remaining regions"`), and empty state text keeps the interface natural without confusing US-centric users.

---

### 2. Technical Review

- **Region Code Utility (`src/lib/region-code.ts`):**
  - **Normalization:** In `parseRegionCode(raw)`, consider trimming whitespace and normalizing to uppercase (`raw.trim().toUpperCase()`) before validation, making query params and manual inputs resilient.
  - **Character Set:** The `/^[A-Z]{2}(-[A-Z0-9]+){0,2}$/` regex correctly handles all ISO 3166-2 / eBird region codes (e.g., `US-FL`, `NO-03`, `GB-ENG`, `GB-ENG-102`, `MX-ROO`).
  - **Helper Signatures:** Pure and client-safe. Returning `null` on invalid inputs fits existing patterns (like `loc-id.ts`).
- **SQL & Query Filters:**
  - The pattern `LIKE '${region.code}-%'` paired with the TypeScript filter `parentOf(loc_code) === region.code` is a very solid safeguard against grandchild double-counting when querying country-level rows.
  - **Teaser Regex:** The regex `~ '^[A-Z]{2}(-[^-]+)?$'` (or `~ '^[A-Z]{2}(-[A-Z0-9]+)?$'`) matches countrywide (`IS`) and subnational1 (`NO-03`, `US-FL`) while cleanly excluding subnational2 (`US-FL-057`).
- **Job Types & Schema:**
  - Reusing `load_region` and `analyze_counties` without schema / check constraint migrations is safe because payloads are generic `{code, name}[]` snapshots and handler logic treats region codes as opaque strings.
- **Caching & API Safety:**
  - Caching `countries()` for 30 days (`REGION_TTL_MIN`) matches `subregions()` and respects eBird API rate limits.
  - When `subregions(code, childLevel(level))` is called for countries with no subnational divisions, eBird returns `[]`, which smoothly degrades by hiding the analyze button without errors.

---

### 3. Edge Cases & Polish

- **Taxonomy Discrepancies (`n_unmatched`):** Non-US checklists frequently contain regional subspecies, morphs, or localized common names. The existing system surfaces `n_unmatched` in the UI; verifying this behavior during live smoke testing (especially for Scandinavian species) is recommended.
- **LocalStorage State Keying:** Storing open accordion states in `forecast-data-open-states` by unique region code (`US-FL`, `NO-03`, `IS`) will work seamlessly without key collisions.

