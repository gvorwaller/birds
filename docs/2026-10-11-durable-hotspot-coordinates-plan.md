# td-c2f2b2 — Durable coordinates for every downloaded hotspot

**Status:** plan, revision 1 (2026-10-11). For CODEX1 hostile review before any code. Owner go required before
implementation and again before deploy.

## Problem (measured on prod, read-only, 2026-10-11/12)
eBird returns latitude/longitude for every hotspot (`ref/hotspot/{region}`, `ref/hotspot/geo`,
`ref/hotspot/info/{locId}`). The app fetches them but never keeps them for downloaded hotspots:
- The hotspot sweep (`hotspot-sweep.ts`, `load_hotspots`) fetches the region's full list **with coordinates** and uses
  only `locId` to queue loads.
- Those lists live only in `ebird_cache` (`hotspots:` / `hotspotsRegion:`), which `pruneEbirdCache` (`jobs.ts:845`)
  deletes after **48 hours**.
- The durable table `ebird_locations` (loc_id PK, loc_name, lat, lng NOT NULL + Google place columns) is written only
  by observation feeds (`hydrateEbirdLocationPlaceIds` → `upsertEbirdLocations`) and lifer-location resolution
  (`lifer-locations.ts`, hotspot info).

| Of 7,428 downloaded hotspots | Count |
|---|---|
| durable coordinates (`ebird_locations`) | 1,669 (22%) |
| coordinates only in a list cached in the last day | 5,665 |
| no coordinates anywhere | 880 |

Missing durable coordinates fall across 63 distinct `frequency_fetch.region_code` values (1,467 subnational1, 5,961
subnational2 regions among all hotspot rows; none with NULL region).

**Who is blind:**
- Field Guide map/radius place — `guide-location.ts` `mapCoverage` joins `ebird_locations` only: always sees ~22% of
  downloaded hotspots (it already counts the rest as "missing").
- Hotspots & data map/radius — `hub-discovery.ts` takes coordinates from cached lists, then `ebird_locations` for
  loaded hotspots (`:339-352`): near-complete right after a list fetch, back to ~22% within 48 h. Intermittent.
- td-a54f8c (Home "nearest downloaded hotspot is N km away") needs this.

## Goal
Every downloaded hotspot that eBird still knows has durable coordinates within minutes of being loaded, kept current
when eBird moves it, with a visible count of any that don't. No reader changes are needed for the two map searches:
both already fall back to `ebird_locations`.

## Design

### C1. Store coordinates where they arrive (one choke point per official source)
New `rememberHotspotCoordinates(hotspots, fetchStartedAt)` in `location-placeids.ts`, called after a **successful
live fetch** (not a cache hit, not a stale fallback) of:
- `hotspotsInRegion` and `hotspotsNear` (`ebird.ts`) — via a small `onLive(data, startedAt)` hook on
  `cachedFetch`/`pacedCachedFetch`, run after the cache row is stored;
- official hotspot info (`hotspot-page.ts` `resolveOfficialHotspot`, `lifer-locations.ts` `lookupHotspot`).

Write rules:
- Upsert `(loc_id, loc_name, lat, lng)` only; **never touch `google_place_*`**. Finite lat in [-90, 90], lng in
  [-180, 180], `^L[0-9]+$` ids only (official hotspots).
- Skip unchanged rows (`WHERE (loc_name, lat, lng) IS DISTINCT FROM (EXCLUDED…)`), so a daily re-fetch of a
  4,000-hotspot list does not rewrite 4,000 rows; `updated_at` moves only on a real change.
- Freshness: a fetch that started before the row's `updated_at` never overwrites it (same rule as `ebird_cache`,
  td-b99b6d §4.8).
- Chunked at ≤2,000 rows per statement (8,000 params).
- Failure is logged, never fails the caller (the list response is still returned).

**Scope decision (for review):** store **every official hotspot in a fetched list**, not only downloaded ones. Today
that is ~112,600 distinct listed hotspots vs 6,898 rows: about 16× the rows, roughly 15–25 MB with indexes (table is
3.1 MB now). Why: the sweep fetches the list *before* it queues loads, so filtering to "downloaded" would miss every
newly loaded hotspot until the repair job (C2) runs; it also gives a later ticket the option to stop
`hubInventoryData` parsing ~8 MB of cached list JSON on every load. Rejected alternative: lat/lng columns on
`frequency_fetch` written at load time — load jobs don't carry coordinates (`retry_loc` and `refresh_loc` have none),
so it needs plumbing through every job payload and still needs C2.

