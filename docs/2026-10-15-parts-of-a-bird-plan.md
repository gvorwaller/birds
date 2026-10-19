# td-9c9655 — Field Guide: "Parts of a Bird" tab (interactive SVG diagrams)

## Context
The owner wants to learn the body parts used in bird identification. The model is the front matter of
the Sibley app ("Bird Topography" → Parts of a Passerine / Shorebird / Duck / Gull), but Sibley's
drawings are dense and hard to learn from.

**Owner decisions (2026-10-15):**
- the name is **"Parts of a Bird"**;
- v1 has four sections: songbird, shorebird, duck and gull;
- the sections are collapsible;
- the diagrams are **our own interactive SVGs, drawn by Claude** (no AGY). Licensed images were
  preferred, but Wikimedia Commons has only one songbird diagram (CC BY-SA), and it has label errors.
  There's nothing for the other three.

**Intended outcome:**
- A fifth Field Guide tab. Each section has a clean, simplified side-view drawing.
- Tapping a part (or its name in the list) highlights it and says what to look at there.
- A "Main parts" / "All feather groups" switch.
- The page works without JS (read-only), in all 5 themes and at phone width. Labels are real text.

**Review history:** CODEX1 reviewed the plan on 2026-10-15 and returned *approve-with-changes*: no P1,
P2-1…P2-6 and P3-1…P3-2. All findings are integrated below and marked [C-…].

## Design

### 1. Data: `src/lib/bird-parts/` (new)

**`types.ts`**

- `BirdPart`:
  `{ id, name, aka?, group, layers: ("main"|"feathers")[], lookFor, visibility? }`
  - `group`: Head · Bill & legs · Upperparts · Wing · Underparts · Tail.
  - `lookFor`: a one- or two-sentence ID tip.
  - `visibility`: an optional honesty note. Example: "Hidden on a resting bird; seen in flight."
- `BirdDiagram`:
  `{ id, title, model: {species, age, pose, sources[]}, intro, viewBox, base, parts, shapes, drawOrder, insets? }`
  - `shapes`: `Record<partId, string[]>`.
  - `drawOrder`: part ids, bottom to top.
  - `insets?`: small extra views of the same model, for a structure a folded side view can't honestly
    show [C-P2-4].

**Layers are cumulative** [C-P2-1]:
- **Main parts** shows the parts whose `layers` include `main`.
- **All feather groups** shows *every* part: the main-layer body context, plus the feather tracts
  drawn over the wing and tail.
- A part that belongs in both views (e.g. primaries, undertail coverts) is **one id with
  `layers: ["main","feathers"]`**, never two ids.
- Hit priority follows `drawOrder`: the topmost visible path wins a tap. Overlapping enlarged hit
  areas are not used.
- **On a layer change**, the selection is kept if the part is still visible and cleared (caption
  reset) if not.

**One module per bird**: `songbird.ts`, `shorebird.ts`, `duck.ts`, `gull.ts`, plus `index.ts`. Each
module records its **model species, age and pose**:
- songbird: an adult sparrow;
- shorebird: an adult yellowlegs;
- duck: an adult male Mallard;
- gull: an **adult American Herring Gull**.

**Main-layer parts by bird:**
- **Songbird:**
  - forehead, crown, nape, lores, eye-ring, supercilium (eyebrow), eye-line;
  - ear patch (auriculars), malar stripe;
  - chin, throat, breast, belly, flanks, undertail coverts;
  - back, rump, tail (outer tail feathers);
  - wing bars, primaries, upper and lower mandible, tarsus.
- **Shorebird:**
  - bill length relative to the head, leg length and colour, scapular pattern, breast band;
  - **primary projection** and **wingtip vs. tail**, as two separate callouts with separate
    definitions [C-P2-3]:
    - primary projection = how far the primaries extend beyond the tertials on the folded wing;
    - wingtip vs. tail = whether the folded wingtips fall short of, reach, or pass the tail tip.
- **Duck:** the nail, cheek, speculum, tertials, sides vs. flanks.
  - The speculum gets a `visibility` note: often partly hidden at rest.
- **Gull:** mantle, wingtip (primaries), tertial crescent, orbital ring, gonys, leg colour.
  - **Gonys** is taught as the *shape*: the angle on the lower mandible.
  - **Gonydeal spot** is the red spot on the model, adult Herring Gull. The text says only some
    species have it; adult Ring-billed has a black bill ring instead [C-P2-4].
  - **Mirrors vs. apical spots** are two different callouts:
    - mirrors = white spots within the outer primaries, near the tip;
    - apical spots = small white tips to the primaries.
    - Mirrors are mostly hidden on a folded wing, so they're shown in a small **open-wingtip
      inset**, with a `visibility` note [C-P2-4].
  - The gull text notes that immatures differ.

