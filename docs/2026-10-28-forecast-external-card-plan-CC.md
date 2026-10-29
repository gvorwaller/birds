# "What can I see?" shows other sources' reports near a place (td-46fff6)

Follow-on to the external sources epic (td-eec7db, closed 2026-10-28). Plan by CC1.

## Why
At Sandnessjøen in October, "What can I see?" within 31 mi gives "0 likely needed species · 2 long shots", all from eBird. Artsobservasjoner has a lot more for the same area. Measured on prod, read-only, 2026-10-28, against the owner's life list:

| Area, October | Species reported | Still needed |
|---|---|---|
| Alstahaug (Sandnessjøen's municipality) | 70 | 38 |
| The 9 municipalities within ~50 km (31 mi) | 113 | 74 |
| Nordland | 210 | 152 |

The page reads only eBird today. External data reaches three places: Hotspots & data, "Where can I find this bird?" and the species page, plus the new "Where and when to look" page.

## Rev B (2026-10-29): built on the stored reports
td-769300 now stores every report with its own coordinates (prod: 153,081 Nordland, 82,070 Oslo). The card counts **reports within the radius** directly instead of municipalities whose centre is within it. Rev A below is kept for the record; where they differ, Rev B wins.

**Measured on prod, read-only, 2026-10-29.** Sandnessjøen (66.0217, 12.6316), October, loaded window, owner's life list:

| Radius | Reports | Species | Still needed |
|---|---|---|---|
| 5 mi (8 km) | 46 | 25 | 12 |
| 10 mi (16 km) | 272 | 62 | 37 |
| 20 mi (32 km) | 673 | 93 | 57 |
| 31 mi (50 km) | 1,429 | 109 | 70 |

At 31 mi the reports come from 204 named places in 12 municipalities. Every record has coordinates. Uncertainty: 78,544 records ≤ 100 m, 134,126 ≤ 1 km, 21,826 ≤ 5 km, 655 above.

**Query speed:** the planner's first choice walked every taxon's records (500 ms). Filtering the coordinate box first (a materialized CTE) took 68 ms. All of Norway would be 14× the rows, and a latitude band in the south crosses many counties. So migration 0098 swaps the (lat, lon) btree for a GiST index on `point(lon, lat)` (built into PostgreSQL, no extension) and the query uses `<@ box`. Both are measured on real Nordland data in birds_test before choosing.

### What the owner sees
A separate card after the eBird card, before the eBird credit line:

> **Reported on Artsobservasjoner near Sandnessjøen**
> *Counts of reports sent to Artsobservasjoner, not checklist frequency or the chance of seeing a bird.*
> **70** species you still need were reported within 31 mi in October, Oct 2024 – Sep 2026 (1,429 reports of all birds).
> 1. **European Greenfinch**, 74 reports, in 2 of 2 Octobers
>    Skogsøy, Nesna, No (49 reports, 21 mi) · Steirostranda, Alstahaug, No (4 reports, 7 mi) · …
>    *Where in Nordland*
> 2. …
> *(the first 25, then "Show all 70" as a `<details>`, so it works without JavaScript)*
> *39 species you've already seen* (`<details>`: name, reports)
> **Busiest places near here in October:** the top 5 places for all birds, each with its count and distance, plus 📍 Map and Add to trip (a pin only when the place's best record is within 1 km uncertainty, the same rule as the other cards)
> **Where and when to look:** Nesna · Alstahaug · Dønna · … (the municipalities the reports fall in, most reports first; each links to that municipality and month)
> Attribution (the source's own block)

- **"in 2 of 2 Octobers"** tells a regular apart from a one-off: the number of that month's years in the window with a report nearby.
- **Species name** goes to the species page (as eBird rows do); **"Where in Nordland"** goes to "Where can I find this bird?" for the county with most of its nearby reports.
- **The pointer** sits under the eBird card's coverage pill: "Artsobservasjoner: 70 needed species reported within 31 mi ↓", jumping to the card. It is never added into the eBird numbers.
- **No reports within the radius,** with a loaded county nearby: "No Artsobservasjoner reports within 5 mi in October. The nearest is Steirohatten, Alstahaug, No, 7 mi away." The search for the nearest looks up to 3× the radius (at least 30 km).
- **County not loaded:** once the eBird analysis names the state-level region (Norway's fylke, e.g. NO-19 Troms), an active source that covers it but has nothing published adds "No Artsobservasjoner reports are loaded for Troms yet" and the Load button (not for viewers). This part arrives with the eBird stream; without an eBird key it is simply absent.
- **No card** when no active source has reports within reach and the region isn't covered (every US place).
- **Window:** only records inside each county's loaded window count, so the numbers agree with the totals on the other cards. Reports after the window (the latest 4 weeks) are left out; the species card's "Latest reports" covers them.

### Build
1. **Migration 0098:** drop `external_records_latlon_idx`; add a GiST index on `point(lon, lat)` WHERE lat IS NOT NULL.
2. **Reader** `src/lib/server/external-sources/near.ts`: `externalNear({ lat, lon, radiusKm, month, userId })`, in one `withReadSnapshot`.
   - **One aggregate query:** box filter, then the month, the county's published window and the active source. It returns haversine km and is grouped by (source, county, municipality, locality, species_code, year), giving reports, the minimum km and the best-uncertainty point.
   - **In JS:** species (needs or seen, top 3 places, years), places (all birds), municipalities, the denominator and the window label.
   - **The nearest-report query** runs only when nothing is within the radius.
   - Also `externalHintStates(regionCode)`, for the unloaded-county line.
3. **Page:**
   - `+page.server.ts` awaits `externalNear` with the location; a failure is logged and the card is left out. The analysis stream adds the hint states for `v.regionCode`. The action gets `queueExternalLoad`.
4. **UI:** `ExternalNearCard.svelte` (callout, `ExternalAttribution`, `reportsText`, `whereWhenHref`, `tripPlanHref`, `mapsPlaceUrl`, `formatDistance`). Every control is 48 px, and it is checked in all 5 themes.
5. **Help:** one sentence in the "What can I see?" section.

### Tests and gates
- **`near-db.test.ts`** (own fixtures) covers:
  - the radius cut (a record just inside and just outside);
  - the month and window filters;
  - an inactive source;
  - needs vs seen for the user;
  - top 3 places and their order;
  - the year count;
  - the denominator, including non-species taxa;
  - the nearest fallback;
  - unpublished hint states.
- **Render tests** cover the card states (normal, nearest-only, unloaded with and without a viewer) and the wording rules.
- **Mutation checks** on the radius cut, the window filter and the needs filter.
- **Live:** load real Nordland into birds_test (own source, dropped after). Sandnessjøen in October at 31 mi must equal a direct SQL count. EXPLAIN on btree vs GiST.
- **Gates:**
  - `npm run check` and the full suite;
  - Playwright on Chromium and WebKit, 5 themes, 320/390/1200 px, plus a JavaScript-off run;
  - the iOS Simulator pass;
  - a CODEX1 review at high effort;
  - `td review`.
- **Deploy** needs its own go.

### Not in this ticket
- **Crow names:** Artskart's "Corvus corone" (kråke) matches eBird's Carrion Crow, and "Corvus corone cornix" (gråkråke) is unmatched. In Norway the bird is the Hooded Crow. The fix is an owner override in Admin → Sources; it is raised separately.
- Locality names keep Artskart's county abbreviation (", No"), as on the other cards.

---

# Rev A (2026-10-28, superseded where Rev B differs)

## What the owner sees
A separate card on "What can I see?", below the eBird species lists and above "Loaded hotspots in use". It appears whenever a loaded source has municipalities within the chosen radius:

> **Reported on Artsobservasjoner near Sandnessjøen**
> *Counts of reports sent to Artsobservasjoner, not checklist frequency or the chance of seeing a bird.*
> 74 species you still need were reported in October in 9 municipalities within 31 mi, in the loaded window (N reports of all birds there that month).
> 1. *Species* · *N* reports · *its top 3 of the nearby municipalities*
> 2. …
> *(40 rows, then "Show all 74")*
> Municipalities: Alstahaug · Dønna · Leirfjord · …, nearest first with distances (each links to "Where and when to look" for that municipality and month)
> Where and when to look in Nordland ›
> Attribution (the source's own block, as on the other cards)

- **Rows:** needs only, most reports first, the same ordering as the by-month list on "Where and when to look". Each row gives:
  - the species name, linking to "Where can I find this bird?" for that county, where the Artsobservasjoner card already shows its months and municipalities;
  - its report count within the radius;
  - up to 3 of the nearby municipalities with the most reports of it.
- **Seen species:** a line under the list, "Plus 39 species you've already seen ›", links to "Where and when to look" with All species.
- **Summary line:** a small pointer goes under the eBird summary, "Artsobservasjoner: 74 needed species reported within 31 mi ↓", jumping to the card. Without it, the card would sit below the eBird lists on a phone. The pointer is a separate line, never added into the "likely" number (owner decision at the epic's start: report counts never enter the eBird frequency tables or wording).
- **No municipality within the radius,** but a loaded county is close: the card names the nearest municipality and its distance ("No municipality centre within 5 mi; the nearest is Alstahaug, 9 mi") and lists that one.
- **County not loaded yet:** when eBird's nearby hotspots put the point in a county that an active source covers (for example Troms), the card says "No Artsobservasjoner reports are loaded for Troms yet" and shows the Load button, the same action and status as elsewhere. Viewers see the text without the button.
- **Wording:** the same rules as the other cards: report counts, never "likely" or "frequency"; the share appears only in prose beside its denominator.
- **Nothing else changes.** No source covers the US, so a US place shows no card.

## The one real gap: where each municipality is
`external_places.lat/lon` exists in the contract and the table, but the Artskart connector sends null for every place (prod: 0 of 42 Nordland places have coordinates). Without a location, the app can't tell which municipalities are within 31 mi.

**Recommended:** the connector sets each municipality's location to the **median of its reports' coordinates** (latitude and longitude separately, from records that have coordinates, rounded to 3 decimals ≈ 100 m). That is where the birding in that municipality actually happens: Vefsn's point lands near Mosjøen, not in the mountains, and "near me" is about where people look.
- No contract or migration change: the place rows already carry `lat`/`lon`, and the ingest already validates them (both set or both null, within range).
- The county row stays null. Distance is measured to municipalities only.
- The connector already reads every record's coordinates, so this adds no requests to Artskart.

**Rejected:** fetching each municipality's official centre from Kartverket by `MunicipalityId`. It adds a second outside service to the connector, and a geographic centre is worse for this question.

**Rejected:** averaging the 25 stored top places per municipality in the app. My measurement used this, and it gives the same 9 municipalities. But it ignores most reports, and it would be a second definition of "where a municipality is" living in the app.

**Consequence:** counties loaded before this change have no locations until they are reloaded. On prod that means Nordland and Oslo. Until then, a nearby county with no locations gets the line "Reload Nordland to see its reports near here" and the Reload button. After the deploy, with the owner's go, I queue both reloads. Measured: Nordland took 8 min 49 s on 2026-10-28 and Oslo 3 min 28 s.

## Build
1. **Connector:** in `src/connectors/artsobs/aggregate.ts`, the place accumulator collects record coordinates per municipality, and `PlaceRow` gets its median `lat`/`lon`.
   - Bump the fingerprint tag `artskart-municipality/v1` → `v2` so a load records the rule it used.
   - Tests in `connector.test.ts`: the median, a municipality with no coordinates (stays null), and the county row stays null.
2. **Reader:** add `externalNear({ lat, lon, radiusKm, month, userId, regionHint })` to a new `src/lib/server/external-sources/near.ts`, in one `withReadSnapshot`.
   - **Places:** the active sources' published subregions with coordinates within the radius (haversine in SQL; the table is tiny), nearest first. If none is within the radius, the nearest within 3× the radius is returned and flagged.
   - **Species:** the same query shape as where-when's by-month list, over those `place_key`s: the summed reports, needs first, seen counted separately, and the top 3 municipalities per species.
   - **Denominator:** `external_place_month_totals` summed over those places for the month.
   - **States:** with `regionHint` (eBird's majority county), it reports whether that county is unloaded, loading, failed, or loaded without locations.
3. **Page:** in `src/routes/forecast/+page.server.ts`, add a second streamed promise next to `analysis`. Its failure must not hide the eBird results, and the reverse.
   - Needs: location, `distKm` and month. The `regionHint` comes from the eBird analysis when it resolves; a missing eBird key or an eBird failure leaves it null and loses only the Load offer.
   - Add the `queueExternalLoad` action (the shared `queueExternalLoadAction`).
4. **UI:** a new `src/lib/components/external/ExternalNearCard.svelte`, reusing the callout, `ExternalAttribution`, `reportsText` and `whereWhenHref`. Distances use `formatDistance(km, "mi")`, as the page does.
   - Wire it, and the summary pointer, into `src/routes/forecast/+page.svelte`.
   - All controls are 48 px. Without JS, the rows render on the server and "Show all" is a link (`?extAll=1`).
5. **Help:** one sentence in the "What can I see?" section.

## Tests and gates
- **Database tests (`near-db.test.ts`, own fixtures):**
  - the radius cut;
  - the nearest-only fallback;
  - places without coordinates are ignored, and give the reload state;
  - per-user needs;
  - an inactive source is hidden;
  - the denominator matches the summed totals;
  - the top-3 municipalities are right.
- **Render test:** the card without JS, the wording rules, a viewer, and the unloaded and needs-reload states.
- **Mutation checks** on the radius cut, the needs filter and the reload-state guard.
- **Live data:** load real Nordland into `birds_test` with the new connector (own fixture source, deleted after). Check that Sandnessjøen in October gives about 9 municipalities and that the species count matches a direct SQL count.
- **Gates:**
  - `npm run check`;
  - the full suite;
  - Playwright: Chromium and WebKit, 5 themes, 320/390/1200 px, plus a run with JavaScript off;
  - the iOS Simulator pass on the forecast page;
  - CODEX1 review at high effort (it touches the connector and a busy page);
  - then `td review`. The owner approves.
- **Deploy:** needs its own go. Queue the Nordland and Oslo reloads after it, with a go, then do a read-only check that their places have coordinates.

## Out of scope
- "Nearest to me" sorting in the "Where and when to look" municipality picker. The new locations make it possible later.
- Per-place (locality) species counts. The connector stores species per municipality only, so "near" means "in a nearby municipality".
