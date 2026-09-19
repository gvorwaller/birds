# Birds UX phase 6 — keyboard shell and map reveal

September 19, 2026 · Parent td-8ff597

## Purpose

Phase 6 completes implementation unit D from the first UX release: make the
shared navigation drawer behave as the modal dialog it claims to be, make the
Forecast map editor visibly open where the user can operate it, and normalize
the interactive sizes on the surfaces changed here. This implements F03, the
F09 Forecast case, and the F08 requirements for these touched surfaces.

This phase changes interaction and presentation only. It does not alter route
data, Forecast calculations, map/geocoding requests, trip planning, stored home
location, permissions, navigation destinations, themes, or result scope.

## Verified starting behavior

- `src/routes/+layout.svelte` renders a `role="dialog" aria-modal="true"`
  drawer but leaves focus on the opener. Escape does nothing and Tab can move
  through the obscured page. Both the desktop hamburger and phone More button
  can open it; neither opener is remembered.
- The drawer's hamburger and close controls are 44px square. Shared top links
  have a 44px minimum; drawer links and Sign out already have a 48px minimum.
- Forecast's `Pick on map` toggles an inline `MapPicker` below the complete
  filter form. At 390x900 the newly revealed action was around 1,399px down;
  scroll stayed at zero and focus stayed on the toggle. The expanded editor has
  no heading. Its Cancel button hides the editor without returning focus.
- `MapPicker.svelte` is shared by Forecast, trip planning, and Settings. Its
  search input and button have 48px minimum heights, but the text input has no
  explicit 16px font size. The trip planner's map toggle is only 40px high.
- Opening the Forecast picker instantiates Google Maps and may initialize a pin
  from the current place. It must not navigate, submit filters, or select a new
  forecast merely because the editor opened.

## 1. Navigation drawer contract

### Opening

Use one `openMenu(event)` path for the desktop hamburger and phone More button.
Capture `event.currentTarget` as the exact opener before setting `menuOpen`.
Both controls expose `aria-expanded` and `aria-controls` for the stable drawer
id. Once the drawer is rendered, wait for Svelte DOM settlement and focus its
visible Close menu button. The close button is the first predictable control
at every scroll position and gives an immediate exit.

While open:

- the app's top navigation, main content and bottom navigation are inert;
- document/body scrolling is suppressed without losing the previous inline
  overflow value;
- Tab from the last enabled, visible focusable element wraps to the first;
- Shift+Tab from the first wraps to the last;
- Escape closes from anywhere in the drawer;
- programmatic focus that escapes the dialog is redirected to its first
  focusable element; and
- drawer scrolling remains available in short landscape viewports.

The focusable query must exclude disabled, hidden and negative-tabindex
elements. It must work for the role-specific item sets and Sign out form rather
than depending on a hard-coded first/last link.

### Closing and navigation

Close, scrim and Escape are dismissals. Remove inert/scroll locking, wait for
DOM settlement, then focus the remembered opener if it remains connected.
Clear the remembered opener after restoration.

Selecting a destination closes the drawer without restoring the opener. Let
SvelteKit navigation and the existing navigation-context behavior establish
the destination's normal focus; do not race it by focusing the old button.
The route-change safety effect may still close an open drawer, but must use the
non-restoring route-selection path.

Cleanup all listeners and scroll-lock state if the layout is destroyed while
open. Keep every existing destination, role rule, active state and Home preload
rule unchanged. Do not move Trips into primary navigation or add a primary tab.

## 2. Forecast map editor contract

Replace the inline toggle expression with explicit open and dismiss functions.
The `Pick on map` button exposes `aria-expanded` and `aria-controls` for a stable
editor id.

On open:

1. render the editor;
2. wait for DOM settlement;
3. focus a new programmatic heading, `Choose a forecast location`;
4. bring that heading into view with fixed-header clearance; and
5. retain the current Forecast query and location until the user activates the
   existing `Forecast near …` action.

The heading is a real heading with `tabindex="-1"`; the editor region references
it with `aria-labelledby`. Use `scroll-margin-top` based on the navigation
height rather than a magic page offset. Do not focus the map canvas, search
input, or a disabled action before the user has heard what opened.

Cancel hides the editor, discards the editor's draft pin, and restores focus to
the Pick on map button after DOM settlement. Cancel does not submit, navigate,
change the current forecast, or change saved Home. Activating `Forecast near …`
retains the existing URL construction and navigation behavior; it is a commit,
so it does not restore focus to the old-page opener.

The editor must still offer both text search and map selection. Loading and
geocoding errors remain visible through the existing inline status paths.

## 3. Shared picker and touched control sizing

Apply the repository's measured target to controls changed or directly involved
in these two interactions:

