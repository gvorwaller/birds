# Keep every report from external sources (td-769300)

Owner, 2026-10-28: "for sure, keep the records … I'm a data-hungry guy, so having detail is good." Plan by CC1. This follows the external sources epic (td-eec7db, closed 2026-10-28). td-46fff6 (the "What can I see?" card) depends on it and gets replanned on top of it.

## Why
The Artskart connector reads every bird report in a county and keeps only totals: reports per municipality, month and species, the top 25 places and the top birders per municipality, and the last 14 days of reports. Everything else is dropped once counted. Each new question (where in a municipality, which years, flock sizes, breeding, how many birders) would mean a connector change and a reload of every county. With one row per report, each is a query.

## Measured (2026-10-28)

**Artskart sample:** 3,000 Nordland records from a week in February, June and October. Share of records with each field filled:

| Field | Filled | Notes |
|---|---|---|
| Id, date, taxon id and scientific name, county, municipality and its number, locality, coordinates, precision | 100% | |
| Norwegian name | 99.7% | |
| Red List status (Norsk Rødliste 2021) | 98% | `Status` plus a link in `PropertyUrls` |
| Count | 94% | |
| Notes | 79% | Structured: `Activity: Forage.`, `Validationstatus: Approved Documented` |
| Behaviour | 68% | feeding, stationary, possiblereproductive, reproductive, moving, dead |
| Sex | 10% | |
| Photos | 9% | `ThumbImgUrls`: id, URL, photographer |
| Subspecies | 0.5% | |
| Survey project | 0.7% | e.g. Seapop |
| IdentifiedBy, Habitat, Info and similar | 0% | Never filled; not stored |

**Records per county, the current 24-month window (Oct 2024 – Sep 2026), from Artskart's `TotalCount`:**
- All 19 counties: 3,394,210.
- Largest: Rogaland 425,924. Then Sør-Trøndelag 401,787, Hedmark 328,109 and Vest-Agder 278,143.
- Nordland 148,536; Oslo 79,715; smallest Finnmark 39,072.
- The contract caps one load at 1,000,000 rows (`MAX_LOAD_ROWS`), so even Rogaland's records plus its totals fit.

**The two prod loads (connector log):**

| County | Reading Artskart | Sending and finishing | Records | Peak connector memory |
|---|---|---|---|---|
| Nordland | 524 s | 7 s | 148,526 | 254 MB |
| Oslo | 203 s | 2 s | 79,715 | 228 MB |

**Droplet:** 3.9 GB RAM, 2.4 GB available; disk 53 GB free of 77 GB. The prod database is 7.6 GB. Today's largest external table is 6.4 MB.

**Not measured yet:** bytes per stored record, the extra sending and finishing time, and the connector's memory. Build step 1 measures them on a real Nordland load in `birds_test`, before any of it reaches prod.

## Design

### One new chunk kind, `records`, staged and published like the others
**Migration `0097_external_records.sql`:**
- Allow `records` in the chunk-kind CHECK.
- Create `external_stage_records` and its published twin `external_records`, same columns.

| Column | Type | From Artskart |
|---|---|---|
| `source_id`, `region_code`, `load_id` | as the other published tables | |
| `upstream_record_id` | TEXT, PK with source and region | `Id` |
| `place_key` | TEXT, FK to `external_places` | county or `county:Municipality` |
| `upstream_taxon_id`, `canonical_name` | TEXT | `TaxonId`, the classified name. Non-species records (genus, hybrids; 230 in Nordland) are kept too, with rank `OTHER`. |
| `observed_on` | DATE | `CollectedDate` (day only; Artskart gives no time) |
| `count` | INTEGER NULL | `Count` |
| `locality` | TEXT NULL | `Locality` |
| `lat`, `lon`, `uncertainty_m` | DOUBLE, DOUBLE, INTEGER | `Latitude`/`Longitude` (decimal comma), `Precision` |
| `observers` | TEXT[] | `Collector` split on "\|". Must be empty unless the source stores observers, the same rule as today. |
| `behaviour` | TEXT[] | `Behavior` |
| `activity` | TEXT NULL | `Notes` "Activity: …" |
| `validation` | TEXT NULL | `Notes` "Validationstatus: …" |
| `notes` | TEXT NULL | `Notes` as sent (≤ 500), so nothing in it is lost if its format changes |
| `sex` | TEXT NULL | `Sex` |
| `photos` | JSONB NULL | `ThumbImgUrls` as `[{url, by}]`. Link-out only (cs.md gallery rule), never copied. |
| `dataset` | TEXT NULL | `DatasetName` |
| `record_url` | TEXT NULL | the sighting link, as recent reports build it |
| `upstream_modified_at` | TIMESTAMPTZ NULL | `TrackDateTime`. Lets a later load fetch only what changed (not in this ticket). |

**Indexes:** `(source_id, region_code)` for the swap; `(source_id, place_key, observed_on)`; `(source_id, upstream_taxon_id)`; `(lat, lon)` for nearby queries.

**Which records go in:** every record the load reads, from the window start through the day it ran. That includes the days after the window that today only feed "Latest reports". `observed_on` against the load's `window_end` tells them apart. Summaries stay window-only, as now.

