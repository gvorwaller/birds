# Birds UX phase 5A — shared journey context and trustworthy place links

September 19, 2026 · Parent td-8ff597 · F01/F02
Status: independently accepted and submitted for review — td-ea384e. Not committed/deployed. Phase 4 is production-verified at 05ba3af.

## Scope and delivery split

Phase 5 is split into 5A (shared core plus the reproduced trip/hotspot/bird
journey and place safety) and 5B (adoption across the remaining entry points).
This keeps a new browser-history contract reviewable before every route uses it.
The parent phase is not complete until both slices pass. Do not start 5B, phase 6
or deploy 5A without a separate owner instruction.

Implement 5A fully: account/tab-scoped navigation context, safe nonrecursive
link builders, PathNavigation, trip detail → hotspot → species round trips,
species → hotspot round trips, hotspot tab/month/expansion restoration, and
hotspot → correctly named Forecast or explicit location choice. Preserve
existing legacy returnTo paths and unrelated navigation. No database migration,
new dependencies, upstream calls for navigation, dataset limits, ranking changes,
new global tabs, persistent preference system or drawer redesign.

Primary owns specification, td, source review and live acceptance. The existing
lower-cost implementer owns application code, focused tests, Help/About. No
commit, push, deployment or unrelated migration edits in this phase.

## Confirmed source contracts

- src/lib/return-link.ts currently validates only initial slash and rejects //;
  returnTrail follows one nested species returnTo. Keep compatible labels and
  bounded legacy reading, while rejecting browser-normalized unsafe paths.
- src/routes/trips/[id]/+page.svelte stop links use /hotspots/ID?returnTo=/trips/ID.
  Its header has the real trip name, and stop rows have real database IDs.
- Hotspot recent links retain only /hotspots/ID; monthly links retain tab/month
  but discard trip ancestry. showAllMonthly is local and resets after a return.
  tabHref drops the inactive report window/month. Its Forecast link sends label
  while the Forecast loader reads loc, and missing coordinates send /forecast,
  silently falling back to remembered search or Home.
- Species detail uses safeReturnTo plus a common-name lookup for species parents;
  streamed data and other controls must remain intact. Existing similarReturnTo
  strips nesting; do not regress this or expand its scope casually.
- Forecast reads explicit place, lat/lng/loc and month, then falls back to Home.
  ForecastTabs independently restores remembered searches on bare URLs. A new
  explicit choose-location entry must defeat BOTH fallbacks until an actual
  valid submitted place/pin exists.
- +layout.server.ts exposes the signed-in user (use user.id, not scopeId).
  +layout.svelte already uses afterNavigate for jobsPoll; preserve it.
- Installed SvelteKit exposes goto({state}), page.state, replaceState and
  before/afterNavigate. Use those public APIs; never native history internals.
  Browser Back/Forward must remain owned by SvelteKit.
- Existing tests include return-link, species-context, forecast-restore,
  forecast loader invariants and job polling. Existing taxonomy reveal/focus
  and Field Guide pagination must continue to work.

## Canonical links and trust boundary

Add one pure navigation-context module and focused tests, with a small browser
adapter (runes allowed) and reusable PathNavigation component. File names may
vary, but policy must be testable without a browser/DB.

Canonical content href = validated local pathname + all content query parameters
+ optional safe fragment. Strip only navigation-only keys (returnTo and any new
returnLabel/nav bookkeeping fields). Preserve unknown content keys rather than
silently discarding another feature's state. Remove named action keys when
minting GET destinations. New outgoing fallback links contain exactly one
immediate canonical source; they never wrap the source's existing returnTo.
No recursively growing query strings or trail JSON in URLs.

Validate every URL read from query or storage. Reject external/protocol-relative
URLs, backslashes (including encoded path forms), controls, malformed escapes,
invalid URL normalization and external origins after parsing against a fixed
internal base. Do not double-decode legitimate query content. Bound navigation
metadata size without silently truncating content queries or result data. An
invalid stored node is ignored; unsafe returnTo uses an honest local fallback.
Route authorization still belongs to the server.

Display labels originate from actual loaded trip/hotspot/species data. A bounded
plain-text returnLabel may accompany a newly built fallback so new tabs can name
the source; strip it when constructing canonical sources, never render HTML.
Do not accept a user-supplied label as authorization or verified place identity.
Preserve safe legacy returnTo and returnTrail behavior for unmigrated routes.

## Account/tab navigation state

Use sessionStorage keyed by actual signed-in account ID, containing a versioned
validated map of no more than 100 navigation nodes. This is navigation history,
not a limit on records/results. Each node: opaque ID, canonical href, display
label, optional parent ID, optional origin element ID/focus ID/scroll offset,
and a small validated route-specific UI state (initially hotspot expansion).
Use real generated opaque IDs, not invented bird/place IDs. Drop oldest nodes
safely; missing parents terminate a trail with a clear unavailable-history note.
Validate types/lengths, detect cycles, and bound traversal to stored nodes.

Attach only the current node reference/account identity to namespaced
App.PageState using goto/replaceState; merge existing page.state rather than
clobbering unrelated state. No secrets or server data in history. On sign-out or
account switch, clear active in-memory state and old namespace; reject a page
state node from another account even when its href matches. Refresh and browser
Back/Forward restore the referenced node. Missing/corrupt/blocked storage leaves
ordinary fallback links usable and does not invent older ancestors.

