# Birds UX release 1: reliable movement and visible answers

September 18, 2026 · Implementation specification proposal · Anchor: td-8ff597

## User-visible result

A person can move from a filtered list into a bird, forecast, county or hotspot, and return to the named place they came from without rebuilding their search. A “here” action always refers to its displayed place. Field Guide answers and species-page sections become easier to reach. Navigation and common controls behave consistently with touch and keyboard.

This implements the first slice of the [roadmap](2026-09-18-birds-ux-roadmap.md), informed by the [browser review](2026-09-18-birds-ux-review.md). It does not expand the dataset, change Seen/Need membership, introduce a new theme, redesign primary navigation, or implement county/hotspot/radius filtering yet. Those remain later roadmap work.

## Prerequisite: trustworthy live-data meaning

The repaired test environment exposed additional correctness issues (review F12–F15). Address these as a small linked prerequisite, keeping the navigation work below as its own reviewable slice:

1. Verify hotspot identity before automatically selecting or badging a planner stop. Preserve non-hotspot reports for exploration and explicit manual selection, with access status stated honestly.
2. Propagate All/Need labels through planner controls, preview and saved target metadata. Store the report source, selected window, place/radius scope and capture time needed to interpret a saved count. Do not compare a 30-day location count with a 14-day surrounding-area count as a trend.
3. Define ranking completeness. The area recent feed contains latest species locations, not full per-hotspot inventories. Use it as an explicitly labeled preview; obtain suitable comparable evidence before claiming complete hotspot ranking. Keep every matching result reachable and disclose unfinished/partial coverage.
4. For Home/Nearest, show window, source and provisional status, deduplicate repeated upstream observations, and merge compatible known recent reports. Provide a distinct route to the owner's recorded sighting when public recent feeds omit it. Do not manufacture a complete personal checklist history from a life list.
5. Resolve missing hotspot metadata for an explicit load request, or provide direct recovery; distinguish paused enrichment from runnable eBird work in queue status.

Verification uses the live examples in the revised review: Huguenot versus Jax Heights Yard 2, All-species stop labels, Huguenot's 10 planner species versus 73 hotspot-feed species, the incompatible four-versus-29 saved count, the own Short-tailed Hawk record, nearby notable versus Nearest Nashville Warbler, and Celery Fields' initial metadata-cache rejection. Production schemas and code changes must follow the usual migration, test and release process when this prerequisite is implemented; this document does not claim those fixes exist.

## 1. Navigation context

### Visible contract

- Each detail or drill-down page has one prominent **Back to [actual destination name]** action. Examples: “Back to Myakka River SP”, “Back to Myakka River state park”, “Back to Field Guide results”, and “Back to Photos”. Avoid generic “Back” when the destination can be named.
- Show a compact “Your path” disclosure for the full available ancestry. On desktop, short paths may be inline; on a phone, the immediate return remains visible and older steps expand. Every step is an ordinary usable link.
- Preserve the canonical location, month/report window, query, filters, sort, result page, tab, expanded result list, and origin row. Navigating through another bird does not discard the trip or original list.
- Distinguish the navigation path from the app's permanent sections. Do not falsely highlight Field Guide just because a bird opened from a trip.
- On direct arrivals with no prior path, provide an honest contextual destination such as Field Guide or the named hotspot. Do not invent a visited ancestor or label a fallback as the previous page.

### State design

Create a shared navigation-context helper and a small PathNavigation component rather than adding another ad hoc `returnTo` variant to each route.

Use canonical query parameters for shareable content state. Preserve the existing safe local `returnTo` contract for compatibility and the immediate fallback. New links should strip nested navigation-only fields from that fallback, so URL size does not double with each hop.

Store the richer trail per signed-in viewer and browser tab in `sessionStorage`, referenced through SvelteKit's public page/history state API. Proposed node fields: opaque id, canonical local href, display label, parent id, origin item id, scroll position, focused control id, and local disclosure/expanded-list state. Treat every stored field as untrusted and validate it before use. Use an account-key namespace; clear it on sign-out/account changes.

Retain the most recent 100 navigation nodes per account/tab. This bounds UI history, not bird results. If a referenced older node has expired or storage is blocked, the visible immediate URL fallback still works; explain when older path history is unavailable. Never use the history limit to reduce search data. Standard new-tab/share navigation must carry the destination's full content query plus an immediate fallback, without requiring storage from another tab.

Use ordinary links and supported SvelteKit navigation hooks; preserve modifier-click/new-tab behavior. Do not overwrite SvelteKit's internal history fields or replace browser Back handling. Filters and month changes update the current journey context rather than generating a misleading chain of identical pages. Refresh and browser Back/Forward must be tested alongside in-app navigation.

