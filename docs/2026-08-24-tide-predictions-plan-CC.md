# td-6a3d2e — Tide predictions (NOAA CO-OPS) beside the tide tags

## Context

The app tags coastal species by productive tide stage (`tide:` vocabulary in
`src/lib/species-tags.ts:53` — `falling, low, rising, mid-tide, high-roost,
tide-independent`, stored in `species_enrichment.tags TEXT[]`) but has **no tide
data source** (audit: `docs/2026-08-18-hidden-data-audit-CC1.md:154`). This feature
adds NOAA CO-OPS tide predictions — free, keyless — so a tide-tagged species or a
coastal trip stop shows e.g. "Low 2:41 PM EDT · Mullet Key Channel (Skyway) · 0.6 mi".

**Template to mirror exactly: `src/lib/server/weather.ts`** (keyless NWS client:
module doc comment, private `Unavailable` sentinel → `null`, generic TTL cache in
the `ebird_cache` table, `AbortSignal.timeout`, UA string, stale-cache fallback
→ `<Badge kind="stale" label="cached" />`, trimmed cached payload, attribution
link, never blocks/crashes the page).

**Scope: NO migration, NO new env var, NO new `/api/` route, NO new job type.**
Surfaces: Phase A = trip detail page (per-stop), Phase B = species detail page.
Phase C (alerts page) is **deferred** — alert rows store no coordinates, the alert
already links to the species page where Phase B renders tides, and the value is
thin for a past-report notification. Do not implement Phase C now.

## Verified API facts (live-checked 2026-08-24; implementation must still fail soft)

- Station list: `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions`
  → 3,499 stations (2 MB; ~313 KB trimmed to `{id,name,lat,lng,state}`). 431 stations
  have `state: ""` (normalize to null). In the live distribution,
  `timezonecorr` behaves as the standard-time offset; MDAPI itself only calls it
  a numeric correction, so code must not treat it as a complete timezone ID.
- Predictions: `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station={id}&product=predictions&datum=MLLW&time_zone=gmt&interval=hilo&units=english&format=json&begin_date=YYYYMMDD&range=72`
  → `{ "predictions": [{ "t": "2026-08-24 14:01", "v": "2.123", "type": "H"|"L" }] }`.
  Subordinate (`type:"S"`) stations work identically with `interval=hilo` (verified on `TEC4271`).
- **Gotcha (confirmed): CO-OPS returns HTTP 200 with `{"error":{"message":…}}` bodies**
  for bad datum / out-of-range dates (bad station id gives HTTP 400 + error body).
  → parse the JSON body and check for an `error` key BEFORE any `res.ok` check.
- **Tidal-regime gotcha (measured): Tampa Bay went diurnal on 2026-08-24 with a
  16-hour gap between extremes.** A 24 h window can miss a next-high or next-low
  → always fetch `begin_date = targetDate − 1 day` with `range=72`.
