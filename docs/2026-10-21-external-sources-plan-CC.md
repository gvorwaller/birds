# td-eec7db — External sightings sources (first: Norway via GBIF)

Status: plan, rev 4 (2026-10-22).
- **Rev 2** includes the CODEX1 plan review: P1 ×4, P2 ×7 and P3 ×1, all accepted. I re-checked the GBIF figures live, and the 512K versus 5m body limits in the code. Sections changed by these findings carry tags like [C-P1-1].
- **Rev 3** includes the AGY plan review (model: Argon). Its code references were checked first: `mapsPlaceUrl`, `LABELED_PATHS`, `jobsPoll`, `ProcessName`, `lastCompleteYear` and the "Add to trip" links on `forecast/species`. Sections changed by AGY's findings carry tags like [A-P1-1].
  - Accepted: P1 ×4, P2-2, P2-3, P2-4, P3 ×2.
  - P2-1 (over-engineering) is **rejected**. The owner decides scope; a reviewer's view of the app's scale is not grounds for cutting what the owner asked for. The full rev 2 upload protocol, staging, sweeper and fault tests stay.
- **Rev 4** (owner, 2026-10-22): **the data window is the most recent 24 complete months, not 2016 onward.** The aim is the most likely current sightings for each species, place and time of year. This replaces rev 3's complete-calendar-years rule (A-P3-2).

## Context
eBird has almost nothing in Norway. In Nordland, 2016–2025, it has 6,187 checklists, and its hotspots have a median of 5 checklists each. Norwegian birders report to Artsobservasjoner instead. GBIF holds about 548k Nordland bird records from it (CC BY 4.0). Gaylon may go to Norway in 2027 and wants to know where to look for what, and when.

**Owner decisions (settled):**
- **One generic ingest API.** Each source's data is fetched by a separate connector program and pushed into the app. The app never reads a source directly.
- **The UI is driven by a source registry.** No per-source code in the app.
- **Report counts never enter the eBird frequency tables** (`species_frequency`, `species_month_freq`, `loc_month_samples`, `frequency_fetch`). They are never called likelihoods.

Decided on 2026-10-21:
- **Connector:** it lives in this repo and runs on the droplet.
- **Coverage:** all 19 Norwegian counties, each loaded on demand; Nordland first.
- **Observer names:** not stored for now, but a nullable column is kept for them.
- **Effort:** each count also shows its share of all bird reports in that place and month.

**Verified facts:**
- GBIF uses the same 19 old counties as eBird (NO-01…NO-20 ↔ GADM `NOR.n_1`); Nordland is `NOR.10_1`.
- The app's `regions` table has no municipalities.
- The only machine-to-machine route today is `/api/internal/trip-places`, which uses a single bearer token kept in an env var.
- SvelteKit's CSRF check does not block JSON POSTs.
- The next migration number is 0092.
- **Totals versus species sums** [C-P1-3], for Nordland, June 2016–2025:
  - `count` = 71,870, but the 264 `speciesKey` facet terms sum to only 71,803, because some records have no species key;
  - with `occurrenceStatus=PRESENT` the count is 71,867, so 3 of the records are absences.
- **Facets** [C-P2-1]: the default facet returns only 10 terms, so every facet needs an explicit `facetLimit` plus a check that the list is complete.
- **`locality`** can be faceted, but it gives names only: "Skogsøy, Nesna, No".
- **GBIF names:** GBIF's `scientificName` includes the author ("Numenius arquata (Linnaeus, 1758)"); `canonicalName` is "Numenius arquata".
- **Body limits:** adapter-node's `BODY_SIZE_LIMIT` defaults to 512K, while `deploy/nginx.conf` allows 5m.

## Contract principles (apply to every phase)
- **Report semantics are fixed per source** [C-P2-2]:
  - Artsobs-GBIF counts **occurrence records** with `occurrenceStatus=PRESENT`, dataset `b124e1e0-…`, taxonKey 212, plus the basis-of-record and date policy pinned in Phase 0.
  - `individualCount` is a different thing and is not summed.
  - The same filters apply to the species counts, the totals, the localities and the recent reports.
- **The data window is the most recent 24 complete months, frozen when a load is created** (owner, rev 4):
  - It ends with the last complete calendar month that GBIF's copy of the dataset covers. GBIF updates its copy every few days; Phase 0 pins the exact rule.
  - It starts 24 months earlier. For a load made in late October 2026, that is `eventDate=2024-10-01,2026-09-30`.
  - Each calendar month therefore appears exactly twice, so the months can be compared.
  - Measured live on 2026-10-22 for Nordland, PRESENT records only:
    - the 24-month window holds 123,345 records, against 547,635 for 2016–2025;
    - June in the window: 16,196 records across 217 species;
    - December: 2,557 records across 112 species.
  - Recent reports cover the last weeks, as Phase 0 decides.
  - The load stores `window_start` and `window_end`, its filter fingerprint, and when the data was retrieved. Pages show the window ("Oct 2024 – Sep 2026").
- **The denominator is GBIF's own `count` for each place and month** [C-P1-3]. It is never a sum of matched species, and never a sum of child places. When there is no denominator the share shows as "share unavailable", never 0%.
- **The previous good data stays published until a load finishes completely** [C-P1-2]. An incomplete, malformed or failed load never replaces it.

