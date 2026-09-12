# Field Guide taxonomy reference and browsing improvements

Prepared September 11, 2026. Design plan; implementation tracked under td-c60291 and td-5bc1d4.

## 1. Purpose and task boundaries

Add an educational **Taxonomy** tab to Field Guide, supported by richer taxonomy data, family filtering, taxonomic sorting, and banding-code search.

The feature should help a user understand how birds are related, explore a family, move between classification and individual species, and organize personal study.

| Task | Role in this plan |
|---|---|
| **td-c60291 — Taxonomy reference guide** | Owns the educational content, Taxonomy tab, hierarchical browser, and two-way species links. |
| **td-5bc1d4 — Taxonomic sort, banding-code search, family browse** | Owns taxonomy storage, sync validation, family filtering, search, and sorting improvements. Narrow its initial scope to Field Guide and Viewed species. |
| **td-b52a90 — Deeper taxonomy and split survival** | Remains deferred under the existing owner ruling. Store useful source metadata now, but do not change historical records or Seen/Need calculations. |

Implement the first two tasks as coordinated work, with separate acceptance criteria. Do not mark td-b52a90 completed merely because additional fields are stored.

## 2. Current implementation and constraints

The existing taxonomy cache stores species code, common name, scientific name, category, common family name, and fetch timestamp. The taxonomy sync replaces its contents inside a transaction.

Field Guide already supports name/code and enrichment searches, geographic filters, tags, and personal Viewed badges. Search results use relevance ranking; they are not simply alphabetical. The current search also has a fixed 50-result limit, which must not become a hidden limit on family browsing.

Viewed species already supports family and country grouping. Its history belongs to the signed-in account, including accounts that share another person’s life list.

The new feature must:

- Use the app’s eBird taxonomy as its classification authority.
- Include species without enrichment or photos.
- Keep personal viewing history separate from shared reference data.
- Preserve existing search, geographic-filter, and navigation behavior.
- Avoid automatic inference of sightings or taxonomy migrations.
- Follow the existing accessibility, attribution, and responsive-layout requirements.

## 3. Taxonomy storage and synchronization

### Additional cached fields

Add nullable fields through a numbered database migration:

| Field | Purpose |
|---|---|
| `taxon_order` | Numeric source ordering; preserve fractional values. |
| `order_name` | Scientific order name supplied by the taxonomy source. |
| `family_code` | Identifier used for family links and filtering. |
| `family_sci_name` | Scientific family name. |
| `banding_codes` | Source-provided code array for exact code searches. |
| `report_as` | Source reporting relationship, retained without changing matching behavior. |
| `extinct` | Source-provided status, with unknown distinct from false. |

Retain the existing common family name field for compatibility.

Before implementing the mapping, inspect a real taxonomy response and the official source definitions. Do not assume that every field mentioned in the historical audit is present for every category. Missing optional metadata remains unknown; do not manufacture identifiers, ranks, or relationships.

### Sync behavior

Extend the existing sync rather than introduce a second competing taxonomy pipeline.

- Validate the complete response before replacing the current cache.
- Reject malformed identifiers, duplicate species codes, invalid numeric ordering, and inconsistent family-to-order relationships.
- Permit genuinely absent optional metadata.
- Preserve atomic replacement: validation or insertion failure leaves the previous cache intact.
- Record row counts and metadata-coverage counts in the sync result without credentials or raw response logging.
- Keep the current species-matching and override behavior unchanged.
- Treat a failure involving an existing override’s foreign key as a failed sync; do not delete the override automatically.

Add indexes for family/category/ordering lookups and banding-code membership. Verify their usefulness with representative query plans on the isolated test database.

One successful taxonomy resync backfills the new metadata. Before that resync, existing pages remain usable and taxonomy-specific controls show an explicit unavailable state.

A fetch timestamp is not a taxonomy edition. Display it as “Taxonomy refreshed …”; do not label it as an authoritative edition number.

## 4. Taxonomy tab and educational experience

### Navigation

Extend the shared Field Guide tabs to:

**Browse species · Viewed species · Taxonomy**

Use `/taxonomy` as the new route and include it in Field Guide’s active-navigation logic. All existing signed-in roles may access it.

### Educational introduction

Provide a concise, expandable introduction covering:

