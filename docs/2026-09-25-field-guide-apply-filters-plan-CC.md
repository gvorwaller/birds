# Field Guide filters: keep Place, search only on Apply (td-daff98)

2026-09-25 · Claude Code (GAYLON-M4-2025-192y) · Status: **plan, CODEX1-reviewed twice (findings folded in, marked [CODEX1]); awaiting owner go**

## Goal

The Field Guide is the app's "all species for {some area}" view: All / Need / Seen ×
place × traits (td-d2bb08, Phase 8A, td-8ff597). Keep all of that, but make the
Filters and sort panel behave like a form: every control edits a **draft**, and
the search runs only when **Apply filters** is activated (click, or Enter/Space on
the focused button; see §6). Make Place easy
to find.

Owner decisions (2026-09-24/25):

1. Keep place filtering in the Field Guide (country → state → county → verified
   hotspot, plus map + radius).
2. Result-summary ✕ chips and "Clear all search and filters" stay **immediate**
   (they act on applied filters, not the draft).
3. The map chooser **feeds the draft**: its button becomes "Use this point"; the
   one Apply filters button runs everything.
4. Separate ticket td-c52c37 links Hotspots-page species counts to this view (out
   of scope here).
5. **All four place fields are searchable** (type to filter): Country, State /
   region, County / equivalent and Verified hotspot (2026-09-25; owner: county and
   hotspot lists are hard to scan). The owner later confirmed the Field Guide
   lists are sorted; the unsorted list he saw was on another page.

## Current behaviour (evidence)

- `src/routes/species/+page.svelte:62` `levelChanged()` clears deeper selects and
  calls `form.requestSubmit()` on every change of the four location selects
  (lines 311–314). Reason: each lower list is only available from the server
  load for the **applied** selection (`+page.server.ts:115–122`:
  `subnational1Of`, `guideCounties`, `guideHotspots`, all DB/reference data;
  no eBird).
- Trait choices (Habitat … Finding) are `<a href={toggleHref(tag)}>` links, so
  each tap navigates and searches.
- Family, Sort and Special interest are plain form fields; they already wait for
  Apply.
- The map chooser's "Apply location" calls `goto(guideMapHref(…))` immediately,
  discarding any other unapplied panel edits.
- No-JS path: the filter form carries hidden `was_country…was_hotspot` fields
  (`guideWasPairs`), and the loader's `canonicalizeGuideLevelChange()` works out
  the shallowest changed level, clears deeper ones, and 303-redirects.

## Design

### 1. Draft model (client)

- In `+page.svelte`, a `draft` `$state` object: `{ interest, family, sort,
  tags: string[], place }`, where `place` is
  `{ kind: "none" } | { kind: "hierarchy", country, region, county, hotspot } |
  { kind: "map", place, lat, lng, dist }`.
- **[CODEX1] One `resetToApplied()` routine**, keyed on an *applied signature*
  (`guideDraftKey(applied)` plus `page.url.search`), run with `$effect.pre` so no
  frame renders an old draft against new data. On every applied change (mount,
  Back/Forward, refresh, shared link, ✕ chip, scope link, pagination, Apply) it:
  1. aborts/invalidates every in-flight choices request (bumps
     `placeGeneration`);
  2. closes and cancels the map chooser (`mapOpen`, `picked`, `radiusText`,
     `applyError` cleared);
  3. clears cascade loading/error/retry state;
  4. reseeds the choice lists and memo from loader data;
  5. copies the applied state into `draft`.
  Tests cover a navigation while a cascade request is pending, and while the
  chooser is open.
- **[CODEX1] `tags` is a plain sorted array, replaced immutably on every toggle**
  (`draft.tags = toggled(draft.tags, tag)`), never a `Set` mutated in place.
  Built-in `Set` mutation inside `$state` isn't deeply reactive, so checkbox
  state, dirty detection and serialization would go stale. The trips planner
  already clones and reassigns for the same reason
  (`src/routes/trips/plan/+page.svelte:114,135–139`).
