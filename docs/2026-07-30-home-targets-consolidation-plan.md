# Home and Targets Consolidation Plan

**Date:** 2026-07-30  
**Status:** Revised after CC6 adversarial review — implementation has not started  
**Task:** `td-b75c51`

## Review Record

CC6 reviewed this plan read-only against `main` at `8f9a150` and returned 25
findings. The revision incorporates the verified blockers and design gaps, notably:

- Settings currently has no saved-radius control; removing the old Home action without
  adding one would regress the most recently shipped feature.
- Home and Targets expose incompatible radius option sets.
- The merged loader must have one complete return shape, including setup/error states.
- Authentication, compatibility redirects, and species return links must preserve the
  full query string.
- Viewer-safe body copy matters in addition to viewer-safe navigation.
- A searched location must remain the species drilldown context instead of silently
  reverting to the saved home.

## Objective

Make the current Targets experience the app's single Home experience:

- retain the stronger Targets place search, notable reports, needs explorer, map,
  species search, and best-places ranking;
- port the useful functionality that exists only on the current Home page;
- remove the duplicate Home/Targets navigation choices;
- make `/` the canonical route while preserving existing `/targets` links;
- avoid database or production-data changes.

This is a route and presentation consolidation, not a redesign of the needs engine.

## Current-State Findings

The two pages share most of their user-facing behavior, but they are not identical.

| Capability        | Current Home (`/`)                      | Current Targets (`/targets`)                  | Decision                    |
| ----------------- | --------------------------------------- | --------------------------------------------- | --------------------------- |
| Default location  | Saved home only                         | Saved home, or arbitrary searched place       | Keep Targets                |
| Recent needs      | Yes                                     | Yes                                           | Keep Targets implementation |
| Notable reports   | No                                      | Yes                                           | Keep Targets                |
| Map               | Needs near home                         | Needs + notable reports around selected place | Keep Targets                |
| Species search    | Needs                                   | Needs + notable reports                       | Keep Targets                |
| Best places       | Top six near home                       | Ranked places around selected location        | Keep Targets                |
| Time window       | 1, 7, 14, or 30 days                    | 1, 7, 14, or 30 days                          | Keep                        |
| Radius            | Saved per-user value, 1–50 km           | Query value, default 50 km                    | Merge behavior              |
| Needs ordering    | Nearest first                           | Activity first                                | Retain Targets default      |
| Life-list summary | Count, sync timestamp, sync-error badge | Not shown                                     | Port to unified Home        |
| Photo summary     | Linked photo count                      | Per-species photo context only                | Port to unified Home        |

The current Home server calls `nearbyNeeds()`. Targets calls `geoTargets()`, which is
the more complete page-view helper: it adds the notable feed while retaining recent
needs, ranked places, hotspot verification, place IDs, photo context, and stale-cache
state. The unified page should use `geoTargets()` only; retaining both computations
would preserve the duplication this change is meant to remove.

## Target User Experience

### Navigation

Primary navigation becomes:

1. Home
2. Trips
3. Photos

Settings remains available in desktop navigation and the drawer for the owner. Help
remains drawer-only. Read-only viewers continue to have no Settings access.

The unified Home uses the house icon and the label **Home**. The top navigation,
phone bottom navigation, and drawer must all derive from explicit primary/menu item
collections rather than `items.slice(0, 4)`. Simply deleting Targets from the current
array would accidentally promote Settings into the primary navigation and expose a
dead Settings link to viewers.

### Unified Home page

The current Targets screen becomes the base. Its page title and heading change from
Targets to Home, with supporting copy such as:

> Find birds you need near home or anywhere you plan to go.

The page retains:

- place search, with the saved home as the default;
- an explicit **Use my home** action after searching elsewhere;
- radius and report-window controls;
- miles/kilometers display toggle;
- map and legend;
- notable reports;
- needs list;
- species search and inline place expansion;
- best-places ranking;
- cached/stale and error states;
- mandatory eBird attribution.

The dedicated missing-API-key setup card from the old Home page also remains. A
missing key must not be collapsed into the generic eBird/geocoding error presentation.

The current Home **At a glance** card is added after the report content and before
the eBird attribution. It shows:

- life-list species count;
- last successful/attempted eBird sync timestamp and sync-error badge;
- linked gaylon.photos photo count and a link to Photos, when the account has a
  gallery.

### Radius semantics

The saved `users.near_me_radius_km` remains meaningful:

- With no `dist` query parameter, the unified Home defaults to the saved radius.
- With a valid integer `dist` from 1 through 50, the explicit value controls only the
  current view.
