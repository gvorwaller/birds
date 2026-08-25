# Similar species links on field guide pages — plan (td-8f0ed8)

**Date:** 2026-08-25
**Status:** IMPLEMENTED + CODE-REVIEWED 2026-08-25 — ready for owner sign-off and commit
**td:** `td-8f0ed8` — Show similar species links on field guide pages
**Reviews:** internal Plan-agent critique, AGY (UI/UX) and CODEX1 (plan baseline) folded in and
closed 2026-08-25. CODEX1 then ran a code review + fix loop on the implementation: round 1 found
1 P1 + 1 P2 and fixed both, round 2 re-review of the fixed tree found nothing further. Loop closed
at round 2 of an authorised maximum of 3.

**Code-review findings (both fixed):**
- **P1 — the aiOnly worker path re-applied only the legacy `ai_status`/revision predicates**, so a
  row enqueued *solely* because its similar-notes were due was silently skipped. That would have
  broken the whole point of the substage clock: the backfill across the ~1,123 already-annotated
  species, and taxonomy-only refreshes. The substage had been added to the inline `aiDue` gate at
  the fresh-skip call site and not carried to the aiOnly path. Fixed by treating payload membership
  as the durable due decision and always entering `runAiStage`, whose candidate hash remains the
  authoritative no-op check.
- **P2 — `SimilarSpeciesCard` omitted the AI caveat.** Added as a card footer, gated on at least one
  note actually being present — an unconditional caveat would wrongly imply the eBird
  reporting-group claim is AI-generated when it comes from Cornell.

CODEX1 verdict: **ACCEPT WITH CORRECTIONS**. Derived slash edges and ordered directional notes are
sound; the AI clock/persistence and the link/query contracts needed fixing. All six findings verified
against source and folded in — independent due signal + one-time backfill for the note substage
(Step 3), atomic `withTransaction` persistence (Step 3), three query-correctness bugs incl. a
case-sensitivity defect that would have returned zero rows (Step 2), the `speciesLinkHref` contract
and the missing `locationContext` in the loader (Step 5), migration grants/provenance/CHECK
(Step 4), and a narrowed hallucination claim (Approach). CODEX1 adjudicated compute-at-load as the
right baseline with no memoization until measured, and confirmed the ordered-pair PK, the no-FK
choice, and the no-new-job-type choice. CODEX1 then re-checked the folded plan directly and
confirmed all six corrections were applied accurately — no remaining blocker.

**P2 #6 resolved by owner (2026-08-25):** genus candidates move to a separately labelled
**"Related species"** section rather than being cut or left under "Similar species". CODEX1 had
offered this as its own alternative and confirmed it the strongest compromise. Folded into Approach,
Step 2 and Step 5.

**Status: BUILT.** Implemented 2026-08-25 across the files listed in each step.
`npm run check` 0 errors, `npm run build` passes, `npm test` 796 passed / 1 skipped with a
single PRE-EXISTING failure (`species-enrichment.test.ts` "scope excludes attempted rows" —
confirmed failing on a clean tree via `git stash`, unrelated to this work).

Verified end-to-end against the running app on the test cluster: `/species/dowwoo` renders
"Similar & related species" with Hairy + Ladder-backed Woodpecker under *Similar species* and
Nuttall's under *Related species*; `/species/coohaw` shows Sharp-shinned Hawk; `/species/norcar`
and `/species/amerob` render the single-tier heading with Pyrrhuloxia and Varied Thrush
respectively. Cross-tier dedupe confirmed live: Ladder-backed Woodpecker is both a slash partner
and a *Dryobates* congener and appears exactly once.

AGY verdict: proceed. All nine UI/UX findings accepted — card-with-heading over a lighter inline
treatment, silent zero state, fixed-width media slot, basis-line-as-completion, plain-text basis,
credit inside the media column, no `returnTo` chaining, placement confirmed, no collision with
`td-f55efe`. Folded into Step 5, with two corrections: credit font size 0.72rem (not 0.68rem, to
match `SpeciesMediaCard.svelte:223`) and tier-2 basis wording kept free of any "regional" claim,
since regional ranking was cut.

