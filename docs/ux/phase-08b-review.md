# Phase 8B review: Hotspots & data geographic discovery

September 20, 2026 · td-687b1c · parent td-8ff597

## Decision

Accepted for owner review. The implementation satisfies the frozen Phase 8B
contract in `docs/ux/phase-08b-hotspots-data-discovery.md`. It is not committed,
pushed or deployed.

Hotspots & data now offers server-rendered typed and map/radius discovery for
reference countries and first-level regions, loaded counties/equivalents and
positively verified eBird hotspots. Failed locations without hotspot evidence
remain visibly **reported location — hotspot status unverified** and open the
existing failed-load recovery row rather than a hotspot presentation. Exact
totals and 50-row pagination replace the prior silent 200-result cap.

## Implementation and primary review

CC1 was the sole implementation writer. The final service uses one local
evidence union and result shape for the page loader and JSON enhancement:

- country and first-level identity comes from reference regions;
- county/equivalent identity comes from exact loaded region rows;
- hotspot identity comes from exact loaded hotspot rows, official cached
  hotspot lists or strict positive official hotspot information;
- `ebird_locations` alone never verifies a hotspot; and
- map results use only coordinate-known verified hotspots within the explicit
  antimeridian-safe great-circle radius.

Primary review found one P1 before independent QA: a hotspot result initially
opened the workspace's default Recent tab, and server-opened inventory sections
could also reach eBird for keyed owners. The corrected implementation opens
hotspot destinations on the local Monthly tab and marks every discovery or
selection URL as a local-only view. Deterministic keyed guards prove that typed,
map, country/region/county and failed-load landings do not call eBird. Explicit
owner actions retain their existing external behavior.

The final direct-ID unverified workspace remains plain and honest: no venue
chips, hotspot link, map/trip/forecast actions, data tabs or automatic recent
request. It retains an owner-only explicit action that verifies eBird hotspot
identity before loading history and does not claim public access.

## Independent QA and fix loop

GROK's first hostile pass found no remaining P0/P1, but returned two P2s:

1. failed evidence-free results still targeted the hotspot workspace rather
   than the failed-load recovery row; and
2. hotspot links revealed inside a selected inventory section still opened the
   live Recent tab.

GROK also identified country-only offline selection, submitted-text display,
visual distinction, unverified venue metadata, notice wording and DB-test skip
coverage gaps. CC1 corrected the full set. During keyed browser retesting CC1
found and fixed an additional hydration path where remembered-open inventory
groups requested hotspot counts after a landing click.

GROK's narrow retest independently re-read the final service, loaders, pages
and tests and closed every finding. It reported no remaining P0, P1, P2 or P3
on the affected surfaces.

## Acceptance evidence

- The current test snapshot contains 2,135 coordinate-known verified hotspot
  candidates. Myakka River SP's recorded point at 25 miles returns 349 verified
  hotspots over seven complete pages, representing Sarasota, Manatee,
  Charlotte and DeSoto counties and Florida. Independent SQL reconciliation
  produced the same 349.
- Exact code/name searches for United States, Florida, Norway, Sarasota and
  Myakka return deterministic typed identities, context, load state and
  evidence.
- Observation-only, name-only and negative official-info rows never enter the
  verified hotspot union. A verified hotspot with a failed load remains
  verified; an evidence-free failed location remains reported/unverified.
- Strict mixed, repeated, malformed and past-end URL states return clear
  400/404 responses. Unknown parameters survive; every result remains reachable
  through exact totals and pagination.
- Named return paths restore the exact typed/map page and row. Country, region
  and county selections open the server-rendered disclosure chain; unloaded
  choices preselect but never submit the existing Load form.
- Keyed browser traps prove discovery, selection and Monthly workspace GETs
  make no eBird requests. SQL capture proves the discovery service sends only
  read queries. Before/after database counts and requested-job ownership show
  no unintended writes or jobs.
- Chromium and WebKit passed owner/viewer, dark/light, JavaScript/no-JavaScript,
  320/390/1280px, real-map, pagination, antimeridian, focus/return and
  unverified-recovery journeys with no page errors or horizontal overflow.

## Automated gates

- CC1 final focused run: 32 files, 336 tests passed, repeated across the
  parallel DB-backed files.
- Primary final core run: 10 files, 100 tests passed.
- GROK narrow independent run: the same 10 files, 100 tests passed.
- `npm run check`: 0 errors and 0 warnings.
- `npm run build`: application, service worker and worker builds passed.
- `git diff --check`: passed.

The broad suite was not run. DB-backed Phase 8B tests now load `.env.test`, pin
the isolated `birds_test` cluster and fail rather than silently skip when it is
unavailable. Test fixtures and throwaway accounts were removed; owner Seen
remains 227.

## Scope retained

Phase 9 still owns All/Need/Seen and recent-versus-historical meaning. Phase 10
still owns cross-page place/scope handoff into Forecast, Home and trips. Phase
8B does not import boundaries, repair region centroids, infer point containment,
invent venue/public-access descriptions, change Home or load bird data merely
because a discovery result was selected.
