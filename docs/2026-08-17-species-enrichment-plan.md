# Species Enrichment: Wikipedia/Wikidata + AI Field Craft + Field Guide (td-47d6d5)

## Context

Gaylon wants per-species data enriched as far as legitimately possible — his framing:
"store the whole eBird description and parse it with tags for search." Research
established the eBird species-page prose is **Birds of the World** (paid Cornell/Lynx
product; eBird API v2 has NO species prose; scraping violates terms). The legitimate
equivalent: **Wikipedia article prose (CC BY-SA 4.0, storable with attribution) +
Wikidata structured facts (CC0), joined to eBird species codes via Wikidata property
P3444 (verified)** — plus **AI-generated field craft**, the only source that answers
td-47d6d5 ("which tide is best for a particular shorebird") since no dataset ships
field-craft knowledge. The app already has every needed pattern: durable job queue +
worker, an LLM precedent (`src/lib/server/ai-guidance.ts` → trip_stops.field_tip),
`ebird_cache`-style TTL fetching, and stock-PG tsvector unused and waiting.

**Gaylon's decisions (2026-08-17, AskUserQuestion):** in-scope set (~500–1500
species: life list ∪ frequency-loaded ∪ photo species), Sonnet 4.6, new "📖 Field
guide" page at `/species`, all 3 phases (each dual-reviewed + deployed on his word).

Current state per species: `taxonomy_cache(com_name, sci_name, category, family)` +
seen flag + weekly frequency. Everything else is link-out. No AI species content
exists (ac8a22a was an unrelated truncation fix). No FTS/extensions installed.

## Phase 0 — UI prototypes (Gaylon sign-off gate, approved 2026-08-17)

