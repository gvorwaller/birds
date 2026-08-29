# Plan: Similar species via iNaturalist misidentification data (td-460b1c)

## Context

Great Black-backed Gull shows no similar species and Lesser Black-backed Gull omits
GBBG. Root cause: candidates are sourced from eBird `category='slash'` taxa, which
encode checklist reporting ambiguity, not field-guide similarity — *Larus marinus*
belongs to zero slash taxa, and the genus fallback (`MAX_GENUS_MATES = 3`) drops
whole for Larus (19 in-scope species). Verified replacement: iNaturalist's public
`GET /v1/identifications/similar_species?taxon_id=X` — species ranked by real
observer misidentification counts (GBBG→#1 LBBG at 754 misIDs, symmetric; Downy→Hairy
at 4,693; even cross-family confusions). Forward name resolution verified 20/20 exact
on a random in-scope sample. Corpus size, **measured on prod data 2026-08-28**
(local `birds_test` is now a full prod restore, re-keyed for eBird creds):
- **3,551 in-scope species** (earlier 1,219/2,500 figures were stale/estimates)
- **3,204 existing similar notes across 1,933 species** — the preservation set
- **3,476 of 3,554 enrichment rows (98%) already carry `cross_ids->>'inat_taxon_id'`**
  from Wikidata P3151 — name-search fallback is the rare path
All further counts (pre-flight wave size, EXPLAIN checks) run against this restored
local copy or prod itself — never against synthetic local content.

**Binding decisions (Gaylon):**
1. Retire the eBird slash tier COMPLETELY (and the genus tier + `MAX_GENUS_MATES`).
   `taxonomy_cache` slash ROWS stay — they belong to taxonomy sync.
2. Unresolvable iNat taxa are NEVER silently dropped — store and show an explanatory
   note in the UI. Same for a focal species unmappable to iNat (`no_mapping`).
3. The Opus prose stage stays; only the pairing source changes.
4. **Existing notes are PRESERVED, never re-billed** (Gaylon, plan review): a pair
   that already has a note under the old scheme and survives into the new iNat
   candidate set keeps its stored note untouched. The AI is only asked for notes
   on candidates that LACK one; a species whose entire new candidate set is
   already noted makes NO AI call at all (hash/status bookkeeping only). Cost
   scales with genuinely new pairs, not corpus size.
5. (AskUserQuestion) The new-note wave runs on **Sonnet 5 temporarily** (admin
   enrichment-model dropdown; switch back to Opus 5 after the wave). Preserved
   notes keep their original Opus provenance (`species_similar.ai_model` is
   per-row and untouched).
6. (AskUserQuestion) **Two-phase deploy** — no blank-card window.
7. (AskUserQuestion) Species with no iNat data get an honest hidden card (status
   `'none'`), explained in help copy.

## Architecture

New worker stage `enrich_species_inat` per species: resolve eBird→iNat taxon id
(`species_enrichment.cross_ids->>'inat_taxon_id'`, already populated from Wikidata
P3151; fallback `/v1/taxa` exact sci-name search), fetch `similar_species`, store
ALL normalized rows (cap 30) in new table `species_inat_similar`.
**Resolution + selection + reciprocity run at RECONCILE time (worker), not page
load** (AGY A1 — this supersedes the earlier read-time-resolution wording): the
AI-stage reconcile resolves confused-with taxa to eBird codes (CODEX1 F2's
two-arm precedence + ambiguity rules, unchanged, just executed in the worker),
applies selection, computes reverse-current-source support, and PERSISTS the
display set (selected resolved codes, unresolved entries, forward/reverse
origin) in the same transaction as the candidate hash — so the page can never
render a candidate set that diverges from the stored notes. The read path is
ONE indexed query per page load; no graph traversal, no Node-side selection.
Staleness is handled by targeted invalidation (AGY A3) + the taxonomy-sync and
mapping-mismatch due-clauses, which mark species for cheap re-reconcile (no
iNat refetch, no AI call for covered pairs). Threshold tuning = re-run
reconcile over stored raw rows — still no refetch, still no re-billing. `basis` disappears; ALL offered
candidates are required in the AI output schema. The `similar_candidates_hash`
mechanism, `upsertAiData` state machine, retry loop, and `species_similar` table are
unchanged.

## Phase 1 — Migration `backend/db/migrations/0037_species_inat_similar.sql`

```sql
CREATE TABLE IF NOT EXISTS species_inat_similar (
    species_code   TEXT   NOT NULL,   -- focal eBird species
    inat_taxon_id  BIGINT NOT NULL,   -- the confused-with iNat taxon
    rank           INT    NOT NULL,   -- 1-based by misid_count desc at fetch time
    misid_count    INT    NOT NULL,
    inat_sci_name  TEXT   NOT NULL,
    inat_com_name  TEXT,
    declined_at    TIMESTAMPTZ,       -- R2: model's terminal "not confusable" verdict
    fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (species_code, inat_taxon_id)
);
-- (plus the persisted display-set columns per AGY A1 — selected flag, resolved
--  code, unresolved marker, origin, resolution_fingerprint — exact shape is the
--  implementer's choice per Phase 4)
-- No FK to taxonomy_cache (0020/0031 precedent: sync_taxonomy delete+reinserts).
GRANT SELECT, INSERT, UPDATE, DELETE ON species_inat_similar TO birds_app;
-- Reverse-current-source reciprocity + targeted invalidation lookups
-- (CODEX1 F1, AGY A2/A3): both arms indexed.
CREATE INDEX species_inat_similar_taxon_idx ON species_inat_similar (inat_taxon_id);
CREATE INDEX species_inat_similar_sci_idx ON species_inat_similar (lower(inat_sci_name));

ALTER TABLE species_enrichment
    ADD COLUMN IF NOT EXISTS inat_taxon_id BIGINT,   -- focal's resolved id
    ADD COLUMN IF NOT EXISTS inat_taxon_source TEXT
        CHECK (inat_taxon_source IN ('cross','search')),  -- R3: P3151-removal handling
    ADD COLUMN IF NOT EXISTS inat_sci_name TEXT,     -- R4: focal's iNat binomial (namespace-correct matching)
    ADD COLUMN IF NOT EXISTS inat_similar_status TEXT
        CHECK (inat_similar_status IN ('ok','none','no_mapping','error')),
    ADD COLUMN IF NOT EXISTS inat_similar_fetched_at TIMESTAMPTZ,   -- restamped on ok/none/no_mapping
    ADD COLUMN IF NOT EXISTS inat_similar_attempted_at TIMESTAMPTZ, -- every attempt
    ADD COLUMN IF NOT EXISTS inat_similar_error TEXT;
    -- (cross_ids_updated_at column dropped from the design: CODEX1 F5's global
    --  clock is superseded by AGY A3's targeted hash invalidation, no column needed)
CREATE INDEX IF NOT EXISTS species_enrichment_inat_similar_idx
    ON species_enrichment (inat_similar_status, inat_similar_attempted_at);
-- CODEX1 F2: indexed cross-id resolution arm. FULL expression index — a partial
-- index WHERE cross_ids ? '...' cannot serve a plain ->> equality join unless
-- every query also repeats the ? predicate (self-review note d).
CREATE INDEX IF NOT EXISTS species_enrichment_cross_inat_idx
    ON species_enrichment ((cross_ids->>'inat_taxon_id'));

ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN (/* existing list from 0028 */ , 'enrich_species_inat'));
```
Conventions per 0028/0031: `IF NOT EXISTS` guards, explicit GRANTs. Index drops
(`taxonomy_genus_idx` from 0031, the slash partial index from 0033 — verify exact
name in the file) go in the **Phase-B migration 0038** (they're still used until the
read path flips; see Deploy).

