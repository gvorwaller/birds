# Birds UX phase 2B — comparable hotspot rankings

September 19, 2026 · Parent td-8ff597 · Finding F13
Status: implemented and independently reviewed as td-f730cf; awaiting owner release instruction. See [review evidence](phase-02b-review.md).

## Result

A location's count must come from that location's own eBird recent reports,
with the same selected window, life-list filter and report policy applied to
all compared hotspots. The area feed is a quick preview, not a fair ranking
of every hotspot. Keep it fast and usable, but label its limits.

Add an explicit **Compare hotspots** action to the trip planner and Home's
Best places area. This starts progressive, cache-first comparison of EVERY
verified hotspot returned for the selected radius, without blocking initial
page rendering. Show progress and gaps. No automatic fan-out on page load.
A user can pause/continue and retry failures. No hidden candidate cap.

In the planner, comparison must NEVER change the selected route, saved count
tokens, name or notes in the background. After a complete fresh comparison,
**Use compared ranking** explicitly replaces the planner's automatic choices
with the highest-count eligible verified hotspots. Until that click, the
existing area-preview route and its original tokens remain untouched.

## Confirmed source and scope

- `src/lib/server/query-engine.ts`: runQuery, buildCandidates and
  assembleTripPreview currently group the area-feed observations by location.
- `src/routes/trips/plan/+page.server.ts` issues phase 2A signed v1 snapshots;
  its save action verifies account, scope, identity and count atomically.
- `src/routes/trips/plan/+page.svelte` currently derives selection from
  data.query and planSig. Keep background comparison out of that signature.
- Home `src/routes/+page.server.ts` and `needs.ts::geoTargetsBase` already
  stream per-species enrichment. Keep this existing path and its cancellation,
  activity sorting, personal sightings, species detail and filters intact.
  Home BestPlaces currently uses only base.view.bestPlaces, so explicitly label
  it as an area preview and provide the shared hotspot comparison beside it.
  Do not pretend per-species enrichment is a complete hotspot comparison.
- `ebird.ts::recentHotspotObs` uses hotspotObs2 cache, includeProvisional=true;
  `notableObs` accepts an eBird region/location code for the notable endpoint.
  `hotspotsNear` provides the reference universe, not observation-id prefixes.
- Existing shared TTL/in-flight eBird cache is authoritative. Preserve it.
- No DB schema migration required: existing nullable JSONB stores versioned
  context. No legacy backfill. No changes to production in this phase.

API reference: https://documenter.getpostman.com/view/664302/S1ENwy59 (linked
by Cornell's data-products page). Existing helpers plus a real test request
must verify the location notable endpoint before claiming rare-mode support.

## Product decisions and comparison contract

1. Universe: deduplicated valid hotspot references from hotspotsNear at the
   executed center/radius, filtered with the existing radius +0.5km tolerance.
   Preserve exact requested and two-decimal upstream center semantics. Never
   drop locations because numSpeciesAllTime/latestObsDt is absent or old.
   A reference error is unavailable, not a zero-hotspot successful comparison.
   Stale reference data is visible and prevents a fully fresh completion claim.
2. Counts: distinct speciesCode at each hotspot from recentHotspotObs for the
   chosen daysBack, includeProvisional=true. My needs removes the scope owner's
   actual seen set; All species does not. Rare-only uses that hotspot's own
   notableObs response, never an intersection with the area-feed's locations
   or a set of regionally rare species. Count only rows whose locId matches the
   requested verified hotspot. Never mix private/other locations into a count.
3. State per hotspot: unqueried, fresh, stale, failed. An empty successful
   response is a **reported zero**, not unavailable or biological absence.
   Missing/malformed/failed response is never zero. Reference and observation
   validation must reject malformed top-level payloads and malformed essential
   count/identity fields before a successful result is reported. Keep source
   species lists reachable, including unconfirmed flags where supplied.
4. Ranking: successful rows sorted by count descending, latest report descending,
   distance ascending, then location id as stable tie-break. Stale rows visibly
   marked; failed/unqueried rows separately reachable, never numeric zero.
   Display that public reports include unconfirmed records and aren't a full
   inventory or promise a bird is present. Never call a count an abundance.
5. Progress: N checked of M hotspots, fresh/stale/failed/unqueried counts,
   selected All/My needs, days, radius and report policy. aria-live polite.
   Complete means every reference location yielded a fresh response AND
   reference is fresh; no stale/failed/unqueried locations. Empty universe gets
   explicit no verified hotspots, not an Apply button. Partial/stale results
   retain visible coverage and an explanation. No silently reduced universe.
