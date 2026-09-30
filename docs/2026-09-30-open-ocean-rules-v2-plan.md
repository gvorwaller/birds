# Open-ocean rules, second approach — td-894144 B5 (plan)

**Status:** rev 14 (2026-09-30, CC). **CODEX1: PASS, ready to build.** Awaiting the owner's go. The owner decided §4: (b).

**Revision history:**
- **Rev 14:** CODEX1 rev-13 review (2 P1, plus cleanup; CODEX1 accepts td-b99b6d as not blocking).
  - A committed `started` is an irrevocable authorization for exactly one provider call and its receipt.
  - The authoring-set freeze is fenced.
  - The catch-rethrow source scan is B5-only.
- **Rev 13:** CODEX1 rev-12 review (2 P1).
  - Every fenced check requires `status = 'running'`, so a claim dies when its job leaves running.
  - **Scope:** zero side effects on a stale claim is guaranteed for the **B5 jobs** (`tag_draft_rules`, `tag_preview`), because every side effect sits behind a fenced SQL checkpoint (§3cc).
  - Pre-side-effect checkpoints in the *existing* handlers are a pre-existing gap, mitigated by the single-worker advisory lock and tracked separately as **td-b99b6d**.
- **Rev 12:** CODEX1 rev-11 review (2 P1, 1 P2). The claim is bound to the execution context through `AsyncLocalStorage`, with no mutable registry. `updateProgress` throws `StaleClaimError`, caught once at the `runJob` boundary, and business catch blocks rethrow it. `terminalizeAndReschedule` gets a transaction-aware fenced CAS. "No call-site changes" is withdrawn.
- **Rev 11:** CODEX1 rev-10 review (2 P1). Rev 10's monotonic attempts is **withdrawn**: `attempts` also drives retry backoff (`retryDelayMs`), failure text and progress rounds, so its semantics stay exactly as today. The fence is a separate monotonic `jobs.claim_seq`, applied in the holder process through a claim registry inside jobs.ts, with no call-site changes. `updateProgress` is fenced and reports `stale` distinctly. §3bb is unchanged (CODEX1: sound).
- **Rev 10:** CODEX1 rev-9 review (2 P1).
  - **The fence is monotonic `attempts` for every job** (§3z replaced). A drain or yield no longer refunds `attempts`; it raises `max_attempts` by 1 instead. The retry budget is unchanged, and every existing `(status, attempts)` CAS in `transition()` becomes a unique per-claim fence. The rev-9 `claim_token` is dropped.
  - `create_ai_tag_proposal` inserts the proposal **and** terminalizes the job in one transaction (§3bb).
- **Rev 9:** CODEX1 rev-8 review (1 P1). The round and proposal fence uses a per-claim `jobs.claim_token` (a uuid, new on every claim, never refunded), not `attempts`, which a drain refunds. The duplicate §7 entries are removed.
- **Rev 8:** CODEX1 rev-7 review (2 P1, 1 P2), set out in §3z–§3aa and §7.
  - Every round-event and proposal definer is fenced on the job's `attempts`.
  - Proposal creation is atomic at the final round, and rounds are frozen afterwards.
  - The §7 migration checklist lists every rev-5 to rev-8 mechanism.
  - The exact rule for excluding the `PREVIEW_SOURCE_HASH` line.
- **Rev 7:** CODEX1 rev-6 review (2 P1, 1 P2), set out in §3w–§3y, which override earlier wording.
  - A DB-enforced state machine for round events.
  - Proposals are created only through definers that bind an AI artifact to its completed round.
  - `PREVIEW_SOURCE_HASH` is taken over raw bytes.
- **Rev 6:** CODEX1 rev-5 review (3 P1, 2 P2), set out in §3r–§3v, which override earlier wording.
  - Examples come from a full collection of accepted hits with an explicit order.
  - Draft calls are checkpointed per round, with a hard ceiling of 4 calls per job across retries.
  - A Preview re-run with a different body is an integrity failure.
  - Draft provenance is DB-bound, and the proposal guard covers `draft_job_id`.
  - `PREVIEW_SOURCE_HASH` uses the engine-guard canonicalization.
- **Rev 5:** CODEX1 rev-4 review (5 P1, 2 P2), set out in §3k–§3q, which override any earlier wording they touch.
  - Preview certifies the whole input through one SQL input-hash encoder, focal exemptions included.
  - Scope algebra is defined.
  - Example-sentence selection is exact, and the Preview source is hash-guarded.
  - `schema_version` is NOT NULL and CHECKed.
  - Previews are inserted only through a definer function.
  - AI rounds go to their own capped table.
  - Preview transaction options are specified.
- **Rev 4:** CODEX1 rev-3 review (5 P1, 2 P2). §3d, §3e, §3g–§3j and §4 are rewritten as one normative text, and superseded wording is removed.
  - **Simplification:** Preview no longer stratifies by `ai_model`. Legacy tags are immutable by trigger (0065), so the baseline hash and its lock problem disappear.
  - Preview inputs are the DB-recorded tag inputs; a stale input refuses the Preview.
  - The preview design hash is pinned in SQL and tested against TS.
  - The schema-2 `preview_id` requirement is enforced in the DB.
  - `reference_sha` is defined, and the reference is snapshotted into `tag_eval_item`.
  - The 1 MB byte cap is defined over the canonical jsonb text.
- **Rev 3:** CODEX1 rev-2 re-review (4 P1, 1 P2), set out in §3g–§3j.
  - The cross-check is bound to an exact Preview, and approval re-verifies it under the exclusive lock.
  - Preview currentness covers a baseline/provenance hash and a preview design hash, with k defined.
  - The evidence schema is bounded, with one taxon item and scopes carried on text items.
  - Each frame row and eval_text_hash binds the actual family reference shown; a missing reference is a hard stop.
  - Preview rows are immutable and completed-only, with bounded bodies.
- **Rev 2:** CODEX1 rev-1 review (7 P1, 4 P2). A complete taxon truth table with overlap rejection; genus as an explicit hashed input; an evidence union; a proposal-preview table (a migration); the label claim chosen explicitly, with an independent family reference; the evaluator design bound into eval_text_hash; a schema 1/2 union with a scanner_rev bump; a sanitized, recorded and deterministic self-check; Preview required before cross-check and approval.
- Rev 1: first draft.
**Builds on:** [2026-09-26-ai-tag-accuracy-plan-CC.md](2026-09-26-ai-tag-accuracy-plan-CC.md) (rev 27; B1–B4 deployed, latest d991544).
**Nothing here changes what users see** until a revision passes the same blind-test gate and the owner activates it.

## 1. Why a second approach

Two Claude Opus 5 drafts of `habitat:open-ocean` (proposals 939a4378, eda27977) both passed the loader, and both would fail the gate. Each was dry-run with the real loader and scanner over the 10,886 stored articles in birds_test (read-only).

