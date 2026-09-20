# Phase 7B: species-page section navigation

September 19, 2026 · Parent td-8ff597

## Purpose

A richly populated species page is nearly 10,000 CSS pixels tall on a 390px
viewport. In the copied production data, Marbled Godwit's useful questions begin
far apart: Identification around 1,075px, Finding this bird around 4,427px,
seasonal distribution around 5,473px, Best time around 7,904px, recent reports
around 8,570px and About around 8,759px. The content is valuable and must remain,
but reaching a specific answer currently requires scanning or long scrolling.

Phase 7B adds a compact, data-aware **On this page** menu near the species
header. A menu choice reveals its target when necessary, scrolls it below the
fixed navigation and moves keyboard focus to its heading. It preserves the
species URL and the Phase 5 journey path. It does not change content order,
section defaults, data loading or card persistence.

## Confirmed current contract

- `src/routes/species/[code]/+page.svelte` renders the species heading and all
  main cards. Sections are conditional on real page data.
- `SpeciesMediaCard.svelte` owns Identification and
  `SimilarSpeciesCard.svelte` owns Similar species. Similar species is a native
  disclosure, open by default.
- Seasonal distribution is a native disclosure controlled by
  `ribbonExpanded`, open by default and reset for each species.
- A migration-ribbon region selection creates/selects a Best-time peer after a
  Svelte `tick()`, then currently scrolls the `besth` heading without focusing
  it or updating a stable section fragment.
- Recent reports always has a rendered card; its contents stream. Nearest
  reports renders only for a needed species when the account has an eBird API
  key and saved home. About renders for species-category taxa. Learn more always
  renders.
- `PathNavigation` owns return-trail and exact-origin focus restoration. Section
  navigation must preserve its `history.state` and all query parameters.

## Frozen product behavior

### 1. A compact, accurate menu

Place a visually compact `nav` labelled **On this page** immediately after the
species header and before the first content card. Use ordinary same-page links
with at least 48px tap targets. The menu wraps cleanly at 390px, uses current
theme tokens, has no horizontal overflow and remains legible in owner dark and
viewer light themes.

Only show links for sections that are actually rendered. Use these labels and
stable fragment ids:

| Menu label | Fragment id | Render condition |
| --- | --- | --- |
| Identification | `identification` | The existing Identification card renders |
| Similar species | `similar-species` | The existing Similar species card renders |
| Finding this bird | `finding-this-bird` | Field craft exists |
| Seasonal distribution | `seasonal-distribution` | The migration card or its explicit load-error card renders |
| Best time | `best-time` | A selected forecast peer exists |
| Recent reports | `recent-reports` | Always |
| Nearest reports | `nearest-reports` | The existing nearest-reports card renders |
| About | `about` | The existing About card renders |
| Learn more | `learn-more` | Always |

Do not add menu entries for absent cards, placeholders that do not render, the
attribution footer, Wikipedia subsections, personal photos or the recorded
sighting card. Those remain visible in the existing content order.

### 2. Reveal, scroll and focus

Each target has one unique stable id and a programmatically focusable `h2`.
Selecting a menu item must:

1. open a containing disclosure when the user previously closed it;
2. wait for Svelte layout where opening or creating content changes geometry;
3. scroll the target heading below the fixed navigation, respecting reduced
   motion; and
4. place focus on the target heading without causing a second scroll.

Apply a shared heading class/contract with scroll clearance based on
`var(--nav-h)` plus visible spacing. At phone and desktop widths, the focused
heading must be fully visible below the fixed shell. A visible focus outline is
required; focus cannot land on a surrounding card or disappear into the body.

The Similar species and Seasonal distribution links reveal their native
disclosures after a user closes them. Their existing defaults remain open. No
other cards become collapsible in this phase.

### 3. One deliberate history policy

Section navigation changes only the URL fragment. Preserve pathname, every
query parameter, `returnTo`, `returnLabel`, location/window controls and the
current `history.state` used by `PathNavigation`.

Use `history.replaceState`, not a new history entry, for menu and internal
section jumps. Repeated jumps update the shareable fragment without building a
stack of scroll-only history entries. If the species page was opened from a
Field Guide row, browser Back after several section jumps must return directly
to that Field Guide URL and restore the exact result row.

Do not run a generic hash-focus effect on every load or navigation. It could
steal focus from Phase 5 path restoration. Direct fragment URLs retain native
scroll semantics; enhanced reveal/focus is owned by deliberate section actions.