- **[CODEX1] Dirty detection compares canonical DATA, not the raw URL.** One pure
  helper, `guideDraftKey(state)`, serializes only the draft-owned fields
  (interest, family, sort, tags, place) with defaults omitted, tag values
  de-duplicated and sorted, and place from the canonical selection
  (`guideLocationPairs`). The applied key is built from loader output
  (`data.interestOnly`, `data.family`, `data.sort`, `data.tags`, `data.selection`),
  which the loader has already normalized: lowercase geography upper-cased,
  unknown/duplicate tags dropped, invalid sort → relevance, only `interest=1`
  counts. `dirty = guideDraftKey(draft) !== guideDraftKey(applied)`. So a
  non-canonical or stale shared link never opens with the panel marked dirty.
- Leaving the page drops the draft; no persistence and no warning dialog.

### 2. Panel layout

`Filters and sort` panel, top to bottom:

1. **Place** (new `<fieldset>`, legend "Place", first in the panel): the four
   selects, the "Choose on map" chooser, and a short line: "All species recorded
   in this place in loaded eBird history, any time of year. Combine with All /
   Need / Seen."
2. Special interest only, Bird family, Sort.
3. Trait groups (Habitat, Foraging, Tide, Time of day, Movement, Finding).
4. A sticky footer inside the panel: **Apply filters** (primary), a **Discard
   changes** button (secondary, shown only when `dirty`), and a persistent
   (non-live) line "Changes not applied yet" while `dirty`. The `<summary>` also
   shows "· changes not applied" when `dirty`, so it's visible with the panel
   collapsed.
   **[CODEX1]** Place-cascade announcements (loading, failure, retry) get their
   **own** region inside the Place fieldset (`role="status"` for loading/empty,
   `role="alert"` for failure), so they never overwrite the dirty text. Tests
   check the accessible text after a failure and after a Retry, not just the
   source wiring.

The panel's `<summary>` count (`activeFilterCount`) keeps counting **applied**
filters.

### 3. Location cascade without navigation

New read-only endpoint `src/routes/api/guide-locations/+server.ts`:

- `GET /api/guide-locations?level=region&parent=US` → `{ level, parent, choices: [{ code, name }] }`.
  `level ∈ { region, county, hotspot }`; `parent` is the country, region or
  county code.
- Requires a signed-in session (`locals.scopeId`, like `/api/region-detail`);
  otherwise 401.
- Validation in two steps **[CODEX1]**:
  1. `parseGuideChoicesRequest(params: URLSearchParams)` in
     `$lib/guide-location.ts` checks syntax and cardinality only. **[CODEX1]**
     It reads `level` and `parent` with `getAll` and requires exactly one
     non-blank value of each. Any other query key → 400. `parent` is
     trimmed/upper-cased once, and its `parseRegionCode` shape must match the
     level (country for `region`, subnational1 for `county`, subnational2 for
     `hotspot`). Missing, blank, repeated or malformed → 400.
  2. Server-side parent **identity**, because the list functions return `[]` for a
     well-shaped but nonexistent parent (`subnational1Of`, `guideCounties`,
     `guideHotspots`), which would confuse "unknown place" with "known place, no
     loaded children". `region`/`county` levels require `getRegion(parent)`
     (`regions.ts:143`) at the right level. The `hotspot` level requires the
     exact loaded subnational2 `frequency_fetch` row, following
     `resolveGuideLocation` (`server/guide-location.ts:242–256`). Unknown parent
     → 400 ("That county has no loaded data…" style); known parent with no
     children → 200 with `choices: []`.
- The endpoint module imports **only** DB/reference helpers (`regions`,
  `guide-location`, `db`). No eBird client, no credential loading, no job
  enqueueing. A test asserts that at the module-import level, in addition to a
  fetch spy.
- Data: `subnational1Of(country)`, `guideCounties(region)`,
  `guideHotspots(county)`: the exact functions the loader already uses, so lists
  are identical (name-sorted, code tie-break, uncapped). DB/reference data only;
  no eBird, Google or AI calls.
- `Cache-Control: private, max-age=300`. The lists only change when an admin
  loads data.
- The loader keeps rendering the applied selection's lists server-side, so the
  first paint and no-JS need no fetch.

Client:

- Changing a select sets that level in `draft.place`, clears deeper draft
  levels, and fetches the next level's choices.
- **[CODEX1] Stale responses: one hierarchy generation token, not per-level
  counters.** Any change at any level increments a single `placeGeneration` and
  aborts every in-flight choices request (one `AbortController` per
  generation). A response is committed only if its generation is still current
  **and** its `parent` equals the draft's current value at the parent level.
  Otherwise, a county list for an old region still in flight when the country
  changes could fill a descendant that was just cleared, because no new county
  request would have been started to replace it.
