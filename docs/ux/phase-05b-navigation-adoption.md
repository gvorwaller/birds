# Birds UX phase 5B — adopt journey context across remaining entry points

September 19, 2026 · Parent td-8ff597 · F01 / release-1 package A

## Outcome

Extend the phase 5A journey contract released as `c731094` to the remaining
bird-list, search, collection, Forecast and report entry points. A person can
open a bird or hotspot several levels deep and return to the exact filtered page
and originating row without repeating a search. Ordinary URLs, reload, new tabs,
JavaScript-disabled navigation and browser Back/Forward remain usable.

This phase adopts the existing navigation core. Do not redesign it, create a
second history store, put a serialized trail in URLs or use native browser
history internals. Use `navigationAction`, `PathNavigation`, stable origin IDs,
canonical immediate `returnTo` fallbacks and the actual signed-in account ID.

## Included routes and journeys

Adopt these entry points:

- Field Guide `/species`, Taxonomy `/taxonomy`, Viewed `/viewed`, and Special
  interest `/special-interest` to `/species/[code]` and back.
- Photos `/photos` and Life list `/life` to `/species/[code]` and back.
- Home `/`, Nearest `/nearest`, and Alerts `/alerts` to bird and hotspot detail
  and back.
- Bird detail to `/forecast/species`, its county/hotspot results, hotspot detail,
  another bird, and back through the named path.
- Hotspots & data `/forecast/data` entries that open a hotspot or species detail.

Representative acceptance journeys are:

1. Field Guide page 2 with name/family/geography/tag/sort filters → bird → its
   family in Taxonomy → another bird → return through Taxonomy to the original
   Field Guide row and filters.
2. Home at an explicit searched place/radius → bird → Where to find this bird →
   county/hotspot → hotspot → another bird → return to the original Home result.
3. Nearest with explicit bird/window/distance → report hotspot → bird → return to
   the exact report, then back to the original selected bird and controls.

Also exercise one Photos or Life-list entry and one Alert-history entry. The
journey may have fewer ancestors when it began in a new tab or storage is
blocked, but its ordinary immediate fallback must remain correctly named and
retain the source URL.

## Explicit exclusions

Do not add county/hotspot/map-radius selection to Field Guide; that is package B.
Do not change All/Need/Seen semantics, rankings, result limits, pagination sizes,
provider calls, caches, query order, list ownership or database schema. Do not
add thumbnails or restyle species rows in this phase. Do not implement drawer
keyboard behavior, map reveal/focus, general control sizing, compact Field Guide
filters, species section navigation or remembered card disclosure; those belong
to phases 6 and 7. No new dependency or migration.

## Released contracts to preserve

- `src/lib/navigation-context.ts` owns local-URL validation, canonical content
  URLs, nonrecursive immediate fallbacks, bounded labels and validated storage.
- `src/lib/navigation-context.svelte.ts` owns account/tab state, successful
  enhanced navigation, reload recovery, active-trail reuse and origin/UI state.
- `src/lib/components/PathNavigation.svelte` owns the prominent named return,
  compact ancestry, missing-history feedback and delayed focus restoration.
- Same-resource query changes update one node. A different bird, hotspot or
  workspace page is a distinct resource. Ordinary primary navigation clears the
  active journey; it must not revive an unrelated earlier path.
- Only unmodified same-tab internal primary clicks are enhanced. Modifier click,
  middle click, keyboard activation, `target`, `download`, JS-off, preload,
  cancellation and normal href behavior remain native and usable.
- Browser popstate owns its scroll. An explicit in-app ancestor return restores
  the source row only after its streamed/paginated content exists and only if
  the user has not moved or focused something else.
- Unsafe/corrupt/missing navigation data is ignored. Blocked storage keeps one
  validated immediate fallback and never invents ancestry or changes results.
- Navigation state contains labels, hrefs, origin IDs and small UI disclosures;
  it never contains bird data, credentials, result arrays or edit drafts.

If adoption reveals a core defect, add a focused regression to the existing
navigation tests and repair the common core. Do not add route-specific patches
that create different history semantics.

## Source-page registration and labels

