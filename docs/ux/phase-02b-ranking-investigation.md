# Birds UX phase 2B — ranking investigation notes

September 18, 2026 · F13 under td-8ff597 · Not an implementation specification

Phase 2A deliberately repairs count meaning and persistence first. Comparable
rankings remain necessary; correcting labels does not make the candidate preview
a full inventory. These source/data observations inform the next specification.

## Confirmed starting point

A read of the isolated test cache during phase 2A found, for Huguenot at
30.41,-81.42, 40 km, 30 days:

- Area recent feed: 195 rows for 195 distinct species.
- Hotspot reference feed: 246 locations.
- Huguenot's own 30-day recent feed: 73 rows for 73 distinct species.

These are changing cached-response observations, not permanent counts. Looking
only at the area feed's location for each species cannot compare all locations
fairly. Fetching all referenced hotspot feeds would involve up to 246 cache
lookups/upstream requests for this one search, so that work cannot be hidden in
a blocking page load or silently cut to the first few candidates.

`needs.ts::geoTargetsBase` already splits the initial Home result from a
per-species enrichment pass, with concurrency four, abort-aware scheduling,
cache reuse, stale status and a partial flag. The returned enrichment updates
species detail, while Best places still comes from the base payload. This is
an existing seam to evaluate rather than creating a competing Home data path.

`recentHotspotObs` includes provisional reports; `recentNearbyObs` currently
does not explicitly request them. Any comparison must deliberately align or
state that report policy. Missing public reports must remain distinct from
unseen species, sampled zero, unqueried locations and failed queries.

## Decisions the executable specification must settle

1. Exactly which location universe and report policy constitute the comparison.
   Retain all preview candidates and access to other reported locations.
2. Whether the planner uses location feeds for all reference locations or an
   explicitly bounded species/location expansion, with honest coverage.
3. How progress, partial results, stale results, failures and retry are shown;
   how navigation cancels additional work and preserves deliberate selections.
4. Which completed comparisons may drive automatic stops, and when re-ranking
   requires a user action rather than silently changing a curated route.
5. How cache reuse, bounded concurrency and deadlines behave for large regions;
   demonstrate both cold and warm cases with real test data.
6. How the resulting source/window/location coverage enters saved context, with
   a new explicit context version/source where needed, never relabeling 2A's
   area-preview snapshots as full-location evidence.

Phase 2B remains open until these decisions, request/coverage contracts and
acceptance checks are written. No implementation or new eBird request fan-out
was performed for these notes.