| | Draft 1 (939a4378) | Draft 2 (eda27977) |
|---|---|---|
| Species assigned | 186 | 172 |
| Legacy positives kept (of 348) | 168 | 155 |
| New species that are clearly wrong | ≥ 6 of 18 | ≥ 10 of 17 |
| American Kestrel / Osprey / Egyptian Goose | excluded | excluded |

Examples of the wrong additions:
- Mallard, Black Swan, Lesser Whistling-Duck: "open sea within sight of the coastline".
- Blue-winged Teal and American Golden-Plover: "over open ocean" on migration.
- Striped Flufftail: "at sea level".
- American White Pelican: "avoid the open ocean".
- Australian Fairy Tern: "pelagic schooling fishes", which describes its prey.

Draft 2 also dropped 89 core pelagic birds, including Sooty Shearwater, Northern Royal Albatross, Gentoo Penguin, prions, storm-petrels and boobies.

**Root cause (evidence, not the model):** the articles of real ocean birds rarely *describe the habit*; they state *what the bird is*.
- Sooty Shearwater: "a medium-large shearwater in the seabird family Procellariidae".
- Surf Scoter: "a large sea duck".
- Antarctic Prion: "small petrels of the Southern Ocean".

The rule language (B1) has only three tools:
- global support phrases;
- excludes;
- *negative* taxon rules (forbid, require_one_of).

So a draft must choose between missing the petrels and admitting every gull, cormorant and duck that the word "seabird" or "at sea" touches. More drafting rounds hit the same wall.

**Not the cause: thin text.** Measured on prod, the median stored article length is:
- 4,057 characters for legacy open-ocean species;
- 3,231 characters for Procellariiformes.

The fetch keeps whole habitat, behaviour and feeding sections (`wikipedia.ts`, 8,000 characters per section).

## 2. The legacy baseline is uneven by model (prod, read-only)

| Model that wrote the legacy tags | Species | Tagged open-ocean | …in land-bird orders | Petrels + penguins tagged |
|---|---|---|---|---|
| Haiku 4.5 | 8,806 | 146 | **40 (27%)** | 50 / 54 |
| Sonnet 5 | 1,717 | 148 | 5 (3%) | 76 / 76 |
| Opus 5 | 366 | 54 | 0 | 33 / 33 |

This comparison is crude: land orders are a proxy for wrong tags. Still, the kestrel-type errors are overwhelmingly Haiku's.

Consequences for the gate:
- Retention is measured against legacy's **real** positives, as labelled. Haiku's wrong tags therefore do not make retention harder; they are simply not real positives.
- But they do enlarge stratum C, and so the labelling cost.

## 3. Proposal (B5)

### 3a. Positive taxon rules: `assign`

New taxon action `assign` at rank `order`, `family` or `genus`. Species in a listed taxon are assigned with **taxon evidence** (§3e), with no text match needed.

**Genus is an explicit input.** A single shared parser, `genusOf(sci_name)`, returns the first token when it matches `^[A-Z][a-z]+$` and null otherwise (mononyms and malformed names). `TaxonInput` becomes `{ order, family, genus }`. Genus joins the DB-canonical input record: `record_tag_input` and the `species_tag_input` hash gain `genus`. It is carried through materialize, activation staging, consistency, frame drift and taxonomy repair. It no longer rides accidentally inside `focal_exempt_hash`. **This needs a migration (0072).**

**Truth table.** The result is order-independent within each step, and every known disqualifier is checked before any unknown can win (the B1 invariant):

1. **Known disqualifiers first.** Any `forbid` whose rank value is known and listed gives `not_assigned(taxon_forbid)`. Any `require_one_of` whose rank value is known and not listed gives `not_assigned(requires_unmet)`. All requires AND together, as today.
2. **Unknowns among forbid and require.** If any forbid or require rank value is unknown, the result is `unevaluated(taxon_unknown)`, as today.
3. **Assign.** Assign rules OR together. If any assign's rank value is known and listed, the result is `assigned`, with the single bounded taxon evidence item of §3e.
4. **Phrases.** Only when no assign matched. A scoped support rule (§3b) is **eligible** only when its scope rank value is known and listed.
5. **Unknowns among assign and scope.** Suppose no support survives. If any assign rank value, or any scope rank value of a support rule that would otherwise have matched, is unknown, the result is `unevaluated(taxon_unknown)`. Otherwise it is `not_assigned(no_support)`.

**Assign∩forbid and assign∩require overlaps are refused.** The loader-side check (extending `checkTaxonRules`) enumerates the whole species taxonomy. It **rejects** any artifact where a species matched by an assign is also forbidden, or fails a require. The error lists every overlapping species and rule pair. So forbid-beats-assign never silently defeats a more specific assign. An overlap that appears later through reclassification is reported by the nightly consistency job, as a new integrity class `taxon_overlap`. It then shows on the Tags tab, and the owner retires or re-drafts.

**Tests:** permutations of every rule order give identical results. Cover each truth-table row, including known assign plus unknown require rank; unmet require plus matching assign (refused by the loader); multiple assigns; mononym and malformed sci_name; a genus-only sci_name change (the input hash changes, and repair re-evaluates); a name swap under the same global lexicon; and replaceTaxonomy racing a shared writer.

### 3b. Taxon-scoped support phrases

A support rule may carry `taxa: [{ rank, values }]`. The scope is **only an eligibility filter**. An eligible phrase still goes through every existing check:
- comparison markers;
- other-taxon clause discard;
- excludes and their scopes;
- the focal-subject rule.

Evidence shows the surviving sentence **and** the matched scope. Unknown scope rank is handled by step 5 above.

**Regressions, inside a scope:** prey ("pelagic schooling fishes"), negation or avoidance ("avoids the open sea"), migration over ocean, "sea level", other-bird comparisons, and a missing scope rank.

### 3c. Draft self-check (adaptive drafting, not validation)

After a draft passes the loader and overlap checks, the draft job runs the Preview computation (§3d) over the pinned corpus snapshot. It returns to the model **only engine-computed diagnostics:**
- aggregate counts;
- by-order and by-family tables of rules-only and legacy-only species;
- the deterministic example sets from §3d, each with its triggering or best-candidate sentence.

**Never sent:**
- any eval label, blind-test set membership, seed or gate outcome;
- free-text cross-check comments. They may carry species-level conclusions or gate details; the previous draft's *artifact* may be sent.

At most 3 revise rounds. **Every round is recorded** in `tag_draft_round` (§3p): the diagnostics sent, the output, any loader or overlap error, the ai_usage call id, the model, and the corpus fingerprint. The final artifact is re-previewed on one pinned snapshot, and that preview is the one stored with the proposal.

The final blind gate stays honest for this finite corpus because it samples fresh after the revision is frozen, and it is judged only by owner labels the drafter never saw. Preview is **descriptive, never pass or fail**.

**Cost:** up to about 4 Opus calls, roughly $1–1.50 per draft, using the Model choice → Tag rules model.

