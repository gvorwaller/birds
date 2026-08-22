# Species Search Never Empty — CODEX Revision

**Date:** 2026-08-21  
**Author:** CODEX  
**Scope:** `td-0753d0`  
**Baseline:** GROK supersedes AGY; this revision preserves GROK's architecture
while closing authorization, UX, concurrency, query-semantics, and testing
gaps.

## 1. Product contract and corrections

"Never empty" means:

- Any current `taxonomy_cache` row with `category='species'` can be found by
  common name, scientific name, or exact eBird species code, even without
  enrichment.
- Its detail page always shows taxonomy, Seen/Need status, available
  observations/forecast/photos, and reference links.
- Wikipedia/Wikidata data is best-effort enrichment. Missing articles are
  valid data states, not errors.
- Arbitrary text, incompatible tags, non-species taxa, and unknown codes may
  still return honest empty results or 404s.

Keep GROK's decisions:

- No upstream requests from GET loaders, crawlers, prefetch, or search.
- First-time enrichment is an explicit action available to every authenticated
  role.
- Re-enrichment remains admin-only.
- Keep the 20-second interactive budget, existing queue fallback, 400ms worker
  politeness, and scoped background scanner.
- No typeahead, global taxonomy crawl, new job type, or automatic stale
  refresh.

Corrections to GROK:

- The viewer exception requires an explicit hook change because viewers
  currently cannot POST anywhere.
- Search must preserve tag semantics: an unenriched name hit cannot satisfy
  selected enrichment tags.
- Concurrent first-load clicks should share one in-process request rather than
  duplicate Wikimedia traffic.
- Queued fallback must disable repeat clicks and refresh the species page when
  the job finishes.
- Empty-state copy must distinguish "not loaded," "no article found," and
  "temporarily unavailable."
- No new search index is justified: the production taxonomy has 11,167 species
  and the full substring name scan currently completes in roughly 25ms.

## 2. Taxonomy-first Field Guide

Replace the enrichment-inner search with two candidate legs:

1. **Taxonomy name/code leg**
   - Search all current species by exact code, exact name, name prefix, then
     name substring.
   - LEFT JOIN enrichment and scope-owner `seen_species`.
   - Include unenriched rows only when no tags are selected.
2. **Enrichment prose/tag leg**
   - Preserve `search_tsv` and `tags @>` AND semantics.
   - Require an enrichment row.

Combine with `UNION ALL`, retain each species' best-ranked candidate, and apply
one final deterministic `LIMIT 50`:

1. Exact code or exact common/scientific name.
2. Name prefix.
3. Name substring.
4. Prose FTS rank.
5. Common name and species code tie-breakers.

Public server interfaces change to:

- `GuideResult` adds `wiki_status`, `wiki_fetched_at`, and `has_prose`; `tags`
  is always coalesced to an empty array.
- `guideCounts()` returns `{ taxonomy, withWikipedia, annotated }`.

UX changes:

- Intro: "Search N species by name or code; M have Wikipedia notes and K have
  field craft."
- Unattempted result: "Open to load species notes."
- Attempted without article: "Taxonomy and reference links available."
- Preserve Seen/Need, family, scientific name, IUCN, tags, and field-craft
  preview.
- Empty search remains inactive and never dumps all 11,167 rows.
- If taxonomy is empty, show an explicit taxonomy-sync/setup message rather
  than "no matches."
- Run active search and guide counts concurrently in the loader.
- Update attribution to "Descriptions from Wikipedia where available."

## 3. Species detail and interactive enrichment

Always render the About card for `category='species'`.

Render distinct states:

- **Unattempted:** "Wikipedia notes haven't been loaded yet," taxonomy/reference
  links, and `Load species data`.
- **Article available:** existing prose, sections, facts, attribution, and
  optional field craft.
- **No article/no mapping:** "No English Wikipedia article was found,"
  preserving Wikidata facts and external links.
- **Transient/error without prose:** explain that notes are temporarily
  unavailable or queued.
- **Failed refresh with old prose:** retain prose and show the existing stale
  warning.

Add two named actions:

- `load_enrichment`: available to all authenticated roles only when
  `wiki_fetched_at IS NULL`.
- `refresh_enrichment`: existing admin-only force refresh after any completed
  attempt.

Both actions must:

- Validate the species-code shape and require a current taxonomy species row.
- Use `enrichOneNow` with the existing 20-second abort budget.
- Queue AI-only work after a successful article load when due.
- Treat `no_article` and `no_mapping` as successful terminal outcomes.
- On transient upstream failure, enqueue the existing one-species enrichment
  job; first-load fallback uses normal freshness, admin refresh uses
  `force:true`.
- Return safe inline form feedback for persistence or queue failures instead
  of an unhandled error page.

Add per-process promise coalescing keyed by species code so simultaneous
first-load requests share one Wikimedia operation. Existing transactional
upserts and worker freshness checks remain the cross-process safety net.

Authorization:

- Add a narrowly tested viewer-hook exception only for
  `POST /species/{valid-code}?/load_enrichment`.
- Continue blocking every other viewer mutation, including
  `refresh_enrichment`.
- Explain in the UI that loading communal reference data does not change the
  owner's sightings.
- Enforce the first-time gate server-side; hiding the button is not
  authorization.

Queued UX:

- Return and track the queued job ID.
- Disable the Load button while that exact job is active.
- When it becomes terminal, invalidate the species page once so newly stored
  notes appear automatically.
- Use `try/finally` around enhanced-form busy state so the button cannot remain
  stuck.

## 4. Background work, Help, and compatibility

- Leave `SCOPE_SQL`, chunk size, scanner cadence, AI scope, retry windows, and
  Wikipedia politeness unchanged.
- Do not add a global crawl or database migration.
- Keep all current attribution and licensing behavior.
- Update Help to state:
  - Name/code search covers the complete current eBird species taxonomy.
  - Wikipedia notes fill from loaded regions, life lists, photos, or an
    explicit first-time Load.
  - Any account may perform the first load; only admins may refresh existing
    data.
  - Some species legitimately have taxonomy and links but no English Wikipedia
    article.
- Preserve GET-restorable searches, exact return links, 48px targets, AAA
  contrast, and mobile behavior.

## 5. Verification and rollout

Automated coverage:

- Unenriched taxonomy species is returned by common name, scientific name, and
  exact code.
- Exact/prefix/substring name tiers outrank prose; a species matching both legs
  appears once.
- Query plus tags excludes unenriched rows; tags-only remains enrichment-only
  with AND semantics.
- Empty search remains inactive; non-species categories remain excluded.
- Counts distinguish taxonomy, Wikipedia, and AI coverage.
- Seen/Need uses `scopeId`, including viewer-owner scoping.
- GET detail loading never invokes `enrichOneNow`.
- First-load succeeds for admin, user, and viewer; viewer refresh and unrelated
  POSTs remain 403.
- Repeated or raced first-load requests do not duplicate the interactive fetch.
- `ok`, `no_article`, `no_mapping`, transient queue fallback, and persistence
  failure all produce truthful UI states.
- Queued completion refreshes the page once.
- Existing scanner tests continue proving the global taxonomy is not added to
  `SCOPE_SQL`.

Release gates:

- Run the dedicated test database and migrations, full tests, `npm run check`,
  `npm run build`, and `git diff --check`.
- Review in two logical commits: taxonomy-first search/Help, then detail
  action/authorization/UX.
- Production smoke-test an unenriched species such as Shoebill by name and
  code, verify first-load behavior with admin and viewer roles, confirm no
  GET-triggered upstream traffic, and inspect the resulting job/enrichment
  state before closing `td-0753d0`.