- While loading, the next select is disabled with the option text "Loading…",
  and the status line announces it. On failure: "Couldn't load counties. Try
  again" with a Retry button; the draft stays as chosen. Empty keeps the existing
  wording ("No loaded counties" plus the Hotspots & data hint).
- Choices are memoised per `level:parent` for the page's lifetime.
- Choosing a hierarchy value clears any draft map point, and vice versa (the
  Phase 8A "hierarchy XOR map" contract).

### 3b. Searchable place fields (owner decision 5)

A new `src/lib/components/SearchableSelect.svelte` replaces the four `<select>`s
**once JavaScript is running**. Pure logic (folding, matching, paging, committed
vs typed state) lives in `$lib/place-filter.ts` so it can be tested without a
browser.

**Typed query vs committed value [CODEX1 P1].** The component keeps two separate
values: `query` (what's typed) and `committed` (the chosen code, which is what
the hidden input submits and what the draft holds). Only **activating an
option** (click, tap, or Enter on the active option) or the explicit **clear
(✕)** button changes `committed`. On Escape, Tab, blur by clicking outside,
blur caused by clicking Apply, or the popup closing with nothing chosen, the
input text reverts to the committed option's label. So the visible text and the
submitted code can never disagree. Option presses use `pointerdown` +
`preventDefault` so the input doesn't blur (and dismiss) before the choice
commits; this includes touch. Tests check that the visible label matches the
submitted code after every dismissal path.

**ARIA and keyboard [CODEX1 P2]** (WAI-ARIA 1.2 editable combobox with a
listbox popup):

- The input has `role="combobox"`, `aria-autocomplete="list"`,
  `aria-expanded`, `aria-controls`, and `aria-activedescendant` pointing at
  stable option ids (`${fieldId}-opt-${code}`).
- The listbox options have `role="option"`, with `aria-selected` on the
  committed option. The active option is scrolled into view. Focus stays in the
  input while ↑/↓ move.
- Enter commits the active option when the popup is open. With the popup
  closed, Enter opens it. Enter in these inputs **never** submits the form
  (`preventDefault`), so only the Apply button applies, consistent with §6.
- Enter during IME composition (`event.isComposing`) is ignored.
- Escape closes the popup and reverts the text. Tab leaves and reverts.
- An "Anywhere in …" option is always first. The clear and Retry buttons have
  labels ("Clear county", "Retry loading counties").
- A polite count line inside the popup: "12 matches", or "Showing 200 of 1,834
  matches".
- No `enterkeyhint="done"`, because Enter picks an option.
  `autocomplete="off"`, `autocorrect="off"`, `autocapitalize="off"`,
  `spellcheck="false"`.

**Matching [CODEX1 P2].** One shared `foldForMatch()` does NFD then
`replace(/\p{M}/gu, "")`, maps letters with no decomposition (ł→l, ø→o, æ→ae,
ß→ss, đ→d), and lower-cases. `tokenStarts()` splits on anything that isn't
`\p{L}\p{N}` (so hyphens, apostrophes, periods and spaces all start a new
word). The ranking is relevance, then name: first matches at the start of the
whole label, then at the start of any word, then anywhere inside a word. Within
each group, the server's name order is kept. The popup states "best matches
first" when a query is active. Hotspots also match their `L…` code. Labels are
always displayed unchanged. Tests: São Paulo, Côte-d'Or, Åland, Łódź, Saint-
/St. hyphens and apostrophes, and mixed case.

**Big lists [CODEX1 P1].** No hard cap. The popup renders matches in pages of
200 with a **"Show next 200"** option at the end of the list. It is reachable
with ↓, Enter and touch, and announced with the count line. So any item is
reachable by scrolling and paging even when hundreds share a name or prefix, and
without knowing its code. A test uses a fixture of more than 200 hotspots with
identical or common-prefix names and selects item #350 by keyboard and by tap.

**Mobile.** Input `font-size ≥ 16px` so iOS doesn't zoom. Options at least 48px
tall. The popup scrolls inside the panel with no horizontal overflow at 320px.
Software-keyboard typing and touch selection are covered in the browser test.
**Real iPhone Safari + VoiceOver is a manual owner check.** Desktop WebKit
automation is not claimed as iOS or VoiceOver proof.

