# td-eec7db — External sightings sources (first: Norway, Artsobservasjoner)

**Status (2026-10-29): built and live.** The epic td-eec7db closed on 2026-10-28. Its follow-ups, td-769300 (every report kept) and td-46fff6 ("What can I see?" card), shipped on 2026-10-29. "How it works now" below is current. Everything after it is the plan as it grew, kept as history. The GBIF route (Phase 0 findings, Phase 2) was replaced by Artskart in Phase 2 rev B.

## How it works now (2026-10-29)

**Source:** Artsobservasjoner, Norway's bird-report portal, read through Artsdatabanken's public Artskart API.
- It is CC BY 4.0 and is credited on every surface that shows it.
- It is registry entry `artsobs`, with observer names stored.
- The old `artsobs-gbif` entry is switched off.

**Coverage:**
- The 19 old (pre-2020) Norwegian counties, each loaded on demand.
- On prod: Nordland (NO-18) and Oslo (NO-03), both reloaded on 2026-10-29.
  - Window: Oct 2024 – Sep 2026.
  - 235,151 reports in all.

**How a load runs:**
1. Someone queues a county:
   - "Load a region" on Hotspots & data;
   - the Load button on a card;
   - "Queue load" in Admin → Sources.
2. The connector (`src/connectors/artsobs/`, PM2 app `birds-connector-artsobs`) claims the load through the ingest API (`/api/ingest/`, bearer token per connector).
3. It reads the county from Artskart one month at a time, from the start of the 24-month window through the day it runs.
4. It sends chunks:
   - summaries (places, totals, species per month, top places, top birders, the last 14 days);
   - `taxa`;
   - `records`, one row per report.
5. Finish swaps the county's rows in one transaction, so the previous good data stays until then.
- The connector never touches the database. The app never reads Artskart itself.

**What is stored:**
- **Summary tables:** `external_place_month_totals`, `external_place_month_species`, `external_top_localities`, `external_top_observers`, `external_recent_reports`.
- **Every report since td-769300:** `external_records`, with its own coordinates, count, behaviour, notes, observers and photo links (link-out only).
- **`external_taxa`:** one row per taxon, with its Norwegian name, Red List status and eBird species match.
- **Separate from eBird:** report counts never enter eBird's frequency tables and are never called likelihoods.

**Where it shows:**
- **Hotspots & data** (`/forecast/data`): the "Reports from other sources" card, with loaded counties, month totals, most active birders and "Load a region".
- **Species forecast** (`/forecast/species?region=NO-xx`), the "Reported on Artsobservasjoner" card:
  - the month strip of report counts;
  - the top municipalities for the month;
  - the latest reports, with their observers.
- **Species page:** the counties with reports and their busiest months.
- **Where and when to look** (`/reports/artsobs/NO-xx`): by month or by species, needs or all, county or municipality, plus top places and birders.
- **What can I see?** (`/forecast`, since td-46fff6):
  - the reports within the chosen radius, counted by each report's own coordinates;
  - needs first, with "in N of M Octobers";
  - the busiest places nearby;
  - the nearest report when none are in range;
  - a Load offer for a county not loaded yet.

**Matching to eBird species:**
- Scientific name first.
- Then eBird's own subspecies grouping (`report_as`).
- Anything else stays unmatched, and the owner matches it in Admin → Sources → "Match species".
- **Admin → Sources helps here (td-b856c7):**
  - Unmatched taxa lead with their Norwegian name and offer a suggested eBird species to accept with one tap ("Match to Hooded Crow"). The suggestion is the subspecies raised to its own species, else its parent species, and only when exactly one eBird species has that name.
  - "Change a match" lists every matched taxon, so a wrong automatic match can be changed.
- **Crows (2026-10-29):** Artskart's *Corvus corone* (kråke) matched Carrion Crow automatically, and *Corvus corone cornix* (gråkråke) was unmatched. In Norway the bird is the Hooded Crow. Both are changed by owner matches in Admin → Sources; svartkråke (*C. c. corone*) stays Carrion Crow.

**Admin → Sources:**
- connectors and their health;
- loads, with "Queue load";
- unmatched taxa (a fold), with Norwegian names, a suggested species, "Match species", "Remove match" and "Re-match species";
- "Change a match" for any matched taxon;
- Revoke for connectors.