Register a source page only when the route participates in an adopted journey.
Use labels from trusted loaded data or fixed product copy:

- `Field guide`, `Taxonomy`, `Viewed species`, `Special interest`, `Photos`,
  `Life list`, `Home`, `Nearest reports`, `Alerts`, `Where to find [bird]`, and
  `Hotspots & data`.
- The species, trip and hotspot labels already come from actual loaded records.
- A selected shared life list may append its trusted loaded display label, but
  a raw query value must never become trusted display text.

Root workspace pages do not need a noisy unconditional back control when opened
from primary navigation. They must still register a node and enhance their
outgoing adopted links. When a workspace itself was reached from an adopted
parent, render `PathNavigation` with an honest contextual fallback. Never claim
that an unvisited page is an ancestor.

All canonical source hrefs retain every content query and fragment, including
unknown future keys. Navigation-only keys and named POST-action keys remain
stripped by the shared core. Do not rebuild query strings from a hand-selected
subset when the current canonical URL already expresses the correct state.

## Stable origins and exact restoration

Add unique, deterministic DOM IDs based only on real route data. Encode or
normalize unsafe characters before placing them in an ID. Prefix by page and
section so the same species appearing twice on one page cannot duplicate IDs.
Examples of the required identity shape:

- `guide-species-[code]`, `taxonomy-species-[code]`,
  `viewed-species-[code]`, `interest-species-[code]`.
- `photos-species-[code]`, `life-species-[owner-or-view]-[code]`.
- `home-[section]-[code-or-report-id]`, `nearest-[section]-[report-or-code]`,
  and `alert-[alert-id]-[code]`.
- `forecast-species-[county-or-hotspot-id]` and
  `forecast-data-[section]-[location-or-species-id]`.

Use a real checklist/report/alert/location ID where rows can repeat a bird.
Species code alone is insufficient for two reports of the same bird on a page.
The clickable/focusable row or its primary link must carry the ID and
`path-focus-target` class. Returning focuses that meaningful element and centers
it below the fixed header. Do not insert dummy rows or change filters to make an
old origin exist.

When a source row no longer exists because its underlying data changed, retain
the valid current page, filters, pagination and counts and show the existing
concise missing-origin notice. Do not silently navigate to page one, Home or a
broader dataset.

## Route-specific requirements

### Field Guide and Taxonomy

Field Guide detail links must retain the complete current canonical URL: query,
interest flag, every repeated tag, family, sort, page, country, region and hash.
Return restores the original result link; it never discards filters or resets
pagination. Existing progressive access to the full matching set is unchanged.

Taxonomy keeps its current URL-driven order/family/search/focus contract. A
return from bird detail reveals the correct order and family and focuses the
matching `taxon-[code]` row. Integrate this with PathNavigation rather than
running a competing unconditional `afterNavigate` scroll. Search-filtered
missing-focus behavior remains honest and offers the existing unfiltered family
link. Bird-detail family/order links must adopt the current bird as their source
while retaining an ordinary focused Taxonomy URL.

Viewed and Special interest retain query, grouping, sort and any current
selection state already represented in their URLs. Clearing viewing history and
adding/removing Special interest remain explicit mutations; navigation adoption
must not submit, repeat or restore those actions.

### Photos and Life list

Photos species headings enter bird detail with a named `Photos` source and
return to the exact species group. External photo links remain external and are
not adopted. Gallery sync and match controls are unchanged.

Life-list bird links retain the canonical selected-list URL and restore the
exact row in both table and supported chart/list interaction paths. Use the
actual signed-in account for navigation storage even while reading a shared
owner list. Do not leak or substitute the shared owner ID. List switching,
search/filter state, export, share settings and eBird checklist links are
unchanged. Generated chart markup must keep a fully usable ordinary href; use a
single safe delegated enhancement only if a Svelte action cannot attach to that
markup, and scope it to marked internal bird links.

### Home, Nearest and Alerts

Home source URLs retain explicit `place`, `dist`, selected `loc`, display/filter
choices and any future content keys. Stable IDs distinguish needs, notable,
personal-sighting and place/report sections. Returning must not replace an
explicit searched place with saved Home or restart enrichment solely because of
navigation bookkeeping.