- With a present but invalid `dist`, the loader falls back to the saved radius rather
  than silently using 50 km.
- A searched place or explicit `dist` parameter changes the current view only.
- This consolidation does not silently overwrite the saved home preference.
- Add the existing saved-radius control to Settings in this change. Settings becomes
  the single explicit persistence surface after the old Home POST action is removed.
- Use the existing `NEAR_ME_RADIUS_OPTIONS_KM` values (`8, 16, 24, 40, 50`) on the
  unified Home and in Settings. Do not retain Targets' incompatible hard-coded
  `10, 25, 50` list.
- Render radius option labels through the selected miles/kilometers unit. The submitted
  values remain integer kilometers.
- Values remain validated by the existing 1–50 km server-boundary rules.

This avoids the current regression where entering Targets always defaults to 50 km,
ignoring the user's saved Near Me radius.

The control must always contain the effective radius. Otherwise a saved 40 km radius
would render with Targets' first 10 km option selected and the next Search would
silently shrink the result area.

### Needs ordering

The initial unified Home retains Targets' activity-first ordering. Current Home's
nearest-first ordering is not silently carried over because that would weaken the
screen the owner explicitly prefers.

An Activity/Nearest sort control is a possible follow-up, described below.

## Route and Compatibility Design

### Canonical route

`/` becomes the canonical unified Home because:

- the brand link already points to `/`;
- login already defaults to `/`;
- the PWA manifest's `start_url` is `/`;
- viewer write-protection redirects to `/`;
- Home is the natural application entry point.

The current Targets page and load logic move into the root route and are merged with
the At-a-glance queries and saved-radius default.

### `/targets` compatibility redirect

`/targets` must remain as a redirect endpoint rather than disappearing:

- redirect with HTTP 303 to `/`;
- preserve all query parameters, including `place`, `dist`, and `back`;
- do not retain a second copy of the page or server loader.

Examples:

- `/targets` → `/`
- `/targets?place=Bar+Harbor%2C+ME&dist=25&back=7`
  → `/?place=Bar+Harbor%2C+ME&dist=25&back=7`

### Species return navigation

Species links already carry `back` and a safe local `returnTo`. Update that contract
so:

- new links originate from the canonical `/` URL with its complete query string;
- legacy `/targets...` return values remain safe and functional;
- the visible return label is **Home**, not Targets or Near Me;
- an absent or rejected `returnTo` falls back directly to `/`, not `/targets`;
- open-redirect protection remains unchanged.

Extract return-link normalization into a pure shared helper with unit tests rather than
leaving the compatibility contract inline in a route loader.

### Authentication return navigation

The authentication hook currently records only the pathname when redirecting a
logged-out user to Login. Change it to preserve `pathname + search`. Without this, a
logged-out `/targets?place=...&dist=...&back=...` bookmark loses its complete context
before the `/targets` compatibility redirect executes.

### Species observation context

Opening a species from a searched location must preserve the selected observation
origin and radius. Today the species page always reloads observations around the saved
home, even when opened from a Targets search elsewhere.

The unified Home species link should carry validated location context (coordinates,
radius, and a display label) in addition to `back` and `returnTo`. The species loader
uses that context when valid and otherwise falls back to the saved home. Parsing and
validation belong in a pure helper with tests; arbitrary URLs must not bypass the
1–50 km radius boundary.

## Server Data Plan

Build one root loader with one complete return shape and no setup-state early return.
It:

1. Resolves the scoped data owner from `locals.scopeId`.
2. Reads saved home coordinates, home label, and `near_me_radius_km`.
3. Parses the selected place, radius, and time window using the explicit
   absent/valid/invalid radius rules above.
4. Uses the saved radius when `dist` is absent or invalid.
5. Geocodes an explicit place, otherwise uses the saved home.
6. Loads gallery context and the eBird API key.
7. Calls `geoTargets()` when location and credentials are available.
8. Loads the At-a-glance state:
   - `seen_species` count;
   - `user_ebird.life_list_synced_at`;
   - `user_ebird.life_list_status`;
   - total linked-photo count from the already-loaded gallery context.
9. Returns the same fields for all setup, geocoding, eBird, stale-cache, and empty
   states. Do not preserve Targets' current early return for `needsLocation`.

Start the user row, gallery context, API-key lookup, At-a-glance reads, and explicit
place geocode concurrently where dependencies allow; do not retain the current serial
user → gallery → key → geocode → eBird chain. No schema changes or migrations are
required.

