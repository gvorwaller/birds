# td-601faf — Home search also finds place names

> **Revision 3 (2026-07-31)** — two read-only adversarial reviews by CODEX3 against `main` 87d3c7e,
> every claim re-verified against source (and the vendored `@sveltejs/kit` 2.65.0 runtime) before
> being applied.
>
> Rev-2 applied the first review: the completeness claim narrowed to _the loaded payload_ rather than
> _all occurrences_, the matcher's typo tolerance bounded, place identity centralized, and the "zero
> server changes" claim **withdrawn** (two shape-only additions are needed — §5).
>
> Rev-3 is a targeted second review of §4 alone, which was the one section that was my own design
> rather than an adoption — and it was wrong twice. **§4d now specifies a plain
> `goto('?loc=…')` with `loc` deliberately untracked**, replacing rev-1's hash + `history.replaceState`
> and rev-2's shallow `pushState`; §4e deletes the server-minted `returnTo` instead of adding a second
> producer alongside it (the same edit is what untracks `loc`); and §4b's map fix is corrected —
> rev-2's "focused center + one marker" still hit `fitBounds` on a zero-area bounds.

## Context

Home (`/`) currently has two unrelated searches:

1. **Top "Place" form** — server-side geocode (`geocodePlace` in `src/routes/+page.server.ts:37`) that
   re-centers the entire view and re-runs `geoTargets()`.
2. **In-page filter** (`src/routes/+page.svelte:20-44`) — client-side, matches only species
   `comName`/`sciName`, and filters the Notable + Needs lists plus the map pins.

The user wants the _second_ box to also match **place names**: typing "Hugenot" should surface
Huguenot Memorial Park _because_ one of their needs or a notable report happened there inside the
current radius + window — then let them focus that place and see what to expect there.

Key finding: **all the data needed is already on the page.** `geoTargets()` returns per-species
`places[]` (`SpeciesPlace` — `locId`, `locName`, lat/lng, `nReports`, `totalCount`, `lastObsDt`,
`distanceKm`, `googlePlaceId`; `src/lib/server/needs.ts:20-30`) for both `needs` and `notable`.
Inverting species→places is therefore a pure client-side transform: **zero new eBird calls, no
latency, and it automatically obeys "within the existing location parameters."**

Verified against source: `aggregate()` populates `places[]` for both base feeds
(`needs.ts:147-242`), cached/stale payloads stay usable (`ebird.ts:74-107`), and a total base
failure with no cache yields `view = null` + the error card (`+page.server.ts:96-113`), which omits
this search entirely along with everything else.

**Completeness caveat — the index covers the loaded payload, not all occurrences.** `geoTargets`
enriches _needs only_ (`needs.ts:422-433`), and `enrichNeedsWithSpeciesReports` swallows per-species
detail failures with `catch { return need; }` (`needs.ts:291-314`) **without setting `stale`**. So in
a partially-failed fetch a need can be missing its secondary locations, and the search would claim
"no place matches" while the place is merely absent from what loaded. Notable has no analogous
enrichment at all — it carries only the base notable payload. Two consequences, both handled below:
copy says _loaded reports_, never _no reports_; and §5 adds a partial-enrichment signal so the UI
does not assert completeness it cannot back.

Decisions taken with the user:

- One box: "Search birds or places…", with a **Places** group above the species results.
- Selecting a place enters an inline **focus mode** on Home; a dedicated `/place/[locId]` page is a
  follow-up ticket, not this one.
- "What to expect" is limited to the recent-window data already loaded.
- A place is findable only if it has one of the user's needs or a notable report (per the ticket).

## Approach

### 1. Shared, client-safe place-name matching — `src/lib/place-name.ts` (new)

`src/lib/server/location-placeids.ts:108-136` already has an eBird-tuned `normalizeName()` +
`tokens()` (strips `US`, state codes like `fl-du`, punctuation) and `placeNameScore()`. It lives in a
server module that imports `$lib/db`, so the client cannot use it.