## Phase 2 — Gateway `src/lib/server/inaturalist.ts` (new)

Copy `wikipedia.ts`/`xeno-canto.ts` shape exactly: `{signal?, fetcher?}` params
(fetcher = the test seam), `enrichmentUserAgent()` (wikidata.ts:105) header, 30s
timeout, `parseRetryAfterMs` import, `class InatError extends Error {status;
rateLimited; retryAfterMs}` — structural, so `isRateLimitedError` (wikidata.ts:116)
picks it up with no changes.

- `fetchInatSimilarSpecies(taxonId, opts)` → `GET {base}/identifications/similar_species?taxon_id=X&per_page=100`;
  parse `results[].{count, taxon.{id,name,preferred_common_name,rank}}`; 429 → rateLimited.
- `searchInatTaxonBySciName(sciName, opts)` → `GET /v1/taxa?q=<sci>&rank=species&per_page=30`,
  first case-insensitive exact `name` match or null (iNat search is synonym-aware).
- `normalizeSimilarResults(focal, raw)` — pure. **CODEX1 F8 (P2) tightened
  contract:** accepted ranks are EXACTLY `'species'` (kept as-is) and
  infraspecific ranks (`subspecies`/`variety`/`form`: collapse to the binomial —
  first two tokens — merging counts by SUM. **AGY A2 (P1): a child taxon id
  breaks reverse lookups** (`WHERE inat_taxon_id = focal_id` never matches a
  subspecies id), so reverse-support and invalidation queries must match on
  `inat_taxon_id OR lower(inat_sci_name)`, both indexed — and where the
  species-level parent id is derivable from the payload, store THAT instead of
  the child id). **Hybrids are DROPPED** (hybrid formula names are
  unsafe to token-split). Anything else (genus, complex, etc.) dropped. Drop
  focal self-references (by id or binomial); re-rank; cap `INAT_MAX_STORED = 30`.
  **Strict envelope parsing — REQUIRED fields only (GROK G9):** validate that
  `results[].{count:number, taxon.{id:number, name:string, rank:string}}` are
  present with the right types; a violation throws a provider-shape `InatError`
  (lands as visible `inat_similar_status='error'`, 7d retry) — never accept a
  response merely because `results` is an array. **IGNORE unknown/extra keys**
  — the live envelope carries dozens of extra taxon fields
  (`default_photo`, ancestry, etc.); rejecting unknowns would fail every
  request and land the whole corpus in `'error'`. Fixture the REAL captured
  envelope (extra keys included) as the regression for this; the endpoint is
  public but undocumented.
  **Licensing/API terms (GROK G9):** iNat identifications are CC BY-NC;
  attribution with a link to iNaturalist is required (see the card attribution
  in Phase 6); ~60 req/min requested (100 hard), 10k/day — the 1,100 ms
  per-request limiter (~54/min) and one-time ~3.5k-request backfill fit
  comfortably; never parallelize iNat requests. This app is personal and
  non-commercial, which matches NC — revisit if that ever changes.
- `INAT_POLITENESS_MS = 1100`, enforced per outbound REQUEST via a single shared
  limiter (see F8 in the worker section).

## Phase 3 — Sourcing job

- `src/lib/server/jobs.ts:19` — add `'enrich_species_inat'` to `JobType`.
- `src/lib/server/job-policy.ts` — `TYPE_NAMES` entry ("Species confusion data"),
  `dedupKeys.enrichInatChunk = codes => dedupKeyForLocs('enrich_inat', codes)`.
