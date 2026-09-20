# Phase 7A independent review

September 19, 2026 · td-b33568 · parent td-8ff597

## Result

Phase 7A satisfies the
[Field Guide search, filters and result meaning specification](phase-07a-field-guide-results.md).
The Field Guide now puts search, current scope and results before the detailed
filter editor; explains direct versus descriptive matches; and retains the full
filter, pagination and return-navigation contracts. This review covers the
uncommitted implementation in the main checkout. It is not a production-release
record.

## Production release

The owner authorized release on September 19, 2026. Commit `1853a8c` was pushed
to `main` and deployed through `scripts/deploy-to-DO.sh`. The remote production
build passed, all 60 migrations were already applied, and PM2 reloaded both
`birds` and `birds-worker` online. Internal and public health returned database,
worker and gallery `ok` with exact version `1853a8c`.

An authenticated, read-only 390px production smoke check returned the exact
seven Florida `godwit` rows and provenance, measured the first row at 806px,
confirmed the collapsed 48px filter summary, retained `future=kept` and the full
Field Guide return URL, and reported no overflow or page errors. Evidence is in
the audit workspace as `phase07a-production.json` and
`phase07a-production-phone.png`. td-b33568 is closed.

The lower-cost implementer completed the code and focused tests. Independent
review returned four defects for correction before acceptance:

1. The first version put the filter disclosure after as many as 100 results.
   It now sits directly between the compact scope summary and result list.
2. Empty results did not provide the `#results` target, and duplicate unknown
   key/value pairs could collide in Svelte keyed loops. Every state now has the
   fragment target and repeated unknown parameters use index-safe keys.
3. The initial compact result still began at 928px for the fixed owner query and
   907px for the taller viewer shell. Removing duplicated range/top-pagination
   text and tightening only the collapsed disclosure spacing moved those values
   to 842px and 899px while retaining the bottom pagination and 48px summary.
4. A focusable results fragment overrode Phase 5B's exact-row restoration. The
   fragment remains scrollable but no longer takes focus; Chromium and WebKit
   now return to `guide-species-blkrai` on Field Guide page 2.

## Data and behavior evidence

The production-like `birds_test` database returned the fixed Florida query with
the same seven rows and order as the pre-change baseline:

1. Bar-tailed Godwit
2. Hudsonian Godwit
3. Marbled Godwit
4. American Barn Owl
5. Red Knot
6. Ruff
7. Willet

The three godwits display **Name or code match**. The remaining four display
**Description or field-note match**. Focused database tests also prove direct
name/code precedence, descriptive provenance, exact banding-code provenance and
null provenance when there is no text query. The SQL still chooses the same
winning tier and sorts by the same rank; only a presentation field is derived
from that tier.

Both native forms, tag links, clear-all links and pagination preserve unknown
query parameters. Search and filter changes omit the old page. The test query
kept `future=kept`; country → region changes kept the filter disclosure open in
the enhanced app. With JavaScript disabled, the native disclosure and search
form remained usable and retained search, country, region, unknown parameter and
fragment state.

## Browser acceptance

Authenticated Chromium and WebKit passed at 390px and desktop width using the
running isolated test app:

| Case | Outcome |
| --- | --- |
| Owner, dark theme, 390px | First row 842px; exact seven rows/provenance; no overflow |
| Viewer, light theme, 390px | First row 899px; exact seven rows/provenance; no overflow |
| Owner, dark theme, desktop | First row 678px; exact seven rows/provenance; no overflow |
| Filters | 48px disclosure and controls; open state survives country/region navigation |
| Native/no JavaScript | Disclosure and search submission work; scope and `future=kept` survive |
| Page 2 return | Exact URL, fragment and `guide-species-blkrai` focus restored in both engines |

No browser acceptance action wrote species, sighting, enrichment or personal
marker data. Generated evidence is retained outside the repository in the UX
audit workspace as `phase07a-{chromium,webkit}-acceptance.json`, screenshots and
`phase07a-navigation.json`.

## Automated gate

- Focused guide, loader, location, taxonomy-reference, special-interest and
  enrichment run: 92 passed, 4 pre-existing broad enrichment timeout failures.
- Isolated Phase 7A search provenance: 2 passed.
- Isolated exact banding-code provenance: 1 passed.
- Phase 7A UI contract: 3 passed.
- `npm run check`: 0 errors and 0 warnings.
- `npm run build`: passed, including `build/worker.js`.
- `git diff --check`: passed.

The four timeout failures are the previously accepted non-blocking DB-suite
condition: terminal resolution, stale-scope, coalesced enrichment and AI retry
tests time out against the restored/active test cluster. The directly affected
search and taxonomy tests pass in isolation, and this phase does not alter those
four enrichment workflows.

## Remaining boundary

Phase 7B still needs its own specification and implementation for navigation
among sections on an individual species page. County, hotspot and map/radius
selection, All/Need/Seen scope and any ranking changes remain later work. No
further Phase 7A work is pending.
