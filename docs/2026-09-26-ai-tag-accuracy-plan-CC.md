# Species tags from evidence rules — td-894144 (plan)

**Status:** PLAN rev 27 (2026-09-29, CC). **Release A is DEPLOYED** (6f14163). **B1–B3 are DEPLOYED** (fa45832, 2026-09-30 00:51 UTC; no tag owned yet). **B4 (the open-ocean pilot): rev 27 spec below (owner decisions: pragmatic gate, labels = what the article says) for CODEX1 review.**

**Governing principle (owner, 2026-09-26):** _AI is never used to generate, drop or change a tag. Only the rule set does,_ and later a blind-tested classifier. The AI's only tag-related job is to **propose rules**, which become loadable only through a separate owner-run approval step. Everything else AI does in the app is unchanged: field craft, similar-species notes, family descriptions, guidance.

**Revision history:**

- Rev 1–5: from a paid AI re-tag to evidence rules; owner decisions; Phase 2.
- Rev 6: per-tag ownership.
- Rev 7: CODEX1's rev-6 fixes.
- **Rev 27:** CODEX1 rev-26 fixes: a recorded design is recomputed, never trusted; an explicit revoke on tag_eval_frame_rows; the exact gate JSON with a pinned DB hash; pi and selectedCodes stored and verified; a single-source evaluator version with code-point sorting and a pinned design hash.
- **Rev 26:** CODEX1 rev-25 fixes. The frame bytes carry the masked names and the page is built from input-covered normalized text (rename drift is bound); the exact trailing-`|` byte form; the gates hash is recomputed in the switch; the label table schema and reuse and freeze semantics are written out; the savepoint dry-run evidence path; missing-state and infeasible-design hard stops; the algorithm is named sha256-rank-v1; ASCII codes asserted.
- **Rev 25:** CODEX1 rev-24 fixes: the stored gate JSON is the only pass authority (named cases included); label identity covers version, deny list and cue words; the frame-hash definition is unified (TS mirrors SQL bytes); status and the marine proxy are carried so C1/C2/U swaps are rejected; the definer recomputes the ranked sample; lost-none retention; sizing worded as a gap target; the test matrix is updated.
- **Rev 24:** B4 per CODEX1's rev-23/23a reviews. Retention is of legacy's real positives (K_A over legacy positives); exact hypergeometric bounds with a Bonferroni split replace the heuristics; worst-case unsure per claim; undefined denominators fail; strict sample validation; sizing on the same bounds; the HMAC-rank sampling contract in one transaction; a DB-canonical frame hash verified inside the activation switch; dry-run switch replaces provisional reports; one authoritative gate JSON; stale sections reconciled.
- **Rev 23:** B4 rewritten per CODEX1's rev-22 review and two owner decisions: pragmatic two-claim gate; labels measure the article, not truth. Fixes estimators from flags, a strict frame hash, owner-only cross-check recording, definer-only label writes with lock ordering, revision-independent masked evaluator text with label reuse, exact Rao–Wu weights, and must-not named cases as gate conditions. **Rev 23a:** a coverage simulation showed the Rao–Wu percentile bootstrap errs optimistic at the lower bounds the gate uses, so precision uses Wilson at the Kish n_eff and retention uses a log-ratio with Agresti–Coull-smoothed variances.
- **Rev 22:** the B4 implementation spec: authoring set, AI drafting, cross-check recording, eval schema, strata, design simulation, sampling, labelling, adjudication, freeze and gate report.
- **Rev 21:** the repair workset is the union of all four drift classes and the CAS is "workset empty" (self-healing loop); a distinct cancellable `tag_repair` job type; the atomic job + event insert with the parent requester; retire-with-a-second-tag tests (CODEX1 rev-20: 2 P1, 1 P2).
- **Rev 20:** the repair branch becomes a generation/compare-and-swap contract, with a generation-qualified job key inserted atomically with the bump (fixing CODEX1's P1 finalization-window race). Retire-to-legacy stays available while a repair is pending (CODEX1 P2).
- **Rev 19:** the B2d benchmark results, plus the batched-repair design for a taxonomy name change while tags are owned.
- **Rev 18:** a mechanical token rule (the post token only once it exists); consistency batches call the single path (CODEX1 rev-17 P1s).
- **Rev 17:** a per-failure-key lock before the post-lock token; `preAttemptNo`/`postAttemptNo` named in every path (CODEX1 rev-16 P1s).
- **Rev 16:** two-token failure ordering, pre-lock and post-lock (CODEX1 rev-15 P1).
- **Rev 15:** CODEX1's rev-14 P1s closed.
  - One executable transaction preamble (timeouts, then the advisory lock).
  - The attempt number is allocated before the locked transaction.
  - Consistency repair batches run under the exclusive lock.
- **Rev 14:** CODEX1's rev-13 findings closed.
  - The obsolete rev-8 Release B design is deleted; its still-valid parts are kept as "Release B: dependencies, availability and approval".
  - The artifact hash is maintained by a trigger.
  - Failure-log ordering uses a DB attempt sequence, with success tombstones.
  - A scanner-revision guard.
  - The consistency job recomputes inputs first.
  - Coverage "extras" are defined.
  - A `transaction_timeout` hard cap.
  - UUID ids for directly inserted tables.
- **Rev 13:** CODEX1's rev-12 findings closed.
  - The focal-exemption hash is part of the input.
  - `replaceTaxonomy` takes the **exclusive** lock.
  - An explicit trust boundary (owner: Option A).
  - Idempotent state recording.
  - The consistency job keys on `input_hash`.
  - An exact hash-byte contract.
  - The end-to-end benchmark decides the transaction shape.
  - Monotone failure log.
  - Grant-matrix completion.
- **Rev 12:** B2 respecified after CODEX1's rev-11 review.
  - A per-species **input context** (text + taxon + lexicon + scanner) with an authoritative current-input pointer.
  - Universe = stored article, not wiki status.
  - A global lexicon change re-materializes everything.
  - New tables revoke inherited privileges first.
  - The DB recomputes the canonical artifact hash.
  - One executable activation protocol.
  - A failure-log table.
  - A type-level lock guarantee.
- **Rev 11:** the Release B implementation spec.
  - B1 as built: engine decisions and measurements.
  - B2: a simpler universe (members = species with a stored article), and the lock entry points listed by function name.
  - The migration 0066 outline, B3 (Tags tab and consistency job) and B4 (pilot flow) wiring.
- **Rev 10:** owner requests.
  - The **admin Tags tab** covers status, reports, labelling, approval, activation and rollback.
  - The **nightly tag consistency job** is an independent safety net.
  - **No owner command line:** every owner action is an admin page or a worker job. Rule proposals and revisions live in the database, not repo files. Phase 2's Mac training becomes a small local worker app with buttons.
- **Rev 9:** folds CODEX1's rev-8 review.
  - The legacy provenance invariant becomes a cutover snapshot.
  - The truthful Release A goal and the full availability contract (Guide, detail page, help copy).
  - An explicit writer and ACL test matrix; the static scan's scope.
  - The write-cycle invariant and corpus-hash encoding.
  - Release B and Phase 2 pre-review notes.
- **Rev 8:** folds CODEX1's rev-7 high review.
  - **Release A is cut to the lean safety release** (CODEX1 P3): remove AI tags, protected legacy copy, DB-derived search index, **correct grants**, per-tag "not evaluated", and byte-identity proofs. No engine machinery.
  - **Release B** carries the engine, with the rev-7 P1 fixes: grants and the definer routine, an immutable state key, the complete universe and lock protocol with lock-at-BEGIN, and the corrected switch candidate set.
  - **Phase 2** gets the model-drift and re-score queue design.

## Owner decisions (2026-09-26 to 28)

1. AI never produces tags; everything else AI does is unchanged.
2. No tag changes before a blind test.
3. **End state:** all AI-generated tags are deleted and every tag is regenerated by the engine. Legacy tags serve only until the engine owns each tag, then are archived. Missed facts are an accepted cost.
4. **Two releases, minimum machinery:** A is safety only; B is the open-ocean pilot.
5. **Blind labelling:** about 150–250 labels for open ocean, with the exact n from a pre-label simulation. **If the simulation needs more than 250, the owner decides before any labelling.**
6. **Enforcement:** strict, no digital signature. It's a _workflow_ boundary (non-loadable proposals, an **owner-only approval action in admin**, DB grants and definer routines), not cryptographic proof. Anyone who can act as the owner in admin, or edit approval code, could still promote output.
7. **Phase 2:** learned challenger classifiers, never generators.
8. **No command line for the owner (2026-09-28).** Every validation, review, approval, activation, rollback and report the owner needs is in the main app (admin) or a small worker app. Agents may still use scripts for their own work (tests, cross-check recording, deploys), but no plan step may require the owner to type a command.

## Context

The Field Guide's **Habitat: open ocean** filter returns American Kestrel (Gaylon, 2026-09-24).

- **How tags are made today:** one AI call per species reads the stored Wikipedia prose and picks ≤12 tags. It draws on the article _and_ its training knowledge, which can't be separated. The kestrel's article never mentions sea or ocean.
- **Production measurements (2026-09-26):**
  - open ocean: 348 tagged, 45 in land-bird orders;
  - tide-independent: 174 of 424 on birds with no coastal-habitat tag;
  - odd-order tags are often true;
  - a naive keyword check confirms 256 of 303 marine-order open-ocean tags and 6 of 45 land-order ones, but as a generator it would add 224 land birds.
- **Runtime:** production runs Node 22.22.0 with ICU 77.1 / Unicode 16.0; the Mac runs Node 24.3 with ICU 77.1.

**Code facts:**

- **AI callers:** `generateSpeciesAnnotation` is called by the worker (`job-handlers.ts:1528-1554`) and by admin Compare (non-persisting). The only persisted AI-tag handoff is `upsertAiData` (`species-enrichment.ts:306`, called at `job-handlers.ts:1649-1659`). CODEX1 confirmed there's no other AI path.
- **Grants:** `0002_grants.sql` gives `birds_app` **table-level** `SELECT, INSERT, UPDATE, DELETE` on all tables, plus `ALTER DEFAULT PRIVILEGES` for future tables. A column-level REVOKE doesn't override a table-level grant. Migrations run as `birds_owner`; the app and worker run as `birds_app` (`migrate_pg.sh:83-107`, `db.ts:11-16`).
- **`species_enrichment` writers:**
  - `upsertResolution` (:118);
  - `upsertWikiOk` (:209);
  - `markWikiNoArticle` (:257);
  - `markWikiError` (:279);
  - `upsertAiData` (:306) and `markAiError` (:486);
  - similar-hash resets (:198, :1809, :2141) and similar reconcile (:1742, :1835);
  - `upsertMediaOk` (:1167) and `markMediaError` (:1228);
  - iNat ok, no-mapping and error (:2223, :2270, :2305, plus :2242, :2283);
  - `job-handlers.ts:1662`;
  - `replaceTaxonomy` (`taxonomy-sync.ts:88-126`), which replaces `taxonomy_cache` membership.
- **Search index:** `search_tsv` = tags (A) + extract and field craft (B) + section text (C), built today by `tsvExpr` inside each statement. **CODEX1 verified a DB-derived version on all 10,898 `birds_test` rows: zero mismatches.**

## Release A: safety only. Implement next.

**Goal (truthful, per CODEX1):** close the AI-to-tags path _now_, with **no change to any existing tag bytes, legacy chips, tag-filter matches or tide-gate decisions.**

Some things users _can_ see do change:

- species enriched after the cutover gain no tags, and show "Tags not yet available";
- the Guide shows an unknown count when a tag filter is active;
- admin Compare no longer shows tags;
- the help copy is updated.

**A1. Remove tags from every AI path.**

- Prompt: the vocabulary block and tag instructions go.
- `buildOutputSchema`, the `SpeciesAnnotation` type and `parseAnnotation` no longer handle tags; the worker call no longer passes them.
- `upsertAiData` becomes `upsertAiProseData`, with no tags parameter and no tags in its SQL.
- Admin Compare's response type can't carry tags.
- `markAiError` stays as is (it never wrote tags).

**A2. Protected legacy copy (migration 0065).**

- `ALTER TABLE species_enrichment ADD COLUMN legacy_tags TEXT[]`.
- Populate it **only where `ai_generated_at IS NOT NULL` at cutover** with `legacy_tags := tags`, byte-for-byte. Otherwise NULL, meaning unknown and never "evaluated empty".
- **This is a cutover snapshot, not a lasting predicate:** after Release A, `upsertAiProseData` keeps stamping `ai_generated_at` for new prose while `legacy_tags` stays NULL. The migration records the pre/post counts and hash of the populated set in td-894144.
- _Then_ install trigger `species_enrichment_legacy_guard` (BEFORE INSERT OR UPDATE): reject an INSERT with non-NULL `legacy_tags`, and an UPDATE where `NEW.legacy_tags IS DISTINCT FROM OLD.legacy_tags`.

**A3. The search index is derived by the database.**

- One function, `species_search_vector(tags, extract, field_craft, sections) RETURNS tsvector`: IMMUTABLE and schema-qualified, with exactly today's weighting and the `'english'` config.
- Trigger `species_enrichment_search_tsv` (BEFORE INSERT OR UPDATE **OF** `tags, wikipedia_extract, field_craft, wikipedia_sections, search_tsv`) sets `NEW.search_tsv` from that function. Any value a caller supplies is overwritten. Unrelated media, iNat or status updates don't recompute the index.
- The migration aborts if any row has `search_tsv IS DISTINCT FROM species_search_vector(…)`. It also logs an ordered corpus hash.
- **All writers stop computing `search_tsv`,** and `tsvExpr` is deleted.
- Trigger names are chosen for deterministic firing order: the legacy guard runs first; neither trigger changes the other's inputs.

**A4. Correct grants.** This is the DB side of the AI barrier.

- `REVOKE INSERT, UPDATE ON species_enrichment FROM birds_app` (table level).
- Then `GRANT INSERT (…)` and `GRANT UPDATE (…)` on **every column except `tags`, `legacy_tags`, `search_tsv`**. The list is generated in the migration from `information_schema.columns`, and logged.
- `SELECT` and `DELETE` are unchanged. A DELETE cascades normally.
- **Rule for future migrations:** a column added to `species_enrichment` is **denied to `birds_app` until a migration explicitly grants it.** That's documented in the migration header, not a universal "every column gets both" policy.
- **Grant assertions** (a test against the catalog):
  - no table-level INSERT or UPDATE for `birds_app`;
  - `tags`, `legacy_tags` and `search_tsv` have no column INSERT or UPDATE;
  - every other _current_ column has both;
  - SELECT and DELETE remain;
  - related table and sequence privileges are unchanged (`species_enrichment` has no sequence; `species_media`'s sequence grant is untouched).
- With nothing writing `tags` in Release A, new rows get the default `'{}'` and existing rows keep their values.

**A5. Per-tag "not evaluated": the full contract.**

- In Release A, a species with `legacy_tags IS NULL` has **all** tags unknown. That includes rows created or annotated after the cutover.
- **The Guide** (`searchGuide`, `species-enrichment.ts:1000-1033`, and `GuideSpeciesRow.svelte`):
  - **per row:** `tags_available: boolean`, and unavailable rows show "Tags not yet available" instead of chips;
  - **per query:** `unknown_count`, the number of species matching every **non-tag** predicate (name/prose search, family, geography, interest, list scope), counted **before** the tag predicate and **before** pagination. It's returned even when the matched page is empty.
  - When a tag filter is active and `unknown_count > 0`, the page shows "N species not yet evaluated for these tags".
  - Unknown species never match a tag filter and are never counted as "none".
- **The species detail page** (`getEnrichment` / `EnrichmentRow` and the "Finding this bird" card): `tags_available`, with the same unavailable copy. The tide gate (`isTideTagged`) reads effective tags as before; an unavailable species has none, which is its current behaviour.
- **Copy:** update the Field Guide empty state and filter help (today it says tags come from AI and are "still filling in"), and review Help and About per the repository rules. They should say tags are being moved to evidence rules, and newly added species show "not yet available".
- Release B generalizes this per tag.

**A6. Static guard test** (regression defense; **the grants are the security control**):

- the AI modules import nothing from the tag vocabulary or validation;
- a scan of non-test runtime SQL in `src/` and `scripts/`, excluding the guard test itself, fails on `tags` or `search_tsv` in an INSERT column list or an UPDATE SET target. It handles aliases, multiline and any case, and parses the SQL template literals rather than raw substrings.
- In Release B, `apply_effective_tags` is the one allow-listed writer.

**Release A tests and invariants:**

- **Migration byte identity:** every row's `tags` and `search_tsv` is exactly identical before and after the migration (row-by-row `IS NOT DISTINCT FROM`).
- **Corpus hash:** SHA-256 over rows ordered by `species_code`. Each row is encoded as JSON `[species_code, tags, search_tsv::text]`, with NULL as JSON null, newline-separated. It's recorded pre and post.
- **Write-cycle invariant:** after a wiki, no-article or prose write, `tags` is byte-identical to before, and `search_tsv` equals `species_search_vector(...)` of the post-write row (the same as the pre-A formula would give for that row). `search_tsv` legitimately changes when its inputs change.
- **Legacy provenance (cutover snapshot):** at cutover, `legacy_tags` is non-NULL exactly where `ai_generated_at` was non-NULL, and equal to `tags`. **After cutover,** a new prose write (`ai_generated_at` set, `legacy_tags` NULL) shows "not yet available".
- **Under `SET ROLE birds_app`** (real-DB tests, owned fixtures only):
  - direct `UPDATE … SET tags`, `SET search_tsv` and `SET legacy_tags` all fail;
  - `INSERT … (tags)` fails;
  - the normal writers succeed, **each exercised on both the INSERT and the ON CONFLICT branch** where it has one:
    - `upsertResolution` (including invalidation);
    - `upsertWikiOk`, `markWikiNoArticle`, `markWikiError`;
    - `upsertAiProseData`, `markAiError`;
    - `upsertMediaOk`, `markMediaError`;
    - `similarCandidatesFor`, `markSimilarDeclined`, `reconcileSimilarState`;
    - `upsertInatSimilar`, `markInatNoMapping`, `markInatError` (including the partner-stale updates);
    - the direct update at `job-handlers.ts:1662`.
- **Trigger behaviour:** an unchanged-input write doesn't recompute; an input write does; a denied direct write fails; the trigger output equals the function. The legacy guard is tested on both the insert and the conflict path, and correctness doesn't depend on trigger order.
- **Search:** after a wiki update, a no-article update and a prose update, `search_tsv` equals `species_search_vector` of the new row, including a species found by field-craft text.
- **Behaviour unchanged:**
  - Field Guide filters (`tags @>` AND, single and multi-tag) return the same results as before;
  - chips and the tide gate are unchanged;
  - "Tags not yet available" shows for a NULL-legacy fixture;
  - Compare persists nothing.
- **Static guard;** idempotent re-run of the migration's checks.
- **Deploy:** the migration runs as `birds_owner`. Before/after hashes and the grant listing are recorded in td-894144.

## Release B: dependencies, availability and approval (normative; complements the implementation spec below)

The rev-8 Release B design (history and state tables, universe and lock protocol, activation, scanner) is **superseded and deleted**. The **"Release B implementation spec"** section is the single normative source for schema, identity, universe, locking, activation, grants and the engine. These three pieces remain valid and complement it:

**Dependencies** (for later tide rules):

- `requires: [activation_id…]`, checked under the exclusive lock.
- A dependency switch is refused while any active dependent references the old activation.
- Tide therefore waits for the coastal habitats.

**Per-tag availability** (generalizing A5): a tag is **known** when it's unowned with non-NULL legacy, or owned with a current state (joined through `species_tag_input.input_hash`) of `assigned` or `not_assigned`; otherwise it's **unknown**.

- The Guide returns `{matched, unknown_count}` per selected tag, and a per-row `partial` flag.
- Cards show only known chips, plus "Some tags not yet available".

**Approval workflow, entirely in the app** (owner decision 8):

- **Proposals live in the database, not repo files.** Table `tag_rule_proposal` (schema in the implementation spec, B2). The engine **never loads** proposals; it loads only `tag_revision` rows.
- **Drafting:** the Tags tab's "Draft rules with AI" button enqueues a worker job. The job makes the metered Sonnet 5 call with the tag definition and the frozen authoring examples, and inserts a `proposed` row. AI output can only ever become a proposal.
- **Cross-check:** CODEX1 (or another model) reviews the proposal. The agent session records the result as a `tag_crosscheck` row (schema in B2), via a script. That's agent work, not the owner's.
- **Approval (owner, in admin):**
  - the proposal page shows the rules readably, the cross-check text and verdict, and the stage report;
  - **Approve** is enabled only when a cross-check exists with `reviewed_sha256 = artifact_sha256` and verdict `approve`;
  - it requires an owner session plus a typed confirmation (the tag name), and calls the definer routine `approve_tag_proposal(proposal_id, user_id)`, which recomputes the hash in the database (B2) and inserts the immutable `tag_revision`.
- **Checks:**
  - the loader and definer routines reject hash mismatches, unknown fields, duplicate ids, oversize rule sets and dependency mismatches;
  - activation derives state only from an approved `tag_revision`;
  - the static guard ensures the AI job modules can't call the approval or activation routines;
  - tests prove the cross-check and hash rules can't be bypassed.

## Release B implementation spec (rev 18; B1 built, B2–B4 for re-review)

### B1: the pure text engine (built; 43 tests; CODEX1-approved; not yet committed)

`src/lib/server/tag-engine/`: `normalize.ts`, `tokens.ts`, `segment.ts`, `rules.ts`, `scanner.ts`. No DB, no AI, no network.

- **Normalization:**
  - NFC; true hyphens (U+2010/2011) become `-`; clause-level dashes become an em dash; curly quotes are straightened; whitespace is collapsed.
  - Matching runs on a lower-cased copy of **identical length**, so evidence offsets (UTF-16) index the display text exactly.
  - `text_hash` is SHA-256 of the normalized `[title, text]` list for the whole article.
- **Tokens:** runs of letters and digits, keeping internal `'` and `-`.
  - **Deviation from the plan (for review):** instead of a Porter2 stemmer (a new dependency), the `stem` matcher accepts only regular English inflections of each phrase word: -s, -es, -ies/-ied, -ed/-d, -ing, and a doubled consonant. Irregular forms are listed as extra phrases. It's deterministic, dependency-free and conservative.
- **Segmentation:**
  - Sections are the extract (`''`) plus stored sections. Stored MediaWiki **sub-headings** (`=== Feeding ===`) become their own subsections ("Behaviour / Feeding"), so the deny policy applies to them and the markers aren't scanned.
  - `Intl.Segmenter('en', sentence)` then a deterministic **abbreviation merge**: a span ending in Dr./St./e.g./c./spp./… or a single initial is joined to the next one. ICU was measured to split "Dr. Smith" otherwise.
  - Clauses split at `; : — ( )` and before but/whereas/while/although/though/however/except.
  - `scanner_rev` = `engine-1|node-…|icu-…|unicode-…`. The Mac and production both run ICU 77.1.
- **Section policy** (part of each ruleset): deny any heading containing taxonom, systematic, etymolog, similar, culture, subspecies or name, with deny winning. Everything stored is otherwise allowed. Stored sections are already filtered by `wikipedia.ts` keywords.
  - Measured on the snapshot, "Description and taxonomy" (211 species) is therefore not scanned. The stage report will show the effect.
- **Ruleset JSON** (`rules.ts`, `parseRuleset`):
  - fields: `schema:1`, `tag`, `rev`, `denySections`, `comparisonMarkers`, `support[] {id, group, match{literal|stem, phrase}, note}`, `exclude[] {id, binds[group|'*'], match, scope{clause|sentence|window before/after ≤12}, note}`, `taxon[] {id, rank order|family, values, action require_one_of|forbid, note}`;
  - rejects unknown fields, duplicate ids, unknown tags, dangling binds, phrases over 6 words or 80 characters, and more than 500 rules;
  - no regex, no weights.
- **Decision order** (`scanner.ts`, `evaluateTag`):
  1. no article → `unevaluated(no_article)`;
  2. taxon forbid → `not_assigned(taxon_forbid:id)`;
  3. require unmet → `not_assigned(requires_unmet:id)`, or an unknown rank value → `unevaluated(taxon_unknown)`;
  4. a support match survives only if its clause doesn't start with a comparison marker, no **other taxon** (a lexicon built once from taxonomy common names, genera and family names, **exempting the focal species' own names**) appears before it in the clause, and no bound exclude fires within its scope;
  5. assigned if any match survives (up to 3 evidence sentences kept), otherwise `not_assigned(no_support | excluded:id | no_focal_support)`, with up to 10 discard diagnostics.
- **CODEX1 review fixes (folded; 43 tests):**
  - taxon checks are order-independent: known disqualifiers first, then any unknown rank gives `unevaluated`;
  - window excludes are clause-bounded;
  - rules and articles share one normalization;
  - empty phrases, markers and binds are rejected, with a 512 KiB cap;
  - "etc./Jr./Sr." merge only before a continuation;
  - the lexicon is ordered deterministically, longest first.
- **Measured** (read-only, all 10,898 snapshot species, **test-fixture ruleset**): 2.5 s total, **0.23 ms per species**, lexicon build 28 ms. The fixture already surfaced a real false positive ("colony size is related to the abundance of **pelagic fish** prey", Great Crested Tern), which is why the rules need AI-drafted and reviewed exclusions.

### B2: database, locking, materialization (rev 18; for CODEX1 re-review)

**Trust boundary (owner decision, 2026-09-29, Option A).**

- The web app and the worker share one database role, `birds_app`, and **the app's own code is trusted**.
- The definer routines, CHECKs, immutability triggers, grants and the branded `TagWriteTx` are **integrity guardrails against bugs, malformed data, and AI output ever reaching tags**. They are **not** protection against a compromised server or deliberately hostile code running as `birds_app`: such code could call the switch, report or state routines directly. That risk is accepted for this three-user app.
- The owner's principle is still enforced structurally where it matters: AI modules can't import the engine or the routines (static guard), AI output has no path to any tag writer, and every activation needs an approved, cross-checked revision plus passing reports produced by the engine's own jobs.
- A separate tag-worker role (Option B) was considered and declined.

**What a decision depends on (P1-1).** A tag result is a pure function of the **input context**:

- the normalized article text (`text_hash`);
- the species' order and family;
- the other-taxon lexicon (`lexicon_hash`: SHA-256 of the sorted lexicon keys built from `taxonomy_cache`);
- the **focal exemptions**, hashed explicitly as `focal_exempt_hash` over the sorted normalized exemption keys (rev 13, CODEX1 P1-1: a taxonomy update can swap names between codes while the global key set stays the same);
- `scanner_rev` (engine version, Node, ICU, Unicode).

`input_hash` = SHA-256 of the canonical JSON of all of these.

**Authoritative current input:** `species_tag_input (species_code PK → species_enrichment ON DELETE CASCADE, input_hash, text_hash, order_name, family_sci_name, lexicon_hash, focal_exempt_hash, scanner_rev, updated_at)`.

- Maintained **only** by the three entry points, inside their locked transaction.
- A row exists **iff** the species is a universe member.
- `species_tag_state` is keyed `UNIQUE (species_code, tag, revision_id, input_hash)`. The _current_ state for an owned tag is the row whose `input_hash` equals `species_tag_input.input_hash`, and **`apply_effective_tags` and every coverage check join through that pointer**. A taxonomy, lexicon or runtime change with identical prose therefore produces a new `input_hash` and a new immutable row, never a collision.
- Composite FKs keep the tags coherent: `species_tag_state (revision_id, tag) → tag_revision (id, tag)`, and the same for `tag_activation`.

**Universe (P1-2):**

- **Members** are species with a **stored article** (`wikipedia_extract IS NOT NULL`) and a current `category='species'` taxonomy row. This is **not** `wiki_status`: `markWikiError` sets `wiki_status='error'` but keeps the last-good article, so the species stays a member and its tags don't flicker.
- Non-members have no `species_tag_input` row and are unknown for every owned tag.

**The only entry points that change membership or input:**

1. **`upsertWikiOk`**: writes the article, recomputes the input, upserts `species_tag_input`, evaluates owned tags, inserts the states, and calls `apply_effective_tags`.
2. **`markWikiNoArticle`**: clears the article, **deletes** `species_tag_input` (the species leaves the universe; no state row, since `text_hash` is NOT NULL), and calls `apply_effective_tags`, which drops the owned tags.
3. **`replaceTaxonomy`**: takes the **exclusive** `tag_engine` lock as its first transactional statement (rev 13, CODEX1 P1-2), while the two wiki entry points take it **shared**. So no wiki transaction can read the old taxonomy or lexicon and commit an old `input_hash` after the replacement. It then recomputes the lexicon.
   - If `lexicon_hash` changed, it **re-materializes every member**. That's measured at ≈2.5 s for 10.9k species, in the same transaction.
   - Otherwise it re-materializes only members whose order, family or category changed, and deletes `species_tag_input` for species leaving `category='species'`.

`markWikiError` and the other ~15 writers (listed in rev 11) change neither membership nor input and take no lock. That's re-verified here against `species-enrichment.ts:254–264`: error keeps the stored article.

**Lock guarantee (P2):** instead of a dev-only assertion, lock-taking is **unrepresentable to skip**.

- The three entry points accept only a branded `TagWriteTx` executor, which can be obtained only from `withTagWriteTx(fn)`.
- **The one executable path (rev 17)**, used by `withTagWriteTx(mode, failureKey, fn)` for **every** tag-affecting transaction (both wiki entry points, `replaceTaxonomy`, activation, rollback, consistency repair batches):
  ```
  preAttemptNo := begin_tag_attempt();              -- autocommit, BEFORE the transaction
  BEGIN;
  SET LOCAL lock_timeout = '10s';
  SET LOCAL statement_timeout = '60s';
  SET LOCAL transaction_timeout = '<cap>';          -- 30s exclusive, 20s shared
  SELECT pg_advisory_xact_lock[_shared](TAG_ENGINE_KEY);       -- 1st work statement
  SELECT pg_advisory_xact_lock(TAG_FAILKEY_NS, hashtext(failureKey)); -- 2nd: serialize this failure key
  postAttemptNo := begin_tag_attempt();              -- 3rd: fresh token, now truly ordered for this key
  ... fn(tx, postAttemptNo) ...                      -- no row lock before this point
  clear_materialization_failure(failureKey, postAttemptNo);   -- on success, inside the transaction
  COMMIT;
  on error (mechanical rule, rev 18):
    token := postAttemptNo IF it was allocated, ELSE preAttemptNo
    -- i.e. any failure before postAttemptNo exists (BEGIN, SET LOCAL, the engine lock,
    -- OR the failure-key lock timing out) stamps with preAttemptNo; only failures after
    -- both locks were acquired and postAttemptNo exists stamp with postAttemptNo.
    follow-up: record_materialization_failure(failureKey, entry, err, token)
  ```
  - **failureKey:** the species code for the wiki entry points; `global:replaceTaxonomy`, `global:activate:<tag>`, `global:rollback:<tag>` or `global:consistency` otherwise.
  - **Lock order is fixed:** `TAG_ENGINE_KEY` first, then exactly **one** failure-key lock, then row locks. Every transaction takes at most one failure-key lock and always after the engine lock, so no deadlock cycle is possible.
  - **Why the key lock:** the wiki entry points hold the engine lock _shared_, so two transactions for the same species could otherwise both pass it and draw post-lock tokens in an order unrelated to their commits. The key lock serializes same-key transactions **before** the post-lock token is drawn, so token order equals commit order for that key. Exclusive transactions are already serialized; they take the key lock anyway for one uniform path.
  - The SET LOCALs are configuration, not work.
  - **Integration tests:**
    - the order of settings and locks, and a `lock_timeout` rather than a hang;
    - **two-session same-key shared writers, in both commit orders:** (a) A succeeds then B fails → B's failure uncleared; (b) A fails then B succeeds → cleared;
    - **engine lock acquired but the same-key failure-key lock times out** (another session holds the key lock): the follow-up records through `preAttemptNo`, with no secondary error from an undefined post token;
    - different species run concurrently under the shared lock without blocking each other.
  - Every tag-affecting transaction takes the advisory lock before any row lock, so there's no tag-lock/row-lock cycle.
- **Test:** a deterministic two-session test pauses `replaceTaxonomy` after writing the candidate taxonomy and proves no wiki transaction commits an old `input_hash` afterwards.
- The worker's autocommit wiki writes and `enrichOneNow` (lock before `upsertResolution`) are rewritten to use it, and `replaceTaxonomy` runs inside it.
- The static guard fails if any other code constructs a `TagWriteTx`.

**Grants (P1-4).** Migration 0066 first runs `REVOKE ALL` on every new table and sequence from `birds_app` and `PUBLIC` (undoing the 0002 default privileges), then grants exactly:

- `species_tag_input`, `species_tag_state`: SELECT only. Writes go through **definer routines**.
- `tag_rule_proposal`: SELECT, plus column INSERT (`tag, artifact, source, ai_usage_call_id`). `status` defaults to `proposed` and changes only via definers.
- `tag_crosscheck`, `tag_revision`, `tag_activation`, `tag_ownership`: SELECT only (definers or owner-role scripts write them).
- `tag_report`: SELECT only. `record_tag_report` (definer) inserts with a server-computed body hash; rows are immutable.
- **B4 tables** (superseded by B4h, rev 24): `tag_authoring_example`, `tag_eval_set`, `tag_eval_item`, `tag_eval_label` and their identity sequences get REVOKE ALL from birds_app and PUBLIC, then **SELECT only**; every write goes through a definer (see B4h).
- `tag_materialization_failure`: SELECT only (definer).
- `tag_consistency_run`: SELECT only; `record_tag_consistency_run` (definer) inserts; immutable.
- **IDs (rev 14):** the one table `birds_app` inserts into directly (`tag_rule_proposal`) uses a `uuid DEFAULT gen_random_uuid()` primary key, so there's no sequence access. Definer-inserted tables may use identity columns.
- **Every sequence** backing the new tables, including `tag_attempt_seq`, is `REVOKE ALL` then not granted: it's used only inside definers. Catalog assertions cover sequences, and a test performs a real `birds_app` insert into each directly writable table.
- Catalog assertions in tests cover every table: no inherited table-level DML.

**Definer routines** (all `SECURITY DEFINER`, `SET search_path = pg_catalog, public`, schema-qualified, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO birds_app`):

- `record_tag_input(code, input jsonb)`: validates the shapes, computes `input_hash` **in SQL** from the canonical jsonb text, and upserts.
- `record_tag_state(code, revision_id, input_hash, status, reason, evidence)` (under Option A, an integrity check, not an authority check):
  - checks `input_hash` equals the current `species_tag_input.input_hash` for the code;
  - the revision exists and its tag matches;
  - the status/reason/evidence shape (CHECK constraints: `assigned` ⇒ reason NULL and 1–3 evidence items; `not_assigned`/`unevaluated` ⇒ reason in the bounded vocabulary and evidence empty).
  - A caller **can't** write state for a stale input or the wrong tag.
  - It's **idempotent**: on conflict, the existing row must be byte-identical in status, reason and evidence, otherwise it raises an integrity error. Two evaluations of the same input can never silently disagree.
- `apply_effective_tags(code)`: the ordered merge (rev 8 B2), reading owned-tag state **only** through `species_tag_input`.
- `approve_tag_proposal(proposal_id, user_id)` (P1-5):
  - computes the artifact hash **in the database** as `encode(sha256(convert_to(artifact::text,'UTF8')),'hex')`.
  - **Hash-byte contract (rev 13):** this is the _PostgreSQL-normalized storage identity_ of the jsonb value, not a general canonical JSON. The TS side must `SELECT artifact::text AS artifact_text` and hash `Buffer.from(artifact_text,'utf8')` exactly, never re-serializing. It's pinned to the Postgres major version (17) and re-verified on any upgrade. Tests cover nested keys, Unicode, escapes, and numeric scale/exponent (`1` vs `1.0` differ by design).
  - `tag_rule_proposal.artifact_sha256` is **maintained by a BEFORE INSERT trigger** that sets it from the same expression, and an UPDATE of `artifact` or `artifact_sha256` is rejected. It **can't be a generated column**: `convert_to()` is STABLE in PG17 (catalog-verified by CODEX1), and generated columns need IMMUTABLE functions. The migration test creates the real column and trigger and checks it.
  - requires an immutable `tag_crosscheck` for that proposal with `reviewed_sha256` equal to it and verdict `approve`;
  - requires `proposal.tag = artifact->>'tag'`;
  - inserts `tag_revision` with the recomputed hash.
  - **`user_id` is audit data, not authentication.** The auth boundary is the admin route plus the worker's execution-time role recheck, and the tests say so explicitly.
  - The TypeScript loader hashes the same `artifact::text` fetched from the database, never its own serialization.
- `switch_tag_ownership(tag, revision_id, gate_report_id, benchmark_report_id, user_id)`: see the activation protocol.
- `rollback_tag(tag, user_id)`.
- `begin_tag_attempt() RETURNS bigint`: definer, `nextval('tag_attempt_seq')`. birds_app has no sequence privilege; this is the only way to get a number.
- `record_materialization_failure(key, entry_point, error, attempt_no)` and `clear_materialization_failure(key, attempt_no)`: signatures as in the failure contract below.

**Activation protocol (P1-6), one executable path.** The worker job `tag_activate`:

1. Run **the rev-17 executable path** in exclusive mode with `failureKey = global:activate:<tag>`: `preAttemptNo` (autocommit), BEGIN with the SET LOCALs (`transaction_timeout` 30 s), the exclusive engine lock, the failure-key lock, then `postAttemptNo`.
2. Load the revision artifact from the database and re-hash it; abort on mismatch.
3. For every member, read `species_tag_input`. Where no state exists for `(revision, input_hash)`, meaning drift since staging or new members, **compute it in TypeScript** and insert it via `record_tag_state`. The rest came from the staging job.
4. Call `switch_tag_ownership`, which checks:
   - the revision is approved;
   - `gate_report_id` and `benchmark_report_id` are immutable reports **of kinds gate and benchmark, for the same tag and revision, with `body->>'passed' = 'true'`**;
   - dependency activations are active;
   - **coverage**: exactly one state row per member for `(revision, current input_hash)`. "Extras" means only a second current candidate for a member, or a state for a current input that doesn't belong to a universe member. Old `input_hash` history is immutable and ignored.

   It then inserts `tag_activation`, moves `tag_ownership`, and calls `apply_effective_tags` for the candidate set (species whose current `tags` contain the tag ∪ those whose new state is assigned), writing only where the result differs.

5. COMMIT.

The job's cancel flag is honoured only **before step 1**. After the lock is taken, the transaction runs to commit or rollback. Rollback uses the same shape with `rollback_tag`.

**Failure contract (P1-7; hardened in rev 13 and 14).** `tag_materialization_failure (key PK, species_code NULL, entry_point, error, first_failed_at, last_failed_at, last_attempt_no bigint, attempts, cleared_at, cleared_by_attempt_no bigint)`:

- `key` = the species code, or `global:<entry_point>` for failures with no species (`replaceTaxonomy`, lock or setup failures).
- Error text is sanitized (`sanitizeErrorText`) and truncated to 500 characters.
- **Ordering is monotone by a database-issued attempt number (rev 14):**
  - **Two tokens (rev 16; executable form in rev 17's path above):**
    - **Pre-lock token:** the caller runs `begin_tag_attempt()` as its own autocommit call **before** the locked transaction. It's used **only** if the attempt never acquires the advisory lock (`lock_timeout`, connection or setup failure), so such a failure still has an ordered number.
    - **Post-lock token:** drawn only after **both** the engine lock and the failure-key lock (rev 17). It's used for the successful `clear_…` inside the transaction, and carried out to the follow-up for any in-lock failure stamp.
    - Operations are serialized by the lock, so a post-lock token reflects the real serialized order. Rolled-back transactions still keep their numbers (`nextval` isn't transactional), so the follow-up stamp can use it.
  - `record_materialization_failure(key, entry_point, error, attempt_no)` writes only if `attempt_no >` the row's `last_attempt_no` **and** `>` its `cleared_by_attempt_no`.
  - `clear_materialization_failure(key, attempt_no)` **upserts a tombstone** (sets `cleared_at`, and `cleared_by_attempt_no = greatest(existing, attempt_no)`) even when no failure row exists.
  - A failed attempt A whose follow-up stamp lands after a successful later attempt B is therefore ignored, including when no row existed before.
  - The table columns are `last_attempt_no bigint` and `cleared_by_attempt_no bigint` (replacing the UUID and timestamp fields).
  - **Tests:**
    - A fails, B succeeds, then A's stamp (with a pre-existing row, and with none) leaves the key cleared.
    - A fails at lock acquisition, then B succeeds, then A's delayed pre-lock stamp leaves the key cleared.
    - **The inverse:** A takes its pre-lock token and stalls before the lock; B acquires, succeeds and clears (post-lock token); **A then acquires, fails inside the lock and stamps with its post-lock token**, and A's failure **stays uncleared**.
- **The worker:** the locked transaction rolls back, then a **follow-up** transaction calls `record_materialization_failure`, which upserts, increments `attempts` and sets `last_failed_at`. The wiki stage's normal retry and backoff apply.
- **`enrichOneNow`:** the error propagates as today and is also recorded.
- **Clearing:** a later successful entry-point transaction for the code calls `clear_materialization_failure`, setting `cleared_at`.
- **Health:** the Server health tab and Tags tab count rows where `cleared_at IS NULL`.

**CHECKs and immutability (P2):**

- enums for status, action, source and verdict;
- 64-hex shape for every hash;
- evidence/reason combinations as above;
- the report's `(tag, revision_id)` must match its referenced revision;
- `tag_activation.previous_activation_id` must be the tag's current activation at insert (checked in the definer);
- `UPDATE`/`DELETE` blocked by trigger on proposals (except `status` via definer), crosschecks, revisions, activations, reports, states, and eval sets once frozen.

**Transaction shape is decided by measurement (rev 13, CODEX1 P2).** The 2.5 s figure is a pure-scan measurement, not a transaction budget. Before choosing the simple in-transaction path for activation and full re-materialization, a birds_test benchmark measures the complete transaction: input upserts, one state row per member per owned tag, `apply_effective_tags` writes with the search-vector trigger, indexes, WAL and commit. It covers the pilot (1 tag) and a projected 10-tag case, recording wall time, CPU, WAL, rows, dead tuples and lock-hold time.

- The **lock budget** is ≤ 10 s for the exclusive hold on the shared droplet. That's a benchmark gate, backed at runtime by PG17 **`SET LOCAL transaction_timeout = '30s'`** on every exclusive-lock transaction, a hard whole-transaction cap (lock_timeout 10 s only bounds acquisition).
- **If the 10-tag case exceeds the budget:** stop, write the generation/compare-and-swap staging schema and its race tests into this plan, and have them reviewed before implementing that branch. The pilot (1 tag) may proceed in-transaction if it's within budget.

**B2d benchmark (2026-09-29, birds_test on the M4; test-fixture ruleset; batched writes):**

| Step                                                               | Time                      | Lock      | WAL           |
| ------------------------------------------------------------------ | ------------------------- | --------- | ------------- |
| inputs for all 10,898 species (first bootstrap / a lexicon change) | 7.3 s first, 4.0 s re-run | exclusive | 24.7 MB first |
| stage one ruleset (10,886 states, 175 assigned)                    | 5.9 s                     | shared    | 9.5 MB        |
| activation dry run (drift + switch + candidate apply)              | **0.8 s**                 | exclusive | —             |

- Before batching, staging took 16.9 s and activation 2.0 s. The fix: one universe scan per operation, and one round trip per 500 rows for inputs, states and merges.
- **Within budget:** activation, the wiki entry points, and `replaceTaxonomy` with **no** owned tag, or with an unchanged lexicon (a small changed set).
- **Over budget:** `replaceTaxonomy` when the **lexicon changes while tags are owned**: all inputs plus every owned tag's states under the exclusive lock, projected at about 10 s per owned tag on the M4 and more on the droplet. Per rev 13's rule, that branch is specified below and reviewed before it's built.

**Taxonomy name change while tags are owned: generation-keyed batched repair (rev 21, for review; revs 19–20 revised per CODEX1).**

**State.** `tag_lexicon_state` gains:

- `repair_generation bigint NOT NULL DEFAULT 0`;
- `repaired_generation bigint NOT NULL DEFAULT 0`;
- `repair_target_lexicon_hash text NULL`.

**Pending ⇔ `repaired_generation < repair_generation`.** The flag is never a bare boolean. It is written only through definers:

- `begin_tag_repair(target_hash) → generation` requires the exclusive engine lock. It increments `repair_generation` and sets the target.
- `complete_tag_repair(generation) → boolean` requires the exclusive engine lock. It is a compare-and-swap:
  1. Return false if `repair_generation <> generation` or `lexicon_hash <> repair_target_lexicon_hash`.
  2. Otherwise verify **in SQL** that the repair workset (below) is **empty**; if not, raise. Emptiness means:
     - membership holds in both directions (every universe member has an input pointer; no non-member has one);
     - every pointer has exactly the target `lexicon_hash` and the current `scanner_rev`;
     - every current owned activation has a state for each member's current `input_hash`.
  3. Otherwise set `repaired_generation = generation` and return true.

**Repair workset (rev 21, CODEX1 P1).** One SQL view-like query, `tag_repair_workset(target, scanner_rev)`, lists the codes needing work as the union of:

- (a) universe members with **no input pointer**;
- (b) members whose pointer has `lexicon_hash <> target` **or** `scanner_rev <> current`;
- (c) members whose pointer is current but that **lack a current state for any owned tag**;
- (d) **non-member pointers** (row iff member: the same invariant switch_tag_ownership already enforces as "extras").

The repair batch materializes (a)–(c) and deletes (d) through `materializeMany`, which already does both per row. The CAS predicate is exactly "this workset is empty", so the loop is self-healing: whatever the CAS would reject, the next batch selects.

**Trigger.** `replaceTaxonomy` runs in exclusive mode, as built. **When the lexicon hash changed and at least one tag is owned**, it:

1. writes the taxonomy and lexicon state;
2. re-materializes only species whose own taxon row changed;
3. calls `begin_tag_repair(new_hash)` → generation G;
4. **inserts the repair job in the same transaction** (rev 21, CODEX1 P2), on `tx.client`, never by calling `enqueueJob` inside the tag transaction:
   - a `jobs` row: **type `tag_repair`** (a distinct, non-recurring, cancellable type), payload `{repairGeneration: G}`, dedup key **`tag_repair:g<G>`**, label "Tag repair (taxonomy change, generation G)", max_attempts 4, with the same ON CONFLICT … DO NOTHING as `enqueueJob`;
   - **and** its `'enqueued'` `job_events` row.

   `requested_by` is the parent `sync_taxonomy` job's `requested_by`. It's the only caller (job-handlers → `syncTaxonomy` → `replaceTaxonomy`), and `replaceTaxonomy` gains a `requesterId` parameter. The shared insert is factored as `insertJobOn(client, params)`, used by both `enqueueJob` and this path.

The bump and its job therefore commit atomically. A generation-qualified key can never dedupe onto a job for an older generation. That closes CODEX1's finalization-window race: an old job that already finished its CAS, but hasn't yet terminalized its row, has key `g<G-1>`, so G gets its own job.

**Repair job** (type `tag_repair`; rev 21 split from `tag_consistency` because `requestCancel` refuses every RECURRING type, CODEX1 P1). The job type is wired like the others: jobs_type_check (a new migration), JobType, handler, TYPE_NAMES, **not** in RECURRING_TYPES, and cancel honoured between batches. The nightly `tag_consistency` stays a non-cancellable recurring singleton.

1. Read the state. If `repaired_generation ≥ G` or `repair_generation > G`, it is a no-op success: a newer generation owns its own job, created atomically by its own bump.
2. Otherwise loop: under `withTagWriteTx('exclusive', 'global:repair')`, take the next 100 codes of `tag_repair_workset(target, current scanner_rev)` and pass them to `materializeMany` (materialize members, delete non-member pointers). Hostile review reduced the production batch from 200 after repeated 1.18 s / 1.25 s lock-budget failures; 100-code reruns held the measured gap to 220–227 ms.
   - Each batch re-checks `repair_generation = G` under the lock. If it's newer, the job stops (no-op success).
3. When a batch finds the workset empty, the **same exclusive transaction** calls `complete_tag_repair(G)`.
4. The job is cancellable between batches. A cancel leaves the generation pending: this is visible in the admin Tags tab, which offers **Resume repair**; that re-enqueues `tag_repair:g<G>` if none is active.
5. The nightly `tag_consistency` run also re-enqueues (via `enqueueJob`, outside any tag transaction) `tag_repair:g<current>` when the state is pending and no active job holds that key. That is the belt-and-braces recovery after a crash, cancel or dead job.

**Semantics while pending** (unchanged from rev 19):

- Each species row derives wholly from the old or the new lexicon.
- Wiki saves use the new lexicon.
- Exclusive batches never overwrite a newer wiki-derived input.

**What is refused while pending:**

- `switch_tag_ownership` (activation) and **revision** rollback (`rollback_tag` whose target is a previous revision) are refused until the generation converges.
- **Retire to legacy stays available** as the emergency escape (CODEX1 P2):
  - `rollback_tag` whose target is `to_legacy` is allowed;
  - a new explicit `retire_tag_to_legacy(tag, user_id)` definer (exclusive lock; admin; activation row `to_legacy`) is allowed whatever the chain;
  - both are surfaced in the admin Tags tab as **Retire tag to legacy**, with an owner-visible confirm.
- Retiring is lexicon-independent. It removes ownership **and re-applies the affected candidate set in the same exclusive transaction**, so retirement and repair batches serialize, and `apply_effective_tags` then restores the legacy baseline for that tag (including NULL-baseline rows, per the CODEX1 fix). Other owned tags' rows keep their internally consistent states.

**Tests** (real DB, owned fixtures, exclusive batches forced small):

1. A lexicon change with an owned tag bumps the generation and creates the `tag_repair:g<G>` job **plus its `enqueued` event** in the same transaction. A forced rollback of replaceTaxonomy leaves no state bump, job or event. The job's `requested_by` is the parent sync job's requester.
2. **The finalization-window race:**
   - job G completes its CAS, and before its row terminalizes, a second replaceTaxonomy bumps to G+1;
   - job `g<G+1>` is created, not deduped;
   - it converges, and `repaired_generation = G+1`.
3. An older job that sees a newer generation stops as a no-op success.
4. **Workset self-healing:** plant each class (a) missing input, (b) stale lexicon, (b′) stale scanner_rev, (c) current input missing one owned state, and (d) a non-member pointer. For each:
   - `complete_tag_repair` raises while it's present;
   - the repair job **actually repairs** it;
   - the CAS then succeeds.

   Also: a wrong generation returns false.

5. Activation and revision rollback are refused while pending. Retire-to-legacy succeeds while pending and restores legacy tags, including a NULL-baseline row.
6. **Retire with a second owned tag:** retire tag X both **before** and **after** a repair batch, while tag Y stays owned. Y's effective tags and states stay consistent with each row's single current input, and X is back to its legacy value everywhere.
7. A wiki save during the repair derives from the new lexicon, and a later batch does not overwrite it.
8. **Cancel:**
   - the server `requestCancel` on a running `tag_repair` job flags it; the job stops between batches, and the state stays pending;
   - the nightly run re-enqueues it, and it converges; a second pass fixes 0;
   - `requestCancel` on the `tag_consistency` singleton is still a no-op;
   - the Tags-tab Cancel and Resume controls are exercised in the GROK UI pass.
9. Each batch's exclusive hold is under 1 s on the benchmark fixture.

**Lock order** (CODEX1-checked): `claimNextJob` is one autocommit UPDATE, released before the handler enters the tag transaction, and terminalization happens after it. The in-transaction job INSERT touches only the new generation's row. That separation is normative.

**Scanner revision guard (rev 14, CODEX1 P2).** `scanner_rev` also carries `ENGINE_SOURCE_HASH`, a constant in `segment.ts`. A test recomputes SHA-256 over the semantic engine sources (`normalize.ts`, `tokens.ts`, `segment.ts`, `rules.ts`, `scanner.ts`, excluding comments and whitespace) and **fails if it differs from the constant**. A semantic engine change can't ship without a new `scanner_rev`, which changes every `input_hash`, so the consistency job re-materializes everything.

**Tests** (additions):

- every definer's refusal cases;
- `record_tag_state` with a stale `input_hash`;
- a lexicon change re-materializing everything;
- `markWikiError` keeping a species in the universe;
- the name-swap regression (focal exemptions change while the global lexicon key set doesn't; `input_hash` must change);
- the two-session `replaceTaxonomy` vs wiki race;
- idempotent `record_tag_state` (identical OK, differing raises);
- `markWikiNoArticle` removing it and its owned tags;
- activation with drift between staging and switch;
- gate or benchmark report mismatch (wrong tag, revision or kind, or not passed);
- a cancel after the lock is ignored;
- `TagWriteTx` can't be constructed outside `withTagWriteTx` (the static guard and a type test);
- catalog grant assertions for every new table;
- the failure-log lifecycle.

### B3: admin Tags tab and consistency job

As rev 10, built on the tables above. **Job wiring checklist (P2):** migration `jobs_type_check`, the `JobType` union, the handler switch, payload validation, dedup keys, `TYPE_NAMES`, `RECURRING_TYPES` and scheduler reconciliation for `tag_consistency`, an execution-time admin recheck, and explicit cancel semantics (activation: only before the lock).

All owner actions are buttons; long work runs as worker jobs:

- `tag_draft_rules`: the AI proposal, metered;
- `tag_stage_report`;
- `tag_design_simulation`;
- `tag_gate_report`;
- `tag_benchmark`: EXPLAIN (ANALYZE, BUFFERS, WAL) of the switch in a rolled-back transaction;
- `tag_activate` / `tag_rollback`;
- `tag_consistency`: nightly.

### B4: the open-ocean pilot flow (rev 27 implementation spec, for CODEX1 review)

**Owner decisions (2026-09-29), answering CODEX1's rev-22 review:**

1. **The gate is pragmatic, not survey-grade.** It measures two claims about the rules, precision and retention of the legacy tag's real positives, from a frozen, fingerprinted stratified sample. There is no Monte Carlo design, no genus-reserved acceptance frame, and no estimate over the "neither system tags it" population.
2. **Labels measure what the article says.** Gaylon is not an ornithologist, so there is no "is it true" question at all.

Every rev-22 correctness finding that survives these decisions is fixed below. Every step is an admin button or a worker job. **Migration 0071 is amended** before any deploy (it's applied only to birds_test).

**B4a. Authoring set.**

- `tag_authoring_example (tag, species_code, genus, frozen_at)` is frozen by the first draft, through the definer `freeze_tag_authoring_set` (an idempotent first-writer).
- **Four cells of 12**, each ordered by `md5(code‖tag)`, taking what exists if a cell is short (the shortfall is recorded):
  - legacy-yes marine;
  - legacy-yes non-marine;
  - legacy-no marine;
  - **legacy-no non-marine with a cue word** (the trap cell: sea crossings, islands, name-only mentions).
- The model sees each species' order, family and ≤ 6 cue sentences. It never sees legacy values or labels.
- **No eval exclusions.** The gate's estimand is this rule set's decisions over the finite universe, and each eval set is a fresh independent random draw. So species that shaped the draft are ordinary members, sampled with their true inclusion probability. Overfitting only affects generalising beyond this population, and the gate doesn't claim that.

**B4b. AI drafting** (`tag_draft_rules`), as rev 22 with these changes:

- The **definition must exist in `TAG_DEFINITIONS`**.
- The loader validates in the handler, with one retry.
- The job result lists **every** attempt's ai_usage call id, model and loader error. The proposal stores the successful call's id.
- The dedup key is `tag_draft_rules:<tag>`, concurrency-safe via the jobs partial unique index.
- The cue lexicon and marine list are **design artifacts with a SHA-256** recorded in the draft result, the simulation report and the set design.

**B4c. Cross-check recording (CODEX1 P1-8).**

- `record_tag_crosscheck(proposal_id, reviewer, verdict, text)`:
  - locks the proposal;
  - **recomputes** `artifact_sha256` from `artifact` and records that value, with no caller-supplied hash;
  - requires status `proposed`/`crosschecked`;
  - requires `reviewer` from the fixed set {CODEX1, CODEX};
  - sets `crosschecked`.
- **EXECUTE is granted to no app role.** It's executable only by `birds_owner`, so no route or worker path can synthesize an approving row. The agent script `scripts/tag-crosscheck.mjs` (`show`, then `record` after the reviewer's verdict) runs with the owner credentials over SSH on the droplet (or `.env.test` locally). A static guard fails if any `src/` file names `record_tag_crosscheck`.

**B4d. The frame and strata** for revision r:

- **Frame** = universe members that have a current state for r **and** (`rules_yes` ∨ `legacy_yes`).
  - `rules_yes` = state `assigned`.
  - `legacy_yes` = the **displayed legacy value** (`legacy_tags ∋ tag`). A NULL legacy baseline displays no tag today, so it counts as no; the report states how many frame species have no baseline.
  - Species neither system tags are **outside every gate claim**, and the report says so.
- **Strata:**
  - **A** = rules ∧ legacy;
  - **B** = rules ∧ ¬legacy;
  - **C1** = ¬rules ∧ legacy ∧ marine (rules state `not_assigned`);
  - **C2** = ¬rules ∧ legacy ∧ ¬marine (rules state `not_assigned`);
  - **U** = legacy ∧ rules state `unevaluated`.
  - They're exhaustive and disjoint over the frame by construction; each item also stores its own flags.
- **Frame hash** (CODEX1 P1-2; exact byte contract in §B4i) covers every member's (species_code, stratum, input_hash, rules_yes, legacy_yes) plus the design hash. The design hash covers the marine list, cue words, named cases, the fixed evaluator deny list and the evaluator-text version. It's recorded on the simulation report and the set. Any difference refuses sampling or readiness; there's no tolerance.

**B4e. The two claims and their bounds (rev 24; supersedes the rev-23 estimators and intervals).**

- K_h is the number of real positives (label "yes") in stratum h. The claims are:
  - **precision** = (K_A + K_B)/(N_A + N_B);
  - **retention of legacy's real positives** = K_A/(K_A + K_C1 + K_C2 + K_U). This is the owner's claim: of the birds the old AI tagged correctly, how many the rules keep. New rules positives (B) **cannot** compensate (CODEX1 rev-23a P1-1).
- **Unsure answers take their worst value per claim** (CODEX1 rev-23 P1-1): for precision, unsure → no; for retention, A-unsure → no and C/U-unsure → yes. This is the exact worst case, because retention is increasing in K_A and decreasing in the lost total.
- **Exact finite-population bounds:**
  - each stratum's K_h gets an exact **hypergeometric** one-sided bound (the inverted tail; a census stratum is exact);
  - the claim's one-sided α = 0.025 is split equally (**Bonferroni**) across the non-census strata the claim uses;
  - precision_lower = Σ K_lo(A, B)/N_R; retention_lower = K_lo(A)/(K_lo(A) + Σ K_hi(C1, C2, U)).
  - Coverage is ≥ 97.5% one-sided **by construction**. All-yes, all-no and small cells are handled exactly; there are no pseudo sample sizes and no log singularities (CODEX1 rev-23a P2-1).
- **Undefined denominators** (CODEX1 rev-23 P1-5, rev-23a P1-2):
  - N_A + N_B = 0 means "the rules assign no species": undefined, **gate fails**;
  - a used stratum with n = 0 is undefined, and the gate fails;
  - when **no legacy positive can have been lost** (every C/U stratum is empty or censused at zero), retention's lower bound is 1. It's vacuous only if A is also censused at zero;
  - a non-census C/U sample that sees no positives still has K_hi > 0, so the lower bound comes from the data and zero observed positives never passes by default.
- **Sample validation** (CODEX1 rev-23a P1-4, rev-24 P1-3): every stratum's N and n are integers with 0 ≤ n ≤ N; the observation count per stratum equals n exactly; species are unique. Each item carries rules_yes, legacy_yes, **rules status** and the **marine** proxy, and `stratumOf(status, legacy, marine)` must reproduce its stratum, so a C1/C2/U swap is rejected. Anything else throws before any estimate.

**B4f. Gates: one authoritative JSON, confirmed and frozen at set creation (CODEX1 rev-23 P1-3).**
The exact bytes are `PROPOSED_GATES` in eval-stats.ts. As stored (jsonb canonical text) they are:
`{"unsure": "worst case per claim", "version": 1, "precision": {"lower_min": 0.85, "point_min": 0.95}, "retention": {"lower_min": 0.9}, "undefined": "fails, except retention when no legacy positive can be lost", "confidence": "one-sided 97.5% exact, Bonferroni across non-census strata", "named_cases_must_not": ["amekes", "egygoo", "osprey"]}`

- The **pinned DB hash** is `24ae83e5f160eb506c29c14bf913cf2fd97183b52375b7331d594b1454971604`, asserted by a test (CODEX1 rev-26 #3).
- The pinned open-ocean design hash is `ae5bcf16efc793b5ebb1f15fa11a1198c9e90f2585d8dda5d011674a2f0c6d9b`. The evaluator-text version has a single source, and lists are sorted by code point (#5).

- `passed` is computed by **one function** (`evaluateGate`) from the **stored** JSON only (parsed strictly: version, keys, thresholds in [0,1], code grammar): precision.point ≥ point_min ∧ precision.lower ≥ lower_min ∧ (retention.lower ≥ lower_min ∨ vacuous) ∧ no `named_cases_must_not` code assigned in the staged states (CODEX1 rev-24 P1-1).
- The owner's confirmation is stored with the set: user, time, and the exact JSON with its SHA-256.

**B4g. Sizing, on the same exact bounds (CODEX1 rev-23a P2-2).**

- For each candidate allocation and each grid scenario, plug in the expected counts x_h = round(p_h·n_h) and compute the **same** exact point and lower bound.
- **Criteria (worst over the 72-scenario grid):**
  - precision point − lower ≤ **0.10** (an expected-count gap target, **not** a power guarantee, per CODEX1 rev-24 P2-1);
  - retention point − lower ≤ **0.07**.
- **Allocation:** n_h = min(N_h, 5); then greedily add the unit with the largest excess reduction. If no single unit helps (integer-step plateaus), add to the stratum with the most unsampled units; ties go in the order A, B, C1, C2, U. The cap is 1,000.
- Reports: `needsOwnerDecision = total > 250`. **Measured:** for frames of about 400–870 species, the total is about 230–530. The exact method costs labels, so **expect the owner's > 250 decision**.
- **The coverage unit test is a guard, not the justification:**
  - 12 predeclared finite populations (3 shapes × 4 rate profiles, including all-positive strata, tiny U and zero-rate U), 400 draws each at the sizeDesign n;
  - the truth may fall below either lower bound in at most 3.5% of draws;
  - a failure is a **hard stop** that needs a plan revision, with no automatic fallback (CODEX1 rev-23 P2-2).

**B4g2. The sampling contract (CODEX1 rev-23 P1-2).**

- The `tag_eval_create` job runs **one REPEATABLE READ transaction**:
  1. recompute the frame and its DB-canonical hash (B4i);
  2. refuse unless it equals the simulation report's frame hash;
  3. select by **SHA-256 rank** ("sha256-rank-v1"; the seed is secret until the set exists, so a keyed hash is equivalent to HMAC here and core `sha256()` is available in SQL): for each stratum, sort frame members by `sha256(seed_hex ‖ "|v1|" ‖ tag ‖ "|" ‖ revision ‖ "|" ‖ stratum ‖ "|" ‖ species_code)`, then by `species_code COLLATE "C"` as a tiebreaker, and take the first n_h;
  4. call `create_tag_eval_set`. It re-checks the frame hash inside the same transaction, inserts the items (UNIQUE set+species) and stores in the design:
     - algorithm "sha256-rank-v1";
     - the 32-byte crypto seed (hex);
     - N_h, n_h and π_h = n_h/N_h;
     - the selected codes;
     - the frame and design hashes.
- **A recorded design is never trusted (CODEX1 rev-26 #1).** `tag_eval_create` recomputes `sizeDesign(body.N)` (N is verified against the live frame by the definer) and demands exact agreement of n, total, feasible and `needsOwnerDecision`, plus the current design hash and the sizing targets and grid (compared by canonical JSON). The over-budget decision uses the **recomputed** total. Tests cover four forgery shapes.
- **The design records `pi` and `selectedCodes`**, and `create_tag_eval_set` refuses unless both equal its own recomputation (#4). The items table remains the full record.
- **Grants (#2):** `tag_eval_frame_rows` is internal: an explicit `REVOKE ALL … FROM PUBLIC, birds_app`. `tag_eval_frame_hash` stays app-executable. Both are asserted with `has_function_privilege`.
- **Hard stops (CODEX1 rev-25 P2-6):** the design job and set creation refuse when `buildFrame.missingStates ≠ 0` (run the stage report first) or when `sizeDesign.feasible` is false.
- **No operator substitution** (CODEX1 rev-24 P1-4): `create_tag_eval_set` **recomputes** the frame in SQL, verifies its hash, **recomputes the ranked selection from the stored seed and n_h**, and refuses unless the supplied item codes, strata and flags equal it exactly. Only the masked text snapshots come from the job (the app's own code, Option A). A test tampers with one code and is refused.

**B4h. Evaluator text and blind labelling (CODEX1 P1-6, P1-7).**

- **The evaluator text is revision-independent.** It's the stored article minus a **fixed global** section list: headings containing taxonomy, systematic, etymolog, subspecies, in culture, references, further reading, external links, gallery or notes (exactly `EVAL_TEXT_DENY`), with the species' **common name, genus and species epithet masked** as "[this bird]" / "[genus]". The frozen cue words are **underlined as a fixed reading aid**: the same on every page and for every system, never rules output. `eval_text_hash` is the label identity (CODEX1 rev-24 P1-2). It's the SHA-256 of the evaluator-text version, the deny list, the underlined cue words and the masked sections, so a label is reused only for an identical page.
- **Labels belong to (tag, species_code, eval_text_hash)** and are reused by later sets whenever the text is unchanged. So a re-draft only asks about new or changed text.
  - The table is `tag_eval_label (id uuid, tag, species_code, eval_text_hash, label, labeled_by, first_set_id, created_at, UNIQUE (tag, species_code, eval_text_hash))`, **immutable** (write-once).
  - A later set's item resolves its label by joining `(set.tag, item.species_code, item.eval_text_hash)`.
  - `freeze_tag_eval_set` counts an item as labelled if that join finds a row, whichever set created it.
  - `record_tag_eval_label` refuses an already-labelled page, so no later item can overwrite a prior answer.
  - A test covers a second set whose only unlabelled page is a new species, and its freeze.
- **Flow on `/admin/tags/[tag]/label/[set]`:**
  - a random item token (no name) and the masked text;
  - the owner answers **"Does this text say the bird uses the open ocean as habitat?"** yes / no / unsure;
  - after **Save**, the page reveals which bird it was (context only, no question), then goes to the next item.
  - **An answer is write-once.** There's no revision after the reveal, and no adjudication pass; unsure answers take their worst value per claim (§B4e).
  - Progress shows the overall count only.
- **Writes go only through definers.**
  - `record_tag_eval_label(set_id, item_id, user_id, label)`:
    - locks the set row `FOR SHARE` and requires `labelling`;
    - checks the item belongs to the set;
    - is write-once;
    - takes the timestamp server-side;
    - does an admin audit check.
  - `freeze_tag_eval_set` locks the set `FOR UPDATE`, so a label and a freeze can't interleave.
  - **birds_app gets SELECT only on every B4 table**, after an explicit `REVOKE ALL … FROM birds_app, PUBLIC` for the tables and their sequences. The route does an admin check at execution time.

**B4i. Sets, the frame hash, and gate-checked activation (CODEX1 rev-23 P1-4, P2-1, P2-3).**

- `tag_eval_set (…, status labelling|frozen|abandoned, design, frame_hash, gates, gates_sha256, gates_confirmed_by, gates_confirmed_at, …)` is created only by `create_tag_eval_set`.
  - A trigger guards the lifecycle: labelling → frozen or labelling → abandoned only. Frozen and abandoned sets are immutable.
  - Approving a new revision retires nothing.
- **A DB-canonical frame hash:** `tag_eval_frame_hash(tag, revision_id, marine_orders text[], design_sha256)` is SQL, and it's the single source of truth for both the job and the switch.
  - It covers universe members with a current state for the revision that are rules-yes or legacy-yes, ordered by `species_code COLLATE "C"`.
  - **Exact bytes (rev 26):** per row, in `species_code COLLATE "C"` order, `len:code|len:stratum|len:input_hash|len:com_name|len:sci_name|r|l|`, with a **trailing `|`**. Lengths are UTF-8 octets, r and l are 0 or 1, and missing names are the empty string. The rows are concatenated, prefixed with `"tagframe-v1|" + design_sha256 + "|"`, then SHA-256.
  - `eval-frame.ts canonicalFrameHash` is the byte-identical TypeScript mirror. **Species codes are asserted ASCII**, so JS ordering equals C collation; names may be any UTF-8.
  - **Binding of the page (CODEX1 rev-25 P1-1).** The evaluator page is built from segmentArticle's normalized sections, exactly what `input_hash`'s text_hash covers. It's masked with the common and scientific names, which the frame bytes now carry, and rendered per the design, which the design hash covers (version, deny list, cue words). So anything that changes `eval_text_hash` changes the frame hash. A regression test changes only a scientific epithet.
  - Cross-check tests: SQL = TS on planted fixtures, row reordering, and the rename regression.
- **Activation verifies the gate inside the exclusive transaction, after materialization** (CODEX1 rev-23 P1-4). `switch_tag_ownership` is amended (CREATE OR REPLACE):
  - for the gate report it requires body.setId → a **frozen** set of the same tag and revision → `gates_sha256` = the SHA-256 of the report's gates → **`set.frame_hash = tag_eval_frame_hash(…)` computed right there**, after the activation's drift completion, under the exclusive lock;
  - the caller can't supply the hash;
  - drift at any point before the switch refuses it with "frame changed: run a new blind test". Labels are reused by text, so only changed text needs new labels.
- **The benchmark no longer uses provisional reports.** `switch_tag_ownership(…, p_dry_run boolean)` skips the gate and benchmark report checks only when `p_dry_run`, and then **always raises** `TAG_DRY_RUN` at its very end, so a dry run can never commit. The provisional-report path and the "provisional" exemption in the report trigger are removed.
  - **Evidence survives (CODEX1 rev-25 P1-4):** the caller runs the dry switch inside `SAVEPOINT tag_dry_run`, catches `TAG_DRY_RUN`, runs `ROLLBACK TO SAVEPOINT` (the transaction is usable again), reads the WAL delta and the timings, then rolls the whole transaction back via TagTxRollback.
  - The benchmark report is recorded afterwards, in its own statement. The tests prove the report carries timing and WAL > 0 and that no activation, ownership or tag change persists.
- **Gates hash (CODEX1 rev-25 P1-2):** `gates_sha256 = sha256(convert_to(gates::text, 'UTF8'))` (jsonb's canonical text), computed by `create_tag_eval_set`. Both the report trigger and the switch require `report.body.gatesSha256 = set.gates_sha256`, and the switch **recomputes** it from `set.gates`. The pass decision is computed from `set.gates` only. There's a test where a lax-gates hash is refused.
- **Exact grants:**
  - `birds_app` gets SELECT on `tag_authoring_example`, `tag_eval_set`, `tag_eval_item` and `tag_eval_label`, and nothing else on them or their sequences. It gets EXECUTE on `freeze_tag_authoring_set`, `create_tag_eval_set`, `record_tag_eval_label`, `freeze_tag_eval_set`, `abandon_tag_eval_set` and `tag_eval_frame_hash`.
  - `record_tag_crosscheck` gets **no** EXECUTE for birds_app; it's owner-role only.
  - `tag_rule_proposal` keeps its column INSERT (0066).
- **Rollback to a previous revision** needs no gate. It's the documented emergency path, and retire-to-legacy is always available.

**Tests (rev 25):**

- **Unit, eval-stats (34 pass):**
  - exact hypergeometric bounds: census, all-yes, all-no, and a brute-force inversion;
  - the two claims, with B unable to compensate retention;
  - worst-case unsure, including the mixed assignment;
  - zero, undefined and lost-none denominators;
  - strict validation, including a C1/C2/U swap;
  - the stored-gate authority (stored thresholds decide; an assigned must-not case fails; a malformed or unversioned JSON is refused);
  - sizing: the criteria hold, and greedy is within 3 of the brute-force minimum;
  - 12-population lower-bound coverage, where a null bound is an assertion failure;
  - single-stratum two-tail coverage.
- **Unit, eval-text:** masking, the fixed deny list, cue underlining, and the label identity changing with the cue words.
- **Real DB:**
  - authoring freeze;
  - owner-only cross-check (hash recomputed, reviewer set, no app EXECUTE, and the static guard);
  - label definer (write-once, status, item-in-set, and the freeze race);
  - SQL frame hash = TS `canonicalFrameHash` on planted fixtures (reordering, delimiters);
  - frame-drift refusal;
  - `create_tag_eval_set` refusing a tampered selection and reproducing it from the stored seed;
  - label reuse by eval_text_hash;
  - the gate trigger;
  - the switch refusing a gate whose frame drifted after materialization;
  - the dry-run switch never committing.
- **Mocked routes:** every action.
- **UI:** the label page at 320/390 on Chromium, WebKit and the iOS Simulator (AGY3 until the GROK reset).

## Evaluation (Release B gate)

**Superseded by B4 rev 24** (owner decisions 2026-09-29: a pragmatic two-claim gate; labels measure what the article says). The normative evaluation is §B4d–B4i: the frame (rules ∨ legacy), strata A/B/C1/C2/U, masked revision-independent text, exact hypergeometric bounds with a Bonferroni split, the authoritative gate JSON (§B4f) and must-not named cases.

The earlier truth label B, the neither-system strata, the recall-difference gate, adjudication and the genus-disjoint sets are **withdrawn**.

## Rollout and end state

- **Order:** open ocean → the other coastal habitats → tide → the forage outliers → the rest of habitat and forage → movement → time and finding. Each has its own approval, simulation-sized blind test and gate.
- **A tag that fails its gate:** assign it by rules at lower recall, or retire it from the filters. No vocabulary or URL change without the owner.
- **End state:** every tag is owned. `apply_effective_tags` ignores `legacy_tags`, which is archived.
- **Measurement** is read-only, with no scratch tables. Reports (stage, design simulation, gate, benchmark) are produced by **worker jobs**, stored as report rows, and viewed in the Tags tab.

## Admin Tags tab (new in rev 10; built with Release B)

A new tab in `/admin`, owner-only, phone-friendly (checked on the iOS Simulator). One screen per concern:

1. **Overview**, one row per vocabulary tag:
   - its source: legacy, or rules/model with the revision;
   - counts of assigned, not-assigned, not-evaluated, and species with no legacy baseline;
   - the last activation and its date;
   - a health badge from the nightly check.

   Release A can show a minimal version (legacy coverage and not-evaluated counts); the full tab arrives with Release B.

2. **Tag detail:**
   - activation and rollback history (from `tag_activation`), with who, when and the linked reports;
   - the current revision's rules, shown readably, not as raw JSON;
   - sample assigned and rejected species with their evidence sentences;
   - a search box: "why does species X have or lack this tag?", showing its state row, evidence or reason, and the article revision.
3. **Proposals:** "Draft rules with AI", the proposal list, the cross-check text and verdict, and the **Approve** / **Reject** actions (B8).
4. **Reports:** buttons that enqueue worker jobs, with results rendered in the app:
   - **stage report:** what the revision would assign or remove, with samples;
   - **design simulation:** the per-stratum n and the expected interval widths, plus the ">250" warning;
   - **gate report:** confusion counts, estimates and intervals vs the confirmed gates;
   - **switch benchmark:** duration, WAL and dead tuples on the live table, dry-run in a rolled-back transaction.
5. **Blind labelling:** the labelling page of §B4h (masked text, no system output), with **overall** progress only (rev 24).
6. **Activate / Roll back:**
   - **Activate** is enabled only when the revision is approved, the gate report passed the owner-confirmed gates, and the benchmark is recorded.
   - Both buttons need a typed confirmation, run as a worker job calling the definer routines under the exclusive lock, and show progress and the result.
7. **Consistency:** the nightly job's run history and any fixes or failures, with a "Run now" button.

**Server health tab:** add a "Tags" line showing the last consistency run, the fixes it made, and the count of uncleared `tag_materialization_failure` rows.

## Nightly tag consistency job (new in rev 10; built with Release B)

An independent safety net that doesn't trust the writers to have done their part.

- **Worker job type `tag_consistency`:** a recurring singleton, daily at a quiet hour (the same pattern as `scan_need_alerts`). It can also be run from the Tags tab.
- **For every owned tag, over the universe, in bounded batches of 200 species. Each batch is one call to `withTagWriteTx('exclusive', 'global:consistency', fn)`**, the single rev-17/18 executable path (pre token, SET LOCALs with a 30 s cap, the exclusive engine lock, the failure-key lock, post token, the batch, clear; the mechanical token rule on error). A repair can't read an old article or taxonomy while a wiki write commits a newer input, because wiki writes hold the shared lock, which excludes it. Each batch is short (≈200 × 0.25 ms of scanning plus writes), so wiki saves wait at most one batch. 0. **recompute the expected input** (rev 14, CODEX1 P1-4/P2) for every species from the authoritative sources (`species_enrichment` article, `taxonomy_cache` order and family, the current lexicon and focal-exemption hashes, the current `scanner_rev`). Compare it with `species_tag_input`, and **repair the pointer** (upsert, or delete for non-members) where it differs, counting each repair as a fix. Only then:
  1. **missing or stale state:** no `species_tag_state` row for the active revision whose `input_hash` equals the species' current `species_tag_input.input_hash` (rev 13: every staleness check joins through the input pointer, so taxonomy, lexicon, focal-exemption and scanner drift are all caught, not just text). Rules-owned tags are re-materialized; model-owned tags get `unevaluated(awaiting_model_score)` and are enqueued in `model_rescore_queue`.
  2. **effective drift:** stored `tags` differs from what `apply_effective_tags` would produce. The routine is re-applied.
  3. **universe drift:** new or retired taxonomy members since the last activation are handled as in 1.
  4. **integrity:** `legacy_tags` corpus hash unchanged since cutover; no species with a non-NULL legacy baseline created after cutover; grants still as specified (catalog check).
- **Records** a `tag_consistency_run (id, started_at, finished_at, checked, fixed_by_reason JSONB, failures JSONB, status)` row.
- **Alerting:** any fix or failure is a **code-path bug signal**, because the writers should have prevented it. It raises a badge on the Tags tab and the Server health tab. Optionally it sends a web push to admins through the existing push infrastructure (owner's choice, off by default).
- **Cost:** hashing ≈11k normalized articles plus a set comparison takes seconds on the droplet. The measured duration is recorded in each run row.
- **Tests (real DB, owned fixtures):** each of the four checks detects and fixes a planted inconsistency, **including one planted drift per non-text input** (order, family, focal exemptions, lexicon, scanner revision). A clean database gives `fixed = 0`. The job is idempotent and respects the lock order. **An opposing-interleaving test** (a wiki write committing a new article between the batch's read and its repair) proves the repair never overwrites a newer input: the wiki write either finishes before the batch acquires the lock, or waits until the batch commits and then writes its newer input.

## Phase 2: learned challenger models (after Release B)

**What's unchanged from rev 7:**

- Local classifiers, never generators: rules; a per-tag logistic regression over masked word and stem features at the sentence level; and a local sentence encoder plus a per-tag classifier.
- A text model _can_ learn shortcuts, so a tag needs a qualifying sentence above a frozen, calibrated threshold that **also** passes the Release B evidence rules, with species and genus names masked.
- Weak labels are noisy and abstaining.
- Four owner-labelled or weak sets, disjoint by genus: train/weak, tuning and calibration, model selection, and a fresh acceptance set.
- Artifacts, embeddings and weights stay on the Mac, with an immutable manifest. Production stores only revision metadata, state and evidence.
- **No command line (rev 10):** Mac-side training and scoring run in a **small local worker app**, `~/birds-tag-models`. It's a local web UI served by a macOS LaunchAgent at a fixed `localhost` port, with **Train**, **Evaluate**, **Score queued species** and **Export bundle** buttons. It reads the rescore queue and articles from a production export file downloaded from the Tags tab, not from a direct production connection. It writes a signed-by-hash result bundle. The owner uploads that bundle in the Tags tab ("Import model results"). The import is validated as specified, then activated with the same buttons.

**New in rev 8 (the P1-5 fix):**

- **Activation drift:** production can't recompute model state. So under the exclusive lock, a model switch **re-checks the imported compare-and-swap** (`wikipedia_rev_id`, `text_hash`) for every universe member. Any drifted member gets a fresh `unevaluated(awaiting_model_score)` state, is enqueued, and is removed from effective tags. It's never scored with stale state.
- **`model_rescore_queue`:**
  - **Key:** `(species_code, tag, revision_id, text_hash)`, unique.
  - **Producer:** the wiki transaction, under the shared lock, whenever the article text of a model-owned tag changes. It's atomic with the unevaluated state row.
  - **Lifecycle:** pending → exported (with an export watermark and batch id) → imported, or failed with retry count and backoff. Plus a terminal **superseded** state, for exported work whose `text_hash` changed before import. Stale exports never live forever.
  - **Activation-time drift** enqueues in the same transaction as the switch.
  - **Import idempotency key:** SHA-256 of `(manifest hash, batch id, sorted (species, tag, text_hash, status, evidence hash) tuples)`.
  - **Import rejects:** a stale `text_hash`, an unknown batch, missing or extra rows, or a mismatched manifest hash. The import hash is idempotent.
  - **Cleanup:** entries completed for more than 30 days are purged.
- **Model reasons:** `below_threshold`, `evidence_gate_failed` (not_assigned); `awaiting_model_score` (unevaluated).

**Education deliverables:** a doc per model with worked examples, and an admin "explain this tag" view. See also the separate LLM-lab plan (`~/birds-llm-lab/docs/plan.md`), a local teaching app.

## Critical files

- **Release A:**
  - `backend/db/migrations/0065_tag_safety.sql`: `legacy_tags` and its guard, `species_search_vector` and its trigger with the abort check, the grants rework;
  - `src/lib/server/ai-enrichment.ts`, `job-handlers.ts`, `species-enrichment.ts`: tags removed from AI, `upsertAiProseData`, `tsvExpr` removed, availability fields;
  - `src/routes/species/…`, `GuideSpeciesRow.svelte`, the species card: the unknown states;
  - the static guard test.
- **Release B:**
  - `0066_tag_engine.sql`: history, state, proposal, cross-check, report and consistency-run tables, plus the definer routines;
  - `src/lib/server/tag-engine/`: normalize, segment, lexicon, scanner, materialize, activation jobs, consistency job, report jobs;
  - `src/routes/admin/tags/…`: the Tags tab (overview, detail, proposals, reports, labelling, activate/rollback, consistency);
  - the Server health "Tags" line;
  - agent-only scripts for tests and cross-check recording. **No owner-facing scripts.**

## Verification

- **Release A:** all the A-section tests and invariants; `npm run check` and the full vitest suite pass; CODEX1 high review of code and migration; GROK UI check that the Field Guide filters, chips and "not yet available" state work on desktop and the iOS Simulator; deploy on the owner's go, with hashes and grants logged.
- **Release B:**
  - the B-section tests, including concurrency, round-trip, coverage-abort and dependency;
  - the consistency-job tests;
  - the Tags tab actions: owner-only, typed confirmations, hash and cross-check gating, and AI job modules unable to reach approval or activation;
  - then, **all run from the Tags tab**: the benchmark, the design simulation, blind labelling, the gate report, and activation on the owner's go.
  - GROK UI check of the whole Tags tab, desktop and iOS Simulator.
- **No live AI in tests.** Proposal runs are the only AI spend; metered and reported.

## Appendix: td-5086cc (closed 2026-09-26)

The 266 species excluded from enrichment are mostly extinct or lost birds with no eBird data, and only 1 was ever attempted. It was closed as low value, with the evidence logged.