- `src/lib/server/species-enrichment.ts`:
  - `inatDueCodes()`: in-scope codes WITH an existing `species_enrichment` row
    (wiki stage first ⇒ cross_ids had its chance) AND
    (`inat_similar_status IS NULL`
    OR `'error'` older than 7d (`ERROR_RETRY_DAYS`)
    OR `IN ('ok','none')` fetched > 180d ago (`INAT_REFRESH_DAYS = 180`)
    OR `'no_mapping' AND inat_similar_attempted_at < NOW() - INTERVAL '180 days'`
    OR **the mapping-mismatch clause** (GROK G6 as corrected by self-review R3):
    `inat_similar_status IN ('ok','none','no_mapping') AND cross_ids ?
    'inat_taxon_id' AND (inat_taxon_id IS NULL OR inat_taxon_id::text IS
    DISTINCT FROM cross_ids->>'inat_taxon_id')`
    — an `'ok'`/`'none'`/`'no_mapping'` focal whose Wikidata P3151 id appears
    or CHANGES refetches immediately. **R3 (P1): `'error'` is EXCLUDED** — after
    any failed fetch `inat_taxon_id` is still NULL while cross_ids is present
    (98% of corpus), so an ungated clause would re-select every errored species
    every scan, bypassing the 7-day backoff entirely (an iNat outage would
    hammer the whole corpus each pass). Errors retry only via their own 7d lane.
    **R3 also: P3151 REMOVAL.** New column `inat_taxon_source
    ('cross'|'search')` records provenance; clause: `NOT cross_ids ?
    'inat_taxon_id' AND inat_taxon_source = 'cross' AND inat_similar_status IN
    ('ok','none')` → re-verify via name search once (which rewrites source to
    `'search'`, so the clause self-clears — no loop). Tests: `inatDueCodes()`
    contains the changed-cross-id `'ok'` row; an `'error'` row with NULL id is
    NOT selected before 7d; a P3151-removal row is selected exactly once.
  - Writers: `upsertInatSimilar(code, taxonId, rows)` (txn: DELETE + INSERT edges;
    status `'ok'`/`'none'`, stamp both clocks, clear error), `markInatNoMapping(code)`
    (stamps BOTH clocks — retry-forever precedent job-handlers.ts:1599-1621),
    `markInatError(code, msg)` (attempted_at only, sanitized).
- `src/lib/server/job-handlers.ts`:
  - `runEnrichSpeciesInat(job)` modeled line-for-line on `runEnrichSpeciesMedia`
    (:1861-1973) via `runChunkLifecycle`: chunk 20, wall budget 10 min. Per unit —
    **CODEX1 F7 (P2): cross_ids is AUTHORITATIVE whenever present**:
    `taxonId = crossIds ?? stored ?? name-search` (a stored name-search result
    must never mask a later Wikidata P3151 value; if crossIds differs from
    stored, refetch and overwrite atomically). None → `markInatNoMapping` (one
    write: status + BOTH clocks restamped + error cleared; retry predicate
    spelled exactly `inat_similar_attempted_at < NOW() - INTERVAL '180 days'`,
    plus the immediate clause when cross_ids appears or CHANGES while
    `inat_taxon_id` disagrees). Else fetch → normalize → upsert.
    `isRateLimitedError` → stop chunk with `retryAfterMs`.
    **CODEX1 F8 (P2): one limiter for ALL outbound iNat requests** — the
    politeness delay applies per REQUEST, not per unit (a fallback unit does
    taxa-search + similar back-to-back and would otherwise double the rate).
  - `case 'enrich_species_inat'` in `runJob` (:1976+).
  - `enqueueEnrichmentChunks` (:884-968) — **CODEX1 F6 (P1): per-lane quotas, not
    loop order.** The scanner's 8-chunk budget is filled in lane order today;
    inserting ~3,551 inat items between wiki and AI would starve the AI/media
    lanes for the whole backfill (and the uncapped nudge puts the entire inat
    backlog ahead of everything on the single FIFO worker). Fix:
    - Split the per-pass chunk budget across lanes round-robin (each non-empty
      lane gets at least one chunk per pass; leftover slots distributed in lane
      order). Applies to both the capped scanner and the uncapped nudge's
      enqueue ORDER (nudge still enqueues everything, but interleaved
      wiki→inat→ai→media→wiki→… so no lane waits for another to drain).
    - `inatWork = inatDueCodes() minus wikiSet` (a mid-wiki species has no
      cross_ids yet and would waste its fallback search).
    - **`aiWork` excludes codes in `inatWork`** — otherwise a brand-new species
      gets a candidate-less AI call (tags only) and is billed AGAIN when inat
      lands. Source-first ordering per species: wiki → inat → one AI call with
      candidates present. **Ships in Phase B** (self-review note a): in Phase A
      the AI layer is deliberately untouched, and applying the subtraction
      during the 1.5-2.5 h backfill would stall the whole AI lane for zero
      anti-double-bill benefit (the old slash-based AI path is still serving).
    - Extend `EnrichmentWorkSummary` with `inatCandidates`; extend the nudge
      message (admin/+page.server.ts:243-246).
  - **GROK G2 (P1): the interactive species-page path must get the same
    source-first ordering** — F6 only fixed the scanner. Today
    `species/[code]/+page.server.ts` `load_enrichment`/`refresh_enrichment` run
    `enrichOneNow` (wiki-only) then enqueue `aiOnly` when `now.aiDue`, and
    `enrichOneNow.aiDue` looks only at `ai_status`/rev — so a first page load
    would fire a candidate-less tags call with inat pending, then a second full
    call after inat lands: the exact double-bill, on the path Gaylon actually
    clicks. Fix: after wiki, enqueue a 1-code `enrich_species_inat` (same
    after-wiki pattern as the media enqueue, :428-442; add
    `dedupKeys.enrichInatOne`); enqueue `aiOnly` only when `inat_similar_status`
    is terminal and not `'error'`. `enrichOneNow.aiDue` and the wiki-fresh
    `similarDue` check in `runEnrichSpecies` (:1641-1643) must use the SAME
    predicates as `aiDueCodes` — extract a shared helper rather than
    hand-copying the clauses. Tests: first-load does not enqueue AI while inat
    is pending; a wiki-fresh `enrich_species` run with inat pending does not
    stamp any `similar_*` column.

## Phase 4 — Read-path rewrite + slash retirement

**Delete** `src/lib/similar-species.ts` + `src/lib/similar-species.test.ts` (only
production import is `species-enrichment.ts:15`). Delete `MAX_GENUS_MATES`, the old
two-tier `candidateSet` (:1127-1208) and `CandidateSet` shape.

**AGY A1 (P1): resolution, selection, and reciprocity run at RECONCILE time in
the worker and are PERSISTED — never per page load.** The earlier read-time
design was an unmaterialized graph traversal: for a well-connected focal, the
reverse-support step alone touches 20-50 species × 30 candidate rows × the
resolution join on every HTTP GET, and read-time re-selection could diverge
from the stored notes' hash. Instead, the reconcile step (part of the AI stage
/ `reconcileSimilarState`) computes everything below ONCE per invalidation and
persists the display set — selected resolved codes, unresolved entries (iNat
names), and `origin: 'forward'|'reverse'` — as columns on `species_inat_similar`
rows (or a sibling table, implementer's choice), in the SAME transaction as
`similar_candidates_hash`. `getSimilarSpecies` becomes one indexed query over
the persisted set + the seen/note/photo joins. Threshold tuning = re-run
reconcile over stored raw rows (no refetch, no re-billing).

`candidateSet(code)` (reconcile-side; drop `sciName` param).
**CODEX1 F2 (P1) resolution design, executed at reconcile time** (the earlier
single-LATERAL draft had a NULLS-FIRST precedence bug, an unindexed cross_ids
arm, and silently broke sci-name collisions by lexicographic pick):

- Two explicitly-prioritized arms per candidate row, `UNION ALL` inside the
  lateral (or two separate indexed passes in TS — implementer's choice, same
  semantics):
  1. **cross-id arm (priority 1):** `species_enrichment` rows where
     `(cross_ids->>'inat_taxon_id') = sis.inat_taxon_id::text`, joined to
     `taxonomy_cache` `category='species'`. Served by a NEW expression index in
     0036: `CREATE INDEX ... ON species_enrichment ((cross_ids->>'inat_taxon_id'))
     WHERE cross_ids ? 'inat_taxon_id'`.
  2. **sci-name arm (priority 2):** exact `lower(tc.sci_name) =
     lower(sis.inat_sci_name)`, `category='species'`, served by `taxonomy_sci_idx`.
- Winner = min priority. **Ambiguity is surfaced, not guessed:** if the winning
  arm returns MORE THAN ONE distinct species_code (sci_name is documented
  non-unique), the row is treated as UNRESOLVED-AMBIGUOUS and joins the
  unresolved list with its iNat names — never a lexicographic pick.
- Deterministic ordering everywhere; no `ORDER BY bool DESC` (NULLS-FIRST trap).
- **Gate:** `EXPLAIN (ANALYZE, BUFFERS)` on the restored prod-scale local DB
  (3,551 in-scope, 3,554 enrichment rows) before Phase B ships.

Selection in TS, exported for tests: `selectInatCandidates(rows)` —
**GROK G1/G7-revised rule**: the original `max(3, ceil(0.05×leader))` floor both
(a) EXCEEDS the leader when leader < 3, selecting nothing from real data
(live-verified: Black Rail n=5 all count=1 → 0 selected; Eskimo Curlew leader=1
→ 0 selected — the card would hide as fake "no data", violating decisions 2/7)
and (b) collapses high-leader species to 1-2 rows before the top-7 cap ever
acts (live-verified: Downy leader=4,693 → 5% floor 235 kills Red-bellied 233,
Nuttall's 171, Ladder-backed 70). Starting rule is therefore:
**floor = `min(leader, 3)`** (no relative 5% term), then top `MAX_SIMILAR = 7`
by `misid_count DESC, inat_taxon_id ASC` (deterministic tie-break so the 7th
seat can't hash-churn). The pre-flight gate must report the **histogram of
selected-set sizes** (species with 0/1/2/…/7) and the final thresholds are
decided from that measured histogram — reconcile-time tunable, no refetch. Named
tests: leader=1 and leader=2 still emit the leader; the Downy-shaped
4,693/312/233/171 distribution keeps its mid-tier.
**AGY A4 (P1) accuracy constraints** — raw misID counts are noisy in two
live-verified ways: super-abundant-species contamination (Bald Eagle's #5
"similar" is Canada Goose at 62 misIDs; Mallard picks up American Coot) and
global-range contamination (Downy's #7 is Lesser Spotted Woodpecker, a
Palearctic species with zero range overlap). Two selection filters:
1. **Resolved candidates must be IN-SCOPE** (the app's own species universe —
   same filter the retired genus tier used). This kills extralimital noise
   without any new range data source. Out-of-scope resolved rows are dropped
   from selection (they are NOT "unresolved" — decision 2 covers taxa with no
   eBird mapping, not species outside the app's regions).
2. **Cross-family pairs need stronger support**: same-family (via
   `taxonomy_cache.family`) pairs use the base floor `min(leader, 3)`;
   cross-family pairs additionally require `misid_count >= max(20,
   ceil(0.10 × leader))` (starting guess — tunable). This keeps genuine
   cross-family confusions (they exist) while filtering
   beginner/photo-AI-vision noise like eagle→goose.
The pre-flight gate must list ALL surviving cross-family pairs for human
review before Phase B (per AGY), alongside the size histogram.
**Self-review R8 (P2): weak-evidence guard + explicit pipeline order.** With
floor `min(leader, 3)`, a leader of 1 admits EVERY single-observer noise row
(Black Rail: five count=1 rows → five billed notes each backed by one
observer error). When `leader < 3`: only same-family rows are eligible and
seats cap at 3 — thin evidence gets a thin card. Named test: leader=1 emits
only same-family rows, at most 3 (not "emits everything"). The selection
pipeline order is FIXED, not implementer's choice (it changes seat counts and
therefore the pre-flight histogram): normalize → resolve → dedupe-by-code →
scope filter → family/cross-family floors (incl. declined-edge exclusion) →
rank → top-7.
**Self-review R7 (P1): scope changes.** Persisted selections don't observe the
scope universe (seen/frequency/photos). Two-part fix: (a) the read path
applies the in-scope filter to the persisted display set at render time, so a
species LEAVING scope disappears immediately; (b) a species ENTERING scope
goes through the normal wiki→inat pipeline as a new species, and
`upsertInatSimilar`'s partner stamping (R6) re-reconciles every affected
partner — GBBG's card gains the newly in-scope LBBG without waiting for any
global clock. Seats occupied by a departed species free up at the partner's
next reconcile (acceptable transient).
Dedupe two iNat taxa resolving to the same eBird code (keep higher count).
`MAX_SIMILAR` lives ONLY here after G4 (import from `$server/ai-enrichment` —
no cycle: ai-enrichment doesn't import species-enrichment). **ALL floor-passing
unresolved rows** (including unresolved-ambiguous from F2) go to the UI note —
**no display cap** (CODEX1 F8); a long list renders as `<details>/<summary>`
with a count (keyboard-accessible, GROK G11).

- `similarCandidatesFor(code)` (one arg now): selected ∪ **reverse-current-source
  extras** → `{code, comName, sciName, misidCount|null}[]`. No `basis`, no
  `reciprocal` flag. Hash = `similarCandidatesHash(codes)` unchanged — covers
  exactly the offered set.
  **CODEX1 F1 (P1): reciprocity must come from CURRENT iNat data, never from
  `species_similar` reverse edges.** The old `reciprocalNoteCodes()` sources
  historical notes — under the new scheme an old A→B slash/genus note would make
  B offer A forever, self-preserving retired pairs and invalidating the cost
  gate. Replace it: reverse support for focal F = species S whose OWN current
  selection (same `selectInatCandidates` over S's stored edges) contains F.
  Implemented as an indexed lookup of `species_inat_similar` rows whose
  `inat_taxon_id` resolves to F (add index on `inat_taxon_id` in 0037), then
  running the shared selection for each such S (≤30 rows each). A pair survives
  — and its note is preserved — ONLY if the current-source union supports it.
  `reciprocalNoteCodes()` loses its production consumer → delete it, and drop
  `species_similar_reverse_idx` (0032) in the 0037 migration.
  The pre-flight gate MUST invoke this exact same candidate builder (selection +
  reverse-current-source union), not a simplified approximation.
- `getSimilarSpecies(code, userId)` (drop sciName; update caller
  `species/[code]/+page.server.ts:246`): same seen/note/photo join; returns
  `{ similar: SimilarSpeciesRow[]; unresolved: {inatSciName, inatComName}[];
  inatStatus: 'pending'|'ok'|'none'|'no_mapping'|'error' }` (`related` is gone; all
  resolved rows render note-or-not — each is a genuine confusion claim).
  `SimilarSpeciesRow` loses `basis` + `slash_com_name`.
  **GROK G5 (P1):** do NOT copy the current early return (`:1280` bails before
  any status read) — `getSimilarSpecies` always reads `inat_similar_status` and
  the unresolved rows even when zero candidates resolve, mapping DB NULL →
  `'pending'` — **and a MISSING `species_enrichment` row is also `'pending'`**
  (self-review note b: pages for never-enriched species must not throw or fall
  into an unnamed state); otherwise unresolved-only and `no_mapping` species
  silently lose their explanatory card, violating binding decision 2. The selected ∪ reverse
  union must dedupe by eBird code (the card's keyed `{#each}` throws on
  duplicates), keeping the selected row's `misidCount` over a reverse extra's
  null.
- Admin Compare Lab (`admin/+page.server.ts:345`): one-arg call; keeps working.

## Phase 5 — AI layer

- `src/lib/server/ai-enrichment.ts`: `SimilarCandidate` loses `basis`/`reciprocal`,
  gains `misidCount: number|null`. `candidateBlock` (:180-192): one phrasing —
  "iNaturalist observers frequently misidentify these (N misidentifications)"; null
  count → "a note is owed here for reciprocity". Prompt instruction 3 (:233-255):
  ALWAYS write a note for EVERY candidate (the genus skip-clause dies).
  **AGY A7 (P3): add an explicit negative constraint so the machinery never
  leaks into prose**: "Never mention 'reciprocity', 'iNaturalist',
  misidentification counts, or database relationships in the note text — write
  only about visible field marks and behavior that separate the two species."
  (Same defect class as the existing verbatim-code instruction :219-222.)
  `buildOutputSchema` (:322): `required` = all candidate codes.
  **Self-review R2 (P1): all-required needs a per-pair DECLINE channel.** The
  code's own history (species-enrichment.ts:337-342) records exactly this
  wedge: requiring notes for pairs the model correctly judges not confusable
  put species in the 7-day error lane forever, re-billing a full call each
  pass — and AGY A4's filters reduce but do not eliminate noise pairs
  (eagle→goose passes whenever the leader is small). Fix: each required key's
  schema value becomes `string | null`; the prompt says to return `null` when
  the pair is genuinely not confusable in the field (distinct from
  "inseparable except by voice", which is a REAL note). A `null` is a terminal
  per-pair verdict: persisted as `declined_at` on the `species_inat_similar`
  edge, excluded by `selectInatCandidates` at the next reconcile (hash shrinks
  accordingly), never owed, never retried. Tests: a declined pair reaches
  `similar_status='ok'` with no error lane; a declined edge stays excluded
  across reconciles; decline ≠ empty-string (empty still counts as a miss).
- `job-handlers.ts` `runAiStage` (:1311-1513) — **note preservation (decision 4)**:
  after computing the offered candidate set, read which offered pairs ALREADY have
  a stored note: `SELECT similar_code FROM species_similar WHERE species_code=$1
  AND similar_code = ANY($2)`. Only candidates WITHOUT one are owed:
  - `askFor = offered.filter(c => !existingNotes.has(c.code))` — the model is
    prompted with `askFor` only (`buildUserPrompt`/`buildOutputSchema` see just
    those; validation closed set = `askFor`).
  - `owed()` (:1411) = `askFor.filter(c => !have.has(c.code))` (have = this run's
    returned notes; existing notes are never owed).
  - **No-call fast path** — **CODEX1 F3 (P1): NOT via `upsertAiData`**, which
    mandates and rewrites field_craft/tags/ai_model/search_tsv (and
    `aiStageInputFor` doesn't even return those for round-tripping). Add a
    dedicated transactional `reconcileSimilarState(code, offeredCodes, hash,
    status)` in species-enrichment.ts that touches ONLY the `similar_*`
    clock/hash/status columns and prunes `species_similar` rows not in the
    offered set. When `askFor` is empty AND tags/field_craft are fresh
    (`ai_status='ok'`, same rev), skip the model and call it with the real hash →
    `similar_status='ok'`. Tests must assert every non-similar column AND
    preserved note bytes + `ai_model` provenance are unchanged. This is the
    dominant path in the wave for species whose iNat top pairs coincide with
    their old slash pairs.
  - **GROK G3 (P1): the `upsertAiData` contract for owed-only calls, spelled
    exactly** (getting either wrong silently wipes preserved notes or
    mis-stamps `'none'`):
    - `offeredCodes` = the **FULL** selected ∪ reverse union, ALWAYS — never
      `askFor`. The keep-list DELETE (`offered ∪ written ∪ owed`) is what
      protects preserved rows; passing `askFor` as offered would prune them.
    - `candidateCount` = that full union's length — never `askFor.length`. A
      tags-only call on a fully-covered species must NOT stamp
      `similar_status='none'` (that requires candidateCount === 0).
    - Prompt/schema/validation see `askFor` only; preserved codes are never
      `required` and never appear in the returned `similar[]`.
    - **Mixed path (tags stale + askFor empty):** one tags/field_craft call
      with an EMPTY similar schema, then upsert with full
      `offeredCodes`/`candidateCount`, `similar: []`, `owedCodes: []` →
      `similar_status` stays `'ok'`, note bytes and per-row `ai_model`
      provenance unchanged. Named tests for both the keep-list footgun and
      this mixed path.
    - **AGY A5 (P2): guard `species_enrichment.similar_model` too** — the
      current UPDATE (:361) rewrites it whenever `similarStatus` is non-null,
      so the mixed path above (Sonnet tags call, zero new notes) would stamp
      Sonnet as the similar-stage model while every note is still Opus. Fix:
      advance `similar_model` only when `similar.length > 0`.
  - When `askFor` is non-empty, the single monolithic call regenerates
    tags/field_craft too (existing architecture; harmless) and writes only the new
    pair notes; preserved rows are untouched by the per-note upsert.
  - **GROK G4 (P1): `validateSimilar`'s cap must be the offered-set size, not
    `MAX_SIMILAR`.** The offered set is top-7 ∪ reverse extras (unbounded); with
    the current `:632-638` cap the parser would drop every reverse extra as
    `over-cap`, `owed()` would retry, and the substage would land `'error'` on
    exactly the well-connected species this feature is for. Parser cap =
    `candidates.length` (`askFor.length`); `MAX_SIMILAR` survives only inside
    `selectInatCandidates`. Scale `AI_ANSWER_BUDGET_TOKENS` with the asked
    count (it's sized for 7 notes today). Update the over-cap test that feeds
    `MAX_SIMILAR + 1`.
  Extend `aiStageInputFor` to carry `inat_similar_status`; when `'pending'`(null)/
  `'error'`, run the model with `candidates: []` AND pass `similarCandidatesHash:
  null` → the existing null-hash path leaves the similar substage untouched (notes
  generate once, after inat lands). Terminal `'none'`/`'no_mapping'` → real
  empty-set hash → `similar_status='none'`.
  **CODEX1 F4 (P1): `markAiError` must become stage-aware.** Today it
  unconditionally stamps `similar_status='error'` + `similar_attempted_at=NOW()`
  (species-enrichment.ts:439-456). Under the new gating, an AI transport failure
  during an inat-pending run would wedge the similar substage for 7 days: once
  inat lands, the `similar_status IS NULL` clause is false, the error clause
  isn't due, and `similar_generated_at` is NULL so the fetched-at clause is false
  too. Fix: when the run did not participate in the similar substage, fail
  `ai_status` ONLY and leave every `similar_*` column untouched.
  **Self-review R-F4b (P1): participation is an EXPLICIT flag, never inferred
  from "hash is null".** `markAiError` is invoked from the one catch
  (job-handlers.ts:1503) whose try also wraps `similarCandidatesFor`/hash
  computation — a throw DURING candidate resolution predates any hash and is
  indistinguishable from a deliberate inat-pending run. Capture
  `similarParticipating: boolean` from the inat-status read BEFORE the try
  body and pass it to `markAiError`: a resolution-stage throw with
  participation=true uses the similar error lane (7d backoff);
  participation=false leaves `similar_*` untouched. Named regression tests:
  (1) iNat pending → tag call fails → iNat lands a minute later →
  `aiDueCodes` selects the species for notes immediately; (2) a throw inside
  candidate resolution itself lands in the 7d lane, not an every-scan loop.
- Fix the known keep-list edge (`upsertAiData` :387-394): when a real hash was
  passed and `offered` is empty, DELETE ALL `species_similar` rows for the code
  (candidate sets can genuinely shrink to zero) — and the terminal status for
  an empty offered set is **`'none'`**, not `'ok'` (self-review consistency
  note: `candidateCount === 0 → 'none'` is the existing upsertAiData rule; the
  empty-offered fast path must match it).
- `aiDueCodes` (:554-564) similar clauses become (**every clause carries the
  inat-terminal gate** — self-review R1: the earlier draft gated only clause 1,
  so a hash-nulled species with inat `'error'`/pending looped every scan):
  `inat_similar_status IN ('ok','none','no_mapping') AND (`
  `(similar_status IS NULL)`
  OR `(similar_status='error' AND similar_attempted_at < NOW()-7d)`
  OR `(similar_generated_at < inat_similar_fetched_at)`  -- new iNat data ⇒ stale notes
  OR `(similar_generated_at < (SELECT MAX(fetched_at) FROM taxonomy_cache))` -- see two-tier reconcile below (R9)
  OR `(similar_candidates_hash IS NULL AND similar_status IS NOT NULL)` `)` -- targeted invalidation marker.
  **Self-review R1 (P1): the hash must ALWAYS be written back.** Every reconcile
  outcome — including nothing-changed — persists the recomputed
  `similar_candidates_hash` (`reconcileSimilarState` subsumes
  `touchSimilarFresh`, which today stamps clocks but never the hash); otherwise
  a nulled hash is never repopulated and the marker clause re-selects forever.
  **Self-review R9 (P1): two-tier reconcile keeps the taxonomy-sync clause from
  becoming a heavy full-corpus storm.** `syncTaxonomy` blanket-stamps
  `fetched_at`, so `MAX(fetched_at)` marks all 3,551 species after every sync.
  Under A1 a full reconcile (resolution + selection + reverse support) is no
  longer cheap. Fix: persist a `resolution_fingerprint` (hash over the display
  set's resolved codes + names) with the display set; the post-sync reconcile
  first recomputes ONLY forward resolution (~30 indexed rows) and compares
  fingerprints — full reconcile (incl. reverse support) runs only on change.
  **CODEX1 F5 → superseded by AGY A3 → mechanics corrected by self-review
  R4/R5 (both P1):** the invalidation runs inside ONE transaction with the
  cross_ids write — `upsertResolution` currently defaults to non-transactional
  `query` and the corpus worker calls it bare (job-handlers.ts:1663), so it
  must be restructured to read the OLD `cross_ids` value (pre-SELECT or CTE;
  today it's a blind upsert) and perform write + invalidation atomically.
  The partner lookup matches by **taxon id only**:
  `UPDATE species_enrichment SET similar_candidates_hash = NULL WHERE
  species_code = $code OR species_code IN (SELECT species_code FROM
  species_inat_similar WHERE inat_taxon_id IN (old_id, new_id) OR
  lower(inat_sci_name) = lower($focal_inat_sci_name))` — where
  `$focal_inat_sci_name` is the focal's **iNat** binomial from the new
  `species_enrichment.inat_sci_name` column (R4: the earlier `S.sci_name` was
  unbindable, and an eBird sci-name would compare the wrong namespace; the
  worker stores the iNat canonical name — from the taxa search, or one
  `/v1/taxa/{id}` lookup on the cross-id path when unknown).
  State machine, retry loop, `nothingToDo`: unchanged
  (`markAiError` changes per F4 above; `touchSimilarFresh` absorbed per R1).

## Phase 6 — UI

- `SimilarSpeciesCard.svelte`: single tier (delete two-tier headings :113-144, basis
  lines :102-108, `slash_com_name`). Muted footer when `unresolved.length > 0`:
  "iNaturalist observers also confuse this species with *<sci>* (<common>), which
  has no matching eBird species here." Long unresolved lists render as
  `<details>/<summary>` with a count (keyboard-accessible).
  **Render predicate (GROK G5/G8, explicit):** the card shows iff
  `similar.length > 0 || unresolved.length > 0 || inatStatus === 'no_mapping'
  || inatStatus === 'error'`. `'no_mapping'` renders "This species couldn't be
  matched to iNaturalist's taxonomy, so no misidentification data is
  available." `'error'` renders the same honest one-liner shape: "Couldn't load
  misidentification data for this species; it will retry automatically."
  `'none'` and `'pending'` stay hidden (decision 7), but the help page must say
  the card is also absent while data is loading.
  **RESOLVED by Gaylon (2026-08-28): keep the `no_mapping` and `error` cards
  VISIBLE.** ("I'm the primary user, and I want to know.") AGY A6's zero-state
  argument is noted and declined — data-state transparency outranks card
  minimalism here. The render predicate above stands as written.
  **Attribution (GROK G8/G9):** shown WHENEVER the card is visible — not gated
  on `hasAiNote` like today's :145-147. It must include a live link to
  <https://www.inaturalist.org> (parallel to the mandatory eBird link
  convention on this page, cs.md): "Confusion data from
  [iNaturalist](https://www.inaturalist.org) observer misidentifications ·
  notes AI-generated · verify in the field". Never render `taxon.default_photo`
  from the iNat payload (license not carried) — photos stay Commons-attributed
  via `species_media`.
- `species/[code]/+page.svelte:233-239`: pass `unresolved` + `inatStatus` props.
- `help/+page.svelte:568-579`: rewrite for the iNat source and name ALL four
  absent-card states distinctly (GROK G8): `none` = iNat recorded no confusions
  (honest empty), `no_mapping` = species not in iNat's taxonomy (card says so),
  `error` = data fetch failed, retrying (card says so), `pending` = data still
  loading (card absent). `about/+page.svelte`: leave the historical v0.1.3
  entry; add a new entry.

## Phase 7 — Tests

- Delete `similar-species.test.ts`.
- New `inaturalist.test.ts`: parsing, 429→`isRateLimitedError`, UA header, exact
  name matching, `normalizeSimilarResults` (ssp collapse, self-exclusion, cap).
- New DB tests (species-enrichment.test.ts, `describe.runIf(dbUp)`, fake codes,
  try/finally): read-path precedence (cross_ids beats sci-name), unresolved rows,
  floor/cap/dedupe selection, `inatDueCodes` clauses incl. no_mapping restamp +
  cross_ids-appeared immediate retry, `upsertInatSimilar` idempotency.
- New job-handlers tests: `runEnrichSpeciesInat` ok/none/no_mapping/error/rate-limit
  outcomes via injected fetcher (fakeNet pattern :970-1009).
- Rewrite job-handlers.test.ts fixtures keyed on old SQL substrings
  (`"category = 'slash'"` :2363, `"lower(sci_name) = ANY"` :2374,
  `"split_part(tc.sci_name"` :2578) → key on `FROM species_inat_similar`; behavior
  tests :2237-2836 (owed/retry/keep-list/swap/partial) survive with basis removed;
  add inat-pending→hash-null skip + empty-offered DELETE coverage. **Note
  preservation coverage (decision 4)**: an offered candidate with an existing
  stored note is excluded from the prompt and never owed; a fully-covered species
  makes zero model calls yet still updates hash/status and prunes retired pairs;
  a partially-covered species prompts only the uncovered candidates and leaves
  preserved rows byte-identical.
- Update ai-enrichment.test.ts :234-419 (phrasing, all-required schema),
  species-media.test.ts :337-630 (seed `species_inat_similar` instead of synthetic
  slash taxa; assert unresolved passthrough), species-enrichment.test.ts :1878-2025
  (drop genus-hiding test; keep backoff; adapt reciprocal), admin-actions.test.ts
  (drop basis, one-arg calls).
- **GROK G10 (P2) additions:** (a) the G2 interactive-path tests and G3
  keep-list/mixed-path tests; (b) `validateSimilar` with offered > 7 (reverse
  extras) passing the parser; (c) `selectInatCandidates` leader=1/leader=2 and
  the Downy-shaped 4,693/312/233 distribution; (d) `getSimilarSpecies`
  unresolved-only, no_mapping-only, pending (NULL→'pending'), and
  duplicate-code union dedupe; (e) `inatDueCodes` focal cross_ids CHANGE on an
  `'ok'` row (G6); (f) wiki-fresh `similarDue` fires when
  `inat_similar_fetched_at > similar_generated_at`; (g) round-robin scanner
  lane quotas; (h) first-load does not enqueue AI while inat pending.

## Phase 8 — Two-phase deploy & backfill (prod, 3,551 in-scope species measured 2026-08-28)

**Phase A (deploy 1):** migration 0037 + gateway + sourcing job + `inatDueCodes`
partition — read path and AI layer UNCHANGED (slash tier still serves). Deploy via
`scripts/deploy-to-DO.sh`, admin nudge → inat backfill (3,551 × 1-2 req at 1.1s ≈
1.5-2.5 h worker time, interleaved with other chunks). Verify coverage:
`SELECT inat_similar_status, count(*) FROM species_enrichment GROUP BY 1`.

**Pre-flight gate between A and B (required):** with the iNat table populated and
the old notes still in place, compute the REAL wave size before flipping anything —
replicate the read-time selection in SQL (or a one-off script using the shared
`selectInatCandidates`) and report:
- species whose selected iNat set is fully covered by existing `species_similar`
  rows → **no-call fast path** (bookkeeping only, $0);
- species with ≥1 uncovered pair → AI calls needed, and the total count of new
  pair notes vs preserved notes;
- species previously `'none'` that now have candidates (all-new notes);
- **the histogram of selected-set sizes** (species getting 0/1/2/…/7 candidates)
  — the selection thresholds are finalized from this, per GROK G1/G7;
- **hard gate (GROK G10):** every in-scope row must be in
  `{ok, none, no_mapping}` (an explicitly-accepted residue of `'error'` rows
  aside) before Phase B ships — otherwise those species lose their slash card
  and get a blank iNat card, breaking decision 6's no-blank-window promise.
Present these numbers to Gaylon before Phase B proceeds — the wave cost is decided
on measured counts, not estimates.

**Phase B (deploy 2):** everything else (Phases 4-6) + migration 0038 dropping
`taxonomy_genus_idx`, the 0033 slash partial index, and `species_similar_reverse_idx`
(0032 — its consumer `reciprocalNoteCodes` is deleted per CODEX1 F1). Before deploy: set admin
enrichment model to **Sonnet 5** (decision 5). After deploy the next scans pick up
every species via `similar_generated_at < inat_similar_fetched_at` / hash mismatch,
but per decision 4 only uncovered pairs trigger model calls; fully-covered species
take the no-call fast path, preserved notes keep their Opus provenance, retired
pairs are removed by the keep-list DELETE. After the wave completes (admin:
`similar_status` counts stabilize), set the model back to **Opus 5**.
**No "reciprocal second wave" exists under F1** (GROK G10: that sentence was a
leftover from note-based reciprocity): Phase A completes the full corpus before
Phase B, so the first wave already sees complete reverse-current-source data.
**Partner invalidation over the edge DIFF (self-review R6, P1):** inside
`upsertInatSimilar(F)`'s transaction, compute the SYMMETRIC DIFFERENCE between
F's old and new edge sets and NULL the `similar_candidates_hash` (NULL only —
a "perturbed" non-NULL hash matches no due-clause and silently never fires) of
every partner in it: added edges make new pairs due, and **dropped edges make
the pair's retirement propagate** — without the removed side, a partner keeps
rendering F with its preserved note indefinitely, resurrecting exactly the
self-preserving pairs F1 killed. `markInatNoMapping(F)` and a terminal decline
of F's mapping likewise delete F's now-invalid edges and stamp the affected
partners in the same transaction (`markInatError` leaves edges — last-good).

## Verification

- `npm run check` (0 errors) after each phase; `npx vitest run` full suite.
- DB suite against local test cluster: `npm run test:db:up` then vitest (dbUp gate).
- Local end-to-end: `npm run dev:test`, admin nudge, watch `enrich_species_inat`
  jobs; then `/species/gbbgul` and `/species/lbbgul` — each must list the other with
  notes; check one unresolved-entry species and one `no_mapping` species page;
  Compare Lab still renders similar names.
- Idempotency: nudge twice; second pass must be all-fresh (no refetch, no AI calls).

## Risks

- `similar_species` is public but undocumented — shape drift lands as
  `inat_similar_status='error'` with 7d retry (visible, not silent).
- Selection thresholds (floor `min(leader, 3)`, top 7, 30 stored, unresolved
  display uncapped) are
  starting guesses — read-time tunable without refetch.
- Subspecies→binomial collapse is a heuristic; rare mis-merges possible.
- New notes are Sonnet-quality until organically refreshed; preserved notes stay
  Opus (accepted, decision 5).
- Old notes were written under slash-framing prompts; their field-mark content is
  framing-independent, so preserving them is safe. If a specific preserved note
  reads oddly, deleting its `species_similar` row makes the pair "uncovered" and
  the next scan regenerates it — the natural per-pair refresh lever.

## Adversarial review log

**CODEX1 (2026-08-28), 6×P1 + 2×P2 — all folded into the sections above:**
1. P1 Reciprocal union from `species_similar` reverse edges self-preserved retired
   pairs → reciprocity now computed from current iNat data only; pre-flight uses
   the identical candidate builder; `reciprocalNoteCodes` + 0032 index deleted.
2. P1 LATERAL precedence NULLS-FIRST bug, unindexed cross_ids arm, lexicographic
   collision pick → two prioritized indexed arms, ambiguous = unresolved,
   EXPLAIN gate on prod-scale restore.
3. P1 No-call fast path via `upsertAiData` would rewrite unrelated AI columns →
   dedicated `reconcileSimilarState()` touching only `similar_*` + prune.
4. P1 `markAiError` wedged similar substage 7d on transport failure during
   inat-pending → stage-aware error persistence + named regression test.
5. P1 cross_ids changes had no invalidation path → `cross_ids_updated_at` clock,
   over-select + hash/no-call suppression.
6. P1 Lane starvation from partition order; AI double-billing for new species →
   round-robin per-lane quotas; `aiWork` excludes `inatWork`.
7. P2 Stored name-search id masked later Wikidata P3151 → cross_ids authoritative;
   precise no_mapping predicates; changed-cross-id test.
8. P2 Per-unit politeness undercounted requests; ssp/hybrid collapse unsafe;
   unresolved display cap violated decision 2 → per-request limiter, strict
   envelope parsing + hybrid drop, uncapped unresolved display.

**GROK (2026-08-28), 6×P1 + 4×P2 + 1×P3 — all folded into the sections above:**
1. P1 Selection floor could exceed the leader → empty selection from real data
   (live-verified Black Rail/Eskimo Curlew) → floor is now `min(leader, 3)`.
2. P1 Interactive species-page path bypassed source-first ordering and
   double-billed → 1-code inat enqueue after wiki; aiOnly gated on inat
   terminal; shared due-predicate helper.
3. P1 `upsertAiData` contract for owed-only calls unspecified (offeredCodes /
   candidateCount footguns could wipe preserved notes or stamp 'none') → exact
   contract spelled in Phase 5 + mixed-path (tags-stale, askFor-empty) test.
4. P1 `validateSimilar` MAX_SIMILAR cap would drop reverse extras as over-cap →
   parser cap = offered-set size; answer budget scales with asked count.
5. P1 Card/loader would hide unresolved-only + no_mapping (early return at
   :1280, card guard) → explicit render predicate; no early return; union
   dedupe by eBird code.
6. P1 cross_ids correction on an 'ok'/'none' focal wasn't inat-due for 180d →
   mapping-mismatch clause applies at ANY status.
7. P2 5% relative floor collapsed high-leader species (Downy → 2 rows,
   live-verified) → relative term dropped; pre-flight histogram decides final
   thresholds; deterministic tie-break.
8. P2 'error' state hidden + attribution gated on hasAiNote + help copy would
   lie → 'error' renders honest one-liner; attribution always visible with
   card; help names all four absent-card states.
9. P2 Envelope parsing must ignore extra keys (live payload has dozens);
   CC BY-NC attribution requires a live iNaturalist link (cs.md eBird-link
   parallel); never render taxon.default_photo; never parallelize iNat calls.
10. P2 Reciprocal "second wave" had no trigger under F1 → removed; ongoing new
    species stamp partners' similar substage stale in upsertInatSimilar;
    pre-flight hard gate: all in-scope rows terminal before Phase B.
11. P3 Doc drift fixed (thresholds line, 3,551 count, `<details>` for the
    unresolved list); 0037 CHECK copies 0028's type list; backup-pg.sh needs no
    change; Sonnet 5 already in SELECTABLE_MODELS.

**AGY (2026-08-28), 4×P1 + 2×P2 + 1×P3 — folded except A6 (open question):**
1. P1 Read-time reverse resolution was an N+1 graph traversal per page load and
   could render candidate sets diverging from the stored hash → resolution,
   selection, and reciprocity now run at reconcile time in the worker and the
   display set is persisted with the hash; read path is one indexed query.
   (Supersedes the read-time wording of the CODEX1 F1/F2 resolutions; their
   mechanics are unchanged, just relocated to the worker.)
2. P1 Infraspecific-collapse kept child taxon ids that break reverse lookups;
   no sci-name index → reverse/invalidation queries match id OR
   lower(inat_sci_name), both indexed in 0037; store parent id where derivable.
3. P1 F5's MAX(cross_ids_updated_at) clock = full-corpus invalidation storm →
   replaced with targeted hash-nulling of only the affected species inside
   upsertResolution + a `hash IS NULL` due-clause; column dropped from 0036.
4. P1 Raw misID ranking promotes non-look-alikes (live: Bald Eagle→Canada
   Goose) and extralimital species (Downy→Lesser Spotted Woodpecker) →
   selection requires in-scope resolved candidates; cross-family pairs need
   `>= max(20, 10% of leader)`; pre-flight lists all surviving cross-family
   pairs for human review.
5. P2 Mixed path stamped `similar_model` with Sonnet despite zero new notes →
   `similar_model` advances only when `similar.length > 0`.
6. P2 (ADVISORY, DECLINED by Gaylon 2026-08-28) no_mapping/error cards stay
   VISIBLE — the primary user wants data-state transparency; see Phase 6.
7. P3 Prompt echo risk ("note owed for reciprocity" leaking into prose) →
   explicit negative constraint added to instruction 3.

**Self-review (Fable, /code-review high, 2026-08-28), 10 findings (16/18
verified CONFIRMED, 0 refuted) + 5 cap-cut notables — all folded:**
1. R1 The hash-NULL due-clause had no inat-terminal gate and no hash writeback
   path → every aiDueCodes clause now gated on inat-terminal; reconcile ALWAYS
   persists the recomputed hash (`touchSimilarFresh` absorbed).
2. R2 All-required schema removed the model's refusal channel, recreating the
   documented genus-era permanent-error wedge → per-pair decline channel
   (`string | null` values, `declined_at` on the edge, excluded from future
   selection, never retried).
3. R3 The ANY-status mapping-mismatch clause bypassed the 7-day error backoff
   (outage → full-corpus hammering) and missed P3151 REMOVAL → clause excludes
   `'error'`; `inat_taxon_source ('cross'|'search')` column handles removal
   with a self-clearing one-shot re-verify.
4. R4 A3's invalidation UPDATE referenced an unbindable `S.sci_name` and would
   have compared eBird names against iNat binomials → id-only partner arm plus
   `species_enrichment.inat_sci_name` (focal's iNat binomial) for the name arm.
5. R5 "Compare old vs new in its existing transaction" was false twice
   (worker calls upsertResolution bare; function never reads old value) →
   restructured: pre-read + write + invalidation in ONE transaction.
6. R6 Partner stamping only fired for ADDED edges and "perturb" matched no
   due-clause → symmetric-diff stamping (adds AND drops), NULL-only clearing;
   no_mapping/decline delete stale edges and stamp partners transactionally.
7. R7 Persisted selections never observed scope-universe changes → read-time
   scope filter on the display set (leave-scope hides immediately) +
   enter-scope covered by the new-species pipeline's partner stamping.
8. R-F4b markAiError inferred participation from "hash null", undefined when
   candidate resolution itself throws → explicit `similarParticipating` flag
   captured before the try body.
9. R8 floor min(leader,3) admitted every single-observer noise row for weak
   species; filter/cap pipeline order unspecified → leader<3 restricts to
   same-family with 3 seats max; pipeline order fixed in the plan.
10. R9 The retained taxonomy-sync MAX(fetched_at) clause became a full-corpus
    HEAVY reconcile storm under A1's materialization → two-tier reconcile
    (cheap forward-resolution fingerprint check gates the full pass).
Notables: F6/G2 aiWork-subtraction ships Phase B only (else the AI lane stalls
through the backfill); missing species_enrichment row → 'pending'; empty
offered set → 'none' not 'ok'; the cross-id index is a FULL expression index
(a partial `? key` index can't serve `->>` joins); all 0037 DDL carries
IF NOT EXISTS guards.

---

## DELIVERED (2026-08-29)

Both phases shipped and the annotation wave completed. Final: 2,835 Sonnet 5
calls / $38.03; 11,776 new notes + 1,646 preserved; 260 declines; 3,005 ok /
508 none / 37 error (7-day lane). Post-plan deltas: reverse-support extras
capped at MAX_SIMILAR (pre-flight found unbounded hubs at 42/64/100);
enrichment model stays Sonnet 5 by Gaylon's live-quality verdict. Full wrap-up:
docs/devlog/2026-08-29.md.
