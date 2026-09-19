# Phase 7A: Field Guide search, filters and result meaning

September 19, 2026 · Parent td-8ff597

## Purpose

The Field Guide currently puts every filter control and six tag dimensions above
the answer. On a 390px viewport, a realistic `godwit` search scoped to Florida
does not begin its result list until about 1,527 CSS pixels down the document.
The search also returns both direct name/code matches and matches found only in
enrichment prose or tags, but the page describes the search as name/code-only
and does not explain why those later results appear.

Phase 7A makes the existing search understandable and gets the user to results
quickly. It does not change which species match, their ranking, the page size,
or any species data shown in a result. Phase 7B will address navigation among
sections on an individual species page.

## Confirmed current contract

- `src/routes/species/+page.server.ts` validates the query, interest, family,
  sort, country, region, tags and page; it returns at most 100 results per page
  with the full result count.
- `src/lib/server/species-enrichment.ts::searchGuide` combines taxonomy
  name/code matching with enrichment full-text matching. Relevance order is
  exact species code, banding code, exact common/scientific name, prefix,
  substring, then enrichment text/tag rank. The public result currently drops
  that match provenance.
- `src/routes/species/+page.svelte` exposes search and every filter in one
  always-expanded card, then renders results. Result links preserve the full
  canonical list URL for Phase 5B return navigation.
- Pagination already clones the current query string. Tag-removal links rebuild
  known parameters and currently lose unknown parameters.
- Geographic scope uses frequency coverage. The page's existing reported,
  zero-history and unavailable wording is a data-integrity contract and must be
  retained.

## Frozen product behavior

### 1. A compact answer-first page

Keep the Field Guide heading, introduction and Browse/Viewed/Special-interest
tabs. The search field and Search button remain immediately visible and use a
minimum 48px control height and 16px input text.

Directly below search, show a concise result/scope summary before the detailed
filter editor. It must communicate:

- the result total and displayed range when results exist;
- the search phrase, active geography, family, special-interest constraint,
  non-default sort and active tags, omitting inactive defaults;
- removable active-tag controls and a clear-all action when applicable; and
- an honest empty or inactive state rather than a result count invented from
  defaults.

Results follow the compact summary. At 390px, the first result for the acceptance
query must begin no lower than 900 CSS pixels from the document top. The baseline
is approximately 1,527px. Do not achieve this by deleting result fields or
hiding the active scope.

### 2. Progressive filter disclosure

Move family, sort, special-interest, geography and the six tag dimensions into
one native `<details>` disclosure labelled **Filters and sort**. Its summary is
at least 48px high and includes the number of active filter constraints. Search
text itself is summarized outside the disclosure and does not count as a filter
constraint.

The disclosure is collapsed on initial/direct/reloaded pages. Opening it exposes
all current controls and explanatory geography text. The country-to-region
workflow must remain usable: a same-page country or region auto-submit must not
unexpectedly close an editor the user has opened. Native form/disclosure
behavior must remain usable without client JavaScript; enhancement may preserve
the open state during client navigation.

An explicit Apply filters action submits to the results fragment. Search also
submits to the results fragment. Interim country/region updates may update
results while leaving the editor open. Do not install a global focus effect that
steals focus from Phase 5B's restored result row when returning from a bird.

### 3. Honest search provenance

Extend `GuideResult` with a presentation-safe match provenance. For a non-empty
text query, each returned row must distinguish:

- **Name or code match** for taxonomy species code, banding code, common name or
  scientific name tiers; and
- **Description or field-note match** for enrichment full-text/tag matches.

For searches with no text query, provenance is absent. Preserve the SQL match
set and ordering exactly; derive provenance from the winning tier after the
existing `DISTINCT ON` selection. The existing banding-code line remains.

Explain beside search, in plain language, that it checks common and scientific
names and eBird/banding codes first, and can also find Wikipedia-derived text,
field notes and tags when available. Each queried result displays its provenance
as text, not color alone. Availability varies by species and the UI must not
claim every species has enrichment.

### 4. Query and journey preservation

All search/filter operations own and preserve these parameters as applicable:
`q`, `interest`, `family`, `sort`, `country`, `region`, repeated `tags`, and
`page`. A changed search or filter resets `page` to 1. Pagination behavior and
the 100-row page size remain unchanged.