**Hydration swap [CODEX1 P1].** The server renders the existing native `<select>`s
(same `name`, same options, same `was_*`) as the no-JS form. At hydration,
before the component replaces a native select, it reads that select's **live**
value (the DOM, not `data`) into the draft. If the value differs from the
applied one, it applies the same "clear deeper levels" rule and marks the panel
dirty. If the native select is focused or open, the swap for that field waits
until it blurs (to avoid pulling a control out from under the user), and
focus moves to the matching combobox if the swap happens while its fieldset has
focus. `was_*` becomes `disabled` only after all four fields have swapped
(`placeHydrated`), not merely at `jsReady`.

**Exactly one submitting control per field [CODEX1 P3].** An integration test
asserts that each place `name` has exactly one successful form control in each
phase: before hydration, the native select with `was_*` enabled; after, the
hidden committed-code input with `was_*` disabled. This catches duplicate or
stale submission during the swap.

**Disabled/loading/empty.** Mirrors §3. The field is disabled, with the same
"Choose a … first" text, until its parent is chosen. It shows "Loading…" while
choices load, and "No loaded counties" (plus the Hotspots & data hint) when
empty.

**Sort order [CODEX1 P2].** The server sorts with `byNameThenCode`, which uses
the runtime's *default* `localeCompare`. Case, diacritics, punctuation and
numbers can therefore sort unexpectedly, and the result can differ between
environments. Change: one shared, fixed comparator in `$lib/place-filter.ts`,
`new Intl.Collator("en", { sensitivity: "base", numeric: true })` on
whitespace-normalized labels with a code tie-break, used by `guideCounties`,
`guideHotspots` and (for Country/State lists) the choices endpoint. Unfiltered
lists are then plainly alphabetical everywhere. Filtered results are
relevance-then-name by design (above), and the popup says so.
The owner confirmed (2026-09-25) that the Field Guide lists already appear
sorted, so there's nothing to reproduce here. The fixed comparator is kept as
hardening: it makes the order independent of the server runtime's default
locale, and the matcher shares it. A test pins alphabetical order for mixed
case, diacritics and numbered names.

### 4. Map chooser feeds the draft

- The button becomes **Use this point** (enabled under the same rules as today:
  a point chosen and a radius of 1–200). It sets
  `draft.place = { kind: "map", … }`, closes the chooser, returns focus to the
  Place fieldset's map summary, and marks the panel dirty. It does not navigate.
- Place shows the draft map summary ("Map point: X, within N miles" with a
  "Change" and a "Use country/county instead" button). Both edit the draft only.
- **[CODEX1]** `openChooser()` and `MapPicker`'s initial props seed from
  **`draft.place` when it is a map point**, falling back to the applied
  `data.map`, so reopening **Change** before Apply shows the draft pin and
  radius. Test: Use this point → Change (same pin and radius shown) → Cancel
  (draft unchanged) → Change → Use this point.
- The map chooser still needs JavaScript (unchanged `<noscript>` note).

### 5. Trait choices wait for Apply

- Each trait becomes a `<label class="chip"><input type="checkbox" name="tags" value="dimension:value">…</label>`
  inside the filter form, keeping the chip look (selected style driven by
  `:has(input:checked)`, with a class fallback), a 48px minimum target, and a
  visible focus ring on the label.
- The old hidden `tags` inputs in the filter form are removed; the checkboxes
  submit them. The **search** form (the top box) keeps submitting the **applied**
  tags as hidden inputs, unchanged.
- `toggleHref` stays only for the result-summary ✕ chips (immediate, per owner
  decision 2).

### 6. Submitting

- The panel stays a native `<form method="GET" action="/species#results">`.
  With JS, SvelteKit handles the GET form as client navigation. Its fields are
  rendered from `draft`: selects, checkboxes, and hidden map fields when
  `draft.place.kind === "map"`.
- **The `was_*` hidden fields must be disabled when JS is active.** With the
  client cascade, a person can change the country and then pick a new region and
  county before applying. `canonicalizeGuideLevelChange()` would see
  "country changed" and clear the region and county they just chose. With JS,
  the submitted hierarchy is already consistent, so no `was_*` fields are sent
  and the loader's strict `parseGuideLocation` validation applies. Without JS,
  the `was_*` fields are still sent and canonicalization works as today.
  (Implementation: render them with `disabled={jsReady}`.)