No product code has been written. Every number in the Feasibility section was
measured against the live test cluster (`127.0.0.1:15436` / `birds_test`) or the
2026-08-24 prod snapshot (`data/backup/prod/birds.pgdump`) — none are estimates.

---


## Context

The field guide (`/species/[code]`) answers "what is this bird and where do I find it" but never
answers the question a birder actually has in the field: *"is this the other one?"* Today `family`
is inert display text, there is no taxonomic navigation anywhere in the app, and the only route from
one species page to a related one is an outbound link to eBird or All About Birds.

This adds a **Similar species** card to the species detail page: the species most likely to be
confused with the one you are looking at, each with a Commons thumbnail, a Seen/Need badge, a
one-line "how to tell them apart" note, and a link to its own field guide page.

Feasibility was researched first. Every number below was measured against the live test cluster
(`127.0.0.1:15436` / `birds_test`) or the 2026-08-24 prod snapshot
(`data/backup/prod/birds.pgdump`) — none are estimates.

---

## Feasibility findings

**Verdict: feasible, with no new external data source and no new API dependency.**

### 1. eBird slash taxa are a curated confusion list already in our DB

`taxonomy_cache` holds 1,035 rows with `category='slash'`. A slash taxon exists *precisely because*
birders routinely cannot separate its members in the field — this is Cornell's own judgement, free,
offline, and already synced quarterly.

Expanding `sci_name` on `/` resolves **2,109 of 2,116 member slots (99.7%)** to real species codes.

**The expansion rule is subtle and is the single easiest thing to get wrong.** Each `/`-part is
either a full binomial or a bare epithet; a bare epithet inherits the genus of the **nearest
preceding part that carried one** — not the first part.

```
Porzana porzana/Zapornia parva/pusilla
  → Porzana porzana, Zapornia parva, Zapornia pusilla   ✓ (baicra1, exists)
  → …, Porzana pusilla                                  ✗ (does not exist)
```

42 slash taxa have 3+ members, up to 5 (`Larus smithsonianus/vegae/mongolicus/argentatus/fuscus`).
Cross-genus 2-part rows exist too (`Accipiter striatus/Astur cooperii`).

Spot-checked, tier 1 returns exactly what a printed field guide lists — no tuning, no AI:

| Focal | Candidates |
|---|---|
| Downy Woodpecker | Hairy Woodpecker, Ladder-backed Woodpecker |
| Cooper's Hawk | Sharp-shinned Hawk, American Goshawk |
| Willow Flycatcher | Alder Flycatcher |
| Semipalmated Sandpiper | Western Sandpiper |
| Greater Yellowlegs | Lesser Yellowlegs |

### 2. But the fan-out is tiny — this is the finding that shapes the design

| Similar species per focal | Species |
|---|---|
| 1 | **1,382** |
| 2 | 281 |
| 3 | 48 |
| 4–7 | 13 |

**The median payload of this feature is one link.** Two consequences:

- **Ranking is a no-op.** You cannot rank a list of one. (This overturns the "rank by region" answer
  given earlier — see *Decisions overturned by evidence* below.)
- **The AI note is not a nice-to-have, it is the feature.** One bare link is thin; one link that says
  *"Hairy is larger, with a bill roughly as long as the head is wide"* is a field guide. This is why
  the note ships in the first release rather than a later phase.

### 3. Coverage, and the honest floor

Of 1,168 in-scope species: **501 (43%) have a slash edge.** Adding a *tightly gated* genus tier
(only when the species has 1–3 in-scope genus-mates) lifts that to **728 (62%)**. The remaining
220 in-scope species sit in genera too large to be meaningful (`Setophaga` × 25) and render
**nothing** — an absent card is honest; a card headed "Similar species" listing 25 warblers is not.

### 4. Thumbnails are viable — 64%, not 0%

`species_media` is **empty in `birds_test`**, so this card cannot be seen locally at all. That is a
local-fixture gap, not a coverage fact. In the prod snapshot: 1,184 species carry a Commons photo,
all with a non-null 640px `thumbnail_url`, and **374 of the 586 distinct edge targets (64%) have
one**. The 36% without need a text-only fallback row. Note that ~31% of edge targets fall outside
`SCOPE_SQL`, so `mediaDueCodes` will never fetch them a photo — that gap is permanent, not pending.

### 5. Wikipedia is grounding, not a source

