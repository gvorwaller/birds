# Phase 9A review: All, Need and Seen

September 20, 2026 · td-f02bf7 · parent td-8ff597

## Decision

Implemented and primary-reviewed against the frozen contract in
`docs/ux/phase-09a-all-need-seen.md`. This review was completed before release;
the owner later authorized a separate Phase 8B follow-up commit, a Phase 9A
commit and production deployment. Phase 9B has not begun. Independent GROK
review is recorded below.

Every Field Guide result list now names its scope. A server-rendered
**All / Need / Seen** link control sits after the Field Guide section tabs and
before the search card. Switching scope keeps text, tags, family, sort,
Special-interest and Phase 8 location or map state, removes only stale `page`,
and lands on `#results`. Every Field Guide result, including geographic results,
uses one shared species-row component.

## Implementation

- **Strict URL contract.** `list=all|need|seen`; absent means All. Blank,
  repeated, unknown or differently cased values return 400. An explicit scope,
  including `list=all`, browses the current taxonomy; a bare `/species` keeps
  the existing prompt.
- **Database scope.** `searchGuide` applies list membership after the common
  candidate filters and before `count(*) OVER()`, ordering, `LIMIT` and
  `OFFSET`. Need is exactly `NOT seen`; Seen is `seen`.
- **Account boundary.** Seen/Need uses `locals.scopeId`, so a linked viewer sees
  the owner's life-list classification. Viewed and Special-interest state keeps
  using the signed-in account id.
- **Candidate integrity.** Retired life-list codes and codes outside the active
  taxonomy/filter/location candidates never enter Seen.
- **State preservation.** Scope links preserve every other known and unknown
  parameter and drop only `page`. Search/filter forms, tag links, pagination,
  clear-location, clear-filters and species detail/return navigation keep the
  scope. Repeated unknown parameters remain repeated.
- **Truthful empty and coverage states.** Empty Need/Seen copy names the scope
  and offers the other scopes without turning a scoped empty result into a claim
  that a place has no birds. Missing historical coverage remains unavailable.
- **Read-only behavior.** List browsing adds no write, queue, refresh or eBird
  path.
- **Shared row.** `src/lib/components/GuideSpeciesRow.svelte` renders thumbnail
  or an honest unavailable state; common and scientific names; Seen/Need then
  Special-interest and Viewed; evidence, family, status, tags and field note;
  stable row target and complete return URL; and photo credit below the row.
- **Documentation.** Help defines the scopes and viewer rule. About v0.1.6
  records the user-visible feature.

## Bounded surface audit

Only the Field Guide adopts this scope and shared row in 9A.

| Surface | State after 9A |
| --- | --- |
| Home | Not adopted; existing rows and wording unchanged. |
| Field Guide | **Adopted**, including Phase 8A location results. |
| Forecast | Not adopted. |
| Hotspot/location detail | Not adopted. |
| Trips | Not adopted. |
| Personal collections | Not adopted. |

The Field Guide has no export today. A future Field Guide export must name and
carry the same scope.

## Measured examples

These are dated test-snapshot examples, not product constants. They were
re-measured after the test-data repair on 2026-09-20 with the owner's 227-species
life list:

| Scope | Florida | Myakka Island Point (L625782) |
| --- | ---: | ---: |
| All | 632 | 108 |
| Need | 439 | 10 |
| Seen | 193 | 98 |

In both places Need plus Seen equals All.

## Verification

Focused Vitest run:

```text
npx vitest run src/lib/guide-list.test.ts src/routes/species/guide-list.test.ts src/routes/species/guide-list-readonly.test.ts
3 files, 29 tests passed, 7.08s
```

The DB tests cover strict parsing and link construction; scope complement and
ordering across text, tag, family, Special-interest, county, hotspot, combined
filters and an antimeridian map circle; all three sorts in a bounded case;
pagination before/after the 100-row boundary; owner/viewer identity; retired and
out-of-candidate codes; strict errors; statement-level read-only SQL; and a
keyed eBird-call guard.

The broader bounded route run passed:

```text
npx vitest run src/lib/guide-list.test.ts src/routes/species src/routes/help src/routes/about src/routes/forecast/data src/routes/hotspots
18 files, 179 tests passed, 11.81s
```

Fresh headless Chromium and WebKit acceptance used the real test owner and an
existing linked viewer. The JavaScript-enabled matrix covered both accounts at
1280px, 390px and 320px (12 engine/account/width combinations); four additional
320px contexts covered both accounts and engines with JavaScript disabled. Both
accounts produced the same complete taxonomy partition:

```text
All 11,167 = Need 10,940 + Seen 227
```

The matrix rechecked exact Florida and Myakka Island Point counts under all
three scopes, active-state semantics, row badges, repeated unknown parameter
preservation and reload, exact page-2 detail/return state and focus target,
search/filter/location changes under a selected scope, a covered empty Need
result, and an uncovered location that says the selected scope is unavailable
instead of claiming zero species. It also verified native server-rendered links
with JavaScript disabled, 48px scope targets, visible focus, and no horizontal
overflow. The 320px engine captures were inspected visually. No page errors
occurred. Before/after snapshots remained exactly Seen 227, Special-interest 0
and Viewed 15; the journey did not leave a data mutation.

Final gates:

- `npm run check`: 0 errors, 0 warnings.
- `npm run build`: passed.
- `git diff --check`: clean.
- Post-test integrity: owner Seen rows 227; throwaway `list-*` users 0; Phase 9A
  `frequency_fetch` fixtures 0; Phase 9A eBird-location fixtures 0.

## Test-data incident and repair

CC1 ran an overly broad shared-database suite while developing 9A. A neighboring
test suite cleared the local test owner's Seen rows, reducing the expected 227
to zero. The local `birds_test` rows for that one owner were restored
transactionally from the production owner's species-code set through a
read-only production connection, then verified at exactly 227. Production was
not written.

CC1's first list test also walked every page of broad filters and took about 98
seconds. It was replaced with stable enriched-taxonomy fixtures, bounded
filter-family cases and one separate three-sort case. The focused 29-test set
now finishes in about seven seconds and cleans up every temporary user and
location row.

The broad `src/lib/server` suite was not rerun because it contains the destructive
shared-owner behavior that caused the incident; it is not a 9A acceptance gate.

## Review status

- Primary review (Codex): found and fixed two P2 contract defects: uncovered
  geography was described as zero Need/Seen, and detail return URLs silently
  lost `#results` because fragments do not reach SSR. The full browser matrix
  passed after both repairs.
- Independent QA (GROK): found P2-1 (Special-interest empty help displaced the
  required Need/Seen recovery) and P3-1 (viewer-false “your life list” control
  titles). Both were fixed. GROK's narrow read/test-only retest closed both and
  passed 2 files / 30 tests. No unresolved P0-P3 finding remains.
