# Phase 8A: Field Guide geographic selection contract

September 20, 2026 · Parent td-8ff597 · Sources td-d2bb08 and td-1e86c2

## Purpose

The Field Guide can currently filter historical frequency data only by country
and first-level region. The owner asked for county, verified hotspot and
map/radius choices as well. Phase 8A adds those choices to the Field Guide and
defines the geographic contract later pages will reuse. It does not yet change
Hotspots & data, Forecast, Home, trip planning or All/Need/Seen meaning.

The central product rule is that selecting geography must not overstate the
data. A named region means historically reported species in loaded frequency
sources belonging to that region. A hotspot means that exact loaded eBird
hotspot. A map point means only coordinate-known, loaded hotspots within the
user's explicit radius. The map viewport itself is never a search boundary.

## Verified baseline

At revision `5adddea`, the Field Guide owns `country` and `region` query
parameters. `guideLocationCoverage()` expands either code across all recorded
region and hotspot sources beneath it, and `searchGuide()` intersects matching
species before pagination. The compact Phase 7A result layout and Phase 5B
return navigation already preserve the complete URL and unknown parameters.

The isolated production-like test database currently contains:

- 91 country, 3,109 first-level, 3,459 second-level and 6,328 hotspot
  `frequency_fetch` rows;
- all 67 Florida county rows and 3,679 loaded Florida hotspot rows;
- Sarasota County (`US-FL-115`) with 376 historically reported species;
- Myakka River SP (`L299291`) with 244 historically reported species; and
- 99 coordinate-known loaded hotspots and 351 distinct historically reported
  species within 25 miles of Myakka River SP's recorded coordinates.

Those measurements establish useful acceptance fixtures. Counts may grow when
data is deliberately refreshed, so automated tests seed exact rows and browser
acceptance verifies containment and meaning rather than freezing mutable
production-copy totals.

## Frozen URL and selection contract

### 1. Canonical parameters

Extend the existing GET-driven URL with these owned parameters:

| Selection | Canonical parameters |
| --- | --- |
| Anywhere | none of the geographic parameters |
| Country | `country=US` |
| State / region | `country=US&region=US-FL` |
| County / equivalent | `country=US&region=US-FL&county=US-FL-115` |
| Verified hotspot | the country, region and county ancestry plus `hotspot=L299291` |
| Map + radius | `place=Myakka+River+SP&lat=27.240503&lng=-82.314817&dist=25` |

`country`, `region`, `county`, `hotspot`, `place`, `lat`, `lng` and `dist` are
owned Field Guide parameters. All unrelated and unknown parameters continue to
survive search, filter, tag, pagination and bird-return operations.

The most specific valid hierarchical parameter determines the selection kind.
Map/radius parameters are mutually exclusive with the four hierarchy
parameters. Reject mixed, malformed or incomplete URLs with a clear 400 error;
do not guess which half the user intended. Existing country/region URLs remain
canonical and compatible.

Normalize codes to uppercase. A map selection requires all four values:
non-empty `place` limited to 200 characters, finite latitude in `[-90, 90]`,
finite longitude in `[-180, 180]`, and a whole-number radius from 1 through 200
miles. Six decimal places are sufficient in generated URLs. No saved radius or
hard-coded radius fills an absent or invalid `dist`.

Changing a country clears region, county and hotspot. Changing a region clears
county and hotspot. Changing a county clears hotspot. Applying map/radius
clears all hierarchical parameters. Clearing location removes every geographic
parameter without changing search, family, sort, interest, tags or unknown
parameters. Every change resets `page` and targets `#results`.

### 2. Validated identity

Country and first-level region retain the static `regions` reference checks.
A county is valid only when a loaded `frequency_fetch` region row has the exact
code, the shared region-code parser identifies it as `subnational2`, and its
immediate parent is the selected first-level region. Its displayed name is the
stored eBird location name, upgraded to the official county-equivalent label
from `countyMeta()` when that exact code is present. Never append “County” to
an unknown equivalent.

A hotspot is valid only when an exact loaded `frequency_fetch` row has
`loc_kind='hotspot'`, its ID passes the public eBird location-ID shape check,
and its recorded `region_code` belongs to the selected county. The displayed
name is its stored eBird name. A reported personal location, a Google place or
a name-only match cannot become a hotspot selection.

The server derives and returns the selected type, validated ancestry, display
label and coverage description. The browser never declares identity from
free-form text.

### 3. Historical coverage semantics

Country, state/region and county selection include every loaded historical
frequency source recorded at or beneath that exact hierarchy:

- exact region rows plus descendant region rows; and
- hotspot rows whose recorded `region_code` is the selection or a descendant.

An exact hotspot includes only its own loaded frequency source. Keep the
existing union semantics: a species present in any included source is present
in the filtered result. Keep complete pagination and the existing search,
family, tag and special-interest intersections.