Register only adopted routes for richer ancestry in 5A. Trip detail uses its real
name; hotspot uses its actual name or explicit ID; species uses common name.
Changes to filters/tab/month on the same resource update its current node/content
href instead of creating chains of identical pages. A different species/hotspot
is a distinct node. Plain primary-navigation arrival does not silently inherit
the prior research path. An outgoing adopted link explicitly creates the child
relationship; an ancestor return targets the existing ancestor node, not a new
node pointing back to its child. Deduplicate/cycle-check repeated resource visits.
(Amended 2026-09-24, td-8214cb, Gaylon-approved: a forward link to a detail
resource already on the trail moves it to the end — its earlier step is spliced
out and the following step re-parented — rather than rewinding to it, so Back
always targets the page just left. Only explicit ancestor returns rewind. List
and search pages match only on their exact URL.)

The enhancement must retain a normal fully usable href. Only unmodified primary
clicks to same-tab internal destinations are enhanced. Preserve modifier click,
middle click, target=_blank, download, keyboard activation, native non-JS links,
SvelteKit cancellation and preload behavior. Save origin state before navigation;
create/activate destination state only for the corresponding successful route.
A superseded/rejected navigation must not overwrite the winning route's node.
Do not turn every click or poll invalidation into a new journey node.

## Visible return contract and restoration

PathNavigation shows one prominent 'Back to [source name]' for an explicit
source, plus a compact 'Your path' disclosure when more ancestry exists. Each
step is an ordinary link with a safe immediate fallback and a same-tab enhancement
that restores its existing node. Use accessible semantic nav/disclosure, no
horizontal overflow, >=48px targets, existing theme tokens and text+color.
For direct arrivals without an explicit source, label a contextual destination
('Field guide', 'Trips', or 'Forecast') without pretending it was visited.
If older history is missing/blocked, explain that only the immediate source is
available; do not show invented ancestry. Preserve primary tab highlighting.

Trip → hotspot → Monthly September → expand → bird → return must reopen that
hotspot in September, restore expansion, reveal/focus the selected bird row,
and retain a named return to the trip. The next return reveals the original
trip stop. Use stable row/link IDs derived from real stop/species/report IDs.
IDs must remain unique when multiple reports share a species. Wait for route
content and expansion rendering before focus/scroll; do not race a new navigation,
force focus after the user has moved elsewhere, or hijack browser Back scrolling.
Use header clearance (scroll-margin) and preventScroll focus before deliberate
scrolling. Existing Svelte snapshots are allowed where supported, but the explicit
in-app ancestor return must work as well as browser Back/Forward.

If the origin is no longer in current results, preserve the valid list and show
a concise inline notice. Never change filters/page/month or suppress records to
manufacture the old row. Restore only relevant UI state, not edit drafts or
automatically submitted mutations. Hotspot tab/month/report-window builders keep
all existing content and navigation context without nesting it again.

## Place-to-Forecast safety

Add one tested helper to construct the hotspot place action. With valid finite
range-checked coordinates, pass lat, lng, **loc** (actual place name), month and
canonical immediate return context. Preserve relevant radius/window only where
the destination supports it; do not falsely translate report days into forecast
months or fabricate coordinates. Zero coordinates are valid, empty values are
not. Name-only data cannot establish a place pin.

Without coordinates, replace 'Forecast my needs here' with explanatory text and
an explicit 'Choose location for forecast' link. Use an explicit choose-location
mode (e.g. chooseLocation=1) recognized by both Forecast loader and remembered-
search restore policy. Its first visit must not fetch/forecast saved Home or
restore a remembered pin. Show a blank usable text/place/map choice workflow,
retain hotspot name/return path and month, and require explicit valid selection
or typed-place submission. Merely opening the route or picker must not choose
Home or auto-geocode the hotspot's name. After an explicit valid choice, existing
forecast loading works normally. Wrong/missing pin inputs keep selection mode
honest. Do not implement the general map focus/drawer work deferred to phase 6.

5A adopts PathNavigation in the required Forecast selection/area page as needed
for a named return to the hotspot; the wider species-forecast/county chain is
5B. Existing ordinary Forecast entries and saved-search behavior remain intact.

## Required checks and acceptance

Pure tests: safe path parsing/encoded attacks, legacy labels, all content query
preservation, nonrecursive link length across >=20 hops, stored node validation,
100-node eviction, cycles, stale node refs, account isolation/reset, blocked
storage, same-resource updates and ancestor return semantics. Place builder tests
include valid zero coordinates, invalid/nonfinite/missing values, loc/month and
no-coordinate mode. Actual Forecast loader tests prove selection mode avoids
Home/geocode/analysis until explicit choice; restore-policy tests prove saved
search cannot hijack it. Keep meaningful existing regressions, not assertions
that merely mirror new constants. Use mocked DB/provider boundaries; do not run
broad database fixture writers against the restored test copy.

Primary live acceptance uses existing real trip 9/Myakka L299291, its September
monthly list and a real bird after position 60 when available. Check named
returns, all-row expansion, origin focus, full-list count, URL query, refresh,
Back/Forward, second bird/hotspot hop, new-tab immediate fallback, blocked storage,
account switch and no-coordinate flow. The latter may reversibly remove only
selected real metadata coordinates in the test copy, restoring them in finally;
no synthetic observations. Test WebKit/Chromium at390px plus desktop. Track page
errors, no overflow, target sizes, and no unexpected navigation-triggered provider
calls. No paid AI or production mutations; preserve owner227 and family pause.

Before handoff: run focused tests, npm run check (zero warnings), web/worker
build and diff check. Announce build completion before primary browser acceptance;
freeze application edits/builds during that run. Report paths, executed checks,
limitations and any decisions needed. Primary reviews and returns concrete
corrections; only primary marks td review. Update Help and About in this change.
