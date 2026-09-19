# Birds UX phase 1 — independent review record

September 18, 2026 · td-d22017 under td-8ff597

Status: released as `582f665` on September 18, 2026, after independent review and owner authorization.

The primary agent wrote the [implementation specification](phase-01-trip-location-identity.md),
a lower-cost built-in implementer wrote the code, and the primary agent reviewed
the diff and independently exercised the running test app. All review corrections below were addressed before acceptance.

## Delivered behavior observed in test

- The Huguenot needs query retained all 36 reported candidate locations.
- Automatic stops were Huguenot Memorial City Park, Spoonbill Pond and Omni
  Amelia Island Plantation Resort, each independently confirmed in actual
  eBird hotspot-reference cache data. Jax Heights Yard 2 was not preselected.
- Explicitly added the yard, removed it, and added it again. Saved trip 19 and
  reloaded it: original location id, name, coordinates and target notes persisted.
  The yard remained labeled Reported location / hotspot status unverified.
- Existing trip 18 lost the incorrect hotspot badge while retaining the verified
  Huguenot badge/link. The family viewer received the corrected labels too.
- Changing the requested stops from three to four in the current planner page
  reset the curated selection to four verified hotspots; the manually selected
  yard did not leak into the new default route.
- Desktop and 390px layouts had no horizontal overflow; changed Add/Remove
  targets met 48px. Owner acceptance reported no browser script exceptions.

## Review corrections

1. Reuse the single hotspot-reference outcome. The early engine change would
   have left a second lookup in the planner loader, including another live
   attempt after failure. The loader now consumes metadata from the same query.
2. Include query/filter/verification/default selection in curation identity so
   same-route replanning reseeds appropriately.
3. Add location-specific accessible action labels and increase the touched
   Add/Remove targets to 48px.
4. Add a shortage/historical-stop regression in addition to the basic identity,
   failed-reference, stale-reference and batch-cache tests.
5. On phone layouts, move the longer reported-location action below descriptive
   content. The initial no-overflow check passed, but visual review found that
   the side action compressed species names and status text excessively.

## Final verification

| Gate | Result |
| --- | --- |
| Focused Vitest, independently rerun by primary | 14 tests passed across query-engine, query-engine-runtime and hotspots |
| Framework/types, implementer final run | `npm run check`: 0 errors, 0 warnings |
| Build, implementer final run after phone layout fix | `npm run build`: web and worker passed |
| Primary diff review | Identity/data flow, reference-failure handling, one reference outcome, preserved candidates, existing data and authorization inspected; no remaining blocking findings |
| Primary browser/real database | Owner and viewer, default/manual selection, save/reload, legacy trip, and same-route replan passed |
| Final phone visual inspection | Reported-location card uses full-width content with action below; its captured height fell from about 417px to 263px without losing content |
| Test health | Database, worker and gallery source report ok |

The automated command was `npx vitest run src/lib/server/query-engine.test.ts src/lib/server/query-engine-runtime.test.ts src/lib/server/hotspots.test.ts`.
Browser evidence and scripts are retained in the task's `work/birds-ux/audit/phase01-*` files.
Phone checks used Chromium emulation, not a physical iPhone. The final visual
layout was inspected after the CSS correction; earlier behavioral assertions
also ran against actual database-backed pages.

## Boundaries

This phase fixes location identity and automatic selection. It does not fix
All/Need labels, complete ranking evidence or incompatible planned/current
counts (next phase), nor implement the broader navigation redesign. A verified
hotspot is not a guarantee of public access. Missing cache evidence means
unverified; the application does not infer that a location is private.

No production data, schema migration, commit or deployment was involved.
Existing audit data, the prior migration comment and earlier UX documents were
preserved. The isolated test worker and live eBird configuration remain usable.

## Production release verification

Deployed through `scripts/deploy-to-DO.sh`; origin/main and public health both
identify `582f665`. Existing migrations were already applied; web and worker
reloaded online. Database, worker and gallery source report ok.

Authenticated production Chromium smoke retained all 36 candidates, confirmed
the three automatically selected locations against actual hotspot-reference
caches, checked an unverified location without a false hotspot link at 390px,
and opened existing trip 16 with seven stops. No browser script errors. No trip
or list edits were made in production. The unrelated migration 0049 comment
was restored after deployment. td-d22017 is closed.