- Distances measured: Fort De Soto → nearest station 1.03 km (`8726364` "Mullet Key
  Channel (Skyway)"); Orlando → 66.7 km. Cutoff **25 km** cleanly separates coastal
  from inland (FL has a station roughly every 4 km of coast).

Official CO-OPS Data API documentation independently confirms that subordinate
tide-prediction stations only support the high/low interval and must use MLLW,
and that `time_zone=gmt` returns Greenwich Mean Time. The MDAPI documentation
defines `timezonecorr` only as a numeric correction, not as an IANA zone; the
IANA mapping below therefore remains a deliberately narrow app inference, not a
provider guarantee. The 200-with-error-body status distinction and the measured
16-hour Tampa gap came from the live audit and must stay covered by fixtures,
because a later review environment may not be able to replay them over the
network.

## Timezone design (the decision that must not be re-litigated)

Times must show the **station's** wall clock, not the viewer's browser clock
(browser-tz silently lies when planning a trip in another zone, and causes SSR
hydration mismatches). Approach:

- Fetch predictions in `time_zone=gmt`; all "next extreme after now" selection is
  pure UTC epoch math (a wrong tz can mislabel a clock but never pick the wrong tide).
- Derive each station's IANA zone **once, at station-list ingest**, from
  `(timezonecorr, state)`, but only for explicit US state/territory codes. Do
  **not** map a blank/foreign state from the offset alone: `-5` also occurs in
  non-DST countries, `-4` does not imply Puerto Rico, and mapping either to a US
  DST zone would silently display the wrong wall clock. Use the following
  explicit state-code allowlists, with the numeric correction disambiguating
  split-zone states such as Florida:
  - `-5` / `America/New_York`: `CT DE DC FL GA IN KY ME MD MA MI NH NJ NY NC OH PA RI SC TN VA VT WV`
  - `-6` / `America/Chicago`: `AL AR FL IL IN IA KS KY LA MI MN MS MO NE ND OK SD TN TX WI`
  - `-8` / `America/Los_Angeles`: `CA ID NV OR WA`

  Then map
  `(-9,'AK')`→`America/Anchorage`, `(-10,'AK')`→`America/Adak`,
  `(-10,'HI')`→`Pacific/Honolulu`, and `(-4,'PR'|'VI')`→`America/Puerto_Rico`.
  Anything else, including `state:''`, is **dropped at ingest**. Document the
  exact allowlists beside `stationTimeZone` and assert every accepted pair in
  tests so expanding coverage is an intentional code change. Trim and uppercase
  provider state codes before lookup; retain normalized uppercase/null in cache.

- Format at the server serialization edge with `Intl.DateTimeFormat('en-US', {
hour:'numeric', minute:'2-digit', timeZone: tz, timeZoneName:'short' })` →
  "2:41 PM EDT". The short zone name is the honesty mechanism and must always
  render. ICU handles DST. Serialize the resulting `timeLabel`/`phrase` strings
  in each extreme and render those strings in Svelte; do not rerun `Intl` during
  hydration. A fixed `timeZone` prevents the browser-zone bug, but the ECMA-402
  spec does not guarantee that Node and every browser choose byte-identical
  short-zone labels.
- "today/tomorrow" wording: the **server** computes `dayOffset` (station-local
  calendar-day diff from now). Build `YYYY-MM-DD` from
  `Intl.DateTimeFormat(...).formatToParts()`, not by parsing
  `toLocaleDateString('en-CA')`: that idiom exists in `src/lib/next-scan.ts`, but
  locale output shape is not an API contract. The client only renders serialized
  labels, so SSR and hydration are byte-identical.
- Record the inference caveat in the module doc comment (display-only, verified
  2026-08-24 against the live station distribution).

## New file 1: `src/lib/tide-format.ts` (client-safe, pure — no fetch, no DB)

Types live here (not in `$server/tides.ts`) so Svelte components can import them
without tripping SvelteKit's illegal-server-import check (precedent: `species-tags.ts`).

```ts
export type TideKind = "H" | "L";
export interface TideExtremeCore {
  type: TideKind;
  at: string /* ISO UTC */;
  feetMllw: number;
  dayOffset: number;
}
export interface TideExtreme extends TideExtremeCore {
  timeLabel: string; // server-produced, e.g. "2:41 PM EDT"
  phrase: string; // server-produced, e.g. "Low tomorrow 6:12 AM EDT (−0.1 ft)"
}
export interface TideStationRef {
  id: string;
  name: string;
  distanceKm: number;
  tz: string;
}
export interface TideResult {
  station: TideStationRef;
  mode: "next" | "day"; // 'next' = upcoming after now; 'day' = all extremes on `date`
  date: string; // station-local YYYY-MM-DD the payload describes
  nextHigh: TideExtreme | null;
  nextLow: TideExtreme | null; // 'next' mode
  day: TideExtreme[]; // 'day' mode; chronological; [] in 'next' mode
  stale: boolean;
}
export const TIDE_ATTRIBUTION_URL = "https://tidesandcurrents.noaa.gov/";
export function formatTideTime(isoUtc: string, tz: string): string; // "2:41 PM EDT"
export function dayPrefix(e: TideExtremeCore, tz: string): string; // "" | "tomorrow " | "Wed "
export function tidePhrase(e: TideExtremeCore, tz: string): string; // "Low tomorrow 6:12 AM EDT (−0.1 ft)"
export function tideWord(t: TideKind): string; // "High" | "Low"
export function formatFeet(feetMllw: number): string; // "2.1 ft" / "−0.1 ft" (U+2212)
```

`formatTideTime`/`tidePhrase` remain exported pure helpers for server-side
decoration and focused tests. Page components render `e.timeLabel` / `e.phrase`,
not the helpers directly.

## New file 2: `src/lib/server/tides.ts`

Doc comment: API summary, verification date 2026-08-24, the 200-with-error-body
gotcha, the tz-inference caveat, and an escape-hatch note (if station-list
cold-start ever hurts, swap `loadStations()` to a committed
`src/lib/server/data/tide-stations.json` — one-function change, `county-meta.json`
precedent).

Constants:

```ts
const UA = "birds.gaylon.photos trip planner (gaylon@vorwaller.net)";
const STATIONS_URL = "…/mdapi/prod/webapi/stations.json?type=tidepredictions";
const PREDICTIONS_URL = "…/api/prod/datagetter";
const STATIONS_TTL_MIN = 43_200; // 30 days (matches ebird.ts REGION_TTL_MIN)
const PRED_TTL_MIN = 43_200; // harmonic → deterministic; key is date-scoped
const STATIONS_TIMEOUT_MS = 20_000; // 2 MB payload
const PRED_TIMEOUT_MS = 10_000; // same as weather.ts
const STATIONS_MEMO_MS = 60 * 60_000;
const MIN_STATIONS = 1000; // sanity gate vs poisoning a 30-day cache
export const TIDE_MAX_STATION_KM = 25;
class TideUnavailable extends Error {} // private sentinel, like WeatherUnavailable
```

Cache keys in `ebird_cache` (JSONB TTL cache, same upsert SQL as `weather.ts:105-110`):

- `tideStations:v1` — trimmed list `{id,name,lat,lng(4dp),state|null,tz}`; bump suffix on shape change.
- `tidePred:{stationId}:{YYYY-MM-DD}` — station-local target date; payload = trimmed
  `{ extremes: [{type, at(ISO UTC), feetMllw}] }` only.

Exported API:

```ts
export interface TideStation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  state: string | null;
  tz: string;
}
export interface TideFetchOpts {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  now?: Date;
} // injectable, xeno-canto.ts style

export async function nearestTideStation(
  lat,
  lon,
  opts?,
): Promise<{ station: TideStation; distanceKm: number } | null>;
export async function tidesNear(
  lat,
  lon,
  opts?: TideFetchOpts & { targetDate?: string | null },
): Promise<TideResult | null>;
export async function tidesForStops(
  stops: ReadonlyArray<{ id: number; lat: number | null; lon: number | null }>,
  opts?: TideFetchOpts & { startDate?: string | null; endDate?: string | null },
): Promise<Record<string, TideResult>>; // keyed by String(stop.id); DEDUPES stations, parallel-fetches unique ones
```

Exported pure helpers (the testable core): `parseCoopsTime(t)` ("2026-08-24 14:01"
GMT → ISO Z, throws on malformed), `stationTimeZone(timezonecorr, state)` (table
above, null = drop), `parseStationList(json, minStations = MIN_STATIONS)` (trim + normalize `''`→null + drop
unresolvable-tz + throw under MIN_STATIONS), `parsePredictions(json)` (throw
`TideUnavailable` on `error` key or when no valid extremes remain; filter non-H/L
rows, non-finite `v`, and individually malformed timestamps),
`nearestStation(stations, lat, lon, maxKm?)` (haversineKm from
`src/lib/geo.ts:2`; ties by input order), `pickNext(extremes, nowMs)`,
`extremesOnLocalDate(extremes, date, tz)`, `localDayOffset(isoUtc, tz, now)`,
`localDate(d, tz)`, `targetTripDate(todayLocal, start, end)`, `_resetStationMemo()`.

`parseStationList(json, minStations = MIN_STATIONS)` trims and validates the
provider payload, then applies the poison-cache threshold. Production never
overrides the default; focused tests and the hand-trimmed fixture pass a small
explicit threshold. Without this seam, the proposed ~10-station fixture cannot
exercise a successful parse because the parser always throws under 1,000.

`loadStations()` flow: module-level memo (1 h; valid — single process per
`ecosystem.config.cjs` fork mode) → `ebird_cache` fresh row → live fetch (UA
header) → `parseStationList` → upsert + memoize; on error fall back to stale row,
else rethrow (converted to null by callers). The memo exists so a 313 KB JSONB row
isn't SELECT+parsed per request.

Cached JSONB is not exempt from shape validation. Validate station and prediction
cache payloads before use; a malformed fresh row is a cache miss, and a malformed
stale row is not a fallback. This prevents a poisoned 30-day row or an old shape
from turning every page into null/500 until manual cache deletion.

`fetchPredictions(stationId, beginYYYYMMDD, opts)`: build the query with
`URL`/`URLSearchParams`, not string interpolation. Fixed params:
`datum=MLLW&time_zone=gmt&interval=hilo&units=english&format=json&begin_date={D-1}&range=72&application=birds.gaylon.photos`.
Validate station IDs against the MDAPI alphanumeric shape before constructing
the URL (IDs such as `8726364` and `TEC4271` are both legitimate).
Compose an injected caller signal with the timeout (`AbortSignal.any` on the
deployed Node runtime, or a small equivalent helper) for **both** station-list
and prediction fetches; do not silently ignore either one.
Response handling order is load-bearing: `res.text()` → `JSON.parse` (non-JSON →
generic error → stale fallback) → `parsePredictions` (throws `TideUnavailable` on
`error` key — covers both 200 and 400 error forms) → only then a `!res.ok` throw.

At each exported coordinate boundary, reject non-finite/out-of-range latitude
or longitude; validate dates as real `YYYY-MM-DD` calendar dates before doing
DB or network work.

`tidesNear()` flow: loadStations (errors→null) → nearestStation (null → return
null, **no predictions fetch**) → `tz`, `today = localDate(now, tz)`,
`date = targetDate ?? today`; a past explicit target returns null, today uses
`next`, and a future target uses `day`
→ cache read `tidePred:{id}:{date}` → fetch on miss, upsert → derive
`pickNext(extremes, now)` or `extremesOnLocalDate(extremes, date, tz)` → attach
`dayOffset` per extreme → catch: `TideUnavailable`→null; else stale row →
`{…, stale:true}`; else null. Decorate every returned extreme once with
`dayOffset`, `timeLabel`, and `phrase` before serialization. Never throws to a
page. If derivation leaves no presentable data (`day.length === 0`, or both
`nextHigh` and `nextLow` are null), return null rather than rendering an empty
tide card.

Date-targeting rule inside `tidesForStops` / `targetTripDate` (today = station-local;
`end = end_date ?? start_date`):

| Condition               | Target | Mode                                                           |
| ----------------------- | ------ | -------------------------------------------------------------- |
| `start == null`         | today  | `next`                                                         |
| `today < start`         | start  | `day`                                                          |
| `start <= today <= end` | today  | `next`                                                         |
| `today > end`           | —      | **return `{}` / null, zero fetches** (finished trip = archive) |

Note: `trips.start_date`/`end_date` arrive at the loader as `'YYYY-MM-DD' | null`
**strings** (`src/lib/server/trips.ts:58-68` casts `::text` deliberately) — string
comparison is safe and is the existing idiom.

`tidesForStops` must load the station list once, resolve every located stop,
group by `(station.id, targetDate, mode)`, and issue one prediction/cache lookup
per group. Reusing predictions does **not** mean reusing one `TideResult` object:
clone the station ref per stop so `distanceKm` remains that stop's own distance
to the shared station. One stop's distance must never leak into its siblings.

## Edit: `src/lib/species-tags.ts`

Add client-safe helpers (filter through `TAG_VOCABULARY.tide` like the
`groupTags` guard at :117):

```ts
export function tideTagValues(tags: readonly string[]): string[]; // excludes 'tide-independent'
export function isTideTagged(tags: readonly string[]): boolean; // ≥1 actionable tide stage
```

## Phase A — trip detail page

**`src/routes/trips/[id]/+page.server.ts`** — import `tidesForStops` from
`$server/tides` + `TideResult` type from `$lib/tide-format` using `import type`.
Replace the serial weather block anchored by the `// Weather for the trip area`
comment (currently lines 100-109) with a `Promise.all` so tides add no wall-clock:

```ts
const firstLocated = stops.find((s) => s.lat != null && s.lon != null);
const [weather, tidesByStop] = await Promise.all([
  firstLocated
    ? weatherFor(firstLocated.lat as number, firstLocated.lon as number)
    : Promise.resolve(null),
  tidesForStops(stops, {
    startDate: trip.start_date,
    endDate: trip.end_date,
  }).catch(() => ({}) as Record<string, TideResult>),
]);
```

Add `tidesByStop` beside `weather` in the returned object. Leave the `field_tips`
action untouched (tide-aware AI tips = separate follow-up td).

**`src/routes/trips/[id]/+page.svelte`** — import `tideWord, formatFeet,
TIDE_ATTRIBUTION_URL` from `$lib/tide-format` (`formatDistance`, `distanceUnit`,
`Badge` already in scope). Insert per-stop markup immediately after the
`.stop-forecast` block (currently lines 416-420), before `{#if s.notes}`:

```svelte
{#if data.tidesByStop[String(s.id)]}
  {@const t = data.tidesByStop[String(s.id)]}
  <div class="tideline">
    <span class="tidehead">🌊 {t.mode === 'day' ? `Tides ${t.date}` : 'Tide'}
      {#if t.stale}<Badge kind="stale" label="cached" />{/if}</span>
    <span class="tidetimes">
      {#if t.mode === 'next'}
        {#if t.nextHigh}<span class="tideitem">{t.nextHigh.phrase}</span>{/if}
        {#if t.nextLow}<span class="tideitem">{t.nextLow.phrase}</span>{/if}
      {:else}
        {#each t.day as e, i (e.at + i)}
          <span class="tideitem">{tideWord(e.type)} {e.timeLabel} ({formatFeet(e.feetMllw)})</span>
        {/each}
      {/if}
    </span>
    <span class="tidestation">{t.station.name} · {formatDistance(t.station.distanceKm, distanceUnit)} away</span>
  </div>
{/if}
```

Attribution for the new provider is mandatory:
`const anyTides = $derived(Object.keys(data.tidesByStop ?? {}).length > 0)`;
after the stops `{/each}` (currently line 479), reuse the existing `.wx-attr`
rule (currently line 778):

```svelte
{#if anyTides}
  <p class="wx-attr">Tide predictions from <a href={TIDE_ATTRIBUTION_URL} target="_blank" rel="noopener">NOAA CO-OPS</a>
  · heights relative to MLLW · predictions, not observations · not for navigation.</p>
{/if}
```

CSS beside `.aitip` (:800) — reuse the tide-chip tokens from the species page
(`#dcebf7` bg / `#163e5e` text = 9.16:1, AAA):

```css
.tideline {
  margin-top: 6px;
  padding: 8px 10px;
  background: #dcebf7;
  border-left: 3px solid #163e5e;
  border-radius: 6px;
  font-size: 0.85rem;
  color: #163e5e;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tidehead {
  font-weight: 700;
}
.tidetimes {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}
.tidestation {
  font-size: 0.76rem;
}
```

Do NOT use the `.muted` class inside `.tideline` (`var(--muted)` on `#dcebf7` is
unlikely to hit 7:1); keep `#163e5e` or verify a fixed darker value ≥7:1.

## Phase B — species detail page

**`src/routes/species/[code]/+page.server.ts`** — import `tidesNear`
(`$server/tides`), `isTideTagged` (`$lib/species-tags`), `TideResult` type via
`import type`.
Insert after the `Promise.all([getEnrichment, getSpeciesMedia])` at lines 239-242
(must follow it — the gate needs `enrichment.tags`; don't add a duplicate tags query):

```ts
// Tides beside the tide tags (td-6a3d2e): only for species with an actionable
// tide stage ('tide-independent' does not count) and only with an origin.
let tide: TideResult | null = null;
if (origin && enrichment?.field_craft && isTideTagged(enrichment.tags ?? [])) {
  tide = await tidesNear(origin.lat, origin.lon).catch(() => null);
}
```

(`origin = {lat, lon}` already computed at :86-102.) Add `tide,` to the return (:244-267).
The `field_craft` gate matches the existing UI invariant that the "Finding this
bird" card does not render without stored field-craft prose; without it, a
partial enrichment row could spend a tide lookup for markup the page hides.

**`src/routes/species/[code]/+page.svelte`** — import
`TIDE_ATTRIBUTION_URL` from `$lib/tide-format`. Insert inside the
`{#if hasFieldCraft}` "Finding this bird" card, right after the `.taggroups`
block closes (line 253): same `.tideline` structure as Phase A with header
`🌊 Tide at {data.tide.station.name}`, next-high/next-low phrases, and station
line `{formatDistance(data.tide.station.distanceKm, distanceUnit)} from
{originName} · NOAA CO-OPS predictions, MLLW`. (`Badge`, `formatDistance`,
`distanceUnit` (:35), `originName` (:39, `$derived(data.originLabel ?? "home")`)
all in scope.) Render the serialized `.phrase` fields, not `Intl` helpers in the
component. Extend the existing `.ai-attrib` paragraph (:254) with
`· <a href={TIDE_ATTRIBUTION_URL} …>Tides: NOAA CO-OPS</a>` when `data.tide`.
Same CSS block as Phase A (20 lines duplicated in two components is acceptable;
optional `TideLine.svelte` factor-out only if it stays clean).

**Field-guide browse (`src/routes/species/+page.svelte`): NO change** — a tide
lookup per result row is a fan-out; chips only.

## Tests

**`src/lib/server/tides.test.ts`** — `vi.mock('$lib/db', …)` with a SQL-routing
handler (pattern: `src/lib/server/barchart.test.ts:1-26`); injected `fetcher`
stub (pattern: `src/lib/server/xeno-canto.test.ts`); `_resetStationMemo()` in
`beforeEach`. Cover:

- `parseCoopsTime` valid/malformed; `stationTimeZone` full table incl. `(-10,'HI')`
  vs `(-10,'AK')` vs `(-10,'')→null` and `(-7,'')→null`; foreign/blank-state
  pairs at `-4/-5/-6/-8` return null rather than inheriting US DST.
- `parseStationList`: drops unresolvable tz, normalizes `''`→null, **throws under
  MIN_STATIONS** (poison-cache guard); the small happy fixture passes an explicit
  test threshold while production uses the default.
- `parsePredictions`: happy fixture; `{error:{…}}` → TideUnavailable; empty array
  → TideUnavailable; filters `type:"X"`, `v:"abc"`, and a single malformed time
  without discarding other valid rows.
- `nearestStation`: Fort De Soto fixture → `8726364` ~1.03 km; Orlando → null at
  25 km; deterministic tie-break.
- `pickNext` on the **real diurnal 2026-08-24 fixture** (16 h gap): `now=15:00Z`
  still finds next-high on 08-25 — the regression test for `range=72`.
- `extremesOnLocalDate` / `localDayOffset` (e.g. `03:00Z` next day is still
  "today" in EDT) / `targetTripDate` all four table rows (past trip → null),
  including DST-transition dates and a `formatToParts`-based local-date result.
- `tidesNear`: fresh cache → fetcher not called; stale + fetch fail → `stale:true`;
  no row + fail → null; 200-with-error → null **and no cache write**; 400-error →
  null; HTML 500 body → null/stale; out-of-range station → null with only the
  station-list fetch issued; URL contains all fixed params + `begin_date = target−1`;
  `application` param and UA header sent; caller abort and timeout abort are both
  honored; malformed dates/coordinates return null without DB/fetch calls;
  malformed fresh/stale cache rows are ignored; no derived extremes returns null.
- `tidesForStops`: 3 differently positioned same-station stops → 1 predictions
  fetch, 3 map entries with three correct per-stop distances; null-lat stop
  skipped; past trip → `{}` and zero fetches.

**`src/lib/tide-format.test.ts`**: `formatTideTime` EDT/EST both seasons,
`Pacific/Honolulu` (no DST), `America/Adak` (HADT/HAST); `formatFeet` U+2212 and
rounding; `tidePhrase` dayOffset 0 vs 1. Assert the server-decorated serialized
labels are what the UI consumes; do not claim a browser-hydration guarantee from
Node-only `Intl` tests.

**`src/lib/species-tags.test.ts`** (extend): `tideTagValues` actionable-only,
`tide-independent` → `[]`/false, out-of-vocabulary `tide:bogus` → `[]`.

**Fixtures**: `src/lib/server/fixtures/tide-predictions-8726364.json` (real
2026-08-24 GMT hilo payload) + a ~10-station hand-trimmed
`tide-stations-sample.json`. Do NOT commit the 2 MB MDAPI body.

## Implementation order

1. `src/lib/tide-format.ts` + test (pure, locks shared types)
2. `species-tags.ts` helpers + tests
3. `tides.ts` pure helpers + tests (window/tz/next-extreme logic before any I/O)
4. `tides.ts` fetch + cache layer + `tidesForStops` + tests
5. Phase A (trip loader + svelte + CSS), then Phase B (species loader + svelte)
6. Gates + manual verification

## Verification

Gates: `npm run check` (0 errors), `npm test`, `npm run build`, `npm run lint`.

Scope invariants: no new file under `backend/db/migrations/`; no new env reads;
no new `src/routes/api/` route; no new job type.

Manual (dev server: `npm run test:db:up` then `npm run dev:test`, port 5178):

- Trip stop at Fort De Soto (27.6159, −82.7371) → tide line naming "Mullet Key
  Channel (Skyway)" ~0.6 mi; inland (Orlando) stop → no tide line.
- Future-dated trip → that day's full H/L set with date prefix; past `end_date`
  → nothing; null dates → next-from-now.
- Two stops at the same beach → one CO-OPS request (temporary log/counter).
- Tide-tagged species (any `tide:falling` shorebird) → tide line in "Finding this
  bird"; `tide:tide-independent`, untagged species, or a partial enrichment row
  without `field_craft` → none and no tide lookup.
- Dead network → both pages render fully, no tide line, no 500; warm second load
  → zero outbound requests.
- Cross-check one rendered time to the minute against
  `tidesandcurrents.noaa.gov/noaatidepredictions.html?id=8726364` (EDT).
- OS timezone set to America/Denver → FL times still show **EDT** (station-tz,
  not browser-tz); no hydration mismatch warning in console.
- Contrast: text on `#dcebf7` ≥7:1; tide state conveyed by text, never color alone.

## Workflow notes

- Work under td: `td start td-6a3d2e`, `td log` progress, finish with
  `td review td-6a3d2e` (never `td close`).
- Commit only when asked; `npm run check` + `npm test` + `npm run build` first.
- Phase C (alerts) intentionally deferred — if requested later: one
  `species_enrichment` tags join over the alert rows' species codes + a single
  `tidesNear(home)` call, rendered as an additive sibling element labeled
  "Tide at home" (never touch the verbatim `title`/`body`/`url` strings,
  migration 0018 invariant).

## CODEX1 review notes

Adversarial review against the 2026-08-24 repository state corrected the
timezone allowlist, local-date construction, SSR/hydration formatting contract,
small-fixture/parser-threshold conflict, station-ID/date/coordinate validation,
abort-signal composition, per-stop distance cloning during prediction dedup,
NOAA `application` parameter, day-mode height display, navigation disclaimer,
type-only imports, and drifted trip-page source anchors. It also made the raw
cache payload versus server-decorated display payload explicit.

Provider sanity check: the official [CO-OPS Data API](https://api.tidesandcurrents.noaa.gov/api/dev)
confirms `gmt`, MLLW, and high/low-only subordinate-station behavior; the
[Metadata API](https://api.tidesandcurrents.noaa.gov/mdapi/prod/) and live station
payload confirmed the current 3,499 count and numeric `timezonecorr`, but MDAPI
does not formally define that number as an IANA/DST zone. The workspace could
not resolve the NOAA API host for direct curl replay, so the claimed HTTP
200-with-error-body cases, 431 blank-state count, measured 16-hour Tampa gap,
and empirical 25 km cutoff were not independently reproduced in this review.
Keep the captured real fixtures and manual coastal/inland checks as acceptance
evidence; do not turn those claims into untested parser assumptions.
