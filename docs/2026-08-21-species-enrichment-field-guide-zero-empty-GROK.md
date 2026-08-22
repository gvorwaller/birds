# Species search never empty (td-0753d0) — GROK plan

**Date:** 2026-08-21
**Author:** GROK
**Source reviewed:** `docs/2026-08-21-species-enrichment-field-guide-zero-empty-AGY.md`
**td:** Any species requested via search must return information. If it is
not already enriched, enrich it real-time on request instead of empty/error.

AGY's **root-cause is correct**. The proposed engine is not. This doc
keeps the diagnosis, replaces the architecture with pins that fit the
code that already shipped (td-b7d021 `enrichOneNow`, SCOPE_SQL,
admin communal quota, 400ms wiki politeness, GET-driven field guide).

No code this turn.

---

## 1. What AGY got right (keep)

Independently read `searchEnrichment`, `SCOPE_SQL`, `/species/+page.server.ts`,
`/species/[code]/+page.server.ts` + About card, `enrichOneNow`,
`refresh_enrichment` (admin-only), `ENRICH_CHUNK_SIZE=30`,
`WIKI_POLITENESS_MS=400`.

1. **Search is enrichment-inner.** `searchEnrichment` is
   `FROM species_enrichment se JOIN taxonomy_cache tc`. A real Clements
   species with no `species_enrichment` row is invisible. That is why
   Shoebill / Spix's Macaw / Common Kingfisher miss if they were never
   in seen ∪ frequency ∪ photos.

