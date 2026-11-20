# Sweden source: Artportalen connector (first: Stockholm + Jönköping counties)

td-99eebf. Revision 3 (2026-11-19) folds in two plan reviews:
- **CODEX1** (high effort): changes marked **[C1-n]**.
- **AGY4** (user/UX side): changes marked **[A4-n]**.

All findings from both were accepted.

## Context
Gaylon wants Sweden in "Reports from other sources", modelled on Norway, using Sweden's own source: **Artportalen** (SLU Artdatabanken). He's most interested in the counties holding **Stockholm** (Stockholms län, `SE-AB`) and **Visingsö** (an island in Vättern, Jönköping kommun, Jönköpings län, `SE-F`).

The external-sources template is in place:
- Connectors push through one ingest API.
- The app reads sources from the registry and holds no code specific to any one source.
- A new country is therefore mostly a new connector plus a registry migration.

No earlier Sweden research exists: Gaylon confirmed he was misremembering.

Facts measured on 2026-11-19, from public docs and unkeyed probes:
- **API:** Species Observation System (SOS) at `https://api.artdatabanken.se/species-observation-system/v1/`.
  - Header `Ocp-Apim-Subscription-Key`; requests without a key get 401 (probed).
  - `POST /Observations/SearchByCursor`: `take` ≤ 2,500, cursor paging, at most 2M records per filter.
  - `/Observations/Count` exists.
  - Area filter `{areaType:"County", featureId:"1"}` (Stockholm = 1, Jönköping = 6; kommun Jönköping = 680).
  - Birds are taxon `4000104` with `includeUnderlyingTaxa`.
  - Data providers default to several; Artportalen is provider 1.
  - Documented fields include `occurrence.recordedBy`/`reportedBy`, `organismQuantityInt` plus unit, `event.plainStartDate`, coordinates plus `coordinateUncertaintyInMeters`, `location.municipality{featureId,name}`, `locality`, `taxon.scientificName`/`vernacularName`/`attributes.redlistCategory`, `occurrence.url`, `sensitive` and diffusion status.
- **Volume** (GBIF copy of Artportalen, birds):
  - Stockholm: 507k in 12 months, 1.04M in 24 (peak month May, about 87k).
  - Jönköping: 168k in 12 months, 360k in 24.
  - Visingsö area: about 10.5k in 24 months, all inside Jönköping kommun.
- **GBIF's copy anonymizes observers** ("User23448"), so the keyed SOS API is the only route to observer names.

**Owner decisions (2026-11-19):**
- **12-month window** for Sweden (Norway keeps 24). The window is never shortened silently to make a load fit **[C1-3]**.
- **Key via Chrome:** I drive the portal sign-up in his Chrome; he does only the password and consent clicks.

## Phase 0 findings (2026-11-19, done)
- **Key:**
  - Product "Species Observations - multiple data resources", access "Öppen" (open). Subscription "birds" on Gaylon's portal account was active immediately.
  - The key is in `.local/connectors/artportalen.test.env` (mode 600, gitignored), never printed. `ApiInfo` returns 404; use `/Areas` as the health call.
- **Counties:** `GET /Areas?areaTypes=County` returns 21 län with featureIds equal to the official län numbers: 1 Stockholm, 3 Uppsala, 4 Södermanland, 5 Östergötland, 6 Jönköping, 7 Kronoberg, 8 Kalmar, 9 Gotland, 10 Blekinge, 12 Skåne, 13 Halland, 14 Västra Götaland, 17 Värmland, 18 Örebro, 19 Västmanland, 20 Dalarna, 21 Gävleborg, 22 Västernorrland, 23 Jämtland, 24 Västerbotten, 25 Norrbotten. So `SE-AB`=1 … `SE-BD`=25.
- **Selection used:** `dataProvider.ids=[1]`, taxon 4000104 with descendants, County area, `dateFilterType=OnlyStartDate`, `occurrenceStatus=Present`, `output.fieldSet=All`, `sortBy=modified` ascending.
- **Stockholm, May 2026** (the busiest month):
  - `Count` 96,757; the cursor returned 96,757 records with 96,757 distinct `occurrenceId`s; `totalCount` was the same on all 40 pages (`take=2500`).
  - 98 s total, slowest page 5.6 s. No 429s and no rate-limit headers.
  - At this rate, a 12-month Stockholm load takes about 9–10 minutes of reading.
  - The probe process hit 398 MB RSS just from parsing pages and keeping the id set, which confirms [C1-4] matters.