Coverage output must state the selected type and label, source count, earliest
and latest complete years, and whether an exact whole-area region source is
loaded. When only component areas are loaded, say that places without loaded
data are not covered. Zero sources means unavailable coverage, never zero birds.

### 4. Map/radius semantics

Reuse `MapPicker.svelte`; do not add another map provider or map loader. The
picked marker supplies the center and label. Radius is a separate, required,
visibly labelled control in miles. Moving the marker does not silently retain a
result until the user explicitly applies the new point and radius.

Map/radius coverage includes only loaded `frequency_fetch` hotspot rows whose
same-ID `ebird_locations` row has finite coordinates within the explicit
great-circle radius. Do not include country, state or county-wide frequency
rows by centroid; their data covers a whole area rather than that circle. Do
not include coordinate-missing hotspots or Google Places as if they were
historical eBird sources. Return an honest count of included loaded hotspots
and disclose that coordinate-missing loaded hotspots could not be evaluated.

Distance calculation must handle the antimeridian correctly. A direct map
point does not use the known bad seeded centroids tracked by td-57d9fc. Seeded
tests must cover a circle crossing 180 degrees. This phase must not remove the
existing centroid safeguards or claim td-57d9fc is fixed.

If no coordinate-known loaded hotspots fall inside the radius, the page shows
that historical coverage for this circle is unavailable and links to Hotspots
& data. It does not fetch eBird, start a worker job, fall back to a region or
show an empty result as proof of absence.

## Field Guide interaction

### Hierarchical chooser

Inside the existing **Filters and sort** disclosure, retain the Country and
State / region selects and add:

1. **County / equivalent**, enabled after a state/region is selected and
   populated with every loaded second-level region directly beneath it.
2. **Verified hotspot**, enabled after a county is selected and populated with
   every loaded hotspot recorded under that county.

Options are name-sorted with code as a stable tie-breaker. Do not silently cap
or sample either list. If no loaded child choices exist, say so and provide the
existing Hotspots & data load link. Selection changes use native GET forms and
remain usable without JavaScript. Enhanced auto-submit may retain the open
filter disclosure, but Apply filters remains the authoritative fallback.

The scope summary outside the disclosure names the exact selected type, for
example **Sarasota County** or **Myakka River SP · verified eBird hotspot**.

### Map/radius chooser

Add a clearly separate **Choose on map** disclosure or button inside the
geography portion of the filter editor. Opening it reveals the shared
MapPicker, explicit radius control, current picked-place text, Apply location
and Cancel. Apply remains disabled until the marker and valid radius exist.
Cancel restores the previously applied Field Guide URL and focus without
changing results.

With JavaScript disabled, country/state/county/hotspot and Apply filters remain
fully usable. An already shared map/radius URL still renders and filters on the
server, with its text summary and a clear-location action. Creating or moving a
map marker requires JavaScript and must say so in `<noscript>` content.

All touched controls are at least 48px high and text inputs are at least 16px.
At 390px, the picker must not cause horizontal page overflow or hide Google map
controls behind the fixed navigation. Preserve Phase 6 focus/reveal behavior
when the picker opens or closes.

## Result and navigation preservation

- Preserve the Phase 7A compact answer-first layout, provenance, thumbnails,
  badges, complete counts, 100-row pages and honest empty states.
- Add the new parameters to the owned-parameter set so clear and hierarchy
  transitions change them deliberately; continue preserving every unknown
  parameter.
- Species links capture the complete canonical list URL. A bird return restores
  the exact result row, geography, map center/radius where applicable, page,
  fragment and focus.
- Do not record the selection in Settings or change the user's saved Home
  location/radius.
- Preserve owner/viewer isolation. Geography is shared read-only data; personal
  Seen, Viewed and Special-interest state keeps its existing account rules.

## Expected implementation surfaces

The implementer may adjust the exact decomposition after explaining why, but
the bounded surfaces are expected to be:

- `src/routes/species/+page.server.ts`
- `src/routes/species/+page.svelte`
- `src/lib/server/guide-location.ts`
- a small client-safe Field Guide location contract/helper
- the existing `src/lib/components/MapPicker.svelte` only for reusable focus,
  apply/cancel or initialization needs
- focused loader, location, query-preservation and UI tests
- Field Guide Help text and a plain-language About/Version History entry

No schema migration, dependency, external data load or production write is
expected. Reuse `frequency_fetch`, `species_month_freq`, `ebird_locations`,
`regions`, `countyMeta`, region parsing, location-ID validation, Haversine
utilities and the existing map/geocode endpoint.

## Automated acceptance

Focused tests must prove:

1. strict parsing, normalization and mutual exclusion for all six selection
   kinds, including invalid ancestry and missing/invalid radius fields;
2. changing a hierarchy level clears only incompatible descendants and every
   match-changing action resets page while preserving unknown parameters;
3. county coverage includes the exact county and its recorded hotspots but no
   sibling county;
