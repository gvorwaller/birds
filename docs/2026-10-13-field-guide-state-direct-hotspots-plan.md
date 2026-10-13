# td-327dd6 — Field Guide: pick a hotspot recorded directly under a state (no county)

## Context
eBird files some hotspots directly under a state or region with no county. The Field Guide place
contract (Phase 8A) only accepts country → region → **county** → hotspot. So these hotspots:
- can't be picked in the Field Guide Place fields;
- get no "see →" species-list link on Hotspots & data, in discovery results or on their hotspot page.

**Measured on prod (read-only, 2026-10-13):**
- 1,467 of the 7,428 loaded hotspots (20%) have `region_code` = a state code (subnational1).
- They fall in 10 states:
  - RU-MOW 390, IS-8 330, NO-03 275, NO-18 182 (Nordland, the Sandnessjøen area), IS-4 125, RU-MOS 116, SE-F 27, SE-O 12, SE-E 9 — none of these states has any county loaded (in practice eBird has no counties there);
  - US-FL 1: "Everglades NP", in a state whose 67 counties are loaded.
- No hotspot is filed directly under a country (0 rows), so a country-direct hotspot is **out of scope**.

**Outcome:**
- "Country + state + hotspot (no county)" becomes a valid Field Guide place, strictly checked: the
  hotspot's loaded `region_code` must equal that exact state. No county is guessed.
- The place appears in the pickers (with and without JS) and in every "see →" link.
- The search itself needs no change: a hotspot already becomes `GuidePlace {kind:"locations"}`, and
  state coverage already files these hotspots under the state (0083 `study_region_code`).

## Design

### 1. Selection type and parse — `src/lib/guide-location.ts`
- The `GuideLocationSelection` hotspot variant gets `county: string | null`.
- `parseGuideLocation` (:190-197):
  - **Hotspot with a county:** unchanged.
  - **Hotspot with no county:**
    - with a region: accept with `county: null`;
    - with no region: fail with "Choose the state or region before choosing a hotspot." The code
      `L…` reveals no ancestry, so the URL must name the state.
- `guideLocationPairs`: for a no-county hotspot, emit `country, region, hotspot`.
  `guideWasPairs` / `canonicalizeGuideLevelChange` need no logic change: comparison is by position,
  and an empty county is skipped. Tests prove both flows:
  - region page → pick a state-direct hotspot;
  - state-direct hotspot → pick a county, which drops the hotspot.
- `parseGuideChoicesRequest`: a hotspot list's parent may be a **subnational2 county** or a
  **subnational1 region**. Any other shape still fails.
- `guidePlaceListHref(code, parent)` (rename the `county` parameter to `parent`):
  - a subnational2 parent works as today;
  - a subnational1 parent links `country, region, hotspot`;
  - anything else returns null.

### 2. Resolve and choice lists — `src/lib/server/guide-location.ts`
- `resolveGuideLocation`:
  - **No-county hotspot:**
    - skip the county-row check;
    - require a `frequency_fetch` hotspot row with `region_code === selection.region`. The region is
      already checked against the regions reference at :340-353;
    - otherwise return 400 "That hotspot has no loaded data directly under the selected state or
      region.";
    - `ancestry.county = null`; the label stays the hotspot name.
  - **Hotspot with a county:** unchanged. A state-direct hotspot sent with a county still returns 400.
- `guideHotspots(parent)`: the exact `region_code = $1` query already returns state-direct hotspots
  for a state code. Reuse it.
- `guideChoicesFor` (hotspot level): a subnational1 parent is allowed when the region is known (the
  same regions-reference check as resolve) and returns `guideHotspots(region)`.
- `/api/guide-locations` follows automatically. Its "That county has no loaded data" 400 text becomes
  "That place has no loaded data".

### 3. Field Guide page — `src/routes/species/+page.server.ts`, `+page.svelte`, `src/lib/guide-draft.ts`
- **Loader:**
  - `hotspots: county ? guideHotspots(county) : region ? guideHotspots(region) : []`;
  - `ancestry.county` may be null.
- **Rule:** the hotspot field's parent is the county when one is chosen, otherwise the state.
  - **States with no counties** (Norway, Iceland, Moscow): the hotspot field lists the state's hotspots
    once the state is chosen.
  - **Florida-type states:** before a county is chosen, it lists only the hotspots filed under the
    state itself (Everglades NP). Choosing a county switches the field to that county's hotspots.
- **Native and no-JS:**
  - hotspot `disabled={data.hotspots.length === 0}`;
  - option text: "Anywhere in this county", "Anywhere in this state or region", "Choose a county
    first" (when the state has counties and no state-direct hotspots) or "No loaded hotspots".
- **Hydrated:**
  - `PARENT_OF.hotspot` becomes dynamic (county ?? region);
  - choosing a region loads both counties and the region's direct hotspots (two `fetchGuideChoices`
    calls);
  - `disabled`, `disabledText` and `anywhereLabel` follow the same rule as the native select;
  - `adoptNativePlace` carries a no-county hotspot.
- **`guide-draft.ts`:**
  - `withDraftLevel` keeps `{kind:"hotspot", county:null}` when a hotspot is set without a county
    (today it collapses to region);
  - `childLevel(region)` → county, plus hotspot via the region parent;
  - `PlaceChoiceLoader` is keyed by (level, parent), so a region-parent hotspot list doesn't collide
    with a county one.
- **Hint copy:** "No county data is loaded for this state or region…" applies only when the state also
  has no direct hotspots. When it has some: "Hotspots here are recorded under the state itself; eBird
  has no county for them."

