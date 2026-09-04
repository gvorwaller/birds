# UX & Birder Experience Analysis: "Where It Is Through the Year" (Migration Ribbon)

**Date:** 2026-09-04  
**Author:** AGY  
**Context:** Feature review of `td-59c2d0` ("Visual species location map") / `MigrationRibbon.svelte`  
**Reference Case:** Baltimore Oriole (`balori`) on Eastern North America (`NAE`)  

---

## Executive Summary

The backend foundation for the migration ribbon (`0050_species_band_rollup` maintaining 18 latitude bands across 8 continental columns with decoupled equal-weight and checklist-weighted aggregates) is mechanically sound and fast.

However, the current user interface presents a **"Spreadsheet Problem"**: it delivers raw mathematical and statistical coordinates (degrees of latitude, sampling weights, hatched sample-size indicators) that force birders to perform mental arithmetic instead of intuitively understanding a species' annual cycle and migratory journey.

By aligning the UI with how birders actually think—in terms of **biological seasons**, **geographic landmarks**, and **clear arrival/departure dynamics**—we can transform this complex technical widget into one of the most educational, delightful, and distinctive features in the app.

---

## 1. The Core Disconnect: Birder Mental Model vs. Current UI

When an avid birder looks at a species to understand its distribution throughout the year, their brain instinctively processes three primary questions:

1. **Where does it spend the summer (Breeding) vs. winter (Non-breeding)?**
2. **When does it arrive and depart from my region?** (Passage / peak migration dates)
3. **What is its migratory strategy?** (Neotropical long-distance migrant, short-distance migrant, or year-round resident?)

### The Friction in the Current Presentation

| Current UI Paradigm | The Birder's Friction |
| :--- | :--- |
| **Abstract Degrees (`40–50°N`)** | Degrees of latitude do not exist on field maps. In Eastern North America, `40–50°N` spans from Philadelphia and Columbus up past Toronto into rural Ontario and Newfoundland. `10–20°N` is Central America. Users have to decode coordinates into geography. |
| **Poles-to-Equator Matrix Waste** | For a temperate songbird like Baltimore Oriole, rows `60–90°N` (Arctic ice and tundra) and `0–90°S` (Southern Hemisphere) are completely empty, yet they consume more than 50% of the vertical space with diagonal slashes and hatched green stripes. |
| **The "Diagonal Sweep" Rule** | The UI caption explicitly tells the user: *"North at the top, so a diagonal sweep means the bird moves with the seasons and a flat band means it stays put."* If a data visualization requires a 3-sentence instruction manual to explain that a diagonal line means movement, the visual metaphor is working against human intuition. |
| **Control Clutter (5 Competing Dials)** | The user is greeted by: Month slider `< [slider] >`, `► Play the year`, a floating stats card, `World` vs. `By continent` toggle, `Continent` dropdown, and `Equal weight` vs. `By checklists` toggle. Methodological details like checklist weighting belong in footnotes, not primary UI chrome. |
| **Static Cursor Animation** | The 12 months are already displayed across the X-axis. Scrubbing the slider or pressing "Play the year" simply moves a rectangular highlight box over static tiles. It animates a cursor, not the actual migration of the bird. |

---

## 2. Six High-Impact UX & UI Recommendations

### Recommendation 1: Natural-Language Migration Summary Header (The "TL;DR")
Before the user even looks at a chart, provide an auto-generated, human-readable takeaway summarizing the bird's annual status:

> 🧭 **Neotropical Migrant**  
> **Breeds:** Eastern & Central US / Southern Canada (May – July)  
> **Winters:** Central America, Caribbean & S. Florida (October – March)  
> **Migration Windows:** Spring arrival **late April** · Fall departure **late August / September**

*Impact:* Instantly answers the user's primary question within 2 seconds. The visualization below then serves as rich visual validation rather than an ambiguous puzzle.

---

### Recommendation 2: Geographic Landmark Anchoring on the Y-Axis
Bridge the gap between raw coordinates and real-world birding terrain by pairing latitude bands with recognizable geographic landmarks for the active continent:

- **50–60°N** · *Boreal Forest & S. Canada*
- **40–50°N** · *Great Lakes & New England*
- **30–40°N** · *Mid-Atlantic, Midwest & Appalachia*
- **20–30°N** · *Gulf Coast, Florida & N. Mexico*
- **10–20°N** · *Central America & Caribbean*
- **0–10°N** · *Northern South America*

*Impact:* Eliminates mental latitude conversion. When the color brightens at *Great Lakes & New England* in May, birders immediately understand what that means.

---

### Recommendation 3: Range-Based Dynamic Latitude Cropping
- Automatically crop the Y-axis to the species' documented range (+1 buffer band).
- For a Baltimore Oriole in North America, render only `10°N` through `60°N`.
- Omit the distracting Arctic bands (`60–90°N`) and Southern Hemisphere bands unless the user explicitly toggles `[ Show entire globe ]`.

*Impact:* Cleans out visual hazard lines (hatched empty samples) and gives the actual distribution data 2x to 3x more vertical breathing room and resolution.

---

### Recommendation 4: Biological Season Ribbon along the Timeline
Replace or augment the bare month letters `J F M A M J J A S O N D` with a clear, color-coded seasonal phase indicator:

```
+---------------------------------------------------------------------------------------+
|  [ WINTER / NON-BREEDING ]  | [SPRING PASSAGE] |  [ BREEDING ]  | [FALL] | [ WINTER ] |
|   Jan   Feb   Mar   Apr     |     May          |   Jun   Jul    |  Aug   |  Sep..Dec  |
+---------------------------------------------------------------------------------------+
```

*Impact:* Grounds the timeline in the bird's annual biological cycle, clarifying *why* densities surge and drop across specific months.

---

### Recommendation 5: Streamline Analytical Controls
- **Retire the top-level Average toggle (`Equal weight` vs. `By checklists`):** Default to Equal Weight (which best models geographic presence without bias from over-birded metropolitan areas). Move the toggle into the expandable *"How these numbers are calculated"* drawer.
- **Single Segmented View Control:** Consolidate `World` vs. `Continent` and continent selection into a clean pill selector:
  `[ Eastern N. America (Default) ]  [ Western N. America ]  [ World Overview ]`
- **Integrate the Inspector Panel:** Replace the detached floating stats card with an integrated status strip directly under the chart:
  > **July at 40–50°N (Great Lakes & New England):**  
  > Reported on **9%** of checklists · Core breeding territory  
  > *Top regions: Maryland (24%), Pennsylvania (21%), Ontario (18%), New York (17%)*  
  > **[ View all 19 regions in Best Time of Year ↓ ]**

---

### Recommendation 6: Dual Mode Visualization — "Flow View" & "Grid View"
Provide two complementary views:

1. **Flow View (Default):** A continuous, contoured latitudinal density ribbon or distribution wave showing the population's center of gravity surging northward in spring and receding southward in fall. Pair this with a subtle continent silhouette that highlights the active zone as the month slider is moved.
2. **Grid View:** The refined heatmap matrix for power users wanting discrete percentage buckets and cell-by-cell regional drills.

---

## 3. Visual Wireframe of the Redesigned Card

```
+---------------------------------------------------------------------------------------------------+
| WHERE IT IS THROUGH THE YEAR                                                                      |
|                                                                                                   |
| 🧭 Neotropical Migrant                                                                            |
| Breeds: Eastern US & S. Canada (May–Aug) · Winters: Central America (Oct–Mar)                    |
| Peak Spring Arrival: Late April / Early May · Peak Fall Departure: Late August                    |
|                                                                                                   |
| View: [ Eastern North America ▾ ]                          Mode: (•) Flow Ribbon   ( ) Data Grid  |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|             [  WINTER  ]          [SPRING]        [  BREEDING  ]       [ FALL ]      [  WINTER  ] |
|             Jan  Feb  Mar         Apr  May        Jun       Jul        Aug  Sep      Oct  Nov  Dec|
|                                                                                                   |
| 50–60°N     ·    ·    ·           ·    ·          ░░        ░░         ░    ·        ·    ·    ·  |
| (S. Canada)                                                                                       |
|                                                                                                   |
| 40–50°N     ·    ·    ·           ░    ████       ██████    ██████     ██   ░        ·    ·    ·  |
| (New Eng / Great Lakes)                                                                           |
|                                                                                                   |
| 30–40°N     ·    ·    ·           ██   ████       ████      ████       ██   ░        ·    ·    ·  |
| (Mid-Atlantic / Midwest)                                                                          |
|                                                                                                   |
| 20–30°N     ░    ░    ░           ██   ░          ·         ·          ░    ██       ░    ░    ░  |
| (Gulf Coast / S. Florida)                                                                         |
|                                                                                                   |
| 10–20°N     ████ ████ ████        ░    ·          ·         ·          ·    ░        ████ ████ ████|
| (Central America / Tropics)                                                                       |
|                                                                                                   |
+---------------------------------------------------------------------------------------------------+
|  ◀  [====================o======================================]  Jul  ▶     [ ▶ Play Animation ] |
|                                                                                                   |
|  📍 July · 40–50°N (Great Lakes & New England)                                                    |
|     9% average reporting rate · 19 regions · Core breeding season                                 |
|     Top regions: Maryland (24%) · Pennsylvania (21%) · Ontario (18%) · New York (17%)             |
|     [ Drill into all 19 regions in Best Time of Year ↓ ]                                          |
+---------------------------------------------------------------------------------------------------+
```

---

## 4. Implementation Roadmap in the Current Stack

These enhancements do **not** require rebuilding the data layer or changing the database schema:

1. **Step 1 (Zero backend changes): Geographic Landmark Dictionary**
   - In `src/lib/components/migration-ribbon.ts`, define landmark labels per `(band, column)` (e.g. `NAE` + `40` $\to$ `"Great Lakes & New England"`).
   - Render these landmark subtitles under the latitude labels in `MigrationRibbon.svelte`.

2. **Step 2 (Pure client logic): Auto-crop Latitudes**
   - Inspect the species' grid cells in `initialState()` / `geometry()`.
   - Compute `minBand` and `maxBand` where frequency $> 0$. Expand by 1 band on each side.
   - Restrict SVG row generation to the active slice, with a toggle for `Show full globe`.

3. **Step 3 (Client UI polish): Biological Season Ribbon & Summary**
   - Derive the primary breeding and wintering latitude centroids per month.
   - Render the seasonal header pill and timeline banner above the month labels.

4. **Step 4 (Streamlined Toolbar & Inspector):**
   - Move checklist weighting into the `<details>` drawer.
   - Unify the continent picker into a clean segmented control.
   - Anchor the readout directly beneath the scrubber.