### 4. Existing seasonal cross-link

Route the migration ribbon's region-row callback through the same Best-time
section helper. It must continue creating/selecting the chart peer, then update
the fragment to `#best-time`, scroll with shell clearance and focus the Best
time heading. Preserve the peer tabs, chart state, chart disclosure state and
all existing forecast links.

### 5. Data, defaults and roles

Keep all existing content, order, streamed loaders, error/empty wording,
permissions, forms, links, charts, media and controls. Do not add data queries,
per-section network requests or a database migration.

Reset any client-only disclosure state when navigating to another species, as
today. Do not store section or disclosure choices in local/session storage.
Persistent open/closed preferences, cross-species memory and broader card
collapse work remain td-74b012.

Viewer accounts receive the same section navigation over the cards they can
already see. The menu must not reveal admin-only controls or change personal
Seen, Viewed or Special-interest state.

Native same-page links remain useful without JavaScript because their fragment
targets exist. Enhanced disclosure reveal and heading focus may depend on
JavaScript; both relevant disclosures are open by default on a fresh native
page.

## Scope exclusions

- No content reordering, deletion, truncation or new section.
- No persistent disclosure preferences or new collapsible cards.
- No Field Guide search/filter changes; Phase 7A is released.
- No county/hotspot/map-radius selector or All/Need/Seen scope.
- No data model, loader, worker, enrichment, ranking or migration change.
- No general site-wide anchor framework unless a tiny tested helper is needed
  to preserve history state and query parameters safely.

## Expected implementation surfaces

- `src/routes/species/[code]/+page.svelte`
- `src/lib/components/SpeciesMediaCard.svelte`
- `src/lib/components/SimilarSpeciesCard.svelte`
- a small route-local or shared section-navigation helper/component if useful
- focused source/pure-helper tests
- Help and About copy for the visible workflow

Avoid changing `+page.server.ts`: the current loader already exposes every
render predicate.

## Automated evidence

Focused tests must cover:

1. exact menu labels/ids and conditional omission for rich and sparse data;
2. unique ids and focusable headings in route-owned and child-component cards;
3. disclosure reveal for Similar species and Seasonal distribution;
4. pathname/query/history-state preservation with fragment replacement;
5. the migration-ribbon callback using the same Best-time reveal/focus helper;
6. reduced-motion behavior and fixed-header scroll clearance; and
7. existing species media, similar-species, ribbon, navigation-context and
   relevant loader tests.

Run `npm run check`, `npm run build` and `git diff --check` after focused tests.

## Real-data acceptance

Use the isolated test app and production-like database in Chromium and WebKit,
at 390px and desktop width.

### Rich page: Marbled Godwit

For owner and viewer sessions, the menu must include Identification, Similar
species, Finding this bird, Seasonal distribution, Best time, Recent reports,
About and Learn more. It must omit Nearest reports because this account already
has Marbled Godwit on the displayed life list.

For every menu entry:

- the fragment becomes the documented id while pathname and query remain byte
  for byte equivalent;
- the corresponding heading receives focus and is visible below the fixed nav;
- no horizontal overflow or page error occurs.

Close Similar species and Seasonal distribution before selecting them, then
prove the menu reopens each disclosure and focuses its heading. Select at least
three sections in succession and prove the browser history length does not grow.

### Sparse page: Aguiguan Reed Warbler

The current test data has no Identification, Similar species, Finding this bird
or Best-time card for `agurew1`. Its menu must omit those links while retaining
Seasonal distribution, Recent reports, Nearest reports, About and Learn more.
The page's existing honest empty/load states remain unchanged.

### Journey and chart regressions

Open Marbled Godwit from a filtered Field Guide URL containing `future=kept`,
select multiple sections, then use browser Back and the in-app return path in
separate runs. Both must restore the exact Field Guide URL and originating row;
section navigation must not create intermediate hash-only stops.

Select a migration-ribbon region row and prove Best time is created/selected as
today, the URL ends in `#best-time`, and the Best time heading receives focus
with fixed-header clearance.

With JavaScript disabled, confirm menu links still scroll to their existing
fragment targets on a fresh page. No acceptance action may submit forms, change
personal markers or write application data.

## Review and handoff

The lower-cost implementer owns code and focused tests from this specification.
The primary agent owns independent diff review, corrections, complete automated
gates and real-data Chromium/WebKit acceptance. Phase 7B moves to review only
after those gates pass. Commit and production deployment require a separate
owner instruction.
