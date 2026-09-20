# Phase 8B: Hotspots & data geographic discovery

September 20, 2026 · Parent td-8ff597 · Sources td-d2bb08 and td-1e86c2

## Purpose

Phase 8A established a geographic selection contract for the Field Guide.
Phase 8B applies that model to **Hotspots & data** so a person can find a
country, first-level region, loaded county/equivalent or verified eBird hotspot
by typing or by choosing a map point and explicit radius. Selecting a result
opens the existing inventory, detail or load workflow; discovery itself never
loads bird data, queues a job or changes saved settings.

The core truth rule is stricter than name matching. A country or first-level
region is reference geography. A county/equivalent is a recorded loaded region.
A verified hotspot has affirmative eBird hotspot evidence. An observation-only
or failed location remains a **reported location — hotspot status unverified**
and can never be silently promoted to a hotspot, venue or public-access site.

## Verified baseline

At revision `1998fde`, `/forecast/data` has a client-enhanced typed search backed
by `/api/hub-search`. It searches only loaded `frequency_fetch` rows and terminal
failures, returns at most 200 matches, and exposes neither its cap nor a way to
continue. Only hotspot hits are links. Country, state/region and county hits do
not open their existing inventory or load workflows, search state is lost on a
round trip, and the page has no map discovery control.

The production-like test database currently contains 252 country and 3,369
first-level reference rows, but no second-level reference rows. Loaded frequency
rows contain the county/equivalent identities Phase 8A validates. Verified
hotspot discovery can be assembled locally from exact loaded hotspot rows,
cached official regional hotspot lists, and strict positive official hotspot
information. The current test snapshot contains 2,135 distinct coordinate-known
verified hotspot candidates in that union. Within 25 miles of Myakka River SP's
recorded coordinates it contains 349 verified hotspots representing four loaded
counties and one first-level region. These are discovery candidates, not Phase
8A historical frequency sources, so the totals intentionally differ.

`ebird_locations` alone is not hotspot proof. It contains reported locations and
must not be used to assert hotspot identity. The known antimeridian centroid
defects tracked by td-57d9fc remain deferred; Phase 8B uses exact hotspot
coordinates rather than region centroids.

## Frozen discovery contract

### 1. Canonical page state

Keep `/forecast/data` as the canonical surface. Add GET-owned discovery state:

| State | Canonical parameters |
| --- | --- |
| Typed query | `find=Myakka` |
| Typed result continuation | `find=Myakka&findPage=2` |
| Map discovery | `place=Myakka+River+SP&lat=27.240503&lng=-82.314817&dist=25` |
| Map result continuation | map parameters plus `mapPage=2` |

`find`, `findPage`, `place`, `lat`, `lng`, `dist` and `mapPage` are owned by
this page. Preserve all unrelated parameters. Typed and map modes are mutually
exclusive. A map state requires all four Phase 8A map values: non-empty place
limited to 200 characters, finite latitude in `[-90, 90]`, finite longitude in
`[-180, 180]`, and a whole-number radius from 1 through 200 miles. Generated
coordinates use at most six decimal places. There is no inferred, saved or
viewport-derived radius.

Normalize searches by trimming and collapsing whitespace. Preserve the text a
person submitted for display. Blank search clears typed discovery. A new typed
query or map point resets its result page. Clear discovery removes only owned
discovery parameters. Malformed, repeated or mixed owned parameters produce a
clear 400 response instead of guessed state.

The native GET form is authoritative and works without JavaScript. Debounced
enhancement may update results, but it must write the same canonical URL, use
the same server result model and retain a normal Submit button.

### 2. Searchable identities and verification

Build one server-owned discovery service and one shared result shape. Search the
following local/reference evidence without external provider calls:

1. **Countries and first-level regions:** exact rows from the `regions`
   reference table. Match exact normalized code first, then name and parent
   context.
2. **Counties/equivalents:** exact loaded `frequency_fetch` region rows whose
   shared parser identifies them as `subnational2`. Their recorded parent and
   stored/official-equivalent label establish identity. Do not invent “County”
   for another administrative type.
3. **Verified hotspots:** the deduplicated union of exact loaded
   `frequency_fetch` hotspot rows, hotspot IDs in cached official regional
   hotspot lists, and strict positive official hotspot-info cache entries.
   Cached-list names and coordinates may improve an exact result; identity must
   never come from fuzzy name similarity.