- What taxonomy is and how it helps bird study.
- Order, family, genus, and species.
- Common names versus scientific names.
- Why classifications and names change.
- The difference between species and reporting categories such as subspecies groups, hybrids, and ambiguous identifications.

The browser hierarchy is **order → family → species**. Explain genus in the introduction, but do not build a genus hierarchy by splitting scientific-name strings.

Use original, reviewed prose with source links. Sibley and iBird are experience references, not sources to copy.

### Hierarchical browser

- Show orders in source taxonomic order.
- Expanding an order reveals its families and their species counts.
- Expanding a family reveals its description and complete species list.
- Count only current rows classified as species; label counts accordingly.
- Show common and scientific family names where available.
- Display extinct status when explicitly supplied by the source.
- Keep species with incomplete classification accessible in a clearly labeled “Classification unavailable” group.
- Allow searching orders, families, and species by their available names; support species and banding codes for species matches.

Load the order/family summary first and fetch the selected family’s species through the route loader. Do not render every species in the world into the initial page.

Use URL state for the selected order, family, query, and focused species, for example:

`/taxonomy?family=<familyCode>&focus=<speciesCode>`

Only one order and family need to be expanded at a time. Browser Back must restore the preceding selection.

### Automatic family-description enrichment (revised September 11)

The original manual-only content plan was incomplete and is superseded here. The app must populate descriptions itself; the owner is not expected to write family accounts.

**Source and identity (revised after live failures):** Prefer a publicly accessible Animal Diversity Web family account with an exact scientific-name and family-rank match, bird-class article, substantive natural-history prose and author attribution. Classification-only pages are not sources. Respect ADW’s eight-second request interval and HTTP cooldowns. If unavailable, use the Wikipedia path below. Use one source per description so attribution and adaptation licensing remain explicit. Birds of the World is excluded; no subscription access or license request is planned. eBird remains the authority for current family membership, names, counts and order. Resolve each scientific family name through Wikidata P225, requiring family rank P105/Q35409 and exactly one matching entity. Fetch its English Wikipedia article. When no English sitelink exists, try the scientific-name article/redirect, requiring the family name in the resulting text. Missing, ambiguous or insufficient sources remain explicit gaps; do not invent prose or use an arbitrary common-name search result. A redirect to a member species can be used only for claims the source supports about the family; never generalize member traits without support.

**Generation and checking:** use a separate Family descriptions model setting (ai.model.family-enrichment), default Sonnet 5, with Sonnet 5 or Opus 5 allowed for both drafting and auditing. Species enrichment retains its own setting. Keep the existing per-call usage ledger. Supply the stored source text as untrusted reference data. Number every cached source passage deterministically. Generate original natural-history paragraphs citing these passage IDs, and validate that each reference exists. Never require a copied quotation or a minimum quotation length. Report paragraph-specific validation errors. A second metered call audits every retained claim, its scope and qualifications against the same passages. Omitted counts or unrelated source details are not errors. Rejections must identify the actual draft claim and explain its missing support or contradiction; short evidence and faithful paraphrases are valid. Publish only after that audit accepts the complete description. Rejected drafts remain unpublished; scrubbed audit feedback accompanies the next generation attempt. Do not call this human review or a guarantee of correctness. Do not generate species counts, current taxonomy or conservation assessments from Wikipedia.

**Durable storage:** migration 0058 adds family_enrichment, independent of the replaced taxonomy cache, plus a singleton control row. Keep published content, article title, revision permalink, Wikidata entity, source text, retrieval time, generation time, generation and verifier models, input hash, attempt state and next retry. Source and paid draft checkpoints survive pause/restart. Persist the last good published description through refresh failures. The input hash covers prompt version, scientific family identity, order and sorted species membership; classification changes invalidate work. Recheck under a short taxonomy table lock before publication to discard superseded drafts.

**Automatic execution:** the existing single worker ensures a durable enrich_families singleton at startup and periodically, even when other queues are busy. A successful taxonomy sync nudges it. Each run reconciles every current species family, processes one due family, and atomically schedules its successor, returning to FIFO order so other tasks get turns. Current descriptions refresh after 180 days; unmatched sources retry after 30 days. Transient errors retry after 15 and 30 minutes, then weekly after repeated failures. The scanner checks again hourly when nothing is due. Every family remains browsable throughout; no page GET starts provider calls.

