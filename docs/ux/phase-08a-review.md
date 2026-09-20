# Phase 8A review: Field Guide geographic selection

September 20, 2026 · td-82fbc1 · parent td-8ff597

## Decision

Accepted for owner review. The implementation satisfies the frozen Phase 8A
contract in `docs/ux/phase-08a-field-guide-location-contract.md`. It is not
committed, pushed or deployed.

The Field Guide now supports historical location scope by country,
state/region, county or equivalent, one verified eBird hotspot, or an explicit
map point and whole-mile radius. The URL remains the source of truth. Coverage
copy identifies the selected type, loaded source count, year range and
whole-area versus component-only coverage; unavailable coverage is never
presented as zero birds.

## Implementation and primary review

CC1 implemented the frozen work order. Primary review traced the parser,
loaded-location ancestry checks, frequency-source expansion, exact-hotspot
scope, coordinate joins, Haversine radius calculation, pagination intersection,
URL preservation, native forms, map apply/cancel behavior and Help/About copy.

Primary review returned three issues to CC1:

1. The first native form required a no-JavaScript user to clear every stale
   descendant manually. The final form submits the applied hierarchy, detects
   the shallowest changed level, clears descendants and redirects to a clean
   canonical URL while preserving every unrelated parameter.
2. That canonicalizer originally could normalize repeated parameters. It now
   accepts only the exact native-form intent shape and returns 400 for partial
   or repeated intent fields or repeated hierarchy values. Copied malformed,
   mixed and conflicting URLs remain strict 400 responses.
3. Version History said choosing a place “fetches nothing,” although geocoding
   makes requests. It now says no new bird data is fetched from eBird.

No unresolved primary-review correctness finding remains.

## Independent QA

GROK independently reviewed the spec and diff, ran the focused suite and
exercised Chromium and WebKit at phone and desktop widths with owner-dark and
viewer-light accounts. It found no P0, P1 or P2 issue.

GROK found one P3 accessibility issue: while the map chooser was open, both the
species search and place search buttons were named **Search**. CC1 changed the
shared MapPicker button to **Search place**. The longer label exposed a 320px
intrinsic-width overflow, so the picker input can shrink and the Field Guide
chooser grids use `minmax(0, 1fr)`. CC1 then verified unique accessible names
and zero horizontal overflow in Chromium and WebKit at 320, 390 and 1280px,
plus unchanged Forecast, Trips and Settings picker behavior. Primary review
re-ran the directly affected tests and inspected the final CSS and markup.

GROK's full pass preceded that final P3 correction. The post-fix evidence is
from CC1's two-engine rerun and the primary review rather than a second GROK
matrix.

## Acceptance evidence

- United States → Florida → Sarasota County produced 376 species from 210
  loaded sources for 2016–2025 and identified the whole-area source.
- Myakka River SP (`L299291`) produced 244 species from that exact hotspot,
  visibly narrower than its county.
- The recorded Myakka coordinates with a 25-mile radius produced 99 included
  loaded hotspots and 351 species. A Google place result used a different
  centroid and correctly remained a map point rather than assuming hotspot
  identity.
- Native no-JavaScript country, state, county and hotspot changes clear
  incompatible descendants, preserve search/tags/sort and unknown parameters,
  reset page and land at `#results`.
- Clear location preserves unrelated state. Page-two species return restored
  the complete county URL, result row and focus.
- Map opening, Apply and Cancel focus, required explicit radius, shared map URL
  server rendering, mobile map controls and owner/viewer isolation passed.
- The seeded antimeridian test includes a hotspot across 180 degrees at the
  correct distance boundary.
- Test cleanup left owner user 1 at 227 seen species with no Phase 8A fixtures
  or throwaway accounts.

## Automated gates

- CC1 final focused run: 16 files, 172 tests passed.
- GROK independent focused run before the P3 fix: 12 files, 155 tests passed.
- Primary focused parser/loader/UI/Help/About run: 5 files, 100 tests passed.
- Primary final MapPicker/Field Guide UI run: 2 files, 22 tests passed.
- `npm run check`: 0 errors and 0 warnings.
- `npm run build`: application, service worker and worker builds passed.
- `git diff --check`: passed.

The broad suite was not used as the release gate. Its known 10–12 shared-test-
database failures reproduce on the clean baseline and were already accepted as
non-blocking; Phase 8A focused tests and database cleanup are green.

## Scope retained

Phase 8B still owns typed/map discovery on Hotspots & data. Phase 9 owns
All/Need/Seen and recent-versus-historical scope. Phase 10 owns cross-page
location handoff. Phase 8A does not fetch eBird history, start worker jobs,
change Settings/Home location or treat a Google place as a verified hotspot.