On a return, load the canonical query first, restore any necessary list expansion, then reveal the origin row. Prefer a stable species/stop/location identifier over a raw pixel offset. If the item no longer matches, retain the valid list and explain that the item is no longer in its results. Restore focus without letting a sticky header obscure the row. Do not silently reset to page one when a valid later page exists.

### Required integrations

1. Field Guide, Taxonomy, Viewed species and Special interest → bird → subsequent pages.
2. Photos and Life list → bird → origin group/row.
3. Trip → hotspot → monthly/recent bird → hotspot → trip.
4. Bird → species forecast → county → hotspot → bird.
5. Forecast month/country/county changes and show-more actions preserve ancestry.
6. Home/Nearest/Alerts species links participate in the same helper, with meaningful recent-window/radius context where currently supported.

Keep existing taxonomy focus behavior and regression coverage. Add ancestry without rebuilding its tree. Validate parent links as local routes; reject protocol-relative, external, malformed or control-character-bearing inputs. Server authorization remains authoritative for every destination.

## 2. Place actions must keep their promise

Centralize construction of place-to-Forecast links so `lat`, `lng`, `loc`, month and return context agree with the loader's actual contract. Keep the named hotspot identity available even when its coordinates are missing.

- With valid coordinates: open the correct named place and preserve the current month where applicable.
- Without coordinates: replace the active “Forecast my needs here” action with a visible explanation and an explicit **Choose location for forecast** action. That action must require a choice and must not pre-submit Home. Continue exposing the hotspot's already-loaded monthly data.
- Never infer coordinates from a name alone without a visible resolved choice; do not use the user's Home as a silent substitute.
- The map picker is a disclosure/editor: opening it reveals its heading, moves focus and scrolls it into view; Cancel restores focus to its opener and leaves the existing selection unchanged. Selecting/submitting a place remains explicit. Preserve typed search as an alternative to map interaction.

No new eBird or AI request should be triggered just to render return navigation or reveal a picker.

## 3. Field Guide: results before the full filter editor

Retain the existing search algorithm, filters, pagination and accessible result rows.

Proposed layout: heading and one concise explanation → existing section tabs → search field/action → scope summary and **Filters (n)** disclosure → result count/pagination → results. The full filter editor contains existing family, sort, country/state, Special interest and tag controls. Existing filters remain editable; their active values remain visible as removable summary chips even when the editor is closed.

On initial phone arrivals, the filter editor is collapsed; if validation requires a correction, it opens and focuses the relevant control. A user opening it keeps it open while changing dependent country/state fields. Preserve current immediate-versus-submit behavior in this release; avoid mixing an unsaved “Apply” draft into existing auto-submitting controls. Announce the resulting count after updates. Changing a filter intentionally resets pagination to page one; returning from detail restores the prior result page.

Search copy must acknowledge names, codes, descriptive text and traits. Expose match provenance already available inside the search query: name/code versus descriptive text/tags. Give descriptive matches a short “Matches description or traits” cue. Do not remove them or alter rank/count semantics to make the list look simpler. Any extra result field must be returned in the same query/batch, not by fetching each row separately.

Acceptance layout target: with the reviewed “godwit + Florida” search and the editor collapsed, the result count and first result name are visible within the initial 390×844 viewport above the bottom bar. Treat this as a layout test, not permission to truncate explanatory data or names; narrow widths/text enlargement may flow naturally. Keep full accessible labels, coverage text and a route to every matching result.

Clear actions must state their scope: clear search text, remove one filter, or clear all filters. Removing country also removes its state; removing a tag leaves the other criteria intact. Do not clear Special interest or change the viewer's personal list as a side effect of editing search filters.

## 4. Species section navigation

Add **On this page** near the species header, before long content. Its options reflect sections actually rendered: Identification, Similar species, Finding this bird, Seasonal distribution, Best time, Recent reports, Nearest reports, About, and Learn more. Use stable section ids.

Selecting a section expands any containing disclosure, waits for layout, scrolls with header clearance, and places focus on its heading. Preserve the species URL's location/window/return context; a hash change must not erase it. Browser Back should not become an endless series of accidental scroll-history entries: use one deliberate section navigation policy and test it.

Keep the current content order and defaults in this release. Persistent card preferences, SSR behavior and cross-species memory remain td-74b012's later scope. Cross-links already present in the ribbon and seasonal chart must use the same reveal-before-scroll helper.

## 5. Shared controls and drawer behavior

