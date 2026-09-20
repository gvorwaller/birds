# Phase 9A: All, Need and Seen

September 20, 2026 · Frozen implementation specification · parent td-8ff597

## Outcome

Make the meaning of every Field Guide result list explicit. A person can switch
the current query, filters and Phase 8 geography among **All**, **Need** and
**Seen** without losing place, filter or return-navigation state.

This is the first bounded adoption of the shared species-row hierarchy. It
covers the Field Guide and all country, region, county, verified-hotspot and
map/radius result lists already delivered there by Phase 8A. It does not change
Home, Forecast, hotspot Recent/Monthly lists, trips or personal collections;
those surfaces are audited here and remain later slices.

## Verified starting point

The current production-like snapshot establishes examples, not permanent
product constants:

- Florida historical coverage returns 632 All species: 193 Seen and 439 Need
  for the owner list.
- Myakka Island Point - MPI returns 108 All: 98 Seen and 10 Need.
- The linked viewer has zero personal `seen_species` rows but sees the same
  Florida owner-list classification (the first alphabetical page contains the
  same 37 Seen rows). The owner has 227 life-list rows in this snapshot.
- Field Guide already intersects geography before its 100-row pagination and
  already displays a stable row target, photo/unavailable state, common and
  scientific names, Seen/Need, Viewed, Special interest and match provenance.

Acceptance must use controlled fixtures for exact assertions. Snapshot counts
are remeasured and labeled with their date; they must not be hard-coded.

## List-scope contract

Use one query parameter named `list` with values `all`, `need` or `seen`.

- **All** is every species supported by the current Field Guide dataset after
  applying text, tags, family, Special-interest and geography filters.
- **Need** is All minus species in `seen_species` for the request's display
  scope owner (`locals.scopeId`).
- **Seen** is All intersected with that same display scope owner's life list.

The parameter is presentation/read scope only. It never writes a life list,
starts a job, refreshes data or calls eBird.

An absent `list` means All for backward-compatible links. An explicit
`list=all` is canonical and useful when All alone activates browsing. Reject
unknown, blank or repeated `list` values with HTTP 400; never guess or silently
drop them.

On the otherwise blank `/species` landing page the control is visible, but the
existing prompt remains until a person chooses a scope or another search/filter.
Following the All control creates `list=all` and opens the complete taxonomy
with normal 100-row pagination. Need or Seen alone similarly browses the whole
current taxonomy under that scope. Existing search/filter/location links with
no `list` continue to show All.

Retired life-list codes are not injected into Seen. A species first has to be
in the same taxonomy/filter/location candidate set as All. Missing historical
coverage continues to produce the Phase 8 unavailable/partial explanation; it
must not be converted into a zero-species or zero-Need claim.

## Account and badge boundaries

Life-list classification follows the existing displayed-list contract:

- normal accounts use their own `locals.scopeId`;
- a viewer linked through `views_user_id` uses that configured owner's list for
  All/Need/Seen and for the row's Seen/Need badge;
- a viewer's own zero or differing `seen_species` rows must not change those
  results; and
- no other user's life-list membership or count is exposed.

Personal browsing state remains attached to the signed-in account ID, exactly
as today: Viewed and Special-interest badges/actions for a viewer are the
viewer's own. Do not replace those calls with `scopeId`.

## Query, count and pagination behavior

Apply list scope inside the database candidate query before `count(*) over`,
ordering, `LIMIT` and `OFFSET`. Do not fetch All and filter a page in memory.
The existing relevance/name/taxonomic order must be unchanged within each
scope.

Every result summary names the selected scope, for example:

- `Showing 1–100 of 439 Need species`
- `Showing 1–98 of 98 Seen species`
- `No Need species match these filters`

The selected location and coverage explanation remain adjacent to that count.
Page links preserve `list` and every other current or unknown parameter.
Changing list scope removes only `page`, targets `#results`, and preserves the
full text, tags, family, sort, Special-interest and Phase 8 location/map state.
Past-end pages remain a 404 rather than falling back to page one.

Search, filter, location and no-JavaScript form submissions preserve the
selected list scope. `Clear location only` preserves it. `Clear all search and
filters` also preserves it because list scope is not a search filter; choosing
All is the explicit way to leave Need or Seen.

The Field Guide has no export today. Do not invent one in this slice. The audit
must record that any future Field Guide export will need to name and carry the
same `list` scope.

