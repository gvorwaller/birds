# CC Review of CC Plan — td-0753d0

**Date:** 2026-08-22
**Reviewing:** `docs/2026-08-21-species-enrichment-field-guide-zero-empty-CC.md`
**Baseline:** CC supersedes GROK supersedes AGY. This review preserves
CC's architecture while closing remaining gaps.

## Context

The root cause (all three plans agree): `searchEnrichment` at
`species-enrichment.ts:461` uses `FROM species_enrichment se JOIN taxonomy_cache tc`
(INNER JOIN). The ~9,500 species in `taxonomy_cache` without a `species_enrichment`
row are invisible to search. The species detail About card is gated by
`{#if en || data.isAdmin}` (`+page.svelte:448`), hiding it from non-admin users
when no enrichment exists.

CC's two-leg UNION architecture, load/refresh action split, viewer hook
exception, promise coalescing, and two-commit sequencing are all correct. The
five-tier ranking (exact code > exact name > prefix > substring > FTS) is a
good improvement over the current two-tier (name_tier 0/1) approach.

What follows are corrections and suggestions only.

---

## Corrections

### 1. Attribution copy must keep the CC BY-SA license notice

CC §2: "Update attribution to 'Descriptions from Wikipedia where available.'"

The current footer reads: `Species text from Wikipedia (CC BY-SA 4.0) — data
from eBird.org`. The "(CC BY-SA 4.0)" is a license requirement under
Wikipedia's terms and cs.md's attribution rules. Dropping it is a compliance
regression.

**Fix:** "Species text from Wikipedia where available (CC BY-SA 4.0) — data
from eBird.org"

### 2. Queued-job auto-refresh has no specified mechanism

CC §3: "When it becomes terminal, invalidate the species page once so newly
stored notes appear automatically."

The codebase has no push infrastructure (no SSE, no WebSocket). Without
specifying HOW the page learns the job completed, this requirement is
unimplementable. Two options:

- **Lightweight poll:** After the action returns a `queued` result, the page
  polls `invalidateAll()` every 5s for up to 60s, stopping on first data
  change. Fits SvelteKit's data-loading model but adds client complexity.
- **Honest manual:** Return "Queued — refresh the page in a moment" and leave
  it to the user. Zero complexity, honest, and the page already re-fetches
  on navigation.

**Decision (Gaylon 2026-08-22):** manual refresh. Show "Queued — refresh
the page shortly" and skip client-side polling. The queue fallback only
fires on transient Wikimedia failures (rare); the page re-fetches on any
navigation. No client-side job tracking needed.

### 3. `load_enrichment` response for already-enriched species is unspecified

CC §3 says to enforce the `wiki_fetched_at IS NULL` gate server-side and
that "hiding the button is not authorization." Correct. But what response does
the action return when the gate fails (stale form, forged POST)?

It should NOT be a 403 — the user has permission to load; the data is simply
already present. Return a success-class message: `"This species already has
Wikipedia data."` and skip calling `enrichOneNow`. Treat it as a no-op, not an
error.

### 4. Viewer hook exception needs the action name check

CC §3: "Add a narrowly tested viewer-hook exception only for
`POST /species/{valid-code}?/load_enrichment`."

The hooks gate at `hooks.server.ts:61-68` checks `method` and `path` but not
the SvelteKit action parameter. The exception must also verify the action name
in the URL search params (`event.url.searchParams.has('/load_enrichment')`),
otherwise it would open `refresh_enrichment` to viewers too — bypassing the
admin-only check only by accident of the action's own 403, not by design.

CC's intent is correct but the text says "only for ... `load_enrichment`"
without calling out that the path alone (`/species/{code}`) is not sufficient —
the action discriminator is in the query string, not the path.

---

## Suggestions

### 5. Search placeholder should hint that name search works

Current placeholder: `"mudflats, probing, granary trees..."` — this only
suggests enrichment prose/tag queries. After this change, name and code
search will be the primary discovery path for unenriched species. Consider
changing to: `"Shoebill, mudflats, granary trees..."` to signal that species
names are valid search terms.

### 6. Non-species taxa: suppress the Load button in the detail template

The `load_enrichment` action validates `category = 'species'` server-side
(CC §3). But the detail page should also suppress the Load button for
non-species taxa (spuh, slash, issf, hybrid) so users don't see an action
that will always fail. The page already has the taxonomy row; a
`category === 'species'` check in the template is sufficient.

### 7. `guideCounts` implementation note

CC §2 says `guideCounts()` returns `{ taxonomy, withWikipedia, annotated }`.
The current implementation (`species-enrichment.ts:499-511`) only counts from
`species_enrichment JOIN taxonomy_cache`. Adding the taxonomy total is a
scalar subquery:

```sql
SELECT
  (SELECT COUNT(*) FROM taxonomy_cache WHERE category = 'species') AS taxonomy,
  COUNT(*) FILTER (WHERE se.wikipedia_extract IS NOT NULL) AS "withWikipedia",
  COUNT(*) FILTER (WHERE se.ai_status = 'ok') AS annotated
FROM species_enrichment se
JOIN taxonomy_cache tc USING (species_code)
WHERE tc.category = 'species'
```

One query. No new indexes needed for ~11k rows.

### 8. Run search and counts concurrently in the loader

The current loader (`/species/+page.server.ts:21-32`) awaits `searchEnrichment`
then awaits `guideCounts` sequentially. CC §2 says "Run active search and
guide counts concurrently in the loader." This is a `Promise.all` when
`active` is true. Minor latency win, easy to implement, no architectural risk.

### 9. Explicit test coverage for the hooks exception path

CC §5 lists: "First-load succeeds for admin, user, and viewer; viewer
refresh and unrelated POSTs remain 403." This covers the action-level behavior
but doesn't explicitly call out testing the hooks exception itself — that a
viewer POST to `?/load_enrichment` passes through `hooks.server.ts` while a
viewer POST to `?/refresh_enrichment` is blocked there. Both should be tested
at the integration level (hitting the route, not mocking the hook).

---

## Agreements (no changes needed)

- Product contract: "never empty" = taxonomy findable, not "every species has
  Wikipedia prose"
- Two-leg UNION: taxonomy name/code leg + enrichment prose/tag leg
- No GET-triggered enrichment. No global crawl. No typeahead.
- SCOPE_SQL unchanged. ENRICH_NOW_BUDGET_MS unchanged.
- load_enrichment for all authenticated roles (first-time only);
  refresh_enrichment admin-only
- Promise coalescing per species code for concurrent first-load
- `no_article` / `no_mapping` as successful terminal data states
- Transient → queue fallback with no DB writes on transient
- Two commits: A (search + Help) then B (detail actions + auth + UX)
- No database migration needed

---

## Summary of changes to CC plan

If these corrections and the manual-refresh decision are accepted, the
CC plan needs four edits before it's implementation-ready:

1. §2 attribution: add "(CC BY-SA 4.0)" back into the proposed copy.
2. §3 queued UX: replace auto-invalidation with "Queued — refresh the
   page shortly" message. Drop client-side job tracking. The Load button
   disables on submit and re-enables on form response (standard enhanced
   form behavior) — no persistent disable across page loads.
3. §3 load_enrichment gate: specify the already-enriched response as a
   success message, not a 403.
4. §3 viewer hook exception: call out that the exception must check the
   action name in the query string (`/load_enrichment`), not just the
   pathname pattern.