### 3d. Preview (normative; rev 4)

**What it computes.** A `tag_preview` job runs the proposal's artifact through the scanner over every tag-universe species, **inside one `withTagWriteTx` shared-lock transaction at REPEATABLE READ**. It uses the same snapshot for inputs, fingerprint and insert.

**Inputs are the DB-recorded tag inputs.** For each species:
- the job computes `segmentArticle(...).textHash`, exactly as the materializer does;
- it requires that hash to equal `species_tag_input.text_hash`, with order, family, genus, lexicon_hash and scanner_rev matching as well.

On any mismatch the Preview **refuses**, stating that the tag inputs are stale and that it will run after the consistency job. It never scans text other than what the recorded inputs certify. Every writer of `species_tag_input` already runs under the shared engine lock (B1–B3), so an exclusive-lock holder sees a stable input set.

**`corpus_fingerprint`** = sha256 of `"tagcorpus-v1|" ‖ lexicon_hash ‖ "|" ‖ scanner_rev ‖ "|"`, followed by one record per universe species in species_code `COLLATE "C"` order. Each record is `len:code|len:input_hash|`. The function `tag_corpus_fingerprint()` (SQL, SECURITY DEFINER) computes it, and the job reads it back from SQL in the same snapshot. TS never supplies it.

**Legacy baseline:** `legacy_tags` is immutable by trigger (0065), and universe membership is inside the fingerprint, so no separate baseline hash is needed. **`ai_model` is not used by Preview at all.**

