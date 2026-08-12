# Forecast UX Suggestions — for Gaylon's review

> Source: CODEX8 post-build review of td-854207 (2026-08-11), part 3 —
> product/UX recommendations, explicitly separated from the correctness
> findings (all of which are already fixed and committed). These require
> product judgment; none are implemented yet. Gaylon: mark each item
> **do / modify / skip**, add notes, and append your own items at the bottom.

Status of the feature as of this doc: Phases 1–3 shipped to the test app
(state month curves, place+month needs forecast, county ranking + hotspot
drill-down + map, data-status page). Deferred already: trips/species-page
integration (`td-ee00e8`).

---

## 1. Make Forecast contextual, not an isolated destination

Prioritize the already-deferred Phase 4 (`td-ee00e8`): from a trip stop and
its dates, open Forecast prefilled with the stop's coordinates and the trip's
month; on a species detail page, show the best-month sparkline and a
"Where should I go?" action. These are the shortest paths from data to an
actual decision.

- [ ] do / modify / skip — notes:

## 2. Merge the two forecast modes into one workspace

One page with two clearly named questions instead of two separate tools:

- **"What can I see?"** = place + month (current `/forecast`)
- **"Where can I find this bird?"** = species + month/region (current `/forecast/species`)

Preserve the selected species/place/month when switching modes. Today the
cross-links restart the other mode from blank.

- [ ] do / modify / skip — notes:

## 3. Deliver value before a full-state batch completes

Don't lead with "Analyze 67 counties (takes minutes)". Options: let the user
pick a single county directly and load just its state/county/top-hotspot
data; or run the first batch of 12 and show useful partial results
immediately with an optional "Continue analyzing all counties". The current
copy is implementation-oriented and intimidating.

- [ ] do / modify / skip — notes:

## 4. Rethink top-6 hotspot selection within a county

Selecting only by highest all-time species count favors famous biodiversity
hotspots and can miss habitat-specialist sites for the target species (a
caracara ranch pasture will lose to a diverse wetland). Use a deterministic
activity/geography mix (as Mode A already does), add an "Analyze 6 more"
expansion, and explain the selection rule in the UI.

- [ ] do / modify / skip — notes:

## 5. Show candidate hotspots on the map before their data loads

The county map currently appears only after barchart data exists. Show all
candidate hotspots as pins immediately (from the official hotspot list),
visually distinguishing loaded vs not-yet-loaded, so the user sees the
geography before deciding what to load.

- [ ] do / modify / skip — notes:

## 6. Turn results into actions

Each ranked county/hotspot row should offer next steps: **Directions**,
**open eBird hotspot page**, **Add to trip**, and **"Forecast my needs
here"** (jump to Mode A centered on that hotspot). Frequency alone is
interesting; a next action makes it useful. (Hotspot rows already have
Map/Directions; the rest are missing.)

- [ ] do / modify / skip — notes:

## 7. Reduce Home density (items from the 7/30 plan, still unbuilt)

- Rename "Rare this week" to "Notable reports — last N days" (current
  heading is false for 1/14/30-day windows).
- Don't show the same species in both Notable and Needs; combine badges or
  collapse the duplicate.
- Add Activity/Nearest sort.
- Show fewer Best Places initially (currently 10) with expansion.
- Move a compact At-a-glance summary near the top.
- Clarify the two search boxes: "Move Home to a new location" vs "Filter
  loaded birds or places" — both currently read as place search.

- [ ] do / modify / skip — notes:

## 8. Compact provenance panel instead of fetch-mechanics copy

A one-line data-status strip in the forecast workspace — e.g.
**"2016–2025 · 43/67 counties · 2 stale · 1 failed"** — with a single
action button. Keep request counts and pacing explanations in Help, not in
primary workflow copy. (The `/forecast/data` page stays as the full
inventory; this is the inline summary.)

- [ ] do / modify / skip — notes:

---

## Gaylon's additions

(Add your own items here after testing.)

-