Two static HTML mockups in `docs/mockups/` (the same pattern that designed V2's
pages — index/dashboard/targets/trips/photos/species live there already; match
their conventions and the app's real CSS variables/card styles):

- `docs/mockups/species-detail-enriched.html` — the species page with the two new
  cards in proposed order (header → **About** [Wikipedia lead, `<details>`
  sections, facts badges incl. IUCN chip, CC BY-SA attribution footer] → gallery →
  forecast teaser → **Finding this bird** [field-craft text, grouped tag chips
  with tide: chips visually distinct, "AI-generated … verify in the field" line,
  owner refresh button] → nearby reports → upgraded Learn-more links). Use a real
  worked example (a shorebird, e.g. Wandering Tattler or Marbled Godwit) with
  realistic prose so card weight/length is honest. Show the no-enrichment
  degraded state as a second variant section or annotation.
- `docs/mockups/field-guide.html` — the /species browser: search box, tag chips
  grouped by dimension (collapsed/expandable groups so 390px isn't a chip wall),
  ranked results with Seen/Need badges, empty-state. Mobile-first: include a
  390px-width framing note or media-query demo like the existing mockups.

Deliverable: Gaylon reviews the mockups (rendered via SendUserFile/browser) and
signs off or redlines BEFORE Phase 1 schema/pipeline work begins. Mockups commit
to the repo (docs-only commit; no review cycle needed beyond his eyes).

## Phase 1 — Licensed data pipeline + About card

**Migration `backend/db/migrations/0020_species_enrichment.sql`:**
- Extend jobs CHECK with `enrich_species`, `scan_enrichment`.
- `species_enrichment` (global, one row/species, **deliberately NO FK** to
  taxonomy_cache — sync_taxonomy delete+reinserts; seen_species precedent).
  **Stage-separated state (CODEX1 #3):** one blended status cannot represent
  Wikidata, Wikipedia, and AI independently, and an AI failure must never turn
  valid licensed prose into an error row:
  `species_code PK;
   wikidata_qid, resolution TEXT CHECK IN ('mapped','no_mapping','no_sitelink')
     NULL until attempted, iucn_status, facts JSONB, cross_ids JSONB;
   wikipedia_title/url/rev_id/extract TEXT, wikipedia_sections JSONB [{title,text}],
   wiki_status TEXT CHECK IN ('ok','no_article','error'), wiki_error TEXT,
   wiki_fetched_at TIMESTAMPTZ (set on every ATTEMPT incl. no_article — it is
   the freshness clock for all wiki-stage states);
   field_craft TEXT, tags TEXT[] NOT NULL DEFAULT '{}', ai_model,
   ai_generated_at, ai_source_rev_id BIGINT, ai_status TEXT CHECK IN
   ('ok','error') NULL until attempted, ai_error TEXT, ai_attempted_at;
   search_tsv tsvector; updated_at`.
  **Failure never clears good fields** — error states only stamp
  *_status/*_error; last good revision keeps serving. GIN on tags + search_tsv;
  (wiki_status, wiki_fetched_at) index. Grants via 0002 defaults. Validation at
  the gateway: species_code shape, section-array shape, tag cardinality ≤12,
  inbound code lists deduped + capped.
- `search_tsv` is writer-maintained in the upsert SQL and **decoupled from
  taxonomy (CODEX1 #4):** it covers ONLY enrichment-owned text — weighted A
  (tags, de-prefixed) / B (extract, field_craft) / C (sections). Names are NOT in
  the vector; the Field-guide query matches names separately (see Phase 3), so a
  taxonomy rename can never leave stale lexemes. BOTH `upsertWikiData` AND
  `upsertAiData` recompute the vector atomically in their statements (field_craft
  and tags feed it).

**New server modules:**
- `src/lib/server/wikidata.ts` — `buildSpeciesSparql(codes)` (pure, VALUES over
  wdt:P3444 → QID, enwiki sitelink via schema:about, IUCN/mass/wingspan/iNat/
  xeno-canto claims — verify exact PIDs beyond P3444 at implementation);
  `fetchWikidataBatch` (POST query.wikidata.org/sparql, chunks of 50, descriptive
  User-Agent with contact email, typed WikidataError).
- `src/lib/server/wikipedia.ts` — `fetchArticlePlaintext(title)`: ONE MediaWiki
  action-API call (`prop=extracts|revisions&explaintext&exsectionformat=wiki&redirects`)
  returning whole plaintext + revid; `splitSections()` (pure): lead → extract,
  whitelist sections (Description/Taxonomy/Habitat/Distribution/Behaviou?r/Ecology/
  Feeding/Diet/Breeding/Migration/Status/Conservation), ~40KB total cap.
- `src/lib/server/species-enrichment.ts` — single DB gateway: `upsertWikiData`
  (ON CONFLICT upsert recomputing search_tsv in-statement), `upsertAiData`,
  `markError` (through scrub/sanitize), `enrichmentScope()` (seen_species ∪
  DISTINCT species_frequency.species_code ∪ photo_links.species_code, category=
  'species', minus fresh ok/no_article), `staleCodes()` (wiki >180d; error >7d;
  AI missing or ai_source_rev_id <> wikipedia_rev_id), `getEnrichment(code)`,
  `searchEnrichment(q, tags)` (Phase 3).

**Jobs (`job-handlers.ts`, `jobs.ts`, `job-policy.ts`):**
- **Chunked, never one mega-batch (CODEX1 #1):** the worker runs exactly ONE job
  at a time under the global advisory lock, so a 1500-species serial job would
  starve every user load and the 30-min alert scan for hours. `scan_enrichment`
  enqueues the work as **bounded `enrich_species` chunks of ≤30 codes** (sorted,
  deterministic chunking); normal queue ordering interleaves user jobs between
  chunks. Each chunk job also carries a **wall budget (~10 min)**: past it, no new
  network side effect starts and the remainder codes re-enqueue as a fresh chunk.
- **Dedup that cannot lose work (CODEX1 #2):** enqueueJob dedup returns the active
  winner WITHOUT merging payloads — a constant 'enrich_species:batch' key would
  silently drop newly-scoped codes. Chunk dedup keys are **content-hashed over the
  sorted code list** (dedupKeyForLocs-style): identical chunk → dedup; different
  codes → distinct job. Single-species manual refresh uses
  `enrich_species:one:<code>` — never collides with chunk hashes. Handler-side
  per-species freshness checks (skip-if-fresh unless force) make overlapping
  chunks idempotent, so collisions are harmless rather than forbidden.
- `enrich_species` {codes ≤30, force?, aiOnly?}: claimed → batched SPARQL
  resolution (AbortSignal timeout; transient fail → whole-job scheduleRetry —
  nothing yet attempted) → per-unit loop with cancel/drain checkpoints before AND
  after each network call/write; 300–500ms serial politeness between Wikipedia
  calls; honor Retry-After on 429 (rateLimited scheduleRetry, stop batch).
  Per-unit outcomes (CODEX1 #11): `no_article`/`no_mapping` are SUCCESSFUL
  terminal data states → unit_ok with a named outcome, NOT unit_skipped;
  per-unit 5xx → unit_failed(transient), batch continues, and the job outcome
  uses the jobOutcome-style typed classification: transient remainder →
  scheduleRetry with a NARROWED resume set (successes are never redone — force
  successes persist before retry), exhausted budget → honest failJob. Result
  reports stage counts {resolved, wikiOk, noArticle, wikiFailed[], aiOk,
  aiFailed[]} — an AI failure never makes a wiki-success unit ambiguous.
  WDQS quirks: preferred-rank claim filtering, deterministic aggregation of
  duplicate rows, and `resolution` distinguishes no_mapping / no_sitelink /
  transient absence.
- `scan_enrichment` — recurring 24h singleton (add to RECURRING_TYPES;
  `ensureEnrichmentScan` at worker startup AND every idle tick, exactly beside
  ensureNeedAlertScan; lowestAdminId owner): computes scope ∪ stale (deduped),
  enqueues missing chunks, and **always** terminalizeAndReschedules its 24h
  successor atomically (terminal CAS + successor insert + both audit events, one
  txn — the existing primitive). Scanner transient failure → scheduleRetry the
  SAME row, never a false success. A no-work scan still schedules its successor.
- **Phase gating (CODEX1 #6):** `staleCodes()` includes AI-missing rows ONLY when
  the AI stage is enabled (`AI_ENRICHMENT_ENABLED` capability flag, flipped on in
  Phase 2) — otherwise Phase 1 would re-enqueue every fresh wiki row daily forever.
- dedupKeys.enrichChunk(codes)/enrichSpeciesOne(code)/scanEnrichment; TYPE_NAMES.

**Species page (`src/routes/species/[code]/`):** loader adds `getEnrichment(code)`;
new **About card** (extract paragraph; sections as `<details>` collapsibles; facts
badges incl. IUCN chip). **Attribution block (CODEX1 #8, license-required):**
rendered wherever the stored prose renders — links the exact revision permalink
(`.../index.php?title=<t>&oldid=<rev_id>`, which carries contributor credit via
history), the article itself, the CC BY-SA 4.0 license URL, the retrieval date,
and an explicit "excerpted and sectioned" modification notice. The AI field craft
is NEVER presented as Wikipedia text — separately labeled, and the plan documents
the licensing position: model output derived from CC BY-SA prose is treated as an
adaptation, shown with its own source-pointing label. Upgrade "Learn more" links
to direct iNat taxon / xeno-canto species URLs when cross_ids present (link-out
only). **Refresh action is explicitly ADMIN-gated server-side (CODEX1 #5)** — it
spends communal Wikimedia/Anthropic quota and mutates a global row; "owner-only"
is not a role in this app and the viewer hook is not an authorization system. The
action re-validates the code against taxonomy (category='species') before
enqueueing {codes:[code], force:true}. Loaders never enqueue (house invariant).
Missing row → page degrades to today's behavior.

## Phase 2 — AI tags + "Finding this bird" (td-47d6d5)

- `src/lib/species-tags.ts` (client-safe): controlled vocabulary as
  `dimension:value` flat tags — habitat: (forest, woodland-edge, grassland,
  shrubland, desert, freshwater-marsh, saltmarsh, mudflat, beach, rocky-shore,
  open-ocean, lake-pond, river-stream, urban-suburban, farmland, alpine-tundra);
  forage: (aerial-insectivore, foliage-gleaner, ground-forager, bark-forager,
  probing-shorebird, dabbler, diver, plunge-diver, hunter, scavenger, nectar,
  seeds-fruit); **tide:** (falling, low, rising, high-roost, tide-independent —
  coastal species only, the td-47d6d5 payload); time: (dawn-peak, diurnal,
  crepuscular, nocturnal); movement: (resident, short-distance-migrant,
  long-distance-migrant, irruptive, pelagic); find: (conspicuous, secretive,
  heard-more-than-seen, flocking, solitary, feeder-visitor). NO seasonality
  dimension — species_frequency curves answer that better regionally.
  `validateTags` enforces membership in code (model output never trusted; drops
  logged in job events), ≤12 tags; `groupTags`/`tagLabel` for chips.
- `src/lib/server/ai-enrichment.ts` — modeled on ai-guidance.ts: direct Anthropic
  fetch, Sonnet 4.6, 30s timeout, JSON-only response `{"tags":[...],
  "field_craft":"..."}`. System prompt: annotate from the provided Wikipedia text +
  well-established natural history; hedge; never invent specifics. User: identity +
  extract + Habitat/Behaviour/Feeding sections (~10k char cap) + full vocabulary +
  instruction that tidal species MUST get a tide: tag and field_craft MUST state
  the productive tide stage and why. field_craft 2–4 hedged sentences, ~700 char
  cap. AI runs ONLY when Wikipedia prose exists (evidence rule). Cost ≈
  $0.018/species → $9–27 one-time for 500–1500 species; regenerates only when
  ai_source_rev_id <> wikipedia_rev_id or manual force (aiOnly batches retry
  AI-stage failures without refetching wiki).
- **"Finding this bird" card** after the forecast teaser: field_craft text, grouped
  tag chips (tide chips visually distinct), muted "AI-generated from the Wikipedia
  article · {date} · verify in the field", owner refresh button.

## Phase 3 — Field guide (search)

- `src/routes/species/+page.server.ts` (read-only loader): `?q=` + `?tags=`
  (repeatable). **Name matching UNIONS with FTS, not fallback-only (CODEX1):**
  `(com_name ILIKE OR sci_name ILIKE)` name matches and
  `search_tsv @@ websearch_to_tsquery('english', $q)` prose matches are combined
  in one query, both filtered by `tags @> $tags`, deterministically ranked —
  name-match tier first, then ts_rank_cd, then com_name — LIMIT 50, JOIN
  taxonomy_cache + seen_species (Seen/Need Badge per row). A valid substring name
  hit can never be hidden by an unrelated prose hit. `/species` + `/species/[code]`
  coexist in SvelteKit.
- `src/routes/species/+page.svelte`: search box (GET form), tag chips grouped by
  dimension, results → `/species/[code]`. Answers "probes mudflats at a falling
  tide" directly.
- Nav: drawer + primary-tab decision at implementation — **"📖 Field guide"**.
  Relieves Forecast (finder keeps its where/when job; cross-link later if wanted).

## Decisions made (not open)

- No-article species: facts + links only, NO AI from model knowledge alone.
- AI attribution line: "AI-generated from the Wikipedia article · verify in the field".
- Tag vocabulary above is v1; Gaylon tunes values in review, not schema.

## Scope/stale SQL contract (CODEX1 #9 — pinned by real-DB tests)

Scope: `SELECT DISTINCT species_code` over (seen_species ∪ species_frequency ∪
photo_links **WHERE species_code IS NOT NULL**), joined ONCE against
taxonomy_cache `category='species'`; scope ∪ stale is de-duplicated before
chunking. Freshness: wiki stage fresh when `wiki_fetched_at > NOW()-180d`
regardless of ok/no_article (attempts stamp the clock); error rows retry after
7d; AI stale when enabled AND prose exists AND (`ai_status IS NULL` OR
`ai_source_rev_id IS DISTINCT FROM wikipedia_rev_id`). Nullable rev comparisons
always IS DISTINCT FROM.

## Verification (each phase)

`npm run check` 0/0; vitest — pure units (buildSpeciesSparql, splitSections
fixtures, validateTags, chunking determinism, dedup-key hashing, AI response
parsing) + test-cluster DB tests in the jobs-db style covering CODEX1's list:
upsert/tsvector recompute from BOTH writers, scope/stale queries incl. NULL
photo_links rows and no_article TTL, dedup collision (identical chunk dedups;
different codes don't; one-species force never swallowed), taxonomy
rename/delete-reinsert → search still correct (names live outside the vector),
good-row survival through wiki/AI-stage errors, stage gating (Phase 1 never
re-enqueues AI-missing rows), narrowed-remainder retry + retry exhaustion →
failJob, late cancel at terminalization, drain during bounded calls, scanner
successor atomicity + lost-chain reconciliation + no-work-still-reschedules, and
a queue-fairness test (a user job enqueued mid-campaign runs between chunks).
Route-level auth tests: viewer GET renders, viewer/user POST refresh rejected,
admin POST accepted; attribution links (revision permalink + license URL +
retrieval date + modification notice) asserted in rendered output. Live
`npm run dev:test` + worker: enqueue small chunk from the admin refresh action,
watch /admin events, cancel mid-chunk, drain-requeue. Deploy via
scripts/deploy-to-DO.sh (migration + worker rebuild automatic).

## Workflow rules (standing)

Each phase: gates green → CODEX1 review AND GROK review → deploy ONLY on Gaylon's
explicit word. No credentials/endpoints in payloads/events. td tracking: this arc
covers td-47d6d5 (field craft/tide) — update it as phases land; use td review flow.

## Review record

CODEX1 plan review folded in 2026-08-17 (8 MUST + 4 SHOULD, all adopted):
chunked jobs + wall budget (queue fairness under the single-worker advisory
lock), content-hash chunk dedup (no swallowed work), stage-separated
status/error columns (good data survives downstream failures), taxonomy-decoupled
tsvector, admin-gated refresh, AI-staleness phase gating, recurring-chain
atomicity + ensure-at-startup-and-idle-tick, revision-permalink attribution,
pinned scope-SQL contract, upstream bounds (AbortSignal/Retry-After/WDQS rank
filtering), no_article-as-success unit accounting, expanded test matrix,
cost corrected to $9–27, name-union search.

## Cost/scale summary

In-scope set ~500–1500 species. Cold Phase-1 run: batched SPARQL (handful of
requests) + serial Wikipedia fetches ≈ 5–15 min. Phase-2 AI: $9–27 one-time,
then pennies on refresh. Storage: ~10–40KB/species prose ≈ 15–60MB — trivial.