2. **Background scope is intentional and narrow.** `SCOPE_SQL`
   (CODEX1 #9) is `category='species'` ∩ (seen ∪ frequency ∪ photos).
   The worker will never pre-fill the other ~9k codes. That is not a
   bug in the scanner; it is why search cannot be enrichment-inner.

3. **About card hides for non-admins when `getEnrichment` is null.**
   `{#if en || data.isAdmin}` — viewers/owners see no About at all.
   The header/taxonomy/Learn-more links still render; the "blank page"
   is the missing About, not a 404 (404 is only unknown `species_code`).

4. **Name-first ranking and the name ∪ FTS union already exist**
   (CODEX1: a substring name hit must not be hidden by prose). Keep
   that contract; extend the *name* side to `taxonomy_cache`.

5. **Attribution (Wikipedia CC BY-SA, AI label, eBird line) stays
   exactly as today.** No new provenance theater.

---

## 2. What AGY got wrong (veto / replace)

| AGY | Why it does not ship |
| --- | --- |
| JIT `enrichOneNow` **inside the GET loader**, 5–10s | Blocks SSR. Cloudflare/nginx. Crawlers and prefetch spend communal Wikimedia. Contradicts td-b7d021: `enrichOneNow` is a **form action**, 20s `AbortSignal`, **admin gate** (communal quota). "Stale → refetch on GET" would SPARQL every 180d-old view. |
| "2–3s" / "5–10s" new budget | Keep `ENRICH_NOW_BUDGET_MS = 20_000`. Do not invent a second ceiling. |
| LEFT JOIN as the whole search | Tags (`se.tags @>`) and `search_tsv` are enrichment-owned. A naive LEFT JOIN plus tag filter **drops** unenriched name hits (the bug we are fixing). Name search and FTS/tag search are different FROM clauses, UNION'd as today. |
| Typeahead as the user types | `/species` is a GET form. This td does not add live typeahead. |
| ">1.5s show header then wiki in-place" on GET | Not how the loader works. If GET never waits on Wikimedia, this UX is free. |
| Expand `scan_enrichment` to all ~11k codes, 200–500/day, "5–10 wiki req/s", 2–3 weeks, 150–250MB | **VETO.** Gaylon deferred bulk pre-load on td-b7d021: scope = seen ∪ frequency ∪ photos; statewide load is the lever; Help already says so. 400ms politeness × 11k is hours of worker, starving alerts/enrichment. "5–10/s" is 12–25× the current politeness. Size claim unverified. |
| "Every query returns comprehensive taxonomic **and descriptive** data" | Oversell. td requires **information**, not a Wikipedia article. Many codes have no enwiki page (`no_article` / `no_sitelink`). Taxonomy + links is a successful empty-wiki, not an error. |
| Auto-enqueue AI on GET | No. AI follows the Load **action** (existing `aiOnly` chunk after wiki-ok), same as admin Refresh. Not on GET. |

---

## 3. Binding architecture (what "never empty" actually means)

Three layers. Only the first two are this td.

### A. Field guide search — taxonomy-first names

`searchEnrichment` becomes two legs, same LIMIT 50, same rank
(name-tier, `ts_rank_cd`, `com_name`, `species_code`):

1. **Name / exact code** (the zero-empty leg), from `taxonomy_cache`
   only:
   `category = 'species'` AND
   (`com_name ILIKE` OR `sci_name ILIKE` OR `species_code ILIKE` /
   exact). LEFT JOIN `species_enrichment` for optional iucn / tags /
   field_craft (nulls allowed). LEFT JOIN `seen_species` for the
   scope owner's badge.
2. **Prose / tags** (unchanged corpus): `species_enrichment` INNER
   JOIN taxonomy, FTS and/or `tags @>`.

UNION the legs (not "FTS fallback if names miss" — CODEX1). A name
hit with no wiki row **must** appear.

Rules:

- Empty `/species` (no `q`, no tags) still does **not** dump 11k
  rows. `active` gate stays.
- Tags-only query: enrichment-only (there are no tags without a
  wiki/AI row). Honest empty: "No tagged matches" — not a td miss.
- `category = 'species'` only (no spuh/slash/issf in the guide).
- Intro copy today: "Search {enriched} enriched species…". Change to
  two numbers from `guideCounts` + taxonomy: names search the whole
  species list (N); M have Wikipedia notes. Do not imply the corpus
  is wiki-complete.
- Row UI: unenriched rows show com, sci, family, Seen/Need, muted
  "Tap for details" (AGY subtitle is fine). No fake extract.

### B. Species page — never hide About; wiki on request not on GET

The page **already** 404s only when the code is missing from
taxonomy. Keep that.

- **Always render About** for `category='species'` (remove
  `en \|\| isAdmin` gate). If no extract: one sentence
  `No Wikipedia article yet` plus the existing Learn-more links.
  Facts/IUCN when present. This is "information" for a viewer.
- **GET loader never calls `enrichOneNow`.** No stale-on-GET.
- **Real-time enrich = existing action**, not a new job type.
  Reuse `enrichOneNow` (20s signal, writers, sitelink fallback,
  zero writes on transient). First-time fill is the same pipeline
  as admin Refresh.
  - **Who may fire it (Gaylon 2026-08-21):** **any logged-in
    role**, including viewer. Searching Shoebill is a family
    action; the Load button must not be admin-only or the
    empty-guide bug comes back for family accounts. The app is
    already auth-gated — not the public internet.
    **Force Refresh** (already-enriched, spend quota again)
    stays **admin-only** (td-b7d021 communal-quota pin).
    First-time (no `wiki_fetched_at`) is the td-0753d0 path
    and is available to everyone signed in.
  - **UI:** if no wiki row: button `Load species data` (busy
    copy `Refreshing…`). Do **not** auto-POST on mount.
    Taxonomy is already on screen so the page is not empty.
  - Wiki-ok + AI due → existing `aiOnly` enqueue + chip via
    `queued` (GROK P2-1 of td-b7d021). Transient → truthful
    queue fallback, no `markWikiError`.
- `no_article` / `no_sitelink` after a real attempt is a **data
  state**, not an error page. Keep the fallback note from
  td-b7d021 when `resolution='no_sitelink' && wiki_status='ok'`.

### C. Background scan — **do not expand**

`scan_enrichment` stays on SCOPE_SQL. Statewide / hotspot load
remains the bulk lever (Help sentence already shipped). Revisit a
global crawl only if A+B still miss in practice **and** Gaylon
reopens the td-b7d021 defer. Not this td.

---

## 4. UX (field guide + detail)

- GET form stays. No typeahead in this td.
- No toasts. No Tailwind. 48px targets. WCAG AAA.
- Help: one sentence that field-guide **names** cover the whole
  eBird species list; Wikipedia notes fill when you load a species
  (or when that bird is already in a loaded region / life list).
- Attribution unchanged.

---

## 5. Tests (no prod credentials)

- `searchEnrichment("shoebill", [])` returns the taxonomy row with
  null extract when no `species_enrichment` row exists.
- Name hit UNION FTS: a name-only species still ranks in name-tier
  0; a prose-only species does not hide it.
- Tags-only does not return unenriched codes.
- Empty `/species` still `active=false`, zero rows.
- Species page: unenriched + **any logged-in role** → About +
  Load. Viewer Load succeeds (first-time only). Admin Refresh
  (force) still 403 for non-admin.
- GET loader fixture: `enrichOneNow` is **not** called.
- `enrichOneNow` empty-wiki outcomes (`no_article`, `no_mapping`)
  render the empty-About sentence, not a 500.
- `guideCounts` / intro: taxonomy species count vs enriched count.
- Do not add a scanner test that SCOPE_SQL includes the whole
  taxonomy — it must not.

---

## 6. Sequencing

Two commits:

**A.** Search: taxonomy name leg + UNION; intro copy; unenriched
row UI; Help sentence. (This alone meets "search never empty.")

**B.** Species page: always-on About; owner/admin first-time
`enrichOneNow` action (not GET); button; AI enqueue unchanged.

Dual review (CODEX1 + GROK). Hold for Gaylon's deploy word. No
push/deploy from planning.

---

## 7. Out of scope

Live typeahead. Loader JIT. Global 11k ingest. Changing
`ENRICH_NOW_BUDGET_MS`. Stale-on-GET
refresh. New job types. 5th nav tab.