**Feathers layer (adds):**
- scapulars;
- lesser, median and greater coverts;
- alula, tertials, secondaries;
- uppertail coverts.

Wing bars are described as **the usual two-bar songbird pattern: pale tips of the median and greater
coverts**. They aren't universal; some birds' wing bars come from other covert tips [C-review note].

**Text rules:**
- original wording, never Sibley's text;
- facts checked against standard references: Cornell All About Birds / Bird Academy, Wikipedia bird
  anatomy, and the Helm Guide to Bird Identification for primary projection;
- each module lists its `sources[]`.

**Owner visual approval is not factual approval.** CODEX1 does a separate factual review of the
final boundaries and text (§Verification) [C-P2-4].

### 2. Drawings: Claude-authored SVG (riskiest step, done first)
1. **References:**
   - Use openly licensed side-view reference photos of each model species, age and pose.
   - These are for proportions only and are never published. Their sources go into `model.sources`.
2. **Draw in the scratchpad.** One simplified side view per bird:
   - Each part is a closed path whose edges meet its neighbours'.
   - The feather tracts are drawn over the wing and tail.
   - Insets cover structures the side view hides (gull mirrors and apicals). Never invent partitions.
   - Use neutral theme-token tones (no species colours), with `--text` outlines.
   - The one exception is the gull's gonydeal spot, drawn in a token-safe red/accent and labelled.
3. **Render and check:**
   - Render to PNG with `rsvg-convert` (`/opt/homebrew/bin`) and look at it.
   - Iterate until each part's boundary matches the reference.
   - Check that small head parts (lores, eye-ring, malar) are big enough to tap at 320px. Enlarge the
     head proportion slightly if needed; never with overlapping hit areas.
4. **Owner checkpoint:**
   - Publish an Artifact preview page with the four static drawings, both layers, every part
     labelled, and the insets.
   - The owner approves the look, then the paths move into the data modules.

### 3. Component: `src/lib/components/PartsDiagram.svelte` (new)

**Props and state:**
- Props: `diagram`, `selected` (bindable), `layer` (bindable).
- The page owns the state, so fragment handling can drive it.

**SVG:**
- `role="img"`, `aria-label="Diagram of a {title}"`.
- Paths render in `drawOrder`. Each has `data-part` and a pointer handler.
- Paths are `aria-hidden` and not tab stops. The **parts list is the accessible, keyboard-equivalent
  control**, and the drawing is a pointer shortcut.
- `npm run check` must show **zero new warnings**. Satisfy the a11y lint properly, e.g. one
  delegated handler on the `<svg>` that reads `data-part`, rather than suppressing it [C-P2-5].

**Colours:**
- Only CSS vars, the way `FrequencyChart.svelte` and `MigrationRibbon.svelte` do it.
- Body: `--placeholder-bg` / `--card`. Outlines: `--text`.
- **Selected part**: `--accent-soft` fill, a 3px `--accent` stroke, and a dashed outline, so the
  selection isn't shown by colour alone.

**Caption:**
- Says "Tap a part, or a name below."
- Changes to **Name** (aka) — lookFor (+ visibility note) when a part is selected.
- `aria-live="polite"`. The caption has an id, and the selected list button references it via
  `aria-describedby`.

**Layer switch:**
- Two `<button aria-pressed>` styled like the species page's mi/km Units toggle.
- Keyboard-operable, with a visible `:focus-visible` outline.

**Parts list:** grouped by `group`.
- **Without JS (SSR)** [C-P2-2, C-P2-5]:
  - The *entire* glossary: every part from both layers, as `name — lookFor`, each with a real
    `id="{diagram}-{part}"` anchor.
  - The layer switch and the "Tap a part" instruction are not rendered.
  - Inert controls are never shown.
- **Hydrated:**
  - The list follows the active layer, and names become `<button aria-pressed>` (48px+).
  - Focus is kept on the pressed button through re-renders. If a layer change removes the focused
    part, focus moves to the layer switch.
  - The SSR text is replaced in place, so there's no layout jump.

### 4. Page: `src/routes/parts-of-a-bird/+page.svelte` (new; no server load)