Unknown query parameters must survive search, filter, tag add/remove and
pagination. Start generated links from the current URL parameters, modify only
owned values, remove `page` when the match set changes, and preserve the
`#results` fragment where it expresses result-list position. Do not recursively
encode return URLs or alter the shared navigation-context contract.

Bird links must continue to capture the complete canonical Field Guide URL.
Returning from a bird on page 2 must restore the exact row and all filters,
including unknown parameters and the fragment.

### 5. Data and role preservation

Retain every existing result element: common/scientific name, species and
banding codes, photos, Seen/Need state, viewed state, special-interest state,
tags and field-craft text. Retain owner save/remove behavior and viewer read-only
behavior. No query may add a silent row cap or reinterpret unavailable
geographic coverage as absence.

Keep current inactive, empty, partial-coverage and unavailable-coverage states.
The page may reword them for clarity only if their factual distinction remains
explicit.

## Scope exclusions

- No county, hotspot or map/radius geography; those remain td-d2bb08 and
  td-1e86c2/later package B.
- No All/Need/Seen list-scope selector.
- No species-detail “On this page” navigation; that is Phase 7B.
- No ranking, tokenization, enrichment-content or result-set change.
- No reduced detail, pagination limit change or database migration.
- No broad visual redesign outside the Field Guide route and directly shared
  helpers needed by it.

## Source and test boundaries

Expected implementation surfaces are:

- `src/routes/species/+page.svelte`
- `src/routes/species/+page.server.ts` only if form/query helpers require it
- `src/lib/server/species-enrichment.ts`
- focused Field Guide and enrichment tests
- Help/About copy only if its current Field Guide explanation becomes false

Extract a small query-parameter helper if that makes unknown-parameter
preservation independently testable. Do not introduce a general navigation
framework in this phase.

Focused automated evidence must cover:

1. a seeded direct name/code result before a seeded descriptive result, with
   the correct provenance on each;
2. banding-code provenance and absent provenance when `q` is blank;
3. no regression in family/geography/tag filters, pagination or complete count;
4. preservation of unknown parameters through search/filter/tag and pagination;
5. accessible disclosure/result labelling and retained 48px/16px controls; and
6. existing Field Guide loader, location, taxonomy-reference, interest and
   enrichment suites relevant to touched behavior.

Run framework checks and a production build after focused tests.

## Real-data acceptance

Use the isolated test application and its production-like data. The fixed
acceptance URL is:

`/species?q=godwit&family=&sort=relevance&country=US&region=US-FL&future=kept#results`

Before implementation it returns exactly seven species in this order:

1. Bar-tailed Godwit (`batgod`)
2. Hudsonian Godwit (`hudgod`)
3. Marbled Godwit (`margod`)
4. American Barn Owl (`brnowl`)
5. Red Knot (`redkno`)
6. Ruff (`ruff`)
7. Willet (`willet1`)

Acceptance requires that same order and total. The three godwits must identify
as name/code matches and the other four as descriptive matches. Verify in both
Chromium and WebKit at 390px and a desktop width:

- first-result position no lower than 900px, no horizontal overflow, readable
  scope/result summary and a collapsed filter editor;
- editor open/close behavior and country/region selection;
- search, tag add/remove, clear, Apply and pagination preserve `future=kept`;
- a page-2 Field Guide → bird → return journey restores the exact row, URL,
  fragment and focus under the existing Phase 5B contract;
- owner dark-theme and viewer light-theme rendering, including viewer read-only
  personal controls; and
- native search/disclosure/filter submission remains usable with JavaScript
  disabled.

No acceptance action should write species, sighting or enrichment data. Personal
marker behavior may be verified only through existing reversible/idempotent test
account actions.

## Review and handoff

The lower-cost implementer owns code and focused tests from this specification.
The primary agent owns independent diff review, corrections, the complete test
and build gate, real-data browser acceptance and the review record. An
implementer completion message is not acceptance. Phase 7A moves to review only
after the measured behavior, exact result contract and Phase 5B regression all
pass. Commit and deployment require a separate owner instruction.