- **Jönköping, Oct 2026:** `Count` 11,824.
- **Fields:**
  - `occurrence.url` is `https://www.artportalen.se/sighting/<id>`: all https, none failing.
  - `occurrence.occurrenceId` is `urn:lsid:artportalen.se:sighting:<id>`.
  - `modified` and `startDate` carry a zone offset (`+02:00`), so they must be normalized for the contract. `event.plainStartDate` is the local Swedish date and is the right month key.
  - `location.municipality{featureId,name}` was present on every record (26 kommuner in Stockholm). Also present: `parish` (Visingsö is a parish), `locality`, `coordinateUncertaintyInMeters` (5 m to 1.6 km in the sample), and province.
  - Taxon: `taxon.scientificName`, Swedish `taxon.vernacularName` (e.g. "sothöna"), `taxon.attributes.redlistCategory` (`LC`, `NT`, …), `taxonRank`. Ranks seen: species 95,120 / subspecies 1,317 / unranked 247 / speciesAggregate 47 / genus 15 / family 6 / others fewer than 3.
  - Quantity: `organismQuantityInt` is missing on 13% (count not given). The unit was empty on all but 10 of 96,757, so non-individual units are rare but real [A4-7].
  - Validation: `identification.verificationStatus.value` is mostly "Ovaliderad" (not validated).
- **Observers:**
  - `occurrence.recordedBy` holds real names, and is never empty or anonymous in the samples.
  - Multiple observers are separated by `", "` (14% of May records).
  - `reportedBy` differs from `recordedBy` on about 12%.
- **Privacy:**
  - `sensitive` was false on every record (the public API leaves protected ones out).
  - `diffusionStatus`: 0 (not diffused) 96,635; **2 = DiffusedByProvider** (the reporter blurred it; no original exists) 122, or 0.13%.
  - **Policy:** diffused records count toward county and kommun totals and species lists, but **never** act as a point: no near / nearest / localities / pins, and no locality text.
- **Rights and terms:**
  - The published Artportalen dataset is **CC0** (GBIF dataset 38b4c89f).
  - The API terms (v1.0, 2018-06-14) require:
    - §2.3: stating in the app that the data comes from SLU Artdatabanken.
    - §2.1: a visible link to SLU's usage rules plus a consent sentence for users ("By using this application I undertake to follow the rules…").
    - §3.2: whoever stores personal data such as observer names is the **GDPR controller** for it.
  - No storage, caching or rate rules; SLU may pause a key for overload.
  - **Gaylon accepted the controller role (2026-11-19), so `store_observers = true`.** Duties:
    - Names only show who reported what and who is most active.
    - Signed-in users only; never public.
    - Removal through the 12-month reload.
    - Honour any removal request.
  - The About page and the Sweden source card carry the attribution, the rules link and the consent line.

## Phase 0: API key + probe (no code)
1. Open `api-portal.artdatabanken.se` in Gaylon's Chrome.
   - He signs up and consents.
   - I subscribe to the Species Observation System product.
   - The key goes to `.local/connectors/artportalen.test.env` (mode 600, gitignored) as `ARTPORTALEN_API_KEY=`. **Never printed or logged.**
2. **Define one exact SOS selection** and use it for `Count` and every cursor page **[C1-1]**:
   - `dataProvider.ids=[1]`; birds plus descendants; the county area; `occurrenceStatus=Present`.
   - Public records only; `dateFilterType=OnlyStartDate`.
   - An explicit field projection (`output.fields`; the Minimum fieldset omits fields, and null fields are absent).
   - A fixed `sortBy`/`sortOrder`.
   - The selection is fingerprinted into the manifest.
   - Verify month boundaries against Swedish `plainStartDate`: an event spanning midnight, local midnight, and the DST change.
