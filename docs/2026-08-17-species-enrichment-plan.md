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
  taxonomy_cache — sync_taxonomy delete+reinserts; seen_species precedent):
  `species_code PK; wikidata_qid, iucn_status, facts JSONB, cross_ids JSONB;
  wikipedia_title/url/rev_id/extract TEXT, wikipedia_sections JSONB [{title,text}],
  wiki_fetched_at; field_craft TEXT, tags TEXT[] DEFAULT '{}', ai_model,
  ai_generated_at, ai_source_rev_id; search_tsv tsvector; status
  pending|ok|no_article|error, last_error, updated_at`.
  GIN on tags + search_tsv; (status, wiki_fetched_at) index. Grants via 0002 defaults.
- `search_tsv` is writer-maintained in the upsert SQL (NOT generated column — needs
  taxonomy_cache.com_name cross-table + array_to_string is STABLE): weighted A
  (com_name, tags) / B (extract, field_craft) / C (sections).

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
- `enrich_species` {codes, force?, aiOnly?} — cancellable batch, runFrequencyJob
  shape: claimed → batched SPARQL resolution (transient fail → whole-job retry) →
  per-unit loop (cancel/drain checks; no sitelink → facts-only upsert,
  status no_article, unit_skipped; else fetch article, split, upsert, [Phase 2 AI
  stage], unit_ok; 300–500ms serial politeness between Wikipedia calls). 429 →
  rateLimited scheduleRetry; per-unit 5xx → unit_failed transient, batch continues;
  no daily caps. Result {ok, noArticle, failed[], aiDone}.
- `scan_enrichment` — recurring 24h singleton (RECURRING_TYPES, ensureEnrichmentScan
  at worker startup + idle tick, lowestAdminId owner): computes scope ∪ stale, if
  non-empty enqueues ONE `enrich_species` batch (dedup 'enrich_species:batch'),
  terminalizeAndReschedule 24h. Heavy work never lives in the recurring job
  (recurring jobs are non-cancellable by design).
- dedupKeys.enrichSpecies/enrichSpeciesOne/scanEnrichment; TYPE_NAMES entries.

**Species page (`src/routes/species/[code]/`):** loader adds `getEnrichment(code)`;
new **About card** (extract paragraph; sections as `<details>` collapsibles; facts
badges incl. IUCN chip; footer attribution `Text from Wikipedia: "<title>" ·
CC BY-SA 4.0` with links — required by license — mirrored in page-bottom
attribution). Upgrade "Learn more" links to direct iNat taxon / xeno-canto species
URLs when cross_ids present (still link-out only). Owner-only `refreshEnrichment`
form action → enqueue {codes:[code], force:true} (loaders never enqueue — house
invariant; viewers' POSTs already hook-blocked). Missing row → page degrades to
today's behavior.

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
  $0.018/species → $9–36 one-time for the in-scope set; regenerates only when
  ai_source_rev_id <> wikipedia_rev_id or manual force (aiOnly batches retry
  AI-stage failures without refetching wiki).
- **"Finding this bird" card** after the forecast teaser: field_craft text, grouped
  tag chips (tide chips visually distinct), muted "AI-generated from the Wikipedia
  article · {date} · verify in the field", owner refresh button.

## Phase 3 — Field guide (search)

- `src/routes/species/+page.server.ts` (read-only loader): `?q=` + `?tags=`
  (repeatable). tsvector query: `search_tsv @@ websearch_to_tsquery('english', $q)`
  AND `tags @> $tags`, ranked ts_rank_cd then com_name, LIMIT 50, JOIN
  taxonomy_cache + seen_species (Seen/Need Badge per row); ILIKE fallback when
  tsquery matches nothing. `/species` + `/species/[code]` coexist in SvelteKit.
- `src/routes/species/+page.svelte`: search box (GET form), tag chips grouped by
  dimension, results → `/species/[code]`. Answers "probes mudflats at a falling
  tide" directly.
- Nav: drawer + primary-tab decision at implementation — **"📖 Field guide"**.
  Relieves Forecast (finder keeps its where/when job; cross-link later if wanted).

## Decisions made (not open)

- No-article species: facts + links only, NO AI from model knowledge alone.
- AI attribution line: "AI-generated from the Wikipedia article · verify in the field".
- Tag vocabulary above is v1; Gaylon tunes values in review, not schema.

## Verification (each phase)

`npm run check` 0/0; vitest — pure units (buildSpeciesSparql, splitSections
fixtures, validateTags, dedup keys, AI response parsing) + test-cluster DB tests
(upsert/tsvector recompute, scope/stale queries, handler happy path with mocked
fetchers, cancel/drain paths) in the jobs-db style; live `npm run dev:test` +
worker: enqueue small batch from species-page action, watch /admin events, verify
About card + attribution render, cancel mid-batch, drain-requeue. Deploy via
scripts/deploy-to-DO.sh (migration + worker rebuild automatic).

## Workflow rules (standing)

Each phase: gates green → CODEX1 review AND GROK review → deploy ONLY on Gaylon's
explicit word. No credentials/endpoints in payloads/events. td tracking: this arc
covers td-47d6d5 (field craft/tide) — update it as phases land; use td review flow.

## Cost/scale summary

In-scope set ~500–1500 species. Cold Phase-1 run: batched SPARQL (handful of
requests) + serial Wikipedia fetches ≈ 5–15 min. Phase-2 AI: $9–36 one-time,
then pennies on refresh. Storage: ~10–40KB/species prose ≈ 15–60MB — trivial.