- **Move** `normalizeName`, `tokens`, and `placeNameScore` verbatim into `src/lib/place-name.ts`, and
  have `location-placeids.ts` import + re-export them. Behavior must not change —
  `placeNameScore` drives Google Places matching (`location-placeids.ts:170`) and is covered by
  `src/lib/server/location-placeids.test.ts`.
  - **Name collision to avoid:** `src/lib/server/species-match.ts:8` already exports a _different_
    `normalizeName` (species names; consumed by `routes/photos/+page.server.ts`). The moved location
    normalizer must not be confused with it — export it as `normalizePlaceName` from
    `place-name.ts`, keeping the private local alias inside `location-placeids.ts` so that file's
    body is untouched.
  - **The existing test does not prove the move is behavior-preserving.**
    `location-placeids.test.ts:4-12` is two coarse threshold assertions on `placeNameScore` and
    nothing else. Before the move, add golden-case tests for `normalizePlaceName`, `tokens`, and
    `placeNameScore` capturing current output (state-code stripping, `&`→`and`, stopword removal,
    the `length > 1` token filter), and assert the Google-matching call site
    (`location-placeids.ts:170`) resolves through the shared export. The re-export does keep the
    old test honest about _import path_, which is necessary but not sufficient.

- **Add** a new `placeQueryMatches(query, locName): boolean` for the search box specifically. Do
  **not** change `placeNameScore` itself. Typo tolerance is required by the ticket's own example
  ("hugenot" vs "Huguenot" fails plain `includes()`), but blanket edit-distance ≤ 1 over every token
  is far too permissive, because `tokens()` keeps 2-character tokens
  (`location-placeids.ts:118-122`) — under a naive rule `"ma"` matches `"me"`, `"mi"`, `"md"`, and
  prefix/substring widens it further. Rules:
  - Minimum **overall** query length of 3 before place matching engages at all.
  - Per token: length ≥ 4 → prefix, substring, **or** edit distance ≤ 1 (local `withinOneEdit()`).
    Length < 4 → exact or prefix only, never fuzzy.
  - Every query token must be satisfied, and **one candidate token may satisfy at most one query
    token** (greedy left-to-right consumption) so `"park park"` cannot match a single `"park"`.
  - **Diacritics**: the inherited normalizer is ASCII-destructive — `[^a-z0-9]+ → " "` turns
    `"Hāna"` into `"h na"`, whose only surviving token is `"na"`. For search only, fold with
    `NFKD` + combining-mark strip _before_ the inherited pipeline so `"Hāna"`/`"Hana"` converge.
    `placeNameScore`'s own normalizer stays byte-for-byte as-is.
  - Test fixtures must cover: the `"hugenot"` typo, `US-FL` prefix noise, county suffixes, `--`
    hotspot subunits, apostrophes/hyphens, diacritics, short-token false positives, and multi-token
    queries.

### 2. Place index + ranking — `src/lib/place-search.ts` (new, pure + unit-tested)