The old root POST action that persists `near_me_radius_km` is removed only after an
equivalent validated Settings action and control exist.

Use a single explicit life-list count for the At-a-glance card in all states. The
Targets view also carries `seenCount`; do not independently present two values that can
disagree during one render.

## Files Expected to Change

- `src/routes/+page.server.ts` — merged canonical loader; remove obsolete radius action.
- `src/routes/+page.svelte` — Targets-based unified Home UI plus At a glance.
- `src/routes/targets/+page.server.ts` — compatibility redirect preserving the query.
- `src/routes/targets/+page.svelte` — retain a minimal never-reached leaf component
  unless verified SvelteKit client navigation works without it; no duplicate page UI.
- `src/routes/+layout.svelte` — explicit Home/Trips/Photos primary navigation.
- `src/hooks.server.ts` — preserve the complete path and query through Login.
- `src/routes/species/[code]/+page.server.ts` — canonical return labels and compatibility.
- `src/routes/species/[code]/+page.svelte` — render selected-location context when
  applicable.
- `src/routes/settings/+page.server.ts` — validated saved-radius update.
- `src/routes/settings/+page.svelte` — saved-radius control.
- `src/lib/near-me-radius.ts` — shared effective-radius selection if needed.
- `src/lib/server/needs.ts` — remove `nearbyNeeds()` if it has no remaining callers.
- `src/routes/help/+page.svelte` — describe the unified Home experience.
- `README.md` — replace the Near Me/Targets split with unified Home.
- `docs/birds-app-design-V2-Fable-revision-plan.md` — add a dated amendment for the
  new single-Home information architecture.
- `docs/devlog/2026-07-30.md` — implementation and verification record.

Tests may add route-independent helpers if query preservation, default-radius
selection, or return-link normalization would otherwise be difficult to exercise
without brittle route tests.

Historical devlogs and static V2 mockups should not be rewritten as though the prior
design never existed.

## Implementation Sequence

1. Add focused pure helpers/tests for:
   - selected radius: absent, valid, and invalid explicit values versus saved default;
   - radius option/effective-value compatibility;
   - `/targets` query-preserving redirect URL;
   - species return-link label normalization;
   - species location-context parsing and validation.
2. Merge the Targets loader into the root loader and add At-a-glance data.
3. Replace the root Svelte page with the Targets UI, renamed Home, and add the
   summary card, setup card, stale-state badge, and Use my home action.
4. Convert `/targets` into the compatibility redirect.
5. Update navigation using explicit primary and menu item collections.
6. Move saved-radius persistence into Settings, then remove the obsolete root action.
7. Update species return/location context, Login query preservation, and user-facing
   Help/README/design-roadmap copy.
8. Remove route-specific dead code such as `nearbyNeeds()` only after confirming no
   remaining callers.
9. Browser-test all owner/viewer, data, URL, and responsive states.
10. Add the devlog entry, run the full repository gates, and review the complete diff.

Use two review checkpoints: first the route/navigation consolidation, then the
saved-radius and species-context behavior. They may be separate commits if the user
later requests commits, but neither should be deployed independently in a state that
removes radius persistence.

No commit or deployment should occur without an explicit request.

## Verification Matrix

### Data and behavior

- `/` with saved home and no query uses the persisted radius.
- The radius control visibly selects that effective value, including the default
  40 km value.
- An invalid explicit `dist` falls back to the saved value; it never silently becomes
  50 km or the first select option.
- `/` with `place`, `dist`, and `back` loads the selected location and preserves the
  complete query in species return links.
- Notable, needs, map, species search, expanded places, and Best Places still work.
- At a glance shows correct life-list and photo totals and sync state.
- Missing home guides the user to search or Settings.
- Missing API key, failed geocode, eBird error, stale cache, empty needs, and empty
  notable results remain distinct visible states.
- A stale needs list shows a visible cached badge even when there are no notable
  reports.
- Viewer sees the owner's scoped counts and data but no write controls, Settings
  links, or owner-only remediation instructions.
- Viewer may see the owner's last life-list sync timestamp, but not an unactionable
  sync-failure warning.
- A species opened from a searched place loads observations around that searched
  place and radius, not the saved home.

### URLs and navigation

- `/targets` redirects to `/`.
- `/targets?...` preserves every query parameter.
- Cold and client-side navigation to `/targets?...` both redirect correctly.
- A logged-out `/targets?...` deep link survives Login with its query intact.
- A species opened from Home returns to the same filtered Home view.
- A legacy species `returnTo=/targets?...` remains safe and returns successfully.
- Top navigation, drawer, and bottom navigation contain one Home item, Trips, and
  Photos; Settings remains owner-only.