**Structure** (models: `src/routes/taxonomy/+page.svelte:32-49`):
- `<title>Parts of a Bird — birds</title>`;
- `PathNavigation` (label "Parts of a Bird", fallback Field guide), with `data.user` from the parent
  `+layout.server.ts`;
- `<h1>📖 Field guide</h1>`;
- `<FieldGuideTabs active="parts" />`;
- an intro card.

**Sections:**
- Four `<details id="songbird|shorebird|duck|gull">`, closed by default.
- Each summary is an `<h2>` with the ▸/▾ style from `species/[code]/+page.svelte:1347-1364`.
- The heading is `.section-target` so it clears the fixed header.

**Open state owned by the page** [C-P2-2]:
- One `$state` record: `{songbird, shorebird, duck, gull}`.
- Each `<details bind:open>`, so native toggles, Expand all / Collapse all and fragment reveals stay
  in sync.
- Expand all / Collapse all are rendered only after hydration, styled after `about/+page.svelte:99-101`.

**Fragment handling** [C-P2-2]:
- One `revealFromHash(hash)`, called from `onMount` and from `afterNavigate`. `afterNavigate` covers
  SvelteKit client links, same-page hash links and Back/Forward, all via `page.url.hash`.
- Steps:
  1. Parse `#{diagram}` or `#{diagram}-{part}`. Validate **against the data**, never as a DOM
     selector. An unknown or malformed hash is ignored.
  2. Open the section.
  3. If the part is feathers-only, switch the layer to *All feather groups*.
  4. Select the part.
  5. `await tick()`.
  6. Scroll the section heading into view with the header offset; focus the part's list button.
- **No-JS:** sections are **closed in SSR, the same as with JS**. Rendering them open in SSR would
  make every normal load flash open, then collapse at hydration. Native `<details>` opens without JS,
  so no-JS readers still reach the whole glossary in one tap per section.
  - Anchors point at real ids. Browsers differ on whether a fragment reveals text inside a closed
    `<details>` (Chromium does; WebKit is tested in UI). A no-JS deep link may land on a closed
    section, which is an accepted, documented limit.
  - The UI test records the WebKit/Chromium behaviour.

### 5. Wiring

- **`src/lib/components/FieldGuideTabs.svelte`:**
  - Add `"parts"` to `active` and a fifth link "Parts of a Bird" → `/parts-of-a-bird`.
  - On phones, the fifth tab gets `grid-column: 1 / -1`.
  - At ≥640px, use `repeat(5, …)` **and reset the fifth tab to `grid-column: auto`** [C-P3-1].
  - Verify on every caller (`/species`, `/viewed`, `/special-interest`, `/taxonomy`,
    `taxonomy/+error.svelte`), particularly at 640px with the long labels.
- **`src/lib/field-guide-nav.ts`:** add `/parts-of-a-bird`, with and without the trailing slash.
  Update the tests in `src/routes/species/guide-loader.test.ts:36-48`.
- **`src/lib/return-link.ts`:** add `["/parts-of-a-bird", "Parts of a Bird"]` to `LABELED_PATHS`.
- **`src/lib/usage-features.ts`:** map the route to `"field_guide"` (enforced by `usage-features.test.ts`).
- **Auth:** no `PUBLIC_PATHS` change. The new route is login-protected by `hooks.server.ts` like
  every page.
- **Help** (`src/routes/help/+page.svelte`): add `<h3>Parts of a Bird</h3>` in the Field guide
  section, beside Taxonomy (~:985).
- **About** [C-P3-2]:
  - **Append to the existing v0.1.6 entry**, which `about-route.test.ts` slices from the first
    `<!-- v0.1.6 -->` to the next marker.
  - Never add a duplicate marker.

## Critical files
- **New:**
  - `src/lib/bird-parts/{types,songbird,shorebird,duck,gull,index}.ts`
  - `src/lib/components/PartsDiagram.svelte`
  - `src/routes/parts-of-a-bird/+page.svelte`
- **Changed:**
  - `src/lib/components/FieldGuideTabs.svelte`
  - `src/lib/field-guide-nav.ts`
  - `src/lib/return-link.ts`
  - `src/lib/usage-features.ts`
  - `src/routes/help/+page.svelte`
  - `src/routes/about/+page.svelte`

## Order of work
1. Draw the songbird, render it, iterate. Then the shorebird, duck and gull, plus the gull wingtip
   inset.
