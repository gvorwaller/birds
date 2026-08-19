# Life-list map + timeline (td-b5986c) — implementation plan (CC1)

Source: docs/2026-08-18-hidden-data-audit-CC1.md (life-list CSV inventory).
Status: DRAFT for AGY advisory + GROK plan review (GROK pins are binding).

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