3. Probe with real requests, saving raw JSON to the scratchpad. Only **sanitized** fixtures go into the repo: names become "Observer A/B/C", and IDs, links and free text are scrubbed where needed **[C1-5]**. Questions to answer:
   - **Observers:** are `recordedBy` and `reportedBy` populated? How do groups and anonymous observers look? Find a real multi-observer example before choosing a split rule **[C1-5]**.
   - **Privacy:** what do sensitive and diffused records look like (system vs provider diffusion, the diffusion-status field, uncertainty)? Find explicit negative evidence that a record is not diffused **[C1-5]**.
   - **Rights:** licence, attribution, and media/record rights (`/DataProviders/1/EML`). Is showing named observer rankings permitted? This decides `store_observers` **[C1-5]**.
   - **Mapping:** `occurrence.url` scheme (the docs show http; the contract needs https), the `modified` time format (UTC with Z, while the contract wants it without a zone), ID length and characters, taxon id and rank, quantity unit (pairs and nests are not individuals), municipality `featureId` string form, Swedish `vernacularName`, red-list values **[C1-8]**.
   - **Paging:** behaviour on 429 and rate limits; cursor lifetime; whether `totalCount` is stable across pages; `Count` vs cursor parity; time to read Stockholm's May (about 87k).
   - **Recent cap:** busiest Swedish fortnight against the 20k recent cap **[C1-9]**.
   - **Areas:** `GET /Areas?areaTypes=County` returns all 21 län.
4. Record the findings as a plan addendum plus the devlog. **Stop and show Gaylon if names are missing or the terms forbid storing or ranking them.**

## Phase 1: share only the wire/spool primitives [C1-7]
- **No generic runner.** Provider paging, mapping, credentials, privacy policy and error classification stay separate per connector.
- Extract into `src/connectors/shared/`:
  - The ingest client (`ingest.ts`).
  - `spool.ts`.
  - Chunking and manifest building (`payload.ts`), with `storeObservers` taken from the source in both `payload.ts:55` and `run.ts:140`.
  - Retry and sleep helpers from `artskart.ts`.
  - `monthRanges`.
- `aggregate.ts` gets the region name and locale from its caller. This removes the Artskart / `REGION_NAMES` references at L145, L173 and L318.
- **Norway parity on frozen inputs:** payloads, digests and fingerprints are identical before and after. Also covered: retry and lease loss, idempotent finish, cancel, cleanup, and the forbidden-import guard for both bundles.
- Unknown error classes stop being treated as terminal by accident: classification is per connector.
- CODEX1 reviews this step on its own.

## Phase 2: `src/connectors/artportalen/`
- **`config.ts`:**
  - `SOURCE_ID='artportalen'`, base URL, birds taxon, `take`.
  - `REGION_TO_COUNTY`: all 21 län, with a test that it matches the migration seed and `/Areas`.
- **`sos.ts`:** client with the shared retry. The key is read from the env file; the connector idles before claiming when the token **or** the key is missing, and both secrets are reread on rotation **[C1-6]**.
- **`fetch.ts`: completeness [C1-2]:**
  - Per month: `Count`, then a cursor read with the fixed selection, sort and direction.
  - Check every page's `totalCount`; follow `nextCursor` until null or empty.
  - Detect cursor loops and repeats.
  - Dedupe raw `occurrenceId` **before** exclusions.
  - Check the 2M cap before following a cursor.
  - Use smaller date sub-ranges for oversized busy slices.
  - Bounded whole-county rereads that reset the spool.
  - Record accepted and excluded counts per slice.
  - Tests: short and terminal pages, stale or repeated cursors, duplicate ids with changed content, records moving in either direction between months, and churn that leaves the count unchanged.
  - Completeness evidence is per load. Local and prod loads are compared only on frozen inputs.
