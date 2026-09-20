# Phase 7B review: species-page section navigation

September 19, 2026 · td-f09c48 · parent td-8ff597

## Decision

Accepted for production release. The implementation satisfies the frozen Phase
7B work order. The owner authorized release after reviewing this result.

The species header now leads into a compact **On this page** menu derived from
the cards that actually render. Its ordinary fragment links progressively
enhance to reveal a closed disclosure, retain the current query and navigation
state, replace the current fragment without adding history entries, scroll
below the fixed shell and focus the target heading. The migration ribbon's
region action uses the same Best-time path. Content, card order, loaders,
permissions and data are unchanged.

## Independent review

The lower-cost Terra implementer supplied the route, component, helper and
focused-test changes. Primary review traced each render predicate against the
existing markup and compared the helper with `PathNavigation`'s stored state.
One issue was found and corrected: route-owned targets displayed the global
focus treatment, but the Identification heading did not consistently show a
ring after a pointer-initiated jump. Explicit focus styling now covers every
route-owned and child-component target. Help and Version History copy were
also added during primary review.

No remaining blocker or correctness finding was found.

## Automated gates

- Focused route, helper, migration-ribbon, Help, About, media and navigation
  tests: 53 passed.
- `npm run check`: 0 errors and 0 warnings.
- `npm run build`: application, service worker and worker builds passed.
- `git diff --check`: passed.

## Real-data browser acceptance

Chromium and WebKit exercised the production-like test database at 390px and
1280px. Marbled Godwit showed the exact rich menu for both owner and viewer:
Identification, Similar species, Finding this bird, Seasonal distribution,
Best time, Recent reports, About and Learn more. Aguiguan Reed Warbler showed
only Seasonal distribution, Recent reports, Nearest reports, About and Learn
more. Every checked layout had no horizontal overflow or page error.

On the rich owner page, every link retained the complete path and query,
updated the documented fragment, focused the correct heading with a visible
outline and left both `history.length` and the stored history state unchanged.
Closing Similar species and the seasonal chart before using the menu proved
that both reopen. A migration-ribbon region action selected its chart peer,
updated `#best-time` and focused Best time.

A filtered Florida `godwit` Field Guide journey retained `future=kept`. Browser
Back returned directly to the exact URL with the Marbled Godwit row restored in
view; the in-app Field Guide return path restored the same URL and focused row.
With JavaScript disabled in WebKit, the native Seasonal distribution link still
updated the fragment and brought the default-open target into view.

Read-only evidence is retained outside the repository in
`phase07b-acceptance.json` and `phase07b-owner-phone.png`. Acceptance created
temporary test sessions only and submitted no application form or personal
marker change.

## Scope retained

Persistent disclosure preferences remain td-74b012. Geographic selection,
All/Need/Seen scope, trip workflow and other later roadmap work remain outside
Phase 7B.