2. **Owner checkpoint** on the drawings (Artifact preview).
3. Data modules and text. Self fact-check against the sources.
4. Component, page and wiring.
5. Tests and gates; Help and About.
6. CODEX1 hostile review, covering code **and** factual accuracy of every final boundary and
   `lookFor`. UI test, owner go, deploy.

## Verification

### Unit tests

**`src/lib/bird-parts/bird-parts.test.ts`** (data integrity):
- ids are unique and fragment-safe;
- every part has ≥1 shape, and every shape belongs to a declared part;
- `drawOrder` covers every part exactly once;
- `layers` is non-empty;
- each diagram has both main and feathers parts;
- `name` and `lookFor` are non-empty;
- `model` has a species, age, pose and ≥1 source;
- every path `d` parses: valid commands, no NaN;
- the gull has separate `mirrors`, `apical-spots` and `gonys` parts, plus an inset;
- the shorebird has separate `primary-projection` and `wingtip-vs-tail` parts.

**Behaviour tests** (pure helpers extracted from the page and component):
- `parseHash` covers valid section, valid part, feathers-only part, unknown diagram, unknown part,
  malformed input and an injection-looking string, which must be ignored;
- `visibleParts(layer)`: a main part and a shared part are visible in both modes, and a
  feathers-only part only in feathers mode;
- selection on a layer change: kept when the part is still visible, cleared when it isn't.

**`src/routes/parts-of-a-bird/parts-route.test.ts`** (source assertions):
- title, tab, four sections with `bind:open`;
- the SSR glossary renders every part with an id;
- sections are closed in SSR (no `open` attribute in the markup);
- `afterNavigate` and `onMount` both call `revealFromHash`.

**Other updates:** tabs, `field-guide-nav` (exact and trailing slash), and the `return-link` label.

### Gates [C-P2-6]

**Build and diff:**
- `npm run check`: 0 errors and **zero new warnings**;
- `npm run build`;
- `git diff --check`.

**Full suite:**
- Audit DB-writing tests first, per the agent guide.
- Use only our own fixtures; never seed, reset or kill a suite on the shared `birds_test`.
- **Record a same-day pre-change baseline** of the known `searchable-select` failure and compare
  against it.

**Routes:** `/parts-of-a-bird` loads for the owner and for a viewer account, and an unauthenticated
request gets a 303 to `/login`.

**CODEX1 hostile review:** code, a11y and factual accuracy; high effort. The reviewer doesn't touch td
or git.

### UI test (dev server `npm run dev:test`, port 5178; screenshots recorded)

**Coverage:**
- all 5 themes; 320, 390 and 1200px;
- Chromium and WebKit;
- no-JS (sections open natively, full glossary, no inert controls; record whether a fragment reveals a closed section in each engine);
- the iOS Simulator (Mobile Safari, via axe) for tapping the small head parts.

**Keyboard:**
- tab through the layer switch and the list;
- visible focus;
- Enter/Space selects;
- focus is kept through a layer change.

**Screen reader (VoiceOver):** the caption is announced on selection, and the pressed state is read.

**Journeys:**
- Duck → "speculum" from the list;
- tap the gull's wingtip on the drawing;
- switch layers with a feathers-only part selected (the selection clears);
- cold `/parts-of-a-bird#gull-mirrors` (section open, inset part selected);
- a same-page hash link;
- a client-side link from Help;
- Back/Forward;
- a malformed hash (ignored);
- Expand all / Collapse all after manual toggles (they stay in sync);
- the tab grid on all 5 Field Guide pages at 320, 640 and 1200px.

### After deploy (owner's explicit go only)
- `/api/health` shows the exact revision, with db and worker ok.
- An authenticated read-only smoke check of `/parts-of-a-bird` and one existing Field Guide tab page.
- Then the owner checks it on phone and browser.

## Implementation notes (2026-10-15, after the owner approved the drawings)

Where the build departs from the plan above, and why:

- **Colours.** The approved drawings use fixed natural tones on a light plate, the same in every
  theme, rather than theme tokens: a drawing has to look like the bird in all five themes. The
  page around it uses theme tokens. A selection is a yellow fill plus a dark-red dashed outline at a
  fixed 2.5px (`vector-effect: non-scaling-stroke`), so it never relies on colour alone and stays
  visible on tiny parts. The drake Mallard got its green head and chestnut breast so the drawing
  agrees with its own text.
- **Hash handling.** `afterNavigate` is not used. SvelteKit treats a same-page hash link, and
  Back/Forward between hashes, as shallow navigation: `page.url` changes but `afterNavigate` never
  runs (verified in `@sveltejs/kit` 2.70.3 `client.js`). The page instead follows `page.url.hash`
  in an `$effect`, which also runs on mount.