- **`records.ts` [C1-5, C1-8]:**
  - Privacy screening happens **before** aggregation, fixtures or spooling. Under a documented policy, a diffused or sensitive record is either excluded or kept without its precise point, locality, observer or link. It never feeds near / nearest / localities / pins.
  - Observer, reporter, group and anonymous values are kept apart.
  - Links are canonical https Artportalen URLs.
  - Modified-time semantics are explicit.
  - The quantity unit is respected.
  - Place identity **matches Norway [A4-1]**: `place_key = "{region}:{municipality name}"`, with `upstream_place_id` = the SOS municipality `featureId`.
    - Swedish kommun names are unique, which the probe confirms within each län.
    - This keeps the `aggregate.ts:329` recent-only path, which slices the name out of `place_key`, from showing a raw number such as "680".
    - A missing municipality stays at county level.
  - **Non-individual units [A4-7]:** when `organismQuantityInt` carries a unit other than individuals (pairs, territories, nests), set `count = null` and keep the raw unit in the notes. The card must never show "2 pairs" as "2 counted".
  - Swedish name → `local_name`; Rödlistan → `red_list`.
  - The mapping is tested against the **real ingest validator**, with fixtures for missing fields and malformed links.
- **Preflight before upload [C1-3]:**
  - Serialize the actual chunk envelopes and count rows by kind.
  - Compute the fenced finish body against the **256 KiB ingest body cap**: the manifest lists every chunk, and 2,100 record descriptors already measure about 276 KB.
  - Check the 1M-row / 1 GiB load caps, which count every kind plus envelopes, and the 12 months **plus the current partial month**.
  - Fail before publication on overflow. If a limit is hit, make a bounded protocol change (e.g. a finish that refers to the staged chunks instead of listing them). Never trim data.
- **Memory [C1-4]:** a file spool doesn't bound heap. Month buffers, county-wide id sets, observer sets, coordinate arrays and median copies all grow with the load. Rehearse Stockholm's peak month and the whole run under production Node flags (320 MiB old-space, 600M RSS restart).
  - If that isn't enough: spill exact id sets and median work to disk, and/or serialize heavy loads across sources.
  - Monthly streaming alone would break exact cross-month distinct observers and medians, so it isn't the fix.
- **Tests** mirror artsobs: `connector.test.ts` and `connector-db.test.ts` (a fake SOS plus the real ingest routes on `birds_test`).

## Phase 3: registry + small generic app changes
- **Migration `0103_artportalen_source.sql`**, modelled on `0096`:
  - The `external_sources` row: `artportalen`, Artportalen / SLU Artdatabanken, licence and citation from the probe, `covers_country 'SE'`, `window_months 12`, `store_observers` per the Phase 0 rights finding.
  - All 21 `external_region_map` rows as reference data.
- **Staged queueability [C1-6]:** without a gate, an active source with 21 map rows lets any signed-in non-viewer queue any län right away. Work queued while the connector idles would run the moment its token appears.
  - Add a per-region `queueable` flag (or equivalent).
  - Only `SE-F` and `SE-AB` are enabled, and only at the approved rollout step.
  - Test the disabled viewer queue action.
  - **Every surface honours the flag [A4-2]:** no Load button may lead to a refusal.
    - `ExternalSourcesCard`: non-enabled län are left out of, or disabled in, the select, with a header such as "2 of 21 counties enabled".
    - `ExternalNearCard` (L246 `canLoad && !status`), `ExternalSpeciesCard` and `/reports/[source]/[region]`: show the not-enabled coverage note instead of a Load button.
    - Admin → Sources: shows which län are enabled.
    - The flag reaches each surface through its DTO.
- **Per-source locale [C1-9]:** add an `external_sources.locale` column (`'nb'` for artsobs, `'sv'` for artportalen; backfill the inactive source; validate the tag).
  - Carry it through queries, DTOs, SSR, client re-sorts and the connector's rank-before-slice paths (`aggregate.ts:363–370,437–444`): UI sorting can't bring back a Swedish tie already cut at rank 25.
  - Also fix the default collation at `external-reports.ts:132` and the SQL name ranking at `where-when.ts:214–218`.
  - Every hard-coded `'nb'` site is replaced **[A4-5]**:
    - `external-reports.ts:149`
    - `where-when.ts:154`
    - `near.ts:336,345`
    - `reports.ts:504`
    - `admin.ts:118` (Admin → Sources match list: Årta, Ängshök, Örnvråk)
  - Define the language used for mixed-source and English names, plus stable id tie-breaks.
  - Tests: sv Z/Å/Ä/Ö ordering, and Norwegian rank boundaries unchanged.