## Phase 0: Unpark and finish the contract (no app code)
- In td: remove the `parked` label and make td-eec7db an epic with one child task per phase.
- Probe GBIF and write down the answers in this doc before Phase 1:
  1. **Basis of record and dates** [C-P2-2]: which `basisOfRecord` values occur, and how records whose date is only partly known (e.g. year only) are treated. Also pin the window-end rule: the last complete month that GBIF's copy covers, read from the dataset's last-crawl or publish date (rev 4).
  2. **Exhausting a facet** [C-P2-1]: `facetLimit`/`facetOffset` paging rules, with no `facetMinCount`. Prove completeness: either the sum of terms plus the records with no species key equals `count`, or the load is marked partial and fails.
  3. **Municipality discovery** [C-P2-1]: a facet of `gadmLevel2Gid` over the whole load window, not one month. Counties don't all have 45 municipalities. Also record which GADM version GBIF uses.
  4. **Top localities** [C-P2-4, A-P1-3]:
     - **Scope:** per municipality over the whole window, from the `locality` facet. This adds one call per municipality.
     - **Per species**, the "where" is the top municipalities, taken from `external_place_month_species`. There are no per-species locality calls, which would be ~350 more per county; they are left for later if the trip proves they're needed.
     - **Still to decide in the probe:** the tie-break rule.
     - **How each locality is placed.** Default: only its municipality, as text, with **no pin**. A coordinate is used only if a validated rule (e.g. the median of the PRESENT records with uncertainty ≤1 km, checked to agree) is proved in the probe.
  5. **Recent reports** [C-P2-4]: search has no documented sort by date, and stops at 100,000 results (Nordland 2016–2026 has 602k records).
     - Method: newest-first date windows (e.g. the last 14 then 60 days), each fetched completely and then sorted, deduplicated by GBIF `key`, and marked incomplete if a window overflows.
     - If that doesn't hold, recent reports are dropped from v1.
  6. **Request rate**: the concurrency cap, the per-request deadline, `Retry-After`, jitter, and a finite number of retries.
  7. **The Artskart link-out URL** for a county.
- Plan reviews: CODEX1 (rev 2) and AGY (rev 3) are done. Rev 4 holds the owner's changes.

### Phase 0 findings (td-fc5f1a, 2026-10-22; live, read-only GBIF probes)
Unless stated otherwise, every probe used dataset `b124e1e0-…`, taxonKey 212 and `occurrenceStatus=PRESENT`, over the window `eventDate=2024-10-01,2026-09-30`.

1. **Basis of record:** all 123,345 Nordland (GADM) records in the window are `HUMAN_OBSERVATION`; there is no other basis to pin. `ABSENT`: 11 records, now excluded.
   - Data-quality flags: `COORDINATE_ROUNDED` on almost all records (harmless), `COORDINATE_UNCERTAINTY_METERS_INVALID` 39, `TAXON_MATCH_HIGHERRANK` 22.
   - No date-related flags, so every record has a full day date.
2. **Window end:** GBIF re-copies the dataset weekly (Saturdays about 03:20 UTC). The last good copy was 2026-10-11 (`pubDate` 2026-10-10); the 2026-10-18 copy was aborted.
   - October 2026 records run to about 10 October.
   - **Rule:** the window ends with the last complete month before the latest **successful** copy (from `/v1/dataset/{key}/process`, `finishReason=NORMAL`).
   - Today that gives Oct 2024 – Sep 2026.
3. **Facets are complete when paged:**
   - With `facetLimit=1000` there are 297 species terms, the same set as three pages of `facetLimit=100` with `facetOffset` 0, 100 and 200. The call takes 0.4 s.
   - **Completeness rule:** returned terms < `facetLimit` (otherwise keep paging), and then `count − Σ species = unkeyed`.
   - Unkeyed means records identified only to genus or family: 430 of 123,345 (0.35%); June: 20 of 16,196.
   - The `taxonKey` facet can't be used for this: it counts every record under all its parent taxa too.
4. **Municipalities (GADM):**
   - For each of the 19 counties the `gadmLevel2Gid` facet adds up exactly to the county count (Nordland: 45 municipalities, 123,345 = 123,345).
   - GBIF doesn't state its GADM version. The connector stores gids as they are and writes `geo_scheme='GBIF-GADM'`.
   - **Names must not drive the mapping:** GBIF returns "Ãstfold" (garbled) for `NOR.2_1`.
   - Explicit county map (all 19 verified):

     | GBIF | App |
     |---|---|
     | NOR.1_1 | NO-02 |
     | NOR.2_1 | NO-01 |
     | NOR.3_1 | NO-09 |
     | NOR.4_1 | NO-06 |
     | NOR.5_1 | NO-20 |
     | NOR.6_1 | NO-04 |
     | NOR.7_1 | NO-12 |
     | NOR.8_1 | NO-15 |
     | NOR.9_1 | NO-17 |
     | NOR.10_1 | NO-18 |
     | NOR.11_1 | NO-05 |
     | NOR.12_1 | NO-03 |
     | NOR.13_1 | NO-11 |
     | NOR.14_1 | NO-14 |
     | NOR.15_1 | NO-16 |
     | NOR.16_1 | NO-08 |
     | NOR.17_1 | NO-19 |
     | NOR.18_1 | NO-10 |
     | NOR.19_1 | NO-07 |