- desktop hamburger and drawer Close are at least 48x48px;
- shared top navigation links/settings retain at least 48px clickable height;
- Forecast Pick on map, picker commit and Cancel controls are at least 48px;
- trip planner Pick on map/Hide map becomes at least 48px because it opens the
  same shared picker;
- `MapPicker` search input and button remain at least 48px, and text inputs use
  an explicit 16px font size so WebKit does not shrink text or zoom; and
- focus-visible treatment remains clearly visible under current theme tokens.

Measure the clickable element, not the glyph. Do not sweep unrelated trip edit,
stop-order, field-tip, Photos, Admin, or Field Guide controls into this phase;
their broader F08 work stays with the phase that changes those surfaces.

## 4. Accessibility and browser requirements

- Keep the drawer's dialog name `Navigation`, modal semantics, scrim label and
  visible Close menu control.
- Inert content must not be keyboard- or pointer-operable while the drawer is
  open. The active dialog and scrim remain operable.
- Do not add `aria-hidden` to an ancestor containing current focus before focus
  moves into the dialog.
- All new ids are stable and unique. No positive tabindex values.
- Focus restoration works from both actual openers at 390px and desktop width.
- Verify both Chromium and WebKit, including native select/input rendering on
  the affected Forecast/picker controls.
- Preserve the fixed phone bottom navigation and safe-area behavior.

## 5. Source boundary

Expected production files:

- `src/routes/+layout.svelte`
- `src/routes/forecast/+page.svelte`
- `src/routes/trips/plan/+page.svelte`
- `src/lib/components/MapPicker.svelte`
- focused helper/test files only if they make the behavior easier to verify
- Help and About only if review finds that the existing map instructions or
  release history no longer describe the visible behavior accurately

No migration, package, server route, database query, credential, worker, or
deployment change is expected. Preserve the unrelated working-tree edit in
`backend/db/migrations/0049_frequency_month_rollup.sql`.

## 6. Focused tests

Add maintainable tests for logic that can regress without visual inspection.
At minimum cover:

- drawer openers carry the dialog relationship and share one opening path;
- Escape and both Tab boundary directions invoke the intended close/wrap
  behavior;
- route selection is distinguishable from dismissal so it cannot restore stale
  opener focus;
- Forecast editor has an associated heading/region and explicit open/cancel
  focus paths; and
- touched control CSS retains 48px targets and the shared picker input retains
  16px text.

Prefer behavior/helper tests where practical. A source-contract test is
acceptable for Svelte wiring that the repository's current unit environment
cannot mount, but browser acceptance remains mandatory and must prove the real
rendered behavior.

Retain existing navigation preload, About-link placement, Forecast, planner,
MapPicker and navigation-context tests.

## 7. Browser acceptance

Run against the isolated test app and copied production data.

### Drawer, Chromium and WebKit

At 390px:

1. focus More and open the drawer;
2. assert focus is the drawer Close menu button and the shell is inert;
3. Shift+Tab from the first focusable wraps to Sign out; Tab wraps back;
4. Escape closes and restores More;
5. reopen, dismiss by scrim, and verify More is restored;
6. reopen and select a real destination, verifying the route changes without
   focus returning to the hidden/stale opener; and
7. assert no horizontal overflow or page error.

At 1280px repeat open, focus containment, Escape and restoration with the
desktop Open menu hamburger. Verify the exact desktop opener receives focus.

### Forecast map, Chromium and WebKit

At 390x900, start at the top of Forecast with a real current location:

1. focus and activate Pick on map;
2. assert the `Choose a forecast location` heading is focused and visible below
   the fixed navigation;
3. assert the URL/current result location has not changed;
4. verify the text-search alternative, map and actions are reachable;
5. Cancel and assert the original button regains focus and no filter/location
   value changed; and
6. reopen, choose a location through a controlled test path, activate Forecast
   near, and verify the existing location query contract still succeeds.

Measure the hamburger, drawer close, Forecast picker controls, trip picker
toggle, and shared picker input/button. Each target listed in section 3 must be
at least 48px high; relevant square controls must also be at least 48px wide;
text inputs must compute to at least 16px.

Repeat the affected shell and Forecast checks in the current default and one
alternate theme. Record physical iPhone/PWA testing as outstanding unless it is
actually performed by the owner; browser emulation is not physical-device
proof.

## 8. Completion gates and ownership

The Terra Medium implementer owns the code and focused tests from this frozen
specification. It must not edit the specification, change td state, commit,
push or deploy. Any ambiguity returns to the primary reviewer.

The primary reviewer owns independent diff review, corrections, full focused
tests, `npm run check`, production web/worker builds, `git diff --check`, real
browser acceptance, protected test-data checks, documentation, and td state.
Phase 6 can move to review only when these pass and the review record states the
remaining physical-device limitation honestly. The parent td-8ff597 stays in
progress because phase 7 and later roadmap work remain.