**Migrations:**

| Migration | What it adds |
|---|---|
| 0092 | ingest foundation |
| 0096 | Artskart source and observers |
| 0097 | per-report records and taxa |
| 0098 | GiST location index for "near a place" queries |

**Related docs:**

| Doc | What it covers |
|---|---|
| `docs/2026-10-28-external-records-plan-CC.md` | every report kept (td-769300) |
| `docs/2026-10-28-forecast-external-card-plan-CC.md` | the "What can I see?" card (td-46fff6) |
| `docs/2026-10-22-bird-sightings-sources-survey.md` | other countries' portals |
| `archive/gbif-artsobs-connector/` | the replaced GBIF connector and how to reuse it |

**Open owner decisions:**
- the window length (24 months now).

## Revision history

Status before the build: plan, rev 4 (2026-10-22).
- **Rev 2** includes the CODEX1 plan review: P1 ×4, P2 ×7 and P3 ×1, all accepted. I re-checked the GBIF figures live, and the 512K versus 5m body limits in the code. Sections changed by these findings carry tags like [C-P1-1].
- **Rev 3** includes the AGY plan review (model: Argon). Its code references were checked first: `mapsPlaceUrl`, `LABELED_PATHS`, `jobsPoll`, `ProcessName`, `lastCompleteYear` and the "Add to trip" links on `forecast/species`. Sections changed by AGY's findings carry tags like [A-P1-1].
  - Accepted: P1 ×4, P2-2, P2-3, P2-4, P3 ×2.
  - P2-1 (over-engineering) is **rejected**. The owner decides scope; a reviewer's view of the app's scale is not grounds for cutting what the owner asked for. The full rev 2 upload protocol, staging, sweeper and fault tests stay.
- **Rev 4** (owner, 2026-10-22): **the data window is the most recent 24 complete months, not 2016 onward.** The aim is the most likely current sightings for each species, place and time of year. This replaces rev 3's complete-calendar-years rule (A-P3-2).
- **Rev 5** (owner, 2026-10-26/27): **the connector reads Artsobservasjoner through Artsdatabanken's Artskart API, not GBIF, and stores observer names.** See "Phase 2 rev B" below; it overrides the GBIF-specific parts of Phase 0 and Phase 2.

## Context
eBird has almost nothing in Norway. In Nordland, 2016–2025, it has 6,187 checklists, and its hotspots have a median of 5 checklists each. Norwegian birders report to Artsobservasjoner instead. GBIF holds about 548k Nordland bird records from it (CC BY 4.0). Gaylon may go to Norway in 2027 and wants to know where to look for what, and when.

**Owner decisions (settled):**
- **One generic ingest API.** Each source's data is fetched by a separate connector program and pushed into the app. The app never reads a source directly.
- **The UI is driven by a source registry.** No per-source code in the app.
- **Report counts never enter the eBird frequency tables** (`species_frequency`, `species_month_freq`, `loc_month_samples`, `frequency_fetch`). They are never called likelihoods.

Decided on 2026-10-21:
- **Connector:** it lives in this repo and runs on the droplet.
- **Coverage:** all 19 Norwegian counties, each loaded on demand; Nordland first.
- **Observer names:** not stored for now, but a nullable column is kept for them. *(Reversed 2026-10-26: stored; see Phase 2 rev B.)*
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
*History: these are GBIF findings, superseded by Phase 2 rev B. Three still apply to the Artskart connector: the placement rule for top places (6), sensitive species being hidden by the source (7), and the missing county deep link (10).*

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

14. **GBIF's deep pages stall (measured 2026-10-23, during the first live connector run):**
    - Search pages are fast (~1.4 s for 300 records) while offset + limit stays within 10,000 (offset 9,900: 3.7 s).
    - Past that, GBIF starts the answer and then stalls: offsets 10,200, 12,000, 14,700 and 15,000 sent 65–165 KB and no more within 20–40 s. Shallow pages kept answering normally at the same moment.
    - The first live Nordland load hit this on May 2025 (15,967 records) and failed as retryable after five 30 s timeouts.
    - **Rule:** a slice is halved until it has at most 9,700 records, so every page ends within the first 10,000. This adds a few count calls, not pages.