5. **⚠ GADM leaves out coastal records: needs an owner decision.**
   - **Scale:** 455,853 of Norway's 3,390,794 records in the window (13%) fall in no GADM county. For Nordland, the publisher's own county field (`stateProvince=Nordland`) has 148,474 records, but GADM has only 123,345, so 17% are missing.
   - **Coastal birds hardest hit:** Common Eider 62% missing, Black Guillemot 61%, Long-tailed Duck 69%, Great Cormorant 61%, Herring Gull 46%, White-tailed Eagle 24%.
   - **Some records found only outside the polygons:** Manx Shearwater, Sabine's Gull.
   - **Inland sites missed too**, e.g. "Vassdal 173, Meløy". GADM's coastline is coarse, and GBIF only matches a record to a county when its coordinates fall inside that county's polygon.
   - **Every record has the publisher's own fields:**
     - `stateProvince`, which uses the 2024 counties (Trøndelag, Agder, Vestland, Innlandet, …);
     - `municipality`;
     - `locality` in the form "Site, Municipality, No".
   - **GBIF search can filter on `stateProvince`, but ignores `municipality`** (checked: `municipality=Bogus` returns the same count), and `municipality` can't be faceted.
   - **Options:**
     - **(A)** Stay with GADM facets and accept the coastal gap.
     - **(B)** Page through the raw records per county (by `stateProvince` and month), and have the connector do the counting by the records' own `municipality`. Each current municipality is mapped to the app's old county, with the record's GADM county deciding when a municipality spans two old counties.
       - It covers everything, needs no GBIF account, and the same pass yields localities with coordinates and the recent reports.
       - The cost is ~500 calls for Nordland and ~1,700 for Trøndelag.
     - **(C)** Use a GBIF SQL download (one asynchronous job that does the grouping on GBIF's side). It needs a GBIF user account, and gives a citable download DOI.
   - **Owner decision (2026-10-22): (B).** Phase 2 describes how the connector reads the data and what one load costs.
6. **Top localities:** the `locality` facet is complete per municipality (Nesna: 231 localities, adding up to 8,148 = count).
   - Localities are Artsobservasjoner's fixed sites. "Skogsøy, Nesna" (4,306 records) has 2 distinct coordinates, and 895 of the first 900 records have 100 m uncertainty. Half the records are within 0.0 km of the median and 90% within 0.0 km; the furthest is 1.58 km.
   - **Placement rule:** take the median coordinate of the locality's records; it gets a pin only when 90% of the records are within 1 km of it and the median uncertainty is ≤1 km. Otherwise the locality is shown as text.
   - Under option (B), this comes from the raw records with no extra calls.
7. **Sensitive species:**
   - No records anywhere carry `informationWithheld` or `dataGeneralizations`.
   - Gyrfalcon: 36 Nordland records, uncertainty 300–826 m. Golden Eagle: 170.
   - **Snowy Owl and Great Grey Owl: 0 records.** Sensitive species appear to be **left out entirely** of the public copy.
   - **UI rule:** "no reports" must never read as "absent". The card says that sensitive species may be hidden by the source.
   - Uncertainty: 4,740 records are >1 km and none >5 km. Records with no uncertainty: ≈12,952 (estimated from the top-60 facet).
8. **Recent reports:** the last 14 days with data (26 Sep – 10 Oct) hold 2,768 Nordland records, 10 pages of 300.
   - Pages aren't sorted by date, so fetch the whole window, then sort and deduplicate by GBIF `key`.
   - Each record links to `https://www.artsobservasjoner.no/Sighting/{catalogNumber}`; verified for 41803040, a European Robin. The `institutionCode` is `nbic`.
9. **Request rate:** GBIF publishes no limit; its responses carry cache headers (`max-age=600`).
   - **Policy:** concurrency 2, a 30 s deadline per request, retry on 429 and 5xx using `Retry-After` or exponential backoff with jitter, at most 5 tries, then the load fails.
10. **Artskart link-out:**
    - **Format:** the app reads its state from the URL, `#map/{center}/{zoom}/background/{bg}/filter/{JSON}`, with `{"AreaIds":[…],"TaxonIds":[…],"Months":[…]}`.
    - **Blocker:** the IDs are Artsdatabanken's own, not GBIF's.
    - **Decision:** county links go to the matching GBIF occurrence search, which shows exactly the records we count, plus Artskart's front page. The Artskart deep link is checked in a browser in Phase 3; a species-level link needs the mapping to Artsdatabanken taxon IDs and is deferred.
11. **2024 county × old county (`stateProvince` × `gadmLevel1Gid`, all of Norway, window):**
    - Records with no GADM county, for each 2024 county:

      | 2024 county | No GADM county |
      |---|---|
      | Trøndelag | 88,597 |
      | Agder | 89,336 |
      | Rogaland | 42,788 |
      | Østfold | 47,734 |
      | Vestland | 36,822 |
      | Vestfold | 30,460 |
      | Akershus | 27,996 |
      | Finnmark | 26,044 |
      | Nordland | 25,583 |
      | Møre og Romsdal | 13,719 |
      | Troms | 10,204 |
      | Oslo | 6,064 |
      | Buskerud | 5,638 |
      | Telemark | 3,339 |
      | Innlandet | 0 |

    - Which old counties each 2024 county spans (≥50 records):

      | 2024 county | Old counties |
      |---|---|
      | Trøndelag | NO-16, NO-17 (+ NO-15 2,350) |
      | Agder | NO-10, NO-09 |
      | Vestland | NO-12, NO-14 |
      | Innlandet | NO-04, NO-05 |
      | Akershus | NO-02 (+ NO-06 9,628, NO-05 2,450, NO-03 1,331) |
      | Troms | NO-19 (+ NO-18 499) |
      | Buskerud | NO-06 (+ NO-02 802, NO-07 691) |
      | Finnmark | NO-20 (+ 3,934 with Russian coordinates) |

    - This is why the connector works out the set of 2024 counties to fetch from the data at load time, rather than from a hand-made list.
12. **Contract v1 is pinned** in Phase 1 → "Ingest contract v1" below.
13. **GBIF downloads instead of paging (checked 2026-10-22 after the owner offered a GBIF account):**
    - **The account works:** basic auth was checked against `/v1/occurrence/download/user/{user}`; a wrong password gets 401. The login is in `.local/gbif.env` (gitignored, mode 600) and is never logged or committed.
    - **Fields per format,** from GBIF's `/v1/occurrence/download/describe/{format}`:
      - **SIMPLE_CSV / SIMPLE_PARQUET** (50 columns) have no `municipality` and no GADM gids, so they can't place records the option-B way. `locality` holds "Site, Municipality, No" as free text, which is not a key.
      - **DWCA:** the interpreted `occurrence.txt` (230 columns) has `municipality`, `stateProvince`, `level1Gid`, `level2Gid`, `locality`, coordinates, uncertainty, `catalogNumber` and `speciesKey`. It is fit for option B.
      - **SQL_TSV_ZIP** has the same fields and groups on GBIF's side, but it is experimental and needs GBIF helpdesk to enable it per user (403 otherwise).
    - **Measured on GBIF's public download log** (`/v1/occurrence/download/dataset/b124e1e0-…`, 17–22 Oct 2026, successful downloads of 30k–3M records). Turnaround runs from creation to the last modification, and includes the queue.

      | Format | Compressed size | Typical turnaround | Slow tail |
      |---|---|---|---|
      | DWCA | 200–620 B/record | 40–75 min | 90–115 min |
      | SIMPLE_CSV | 60–135 B/record | 15–30 min | 50–110 min |
      | SQL_TSV_ZIP | 20–60 B/row | 15–35 min | 40 min |

    - **What a DWCA load would cost:**
      - Nordland (196k records): ~60–110 MB, one request, ~45–115 min.
      - Trøndelag (511k records): ~150–300 MB, ~45–115 min.
      - Paging (Phase 2 table) moves ~10× more data (1–2.6 GB) but **finishes sooner**: 10–15 and 30–45 min.
    - **Conclusion:** the download is lighter on bandwidth and gives a citable DOI per load, but it isn't faster end to end for one county.
    - **Owner decision (2026-10-22): keep paging (option B).** The GBIF login stays local and unused. If GBIF's SQL download becomes generally available, revisit.

## Phase 1: Generic ingest foundation (app side)

### Migration `0092_external_sources.sql`
All of these tables are separate from the eBird tables. Composite foreign keys are scoped by source throughout [C-P2-3].
- `external_sources`
  - Columns: `id` slug, `name`, `publisher`, `license`, `license_url`, `citation`, `doi`, `attribution`, `record_semantics`, `homepage`, `region_link_template`, `covers_country`, `geo_scheme` (e.g. `GADM 4.1`), `store_observers BOOLEAN NOT NULL DEFAULT false`, `active`.
- `external_connectors`
  - Columns: `id`, `source_id` FK, `token_sha256 UNIQUE`, `created_at`, `last_seen_at`, `revoked_at`.
- `external_region_map`
  - Columns: `(source_id, place_key)` → `region_code` FK `regions`, unique per source.
  - This is an explicit mapping, seeded by migration or admin, and never inferred from names at ingest time [C-P2-3].
- `external_places`
  - Columns: `(source_id, place_key)`, `name`, `level` (`region` | `subregion`), `parent_key` (composite FK on the same source), `region_code` (the county it belongs to), `lat`/`lon` nullable.
  - Cycles and attaching a place to a different region are rejected.
- `external_loads`
  - Columns: `id` uuid, `source_id`, `region_code`, `requested_by`, `status` (queued | leased | staging | done | failed | superseded), `attempt`, `lease_token`, `claim_idempotency_key`, `lease_expires_at`, `heartbeat_at`, `connector_id`, `filter_fingerprint`, `window_start`, `window_end`, `retrieved_at`, `progress`, `error` (sanitized), `result` jsonb, timestamps.
  - **A partial unique index allows one active load per (source, region)** [C-P1-1].
- `external_load_chunks`
  - Columns: `(load_id, chunk_id)` → `kind`, `sha256`, `rows`, `received_at` [C-P1-2].
- Staging tables keyed by `load_id`, one per chunk kind, with the same columns as their published tables. Finish and fail delete them, and a sweeper removes abandoned ones after 7 days.
- Published tables. **Each one has `region_code NOT NULL` and `load_id`**, so swapping and reading a county is a single `WHERE source_id=$1 AND region_code=$2` [A-P1-2, C-P1-2, C-P2-3]:
  - `external_place_month_totals (source_id, region_code, place_key, month)`: `reports` (GBIF `count`), plus `unkeyed` (records without a species key).
  - `external_taxon_month (source_id, region_code, place_key, upstream_taxon_id, month)`: `reports`, `canonical_name`, `raw_name`.
    - These are raw upstream taxa, kept so that the data can be rebuilt after an override or a taxonomy change without fetching again [C-P1-4].
  - `external_place_month_species (source_id, region_code, place_key, species_code FK taxonomy_cache, month)`: `reports`.
    - Derived from `external_taxon_month`. When several upstream taxa map to the same species code, their counts are **summed** [C-P1-4].
  - `external_top_localities (source_id, region_code, place_key, rank)`: `locality`, `reports`, coordinates as Phase 0 decides, `uncertainty_m` (nullable, distinct from 0), and `generalized`/`withheld` flags [C-P2-5].
  - `external_recent_reports`: `(source_id, upstream_record_id) UNIQUE`, `region_code`, `place_key`, `upstream_taxon_id NOT NULL`, `species_code` NULL until matched [A-P1-2], `observed_on`, `count` (nullable), `locality`, coordinates plus `uncertainty_m` nullable, `generalized`, `record_url`, `observer TEXT NULL` (left open).
  - `external_unmatched (source_id, region_code, canonical_name, upstream_taxon_id)`: `reports`. Kept per region; the source-wide totals are derived from it [C-P2-3].
- `external_taxon_overrides`
  - Columns: `(source_id, upstream_taxon_id)` → `species_code` FK, `canonical_name`, `set_by`, `set_at`.
- `CHECK` constraints:
  - counts are non-negative integers no larger than 2^31−1 (`int4`);
  - months are 1–12;
  - years are 1900 through the current year + 1;
  - latitude is between −90 and 90 and longitude between −180 and 180, and both are finite;
  - text fields have maximum lengths.
- Grants follow the 0090/0091 pattern.

### Load lifecycle (`src/lib/server/external-sources/`)

**1. Claim** [C-P1-1, C-P3-1]: `POST /api/ingest/loads/claim` with an `Idempotency-Key`.
- It runs as one atomic `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`, bumps `attempt`, and sets a new `lease_token` and `lease_expires_at` (now + 10 min).
- Repeating the same idempotency key returns the same lease, so a timed-out claim doesn't grab a second load. This is one column on `external_loads`.
- The response carries `Cache-Control: no-store`.
- The connector checks for work every 10 s; a check against the app on the same machine costs almost nothing [A-P2-2].

**2. Heartbeat**: `POST loads/[id]/heartbeat` extends the lease. The connector sends one every 60 s.

**3. Chunks**: `POST loads/[id]/chunks`, with `{contract_version, chunk_id, kind, rows, sha256}`. The kinds are places, taxon_month, totals, localities, recent and diagnostics.
- A repeated chunk ID with the same digest returns the earlier result; with a different digest it gets a 409 [C-P1-2].

**4. Finish**: `POST loads/[id]/finish`, with a manifest: the expected chunk IDs and kinds, row counts per kind, the places covered, and the months covered (empty months listed explicitly).
- In one transaction holding the load's row lock:
  1. Verify the manifest against the received chunks.
  2. Check the totals: for each place and month, the species sum plus `unkeyed` ≤ `count`; if it is lower, record the gap.
  3. Match the taxa.
  4. Replace **all** published rows for (source, region).
  5. Mark the previous load superseded and this load done, and store the result.
- A repeated finish after the response was lost returns the stored result [C-P1-2].

**5. Fail**: `POST loads/[id]/fail` with a sanitized reason. It has no effect on a load that is already done.

**Fencing** [C-P1-1]: every call must carry the load ID, its `lease_token` and its `attempt`, and they must match the authenticated connector's source and the live lease. Otherwise the call gets a 409.
- An expired lease returns the load to the queue with backoff.
- After 3 attempts the load is marked failed.
- A connector whose lease has expired or whose token is revoked can never publish.

**Taxon matching** is a dedicated helper, `matchExternalTaxa(sourceId, rows)` [C-P1-4, A-P2-3]:
1. Accept only species-rank `canonicalName` plus the upstream taxon ID; the original name is kept for diagnostics.
2. Resolve `(source_id, upstream_taxon_id)` against `external_taxon_overrides` first. The gallery's `species_match_overrides` is keyed on common names and is never consulted.
3. Then match by scientific name only: `matcher.match(null, canonicalName)` from `src/lib/server/species-match.ts`. This leaves the gallery's common-name-first order unchanged.
4. Splits and ambiguous names stay unmatched; nothing is guessed.
- Saving an override re-derives `external_place_month_species` from the stored `external_taxon_month`, and sets `species_code` on `external_recent_reports` by `upstream_taxon_id` [A-P1-2]. No new fetch is needed.

### Ingest contract v1 (pinned in Phase 0)
- **Every request:**
  - `Authorization: Bearer <token>`
  - `Content-Type: application/json`
  - `X-Request-Id` (a uuid, echoed in the logs)
- **Every load-scoped body** carries `contract_version: 1`, `lease_token` and `attempt`.

| Call | Body | Answer |
|---|---|---|
| `POST loads/claim` | `{contract_version, idempotency_key}` | 200 `{load: {id, region_code, attempt, lease_token, lease_expires_at, window_months, window_ends}}` · 204 no work |
| `POST loads/{id}/heartbeat` | `{…, progress: {phase, done, total}}` | 200 `{lease_expires_at}` |
| `POST loads/{id}/chunks` | `{…, chunk_id, kind, sha256, rows: […]}` | 200 `{status: "stored" \| "duplicate"}` · 409 different digest |
| `POST loads/{id}/finish` | `{…, manifest}` | 200 `{status: "done", result}`. A repeated call returns the same result. |
| `POST loads/{id}/fail` | `{…, reason, retryable}` | 200. No effect on a load that is already done. |

`window_months` (24) comes from the source registry. `window_ends` (added in Phase 1 after review; additive) lists the window ends the load accepts, latest first. They are frozen when the load is queued: the last day of the month before, or of the month before that. The connector uses the latest one its source copy fully covers. The app checks that the manifest's window ends on one of them and spans exactly `window_months` months.

**Row shapes, by `kind`.** Unknown fields are rejected, and every field is required unless marked `|null`.

| `kind` | Row fields |
|---|---|
| `places` | `place_key`, `name`, `level` ("region" \| "subregion"), `parent_key\|null`, `lat\|null`, `lon\|null` |
| `totals` | `place_key`, `month`, `reports`, `unkeyed` |
| `taxon_month` | `place_key`, `month`, `upstream_taxon_id`, `canonical_name`, `raw_name`, `rank` ("SPECIES"), `reports` |
| `localities` | `place_key`, `rank`, `locality`, `reports`, `lat\|null`, `lon\|null`, `uncertainty_m\|null`, `placement` ("pin" \| "text") |
| `recent` | `upstream_record_id`, `place_key`, `upstream_taxon_id`, `canonical_name`, `observed_on`, `count\|null`, `locality`, `lat\|null`, `lon\|null`, `uncertainty_m\|null`, `generalized`, `record_url`, `observer\|null` (must be null unless `store_observers`) |
| `diagnostics` | `code`, `detail`, `count` (e.g. `unplaced_records`, `split_municipality`, `no_uncertainty`) |

- **Place keys:** the county is its app code (`NO-18`); a municipality is `"NO-18:Nesna"`.
- **`sha256`** is the hex SHA-256 of the canonical JSON of `rows` (keys sorted, no whitespace).
- **Chunk size:** ≤256 KB, roughly 1,500 `taxon_month` rows.

**The manifest:**
- `window_start`, `window_end`
- `retrieved_at`
- `source_snapshot`: the GBIF copy it was read from (`pubDate` and last good crawl)
- `filter_fingerprint`: the GBIF query parameters, hashed
- `chunks: [{chunk_id, kind, rows, sha256}]`
- `counts`: rows per kind
- `places`: every place key
- `months`: 1–12, each listed even when empty

### Ingest routes `/api/ingest/` [C-P2-6]
- **Hooks:** the prefix is added to `PUBLIC_PREFIXES` in `src/hooks.server.ts` as `/api/ingest/` (with the trailing slash, tested against look-alike paths).
- **Authentication:** one shared `requireConnector(request)` runs **before any JSON parsing**:
  - a bearer token, looked up by its SHA-256 and compared with `timingSafeEqual`;
  - the source comes from the token, never from the request body;
  - a revoked token or an inactive source is refused on every call.
- **Request checks:**
  - `Content-Type: application/json` is required;
  - chunks are at most 256 KB (enforced before parsing, and below both the 512K adapter limit and nginx's 5m);
  - each load is capped in total rows and bytes.
- **Status codes:** 401 no or bad token · 403 wrong source or region · 409 lease, fencing or digest conflict · 413 too large · 422 failed validation · 429 back off. Responses carry `Retry-After` where it applies.
- **Logs and errors:** structured lines with a request ID. Tokens never appear in logs, errors or process arguments, and failure text from the connector is sanitized.

### Admin → "Sources" tab
Built with the existing tab and `CollapsibleCard` pattern in `src/routes/admin/+page.svelte`. Every action re-checks `role==='admin'`. It shows:
- the registry and connector health: last seen, the age of the oldest queued load, and leases that are overdue;
- loads, with their status, attempts and result;
- unmatched taxa, each with a "Match to species" override, modelled on the `/photos` override action;
- a Revoke button for connectors;
- **Reference docs (owner request, 2026-10-23; built in Phase 2):** a "Reference" line at the top of the tab, so the background is found from the place where imports are run. It links to:
  - the sources survey, `docs/2026-10-22-bird-sightings-sources-survey.md` (which countries' portals out-record eBird, and candidate connectors);
  - this plan, `docs/2026-10-21-external-sources-plan-CC.md` (the contract and the Phase 0 findings).
  - The links go to the files on `main` in the public GitHub repo, opening in a new tab. The repo path is shown as text too, so it can still be found if the repo moves.

### Token creation
`scripts/connector-token.mjs` is run by agents on the droplet.
- It stores the hash and writes the connector's env file atomically (a temp file, then rename, mode 0600).
- The token is never printed or passed as a command argument.

### Tests (`*-db.test.ts`)
- Fixtures use UUID-owned rows, are cleaned up in `finally`, and sit behind the test-env gates [C-P2-7].
- Happy path: the whole lifecycle driven by a fake connector, plus an override followed by the rebuild.
- **Fault and race tests** [C-P2-7]:
  - two claimers for the same county;
  - an expired lease with a stale writer;
  - a load ID from a foreign source or region;
  - a duplicate chunk with changed content;
  - missing or out-of-order chunks;
  - an incomplete manifest, which leaves the previous data published;
  - a chunk arriving while finish is running;
  - a rollback in the middle of the swap;
  - a finish repeated after a lost response;
  - an empty but complete load;
  - a token revoked mid-load;
  - a crash and restart;
  - the sweeper removing abandoned staging, but never staging for a live lease;
  - a gap in the denominator;
  - unmapped species and places, then an override and the rebuild, including the recent reports;
  - the observer column being refused;
  - path look-alikes for the hooks prefix and every HTTP method.
- **Invariant:** row counts in the eBird frequency tables are the same before and after every test.

### Progress in the app's job chip [A-P2-2]
- `/api/jobs` also returns the current user's active and recently finished `external_loads`, in the same shape. The layout's progress chip and `jobsPoll` (`src/lib/job-poll.svelte.ts`) then show the load and refresh the page when it finishes, exactly as eBird loads do.
- The exact mapping is pinned against `src/routes/api/jobs/+server.ts` at implementation time.

### Phase 1 as built (td-53b207, 2026-10-22): differences from the plan above
- **No foreign key from species codes to `taxonomy_cache`.** Taxonomy sync deletes and reinserts the whole table (`taxonomy-sync.ts` `writeTaxonomy`), so a code dropped by a split would make the eBird sync fail. Codes are checked when written, and species rows are re-derived from `external_taxon_month` ("Re-match species" in Admin → Sources).
- **Name matching** uses the gallery matcher's `normalizeName`, but has its own scientific-name map, so a name shared by two eBird species is reported as `ambiguous` and never guessed. `buildMatcher` would silently keep one of them.
- **`external_recent_reports` is keyed by (source, region, record)**, not (source, record). The swap is per region, so a record that a later load places in the neighbouring county can't collide.
- **`external_unmatched` has a `reason`:** `no_match`, `ambiguous` or `override_code_missing`.
- **`external_region_map.upstream_key`** holds the upstream id (`NOR.10_1`). This keeps it apart from the app-side `place_key` (`NO-18:Nesna`).
- **Finish requires a total for every place × month,** with 0 for empty months. A share is then never computed against a missing denominator.
- **A finished load keeps its lease token,** so a repeated finish is recognised and returns the stored result.
- **Job chip:** `/api/jobs` returns the user's loads in a separate `external` list, because their IDs are uuids and they have no cancel route. The chip shows them in the eBird states, and links to Admin → Sources until the Phase 3 pages exist.
- **Admin → Sources** also has "Queue load" for a region, which the first prod run needs. It also has "Remove match" and "Re-match species".
- **`scripts/connector-token.mjs`** takes `--out` for the env-file path. Node takes `--env-file` for itself even when it comes after the script name.
- **Rate limit:** 20 requests a second per connector, per app process, answered with a 429 and `Retry-After`.
- **CODEX1 code review (2026-10-22, high effort): no P1s; ten P2s and two P3s, all fixed, each with a regression test.**
  - **Claims:** retries with the same idempotency key run one at a time (an advisory lock on connector and key), plus a unique index on (connector, key) for live leases.
  - **Revocation:** every writing transaction re-checks the connector and source under `FOR SHARE`. A revoke that commits first gets a 401; a later one waits for the write in flight.
  - **One lock per source:** finish, re-match and saving or removing an override share it, taken before any read.
  - **Matching** is keyed by (upstream ID, name), so a county loaded at another upstream snapshot can't change another county's matches.
  - **The window rule is enforced.** A load's window must end with the last complete month before the month it was queued in, or the month before that, because GBIF's weekly copy may lag at the start of a month. This is fixed by the load's creation date and can't drift on a retry.
  - **Counts and dates:** unmatched report totals are `bigint`. Dates must be in 1900 through next year, and date errors are a 422.
  - **Job chip:** every active load is always listed, and finished ones are capped separately.
  - **Queue:** it retries if the conflicting active load finishes at that moment.
  - **Token rotation** installs the new file before revoking the old token.
  - **Connector notes** are all kept in `external_load_diagnostics`, and the result holds exact totals per code.
  - **The revoke dialog** is a native `<dialog>`, and focus is returned by hand because WebKit doesn't restore it.
- **CODEX1 re-review (2026-10-22): the 12 fixes are confirmed; two new P2s and one P3, all fixed.**
  - **The claim answer carries `window_ends`,** the frozen ends the load accepts, so the connector never builds a window the app will refuse (for example, queued Oct 31 and claimed Nov 1).
  - **`connector-token.mjs`** holds database session locks per source+label and per output file across the whole operation, so concurrent rotations run one after another. Four parallel rotations left exactly one live token, the installed one.
  - **The test fixtures** take their window from the database clock, so they don't age out at a month boundary. A queued-Oct-31 regression test covers the rollover.

## Phase 2: Norway connector (`connectors/gbif-artsobs/`)
- **Admin → Sources reference links** (owner request, 2026-10-23): add the "Reference" line described under Phase 1's Admin → "Sources" tab, linking the sources survey and this plan.
- **Process:** a standalone Node program, bundled in `npm run build` the same way as `scripts/build-worker.mjs`. It runs as its own PM2 app (one instance, a memory cap via `max_memory_restart`, a graceful stop that releases or finishes the load). It never touches the database.
- **Health** [A-P3-1]: the connector is **not** added to `process_memory_samples` or `ProcessName`. Its health shows as `last_seen_at` and the heartbeat in Admin → Sources. Memory on prod is read with `pm2 jlist` (read-only).
- **Polling:** it POSTs a claim every 10 s.
  - The bearer token is sent only to the configured ingest origin, and redirects are not followed [C-P2-6].
- **How it reads the data (owner's choice B, 2026-10-22; see Phase 0 finding 5):** raw records, placed by Artsobservasjoner's own fields, not by GADM.
  1. **Which 2024 counties to fetch** for an app county: one cheap facet call per `stateProvince` value, crossed against `gadmLevel1Gid` (finding 11). Every 2024 county holding ≥50 of the app county's GADM-placed records is fetched.
     - For NO-18 that means Nordland plus Troms.
     - Garbled spellings ("Tr��ndelag") are matched after normalizing.
  2. **Paging:** for each 2024 county, the window is split by month, and halved again while a slice exceeds the 100,000-result search cap (Trøndelag's busiest month has 89,925 records). Records are fetched 300 per page.
  3. **Counting:** records are counted as they stream in, never all held in memory, into:
     - (app county, municipality, month, speciesKey) report counts;
     - (place, month) totals and unkeyed counts;
     - locality counts and their coordinates;
     - the last 14 days of records.
  4. **Placing each record:**
     - **App county:** the record's own GADM county where it has one. Otherwise, the county that most of that municipality's GADM-placed records fall in, computed from the same data.
     - **Records that can't be placed**, such as the offshore "Norskekysten hav S/N" (1,517 records), go into the `diagnostics` chunk and are not published to any county.
     - **Municipality:** the record's own `municipality` field. The place key is `"{region_code}:{municipality}"`, which keeps same-named municipalities apart (Herøy, Våler, Bø).
  5. **Reuse:** the counted results of one 2024-county fetch are cached in the connector for 24 h, so loading NO-17 right after NO-16 doesn't fetch Trøndelag again. Raw records are never cached.
- **Cost of one load:**

  | Load | Records | Pages | Download | Time (2 at a time) |
  |---|---|---|---|---|
  | NO-18 Nordland | 196k (incl. Troms) | ~655 | ~1 GB | ~10–15 min |
  | NO-16/NO-17 Trøndelag | 511k | ~1,700 | ~2.6 GB | ~30–45 min |

  Pages are ~1.5 MB each and take 1.5–2.3 s.
  - Taxonomy (`/species/{key}`) and the GBIF copy's status come from separate caches.
- **County mapping:** the explicit `external_region_map` rows (finding 4) are seeded in Phase 1. Under option B they serve as the check on GADM placement, not the primary key.
- **Data it sends:**
  - GBIF speciesKey → `canonicalName` and rank via `/species/{key}`, cached;
  - the upstream taxon ID;
  - no observer names;
  - uncertainty passed through as null, never coerced to 0.
- **Tests:** unit tests run on recorded GBIF responses in `connectors/gbif-artsobs/fixtures/`, including a paged facet, records with no species key, absences, null uncertainty and generalized coordinates.
- **Order on prod (each step needs its own go):**
  1. Deploy the app and connector without a token, and confirm they stay healthy.
  2. Create the token and env file.
  3. Load Nordland.
  4. Measure the rows, unmatched taxa, gaps, time taken and memory (read-only).

## Phase 3: Show it (pages driven by the registry, all 5 themes)
- **`forecast/data`, Norwegian county rows:**
  - an "Artsobservasjoner ↗" link from `region_link_template`;
  - "Load Norwegian reports for Nordland", which queues an `external_loads` row; progress shows in the job chip;
  - the load's status, and "data as of" for the last good load;
  - a link to the Phase 4 view [A-P2-4].
- **`forecast/species?region=NO-xx`:** a "Reported on Artsobservasjoner" card containing:
  - **A callout line at the top** [A-P1-4]: "Counts of reports sent to Artsobservasjoner, not checklist frequency or the chance of seeing this bird."
  - **A 12-month strip that shows the report count N in each cell, never a percentage** [A-P1-4], modelled on `src/routes/hotspots/[locId]/+page.svelte:410`.
    - The share appears only in the caption for the selected month, in full: "142 reports in June — 1.8% of all 7,890 bird reports in Nordland that month."
    - "Share unavailable" when there is no denominator.
  - **The top municipalities for this species**, each with a 📍 Map link built with `mapsPlaceUrl({ name: "<municipality>, Norway" })` from `src/lib/geo.ts` [A-P1-1, A-P1-3].
  - the 24-month window covered, e.g. "Oct 2024 – Sep 2026";
  - the attribution and DOI, modelled on the Wikipedia "Source & license" details in `src/routes/species/[code]/+page.svelte:1195`;
  - a link to the Phase 4 view [A-P2-4].
- **Pins and locations** [C-P2-5, A-P1-1]:
  - A pin, a coordinate map link and "Add to trip" (the existing `/trips/plan` handoff, as on the `forecast/species` hotspot rows) appear only when Phase 0's placement rule is met.
  - Otherwise the place is shown as text with a 📍 Map link by name. Missing, withheld, generalized or imprecise locations are shown as the municipality.
- **Species page:** a compact summary card listing counties and their busiest months by report count, shown only when rows exist. It links to the Phase 4 view [A-P2-4].
- **Help/About:** a section on what these numbers are and are not [C-P2-7].
- **Sensitive species** (Phase 0 finding 7): the card and Help both say that the source hides some sensitive species entirely. "No reports" is never worded as "not present".
- **Wording rules:**
  - never "likely" or "frequency";
  - a percentage appears only in full prose next to its denominator, never as a badge [A-P1-4];
  - the source's attribution appears everywhere.

## Phase 4: "Where and when to look" view
- A new route, `/reports/[source]/[region]`, with `<PathNavigation>` and an entry in `LABELED_PATHS` in `src/lib/return-link.ts` [A-P2-4]:
  - **By month:** which species are reported where, by municipality.
  - **By species:** which months and which places.
- **For trip planning and use in the field** [A-P1-1]:
  - A **Needs / All species** toggle, defaulting to Needs, as on `/forecast` and `/trips/plan`.
  - A **municipality picker**: at 320 and 390 px, one municipality's monthly needs and top localities fit without scrolling past the other 44.
  - 📍 Map links on every municipality and locality.
  - "Add to trip" only where a locality has a validated coordinate.
- It reuses the month strip and a list layout, so no new chart type is needed.

## Later (separate tickets)
- A Sweden connector (Artportalen, keyed API).
- GBIF density map tiles as an overlay (the earlier probe returned 503).

## Process for every phase
- `npm run check`, `npm run build` and the full `npm test`.
  - The known searchable-select failure is reproduced and reported separately, never counted as passing [C-P2-7].
- Phases 3 and 4 get the Playwright pass (Chromium and WebKit; 5 themes at 320, 390 and 1200 px) and the iOS Simulator pass.
- Every phase gets a CODEX1 code review (`high` for Phases 1 and 2).
- Then `td review`. Gaylon approves; I never close.
- Each commit, push and deploy needs its own go. Prod access stays read-only apart from the agreed connector setup.
- Each phase gets a devlog entry.

## Verification (end to end)
1. **Fake connector:** the happy path plus every fault and race test against `birds_test`, with the eBird tables unchanged.
2. **Recorded fixtures:** the connector runs on recorded GBIF responses against `npm run dev:test`.
3. **Live GBIF into `birds_test`:** one live run for Nordland. The rows are mine and are deleted afterwards.
4. **Numbers against GBIF, using the load's own frozen filters:**
   - each place and month total equals GBIF's `count`;
   - the species sum plus the unkeyed records reconcile;
   - the top species match.
5. **Prod, after the Phase 2 go:** load Nordland and compare it the same way. Then the browser and iOS checks on `forecast/species?species=…&region=NO-18`.