Nearest source URLs retain selected bird, search text where applicable,
`back`, `nearestKm` and any other content keys. Adopt both bird and internal
hotspot names. Report origins use their real checklist/location/time identity so
duplicate species or place/time pairs remain distinct. Existing bounded lookup
and partial/unknown semantics remain unchanged.

Alert bird links and any internal report/location links retain the Alert-history
source and alert row identity. Opening eBird checklist URLs remains external.
No alert read/acknowledgement behavior is added.

### Species Forecast and Hotspots & data

`/forecast/species` uses `Where to find [actual bird name]` after taxonomy
validation. It adopts a bird-detail source and registers county/hotspot result
origins. Species selection, country/state/county/month query state and streamed
result state remain canonical and refreshable. Query changes within the same
selected-bird workspace update its node rather than building a chain of every
selector change.

Internal county/hotspot actions pass actual validated labels and current
Forecast source context. Hotspot links use their real eBird location ID and
coordinates already supplied by the loader; never turn an observation place
into a verified hotspot or fabricate coordinates. A subsequent hotspot-to-bird
link already uses the 5A contract and must preserve the Forecast ancestry.

`/forecast/data` registers named origins for internal hotspot/species links while
leaving background-job forms, correction controls, failure retries and
disclosures untouched. Navigation must not enqueue work, change polling scope or
restore an open mutation form.

## Focused automated checks

Add behavior-focused tests rather than static assertions that merely mirror the
new markup:

- Canonical source URLs retain repeated tags, page/filter/search/location/month/
  radius values, hashes and unknown content keys through two or more adopted hops.
- Route link helpers create one nonrecursive immediate fallback with the trusted
  source label and stable origin ID.
- Same-workspace query changes update rather than deepen a path; changing bird or
  hotspot creates a child; ordinary primary navigation does not revive an old
  path.
- Taxonomy focus and missing-focus behavior coexist with PathNavigation focus.
- Duplicate reports/alerts/species sections generate unique origin IDs.
- Life-list navigation is scoped to the signed-in viewer while a shared owner's
  list is displayed.
- Blocked storage, invalid state, direct/new-tab fallback, reload and account
  switch retain the released degradation and isolation contracts.
- No navigation click submits a form or calls a provider/job endpoint.

Keep the 83 phase 5A regressions green. Add route-loader tests only when source
data is transformed; do not run broad DB-writing fixture suites against the
restored test copy.

## Real acceptance and preservation

Primary review will exercise Chromium and WebKit at 390px plus desktop against
the restored test data and running worker. Use existing real rows and records;
do not create synthetic birds, checklists, alerts or locations. Record the
actual URLs, source IDs, focus targets, list counts, page errors and overflow.

Verify the three representative journeys plus Photos/Life and Alerts. Include
reload at bird detail, explicit ancestry returns, browser Back/Forward, new-tab
immediate fallback, blocked storage and switch to the family viewer. Confirm
the viewer uses its own navigation namespace while permitted shared list data
still renders. No paid AI calls or production data mutations.

Before and after acceptance, preserve owner Seen count, the Myakka frequency
fingerprint/full September row count, family enrichment pause and any test rows
used by the journey. Normal read-through cache timestamps may advance and must
be reported as such. Navigation may not reduce or cap any list.

## Documentation, handoff and completion

Update Help where named paths or workspace return behavior needs explanation and
add one plain-language About entry for this meaningful release. Update the UX
roadmap, implementation workflow and phase review record. Preserve the unrelated
migration 0049 comment.

Terra Medium owns application changes and focused tests from this specification.
It must not commit, push, deploy, change td state, edit production or expand the
scope. Before handoff it runs focused tests, `npm run check` with zero warnings,
the web/worker build and `git diff --check`, then freezes edits/builds for primary
review. It reports exact files, checks, remaining uncertainty and any real-data
assumptions.

The primary agent owns source review, corrections, realistic browser/data
acceptance, documentation evidence and td review. Phase 5B is complete only when
the implemented routes preserve their real filters/results and all acceptance
checks pass. Commit and deployment require a separate owner instruction.