- **Recent cap [C1-9, A4-6]:** a partial recent list (20k cap) is made visible, not silent.
  - The connector records the recent rows' actual first and last dates, plus a truncated flag, in the load result.
  - `ExternalSpeciesCard` "Latest reports" (L149/L174) states the real span when truncated, instead of claiming 14 days.
- **UI text** made generic or extended:
  - `SourcesPanel.svelte` L40, L503 (the kråke example becomes "for example"), L510 placeholder "Local, scientific or eBird name", and the `localName` label at `admin.ts:41`.
  - `TaxonomyPanel.svelte` L253/461.
  - Help gets a Sweden section plus Version History. It explains that the window is set per source: Artportalen reads **12** complete months, Norway 24 (`help/+page.svelte:487, 517`). "In N of M Mays" therefore only applies where a source has several years.
  - About gets an Artportalen credit.
  - A clearly labelled partial / no-coverage state for län that aren't loaded.
- **Registry details:**
  - `region_link_template` comes from a stable Artportalen county URL if the probe finds one, else explicitly `NULL` **[A4-8]**.
  - The plan goes into `SourcesPanel` `REFERENCE_DOCS` **[A4-9]**.
- **Build and run:**
  - `build-connector.mjs` builds both bundles.
  - PM2 app `birds-connector-artportalen`.
  - `package.json` script `connector:artportalen:dev:test`.
- **Deploy gate [C1-6]:** both exact apps must be online for at least 35 s **in the same PM2 sample** within the existing deadline. Tests cover: either app missing or restarting, warning-prefixed or malformed output, and one app healthy while the other resets. Uptime is not proof of a working source: after activation, a successful claim and finish is checked separately.

## Phase 4: local end-to-end, then prod (each prod step needs its own go)
1. **Local** (isolated load state; Norway invariants checked before and after):
   - Load `SE-F`, then `SE-AB`.
   - Record wall time, peak RSS and heap through payload and finish, spool and DB staging space, finish time, heartbeat gaps, and host headroom with Norway active.
   - Month totals equal the selection's `Count`.
   - Check the forecast card, `/reports/artportalen/SE-AB`, the near card at Visingsö (58.04, 14.33) against a mainland Jönköping report outside the radius, and the observer list.
   - **Visingsö at radii of 5, 10, 20 and 31 mi [A4-4]:**
     - Record what `/forecast` resolves as `v.regionCode`. `majorityRegionCode` over eBird hotspots could pick `SE-O` or `SE-E` across Vättern, or null, and then never offer `SE-F`.
     - Confirm the near card labels the parts of the circle in län that aren't loaded.
     - If the region pick is wrong, fix it so a point inside a county counts toward that county; propose the fix to Gaylon before building it.
   - Reload after a failed load keeps the last good data.
   - Map unmatched taxa in Admin → Sources.
2. **Gate:** full tier:
   - `npm run check`, `npm run build`, full `npm test`, `git diff --check`.
   - CODEX1 high-effort review of the Phase 1 refactor and the connector.
   - Playwright on the Sweden pages at 390/1024, with fixtures covering both sources and accounts **[C1-10]**.
3. **Prod, each step with Gaylon's explicit go:**
   - Deploy (migration 0103; Sweden not queueable yet).
   - Token plus API key in `/opt/birds/.local/connectors/artportalen.env`.
   - Enable `SE-F`, then load it and measure (read-only).
   - Then `SE-AB`, the same way.
4. **td:** td-99eebf goes to review; Gaylon approves.

## Verification
- Probe JSON (sanitized fixtures) and the devlog record the API facts, the selection, the privacy policy and the rights decision.
- The artsobs suite is unchanged and green; frozen-input Norway payload digests and fingerprints are unchanged.
- The artportalen suite covers paging edge cases, privacy screening, the validator-backed mapping and preflight overflow.
- Local loads: month totals equal `Count`. Preflight shows headroom on rows, bytes and the finish body. Peak RSS stays under 600M under production flags. Visingsö near-card behaviour is checked.
- UI: Sweden appears as a second source with no source-specific app code; Swedish ordering is correct and Norwegian order unchanged; partial and no-coverage states are labelled.
- Prod: health OK; both connector apps pass the gate in one sample; each load is compared with its own evidence.