Side effects checked: there is **no background Google Places sweep** — lookups run only for locations a page passes
to `hydrateEbirdLocationPlaceIds` (capped), so new rows cost no Google calls. Readers that join `ebird_locations` by a
lifer's `loc_id` (Home, Life, species page) gain coordinates for lifers at official hotspots; personal locations are
never listed.

### C2. Repair job: guarantee and backfill (`repair_hotspot_coords`, recurring daily)
Worker singleton, ensured at worker start and daily like `ensureNeedAlertScan`. Each run:
1. **Find gaps:** downloaded hotspots (`frequency_fetch.loc_kind = 'hotspot'`) with no `ebird_locations` row and no
   recent miss (C3).
2. **From the cache (no eBird calls):** fill from any cached `hotspots:`/`hotspotsRegion:`/`hotspotInfo:` payload.
3. **One list per region:** for each remaining `region_code`, `hotspotsInRegion` (the C1 hook stores every listed
   hotspot). 63 calls on the first prod run, ~0 afterwards.
4. **Per-hotspot info** for anything still missing (merged, renamed or hidden hotspots), capped at 200 per run; a
   404 records a miss.
- Paced through the existing eBird pacer/hourly reserve; every write fenced to the live claim (td-b99b6d), progress
  reported in units, cancellable; no-op when there are no gaps.
- Migration **0084**: add `repair_hotspot_coords` to `jobs_type_check`; create `hotspot_coord_misses(loc_code PK FK
  frequency_fetch ON DELETE CASCADE, reason, checked_at)`; a miss is retried after 30 days.

### C3. Visible integrity
- Admin → existing data status area: "Downloaded hotspots without coordinates: N" (0 normally), plus the misses list
  (name, code, reason) — owner-readable, no CLI.
- `mapCoverage` keeps its existing "missing" count; the Field Guide note stays honest when N > 0.

## Tests (own `zz`/fixture ids, exact cleanup, shared `birds_test` etiquette)
- C1: live list fetch stores coordinates; cache hit and stale fallback store nothing; unchanged rows keep
  `updated_at`; Google columns preserved; moved hotspot updates; older-started fetch does not overwrite a newer row;
  invalid coordinates/ids skipped; a failing upsert does not fail the fetch; 2,000-row chunking.
- C2: fills from cache with zero eBird calls; region list fills the rest; info fallback; 404 → miss; miss not
  retried before 30 days; budget/pacer respected; claim loss stops writes; idempotent second run is a no-op.
- Readers: Field Guide map place and Hotspots & data map find a downloaded hotspot **after its list cache row is
  deleted** (the regression this ticket is about).
- Migration 0084 on `birds_test`; `jobs_type_check`; job policy/handler wiring tests.

## Rollout
1. `npm run check`, affected tests, full suite (known searchable-select failure only), CODEX1 code review, owner go.
2. Deploy (0084 is small: one constraint swap + a new table — no worker pause needed; confirm the constraint swap
   lock on `jobs` is brief).
3. On prod after deploy: the first repair run; then read-only check — downloaded hotspots without coordinates → 0 or
   a named list of misses; Field Guide map near Sandnessjøen (50 km) now counts Søvik ferjekai, Salsvatnet,
   Leirfjord, Tjøtta, Hestøya, Stokkvågen, Lovund, Onøy ferge (8 downloaded).
4. Then td-a54f8c (P2) builds on it.

## Questions for review
1. Store all listed hotspots (≈112 k rows) vs only downloaded ones — is the growth or the mixed table a problem?
2. Is the `onLive` hook the right choke point, or should the write sit in each caller?
3. Daily repair vs repair triggered at the end of each hotspot load — is a ≤24 h gap for a `retry_loc`/`refresh_loc`
   loaded hotspot acceptable given C1 covers the sweep path?
4. Anything that treats an `ebird_locations` row as evidence of identity (hub-discovery says it never does) and would
   change meaning with 112 k new rows?
