# Birds UX phase 6 — independent review

September 19, 2026 · td-f3ccda · Parent td-8ff597

Status: independently accepted. The owner authorized production release after
this review; exact revision and live evidence are recorded in the phase td.

[Detailed specification](phase-06-shell-map-controls.md).

## Delivered behavior

The shared Navigation drawer now remembers whether the desktop hamburger or
phone More button opened it, moves focus to its visible Close menu control,
contains forward and reverse Tab navigation, and closes with Escape, its Close
button or the scrim. The top navigation, page and bottom navigation are inert
while it is modal; page scrolling is locked and restored. Dismissal returns
focus to the exact opener, while route selection lets normal destination
navigation own focus.

Forecast's Pick on map control now identifies a named inline editor. Opening it
focuses `Choose a forecast location` and scrolls that heading below the fixed
navigation. Cancel discards the draft pin and restores the opener without
changing the current Forecast or saved Home. The existing text search, map pin,
geocoding status and `Forecast near …` commit flow remain intact.

The touched shell, Forecast and shared map controls now meet the 48px target;
the shared map search input explicitly renders at 16px in both engines. The trip
planner's shared map toggle also reaches 48px. Help explains the map draft/apply
behavior and About records the visible release change.

## Independent browser verification

| Check | Verified result |
| --- | --- |
| Drawer at 390px | Chromium and WebKit moved focus from More to Close, wrapped Shift+Tab to Sign out and Tab to Close, closed from Escape and scrim, and restored More. Shell regions were inert and body overflow locked only while open. |
| Drawer at 1280px | Both engines repeated containment, dismissal and exact restoration to the desktop Open menu hamburger. |
| Destination selection | Help navigation closed the drawer and did not restore either stale opener; no horizontal overflow or page error occurred. |
| Forecast open/cancel | Both engines focused the named heading around 72px below the top of a 56px fixed nav. Cancel restored Pick on map and retained the URL and Near field. |
| Forecast apply | Real test geocoding resolved `Myakka River State Park, Florida`; applying the result produced the expected `lat`, `lng`, `loc`, `month` and `dist` Forecast URL in both engines. |
| Dark and light themes | Owner dark and family-viewer light sessions passed the affected phone shell and map reveal/cancel checks. |
| Measured controls | Hamburger and drawer Close measured 48x48px. Forecast opener/search/commit/Cancel measured 48–49px high; the WebKit search input computed at 16px. Trip Pick on map measured 48px high. |
| Code checks | 25 focused tests across six files passed; framework check reported zero errors and warnings; production web and worker builds passed; diff whitespace check is clean. |

The executable evidence is in the task's
`work/birds-ux/audit/phase06-browser.mjs`, `phase06-chromium.json` and
`phase06-webkit.json`. Browser sessions were temporary and removed by the
harness. The commit-path check made a normal Forecast read through the isolated
test application and added a Myakka-area hotspot cache entry there; it did not
write production or saved account data.

## Review corrections that mattered

- The first implementation attached `scroll-margin-top` to the editor section
  but invoked `scrollIntoView()` on its child heading. Chromium measured the
  focused heading at approximately y=0, under the fixed 56px navigation. The
  clearance now belongs to the actual heading scroll target and is protected by
  a focused source contract.
- Repeated WebKit dismissal exposed an update-cycle race: the document focus
  guard could still receive the opener's restored `focusin` after `menuOpen`
  became false and redirect it toward the detached drawer. The guard now
  requires the drawer to remain open before containing focus, with regression
  coverage.

## Data and release boundary

The protected Myakka baseline remains 5,657 species/week rows with fingerprint
`abc806f5b000b989e75c31057dedf3e2b63842da97cb5ecd7da17d47f51823e7`,
owner Seen count 227 and family enrichment paused. Test health reports database,
worker and gallery healthy. The unrelated migration 0049 comment remains
outside this phase with its pre-phase patch fingerprint unchanged.

No dependency, schema, server, worker or permission behavior changed. Physical
iPhone/Home Screen verification remains outstanding because browser emulation
is not a physical-device claim. Phase 7 covers compact Field Guide controls and species
section navigation; the parent UX epic remains in progress.