### 4. "see →" links
- **Hotspots & data** (`src/routes/forecast/data/+page.svelte`):
  - `dataTable` for `detail.stateHotspots` passes the state code as the parent, so those rows get
    `see →`;
  - the existing notice "recorded under {state}, without a more specific county" stays.
- **Discovery** (`src/lib/server/hub-discovery.ts:57-59, 590-594, 760`):
  - `guideCounty` → `guideParent`: a loaded subnational2 county as today, or the hotspot's
    subnational1 `region_code`;
  - the page caller at :1567 changes to match.
- **Hotspot page** (`src/routes/hotspots/[locId]/+page.server.ts:67-74, 145`):
  - read the hotspot's `region_code` and whether a county row is loaded;
  - the parent is the loaded county (subnational2) or the state (subnational1).

### 5. Spec and Help
- **Phase 8A spec** (`docs/ux/phase-08a-field-guide-location-contract.md`), amended at:
  - :54 (URL shape);
  - :73-74 (clearing);
  - :89-91 (validity: "…belongs to the selected county, or — with no county selected — is recorded
    directly under the selected state or region");
  - :151-152 (the hotspot field's parent).
- **Help** (`src/routes/help/+page.svelte`):
  - Field Guide "Filter by place" (:801-828): add a hotspot recorded directly under a state;
  - Hotspots & data (:396-409): replace "opens only when its county is loaded too" with the new rule;
  - keep the strings `help-route.test.ts` requires.
- **About:** a Version History entry.

## Critical files
- `src/lib/guide-location.ts`, `src/lib/guide-draft.ts`, `src/lib/server/guide-location.ts`
- `src/routes/species/+page.server.ts`, `src/routes/species/+page.svelte`, `src/routes/api/guide-locations/+server.ts`
- `src/routes/forecast/data/+page.svelte`, `src/lib/server/hub-discovery.ts`, `src/routes/hotspots/[locId]/+page.server.ts`
- `docs/ux/phase-08a-field-guide-location-contract.md`, `src/routes/help/+page.svelte`, `src/routes/about/+page.svelte`

## Verification
- **Unit tests:**
  - `guide-location.test.ts`:
    - parse accepts region+hotspot and rejects a bare hotspot;
    - URL pairs;
    - both `was_*` flows;
    - choices-request parents;
    - `guidePlaceListHref` for both parent kinds. This replaces the `("L127348","US-FL") → null`
      assertion with a link and adds a country-parent → null case.
  - `guide-draft.test.ts`: the no-county hotspot draft and the loader key.
- **DB integration** (`guide-geography.test.ts`, own fixtures, exact cleanup): add a state-direct
  hotspot fixture under a no-county test state, and one under `US-FL` with counties. Test:
  - resolve succeeds;
  - search results are that hotspot's species;
  - choice lists at the state and county levels;
  - native `was_*` redirects;
  - 400s for: a county sent with a state-direct hotspot, a county hotspot sent without its county,
    and a hotspot under a different state.
  - The existing "county omitted" and "no county (null region)" 400s stay.
- **Route tests:** `guide-locations.test.ts` (subnational1 parent) and `species-list-links.test.ts`
  (the source assertions flip to "state hotspots link").
- **Gates:** `npm run check`; full suite (known `searchable-select` failure only); CODEX1 hostile
  review (contract change).
- **UI** (Field Guide, Hotspots & data, a hotspot page): AGY or GROK, per the current trial —
  - 5 themes; 320 / 390 / 1200 px; Chromium and WebKit; no-JS parity;
  - an iOS Simulator (Mobile Safari) pass, as the ticket asks;
  - journeys: NO-18 → pick a hotspot → species list; US-FL with no county → Everglades NP → choose a
    county → hotspot cleared.
- **Prod check (read-only) after deploy:** the Hotspots & data NO-18 rows show `see →`, and the link
  opens a Field Guide list.
- Owner go before deploy.

## CODEX1 plan review (2026-10-13): NEEDS CHANGES → dispositions
| Finding | Disposition |
|---|---|
| P1 Clearing the county must reload the state's own hotspots (draft levels are `""`, so `county \|\| region`, not `??`) | Fixed: `hotspotParent(levels) = county \|\| region`; after every choice, each list below the change is emptied and refilled from its current parent; tests: county URL → clear county → state hotspots without Apply, then county → clear again (memo) |
| P1 Picking a hotspot invalidates the loader and abandons a sibling county load still in flight | Fixed: `PlaceListsController.afterChoice` refills **every** empty list whose parent is chosen (memo hits are instant, empty ones included); test: state hotspots known, counties loading, pick Everglades → counties re-requested and filled |
| P2 One `loadingLevel`/`choiceError` for two lists | Fixed: per-list `loading` and `errors`, per-list Retry; lists fill one request at a time; one failing does not stop the next; tests: county fails/hotspots load/retry counties; both fail/retry one keeps the other's error; country switch mid-load drops stale results |
| Spec appendix (draft picker / API) | Updated (API parent rule; "Two lists per state") |

Implementation notes: the cascade moved from the page into `PlaceListsController` (`src/lib/guide-draft.ts`) so it is unit-tested; the page passes its reactive state through get/set. Shared `guideHotspotParent(regionCode, countyLoaded)` (`src/lib/guide-location.ts`) decides the link parent for discovery and the hotspot page; Hotspots & data passes the state group's code to its state-hotspot table (country groups pass none → no link).