## Control and row presentation

Place a server-rendered, keyboard-usable All / Need / Seen control after the
Field Guide section tabs and before the compact search/filter summary. Use
links so it works without JavaScript, expose the selected item with
`aria-current`, provide an accessible group/navigation name, retain visible
focus, and keep each target at least 48px high at 320, 390 and desktop widths.
Do not use color alone to indicate selection.

The first shared species-row component must preserve this information order:

1. reference thumbnail, or the honest existing unavailable state;
2. common and scientific names;
3. Seen/Need, then other personal badges such as Special interest and Viewed;
4. result/evidence meaning such as banding-code or text-match provenance,
   family/tags and the existing short field note; and
5. the stable `guide-species-{code}` row target and complete return URL.

Adopt that component for every Field Guide result, including Phase 8 location
results. Preserve source/license credit and failed-image behavior. A missing
thumbnail is not an empty broken image and never removes the row.

Add a short audit table to the review record for Home, Field Guide, Forecast,
hotspot/location detail, trips and personal collections. Mark only Field Guide
as adopted in 9A. Do not refactor untouched lists or claim app-wide uniformity.

## Navigation and state

Opening a species detail carries the exact source URL including `list`, page,
all filter/location parameters and `#results`. Returning restores the exact
row target and focus through the existing navigation-context contract.

Scope switching preserves unknown query parameters and repeated unknown
key/value pairs. It must not preserve a stale page. Browser reload, copied URL,
native no-JavaScript submission and the iOS-PWA-style path navigation all
resolve to the same list.

## Documentation

Update Help where it explains Field Guide lists and geography: define All,
Need and Seen, explain that Seen/Need follows the displayed life list for a
viewer, and keep historical coverage language intact. Add a concise Version
History entry in About. Record the bounded surface audit and test/review proof
in a Phase 9A review document and today's devlog.

## Automated acceptance

Use deterministic isolated-DB fixtures and test at least:

1. all/need/seen are a disjoint complement over the identical candidate set;
2. scope is applied before the 100-row limit, exact count and pagination;
3. text, tag, family, Special-interest, country, region, county, hotspot and
   antimeridian-safe map/radius filters combine with each scope;
4. zero historical coverage remains unavailable/unknown in all scopes;
5. owner and linked viewer receive identical displayed-list membership while
   viewer Viewed/Special-interest state remains personal;
6. retired and out-of-candidate seen codes never enter Seen;
7. malformed, blank and repeated list parameters return 400; a past-end page
   returns 404;
8. all forms, toggle links, clear links and pagination preserve the required
   known/unknown state and clear only stale `page`;
9. row hierarchy, unavailable thumbnail, photo credit and stable IDs survive
   component extraction; and
10. no read journey writes data, queues work or makes an eBird request.

Run focused Field Guide/location/server tests, then `npm run check`,
`npm run build` and `git diff --check`.

## Browser acceptance

Test authenticated owner and linked-viewer journeys in Chromium and WebKit at
320px, 390px and desktop, including JavaScript disabled:

- Florida All → Need → Seen, with exact counts and no lost location;
- Myakka Island Point All/Need/Seen and page navigation where applicable;
- a controlled result set beyond 100 rows;
- an empty Need or Seen result with scope-named recovery text;
- a no-coverage location whose status remains unknown/unavailable;
- a species detail round trip from page 2 back to the exact row;
- search, filter and location form changes while Seen or Need is selected;
- copied/reloaded URLs and repeated unknown parameters; and
- 48px targets, visible focus, no horizontal overflow, no page errors and no
  unintended writes, jobs or eBird calls.

## Explicit non-goals

- Reported-recently versus historically-expected controls (Phase 9B).
- Home, Forecast, hotspot Recent/Monthly, trips or collection-row migrations.
- Viewer owner-selection administration (Phase 10C).
- New export formats, new life-list writes, new geographic inference, fresh
  eBird loading, ranking changes or a silent row cap.

## Sequence gate

CC1 is the sole implementation writer. Codex primary reviews the complete diff
and focused evidence; GROK then receives an independent read/test-only charter.
Confirmed defects return to CC1 and affected journeys return to GROK. Phase 9B
does not begin until Phase 9A has no unresolved P0-P3 findings and its child td
is in review. Do not commit, push or deploy Phase 9A without a new owner request.