15. **GBIF answers 429 under sustained paging (2026-10-23):** the fourth county read in 30 minutes (~3,000 pages, ~3 GB from one address) got 429s, and five tries over ~30 s were not enough.
    - The answers carry no usable rate-limit or Retry-After header (`x-varnish-rli`/`x-varnish-rlg` don't count requests).
    - **Rule:** a 429 pauses every request, for Retry-After or 15 s, 30 s, 60 s … up to 5 min, with up to 8 tries (~25 min) before the load fails as retryable. Other errors keep the 5-try policy.
    - **Measured with that rule (NO-16, 2026-10-23, before the queued-request fix):** 3,405 requests, 1,579 of them 429s, 4 h 21 min for 516,440 records (estimate: 30–45 min). Peak RSS 344 MB. Paging time on prod therefore depends on GBIF's throttling, not on our page count.

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

- **Kinds added later (contract version still 1, additive):**
  - `observers` (Phase 2 rev B);
  - `taxa` and `records` (td-769300, see `docs/2026-10-28-external-records-plan-CC.md`).
  - The live list is `CHUNK_KINDS` in `src/lib/server/external-sources/contract.ts`.
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
- unmatched taxa, each with a "Match species" override, modelled on the `/photos` override action;
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
*History: this GBIF connector was replaced by Phase 2 rev B (Artskart) and never ran on prod. Its code is in `archive/gbif-artsobs-connector/`.*

- **Admin → Sources reference links** (owner request, 2026-10-23): add the "Reference" line described under Phase 1's Admin → "Sources" tab, linking the sources survey and this plan.
- **Process:** a standalone Node program, bundled in `npm run build` the same way as `scripts/build-worker.mjs`. It runs as its own PM2 app (one instance, a memory cap via `max_memory_restart`, a graceful stop that releases or finishes the load). It never touches the database.
- **Health** [A-P3-1]: the connector is **not** added to `process_memory_samples` or `ProcessName`. Its health shows as `last_seen_at` and the heartbeat in Admin → Sources. Memory on prod is read with `pm2 jlist` (read-only).
- **Polling:** it POSTs a claim every 10 s.
  - The bearer token is sent only to the configured ingest origin, and redirects are not followed [C-P2-6].
- **How it reads the data (owner's choice B, 2026-10-22; see Phase 0 finding 5):** raw records, placed by Artsobservasjoner's own fields, not by GADM.
  1. **Which 2024 counties to fetch** for an app county: one cheap facet call per `stateProvince` value, crossed against `gadmLevel1Gid` (finding 11). Every 2024 county holding ≥50 of the app county's GADM-placed records is fetched.
     - For NO-18 that means Nordland plus Troms.
     - Garbled spellings ("Tr��ndelag") are matched after normalizing.
  2. **Paging:** for each 2024 county, the window is split by month, and halved again while a slice has more than 9,700 records. GBIF's documented cap is 100,000 results, but pages past the first 10,000 stall (finding 14). Records are fetched 300 per page.
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

### Phase 2 as built (td-c2913c, 2026-10-23): differences and pinned details
- **Location: `src/connectors/gbif-artsobs/`**, not `connectors/gbif-artsobs/`, so `npm run check` type-checks it and `npm test` runs its tests.
  - It imports only the app's pure contract module (`$server/external-sources/contract`), so its rows pass the same validator before they are sent.
  - `scripts/build-connector.mjs` bundles it to `build/connector-gbif-artsobs.js` (part of `npm run build`). The build fails if the bundle pulls in any other app server or database module.
- **PM2 app `birds-connector-gbif-artsobs`:**
  - no `--env-file=.env`, so it never has the database settings;
  - heap 320 MB, `max_memory_restart` 450 MB, `kill_timeout` 15 s;
  - the deploy script fails unless the app has been online for 35 s (past PM2's `min_uptime` of 30 s) within 90 s, so a process that keeps restarting fails the deploy. It reads `pm2 jlist` past any `[PM2][WARN]` lines, and a test runs that parser.
- **Its env file** is `/opt/birds/.local/connectors/gbif-artsobs.env` (gitignored), written by `scripts/connector-token.mjs`.
  - It is read again before every claim, so creating or rotating the token needs no restart.
  - With no token, or a refused one, the connector idles and logs why once.
- **Window:** the latest of the load's `window_ends` that GBIF's latest NORMAL copy fully covers (the last complete month before the copy). If neither end is covered, the load fails without a retry.
- **Which 2024 counties:** two facet calls, `stateProvince` within the app county's GADM polygon and `stateProvince` across Norway. Spellings are grouped by a letters-only key ("Trøndelag" = "Tr��ndelag"), and every spelling of a qualifying county is read.
  - A facet answer must carry its facet entry with valid counts. GBIF sends the entry even when there are no records (`"facets":[{"field":"STATE_PROVINCE","counts":[]}]`, checked 2026-10-23), so anything else is a broken answer and the load fails as retryable.
  - When no 2024 county qualifies, the load fails without a retry and publishes nothing, so a bad answer can never replace a county's rows with zeros.
- **Slices** hold at most 9,700 records (finding 14), and GBIF errors name the slice and offset.
- **429s** (finding 15) pause every request, including ones already queued for a slot: a request checks the pause again once it has a slot, and a paused request never holds one. The backoff doubles with each 429 in a row from any request and resets on the next good answer.
- **Paging completeness:** a date slice counts only once it reads back whole. Every page must give the same count as its first page, and the distinct records read must equal that count.
  - Until then its records wait in the slice's own buffer, so nothing from a read that changed is counted.
  - A changed slice is read again from scratch, and split again if it grew past 9,700. Up to three reads; then the load fails as retryable.
  - A record can also move into a slice already read, when its date changes. The whole group is read again, up to three times and then the load fails as retryable, when:
    - a record turns up in two date slices, unless it is dated as an interval with exactly the same event date, read under the same spelling, both times (moves that balance out leave every count unchanged). Only an interval rightly matches two date slices of one spelling; it counts once, on its first day; or
    - once every slice is counted, any slice's count, asked for again (count only, no records), has changed.
  - This catches every change that shows in counts or record keys, but it is not a snapshot guarantee: GBIF's search offers no snapshot to page through.
  - Records are de-duplicated by GBIF key across slices.
  - Across 2024 counties: each counted county keeps its sorted record keys, and a record found in two of them (moved while GBIF was read) fails the load as retryable, dropping both from the cache.
- **Species names** are looked up two at a time. In every pool of GBIF requests (slices, rechecks, names), the first failure aborts the requests still running beside it.
- **Placement, pinned:**
  - The municipality majority counts all of a municipality's GADM-placed records; ties go to the lowest county code.
  - A GADM gid outside the 19-county map (Sweden, Russia) counts as none.
  - A record with no municipality is counted at county level only.
  - When two 2024 counties both put a same-named municipality in one app county, the second becomes "Name (2024 county)", with a `municipality_name_clash` note.
- **Places have no coordinates** (lat/lon null). Phase 3 links municipalities to maps by name.
- **Species:** a GBIF species key counts as a species only when its backbone record has rank SPECIES, a `canonicalName` and name type SCIENTIFIC. Anything else counts as unkeyed, with a `non_species_taxon` note naming it, so species plus unkeyed always equal the total exactly.
  - Found on the first live run: GBIF files hybrids at rank SPECIES, e.g. "Mareca penelope x Anas platyrhynchos" (Eurasian Wigeon × Mallard, 767 Norwegian records, name type HYBRID, no `canonicalName`).
- **Localities:** the top 25 per municipality (none at county level), ranked by reports, then name.
  - The pin rule's shares are of all the locality's reports: a report without coordinates is never "near", and one without an uncertainty counts as unbounded.
  - A "text" locality is sent without coordinates.
  - The uncertainty sent is the median of the uncertainties the locality's reports give, or null when none give one.
- **Recent reports:**
  - the 14 days up to the newest date in the county's placed species records, including species reported only after the window;
  - species rank only;
  - newest first, capped at 20,000;
  - links go to Artsobservasjoner by `catalogNumber`, or to GBIF when there is none.
- **Connector notes** (`diagnostics`): `unplaced_records`, `split_municipality`, `placed_by_municipality`, `foreign_gadm_county`, `municipality_name_clash`, `non_species_taxon`, `no_uncertainty`, `generalized_coordinates`, `information_withheld`, `outside_window_dates`, `recent_truncated`.
- **Reuse:** counted 2024 counties are cached for 24 h (at most 2), keyed by spellings, window and GBIF copy.
- **Stopping:** a lost lease (401, 404, or 409 other than a chunk conflict) stops the load without a fail call. A PM2 stop hands the load back as retryable.
- **Admin → Sources "Reference" links** (owner request) link the survey and this plan on GitHub, with the repo path shown.
- **Tests:**
  - `connector.test.ts` (52) runs on recorded GBIF responses (observer and validator names removed) and a fake GBIF built from them;
  - `connector-db.test.ts` (3) drives the real connector through the real ingest route handlers into `birds_test`;
  - `deploy-gate.test.ts` (3) runs the deploy script's `pm2 jlist` parser on sample output.
- **CODEX1 code review (high, 2026-10-23):** rounds 3, 4 and 5 each found 1 more P2, fixed with tests: records swapping slices without changing any count, first one-day records, then interval records whose dates changed, then unchanged intervals swapping spellings (the rule above). Round 2 found 3 more P2s, all fixed with tests: a record moving into a slice already read (the group recheck above), a failure not aborting the request beside it, and the deploy gate misreading `[PM2][WARN]` lines. Round 1 had 10 findings (P1 ×1, P2 ×9), all accepted and fixed with a regression test each: zero-county publish on a broken facet; re-read keeping deleted records; no cross-county dedupe; recent-only species dropped; pin share ignoring reports without coordinates; queued requests bypassing a 429 pause; a re-read paging past the cap; a large locality overflowing a spread call; a failed name lookup leaving GBIF requests queued; the deploy gate accepting a stopped connector.

## Phase 2 rev B: read Artskart, not GBIF (owner, 2026-10-26/27)
The owner chose Artsobservasjoner's own source (Artsdatabanken's Artskart public API) over GBIF after the probe in `docs/devlog/2026-10-26.md`. The owner also wants **observer names stored** (reversing "not stored for now"): they are public on Artsobservasjoner, and seeing who birds a county most is interesting and points to people worth looking up. The GBIF connector above is replaced. It is archived in `archive/gbif-artsobs-connector/` (baf00ca), with a README on reusing it for another country.

**Why (measured 2026-10-26/27, not estimated):**
- A whole-Nordland pull (2016 on, 723,133 records) took 27 min 31 s: 144 requests, one at a time, no throttling, every window complete. The GBIF paging run for Trøndelag took 4 h 21 min for 516,440 records, 46% of its requests answered 429.
- No GADM placement: every record carries its county and municipality. The GBIF route's 17% gap was our GADM filter (GBIF's `stateProvince` count agrees within 0.1%).
- **Artskart filters by the app's own 19 old counties** (`countys[]=1…20`, pre-2020 boundaries). For 2024-10-01…2026-09-30 the 19 sum to 3,393,596, exactly what one query for all 19 returns (no overlap). All of Norway is 3,404,436: Svalbard (21) 6,170, Jan Mayen (22) 115, and 4,555 (0.13%) in no county. `countys[]=18` returns 30 Tjeldsund records, the part that moved to Troms in 2020, so the filter follows the old boundaries. No 2024-county mapping is needed.
- Changes can be read incrementally later (`afterTrackDateTime`, `observations/Deleted`); v1 still reloads a whole county.
- **Terms** (artsobservasjoner.no "Brukervilkår", read 2026-10-27): reports "can be used freely by everyone" (§1); the observer's name is public and attached to each report (§3); the data is CC BY 4.0 (§9); use must name Artsobservasjoner as the source with the licence, and say something about data quality (§10). Rejected reports are not in public portals (§4); sensitive breeding sites are screened by Artsdatabanken (§7).

**What a load reads:** `GET https://artskart.artsdatabanken.no/publicapi/api/observations/list` with `countys[]=<old county number>&taxongroups[]=8&collections[]=so2-birds&fromDate=…&toDate=…&pageSize=…&pageIndex=…`.
- Group 8 is birds; collection `so2-birds` is Artsobservasjoner's birds (institution NOF). Both date bounds are inclusive.
- **Slices:** calendar months from the window start through today, one request at a time.
- **A slice counts only once it reads back whole:** every page gives the same `TotalCount`, and the distinct record `Id`s equal it. Artskart repeats a few rows on some pages (605 in 723k), so rows are de-duplicated by `Id`. A slice that changes while read is read again from scratch, up to 3 times, then the load fails as retryable.
- **Moves:** a record `Id` met in two slices (its date changed mid-read) sends the whole county round again (up to 3 times, then retryable), so nothing counts twice. Known limits (Artskart offers no snapshot; the next load corrects both): a report deleted and another added in the same month while that month is paged leave its count unchanged, so a load may count the deleted one and miss the new one; and a report re-dated from a month not yet read into one already read is in neither slice, so it is missed (CODEX1 rev B finding 4). A record with an unreadable date, or a date outside the month asked for, fails the load as retryable instead of being skipped (finding 1). Slices are **not** counted again after the read, unlike the GBIF connector: Artskart is live (Nordland gains ~160 reports a day), and a report added after its month was read belongs to the next load.
- **Window:** the latest of the load's `window_ends` (Artskart is live, so there is no copy lag), 24 months back. Recent reports run through today.

**Per record:** `Id`, `TaxonId`, `ScientificName`, `CollectedDate` (dd.mm.yyyy), `Municipality`, `Locality`, `Latitude`/`Longitude` (decimal comma), `Precision` (metres), `Count`, `Collector`, `CatalogNumber`.
- **Place:** `"{region}:{Municipality}"`; a record with no municipality counts at county level only.
- **Taxa:** names are trimmed and their spaces collapsed ("Astur gentilis " arrives with a trailing space). Two-part names are rank `SPECIES`. "Genus species subsp.|var.|f. x" is rank `SUBSPECIES`, sent as "Genus species x" with the raw name kept. Anything else (genus or family reports such as *Laridae*, hybrids) counts as unkeyed, with a `non_species_taxon` note. `upstream_taxon_id` is Artskart's `TaxonId` (1:1 with names in the probe).
- **Localities:** as before (top 25 per municipality, pin rule from Phase 0 finding 6), with `Precision` as the uncertainty.
- **Recent reports:** as before (14 days up to the newest date, newest first, capped at 20,000), with the record link `https://www.artsobservasjoner.no/Sighting/{CatalogNumber}` and the observers named.

**Observers (new chunk kind `observers`, contract v1, additive):**
- `Collector` holds the party, separated by `|` (20% of records name 2–13 people). Names are split, trimmed and their spaces collapsed. The API gives no user ID, so two people who share a name count as one.
- A "report" here is one species at one place on one day, so a busy birder has tens of thousands (the probe's top Nordland observer: 112k reports on 3,873 days). **The ranking leads with days out**, then species, then localities; reports come last.
- Rows: `place_key`, `rank`, `observer`, `days`, `species`, `localities`, `reports`; the top 25 per place (county and each municipality), over the same 24-month window.
- The app accepts `observers` rows only from a source with `store_observers` on (else 422 `observer`, like the recent-reports column). The Artskart source has it on; recent reports carry the party as "A, B".

**App side (migration 0096):**
- Source `artsobs`: Artsobservasjoner via the Artskart public API, CC BY 4.0, `store_observers` on, 24 months, region map `1…20` ↔ `NO-01…NO-20` (the old county numbers, not GADM). `artsobs-gbif` is switched off (`active = false`), its rows kept.
- `external_stage_observers` and `external_top_observers`, swapped with the other published tables.
- **Subspecies matching** (`taxa.ts`): after an override and an exact species name, a name that is an eBird `issf` or `form` whose `report_as` is one species matches that species (eBird's own grouping, e.g. *Anas crecca carolinensis* → Green-winged Teal). Nothing else is rolled up; a subspecies eBird has no entry for stays unmatched for "Match species". Measured on the Nordland pull: 99.41% of records match as species, 0.39% more through `report_as`, and 0.20% (genus/family reports and odd forms) do not.

**Memory (measured live, 2026-10-27):** pages of 2,000 rows; Rogaland, the largest county (425,795 records), peaked at 487 MB RSS (macOS) with a ~200 MB heap. The owner set PM2's `max_memory_restart` to **600M** (heap cap stays 320 MB); prod's first load gives the Linux figure.

**Renames:** the connector is `src/connectors/artsobs/`, its PM2 app `birds-connector-artsobs`, its bundle `build/connector-artsobs.js`, its env file `/opt/birds/.local/connectors/artsobs.env`.

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

### Phase 3 rev B: what changed since the plan was reviewed (td-6895f6, 2026-10-27)
Phase 2 rev B changed the data underneath Phase 3, so these points override the list above where they differ.
- **Observers (owner, 2026-10-27: "County panel now"):** each loaded Norwegian county on Hotspots & data gets a folded "Most active birders" list, from the county-level rows of `external_top_observers`: name, days out, species, places, reports, ranked as stored (days first). The species card's latest reports name the party. The per-municipality lists wait for the Phase 4 view.
- **Latest reports on the species card:** the last 14 days with data (`external_recent_reports`, 10 newest per species and county): date, count, locality, municipality, party, and "Sighting ↗" to the record on the source. A coordinate map link only when the report is not generalized and its uncertainty is ≤1 km; otherwise 📍 Map by locality and municipality name.
- **Top municipalities** on the species card are for the selected month, since "where in June" is the trip question. When the species has no reports that month, the card says so and lists the whole window instead.
- **Link-out:** `artsobs.region_link_template` is NULL. Artskart's map filters by Artsdatabanken's own area ids (Phase 0 finding 10), so there is no county deep link to build from the old county number. The source link goes to `homepage`; each latest report links to its own record. A template-driven county link appears automatically if a source sets one.
- **Hotspots & data card (changed while building):** Hotspots & data lists a county only once eBird data for it is loaded, so a panel inside the county rows would never appear for a county eBird hasn't loaded. The page instead has its own **"Reports from other sources"** card after "Loaded data": each active source, its loaded, loading and failed regions (row id `ext-NO-xx`) with status, month totals and the birders list, and one "Load a region" picker for the rest. It comes in the page load, a fixed handful of queries in one read snapshot. Every non-viewer can queue a load there or on the species card (`queueExternalLoad`, one active load per source and region, requested by the signed-in user). Admin → Sources keeps its own queue.
- **Progress and completion:** the user's own load shows live from the jobs poll (the job chip is hidden on /forecast pages). A load someone else started is watched through `GET /api/external/load-state` until it ends, then the page reloads its data.
- **Job chip:** an external load links to its row on Hotspots & data (`/forecast/data#ext-NO-xx`) for everyone, not Admin → Sources.
- **Data quality** (Brukervilkår §10): the "Source & license" details say that reports rejected by the source's validation are left out, the rest are as reported, and the counts follow where and how often people report.
- **Region = Norway** (country) on `forecast/species` shows the per-county summary the species page uses, instead of the card.
- **Only active sources show.** `artsobs-gbif` is switched off, so its rows (none on prod) never appear.

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

### Phase 4 rev B: as built (td-b6ddfc, 2026-10-28)
Sized from prod's Nordland load (read-only, 2026-10-28): 41 municipalities; 298 species in the county, 64–216 per municipality; up to 233 species in a county month (median 50 in a municipality month). Against the owner's life list, 229 of the 298 are needs, 78–169 in a month, so "My needs" narrows the lists but doesn't make them short. Top localities are stored **per municipality, all birds** (25 each, 83% with a pin), not per species, so "which places" for a species is its municipalities.
- **URL:** `/reports/<source>/<region>?view=month|species&place=<municipality>&month=1–12&seen=needs|all`. Defaults: by month, the whole region, this month (the owner's calendar, as on the forecast), My needs. An unknown place reads as the whole region; an unknown or inactive source, or a region it doesn't cover, is 404. One read snapshot per page (`where-when.ts`).
- **Controls:** a "By month / By species" switch, a "My needs / All species" switch (needs = not in the viewer's `seen_species`, the scope owner for a family viewer), and a Place picker (All of Nordland, then the municipalities in Norwegian order) that navigates on change. A picked municipality gets a 📍 map link by name.
- **By month:** the place's all-bird month strip (counts, as on Phase 3) with a caption: "N reports of S species in Place in June, Oct 2024 – Sep 2026; K are needs (not on your life list)." Then the species reported that month, most reports first; at county level each names the up to 3 municipalities with the most that month ("Most in Røst, Værøy, Bodø", each picks that municipality). A species links to its Phase 3 card (forecast/species, that month).
- **By species:** taxonomic order; each row shows its reports and busiest months and opens to its month strip, at county level its top 3 municipalities over the window, and a link to its card.
- **Folds above the list:** at county level "Municipalities in June (41)": needs, species and reports per municipality, most needs first (most species under All); at municipality level "Places in Bodø with the most reports (25)": 📍 Map by coordinate and **Add to trip only for a pin** (the connector's Phase 0 rule, with ≤1 km uncertainty checked again); the rest map by name. Both levels: "Most active birders in <place>" (the per-municipality lists Phase 3 deferred).
- **Long lists:** the first 40 rows, then "Show all N".
- **Not loaded yet:** the page says so and offers the Phase 3 Load button (non-viewers); a load in progress is watched as on the cards.
- **Links in:** each loaded county on Hotspots & data ("Where and when to look in Nordland ›") and the species card ("Every species in Nordland in June ›"). The species page reaches it through the county card. Back link label "Where and when to look" (`LABELED_PATHS`).
- **Wording:** the same callout (counts, not frequency or chance; reporting effort; hidden sensitive species) and the source's attribution with its window.

## After the epic (2026-10-28/29)
- **td-769300, keep every report:** migration 0097 and chunk kinds `taxa` and `records`. Nordland and Oslo were reloaded on prod on 2026-10-29, and the stored reports reproduce every place-month total. Details: `docs/2026-10-28-external-records-plan-CC.md`.
- **td-46fff6, "What can I see?" card:** counts the reports within the radius by their own coordinates, with migration 0098 (GiST index on `point(lon, lat)`). Measured on prod for Sandnessjøen in October at 31 mi: 1,429 reports, 109 species, 70 needs. Details: `docs/2026-10-28-forecast-external-card-plan-CC.md` → "Rev B".

## Later (separate tickets)
- A Sweden connector (Artportalen, keyed API).
- GBIF density map tiles as an overlay (the earlier probe returned 503).
- Incremental loads from Artskart (`afterTrackDateTime`, `observations/Deleted`) instead of reloading a whole county.

## Process for every phase
- `npm run check`, `npm run build` and the full `npm test`.
  - The known searchable-select failure is reproduced and reported separately, never counted as passing [C-P2-7].
- Phases 3 and 4 get the Playwright pass (Chromium and WebKit; 5 themes at 320, 390 and 1200 px) and the iOS Simulator pass.
- Every phase gets a CODEX1 code review (`high` for Phases 1 and 2).
- Then `td review`. Gaylon approves; I never close.
- Each commit, push and deploy needs its own go. Prod access stays read-only apart from the agreed connector setup.
- Each phase gets a devlog entry.

## Verification (end to end)
*As planned for GBIF. Done for Artskart instead:*
- *the first prod Nordland load's month totals equal Artskart's own counts for all 12 months (devlog 2026-10-27);*
- *after td-769300, the stored reports reproduce every place-month total on prod (Nordland 486/486, Oslo 25/25).*

1. **Fake connector:** the happy path plus every fault and race test against `birds_test`, with the eBird tables unchanged.
2. **Recorded fixtures:** the connector runs on recorded GBIF responses against `npm run dev:test`.
3. **Live GBIF into `birds_test`:** one live run for Nordland. The rows are mine and are deleted afterwards.
4. **Numbers against GBIF, using the load's own frozen filters:**
   - each place and month total equals GBIF's `count`;
   - the species sum plus the unkeyed records reconcile;
   - the top species match.
5. **Prod, after the Phase 2 go:** load Nordland and compare it the same way. Then the browser and iOS checks on `forecast/species?species=…&region=NO-18`.