**Controls and failures:** Admin reports all current families, descriptions available, pending, missing-source and error counts, with an expandable complete issue list and next retry dates. Family-only pause/resume persists across deploys; the existing worker pause also applies. Finish an in-flight paid call and checkpoint before stopping. Retry gaps makes failed/missing-source rows due without regenerating current descriptions. Rate limits impose a shared family-lane cooldown honoring Retry-After (at least 30 minutes). AI credential failures pause the family lane visibly. Source permission failures are not mislabeled as AI credential problems. Cancellation/drain and publication use existing durable job transitions.

**Display and attribution:** show AI summary wording, explicitly not human-reviewed, the selected source link and author credit, with CC BY-NC-SA 3.0 for ADW adaptations or a Wikipedia revision and CC BY-SA 4.0 for Wikipedia adaptations. Existing published Wikipedia attribution stays correct during refresh. Missing and waiting descriptions have honest states. A failed or pending refresh labels the previous description. The full source and unfinished draft remain server-side. No manual essay editor or owner-written descriptions are required.

**Verification:** isolated PostgreSQL tests cover idempotent scheduling, freshness, input invalidation, source identity, unknown-passage rejection, unsupported claims, last-good preservation, checkpoints, cooldown, credentials, pause/drain and authorization. Smoke-test real source retrieval and configured provider behavior where available, and inspect Taxonomy and Admin in WebKit at mobile and desktop widths. Run framework checks and app/worker builds before release.