- `page` is always dropped on Apply (as today).
- Unknown params (`unknownParams`) and `q` are still carried as hidden inputs.
- **[CODEX1] Keyboard contract, stated precisely:** Enter/Space on the focused
  **Apply filters** button applies. Native select, checkbox and details
  keyboard behavior is left exactly as the browser defines it: no form-wide
  keydown handler, and no Enter-hijacking on selects or checkboxes. The
  searchable place inputs (§3b) are text fields, so each one handles its own
  Enter (commit or open the option list) and prevents implicit submission.
  The Chromium and WebKit keyboard checks in the browser test cover this.
- **[CODEX1]** The top search form keeps using **applied** filters, and a search
  discards any unapplied panel edits (the navigation resets the draft). There is
  no pre-navigation "draft discarded" message: SvelteKit navigates immediately and
  it wouldn't be perceived or announced. Help states the rule instead.

### 7. What stays immediate

- Result-summary ✕ tag chips, "Clear location only", "Clear all search and
  filters", the All / Need / Seen scope links, and pagination links, because
  they act on applied state. After such a navigation, `resetDraft()` resyncs the
  panel.

### 8. Server changes

- `+page.server.ts`: unchanged contract. It still renders applied lists and still
  canonicalizes `was_*` for no-JS. Nothing is removed.
- New endpoint (§3), plus a small shared validator in `$lib/guide-location.ts`:
  `parseGuideChoicesRequest(level, parent)`, so the endpoint and tests share one
  rule.

### 9. Copy

- Help, Field Guide section (`src/routes/help/+page.svelte` ~650–700): describe
  Place first; "Changes take effect when you choose **Apply filters**";
  "**Use this point**" for the map; typing to search each Place field; that the
  ✕ chips, Clear links and the top Search box act straight away (Search uses the
  applied filters and discards unapplied panel edits); and the "all species in
  loaded history, any time of year" meaning. **[CODEX1]** Keep the level rule,
  reworded: "Changing a higher Place choice clears the deeper choices right
  away, but the results don't change until you choose Apply filters." 
- About: one bullet in the current release block. Don't rewrite past release
  notes.
- `docs/ux/phase-08a-field-guide-location-contract.md`: dated amendment for
  draft + Apply, the options endpoint and map "Use this point".

## Tests

Unit / component-source (`src/routes/species/guide-ui.test.ts`, updated):

- No `requestSubmit` or `levelChanged` auto-submit; the selects have no
  navigation on change.
- `was_*` inputs rendered with `disabled={jsReady}` inside the filter form;
  loader still canonicalizes (no-JS contract unchanged).
- Trait checkboxes `name="tags"` inside the filter form; the result-summary ✕
  chips still use `toggleHref`.
- Map button text "Use this point"; no `goto(` in the chooser path.
- Apply, Discard and status-line wiring; the summary's "changes not applied"
  marker.

Pure (`src/lib/guide-location.test.ts` + new draft helper tests):

- Draft serialization equals `guideLocationPairs` for applied selections
  (round-trip); hierarchy XOR map.
- **[CODEX1] `guideDraftKey` canonical comparison:** a freshly loaded page is
  not dirty for lowercase geography, reordered/duplicate/unknown tags,
  empty/default/invalid sort, or a junk `interest` value; a real change is
  dirty.
- **[CODEX1] Tag toggles:** two successive toggles update checked state, the
  dirty flag and the Apply serialization; Discard restores the applied tags
  (array replaced, never mutated).
- `parseGuideChoicesRequest`: valid levels/parents, wrong-level parent, malformed
  codes, hotspot parent must be a county.

Endpoint (`src/routes/api/guide-locations/guide-locations.test.ts`, DB, owned
fixtures only):

- **[CODEX1]** 400 for a repeated, missing, blank or extra query key, and for a
  wrong-level parent; 200 with `[]` for each level's legitimate empty list.
- 401 without a session; 400 on bad input; **[CODEX1] 400 for a well-shaped
  but nonexistent country, region or county** (e.g. `XX`, `US-ZZ`,
  `US-FL-999`), and 200 `[]` for a real parent with no loaded children; choices identical to
  `guideCounties` / `guideHotspots` / `subnational1Of` for the same parent
  (uncapped, same order); `Cache-Control` set; no network (fetch spy asserts
  zero calls).

