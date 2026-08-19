# Life-list map + timeline (td-b5986c) — implementation plan (CC1)

Source: docs/2026-08-18-hidden-data-audit-CC1.md (life-list CSV inventory).
Status: GROK pins recorded 2026-08-19 (binding). AGY advisory still welcome, non-blocking.

## GROK rulings (binding) — 2026-08-19

Design-only review of this doc at `80e0d7d`. Independently verified the
live-CSV claims against `parseLifeListCsv` / `importLifeList`
(`ebird-account.ts`), `seen_species` (`0001_schema.sql`),
`ebird_locations` (`0008`), `ebirdFetch` 404/429 behavior, `sync_lifelist`
as a single-unit background job, drawer-only `/nearest` precedent, and
cs.md test-isolation / attribution / `resolveMissing:false` rules. AGY is
advisory and offline; these pins are the binding layer. No code in this
turn.

Verdict: **APPROVE WITH PINS**. Shape is right (verified header, extend
`seen_species` nullable 1:1, no join table, taxonomy sort stays in
td-5bc1d4, county correctly dropped because S/P is `US-FL` not county,
`resolveMissing:false`, commit split A→B→C, dual review after C, hold
for Gaylon). Do not start C until A+B honor pins 1–7.

### 1. GET `/life` is join-only. Never live-fetch.

The page loader JOINs `seen_species.loc_id` → `ebird_locations` and
renders what is already stored. No eBird API, no Google Places, no
`resolveMissing` default. Same discipline as `/nearest`.

### 2. Location resolution is fail-soft, job-only, capped, and 404-tolerant.

- Call it at the **end of `syncLifeListFromEbird`** (already a background
  `sync_lifelist` job). **Not** inside `importLifeList`'s transaction, and
  **not** on the Settings CSV form action (that request will time out).
- CSV import stores the new columns immediately; pins then come from the
  `ebird_locations` join (4,798 rows already have coords). Remaining
  personal/unknown loc_ids wait for a credentialed sync.
- CSV import success and the `seen_species` replace must **commit even if
  resolution is incomplete**. A 429/5xx/timeout during resolution must
  **not** set `life_list_status='error'` or fail the job after a good
  import. Disclose leftover unresolved on `/life`.
- `ebirdFetch` today throws on any non-OK, including **404**. Hotspot
  `/ref/hotspot/info/{locId}` 404 is **expected** for personal L-ids
  (eBird uses `L\d+` for both hotspots and personal locations —
  `isHotspotLocId` is the wrong predicate here). Checklist
  `/product/checklist/view/{subId}` 403/404 for unshared checklists is
  also expected. Add a 404/403-returns-null helper; never let those
  bubble as `EbirdError` out of this path.
- Cap **≤25 live lookups per `sync_lifelist` invocation** (hotspot info
  + checklist fallback count as the lookups for one loc_id). First-run
  remainder is picked up on later syncs. Worker budget is 4 min;
  unbounded 228-serial is how this starves need-alerts/enrichment.
- Join existing `ebird_locations` first. On a live hit, **INSERT missing
  loc_ids only** — do not UPDATE lat/lng/name on rows already present
  (obs feeds stay source of truth).
- Persist a negative: loc_ids that 404/403 both endpoints must not be
  retried every sync. Store `checked_at` (on `seen_species` or a tiny
  per-user loc attempt table). Retry a negative only after a long TTL
  or never in v1. "Only NEW loc_ids afterward" is a lie unless 404s
  are remembered.

### 3. Schema / import.

- Migration **0023** is the right next number. All new columns nullable.
  Index `seen_species (loc_id) WHERE loc_id IS NOT NULL`.
- Column is **`region_code`**, not `state_code`. S/P is `US-FL` /
  `MX-ROO` / country-only, not a US-state enum. Chips render the stored
  code (US-XX may display as XX). No county — it is not in the CSV.
- Keep writing `first_seen` from the Date column as today. Parse eBird
  dates as **calendar dates** (`D Mon YYYY` and `YYYY-MM-DD`) without
  `Date#toISOString` (UTC round-trip). Prod droplet is UTC; do not
  create a new date-shift footgun now that dates drive a timeline.
- `NUMERIC taxon_order` returns as a string at the PG boundary —
  coerce if you ever sort on it; v1 does not.
- Unmatched names: details stay unstored (no `species_code`). Same
  unmatched disclosure as today.