- Brand, login default, and installed PWA start at `/`.

### Responsive and accessibility

- Phone portrait and landscape, tablet, and desktop.
- Map remains contained and does not hijack scrolling.
- Controls meet existing tap-target and input-size rules.
- No horizontal overflow.
- Status remains conveyed by text plus color.
- eBird attribution remains present.

### Automated gates

- focused helper/unit tests;
- `npm test`;
- `npm run check` with zero errors and warnings;
- `npm run build`;
- `npm run lint` when the repository baseline is clean, or targeted Prettier checks
  for every changed file with any unrelated baseline failures recorded;
- `git diff --check`.

Record cold and warm Home load timings at the largest supported 30-day/50-km query.
External eBird latency makes a universal hard threshold inappropriate, but the new
default entry route must not introduce an unexplained serial delay.

## Risks and Mitigations

### Old links lose their context

**Risk:** Removing `/targets` could break bookmarks and species return links.  
**Mitigation:** Keep a query-preserving redirect and test legacy `returnTo` values.

### Navigation array slicing promotes Settings

**Risk:** The existing `slice(0, 4)` logic changes meaning when an item is removed.  
**Mitigation:** Separate primary navigation from owner-only menu items explicitly.

### Saved radius is silently discarded

**Risk:** Using Targets' current hard-coded 50 km default would regress a shipped
per-user preference.  
**Mitigation:** Use `near_me_radius_km` whenever `dist` is absent or invalid, use one
compatible option list, and move the persistence control to Settings before removing
the old action.

### Setup states return incomplete data

**Risk:** Targets currently returns early when no location exists. A naïve merge would
omit At-a-glance and setup fields for a brand-new user.  
**Mitigation:** Return one complete server-data shape for every state and render the
dedicated missing-key/setup guidance explicitly.

### Searched species silently revert to saved home

**Risk:** Species drilldown currently ignores the place selected on Targets and loads
observations around the saved home.  
**Mitigation:** Carry a validated location/radius context to the species route and
test searched-location drilldown end to end.

### Home becomes a heavier initial request

**Risk:** `geoTargets()` fetches both recent and notable observations, while the old
Home page did not fetch notable observations.  
**Mitigation:** Retain existing eBird caching and fail-soft behavior, parallelize
independent loader work, and record cold/warm worst-case timing plus stale-cache
rendering during browser QA.

### Consolidation changes result ordering

**Risk:** Users accustomed to nearest-first Home results will now see activity-first
results.  
**Mitigation:** This is an intentional choice favoring the stronger Targets behavior;
consider an explicit sort control rather than hidden route-dependent ordering.

## Recommended Follow-up Improvements

These should be evaluated after consolidation rather than mixed into the route
migration. The radius/unit compatibility, Use my home action, setup-state
presentation, query preservation, and stale badge are not on this list because the
review established that they are required for a coherent consolidation.

1. **Correct the notable heading.** “Rare this week” is inaccurate when the selected
   window is 1, 14, or 30 days. Prefer “Notable reports” plus the active window.
2. **Deduplicate notable needs.** A species can appear in both the notable and needs
   sections even though the map already suppresses the duplicate need marker.
3. **Add Activity/Nearest sorting.** Preserve Targets' activity-first default while
   making the old Home distance-first view available explicitly.
4. **Preserve failed search text.** If geocoding fails and the loader falls back to
   home, do not replace the user's typed query in the input before they can correct it.
5. **Reconsider Best Places density.** The consolidation changes the Home default from
   six “Best places near you” entries to Targets' ten “Best places for your needs.”
   Retain ten initially, then evaluate whether that makes the default page too long.
6. **Restore count-rich search copy.** The old Home placeholder includes the current
   number of needs; the Targets placeholder does not.

The notable heading and duplicate-species cleanup are small correctness/coherence
improvements. Sorting is a product enhancement and deserves explicit UX review.

## Open Review Questions

1. Should At a glance remain at the bottom, matching the current Home, or become a
   compact summary near the top? This plan keeps it at the bottom for minimal change.
2. Should the `/targets` compatibility redirect ever become permanent? This plan uses
   303 indefinitely: real bookmarks and legacy `returnTo` values make the compatibility
   path long-lived, while a permanent browser/CDN cache buys little.
3. Should family viewers see the owner's last life-list sync timestamp? This plan says
   yes, but hides the owner's sync-error warning and owner-only Settings remediation.