## Implementation notes (2026-11-19, built locally, not yet deployed)
- **Phase 1 (shared core):** moved into `src/connectors/shared/` with `git mv`:
  - `ingest.ts`, `spool.ts`, `payload.ts`, `aggregate.ts`.
  - New `http.ts`, `limits.ts`, `months.ts` and `records.ts`.
  - Norway keeps thin re-export wrappers, so its tests are unchanged.
  - `src/connectors/artsobs/parity.test.ts` pins the digests of Norway's chunks, records, manifest and fingerprint, computed before the move. They are identical after it.
- **Shared aggregate options:**
  - `sourceLabel` (the notes text) and `locale` (tie-breaks in the ranked lists cut at 25).
  - `recentKeepDays`: recent candidates are kept only within N days of the NEWEST REPORT seen so far, since months are read oldest first. Sweden uses 14 and also trims at 2× the 20k cap instead of 4×. Norway keeps 60 and 4×, so its output is unchanged.
  - An earlier version anchored a floor to the load's last day (`recentFloorDays`). CODEX1 round 2 showed it dropped every recent row for a county whose newest report was weeks old, so it was replaced.
  - Latest reports are chosen from rows WITH a link before the 20k cap. Protected or blurred rows never displace listable ones, and `recent_from` and `recent_to` are the span actually kept.
- **Sweden connector** (`src/connectors/artportalen/`): `sos.ts`, `records.ts`, `fetch.ts`, `run.ts`, `main.ts`, plus fixtures with made-up names and ids.
  - Each month's records are buffered on disk. County-wide ids are kept as a `Set<number>`.
- **Live measurements** (Stockholm, 12-month window 2025-11-01 – 2026-10-31 read through 2026-11-19, `--max-old-space-size=320`, macOS):

  | Recent-candidate rule | Result |
  |---|---|
  | rev A: 60 days from newest, trim at 4× | Out of memory in May |
  | rev B: today − 30 floor | 554,515 reports, heap 177 MB, RSS 432 MB |
  | rev C: 14 days from newest, trim at 4× | heap 246 MB, RSS 523 MB |
  | **rev D (built): 14 days from newest, trim at 2×** | **554,517 reports; heap 217 MB, RSS 532 MB; 300 s** |

  - In every successful run, all 13 months equalled `Count` on their first read.
  - Preflight (rev B): 599k rows, 305 MB; finish body about 272 KB, which needs the 2 MiB finish cap.
  - **Jönköping** (rev B, built connector through the dev app): 175,246 records published in 237 s, peak RSS 318 MB, 247 species, 10 unmatched subspecies taxa. Gråkråka (Corvus corone cornix, Hooded Crow) has 1,993 reports.
  - **Risk:** Stockholm's RSS is about 89% of PM2's 600M restart limit on macOS. The production SE-AB load is measured read-only on Linux. If it gets close, the options are a smaller page size or raising `max_memory_restart` for this app (owner's call, as for Norway).
- **Finish body:** the finish route alone accepts up to 2 MiB (`MAX_FINISH_BODY_BYTES`). Every other ingest call keeps 256 KiB. adapter-node gets `BODY_SIZE_LIMIT=3M` in `ecosystem.config.cjs`.
- **Registry (migration 0103):**
  - `external_sources.locale` and `external_sources.terms_url`. The SLU rules link and consent line show beside the attribution.
  - `external_region_map.queueable`, with a 409 `region_not_open` from `queueExternalLoad`.
  - Admin → Sources "Regions open for loading" opens and closes regions, so no command line is needed.
- **Visingsö county pick [A4-4]:** `majorityRegionCode` picks SE-F at every radius: 5/5 hotspots at 5 mi, 8/9 at 10 mi, 39/53 at 20 mi, 63/124 at 31 mi. The 31-mile case is a bare majority, but correct, so no change.
- **Feral Pigeon:** `Columba livia, domesticated populations` arrives unranked. It is kept as the form `Columba livia domestica` (SUBSPECIES under Columba livia), so Admin → Sources suggests Rock Pigeon for it and it isn't dropped as not-a-species.