- Manual rows: DELETE+replace of sync/import sources is unchanged, but
  `ON CONFLICT (user_id, species_code)` against a leftover **manual**
  row must **write the new detail columns** and must **not** flip
  `source` to `ebird_sync`/`csv_import`. Today it updates `source`;
  that would either clobber manual or (if you switch to DO NOTHING)
  leave those lifers without loc_id/sub_id, so they vanish from the
  map. Fill NULLs/details, keep `source='manual'`.
- Pre-migration rows are all-NULL. **No backfill.** Empty state after
  deploy is "Sync your life list to plot where you got each lifer"
  (CSV upload also fills columns; live loc resolution still needs the
  credentialed sync).

### 4. Countable / exotic / lifer numbers.

The verified export's 228 rows **include** not-countable exotic rows.
v1 map + timeline + chips include every imported row so count parity
with the CSV is 228. Badge exotic / not-countable; do not drop them.
Lifer # = `total − csv_row_num + 1` against that full imported set
(recomputed at render). If a later filter hides not-countable, recompute
against the visible set — do not store lifer #.

### 5. `/life` UI.

- Drawer-only **Life list**, same slot pattern as Nearest lifers —
  **not** a 5th primary tab, **not** `ownerMenuItems`. Visible to
  viewers (owner's data, no redaction).
- Reuse `loadGoogleMaps` + AdvancedMarker + Map ID. **Do not** force-fit
  `ObsMap`'s single title/href info window onto a multi-lifer location.
  New list-of-lifers content path (extend ObsMap **or** a small sibling).
  Pin glyph = lifer count at that loc. Info window lists name, date,
  species-page link (`returnTo=/life`), `checklist ↗` to
  `ebird.org/checklist/{subId}` (new tab). Location name is text unless
  hotspot/info actually succeeded — then `/hotspots/{locId}` is OK.
  Personal L-ids must not 404 into a hotspot page.
- State chips filter both map and timeline. Timeline by year newest
  first; milestone rows #100, #200, …; per-year count header.
- Attribution on the page: "Data from eBird.org" with a link (cs.md
  sacred). Help + menu in-commit.
- `/life` is **read-only**. No form action that enqueues sync. Owner
  empty/stale: pointer to Settings. Viewer empty: **no Settings link**
  (viewers have no Settings) — "This page needs the account owner's
  life list" (nearest-viewer precedent).
- Unresolved disclosure exactly as specified ("N locations have no map
  pin — eBird returned no coordinates"), never silently dropped.
- Add `/life` to `safeReturnTo` labeled paths ("Life list").
- Mobile-first; scoped CSS; no toasts; WCAG AAA. Info windows with many
  lifers at one patch must scroll, not overflow the viewport.

### 6. Tests. No prod credentials in `birds_test`.

cs.md: never seed real eBird credentials into the test DB. The
authenticated header check is **already done**. Parser + import tests
use a **committed fixture** with the verified 13-column header (quoted
Location-with-commas, `19 Aug 2026`, exotic/countable variants) **plus**
the existing legacy minimal fixture. Loc resolution: mocked 404→checklist
and both-miss. E2E on the test cluster: `importLifeList` of that fixture
+ seeded `ebird_locations` rows, then `/life` renders pins + timeline +
count parity. Do **not** CAS-login user 1 against the test cluster.

### 7. Out of scope (veto if they sneak in).

Taxonomic sort / banding codes / family browse (td-5bc1d4). County life
lists. Google Places. New recurring job type. 5th primary nav tab.
Sync button on `/life`. Backfill of pre-migration rows. Updating
existing `ebird_locations` coords from checklist payloads.


## Live CSV header — VERIFIED 2026-08-19 (td mandate)

One authenticated export against the real endpoint
(`https://ebird.org/lifelist?r=world&time=life&fmt=csv`, 229 lines = 228
lifers) returned:

```
Row #,Taxon Order,Category,Common Name,Scientific Name,Count,Location,S/P,Date,LocID,SubID,Exotic,Countable
1,6710,species,Gull-billed Tern,Gelochelidon nilotica,1,Big Talbot Island SP--Spoonbill Pond (includes parking & boat ramp),US-FL,19 Aug 2026,L1125706,S384983878,,1
```

Facts that shape the design:
- **Reverse-chronological**: Row # 1 is the NEWEST lifer. Lifer number =
  `total − rowNum + 1` (computed at render, not stored as truth).
- **No coordinates** — the map needs LocID→lat/lng resolution (Phase 2).
- Date format `19 Aug 2026`; `S/P` is `US-FL`-style; `Exotic` empty or a
  flag; `Countable` is `1`/`0` (row 226-228 in the real export include a
  not-countable exotic — verified present).
- The richer header also carries `Taxon Order` (numeric sort key) and
  `Category` — captured by the parser but taxonomy-wide sort stays in
  td-5bc1d4's scope.

## Phase 1 — schema + parser + import

**Migration 0023_lifer_details.sql**: extend `seen_species` with nullable
columns (1:1 with the lifer row; no join table for a ≤1k-row list):
`csv_row_num int, taxon_order numeric, category text, obs_count int,
location_name text, loc_id text, state_code text, sub_id text,
exotic text, countable boolean`.
All nullable — manual rows and pre-migration rows simply have NULLs.

**Parser** (`parseLifeListCsv`): capture the new columns tolerantly (every
one optional; header names matched lowercased). Existing tolerant behavior
(combined "Common - Scientific" style, missing columns) unchanged — the
parser must still accept the OLD minimal fixtures.

**Import** (`importLifeList`): store the new fields on the synced rows.
The existing delete-and-replace of `source IN ('ebird_sync','csv_import')`
plus preservation of `manual` rows is unchanged. Unmatched names keep
their current reporting; their details are NOT stored (no species_code to
key on) — count disclosed in the sync result as today.

## Phase 2 — LocID → coordinates

Join `loc_id` against `ebird_locations` (4,798 rows already carry
lat/lng from observation feeds). For lifer loc_ids NOT present there:

- Resolve via eBird `GET /ref/hotspot/info/{locId}` (works for hotspot
  L-ids; uses the user's stored API key) → upsert into `ebird_locations`
  (the existing single source of coordinate truth).
- For personal (non-hotspot) locations that endpoint 404s — fall back to
  `GET /product/checklist/view/{subId}` (the CSV gives us each lifer's
  SubID), which carries the checklist's location lat/lng.
- Runs as a bounded post-sync step inside the existing sync flow (≤228
  lookups worst-case on first run, only NEW loc_ids afterward — typical
  incremental cost 0–2 requests). NOT a new recurring job type.
- `resolveMissing:false` discipline: no Google Places calls anywhere in
  this path (CODEX1 P1 precedent on nearest).
- Unresolvable locations are DISCLOSED on the page ("3 locations have no
  map pin — eBird returned no coordinates"), never silently dropped.

## Phase 3 — /life page (menu + Help in-commit)

New route `/life` ("Life list" in the menu):

1. **Map** — Google Maps JS (existing loader/patterns), one marker per
   distinct location, badge = lifer count there; click → info window
   listing that location's lifers (name, date, link to species page,
   "checklist ↗" link-out to `https://ebird.org/checklist/{subId}`).
2. **Timeline** — grouped by year (newest first): each lifer row shows
   lifer # (computed), name, location, state, date; milestone rows
   (#100, #200, …) visually marked. A per-year count header ("2026 — 41
   lifers") gives the "your birding year" read.
3. **State life lists** — chip row of state_code with counts (from the
   stored S/P column), tap to filter both map + timeline.
4. Sync freshness line + a "Sync now" pointer to Settings when the user
   has creds; empty state explains the sync/CSV path when not.
5. Viewer role: read-only page works (it's the account owner's data —
   same visibility as /targets today; no redaction per standing rule).

Sorting is date-based; taxonomic sort arrives with td-5bc1d4.

## Tests + verification

- Parser: new-header fixture (real column set, quoted Location with
  commas, `19 Aug 2026` dates, exotic/countable variants) + legacy
  minimal fixture still parses.
- Import (DB-gated): new columns land; manual rows untouched; re-import
  replaces cleanly.
- Loc resolution: unit tests with mocked eBird responses (hotspot hit,
  hotspot 404 → checklist fallback, both-miss → disclosed-unresolved).
- Live E2E: real sync as user 1 on the test cluster, then /life renders
  map pins + timeline; count parity with eBird (228).

## Commit split

A: migration + parser + import (+tests). B: loc resolution (+tests).
C: /life page + menu + Help (+E2E). Dual review after C, per range.