4. **Reported/unverified locations:** a failed or report-only location may be
   shown only when the existing local evidence makes it useful to recover the
   workflow. Its result type and visible label are **reported location — hotspot
   status unverified**. `ebird_locations` alone must not populate a general
   personal-location index, and no unverified row may enter the verified hotspot
   union.

Deduplicate by canonical country/region code or exact eBird location ID. Each
result carries a stable identity, type, display name, parent context, evidence
status, available coordinates, and load state: current, outdated,
available-not-loaded, failed, or unverified. Ordering is deterministic: exact ID,
exact name, prefix name, substring/context match; then verified/loaded evidence,
display name and stable ID.

No result description may imply venue features or public access unless a future
audited source from td-39d567 explicitly supports it. Phase 8B does not close
that metadata audit.

### 3. Complete result access

Return 50 results per page with an exact total and native Previous/Next controls
or an equivalent **Show more** control that eventually exposes every match.
Never retain the existing silent 200-result cap. Counts name the result universe
and filters, and zero means no local/reference match — not that no such place
exists in eBird.

The browser may request JSON enhancement from `/api/hub-search`, but the page
loader must render the same query, counts, pages and links without JavaScript.
The API accepts the same strict contract; it must not become an uncapped dump.

### 4. Map/radius discovery

Reuse `MapPicker.svelte`, its existing Google place/geocode action and its
48px/16px/mobile behavior. The marker provides a label and center; the radius is
a separate required 1–200 mile whole-number control. The map viewport is never
the search boundary. Choosing a Google place establishes only a point, not an
eBird hotspot or administrative identity.

Map results are coordinate-known **verified hotspots** inside the exact
great-circle radius. Use the same verification union as typed search, exact
coordinates and antimeridian-safe distance. Exclude coordinate-missing verified
hotspots from distance results and disclose how many locally known verified
hotspots could not be evaluated. Do not substitute region centroids.

The page may summarize countries, first-level regions and loaded
counties/equivalents represented by the returned nearby verified hotspots. Word
these as **areas represented by nearby verified hotspots**, never as a claim
that the arbitrary map point lies within those boundaries. Administrative
summary links use recorded hotspot ancestry and the normal result-selection
rules. They do not add whole-area rows to the radius result or close
td-57d9fc.

Map discovery reads local database/cache state only after the explicit geocode
interaction. It makes no eBird API request, frequency request or worker job.

### 5. Selecting a result

Every selectable result gets a named immediate return path containing the exact
canonical `/forecast/data` query, page, mode and result fragment. Use the shared
navigation-context validation and encoding; never accept an external return URL.

- **Country:** open and focus that country's existing inventory/loading section.
  If it has no loaded section, preselect it in the existing country/region load
  workflow. Do not submit a load.
- **First-level region:** open and focus its existing loaded group when present;
  otherwise preselect the existing **Load region** form with its country and
  region. Do not submit it.
- **Loaded county/equivalent:** open its exact county block with parent country
  and region disclosures expanded and focused.
- **Verified hotspot:** open `/hotspots/[locId]` with the exact named return path.
  That workspace retains its existing explicit load/refresh controls.
- **Reported/unverified location:** if exposed, open only the existing recovery
  workspace that can preserve the unverified label. Never route it through a
  verified-hotspot presentation or imply that a load will verify public-access
  status.

Selections are navigation/preselection only. They must not write
`frequency_fetch`, call eBird, enqueue a job, change the user's Home location or
modify account data. Back/return restores query, mode, pagination, scroll target
and focus. Owner and viewer permissions remain unchanged; discovery is shared
read-only state and action controls retain their current authorization rules.

## Interaction and copy

Replace the current transient **Find a hotspot or region** block with a server-
rendered **Find a country, region, county or hotspot** section. Result rows name
their type and evidence/load status rather than relying on icon or color alone.
Verified hotspot and unverified reported-location wording must be visually and
semantically distinct.

Provide a separate **Choose on map** disclosure with Apply and Cancel. Apply is
disabled until both a marker and valid explicit radius exist. Cancel restores
the last applied canonical state and focus. `<noscript>` explains that typed
search remains available but creating/moving a map point requires JavaScript;
an already shared map URL still renders its results on the server.

At 320px and 390px there must be no horizontal overflow or map controls hidden
behind fixed navigation. Preserve the shared MapPicker behavior validated in
Phase 8A. Help and About/Version History must explain the discovery evidence,
unverified labels, complete pagination and that selecting a result does not load
bird data.