6. Controls: start, pause, continue remaining, retry failed/stale. Work runs in
   batches of at most FOUR locations, sequential batch requests, up to FOUR
   server-side comparison fetches in flight process-wide (shared limiter).
   Release limiter slots in finally. Rate-limit/auth errors (401/403/429) stop
   additional scheduling, including when stale cache fallback exists; preserve
   landed results and display the reason. Retrying is explicit, no busy loop.
   If cachedFetch needs an optional refreshErrorStatus to retain this reason,
   add it compatibly and cover with tests. Never expose upstream credential text.
7. Navigation/query changes abort the browser request and stop new scheduling;
   server checks cancellation before each queued task. Shared cached in-flight
   calls may finish for cache reuse, never cancel someone else's shared fetch.
   No late result can overwrite a new query. Per-query identity includes actual
   account/scope as appropriate, center, window, radius, All/Needs and rare mode.
   Pause preserves results and selections. Returning later can restart via cache.
8. Cache/deadline: reuse existing endpoint TTLs and coalescing, with bounded
   HTTP deadlines (existing 45s ceiling is acceptable per batch); no uncapped
   parallel promises. Each batch only runs its declared <=4 locations, so
   browser pause/navigation can't leave hundreds of requests scheduled server-side.
   A cached warm repeat must avoid new provider calls for fresh data. No total
   cap or automatic truncation. No credentials in client responses/logs/URLs.
9. Initial area preview stays available for manual/quick planning, clearly
   labeled incomplete evidence (including preview auto-selection). All existing
   private/unverified candidates remain manually accessible. Comparison is of
   verified hotspots; it must not silently convert other locations to hotspots.

## Server and API boundary

Add shared client-safe types/pure aggregation and a server comparison service.
Use authenticated GET `/api/hotspot-comparison` (read-only, viewers allowed).
Parameters: explicit finite bounded lat[-90,90], lng[-180,180], radiusKm[1,50],
daysBack integer[1,30], seenStatus exactly all|needs, rareOnly exactly 0|1,
anchorLabel nonempty <=200 chars. No hidden meaning-changing defaults.
No ids means initialization: return reference locations plus fetchedAt/stale,
without location-observation fan-out. Batch ids must be 1..4 unique valid ids,
all members of that server-resolved reference universe; reject unknown,
duplicate, oversized or malformed ids before any location fetch. Ignore any
client count, credentials, user/scope parameters; use locals.user/scopeId.
Reject missing auth. Missing key is explicit unavailable with Settings link.
Initialization also returns a server-derived comparison identity (hash of the
normalized filters, account/scope, sorted reference ids/coords and, in Needs
mode, sorted seen species). Each batch must carry that identity; revalidate it
before observation requests. If the life list or reference universe changed,
return an explicit restart-required response instead of combining different
comparison scopes. Do not include raw seen lists in the client identity.
Return Cache-Control private,no-store. GET requests mutate only the ordinary
upstream cache; no trip/list mutation. Do not widen the viewer POST exemption.

Each successful row carries candidate identity/coords from reference, full
matched species, count, actual per-location fetchedAt/stale, and signed v2
snapshot token for this actual account/scope. Empty successful rows count zero
and can have a valid token. Per-row errors are structured, sanitized and
retryable; account/rate-limit problems additionally stop the batch controller.
Do not hydrate missing Google place ids with serial external lookups here.
Use cached/batched lookup or null (coordinate MapLinks remain usable).

## Saved context version 2

Keep v1 parse/format/signature behavior and old saved rows fully compatible.
Add strict v2 with source `hotspot-recent` or `hotspot-notable`, explicit
reportPolicy `including-unconfirmed`, same All/Needs, days, anchor search
context, verified location id/coords, count, fetchedAt/plannedAt/stale.
Use discriminated version/source validation; v2 locationId is required.
Keep 24-hour account/scope-bound HMAC and existing stop matching. The signed
context is per-stop report evidence; do NOT trust browser coverage counts or
claim a completed comparison merely because the stop has a v2 token.

Display: When planned: N species/needs reported at this hotspot · last D days
· includes unconfirmed reports · fetched timestamp [stale if appropriate].
Optional search-area context must be clearly a location-selection area, never
claim the per-hotspot count came from every location within that radius.
Existing independent Now nearby counts, legacy wording, exports and public
sharing continue to work through the shared formatter. No new migration.