- **No-JS deep links.** Chromium and WebKit both open a closed `<details>` to reveal a fragment
  target, so `/parts-of-a-bird#gull-mirrors` without JS lands on the open section. The limit
  accepted above does not occur in either engine.
- **The duck has one layer.** Every swimming-duck part is already in the main view, so its
  "All feather groups" switch is not shown (`hasFeatherLayer`). Its Help text says so.
- **Data shape.** Each part has one `d` (several subpaths allowed), not `shapes[]`. Geometry is
  generated into `src/lib/bird-parts/geometry/*.json` by `scripts/bird-parts/` (Python and
  shapely; see `generate.py`). The text lives in one TypeScript module per bird. `joinDiagram`
  throws on any id mismatch. Lists follow the text module's order; drawing follows `drawOrder`.
- **Fact fixes found while writing the text:**
  - the drake Mallard's curl is labelled "Curled tail feathers" (the drake's central tail
    feathers), not uppertail coverts;
  - the gull's bill was reshaped so its lower edge has a real gonydeal angle (the lowest point,
    rising to the tip). The earlier gonys shape was swallowed by the spot and drew nothing;
  - the adult Herring Gull's orbital ring is yellow-orange, not red;
  - no tip claims primary projection separates the two yellowlegs (sources conflict). The
    wingtip-vs-tail example uses Baird's and White-rumped vs. Least Sandpiper instead.

## Addendum (2026-10-19): the raptor (td-dd4f9c)

A fifth drawing, built the same way as the other four (`scripts/bird-parts/raptor.py`, `raptor_flight.py`; text in `src/lib/bird-parts/raptor.ts`).

- **Model:** an adult light-morph Red-tailed Hawk, perched. It is North America's most widespread hawk and carries the classic hawk marks: belly band, patagial bar, red tail.
- **Parts it adds:** cere, tarsus, talons, belly band, leg feathers, patagial bar, carpal patch, fingers, dark trailing edge, subterminal band, wingtip vs. tail.
- **Drawing notes:**
  - The perched hawk is upright, so its plate is portrait (580×740). `PartsDiagram` caps any portrait whole drawing at 560 px tall; "One wing, larger" is not capped.
  - The flight views use `HawkWing`, a `flight.Wing` whose hand ends in five fanned fingers. `fingers` is its own part, drawn over the primaries.
- **Facts:** checked against Wikipedia and the USGS Patuxent ID page. Two claims were dropped because no source in hand confirmed them: Swainson's Hawk's wingtips on a perched bird, and the harrier's rump.
- **Term links:**
  - Hawks, eagles, kites, harriers, falcons, the Osprey, New World vultures, the Secretarybird and owls use the raptor drawing.
  - New terms: cere, patagial bar/patagium, belly band, tarsus/tarsi.
  - Linked only on raptor pages, because a count over the snapshot's text found other meanings elsewhere:
    - carpal patch (a tern's upperwing carpal bar);
    - fingers/emarginations ("finger claws");
    - subterminal band (gull bill bands).

## Addendum (2026-10-19): the heron (td-46e6e3, epic td-56a506)

The sixth drawing and the first of the epic's new groups (`scripts/bird-parts/heron.py`, `heron_flight.py`; text in `src/lib/bird-parts/heron.ts`).

- **Model:** an adult Great Blue Heron in breeding plumage, standing.
- **New parts:** head plumes, face, hindneck, foreneck, breast plumes, back plumes, flank stripe, thighs, tibia and toes.
- **Flight views:**
  - the neck is folded into an S, so the foreneck is the bulge under the head;
  - the legs trail past the tail;
  - from above, the tibiae are hidden behind the rump and tail, so only the tarsi and toes are drawn there.
- **The eye is not a part,** because no source in hand gave a Great Blue Heron iris fact.
- **New check in `common.build`:** `check_visible` stops generation if any part shows less than 25% of its own area in a layer that lists it. CODEX1 found the heron's tibia 2% visible from above. The lowest share across all six birds is 42.8%.
- **Term links:**
  - Ardeidae, Ciconiidae, Threskiornithidae, Gruidae, Aramidae, Balaenicipitidae and Scopidae use the heron drawing.
  - `tibia` links on every bird.
  - foreneck, hindneck and head/nuchal/occipital plumes link only on the heron group's pages. Stilts, grebes and others use the neck words in other senses.