SearchableSelect (`src/lib/components/searchable-select.test.ts` + pure
`$lib/place-filter.ts`):

- Matching: case/accent-insensitive; word-start matches before substring
  matches; server order kept within each group; hotspot `L…` code match.
- 200-row rendering cap with an accurate "N more" count; every choice reachable
  by typing.
- Markup contract: combobox/listbox roles, `aria-activedescendant`, a hidden
  input with the submitted `name`, and a native `<select>` fallback before
  hydration.

Client cascade logic (extracted into `$lib/guide-draft.ts` so it's testable
without a browser):

- Changing a level clears deeper levels; a failure keeps the draft and shows
  Retry.
- **[CODEX1] Ancestor-switch race:** a county (or hotspot) request for the old
  parent resolves *after* the country/region changed and must not fill the
  cleared descendant. Also covers same-level out-of-order resolution.

Browser (GROK, Chromium + WebKit, 390/320/desktop):

1. Change country → region → county → hotspot **by typing** in each searchable
   field (e.g. "uni", "flo", "sara", "myak"): no navigation or result change
   until Apply; lists fill at each step; Apply shows that hotspot's species with
   All. Keyboard-only (↑/↓/Enter/Escape/Tab) and VoiceOver announce the
   options. On a 390px iPhone-width viewport the page doesn't zoom and the popup
   stays inside the panel.
2. Change family, sort, special interest and two trait chips; Discard restores
   the applied state; Apply applies all at once.
3. Map: choose a point and radius, Use this point, then Apply; switch back to
   county; hierarchy XOR map holds.
4. Result ✕ chip and Clear all act immediately and the panel resyncs.
5. Refresh, Back/Forward and a shared link show the applied state, not a draft.
6. JavaScript off: the native form still applies, and changing a higher level
   clears the lower ones server-side.
7. Keyboard: tab through Place → traits → Apply; status announcements; focus
   after "Use this point"; 48px targets; no horizontal overflow. **[CODEX1]**
   In Chromium and WebKit, Enter on a select or checkbox does not submit and
   Enter/Space on Apply does.
8. td-8214cb path: Field guide → species → back returns to the applied filters
   with the row focused.
9. **[CODEX1] Throttled hydration** (CPU/network throttling): (a) change the
   county natively and Apply before hydration, and the server canonicalizes; (b)
   change the county natively, let hydration finish, then Apply: value, dirty
   state, focus and cleared descendants are preserved, with no duplicate
   submission.
10. **[CODEX1] Large lists:** in a county with more than 200 hotspots, reach
    item #350 with "Show next 200" by keyboard and by tap; after Escape, Tab,
    outside tap or Apply, the visible label always matches what submits.
11. Manual owner check on a real iPhone (Safari + VoiceOver): not claimed from
    desktop WebKit.

Gates: focused vitest; the full suite (now clean without exclusions);
`npm run check`; `npm run build`; `git diff --check`; before/after counts for
any DB test.

## Risks and edge cases

- **Stale-level clearing on JS submit** (§6). This is the main correctness trap;
  covered by the `disabled={jsReady}` rule and a test.
- **Hydration race [CODEX1]:** not assumed; handled by the §3b swap rules
  (read live DOM values, defer while focused, disable `was_*` only after all
  fields swap) and **proven by a throttled-hydration browser test** covering
  (a) edit and submit before hydration (native + `was_*`) and (b) edit before
  hydration, then submit after (value, dirty state, focus and cleared
  descendants all preserved).
- **Large lists**: some countries/regions have hundreds of counties or hotspots.
  The endpoint returns them uncapped as today; the payload is small (code +
  name). Memoisation avoids refetching.
- **Applied map + hierarchy URL from older links**: the loader's strict parse
  still rejects mixed selections (unchanged).
- **Viewer role**: read-only; the endpoint only needs a session, like the page.

## Out of scope

- td-c52c37 (Hotspots count → Field Guide links).
- Forecast changes; "any month" in Forecast.
- td-894144 (tag accuracy).

## Rollout

Single PR-sized change on a feature branch → CODEX1 hostile review → GROK
browser test → owner go → deploy via `./scripts/deploy-to-DO.sh` →
authenticated smoke.