### Taxa: one row per taxon per source, not repeated on every record
**`external_taxa`**, keyed by (`source_id`, `upstream_taxon_id`, `canonical_name`):
- columns: `raw_name`, `rank`, `local_name` (grågås), `red_list` (LC/NT/VU/EN/CR/…), `red_list_url`, `species_code`, `match_reason`, `updated_at`;
- upserted at every finish from the load's records;
- source-wide, not swapped per region: a taxon stays when one county is reloaded.

`deriveSpecies` (taxa.ts) also writes `species_code` and `match_reason` here, so readers join records to species through it. An override saved in Admin → Sources then updates one row per taxon, not every record.

### Places get their upstream number and a location
- `external_places` and its staging table get `upstream_place_id TEXT NULL` (Artskart's `MunicipalityId`, which survives renames).
- The connector also fills the existing `lat`/`lon`: the median of the municipality's report coordinates, as in the td-46fff6 plan.

### Connector
- **Parsing:** `records.ts` reads the new fields (Notes parsed for Activity and Validationstatus; raw text kept).
- **Spooling to disk:** records are written as JSON lines to a temporary file, not held in memory.
  - Reason: a county is read again from scratch when a record moves between months, and Rogaland has 2.9× Nordland's records.
  - A county re-read truncates the file.
  - After the read, the file is streamed into `records` chunks (under `CHUNK_TARGET_BYTES` and `MAX_ROWS_PER_CHUNK`), then the summary chunks follow as now.
  - The file is removed in `finally`.
- **Fingerprint:** the tag goes to `artskart-municipality/v2`.

### App side (lifecycle.ts, contract.ts)
- **Contract:**
  - `records` joins `CHUNK_KINDS` with a strict row validator: every field checked, and no unknown field.
  - Observers are refused when the source's `store_observers` is off, as for recent reports and birders.
  - The contract version stays 1: the change only adds a kind, and the app and connector are deployed together.
- **Finish:**
  - The observer check and the taxon-name check cover records.
  - The swap deletes and inserts `external_records` with the region's other rows, in the same transaction.
  - It then upserts `external_taxa`.
  - The load result gains a records count, which Admin → Sources already shows through `counts`.
- **Not changed:** existing summary tables, readers and pages. Building the summaries from records in the app (one definition instead of two) is possible later; not in this ticket.

## Build order
1. Migration and contract, with database tests.
2. Connector parsing and spool, with unit tests on the recorded fixtures (`fixtures/records.json` covers notes, party, null count and big precision).
3. Finish and swap, the taxa table and `deriveSpecies`, with database tests:
   - swap and idempotent chunks;
   - the observer policy, including records;
   - an override updating `external_taxa`;
   - a reload replacing records;
   - another county left untouched.
4. **Measure, live:**
   - **Load:** real Nordland into `birds_test` through the real connector (fixture source `xrec-<n>`, deleted after).
   - **Measure:** bytes per row and the table size with indexes; sending and finishing time; the connector's peak memory; and the finish transaction time.
   - **Check:**
     - records = Artskart's `TotalCount` for the window plus the days after it;
     - the region-level totals equal a `GROUP BY` over records for every month;
     - the species rows match a join of records to `external_taxa`.
   - **Gate:** if size, time or memory behaves badly, stop and report before going on.
5. Gates:
   - `npm run check`, then the full suite;
   - CODEX1 review at high effort: the contract, the swap transaction and the connector's spool;
   - `td review`; the owner approves.
6. **Deploy:** its own go. Then, with a go, reload Nordland and Oslo on prod. Then a read-only check of their rows and sizes.

No page changes in this ticket, so no browser or iOS pass. td-46fff6 is the first to read the records.

## Owner decision (not blocking this ticket)
**How far back to keep.** The window is 24 months (a setting on the source, `window_months`).
- Nordland from 2016 on was 723,133 records, read in 27 min 31 s on 2026-10-26 (10,000-row pages; the connector now uses 2,000).
- A longer window also changes every existing "reports per month" count. They would cover more years, and the page text says which.
- I'd keep 24 months for this ticket and decide after seeing the measured size.

## As built (2026-10-28)
Differences from the design above, and the measurements:
- **Taxa travel separately:** they have their own chunk kind, `taxa`, rather than being repeated on every record. Records reference them by a foreign key (source, taxon id, name). A record whose taxon wasn't sent in the same load fails finish with `unknown_taxon`.
- **Modified time:** `upstream_modified_at` is `TIMESTAMP`, not `TIMESTAMPTZ`, because Artskart's TrackDateTime states no zone. It is kept as given, cut to microseconds.
- **Records without a taxon id:** they are noted (`record_without_taxon`) and not kept. Every record in the live load had one.
- **"Latest reports" candidates** keep only the fields that list shows. With full records, a live read's heap grew from 122 MB to 216 MB; trimmed, it was 173 MB.
- **Load byte cap:** raised from 300 MB to 1 GB (`MAX_LOAD_BYTES`).
- **Live Nordland load into `birds_test`:**

| Measure | Result |
|---|---|
| Reports stored | 153,066 (148,536 in the window, 4,530 after it) |
| Size to send | about 603 bytes per report (92.3 MB for the county) |
| Table size | 88 MB (61 MB table, 27 MB indexes) |
| Reading Artskart | 633 s, then 335 s on a second run |
| Sending 486 chunks | 120 s and 143 s |
| Finish | 6 s |
| Connector peak memory (Mac) | 485 MB, then 462 MB after the trim |

- **Cross-checks:** all 12 monthly county totals and all 298 species equal counts taken straight from the stored reports. All 41 municipalities got a location and a number.