4. hotspot coverage includes only the exact verified loaded hotspot;
5. map/radius includes every coordinate-known loaded hotspot inside the circle,
   excludes outside and coordinate-missing rows, reports unavailable counts and
   handles an antimeridian circle;
6. the location intersection happens before pagination and retains the complete
   result count, thumbnails, Seen/Need, Viewed, Special interest and provenance;
7. complete, component-only and unavailable coverage wording remains distinct;
8. country/state/county/hotspot native forms work without client JavaScript;
9. 48px/16px sizing, accessible names, map apply/cancel focus and no hidden
   default radius; and
10. existing Field Guide, MapPicker, guide-location, navigation-context,
    taxonomy, interest and account-isolation tests remain green.

After focused tests, run `npm run check`, `npm run build` and
`git diff --check`. Record any broad-suite failures exactly; do not relabel a
failure as pre-existing without baseline evidence.

## Real-data browser acceptance

Use the isolated test app and production-like database in authenticated
Chromium and WebKit at 390px and desktop width. Exercise owner dark theme and
viewer light theme without mutating production or loading new external data:

1. Anywhere → United States → Florida → Sarasota County and confirm the scope
   identifies a county, coverage years/sources are truthful and all results
   remain pageable.
2. Sarasota County → Myakka River SP (`L299291`) and confirm the exact hotspot
   scope is visibly narrower than county scope.
3. Search **Myakka River SP**, adjust the marker to its recorded coordinates,
   choose 25 miles, apply and confirm the summary names the point, 25-mile
   radius and included loaded-hotspot count. The current corpus should contain
   99 evaluated sources and 351 species unless a deliberate refresh changed it;
   any change must be reconciled from the database rather than ignored.
4. Clear back to Anywhere without losing an unrelated `future=kept` parameter,
   search text, family, tags, sort or interest constraint.
5. Reload and open a copied hierarchical URL and a copied map/radius URL.
6. From a page-2 result, open a species and return to the exact source row with
   the complete location URL and focus restored.
7. Confirm native no-JavaScript hierarchy submission, server rendering of a
   shared radius URL, explicit map-JavaScript explanation, no horizontal
   overflow, no page error and no unintended writes.

Also exercise a seeded or real direct map point close to the antimeridian. The
test proves distance inclusion, not the correctness of the deferred region
centroids.

## Explicit exclusions

- No typed/map discovery on Hotspots & data; that is Phase 8B.
- No All/Need/Seen selector or recent-versus-historical selector; those are
  Phase 9.
- No cross-page location handoff to Home, Forecast or trips; that is Phase 10.
- No eBird fetch, automatic frequency load or worker job triggered by selection.
- No arbitrary Google place treated as a hotspot.
- No viewport-derived or saved default radius.
- No silent option/result cap, reduced result detail or pagination change.
- No fix or closure of td-57d9fc unless its independent acceptance plan is
  separately implemented and reviewed.

## Review and handoff

Codex primary owns this specification and final diff review. `CC1` is the sole
implementation writer through Claude Relay. After Codex review is clean,
`GROK` receives a read/test-only charter for the automated and browser/UI/UX
acceptance above. Confirmed defects return to CC1; GROK retests them; Codex
performs final review. The child ticket moves to review only after this record
is complete. Commit and deployment require a separate owner instruction.

## Amendment 2026-09-25 (td-daff98, owner-approved)

The Filters and sort panel is now a **draft** form: changing a Place level,
the map point, Special interest, family, sort or a trait choice changes nothing
until **Apply filters**. The contract above is unchanged. Hierarchy XOR map,
strict identity, levels clearing their descendants, and the no-JS `was_*`
canonicalization all still hold, with these additions:

- **Cascade without navigation.** `GET /api/guide-locations?level=region|county|hotspot&parent=…`
  returns the same lists the loader renders (`guideRegions`, `guideCounties`,
  `guideHotspots`), after proving the parent exists (a well-shaped but unknown
  parent is a 400; a real parent with nothing loaded is `[]`). Session
  required; DB/reference data only; `Cache-Control: private, max-age=300`.
- **Searchable Place fields.** After hydration, each native select becomes an
  accessible combobox (`SearchableSelect`) that submits its committed code
  through one hidden input. Typing filters case- and accent-insensitively,
  best matches first; long lists page with "Show next", and nothing is capped.
  Unfiltered lists use one fixed collator order (`comparePlaceChoices`).
- **`was_*` only without JavaScript.** Once the searchable fields take over,
  the `was_*` inputs are disabled, because the submitted hierarchy is already
  consistent. The loader's strict parse then applies. Before hydration they
  still submit, and the loader canonicalizes as before.
- **Map "Use this point".** The chooser now puts the point into the draft; the
  single Apply filters button applies it.
- **Immediate actions unchanged.** Result ✕ chips, Clear location only, Clear
  all, All/Need/Seen and pagination act on the applied state straight away.