Use current theme tokens and scoped component styles. Normalize touched buttons/selects/disclosures to at least 48px clickable targets; inputs/selects use at least 16px text. Address the observed WebKit select sizing explicitly rather than assuming Chromium proves Safari behavior. Keep badge text plus color and the existing inline feedback pattern.

The Navigation drawer must focus its first meaningful control on open, keep keyboard focus within it while modal, make the obscured page inert, close with Escape/close/scrim, and restore the actual opener on dismiss. On route selection, follow normal route heading focus. Support both desktop hamburger and mobile More; do not move Trips or add more primary tabs in this release.

Standardize only the page-heading/return-action/section-navigation areas touched here and the measured undersized controls. Preserve specialized charts, maps, lists and trip cards instead of forcing them into one generic layout. Verify current themes' affected contrast values against the repository requirement.

## 6. Implementation units and dependencies

| Unit | Concrete work | Verification |
| --- | --- | --- |
| A — Context core | Navigation node schema, validation, canonical href/label helpers, storage lifecycle and PathNavigation. Preserve legacy links. | Pure tests for unsafe paths, Unicode labels, account separation, missing/expired storage, loops and bounded history; no browser required for pure policy. |
| B — Route adoption and place safety | Migrate required caller links, county/month/show-more builders, Photos, trip/hotspot chains, and coordinate guards. | Real route/browser journeys with loaded test DB; direct URLs and no-coordinate cases. |
| C — Results and section access | Compact Field Guide editor, scope chips, match provenance and count focus; species section menu/reveal helper. | Same result set/count/order before/after; real DB search; phone layout, pagination, taxonomy and ribbon regressions. |
| D — Shell and controls | Drawer keyboard behavior, control sizes and map-editor focus. | Keyboard, touch emulation, WebKit/Chromium, affected themes and physical iPhone/PWA follow-through. |
| E — Documentation/release evidence | Help instructions and About note; before/after screenshots; exact checks and remaining limits. | Type/framework check, production build, focused tests and changed-journey smoke. Commit/deploy only on owner instruction. |

Units A and B define correctness before C's presentation work. This is a focused slice of td-8ff597; do not close the umbrella while its broader location/list requirements remain. Create linked implementation children when work starts, rather than duplicating the entire backlog now.

## 7. Release acceptance matrix

| Scenario | Required result |
| --- | --- |
| Trip → Myakka hotspot → September bird → return twice | Named hotspot and trip remain reachable; September, list expansion and originating row survive. |
| Filtered Field Guide page 2 → bird → forecast → county → hotspot → bird | Original criteria/page remain available in the path; successive URLs do not grow recursively. |
| Photos / Life list → bird → return | Return to the named source and original group/row, not Home. |
| Family taxonomy link and return | Matching bird is revealed/scrolled/focused; the entry path is preserved. |
| Missing hotspot coordinates | No Home substitution; visible location-choice recovery; historical results still readable. |
| Map picker open/cancel | Editor comes into view and receives focus; cancelling preserves selection and restores opener. |
| Keyboard drawer | Focus enters/stays within it; Escape closes; opener receives focus; route selection remains accessible. |
| Refresh, browser Back/Forward, direct/new-tab link, blocked storage | Correct shareable query remains; honest immediate fallback; no fabricated ancestry or loops. |
| Account switch and read-only/no-key accounts | No trail/preference leakage or unauthorized actions; available stored data remains usable. |
| “godwit + Florida” search | Same seven snapshot results and ranking; provenance explained; results reached earlier; existing pagination retained. |
| Myakka monthly expansion | All 110 snapshot species still reachable; no data reduction. |
| Long species section links | Closed targets reveal, heading remains unobscured, keyboard focus is meaningful, chart interactions still work. |

Run the relevant DB suites against the isolated test database. Address interference from known test-isolation tickets if it affects these gates; do not label a mocked query test as DB coverage. Working credentials and the dedicated test worker are now available. Baseline live Home, Nearest, Forecast, planner/save, account sync and historical refresh/load journeys have been exercised; repeat them against the changed code and assert corrected semantics, not merely HTTP success. Keep physical-device checks explicit and outstanding until performed.

## Ready-for-review artifacts

The accompanying HTML concept shows the proposed compact Field Guide, a species section menu, and a named trip/hotspot return path. It uses the reviewed test examples and clearly labels placeholder image areas; it does not connect to or modify the app. The concept is for judging hierarchy and behavior, not approving a new theme or claiming implemented functionality.

Before implementation, review the visible contract and mockup together. Subsequent implementation should preserve this first release's scope; county/hotspot/radius filtering and All / Need / Seen remain the next release, informed by the same shared patterns.