**`preview_design_hash`:** a SQL function `tag_preview_design_hash(tag)` returns a pinned constant per design version. The TS source computes the same value from its canonical bytes, and a test asserts they are equal (the PROPOSED_GATES pattern). The canonical bytes cover:
- the algorithm id `preview-v1`;
- the marine-proxy order set and the named must-not cases (from the tag's eval design);
- the strata definition: **rules-only / legacy-only × marine proxy × order**;
- **k = 4 per stratum** and a **total cap of 60**, filled round-robin in the fixed stratum order: rules-only before legacy-only, marine before non-marine, then orders by code point.

Within a stratum, species are ordered by `sha256("preview-v1|" ‖ artifact_sha256 ‖ "|" ‖ code)`. Named must-not cases are always included, and they count against the cap first.

**Body:** aggregates; by-order and by-family tables; the full additions and drops (§3j bounds); and the example sets, each with its triggering or best-candidate sentence.

**Storage and currentness:** see §3j (rows) and §3g (binding). A Preview is **current** when:
- its `artifact_sha256` equals the proposal's;
- its `corpus_fingerprint` equals `tag_corpus_fingerprint()` now;
- its `preview_design_hash` equals `tag_preview_design_hash(tag)` now.

The proposal card marks a non-current Preview **stale** and offers **Preview** again.

### 3e. Evidence union (normative; rev 4)

Every result keeps **1–3 evidence items**.
- **Text:** the existing shape. **Schema-1 text items are byte-identical**, with no new keys; absence of `kind` means text. A schema-2 text item may add `scopes: [{ rank, value }]`: the eligibility scopes that admitted the phrase, sorted by rank (order, then family, then genus) and then value. The loader limits each support rule to **at most 3 `taxa` entries**, so `scopes` is never truncated.
- **Taxon:** a result assigned by taxon has **exactly one** evidence item, `{ kind: "taxon", matchedCount, matchedRules: [{ ruleId, rank, value }] }`. `matchedRules` is sorted by rank and then ruleId, and capped at 5; `matchedCount` is the true count.

The DB state-boundary check (0072) validates both shapes and all bounds. Rendering: "assigned because family Procellariidae is listed"; for scopes, "counted because this bird is in family Laridae".

### 3f. Schemas 1 and 2

- **Parsing:** `parseRuleset` parses schema 1 and schema 2 as a discriminated union. Schema 2 adds `assign`, `genus` rank and support `taxa`.
- **Old revisions:** approved schema-1 revisions and rollback stay loadable, with byte-identical decisions and evidence, pinned by a schema-1 golden corpus regression.
- **Repair on a semantic change:** the scanner change bumps `ENGINE_SOURCE_HASH` / scanner_rev and runs the existing full repair/consistency path for every owned tag. None is owned today, but the path is exercised in tests.
- **Proposal sources:** the DB literal is `source = 'human'` (not "manual"). Hand-written proposals use it.

### 3g. Cross-check and approval bound to a Preview (normative; rev 4)

- **Schema version in the DB:** `tag_rule_proposal` gains a stored generated column `schema_version` (`(artifact->>'schema')::int`). `tag_crosscheck` gains `preview_id` (an FK to `tag_proposal_preview`). A trigger on `tag_crosscheck` **requires `preview_id` when the proposal's schema_version is 2**, and requires that preview to belong to the same proposal and artifact. This is a DB boundary, not a script convention.
- **Recording:** `record_tag_crosscheck(...)` takes the tag-engine **exclusive** lock. It then selects the one Preview that is current (§3d), recomputing both hashes with the SQL functions, and binds it. If none is current, recording refuses. The caller never supplies a hash.
- **Approving:** `approve_tag_proposal(...)` takes the exclusive lock and, in that transaction, recomputes currentness. It approves a schema-2 proposal only if the approving cross-check's `preview_id` is current.
- **Races are closed by the lock:**
  - input writers hold the shared lock;
  - Preview build and insert run under the shared lock in one snapshot;
  - record and approve run under the exclusive lock.

  A corpus change between cross-check and approval therefore makes that cross-check non-authorising, and a new cross-check against the new Preview is required.
- **Race tests:** a wiki/input change, a taxonomy replace, and a design-hash change, each between Preview and cross-check and between cross-check and approve.

### 3h. (merged into §3d and §3g in rev 4)

### 3i. (merged into §3e in rev 4)

### 3j. Preview rows (normative; rev 4)

- **Mutable run state and failures live only in `jobs`** (`tag_preview`).
- **Completed Previews only:** `tag_proposal_preview` has one row per *completed* Preview. Its columns: surrogate `id`; `proposal_id`; `artifact_sha256`; `corpus_fingerprint`; `preview_design_hash`; `job_id`; `body` (jsonb); `body_sha256`; `created_at`.
  - `UNIQUE (proposal_id, artifact_sha256, corpus_fingerprint, preview_design_hash)`. An identical re-run reuses the existing row idempotently (`ON CONFLICT DO NOTHING`, then read the row back).
  - A trigger forbids UPDATE and DELETE (the birds_test owner fixture escape excepted, as elsewhere).
- **Byte cap:** `CHECK (octet_length(body::text) <= 1048576)`, measured on the jsonb text form. The TS builder applies the caps first:
  - 2,000 species per list, in the §3d hash order;
  - 50 overlap-diagnostic lines.

  If the canonical text still exceeds 1 MB, the builder halves the list caps (additions first, then drops) until it fits. True counts and `truncated` flags are always kept.

### 3k. Preview certifies the whole input (rev 5, P1-1)

- **One pure SQL encoder** is factored out of `record_tag_input`: `tag_input_hash(text_hash, order, family, genus, lexicon_hash, focal_exempt_hash, scanner_rev)`. `record_tag_input` (which gains genus, §3a) and Preview both use it. The field list is not duplicated anywhere else.
- **Per species,** Preview computes in TS exactly what the materializer computes: textHash, and focal_exempt_hash from `focalExemptions(row)`. It passes them to SQL in batches, and SQL computes `tag_input_hash(...)` with the live lexicon_hash and scanner_rev. The computed hash must **equal the stored `species_tag_input.input_hash`**; any mismatch refuses the whole Preview as stale.
- Order, family and genus are read in SQL from `taxonomy_cache` in the same snapshot, never from TS.
- **Regressions:** a common-name rename, a family-name rename and a genus change, each between the last consistency run and a Preview. The Preview must refuse.

### 3l. Scope algebra (rev 5, P1-2)

- A support rule's `taxa` holds 1–3 entries with **distinct ranks**. The loader rejects empty `values`, duplicate ranks and duplicate values.
- **Entries AND; values within an entry OR.**
- **Eligibility, known disqualifier first:**
  - if any entry's rank value is known and not listed, the rule is **ineligible**;
  - otherwise, if any entry's rank value is unknown, the rule is **scope-unknown**, which feeds §3a step 5;
  - otherwise it is **eligible**, and its evidence `scopes` are the matched (rank, value) of every entry, sorted as in §3e.
- **Tests:** multi-rank AND; duplicate rank (refused); known-fail with unknown (ineligible wins); all known and passing; unknown-only.

### 3m. Example sentences are exact, and the Preview source is guarded (rev 5, P1-3)

- **Additions:** the example sentence is the result's first evidence item, in the scanner's existing deterministic order (section order, then sentence order, then match offset). For taxon-assigned species, the item is rendered as taxon evidence and no sentence is shown.
- **Drops** (legacy-only): the example is the first sentence, in section and then sentence order over the *scanned* sections (the proposal's denySections applied), that contains any of the design's `cueWords` as a whole word after `foldCase`. If there is none, the example is `null`, rendered as "no sea or ocean wording in the scanned text".
- **Source guard:** the Preview builder lives in one module, `tag-engine/preview.ts`. `PREVIEW_SOURCE_HASH`, the sha256 of that file together with normalize, tokens, segment, rules and scanner (the engine-guard set), is part of the canonical bytes of `preview_design_hash`. A golden test asserts that TS's computed design hash equals the SQL-pinned constant. Any code change to Preview therefore fails CI until a migration re-pins the constant, and re-pinning makes every older Preview non-current.

### 3n. `schema_version` cannot be null (rev 5, P1-4)

- `tag_rule_proposal.schema_version`: `GENERATED ALWAYS AS (CASE WHEN jsonb_typeof(artifact->'schema') = 'number' THEN (artifact->>'schema')::int END) STORED`, plus `NOT NULL CHECK (schema_version IN (1, 2))`. A missing, null, string or out-of-range schema therefore fails the INSERT itself. The existing prod rows are all schema 1, which 0072 checks before adding the constraint.
- `record_tag_crosscheck` and `approve_tag_proposal` independently refuse any schema_version other than 1 or 2. For 2, they require the bound current Preview (§3g).
- **Tests:** artifacts with a missing, null, string, 0 and 3 schema are refused at INSERT.

### 3o. Trusted Preview insert (rev 5, P1-5)

- **birds_app has no INSERT, UPDATE or DELETE** on `tag_proposal_preview`.
- The only writer is `record_tag_preview(p_proposal_id, p_job_id, p_body jsonb)`, a SECURITY DEFINER function. It asserts the **shared** engine lock is held (a new `tag_assert_shared_engine_lock`), then:
  - requires `p_job_id` to be a `running` `tag_preview` job whose payload names this proposal;
  - reads `artifact_sha256` from the proposal row;
  - computes `corpus_fingerprint` and `preview_design_hash` with the SQL functions;
  - computes `body_sha256 = sha256(convert_to(p_body::text, 'UTF8'))`;
  - enforces the §3j byte cap;
  - then upserts on the unique key and returns the row id.
- No hash is ever caller-supplied.
- **Tests:** tampered artifact, fingerprint and body hashes are impossible to supply; a wrong job, a wrong proposal, a finished job and a missing lock are all refused.

### 3p. AI self-check rounds (rev 5, P2-1)

Rounds happen **before** the proposal exists, so they belong to the draft job, not to Preview rows (§3j drops `rounds`).
- **Table `tag_draft_round`:** job_id, round_no, model, ai_usage_call_id, diagnostics jsonb, output jsonb, loader_error. It is immutable, with a definer insert. Caps: diagnostics ≤ 512 KB, output ≤ 256 KB, loader_error ≤ 2,000 chars, and at most 4 rows per job.
- The final proposal records `draft_job_id`, which links it to its rounds.
- **Overlap errors (§3a)** report the true count plus the **first 20 (species_code, rule pair)** in `COLLATE "C"` order, never an unbounded list.

### 3q. Preview transaction options (rev 5, P2-2)

- `withTagWriteTx` gains an options object: `{ isolation: "repeatable read", statementTimeout: "120s", transactionTimeout: "180s" }`. It issues `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` as the **first** statement, before the lock and before any snapshot-taking query. Only the Preview uses these options; the defaults are unchanged.
- **Tests:**
  - a 10,886-species Preview completes inside the limits on birds_test;
  - a concurrent shared-lock input writer committing mid-Preview leaves the stored Preview consistent with its own snapshot, and **immediately non-current**, so it cannot authorise a cross-check.

### 3r. Example sentences from all accepted hits (rev 6, P1-1; replaces the Additions bullet of §3m)

- `evaluateTag` and its evidence stay exactly as they are (schema-1 bytes are unchanged).
- The scanner gains a separate pure export, `collectAcceptedHits(input, ruleset)`. It walks the same pipeline (eligibility, comparison markers, other-taxon discard, excludes, focal subject) but **does not cap**, returning every accepted support hit.
- The Preview example for an addition is the minimum hit by the explicit key **(section index, sentence index, matchStart, ruleId in C order)**. Taxon-assigned additions show their taxon item, with no sentence.
- **Regression:** a rule listed later that matches earlier text must be the chosen example, while `evaluateTag`'s evidence stays byte-identical to today's.

### 3s. Draft calls: checkpointed rounds and a hard call ceiling (rev 6, P1-2; replaces §3c's round count and §3p's row semantics)

- **Every AI call in a `tag_draft_rules` job is a round,** numbered 0–3. That covers the initial draft, a loader or overlap retry, and a self-check revision. The old separate "one loader retry" loop is folded into rounds.
- **Checkpoints:** `tag_draft_round` gets append-only **events**: `(job_id, round_no, event IN ('started','completed','abandoned'), call_token uuid, …)`.
  - A `started` row is committed **before** the provider call.
  - `completed` carries the output, diagnostics and any loader error.
  - `abandoned` records a drain abort or a crash found at resume.
- **Resume after a reclaim or requeue:**
  - Find the highest round with a `completed` event, and continue from its stored output. A completed round is never re-called.
  - A round with `started` but no `completed` or `abandoned` is a crash in flight, and the provider may have billed it. At resume it is first marked `abandoned` and **still counts against the budget**.
  - The next round number is 1 + the highest started round.
- **Ceiling:** at most 4 `started` events per job, enforced in the DB (`round_no` 0–3, UNIQUE(job_id, round_no, event)). The ceiling therefore holds across the job's 2 attempts and any number of drains. When the budget is exhausted without a valid draft, the job fails and says so.
- **Drain between calls** requeues with no new `started` row. **Drain mid-call** writes `abandoned` and then requeues. Both are counted exactly once.
- **Tests:** a crash or reclaim after rounds 0, 1 and 3; a drain between calls; a drain mid-call; and a ceiling of 4 calls in total across a reclaim.

### 3t. A Preview re-run must reproduce the same body (rev 6, P1-3)

On a unique-key conflict, `record_tag_preview` compares the new `body_sha256` with the stored row's.
- **Equal:** return the existing row (idempotent).
- **Different:** RAISE `tag_preview: nondeterministic body for an identical key (integrity)`, and the job fails. The Tags tab surfaces it as an integrity problem.

**Tests:** same key and same body gives the same id; same key and a different body is refused.

### 3u. Draft provenance is DB-bound (rev 6, P2-1)

- **`tag_draft_round`:** `CHECK (round_no BETWEEN 0 AND 3)`, with the uniqueness from §3s. Its SECURITY DEFINER insert verifies a **running `tag_draft_rules` job whose payload tag matches**. A non-null `ai_usage_call_id` must reference `ai_usage` rows with that job_id and purpose `tag_draft`. It may be null only because metering is best-effort, and a null is recorded as such.
- **`tag_rule_proposal.draft_job_id`:**
  - `UNIQUE`;
  - `CHECK ((source = 'ai') = (draft_job_id IS NOT NULL))`;
  - immutable: `tag_rule_proposal_guard` is rewritten so that only `status` may change and `draft_job_id` is in the compared set.
  - Migration 0072 backfills the three existing prod AI proposals from their jobs' `result.proposalId` (jobs 6893, 6899 and 6901) before adding the CHECK.

### 3v. `PREVIEW_SOURCE_HASH` canonicalization (rev 6, P2-2)

- It reuses the engine-guard canonicalization, `semanticSource`: block and line comments and blank lines are removed, and lines are trimmed. It also drops the line declaring the hash constant itself: `export const PREVIEW_SOURCE_HASH` is excluded, as `ENGINE_SOURCE_HASH` is.
- Files are hashed in the fixed order normalize, tokens, segment, rules, scanner, preview, each prefixed by its file name and a newline, as UTF-8.
- **Tests:** a comment-only edit leaves the hash unchanged; a code edit changes it; and the SQL-pinned `tag_preview_design_hash` golden (§3m) still applies.

### 3w. Round-event state machine (rev 7, P1-1; makes §3s normative)

The only writer is `tag_draft_round_event(p_job_id, p_round_no, p_event, p_call_token, p_payload jsonb)`, a SECURITY DEFINER function; birds_app has no direct DML. In one transaction it locks the job row (`SELECT … FROM jobs WHERE id = p_job_id FOR UPDATE`), requires a `running` `tag_draft_rules` job, and then enforces the following.

**`started`:**
- `p_round_no` = 0 when no round exists, otherwise 1 + the highest started round;
- every earlier round already has a terminal event (no open round);
- `p_round_no` ≤ 3;
- a fresh `p_call_token`, unique across the table.

**`completed` or `abandoned`:**
- a `started` event exists for this round with **the same `call_token`**;
- the round has **no terminal event yet**.

**Exactly one terminal event per round,** also enforced by a partial unique index `(job_id, round_no) WHERE event IN ('completed','abandoned')`. So a completion after an abandonment is refused, and so is a second completion.

**What `call_token` is for:** it names one provider call. A worker from an earlier attempt that finishes late presents its token. If the resume already marked that round `abandoned`, its `completed` is refused and the output is discarded; the spend is still on the books via `ai_usage`.

**Tests (direct DB):**
- completed without started;
- a token mismatch;
- completed and then abandoned, and abandoned and then completed;
- a second completion;
- a non-contiguous started, and started while a round is open;
- round 4;
- a wrong job type or a non-running job.

**Race tests:** a late stale completion after a reclaim or a drain has abandoned the round.

### 3x. Proposals created only through definers (rev 7, P1-2)

- 0072 **revokes birds_app's column INSERT** on `tag_rule_proposal`, the grant made in 0066:664. There are two definers.
- **`create_ai_tag_proposal(p_job_id, p_round_no)`** requires:
  - a `running` `tag_draft_rules` job whose payload tag is the proposal tag;
  - that round to have a `completed` event with the loader and overlap result `ok`.

  It then **copies the artifact from that round's stored output in SQL.** The caller never supplies artifact bytes. It inserts the proposal with `source = 'ai'`, `draft_job_id` and `draft_round_no`, and returns the id.
- **`create_human_tag_proposal(p_tag, p_artifact, p_user_id)`** requires an admin user and inserts with `source = 'human'` and null draft fields. The loader is run in TS before the call; the artifact is still validated again at approval.
- The **backfill** of the three existing AI proposals (jobs 6893, 6899, 6901) is a documented migration-only exception. It checks each job's `result.proposalId` and tag and records `draft_round_no = NULL`. `create_ai_tag_proposal` is the only path from 0072 on.
- **Tests:**
  - a wrong or missing job;
  - a wrong job type or tag;
  - a non-completed round and a failed-loader round;
  - an artifact that doesn't match its round, impossible by construction and asserted;
  - a direct INSERT by birds_app, refused;
  - a human proposal by a non-admin, refused.

### 3y. `PREVIEW_SOURCE_HASH` over raw bytes (rev 7, P2; replaces §3v's canonicalization)

- sha256 over the **raw UTF-8 bytes** of normalize, tokens, segment, rules, scanner and preview, in that fixed order, each prefixed by its file name and a newline.
- The **only** exclusion is the single line beginning `export const PREVIEW_SOURCE_HASH` in preview.ts.
- Comment edits therefore change the hash too, and need a re-pin. That is accepted: correctness beats convenience.
- **Tests:** an edit inside a string or regex literal containing `/* … */` changes the hash; editing the excluded line does not; and the SQL-pin golden still applies.

### 3z. Claim fencing: `claim_seq` bound to the execution context (rev 12; replaces every earlier §3z)

**`attempts` is unchanged**: refunds, `retryDelayMs` backoff, failure text and progress rounds all work exactly as today.

**`jobs.claim_seq bigint NOT NULL DEFAULT 0`:** `claimNextJob` increments it in its single UPDATE and returns it. It is never decremented or reused.

**The claim context is immutable and per execution.**
- `runJob(job, ctx)` runs the handler inside `claimContext.run({ jobId: job.id, claimSeq: job.claim_seq }, …)`, where `claimContext` is an `AsyncLocalStorage` in jobs.ts.
- Every async continuation of that handler, including a late one after a requeue and a same-process re-claim, keeps **its own** context. A late continuation of claim A therefore carries A's `claimSeq`, even while claim B is running.
- There is no mutable map, so nothing needs clearing.

**Every fenced predicate includes `status = 'running'`** (rev 13): `transition()`, `updateProgress()`, `terminalizeAndReschedule()` and the definers all use `status = 'running' AND claim_seq = $ctx` (plus `attempts = $` where the API takes it). A claim is therefore dead the moment its job leaves `running`: yielded, requeued, retried, cancelled, succeeded or failed. This holds before any re-claim exists, not only against a later claim B.

**Fenced queue APIs:**
- `transition()`, `updateProgress()` and the transaction inside `terminalizeAndReschedule` read `claimContext.getStore()`.
- When the store's `jobId` equals the target job, each appends `AND claim_seq = $ctx.claimSeq` to its predicate. `terminalizeAndReschedule` gets it on its own `UPDATE … WHERE status = 'running' AND attempts = $ AND claim_seq = $` inside its client transaction.
- With no store, or a store for a different job, the predicate stays today's attempts-only one. This covers tests, scripts, and a handler acting on another job.

**Stale stops the handler at once:**
- `updateProgress`, under a context, matching no row → throws **`StaleClaimError`**.
- A fenced `transition()` that loses under a context also throws `StaleClaimError`. It no longer returns false, so the caller does no follow-up work.
- `runJob` catches `StaleClaimError` once at its boundary, logs `stale claim abandoned`, and returns without further writes.
- **Call-site change, B5 modules only (rev 14):** in the B5 handler modules (tag-draft-job.ts and the new preview job), every `catch` that performs business writes, provider calls or notifications must rethrow `isStaleClaim(err)` first. A source-scan test enumerates **those modules only**, plus per-shape behaviour tests. The existing handlers' catch-all behaviour and pre-side-effect checkpoints (job-handlers.ts 213, 415–425, 671–682 and 861; family-enrichment.ts 343 and 609) are left to **td-b99b6d**. For those handlers, B5 claims only the fenced transition and progress of §3z.

**The round-event and proposal definers** take `p_expected_attempts` and `p_claim_seq`, taken from the context, and require both under the job-row `FOR UPDATE` lock. Otherwise they RAISE `stale claim`, which TS maps to `StaleClaimError`.

**§3bb path:** the proposal definer terminalizes the job in SQL, and the handler returns. There is no registry to clean, and the context ends with the handler.

**Tests:**
- **Overlapping contexts** A and B for the same job id and the same `attempts`, after a drain requeue and re-claim: every A call is refused (transition, progress, `terminalizeAndReschedule`, round event, proposal) while B proceeds.
- The same after a crash reclaim.
- A stale claim at the **first** progress call and **mid-loop** for each handler shape, asserting no later unit, provider or business write.
- Yields and drains do not advance backoff or the failure text.
- The existing suites pass.

**Defense in depth, unchanged:** the worker's lifetime single-worker advisory lock.

### 3cc. B5 jobs have no side effects on a stale claim (rev 13–14; scope)

This covers `tag_draft_rules` and `tag_preview`. Every externally visible effect happens only **after**, or **inside**, a SQL statement that checks `status = 'running' AND attempts = $ AND claim_seq = $` under the job-row lock.
- **Provider call:** a committed, fenced `tag_draft_round_event('started')` is an **irrevocable authorization for exactly one provider call**, plus its `ai_usage` receipt. Once `started` has committed while the claim was current, that one call and its receipt may still happen even if the claim dies before the network dispatch (a TOCTOU no DB fence can close). Everything **downstream** of the call (round output, proposal, job state, events) stays fenced. A stale continuation can never obtain a *new* `started`, so it can never authorize an additional call. The call budget (≤ 4 started per job) already counts such a reserved call.
- **Authoring-set freeze:** `freeze_tag_authoring_set` gains `p_job_id`, `p_expected_attempts` and `p_claim_seq`. It requires a `running` `tag_draft_rules` job with that tag under the job-row lock, fenced like the other definers, before inserting the immutable `tag_authoring_example` rows. A stale claim therefore cannot choose the authoring set. Its call site moves under the claim context.
- **Round output:** `completed` and `abandoned` go through the fenced definer.
- **Proposal and job completion:** the fenced `create_ai_tag_proposal` (§3bb).
- **Preview row:** `record_tag_preview` additionally requires the preview job's `status = 'running' AND attempts = $ AND claim_seq = $` (§3o, extended).
- **Job events for these jobs:** written only by those definers or by a fenced `transition()`. These handlers never call a bare `recordEvent`.
- **Failure, retry and requeue:** the fenced `transition()`.

**Tests:** a stale A resumes **exactly at each boundary**, each run against a pending, a terminal and a re-claimed row:
- before the authoring freeze;
- before `started`;
- between `started` and the provider call;
- before `completed`;
- before the proposal;
- before the preview insert;
- before fail or requeue.

Expected: **no authoring rows, no new `started`, no round output, no proposal, no preview row and no job events from A**. The only allowed effect is, at the between-`started`-and-call boundary, the **one reserved provider call and its `ai_usage` receipt** that the already-committed `started` authorized.

**Existing handlers** (enrichment, frequency, family and so on) get the generic `claim_seq` + `status = 'running'` fence on transitions and progress from §3z. Their pre-side-effect checkpoints and a fenced `recordEvent` are **td-b99b6d**. That gap predates B5, and the worker's lifetime single-worker advisory lock mitigates it: a stale continuation needs a lost lock session while the process keeps running. The source-scan catch test in §3z is therefore limited to the B5 handler modules.

### 3aa. Atomic final-round proposal (rev 8, P1-2)

`create_ai_tag_proposal(p_job_id, p_expected_attempts, p_claim_seq, p_round_no)` locks the job row `FOR UPDATE` and, in the same transaction, requires:
- the fence from §3z;
- that the job has **no proposal yet** (`draft_job_id` is UNIQUE, and it is also checked explicitly);
- that `p_round_no` is the **highest started round** of the job;
- that this round has a `completed` event with loader and overlap `ok`, and **no open or later round** exists.

It then inserts the proposal, copying the artifact from that round.

`tag_draft_round_event` refuses `started` for any job that already has a proposal. So the job's rounds are frozen at proposal creation.

**Tests:** an earlier ok round when a later round exists (refused); the job being cancelled, requeued or finished between check and insert (serialized by the row lock and refused); a start after a proposal exists (refused).

### 3bb. Proposal insertion and job completion are one transaction (rev 10, P1-2)

- `create_ai_tag_proposal` does both steps in the transaction that holds the job-row lock:
  - inserts the proposal;
  - **terminalizes the job**: `status = 'succeeded'`, `result = {tag, designHash, proposalId, rounds: [...]}`, `finished_at = now()`, plus the `completed` job event, under the same `status = 'running' AND attempts = p_expected_attempts AND claim_seq = p_claim_seq` predicate.
- **If `cancel_requested` is set,** it inserts nothing. The job becomes `cancelled` with a `cancelled` event, and the function returns null. This mirrors `transition()`'s cancel-at-linearization rule.
- The TS job simply returns after the call; it does not call `completeJob` for this path.
- **Crash boundaries:** a crash before the commit leaves no proposal and a running job, which the reclaim resumes per §3s. A crash after the commit leaves a finished job, so no reclaim happens.
- **Tests:** the proposal and the completion appear together or not at all (fault injection makes the event insert fail, and neither is left behind); cancel at the boundary; and a reclaim after a completed proposal has nothing to reclaim.

**§3y precision:** the exclusion matches lines in preview.ts equal to `^export const PREVIEW_SOURCE_HASH = '[0-9a-f]{64}';$` after stripping one trailing `\r`. **Exactly one** such line must exist, or the hash function throws. That full line **and its line terminator** are removed before hashing.

## 4. The label claim with taxon rules (OWNER DECISION)

Today's B4 claim is: *does the article say this bird feeds or rests at sea away from shore?*, with the species' names masked. As CODEX1 notes, an article saying only "a shearwater in the family Procellariidae" establishes taxonomy, not habit. Deciding "yes" from it would import outside knowledge. Masking today already leaves "Procellariidae" visible, while hiding "shearwater" and the genus and epithet.

- **(a) Keep the claim: article only.** Taxon-assigned species whose article says nothing about sea habits will get Unsure or No, which counts against precision. Taxon rules then pass only as far as articles are explicit. The measured Draft-2 misses suggest many petrel articles are not.
- **(b) Redefine the claim with an independent, fixed reference.** The labelling page also shows the lead of the **family's Wikipedia article**. It is fetched once per family (about 250), stored with its revision id, and never AI-written; the app's own family descriptions are AI-written, so they don't qualify. The question becomes: *from this species article and its family's article, does this bird feed or rest at sea away from shore?* The evaluator is not taught the rule. The reference is Wikipedia's own family text, pinned by revision and hashed into the evaluator design, so it cannot drift silently.

**Owner decision (2026-09-30): (b).** CC recommended it. It measures what a reader of the app can learn from the sources, and it is independent of the rule lists. With (a), taxon rules are unlikely to pass however correct they are.

**Binding the reference actually shown (normative; rev 4; applies because (b) was chosen):**
- **`reference_sha`** = sha256 of `"tagref-v1|" ‖ len:family_code| ‖ len:wiki_title| ‖ rev_id "|" ‖ len:lead|lead`. Lengths are in UTF-8 bytes, and the lead is taken exactly as stored.
- **The reference is snapshotted.** `tag_eval_item` gains an immutable display payload that snapshots the reference: family_code, title, rev_id and lead. The label page renders from that snapshot only, never from the live `tag_family_reference` row. `eval_text_hash` covers the species text and the snapshotted reference.
- **The frame covers the reference.** The frame's canonical bytes gain `len:family_code|len:reference_sha|` per row, with the prefix `tagframe-v2`. One SQL encoder is used by `create_tag_eval_set` and by the activation switch. A family-code-only remap, or a title-only or revision-only reference change, therefore changes the frame, and activation **refuses on drift**.
- **Hard stop:** a missing, ambiguous or failed reference for any frame species makes the design **infeasible**. It never falls back to article-only.
- **Regressions:** a family-code-only remap; a title-only and a revision-only reference change; a missing and an ambiguous reference; and a label page that renders the snapshot after the live reference changes.

**Label identity (either choice):** `eval_text_hash` gains a per-tag **evaluator design hash**. That hash covers:
- the question;
- the masking version;
- the reference source and revision ids (for option b);
- the deny list and cues.

So any future change to the question or reference makes old labels non-reusable, automatically, not by a manual version bump. `EVAL_TEXT_VERSION` and the pinned open-ocean design hash are re-pinned. **No B4 labels exist yet**, so nothing is invalidated.

## 5. Not recommended here, listed for completeness: AI re-tag of Haiku species

Re-running tags-only for the 8,806 Haiku species on Sonnet 5 would cost about $105 (about $0.012 each). It **reverses the governing principle** ("AI is never used to generate, drop or change a tag"), and it has no blind test behind it. It is out of scope unless the owner reopens that principle. CODEX1 concurs.

## 6. "Am I asking too much?"

No. The drafts missed both claims by a wide margin, for the structural reason in §1. With taxon assign, the Draft-2 simulation keeps 244 of 348 legacy positives, and the remaining drops are mostly legacy errors (Haiku). Keep the gates. Revisit only if a B5 revision fails narrowly, with numbers in hand.

## 7. Work, review, order

1. **Migration 0072:**
   - genus in the tag input record and hash;
   - `jobs.claim_seq bigint NOT NULL DEFAULT 0`, incremented by `claimNextJob`. The TS-side `claimContext` (AsyncLocalStorage), the fenced `transition()`, `updateProgress()` and `terminalizeAndReschedule()`, `StaleClaimError`, and the handler catch rethrows are listed here so they are not missed (§3z);
   - `tag_input_hash` factored out of `record_tag_input` (§3k); `record_tag_input` gains genus;
   - `tag_rule_proposal.schema_version`, generated, NOT NULL, CHECK IN (1, 2) (§3n);
   - `tag_proposal_preview`, with a surrogate id, the UNIQUE 4-key constraint, the immutability trigger and the byte-cap CHECK; `record_tag_preview` (body-hash conflict check, §3t); `tag_assert_shared_engine_lock`; `tag_corpus_fingerprint()`; `tag_preview_design_hash(tag)` pinned (§3d, §3o, §3j);
   - `tag_draft_round` events: `round_no` CHECK 0–3; UNIQUE(job_id, round_no, event); the terminal partial unique index `(job_id, round_no) WHERE event IN ('completed','abandoned')`; UNIQUE(call_token); no birds_app DML; the definer `tag_draft_round_event(job, expected_attempts, claim_seq, round, event, call_token, payload)` with the §3w state machine and §3z fence, refusing `started` once a proposal exists (§3aa);
   - `tag_rule_proposal.draft_job_id` (UNIQUE) and `draft_round_no`. CHECK `(source = 'ai') = (draft_job_id IS NOT NULL)`; `draft_round_no` NOT NULL for AI proposals except the three backfilled rows. Both are immutable through the rewritten `tag_rule_proposal_guard`. The backfill of jobs 6893, 6899 and 6901 comes before the CHECK (§3u, §3x);
   - REVOKE birds_app's column INSERT on `tag_rule_proposal`. Add the definers `create_ai_tag_proposal(job, expected_attempts, claim_seq, round)` (it also terminalizes the job, §3bb) (§3aa) and `create_human_tag_proposal(tag, artifact, user)` (§3x), with EXECUTE granted to birds_app;
   - `freeze_tag_authoring_set` re-signed with the job, attempts and claim_seq fence (§3cc);
   - `tag_crosscheck.preview_id`, its schema-2 trigger, and the record/approve functions rebound (§3g);
   - the frame bytes bumped to v2, with the family reference (§4);
   - the `tag_preview` job type;
   - the evidence-union check;
   - integrity class `taxon_overlap`;
   - (option b) a `tag_family_reference` table (family_code, wiki title, rev_id, lead text, fetched_at).
2. **Engine:**
   - the `genusOf` parser;
   - the TaxonInput genus;
   - the schema 1/2 union;
   - the truth table;
   - scoped support;
   - the evidence union;
   - the scanner_rev bump;
   - overlap enumeration.
   Plus the tests from §3a, §3b and §3f.
3. **Preview job**, the card with a stale marker, the approve gate, and `tag-crosscheck show`.
4. **Draft self-check loop** with the sanitized channel and per-round records; the prompt updated for schema 2.
5. **Evaluator** per §4: the design hash inside eval_text_hash; (b) a one-time family-lead fetch job and the labelling page layout.
6. **Help:** the Tags section (taxon rules, Preview, the label question).
7. **Review and deploy:** CODEX1 high review of this rev, then of the code; an AGY3 or GROK UI check (GROK returns Oct 1 14:00 ET); deploy on the owner's go.
8. **Pilot again:** CC writes the taxon lists as a `human` proposal. Preview, then cross-check, then approve, then the blind test. The AI draft remains available for the phrase part.

## 8. Owner decisions needed

1. ~~§4~~ **Decided 2026-09-30: (b)**, article plus the family's Wikipedia lead.
2. **Build B5** as specified in rev 14 (CODEX1 passed it)? CC recommends yes.
3. **Taxon lists written by CC** as a `human` proposal that goes through the cross-check (recommended), or drafted by AI.

## 9. Phase 1 implementation notes (2026-09-30, CC)

**Phase 1 builds:**
- schema-2 rules (assign, genus, scoped support);
- the truth table;
- the evidence union;
- the taxonomy check;
- Preview, required for schema-2 cross-check and approval;
- the claim fencing (§3z);
- family references and frame v2 (§4 option b);
- Help.

**Phase 2 (the AI self-check loop) is not built:** §3c, §3p, §3s, §3w, the draft-job half of §3cc, §3x's `create_ai_tag_proposal`, and the `freeze_tag_authoring_set` fence. Until then, the existing AI draft job keeps its B4 behaviour and birds_app keeps its column INSERT on `tag_rule_proposal`. The revoke lands with `create_ai_tag_proposal` in Phase 2.

**Deliberate deviations, for review:**

1. **Preview is two phases, not one shared-lock REPEATABLE READ transaction (§3d/§3q).**
   - **Why:** `record_tag_preview` must lock the job row under the claim fence. The worker's own heartbeat and a cancel click update that row during a multi-second scan, so a snapshot-then-`FOR UPDATE` would fail with a serialization conflict.
   - **Scan:** now a READ ONLY REPEATABLE READ snapshot, with every member's input certified by the SQL encoder, and the fingerprint read in the same snapshot.
   - **Store:** a short shared-lock `withTagWriteTx` in which `record_tag_preview` requires the live fingerprint to equal the scanned one, so a moved corpus stores nothing.
   - **Guarantee:** the same as the plan's. A stored row always describes the corpus it names, and a concurrent writer leaves nothing or a row that is immediately non-current.
   - `withTagWriteTx` therefore gained no isolation option, only a `TagTxRefusal` (an expected refusal that is not recorded as a materialization failure).
2. **Preview scans in batches of 300 inside that one snapshot.** About 37 MB of stored article text on prod would put the worker near its 300 MB PM2 restart limit. Pass 1 keeps a small summary per species; pass 2 re-reads only the ≤ 60 example articles.
3. **`preview_design_hash` is a DB table,** `tag_preview_design(tag, design_hash)`, pinned by migration. It is not a SQL function constant (the §3h/§3o registry option). A guard test checks both `PREVIEW_SOURCE_HASH` against the raw source bytes and the pinned row against the TS computation.
4. **The engine upgrade path.** A deploy that changes `scanner_rev` (this one does) makes the consistency pass open a repair generation, recorded as `details.scannerUpgrade`, not as "fixes". Worker startup runs that pass at once when the stored `scanner_rev` differs. Preview refuses until the inputs converge.
5. **Genus is not a separate drift class in `tag_repair_workset`.** A `sci_name` change reaches the input through replaceTaxonomy's changed-row re-materialization, and through the lexicon (genera are lexicon names).

**Evidence:**
- **Schema-1 byte identity:** three schema-1 rule sets over all 10,886 birds_test articles, before and after the scanner change, give 32,658 results with 0 differences (scannerRev excluded).
- **The hand-written open-ocean proposal** (`docs/tag-rules/habitat-open-ocean.v2.json`), dry-run on birds_test:
  - 246 species assigned (240 by family or genus lists, 6 by wording);
  - 240 of 348 legacy positives kept;
  - 6 new ones, all plausible;
  - American Kestrel, Osprey and Egyptian Goose not assigned.

**CODEX1 code review (2026-09-30, 2 P1 + 3 P2), fixed in 0073 plus TS:**
- **P1-1:** approval runs the loader, the taxonomy check and the definer in ONE exclusive-lock transaction (`approveProposal` via `withTagWriteTx`). The definer additionally requires the bound current Preview's recorded taxonomy check to be clean, so a direct definer call is refused too.
- **P1-2:** the newest cross-check of the exact artifact decides; a later "changes" or "reject" revokes an earlier "approve".
- **P2-1:** a claim-fenced `recordClaimedEvent` is used by the Preview, family-refs, draft and eval jobs, so a stale claim leaves no event.
- **P2-2:** `record_tag_family_reference_for_job` is fenced to the running claim and the requester's admin role, and the unfenced writer is owner-only. The job also re-checks the admin role.
- **P2-3:** `PREVIEW_SOURCE_HASH` covers taxon-check.ts; open ocean is re-pinned in 0073.