## Expected implementation surfaces

The implementer may adjust decomposition after recording why, but the bounded
surfaces are expected to include:

- `src/routes/forecast/data/+page.server.ts`
- `src/routes/forecast/data/+page.svelte`
- `src/routes/api/hub-search/+server.ts`
- `src/lib/server/region-detail.ts` or a focused discovery module
- a small client-safe discovery URL/state helper
- the existing `src/lib/components/MapPicker.svelte` only if shared behavior
  genuinely needs adjustment
- focused service, loader, API, navigation, no-JavaScript and UI tests
- Hotspots & data Help text and a plain-language About/Version History entry

No schema migration, new dependency, external bird-data fetch or production
write is expected. Reuse shared region parsing, location-ID validation, cache
parsers, navigation context and Haversine utilities.

## Automated acceptance

Focused tests must prove:

1. strict typed/map parsing, normalization, mutual exclusion, repeated-field
   rejection and unknown-parameter preservation;
2. country/first-level reference search, loaded county search and exact-code
   priority for Florida, Norway, Sarasota and Myakka fixtures;
3. hotspot verification from each accepted evidence source, exact-ID
   deduplication, and rejection of observation-only/name-only promotion;
4. unverified/failed results retain explicit labels through selection;
5. exact totals and complete 50-row pagination replace the silent cap;
6. map/radius includes every coordinate-known verified hotspot inside the
   circle, excludes outside/unverified/coordinate-missing rows, discloses
   unevaluable rows and handles an antimeridian circle;
7. administrative summaries are derived only from nearby verified hotspot
   ancestry and do not claim point containment;
8. country/region/county navigation or form preselection and hotspot detail
   navigation preserve exact named return state without submitting actions;
9. the native typed flow and shared-map URL render without client JavaScript,
   while `<noscript>` honestly describes interactive map requirements;
10. owner/viewer action permissions, 48px/16px sizing, focus, scroll restoration
    and 320/390/1280px layout remain correct; and
11. discovery causes zero database writes, zero eBird calls and zero worker jobs.

After focused tests, run `npm run check`, `npm run build` and
`git diff --check`. Record broad-suite failures exactly; do not relabel a
failure as pre-existing without baseline evidence.

## Real-data browser acceptance

Use the isolated test app and production-like database in authenticated
Chromium and WebKit at 320px, 390px and desktop width, including owner dark theme
and viewer light theme:

1. Search exact codes and names for United States/Florida, Norway, Sarasota and
   Myakka; verify types, parent context, status and deterministic ordering.
2. Continue a query with more than 50 matches through its exact total; confirm
   no silent cap and back/forward state restoration.
3. Select a loaded country, region and county and confirm the exact inventory
   disclosure/focus; select an unloaded first-level region and confirm the load
   form is preselected but not submitted.
4. Open Myakka River SP as a verified hotspot, return, and confirm the exact
   query page, row and focus.
5. Exercise a failed/report-only fixture and confirm every surface retains
   **reported location — hotspot status unverified**.
6. Pick Myakka River SP's recorded coordinates, enter 25 miles and apply. The
   current test snapshot should produce 349 verified coordinate-known hotspots,
   four loaded counties and one first-level region; reconcile any changed count
   directly against the current evidence union rather than ignoring it.
7. Confirm the map result does not add whole-region frequency data, use a
   centroid, save a radius, alter Home, call eBird or queue work.
8. Reload and share both typed and map URLs, then clear discovery without losing
   an unrelated `future=kept` parameter.
9. Disable JavaScript: submit typed search, paginate and select a result; load a
   shared map URL and verify server results plus the honest interactive-map note.
10. Exercise a seeded point across the antimeridian and verify exact distance
    inclusion, zero horizontal overflow, accessible names and no page errors.

Capture before/after database/job counts around the journeys. Browser actions
must not mutate production or request new external bird data.

## Explicit exclusions

- No change to Phase 8A Field Guide result meaning or its historical frequency
  source contract.
- No All/Need/Seen or recent-versus-historical selector; those remain Phase 9.
- No Home, Forecast or trip-planning location handoff; that remains Phase 10.
- No region-boundary import, centroid repair or point-in-polygon inference.
- No general indexing of personal/report-only `ebird_locations` rows.
- No hotspot venue description or public-access assertion.
- No automatic load, refresh, external eBird request or worker job.