Sampling 8 ABA species live against the MediaWiki API, only 2/8 had a "Similar species" /
"Confusion species" / "Identification" heading. `SECTION_KEYWORDS`
(`src/lib/server/wikipedia.ts:17-30`) drops all three keywords, and 0 stored rows have one.

But `'description'` **is** already whitelisted and stored — the gap is downstream: `proseBlock()` in
`src/lib/server/ai-enrichment.ts:57` filters on
`/habitat|distribution|behavio|ecology|feeding|diet|breeding|migration/i`, which **excludes the
Description section** — the one most relevant to visual similarity. That is a one-line prompt fix
requiring no re-fetch.

### 6. The AI stage is a solved pattern here

`ai-enrichment.ts` already calls the Messages API directly (`claude-sonnet-4-6`), validates output
against a closed vocabulary via `validateTags`, and carries `EnrichmentAiError` with 429 /
`retry-after` handling. 1,123 species already have AI `field_craft`.

---

## Decisions overturned by evidence

Three earlier calls changed once the data was in. Flagging them explicitly rather than quietly
dropping them:

- **Regional ranking: dropped.** With a median of one candidate there is nothing to order. It also
  could not be built as imagined — `frequency_fetch` has no coordinates, and the species page holds
  lat/lon, not a region code. (`seen_species.region_code` *is* 100% populated and would have been a
  workable input, but it does not rescue a list of one.) Candidates are ordered by their position
  within the slash `sci_name` — the order eBird itself prints them in, free and stable.
- **Thumbnails: kept.** The design review recommended dropping them on a reading of 0% coverage;
  that was a `birds_test` artifact. Real coverage is 64%, so they stay, with a text fallback row.
- **Family tier: cut entirely.** Mean 31 family-mates in scope, max 90. That is a family index, and
  a misleading one.

---

## Approach

**Edges are derived; only the AI note is stored.**

This is the key structural decision. A slash edge is a pure function of `taxonomy_cache.sci_name`,
recomputable in milliseconds, with no upstream provenance. Materialising it would create a derived
cache with no invalidation path: `syncTaxonomy()` does `DELETE FROM taxonomy_cache` + reinsert
(`src/lib/server/ebird.ts:402`), nothing can FK to it (the same reason `species_enrichment` has no
FK — `0020_species_enrichment.sql:17`), and the first taxonomy revision that splits a slash leaves
stale codes being rendered. Recomputing at load makes that class of bug impossible.

The **note** is different: it carries model, source revision, and generated-at, and is genuinely not
recomputable. It gets a table.