Reference APIs and reuse guidance: [ADW text reuse](https://animaldiversity.org/about/use_conditions/), [ADW kingfishers](https://animaldiversity.org/accounts/Alcedinidae/), [Wikidata family rank](https://www.wikidata.org/wiki/Q35409), [Wikipedia reuse guidance](https://en.wikipedia.org/wiki/Wikipedia:Reusing_Wikipedia_content).

### Species rows and personal study

Each species row includes its common name, scientific name, detail-page link, and the signed-in user’s Viewed badge when applicable.

Opening the Taxonomy tab, an order, or a family does **not** record visits for its species. Only opening a species detail page uses the existing viewing-history behavior.

Personalized responses remain private and non-cacheable by shared caches.

## 5. Two-way links and browsing controls

### Species detail links

Make the existing family label on each species page a link to that family in Taxonomy. Show the order alongside it when available.

The destination must open the relevant family and highlight the originating species. The highlight uses text or shape as well as color.

Species links from Taxonomy carry a validated internal return URL. Returning restores the selected family and search context. If metadata has changed since the link was created, show a clear unavailable message and a route back to the taxonomy overview.

### Family filter in Browse species

Add a family selector using `family_code`, with common and scientific names in its labels.

- A selected family alone is sufficient to run a search.
- Family, geography, text, and tags combine by intersection.
- Species lacking enrichment remain eligible unless selected enrichment tags exclude them.
- All filters remain represented in the URL.
- Unknown family codes produce an explicit invalid-selection response rather than silently broadening the search.

### Sorting

Add explicit sorting options:

| Surface | Options and defaults |
|---|---|
| Taxonomy browser | Taxonomic order by default. |
| Browse species | Preserve current relevance behavior; offer alphabetical and taxonomic order. |
| Viewed species | Preserve most-recently-viewed default; offer alphabetical and taxonomic order. |
| Not yet viewed | Preserve alphabetical default; offer taxonomic order. |

For taxonomic sorting, use source order, then common name and species code as deterministic tie-breakers. Rows lacking source order appear afterward and remain accessible.

In grouped study lists, sorting applies to species within each group. Country headings retain their existing order. Family headings use taxonomic order when that sort is selected.

Update the country-expansion API so it honors the same sort options as the parent study page.

### Banding-code search

Add case-insensitive, exact banding-code matching to Browse species, Taxonomy search, and Viewed species search.

- Keep source species-code matching.
- Return all species matching an ambiguous banding code.
- Show the matched code in results so the match is understandable.
- Do not generate codes from names.
- Preserve geographic, family, study-status, and tag filtering.

Under relevance sorting, exact species-code matches rank first, followed by exact banding-code matches, then the existing name and prose ranking.

Do not extend this change to import matching, photo matching, or every species picker in the application.

### Complete result access

Replace the fixed Field Guide result truncation with explicit pagination:

- 100 results per page.
- Visible total count and current result range.
- Previous/Next controls preserving every filter and sort parameter.
- Reset to page one when filters or sorting change.
- Apply filtering and sorting before pagination.

Family lists inside Taxonomy load all species in the selected family without an arbitrary cap. Existing complete Viewed species collections remain complete.

## 6. Deferred taxonomy-change handling

Store `report_as` and category metadata for future work, but do not use them to reinterpret existing observations in this release.

Specifically, do not:

- Award multiple new species after a split.
- Convert hybrids or ambiguous identifications into confirmed species.
- Remap personal Viewed history, sightings, photos, or overrides automatically.
- Change Seen/Need calculations.
- Expand the ordinary Field Guide species universe to every reporting category.

When td-b52a90 is resumed, its first deliverable should be an impact report for changed or retired codes, covering affected sightings, photos, overrides, and viewing history. Preserve original records and distinguish deterministic changes from cases requiring review.

Cornell’s documentation explains why names alone are insufficient: taxon concepts can change across editions even when names remain the same. [Cornell taxonomy update explanation](https://www.birds.cornell.edu/clementschecklist/introduction/updateindex/october-2025/)

That future reconciliation work requires its own implementation plan.

## 7. Verification and acceptance

### Database and sync

Test on isolated `birds_test`:

- Valid metadata ingestion, including fractional ordering and multiple banding codes.
- Missing optional metadata.
- Duplicate or malformed taxonomy responses.
- Transaction rollback preserving the previous cache.
- Family/order consistency.
- Existing override constraints.
- No changes to personal history or sightings during metadata resync.

### Search, sorting, and isolation

Verify:

- Family-only browsing and combined family/geography/tag/text filtering.
- Unenriched species remain discoverable.
- Exact, lowercase, ambiguous, and missing banding codes.
- Deterministic taxonomic sorting and missing-order behavior.
- More than 100 matches remain reachable through pagination.
- Country-expanded study lists respect selected sorting.
- Two accounts see their own Viewed badges and study membership.
- Family browsing does not mark species viewed.
- Existing recent/alphabetical defaults and old URLs remain compatible.

### Browser checks

Use authenticated WebKit at phone and desktop widths to verify:

- Three-tab navigation without horizontal overflow.
- Keyboard-accessible expansion and visible focus.
- Minimum 48px interaction targets and required contrast.
- Species → family → species navigation and Back restoration.
- Direct family links and focused-species visibility.
- Loading, empty, missing-metadata, and retry states.
- Pagination and sorting with filters preserved.
- No browser exceptions.

Run focused tests, `npm run check`, `npm run build`, and `git diff --check`. Update Help and About in the same implementation.

Measure initial taxonomy-page loading and large-family expansion. These requests must use local cached data and make no upstream taxonomy calls.

## 8. Implementation sequence, release, and plan delivery

1. **Data foundation:** migration, source validation, sync extension, indexes, and isolated backfill verification.
2. **Taxonomy experience:** introduction, hierarchy, family content support, Viewed badges, and two-way links.
3. **Browsing improvements:** family filter, banding-code search, sorting, and explicit Field Guide pagination.
4. **Verification:** regression tests, WebKit checks, documentation, and task-specific acceptance evidence.
5. **Release when requested:** standard Birds deployment script, taxonomy resync, metadata-coverage verification, live health checks, and authenticated smoke testing.

The richer schema is additive. An application rollback can leave the added columns in place. A failed resync must preserve the prior taxonomy.

Record this plan against td-c60291 and td-5bc1d4 when execution is authorized. Add a reference to td-b52a90 explaining that its record-reconciliation scope remains deferred.

### Plan artifacts

Matching versions of this plan:

- `docs/2026-09-11-field-guide-taxonomy-plan.md`
- `docs/2026-09-11-field-guide-taxonomy-plan.html`

The HTML is self-contained, with readable responsive styling, linked contents, the same plan text, working source links, and print styling. Open the saved HTML as a new tab in the existing Safari window, preserving its current tabs.