## Client integration details

Create one shared comparison component/controller used by Home and planner,
with scoped CSS, >=48px controls, >=16px inputs, phone-width layout, accessible
status and no toast. It owns query cancellation, progressive state and retry.
Initially show summary/action; while comparing show ranked rows plus expandable
all-result/unknown lists. A collapsed first-five preview needs an explicit
Show all N; never remove rows/data from the underlying result.

Home: retain the fast area preview with honest heading/explanation, then let
comparison display the ranked hotspot counts (My needs, current center/window/
radius). It must be available even when base needs/bestPlaces is empty, as that
feed is not evidence that all hotspots have no needs. Missing key/location
shows existing setup guidance. Do not auto-start 246 requests for never-synced
accounts; explicit action is enough. Preserve current Home enrichment path.

Planner: display comparison between filters and route/candidate controls so it
is discoverable. Comparison callback/results are separate from active route
state. Use compared ranking is enabled only for fresh complete nonempty universe.
It replaces active verified candidates with fresh compared candidates, preserves
all original other reported locations, and uses new per-stop v2 token map.
Top eligible verified candidates get selected, bounded by requested stops;
route ordering remains nearest-neighbor. Existing requested historical stop
may be retained without automatically fetching/replacing it. Explain if fewer
eligible hotspots exist. The explicit action may replace deliberate selections
because its label/text explains that; merely completing or retrying must not.
Keep trip name field and historical toggle stable during background work.
Retained unverified preview candidates keep their original v1 tokens. Manual
selection and save after Apply must serialize exactly displayed source/count.
When a NEW plan loads, reset comparison and active candidate/token state to the
new plan; never let old query results leak. Same-query background updates must
not silently overwrite curation.

## Acceptance and implementation handback

Unit/route tests must cover actual service/handler and controller boundaries:
- area feed undercounts a known hotspot; per-location count wins, distinct-species
  deduplication, All/Needs, notable separate feed, zero vs failure, malformed rows;
- complete/partial/stale/reference-failure/unqueried classification and stable
  ordering; all candidates retained beyond first-five and beyond batch four;
- batch validation before provider calls, auth/scope/viewer reads, no key,
  rate-limit/auth stopping (including stale fallback), concurrency max4,
  cancellation skips queued work, warm cache reuse and coalescing;
- v1 compatibility; v2 strict parse/format/signing; tamper/expiry/cross-account/
  changed-count rejection and actual planner save accepting v2 JSONB;
- client query supersession, pause/resume/retry, completion without automatic
  selection mutation, explicit apply changes route/tokens and preserves other
  candidates; Home initial empty preview still offers comparison.

Run only focused tests, npm run check (zero errors/warnings), npm run build,
and git diff --check. Do NOT run broad database suites or wipe seen fixtures.
User accepts the separate 12 broad-suite failures as nonblocking; that isn't a
waiver of new/affected tests. Test database already contains real prod-copy
lists, valid re-keyed eBird credentials, worker and caches, explicitly authorized
by user. Preserve 227-species owner list; record before/after count.

Primary reviewer will independently exercise test at 127.0.0.1:5178: real
Huguenot comparison (all reference hotspots), cold/missing vs warm cache timing,
All/Needs/rare, mid-run pause/retry, curated route unchanged until explicit Apply,
save/reload v2 + JSONB + export, v1 legacy compatibility, Home at desktop/390px,
viewer access, no-key/failed behavior and navigation cancellation. No synthetic
observations inserted into DB. Failure injection may use test mocks/browser
routing and must be explicitly labeled. Keep production untouched.

Update Help and About with plain-language controls/limitations. No commit/push/
deploy. Primary owns this spec, roadmap, review record, devlog and td status;
lower-cost implementer owns application changes and focused tests. Report exact
files/checks, limitations and questions. A handoff is not independent approval.

## Pre-implementation live evidence

September 19 test-key probe: 246 hotspot references at 30.41,-81.42/40km;
Huguenot Memorial City Park L127286 returned 73 distinct species from its
30-day recent feed (HTTP200, 219ms), and four notable rows for three distinct
species (HTTP200, 122ms). All rows matched L127286. Owner life list: 227.
These are dated observations, not fixed expected totals. Raw secrets never
left the server-side probe. Evidence: phase02b-endpoint-probe.json.