Client-safe, no imports from `$server`. Types declared structurally (same pattern as
`BestPlaces.svelte`'s module block, which avoids importing server types into client code).

- **`placeKey(locId, lat, lng)` — one canonical exported helper**, used by the index and by focus
  restore so they can never drift. It is the locId when present, otherwise the `"lat,lng"` string —
  joined with **`||`, not `??`**, matching the existing convention exactly (`needs.ts:99` and
  `needs.ts:198`). Under `??` an empty-string locId would key as `""` and collapse unrelated places
  together. Round the coordinate fallback to a fixed precision (5dp) so float noise cannot split one
  place.
- `buildPlaceIndex(notable, needs)` → `PlaceMatch[]`. Merge **both** lists — note `view.bestPlaces`
  is needs-only, so rarities the user has already seen contribute no entry there and it cannot be
  the source. Accumulate per place: `locName`, lat/lng, `googlePlaceId`, `needCodes: Set<string>`,
  `notableCodes: Set<string>`, `lastObsDt`, `distanceKm`. Separate Sets (rather than a raw counter)
  are what make notable/need overlap at one place safe to count.
  - **Identity reconciliation, stated explicitly:** the same physical place splits when one feed
    carries a `locId` and the other only coordinates (personal locations, jittered/private coords).
    Prefer `locId` when either record has one; when merging a coords-keyed record into a
    `locId`-keyed one, require the coordinates to be within a small epsilon and keep the `locId`
    record's `locName`/`googlePlaceId` as authoritative. On a conflicting `locName` for the same
    `locId`, keep the first and do not attempt a merge of names.
- `searchPlaces(index, query)` → filter with `placeQueryMatches`, then sort:
  need count desc → has-rarity → `lastObsDt` desc → distance asc (mirrors `rankPlaces()`'s
  convention in `src/lib/server/needs.ts:133-136`). **Cap the rendered result list** (20) — a short
  permissive query can otherwise match most of the index.
- `speciesAtPlace(key, notable, needs)` helpers used by focus mode.
- **Memoize**: build the index once per `data.view` change (`$derived`), not per keystroke; only
  `searchPlaces` runs on input.

Tests in `src/lib/place-search.test.ts` + `src/lib/place-name.test.ts` (vitest, same style as
`src/lib/near-me-radius.test.ts`): the "hugenot" typo case, `US-FL` prefix noise, merging notable +
needs into one entry, `locId`-less places keyed by coords, `locId`-vs-null identity, coordinate
jitter, conflicting names/`googlePlaceId`s, short-token false positives, the result cap, and
ranking order.

### 3. `PlaceMatches.svelte` (new component)

Modeled on `src/lib/components/BestPlaces.svelte` — reuse its card/rank/badge styling and its
`isHotspot` → `https://ebird.org/hotspot/{locId}` link treatment, plus `MapLink` for the map pin.
Each row: place name, `eBird hotspot ↗` badge when applicable, `3 needs · 1 rarity · 12.4 mi ·
<date>`, and a **Focus** action.

**Hotspot badge — do not derive it from `bestPlaces`** (rev-1 said to; that was wrong). `bestPlaces`
comes from `rankPlaces(recent.data, …)` (`needs.ts:350-356`) — the _pre-enrichment recent-needs feed
only_. It therefore excludes notable-only places and need places discovered by per-species
enrichment, so a derived Set would silently drop the badge from valid hits. (The `limit = 10` is
**not** the problem: `BestPlaces.svelte:22-35` slices only at render, so the full array is on the
page.) A badge that is wrong in a knowable way is worse than no badge, so see §5 — `isHotspot` gets
annotated onto `SpeciesPlace` server-side, where the complete verified set already exists.

**Accessibility and tap targets** (cs.md:82 — ≥48px targets, ≥16px input font):

- The search input is currently `min-height: 44px` (`+page.svelte:649-659`) — already under the
  rule. Fix it to 48px as part of this change.
- Give the input a programmatic label; give the Places group and each bird group a real heading so
  the results are navigable structurally.
- Announce the result summary and focus changes via `aria-live="polite"`.
- Focus actions must be real keyboard-reachable `<button>`s at ≥48px; the dismiss control needs an
  accessible name ("Clear place focus"), not a bare `✕`.
- Full combobox semantics are **not** required — the results are ordinary downstream groups, not a
  popup listbox — but the input↔results relationship must still be announced.
- 390px checks: long eBird names, metadata wrapping, no horizontal overflow, card/map stacking.

### 4. Home wiring — `src/routes/+page.svelte`

- Placeholder → `"Search birds or places…"`; count line reports places **and** birds.
- Render `PlaceMatches` above the "Rare this week" section whenever `searching && placeHits.length`.
- **Focus mode** (`focusKey: string | null`): when set, filter `notableShown` / `needsMatched` to
  species having a place with that key, restrict each species' rendered `places` list to that one
  place, and restrict `mapPoints` to the focused place. Filtering must produce new arrays and never
  mutate `PageData`.
- A dismissible chip: `📍 Huguenot Memorial Park ✕` (styled like `.reset-home`, ≥48px tap target per
  the CSS conventions in `cs.md`; accessible name per §3).
- **Escape hatch** when no in-range place matches: an anchor to
  `/?place=…&dist=…&back=…` labeled _"No place in the loaded reports matches "Hugenot" — search it
  as a location instead →"_. It reuses the existing geocode path; after geocoding, the existing
  searched-origin species-context plumbing (`+page.svelte:53-71`, `species-context.ts:68-85`)
  carries the new origin correctly, so there is no conflict there.
  **Correction (rev-3 was wrong): this does NOT work without JS**, and the claim is withdrawn
  rather than left as an untested aspiration. The anchor is rendered only when a typed query
  produces zero place hits, but the in-page filter is client state — SSR always renders it empty,
  and without hydration nothing can ever change it, so the link is statically unreachable with JS
  off. The whole place-search feature is JS-required by construction; only the top "Place" form
  (a real GET form) works without it, and that form is the no-JS path to the same geocoder.
  **Build the URL with `URL`/`URLSearchParams`, never string interpolation** — a raw query
  containing `&`, `#`, `?`, quotes, or existing percent-escapes would otherwise change the query's
  meaning.
- Empty-state copy in both sections must account for place filtering (currently hardcodes
  `No needs match "{q}"`), and must say **"in the loaded reports"** rather than asserting the place
  has no reports — see the completeness caveat in Context.

#### 4a. Focus vs. the typed query — precedence, stated explicitly

Focusing a place while `q` still reads `"hugenot"` cannot AND the place predicate with the existing
species-name predicate: no species is named "hugenot", so both lists would render empty. **While
focused, place membership replaces the species-name predicate entirely.** The typed text stays in
the box (so the Places group and the escape hatch remain visible and the user can pick a different
place), and dismissing focus restores plain species-name filtering on that same text.

Focus must also be **self-healing**: any navigation that changes radius, window, or place produces a
new index, and the focused key may no longer exist in it. On a new `data.view`, if `focusKey` is
absent from the rebuilt index, clear focus (and its URL param) rather than rendering an
indefinitely-empty page.

Mechanism, stated precisely so it cannot loop: focus is a `$derived` read of `loc` from `page.url`
(§4d), and self-heal is a **narrowly guarded `$effect`** that fires only once the new index actually
exists — never transiently while `data`/the index is still rebuilding — and repairs by navigating to
the `loc`-less URL with `replaceState: true` (one history entry consumed, not added). Because the URL
is the single source of truth under §4d, the repair is idempotent: after it lands, `loc` is gone from
`page.url`, so the effect's guard is false and it cannot re-fire.

#### 4b. Map behavior in focus mode

The rev-1 claim that "`ObsMap` re-fits bounds, so the zoom is free" is **false** as written.
`renderMarkers()` does `if (center) bounds.extend(center)` (`ObsMap.svelte:89-90`), and Home passes
the searched/home location as `center` _and_ also pushes it as a `kind: "home"` point
(`+page.svelte:83-91`). Filtering pins to a distant focused place would still fit the original
origin plus that place — a wide view, not a zoom. In focus mode therefore:

- emit **one aggregate marker for the focused place**, not one marker per species — otherwise every
  species at that place stacks coincident pins on the same coordinate, which is both unusable and a
  degenerate bounds case;
- **pass `center = null`** in focus mode (rev-2 said to pass the focused coordinates — that was
  still wrong). `ObsMap` computes `total = pts.length + (center ? 1 : 0)` and calls
  `fitBounds` whenever `total >= 2` (`ObsMap.svelte:124-126`) — it counts **entries, not unique
  coordinates**. "Focused center + one marker at those same coordinates" therefore yields
  `total === 2` and runs `fitBounds` on a **zero-area bounds**, which is exactly the degenerate case
  the bullet above claims to avoid. With `center = null` and a single marker, `total === 1` takes the
  `setCenter` + `setZoom(11)` branch (`:127-130`) — a deterministic, predictable focus zoom.
- The alternative (teach `ObsMap` to count _unique_ coordinates, or give it an explicit focus/fit
  prop) is cleaner long-term but is a component API change; take it only if the `center = null` route
  conflicts with the surrounding section's render guard.

#### 4c. Map pin de-duplication bug this change would otherwise introduce

`mapPoints` builds `notableCodes` from **`notableAll`** (`+page.svelte:84`) and then skips any need
pin for those species (`+page.svelte:107-112`). That is correct while both lists are filtered by the
same species predicate, but once place filtering narrows the lists independently, a species that is
notable _somewhere else_ and needed _at the focused place_ would lose its legitimate need pin.
De-duplicate against the **rendered** `notableShown`, not `notableAll`.

**Ordering matters — do not mix the two marker strategies.** §4b's focused branch emits a single
aggregate place marker, so species-code de-duplication does not apply there and must be bypassed
entirely; this rule governs only the branches that still emit per-species pins (unfocused, and
searching-without-focus). Compute one or the other, never both.

#### 4d. URL state — a plain `goto('?loc=…')`, with `loc` deliberately untracked

Both earlier revisions got this wrong, in opposite directions. Recording why, because the reasoning
is what keeps rev-4 from regressing it:

- **Rev-1: `#loc=` + native `history.replaceState`.** Unworkable. `replaceState` creates no history
  entry, so Back could never clear focus (while the text claimed "back-button friendly"); it
  dispatches no `hashchange`/`popstate` of its own; and SvelteKit 2.65 monkey-patches both native
  history methods to warn — _"Avoid using `history.pushState(...)` and `history.replaceState(...)` as
  these will conflict with SvelteKit's router"_ (`client.js:110-121`).
- **Rev-2: shallow routing via `pushState` from `$app/navigation`.** The premise was right and is
  confirmed from vendored source — `pushState` calls `history.pushState` and updates only
  `page.state`/root (`client.js:2451-2488`); it never resolves a route, compares params, or runs
  `load`. But the state model built on it was false: **`pushState` does not assign `page.url`**. It
  stores `[PAGE_URL_KEY]: page.url.href` — the URL of the last _real_ navigation (`:2472-2477`) — and
  on a shallow pop the router restores `page.url` from that stored value, not from `location`
  (`:2828-2851`). So `page.url` and the address bar diverge, and rev-2's "hydrate from `page.url`,
  `page.state` unused" cannot observe a client-selected `loc` at all. Query + "`page.state` unused"
  is the uniquely broken combination.

**The real cause is one line, and removing it dissolves the whole problem.** SvelteKit tracks load
dependencies per URL access: `searchParams.get/has/getAll` records a **single key**, while any read
of `href`/`pathname`/`search`/`toString`/`toJSON` marks the **entire URL** as a dependency
(`make_trackable`, `src/utils/url.js:94-140`), and a node reruns only when something it tracked
changed (`client.js:1078-1095`). The root loader already tracks `place`, `back`, and `dist`
individually (`+page.server.ts:37,38,75`) — and then reads `url.search` at line 137 purely to mint
`returnTo`, which marks the whole URL and is why _any_ param change reruns `geoTargets()`.
`+layout.server.ts` tracks no URL at all.

So: **move `returnTo` minting out of the server loader** (§4e), leaving only per-key tracking. `loc`
is then an untracked param, and an ordinary navigation that changes only `loc` reuses the existing
server data. That buys the same "no `load` rerun" that motivated the hash and then shallow routing —
without either:

- Entering or changing focus → `goto(urlWithLoc, { keepFocus: true, noScroll: true })`. A real
  history entry, real Back/Forward, and `afterNavigate` actually fires (shallow routing never calls
  it — `pushState`/`replaceState` only touch `page.state`/root, and the shallow pop branch returns
  before `navigate`, `:2836-2851`).
- Self-heal / normalizing a stale `loc` → the same `goto` with `replaceState: true` (§4a).
- Cold load, reload, or a shared link of `?loc=…` → an ordinary SSR load; the server parses `loc` for
  the initial render, so focus is server-rendered with no `onMount` dance and no hydration mismatch.
- **`page.url` is now genuinely the single source of truth** — it is assigned on every real
  navigation (`client.js:1903`, `:2931`), which is exactly what shallow routing declined to do. No
  `page.state`, no second carrier, no canonicalizer needed to keep two producers agreeing.
- **One mechanism covers every case** — first focus, focus change, Back, Forward, reload, and
  reload-then-Back. That last case is the one rev-2 silently got wrong: after a reload
  `has_navigated` is false and dropping a query param is not a hash change, so a shallow pop would
  have fallen through to a full `navigate` (`:2832-2840`) and — with line 137 still present — rerun
  the server load. Under this design there is no shallow/non-shallow split to fall out of.

**Gate this before building anything else.** The whole design rests on "a `loc`-only navigation does
not rerun the root loader." Verify empirically first, in one click: focus a place and confirm the
network panel shows **no `__data.json` request** and the server logs **no `geoTargets` run**. If that
fails, stop — the fallback is rev-2's shallow design with the focus carried in `page.state`
(`pushState(url, { focusKey })`, `page.state` first with a `page.url` fallback for cold loads, and an
explicit `{ focusKey: null }` on self-heal so a stale cold-load `loc` cannot loop), and the plan pays
item 4d's reload-then-Back cost.

#### 4e. Species round-trip — one `returnTo` producer, in the component

`returnTo` is currently `homeUrlWithQuery(url.search)` computed **server-side** (`+page.server.ts:137`)
and handed to the page as `data.returnTo`. Under §4d the loader does not rerun on a focus change, so
a server-minted `returnTo` would be stale the moment a user focuses a place: tapping a bird and
pressing "← Home" would restore the radius and window but drop the focus, breaking the round trip the
ticket promises.

Rev-2 proposed patching this by minting a _second_ `returnTo` client-side while keeping the server
one — two producers that had to agree byte-for-byte. Drop that. **Delete `returnTo` from the loader's
return value and mint it once in `+page.svelte` from `$app/state`'s `page.url`**, which is populated
under SSR as well as on the client, so there is no SSR/CSR divergence and no parity problem to test.
This is also precisely the edit that untracks `loc` in §4d — the fix and the enabler are the same
change.

- `homeUrlWithQuery` itself **stays** in `src/lib/return-link.ts` — the `/targets` compatibility
  redirect still uses it. Only the root loader's call goes away.
- `safeReturnTo` needs no change: it already accepts any local absolute path
  (`return-link.ts:40-49`), and `/?place=…&loc=…` is one.
- Use a single shared helper for inserting/removing `loc` so the focus link, the dismiss link, and
  `returnTo` cannot drift, and so `loc` is **replaced rather than duplicated** when focus changes.
- Tests: focused round trip returns to the focused view; `place` values containing spaces and
  Unicode survive; changing focus replaces `loc` instead of appending a second one.

### 5. Two shape-only server additions (the "zero server changes" claim is withdrawn)

Rev-1 claimed no server changes. Two findings make that untenable, and both are **shape-only** — no
new eBird calls, no new queries, no schema change, so the eBird "sacred rules" still hold:

1. **`isHotspot` on `SpeciesPlace`.** `geoTargets` already holds the complete verified hotspot set
   (`needs.ts:408-420`) and already threads `hotspotLocIds` into `buildView`. Annotate the flag onto
   each `SpeciesPlace` inside `aggregate()` instead of having the client reconstruct a partial set
   from `bestPlaces` (see §3). **Also thread it into the enrichment path** — the second `aggregate()`
   call inside `enrichNeedsWithSpeciesReports` (`needs.ts:305-311`) currently receives no hotspot
   set, so enriched places would otherwise come back with the flag cleared.
2. **A partial-enrichment signal.** `enrichNeedsWithSpeciesReports` returns `{ needs, stale }` but
   its `catch { return need; }` (`needs.ts:291-314`) sets neither. Return an additional
   `enrichPartial: boolean` (set in the catch) and surface it on `TargetsView`, so the UI can say
   "some locations may be missing" instead of asserting a place is absent when the fetch for it
   simply failed. Without this the feature confidently reports a false negative.

If either turns out to be more invasive than it reads at implementation time, the fallback is to
**drop the hotspot badge** and **keep the softened copy** — not to ship a badge or a "no match"
message that is knowably wrong.

### 6. Files touched

| File                                                         | Change                                                                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/place-name.ts`                                      | **new** — moved normalizer/tokens/`placeNameScore` + `placeQueryMatches`                                                                                                          |
| `src/lib/server/location-placeids.ts`                        | import + re-export from `$lib/place-name`; delete the local copies                                                                                                                |
| `src/lib/place-search.ts`                                    | **new** — `placeKey`, `buildPlaceIndex`, `searchPlaces`, `speciesAtPlace`                                                                                                         |
| `src/lib/components/PlaceMatches.svelte`                     | **new** — places result group                                                                                                                                                     |
| `src/routes/+page.svelte`                                    | unified search, place group, focus mode, escape hatch, `goto`-driven `?loc=`, `returnTo` minted here from `page.url`, map center/dedup fixes, 48px input                          |
| `src/routes/+page.server.ts`                                 | parse `loc` for the SSR-focused first render; **delete `returnTo: homeUrlWithQuery(url.search)`** — the whole-URL read that forces a loader rerun on every param change (§4d/§4e) |
| `src/lib/server/needs.ts`                                    | `isHotspot` on `SpeciesPlace` (both `aggregate()` call sites); `enrichPartial` on `TargetsView`                                                                                   |
| `src/lib/server/location-placeids.test.ts`                   | **golden cases added before the move** (normalizer/tokens/score)                                                                                                                  |
| `src/lib/place-search.test.ts`, `src/lib/place-name.test.ts` | **new** unit tests                                                                                                                                                                |

No schema, migration, or eBird-client changes, and **no new API calls** — the server additions are
shape-only, so this adds zero request volume per the eBird "sacred rules" in `cs.md`.

## Verification

Rev-1's verification was materially thinner than the risk. Expanded:

1. `npm test` — new unit tests pass, plus the **golden normalizer/tokens/score cases added before
   the move** (§1). `location-placeids.test.ts` passing unchanged proves the _import path_ survived,
   **not** that behavior did — its two threshold assertions (lines 4-12) are too coarse to be that
   proof, which is why the golden cases exist.
   Unit coverage to add: focus **replacing** (not ANDing) the species predicate; focused list
   place-restriction without mutating `PageData`; `placeKey` identity (locId-vs-null, coordinate
   jitter, conflicting names); short-token false positives; diacritic folding; the result cap; URL
   construction with `&`/`#`/quotes/Unicode in the query; `safeReturnTo` on a focused
   `"/?place=…&loc=…"`.
2. `npm run check` — svelte-check, **0 errors / 0 warnings**.
3. `npm run build` — required by `cs.md` after code changes; rev-1 omitted it.
4. `npm run lint` — `prettier --check` on the new `.ts`/`.md` files. Known repo-wide gap: no Prettier
   config registers `prettier-plugin-svelte`, so no `.svelte` file in this repo can be parsed; match
   surrounding style by hand for the `.svelte` edits.
5. `npm run test:db:up && ANTHROPIC_API_KEY=… npm run dev:test` → `http://127.0.0.1:5178`
   (the global CLAUDE.md env-blanking gotcha applies to server-side API calls).
   - Type a partial/misspelled place name present in the current view ("hugenot") → Places group
     appears above the bird results with correct needs/rarity counts and distance.
   - Focus a place → map **centers and zooms on that place** (home point dropped, one aggregate
     marker), both species lists narrow to species reported there, chip shows, `?loc=` appears in
     the URL, and **no new server request fires** (network panel).
   - **The §4d gate, first and before anything else is built**: focus a place and confirm the network
     panel shows **no `__data.json` request** and the server logs **no `geoTargets` run**. If it
     fails, fall back to the shallow design named at the end of §4d rather than proceeding.
   - **Full history matrix** — each case must be checked for both correct focus and whether the
     server loader reran:
     | Case | Expected |
     | --- | --- |
     | Focus L1 from unfocused Home | focus set, no loader rerun |
     | Focus L1 → L2 (change focus) | `loc` replaced not duplicated, no loader rerun |
     | Back (L2 → L1), then Back again (→ unfocused) | focus restored then cleared, no loader rerun |
     | Forward after either Back | focus restored, no loader rerun |
     | Cold load / shared link of `?loc=…` | focus server-rendered, exactly one ordinary load |
     | **Reload while focused, then Back** | focus cleared correctly — the case rev-2 got wrong |
     | Stale/invalid `loc` (cold, or after a radius/window/place change) | one guarded `replaceState` repair, no loop, no extra history entry |
   - **Focused species round-trip**: focus → tap a bird → "← Home" returns to the _focused_ view.
   - Notable/need overlap: a species notable elsewhere but needed at the focused place keeps its
     need pin.
   - Type a species name → behaves exactly as before; mi/km toggle propagates into place metadata.
   - Type a place _not_ in the loaded reports → escape-hatch link appears and re-centers via the
     geocoder. (Do NOT expect this to work with JS disabled — see §4; the top "Place" GET form is
     the no-JS path, and it is unchanged by this work.)
   - State matrix: owner **and** viewer; empty / new-user / no-key / base-error (search absent with
     `view = null`); **stale cached** view; and a **simulated per-species enrichment failure** to
     confirm the partial-enrichment copy.
   - 390px: keyboard reachability, screen-reader announcement of results and focus, ≥48px targets
     (including the corrected search input), no horizontal overflow.
6. Devlog entry under `docs/devlog/`, then `td review 601faf`.