**Two tiers, two headings — they make different claims and must not look equally authoritative**
(owner decision 2026-08-25, resolving CODEX1 P2 #6):

| Heading | Source | Claim being made | Basis line | Cost |
|---|---|---|---|---|
| **Similar species** | eBird slash taxa, N-part expanded | *Cornell says these are confusable* — sourced | `eBird reporting group: Downy/Hairy Woodpecker` | free, offline |
| **Related species** | Same genus, **only when 1–3 in-scope mates** | *taxonomically close* — ours, and explicitly not a confusion claim | `Same genus — not necessarily a look-alike` | free, offline |
| — | AI writes one hedged distinguishing note per ordered pair, for candidates in **either** tier | — | rendered as the row's body text | ~1 Sonnet call/species |

Both reviewers independently objected to genus rows sitting under a "Similar species" heading —
CODEX1's framing being that a 43%→62% lift "measures recall, not confusion precision", and that the
small-genus gate limits cardinality, not precision. Correct, and conceded. Splitting the headings
keeps the 227 extra species without ever asserting they are confusable. CODEX1 confirmed this as the
strongest compromise.

The two sections are **independent** — genus is no longer conditional on the slash tier being empty.
A species can show both (Downy Woodpecker: Hairy under *Similar*, Nuttall's under *Related*), one, or
neither. Dedupe across sections: a candidate already shown under *Similar* never repeats under
*Related*.

**Closed-set validation bounds *which species* can appear, not *what is said about them*.** The model
is handed a closed list of species codes and returns a subset; any code outside the set is dropped,
the exact `validateTags` pattern. That makes an invented *species* impossible. It does **not** make
an invented *field mark* impossible — the note is free text, and `SYSTEM`
(`src/lib/server/ai-enrichment.ts:44-49`) explicitly permits "well-established natural history"
beyond the supplied article. So the note carries the same "AI-generated … verify in the field"
caveat already used beside field craft (`+page.svelte:286-295`), and closed-set identity is tested
separately from note content.

---

## Implementation

Per repo convention (NOAA tides, species enrichment, sample media each got one), write
`docs/2026-08-25-similar-species-plan.md` from this document first and cite `td-8f0ed8` in it.

### Step 0 — free wins, independent of everything else

Add `description` to the `wanted` regex in `ai-enrichment.ts:57`. The section is already stored; the
prompt just discards it. No migration, no re-fetch, immediate improvement to every future annotation.

### Step 1 — pure expansion

**NEW `src/lib/similar-species.ts`** (in `$lib`, not `$server`, so it unit-tests with zero DB):

```ts
export function expandSlashSciNames(sciName: string): string[]
```

Split on `/`; a part containing a space is used verbatim and becomes the current genus; a bare
epithet takes the current genus. Return `[]` when there is no `/` or the first part carries no genus.

### Step 2 — candidate resolution

**`src/lib/server/species-enrichment.ts`**, beside `getSpeciesMedia` (~line 830):

```ts
export interface SimilarSpecies {
  species_code: string; com_name: string; sci_name: string;
  basis: 'ebird_slash' | 'genus';
  slash_com_name: string | null;   // e.g. "Greater/Lesser Scaup"
  note: string | null;             // AI distinguishing sentence
  photo: { thumbnail_url, source_url, creator, license_code, license_url, width, height } | null;
  seen: boolean;
}
export async function getSimilarSpecies(code, sciName, userId): Promise<SimilarSpecies[]>
```

Tier 1 (*Similar species*): select the 1,035 `category='slash'` rows, expand each, keep those
containing this species, collect the other members. Tier 2 (*Related species*): same genus via
`split_part(sci_name,' ',1)`, included **whenever** the in-scope genus-mate count is 1–3 —
independent of tier 1, minus anything tier 1 already returned. Then one resolution query, left-joining
`seen_species`, `species_similar` for the note, and `species_media` (kind `'photo'`, rank 1) for the
thumbnail.

**Three correctness requirements on that resolution query (CODEX1 P1 #3 — all verified):**

1. **Lowercase both sides.** `expandSlashSciNames` preserves case, so
   `lower(tc.sci_name) = ANY($1)` matches *nothing* for `"Aythya marila"`. Pass
   `names.map(n => n.toLowerCase())`, or lower an unnested RHS.
2. **Filter `tc.category = 'species'`.** `taxonomy_sci_idx` is not unique and `taxonomy_cache` holds
   issf/hybrid/slash/spuh rows whose `sci_name` can collide
   (`backend/db/migrations/0001_schema.sql:44-53`).
3. **Ordering needs a stable cross-group tie-break.** Slash ordinal orders members *within one slash
   row*; a species can sit in several. Cooper's Hawk appears in both
   `Accipiter striatus/Astur cooperii` (`y00666`-adjacent) and `Astur cooperii/atricapillus`, and the
   `SELECT … WHERE category='slash'` has no `ORDER BY` at all — so cross-group order is currently
   nondeterministic. Sort by (slash taxon `species_code`, member ordinal), carry the ordinals through
   resolution, then **dedupe by target code keeping the first**.

**Unresolved names are dropped silently** — never rendered as a bare code or a synthesised name
(cs.md forbids placeholder data). Self-reference is excluded by construction. DB-only: the loader
makes no network calls on GET, matching the existing invariant.

Add a functional index on `split_part(sci_name,' ',1)` for the genus tier, in the migration below.

### Step 3 — the note, folded into the existing AI stage

**Do not mint an `enrich_species_similar` job type.** The note runs under the same evidence gate
(Wikipedia prose must exist), from the same input (`aiStageInputFor`), against the same staleness key
(`ai_source_rev_id IS DISTINCT FROM wikipedia_rev_id`, `species-enrichment.ts:355`), hitting the same
Anthropic endpoint and rate limit. Splitting it would create **a second clock over the same source
revision that can disagree with the first** — `field_craft` at rev N and notes at rev N−1, both
rendered under one "AI-generated from the Wikipedia article" attribution. That is a correctness bug
the split creates, not one it solves. (`enrich_species_media` earns its own type because it hits
different upstreams with a different retry cadence; that reasoning does not transfer.)

Extend `ai-enrichment.ts`:
- `buildUserPrompt` gains a `candidates: {code, comName, sciName}[]` block.
- Response schema gains `"similar": [{"code","note"}]`, ≤5 entries, note ≤200 chars.
- `parseAnnotation` gains closed-set validation mirroring `validateTags`, with a `droppedSimilar`
  counter for vocabulary misses (the `droppedTags` precedent).
- **`similar` must be optional.** Missing or unparseable → `[]`, never a throw. `tags` and
  `field_craft` stay hard requirements; otherwise one bad similar-list nukes field craft for that
  species for 7 days.
- Bump `max_tokens` from 800 — 5 notes will not fit otherwise.

#### The substage needs its own due signal (CODEX1 P1 #1 — corrected)

Making the output optional is necessary but **not sufficient**, and my earlier framing of it as the
whole mitigation was wrong. Verified against source:

- `aiDueCodes` selects only `ai_status IS NULL`, `ai_status='error'` past the retry window, or
  `ai_source_rev_id IS DISTINCT FROM wikipedia_rev_id` (`species-enrichment.ts:345-361`); the worker
  repeats that gate (`job-handlers.ts:1392-1403, 1460-1484`). **The 1,123 already-current rows will
  never re-run merely because the response schema grew a field.**
- Worse, on a later combined call an absent or bad `similar` still lets `upsertAiData` stamp
  `ai_status='ok'` at the current rev (`species-enrichment.ts:234-258`) — so the note is
  **permanently suppressed** until the Wikipedia revision happens to change.
- And candidate edges can change without any Wikipedia change at all: a taxonomy re-sync that splits
  or merges a slash alters the candidate set while `wikipedia_rev_id` sits still.

So: same Anthropic call, same `enrich_species` job type — but the note substage gets **its own due
signal**, keyed on a candidate-set hash (or taxonomy generation) *plus* its own status / attempted-at
/ source-rev columns, retried independently of `field_craft`. Plus a **one-time backfill** for the
1,123 rows that the rev-based clock cannot reach.

Note this does not resurrect the "second clock" problem I used to argue against a separate job type.
That argument was about two *jobs* diverging over one source revision under one attribution line.
Here both outputs are produced by one call in one transaction; the extra signal only governs
**when to retry**, and it is required precisely *because* the output is optional — hiding the
divergence does not remove it.

#### Persistence must be one atomic replacement (CODEX1 P1 #2)

`upsertAiData` is a single statement today (`species-enrichment.ts:234-258`). Adding loose note
writes beside it would let a note-write failure land *after* the substage was already marked fresh.
cs.md requires `withTransaction` for multi-statement mutations, and the helper exists at
`src/lib/db.ts:88-112`. For one focal species, in **one** transaction: delete its current note rows,
insert the new ones, and update the AI clock columns.

Define bad-optional-output semantics explicitly — do not leave it implicit:
- either **preserve last-good notes** with their own visible provenance and keep the substage due,
- or **clear them** and record a completed-empty result;
- **never** mix rev-N `field_craft` attribution with rev-N−1 notes under one "AI-generated from the
  Wikipedia article" line.

Also delete notes for candidates no longer returned or no longer current.

**Notes are directional and must never be mirrored.** A note on Greater Scaup's page is generated
from *Greater Scaup's* article at *Greater Scaup's* rev id; Lesser Scaup's note comes from a
different article at a different rev, possibly months apart. They will not be converses. Key on the
**ordered** pair, generate only from `species_code`'s own prose, stamp with `species_code`'s
`ai_source_rev_id`, and never render A's note on B's page. Expect ~37% of rows to have a bare link
with no note; the UI must not imply that is an error.

### Step 4 — migration

`backend/db/migrations/0031_species_similar_notes.sql`, following `0028_species_media.sql` (comment
header citing the plan doc + `td-8f0ed8`, DDL, explicit `GRANT`s to `birds_app`):

```sql
CREATE TABLE species_similar (
  species_code     TEXT NOT NULL,    -- focal (the page being viewed)
  similar_code     TEXT NOT NULL,    -- the candidate the note is about
  note             TEXT NOT NULL,
  ai_model         TEXT NOT NULL,
  ai_source_rev_id BIGINT,
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (species_code, similar_code),
  CHECK (species_code <> similar_code)
);
CREATE INDEX taxonomy_genus_idx ON taxonomy_cache ((split_part(sci_name,' ',1)));

GRANT SELECT, INSERT, UPDATE, DELETE ON species_similar TO birds_app;
```

Three corrections from CODEX1 P2 #7, all verified:
- **`generated_at`, not `created_at`.** An upsert at a later source rev must expose when the *current*
  note was generated, not when the row was first inserted.
- **Grants must be explicit and complete.** The runtime role defaults to `birds_app`
  (`src/lib/db.ts:8-16`) and the atomic delete-then-insert needs `DELETE` and `INSERT`, not just
  `SELECT`. "GRANTs to `birds_app`" was too vague to implement from.
- **`CHECK (species_code <> similar_code)`** — self-reference is excluded by construction today, but
  the constraint costs nothing and makes that guarantee schema-level.

**Notes stay out of `search_tsv`.** The existing search discipline is enrichment-owned *focal* prose
(`species-enrichment.ts:2-8`, `0020_species_enrichment.sql:58-60`); indexing comparison text would
make a search for one species match another species' page. Revisit only if product explicitly asks.

No FK to `taxonomy_cache` (DELETE+reinsert on sync). No `jobs_type_check` ALTER — no new job type.
Notes for a `similar_code` that later retires are simply never joined; the read path inner-joins
`taxonomy_cache`, so a retired code disappears rather than 500s.

### Step 5 — UI

**NEW `src/lib/components/SimilarSpeciesCard.svelte`**, modelled on `SpeciesMediaCard.svelte`
including its `<script lang="ts" module>` block that re-declares the row interface locally (the
established pattern for not importing a `$server` module into client code).

Rendered in `src/routes/species/[code]/+page.svelte` between the `SpeciesMediaCard` block (ends
line 230) and `{#if hasFieldCraft}` (line 232) — it is an identification aid and belongs beside the
reference photo, above "Finding this bird". Guard on `data.similar.length > 0`, the way `hasMedia`
(`+page.svelte:104`) guards the media card.

**Row layout (AGY review, accepted).** Mirror the `.obs` pattern in `docs/mockups/mockup.css:194-206`
— stacked rows separated by `border-top: 1px solid var(--border)`, `:first-of-type` borderless,
`display: flex; align-items: flex-start; gap: 12px; padding: 12px 0`. That reads as deliberate at one
row and at four, which is what the fan-out data demands.

Two columns per row:

- **Media column — fixed 84px square (96px ≥640px), never collapsing.** This is the answer to the
  36%-no-photo problem: a fixed slot with a neutral dashed placeholder when there is no Commons
  photo keeps every row aligned instead of ragged. `object-fit: cover` on the thumb;
  `loading="lazy" decoding="async"`; wrapped in `<a target="_blank" rel="noopener">` to `source_url`.
  A fixed square supersedes the `aspect-ratio`-from-`width`/`height` CLS trick — the box reserves its
  own space, so there is nothing to shift.
  Credit sits **under the thumbnail inside the media column**: `creator · source ↗ · license`, at
  `font-size: 0.72rem` with `overflow-wrap: anywhere`, matching `SpeciesMediaCard.svelte:222-230`
  exactly (AGY's draft said 0.68rem — use 0.72rem for consistency with the existing card).
- **Info column** (`flex: 1; min-width: 0`): common name + `<em>` sci name as one link, `<Badge>`
  Seen/Need, then the note when present, then the basis line.

**One card, two subheadings — and the heading adapts to what is present** (AGY, 2026-08-25).
Two stacked cards would double the padding, margin and border for a block that frequently holds a
single row each, fragmenting the space between "Identification" and "Finding this bird". A `<details>`
wrapper on the second tier was rejected too: it adds tap friction and hides genus mates exactly when
the slash tier came up empty and the user most wants them.

So `SimilarSpeciesCard` renders **one** `<section class="card">`, with the heading structure
determined by which tiers are non-empty — this keeps the heading hierarchy valid (every other card on
this page uses `<h2>`; bare `<h3>`s under no `<h2>` would break it) and avoids a redundant
double heading in the common single-tier case:

| Tiers present | Markup |
|---|---|
| slash only | `<h2>Similar species</h2>` + rows |
| genus only | `<h2>Related species</h2>` + rows |
| both | `<h2>Similar &amp; related species</h2>`, then `<h3>Similar species</h3>` + rows, a subtle divider, `<h3>Related species</h3>` + rows |
| neither | nothing renders |

Row markup is identical in every case — the tiers differ only in heading and basis line.

**Basis line: plain text, never a badge.** `Badge.svelte`'s `kind` union is
`'need'|'seen'|'notable'|'unmatched'|'stale'`; a new kind means new custom properties and a fresh
WCAG AAA audit. Render as `<p class="basis muted">`:
- *Similar species* → `eBird reporting group: <em>{slash_com_name}</em>`
- *Related species* → `Same genus — not necessarily a look-alike`

Keep the tier-2 basis line even though the heading now carries part of that meaning — the heading
says what the grouping *is*, the basis line says what it is *not*, and the second half is the part a
birder scanning in the field needs.

Do **not** word tier 2 as "1 of N regional species" — regional computation was cut, and the gate is
on in-scope genus-mates, not range.

**The basis line is also what makes a note-less row feel finished** (~37% of rows). It states *why*
the link is there, so a bare row reads as informational rather than as a failure to load. Never add
"no description available" text.

**Zero state: silent absence.** Guard on `data.similar.length > 0` and render nothing for the 38%
with no candidates — every other card on this page is conditionally present (`hasMedia`,
`hasFieldCraft`, `hasGallery`, `forecastTeaser`). The "never empty" discipline in
`docs/2026-08-21-species-enrichment-field-guide-zero-empty-CC.md` governs search discoverability and
the taxonomy index, not optional enrichment sections on one species page. Help carries the
explanation instead (Step 6).

**Navigation — needs a deliberate loader change (CODEX1 P1 #4).** Link via `speciesLinkHref` from
`src/lib/species-context.ts:68-85`; do not hand-build the href. Its signature is
`(code, { backDays, returnTo, context? })` — `backDays` and `returnTo` are **required**, so "just
pass the code" would not compile, and dropping `context` is worse than a style nit: that helper
exists precisely because losing `lat/lng` makes the next species page report around the *saved home*
instead of the *searched place* (`species-context.ts:1-9`).

The loader currently returns `returnLink`, `backDays`, `distKm` and `originLabel` but **not** the
validated `SpeciesLocationContext` (`+page.server.ts:261-285`). Wire it through deliberately, then
pass into A→B links: `data.backDays`, the **original** `data.returnLink.href`, and the current
context. Do **not** nest the current species URL into `returnTo` — chaining nests params on every
A→B→C hop, and `safeReturnTo` (`src/lib/return-link.ts`) degrades a `/species/<code>` target to the
generic label "Back", strictly worse than keeping "← Home".

Test that A→B preserves origin, report window, and the original return target.

**One thing to verify during implementation:** AGY's prototype puts `min-height: 48px` on an
`inline-flex`, baseline-aligned `.species-link` inside a flex `.name-line`. That combination can
inflate row height oddly — the mockup's `.obs .name` sets no min-height, and `.btn` uses
`align-items: center`. Confirm the tap target genuinely measures ≥48px without visually bloating the
row before settling the markup.

AGY supplied a full working component prototype (markup + scoped styles) in the relay thread; use it
as the starting point rather than writing the card from scratch.

Wire the loader in `src/routes/species/[code]/+page.server.ts`: add `getSimilarSpecies(code,
t.sci_name, userId)` to the existing `Promise.all` (~line 242) — `t.sci_name` is already in hand from
the taxon query at line 51 — and return `similar` alongside `sampleMedia` (~line 264).

### Step 6 — user-facing docs (required, not optional)

cs.md mandates a Help + About update in the same change as any user-visible feature. Add a bullet to
the Field guide accordion in `src/routes/help/+page.svelte` and a Version History entry in
`src/routes/about/+page.svelte`. Say plainly where the links come from (eBird's own reporting
groups), and that their **absence means no such group exists — not missing data**.

---

## Constraints this must satisfy (cs.md)

- **Attribution mandatory**: creator · source ↗ · license under every Commons thumbnail, as in
  `SpeciesMediaCard.svelte:100-120`. The relationship claim is an eBird claim — say so in the basis
  line; the page footer's existing "Data from eBird.org" (`+page.svelte:692`) covers the global rule.
- **No placeholder data**: an unresolved slash member is dropped, never rendered.
- No Tailwind; component-scoped `<style>`. WCAG AAA 7:1 including muted text. Badges carry colour
  **and** text. Mobile-first, breakpoints 640/1024 only, ≥48px tap targets.
- DDL only via `backend/db/migrations/` + `./backend/db/migrate_pg.sh` — never raw `psql -f`.

---

## Risks

- **`species_media` is empty locally**, so the card shows text-only rows in dev. Restore a prod
  snapshot to see the real thing — and note the cs.md trap: a prod snapshot in `birds_test` 500s
  every page until stored eBird keys are re-encrypted under the test `EBIRD_KEY_SECRET`. That looks
  exactly like a code regression and is not one.
- **Slash taxa are ABA/Palearctic-biased.** 62% in-scope coverage is a floor, and it is highest
  exactly where this user birds (US-WA, US-FL dominate `seen_species.region_code`).
- **Whitelisting `similar`/`confusion`/`identification` in `SECTION_KEYWORDS` is deferred**, and
  deliberately so. New keywords only take effect on the next wiki fetch (180-day clock), and a forced
  re-fetch re-stamps `wikipedia_rev_id` for every article edited since — which makes `aiDueCodes`
  true and re-runs the AI stage across the corpus. Given only 2/8 sampled articles even have such a
  section, that is a poor trade. Revisit as a deliberate, budgeted backfill, never as a side effect
  of editing a keyword array.

---

## Verification

1. `npm run test:db:up`, then `npm run dev:test` (port 5178) — the app runs against the test cluster;
   there is no separate local dev cluster.
2. `npm test` (vitest). This repo has **no component-render harness** — per the header of
   `species-media.test.ts`, UI is verified manually and coverage lives at the loader / pure-function
   level. Follow that; do not invent a harness.
   - **NEW `src/lib/similar-species.test.ts`** — cases drawn from real rows:
     `Aythya marila/affinis` (2-part, same genus); `Accipiter striatus/Astur cooperii` (cross-genus);
     **`Porzana porzana/Zapornia parva/pusilla` asserting the third element is `Zapornia pusilla`
     and explicitly *not* `Porzana pusilla`** — this is the regression guard for the whole feature;
     the 5-part `Larus` row; no-slash → `[]`.
     Plus a DB-gated parity case: expand all 1,035 live slash rows and assert **≥2,109 of 2,116**
     member slots resolve — this fails loudly if a future taxonomy sync changes the shape.
   - **`src/routes/species/[code]/species-media.test.ts`** — extend using its existing `seedTaxon` /
     `noKeyUserId()` harness: loader returns the *other* member not self; `seen` is scope-personal
     (true for user A, false for user B); a species in no slash taxon → `[]`; an unresolvable member
     is dropped rather than emitted; carry-forward works end-to-end; no network on the loader path.
   - **`src/lib/server/ai-enrichment.test.ts`** — extend beside the `validateTags` tests: an
     out-of-set code is dropped into `droppedSimilar`; `similar_code === species_code` is dropped;
     **a missing or unparseable `similar` yields `[]` and does not throw**; note length is capped.
3. Manual, against a prod snapshot: `/species/dowwoo` shows Hairy Woodpecker (`haiwoo`);
   `/species/coohaw` shows Sharp-shinned Hawk (`shshaw`, from `Accipiter striatus/Astur cooperii`)
   and American Goshawk (`norgos`, from `Astur cooperii/atricapillus`). Confirm every thumbnail
   carries creator · source · license, and that a photo-less target degrades to a text row.
4. `npm run check` (svelte-check, 0 errors) and `npm run build` before commit.
5. Mobile at <640px: no horizontal page scroll, tap targets ≥48px.
