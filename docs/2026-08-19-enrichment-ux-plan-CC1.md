# Enrichment UX: instant refresh, honest labels, sitelink fallback (td-b7d021)

Gaylon 2026-08-19, after the Hudsonian Whimbrel session. Prod evidence
in the td: his two manual refreshes each COMPLETED in ~1s — the empty
card was a DATA gap (whimbr3 → Q27608723 has no enwiki sitelink), and
the thing that read "queued" for 5 minutes was the recurring daily
scan singleton (pending all day with next_retry_at = tomorrow),
rendered by the chip as "Load queued — Enrichment scan (system)".

## 1 — Honest labels & scheduled-vs-queued display

- The manual refresh label becomes `Species data — {comName}` (the
  enqueue site already has taxonomy in hand).
- Jobs API: recurring singletons (scan_enrichment, scan_need_alerts)
  whose next_retry_at is in the future get `scheduled: true` + the
  time. The global chip SKIPS scheduled jobs entirely (it exists to
  narrate actual work); the Hotspots & data hub shows them on their
  own line: "Next enrichment scan — tomorrow 11:39 PM ET" (app TZ,
  the Home as-of precedent). A scheduled-for-tomorrow row must never
  read as "queued".
- waiting_retry jobs keep their existing honest "retrying" copy.

## 2 — Immediate on-demand refresh (the load "immediate in any case")

The admin Refresh currently enqueues behind the FIFO. New shape:
- `enrichOneNow(code)` in species-enrichment.ts: a compact synchronous
  single-species pipeline reusing the EXISTING exported building
  blocks — fetchWikidataBatch([code]) + the sci-name fallback +
  fetchArticlePlaintext + upsertResolution / upsertWikiOk /
  markWikiNoArticle — same outcome vocabulary as the worker unit path,
  wall-budgeted (~20s AbortSignal).
- The refresh_enrichment action calls it inline: the About card is
  populated when the response lands (one SPARQL + one wiki fetch ≈
  2-4s). On success it ALSO enqueues the existing aiOnly chunk so
  field craft follows in the background (existing route, existing
  dedup). On transient failure/rate-limit → fall back to today's
  enqueue with a truthful message.
- Queue semantics unchanged for scans/bulk; no new job types; the
  admin gate stays (communal quota).

## 3 — no_sitelink fallback (the Whimbrel flavor of split survivors)

- When resolution finds a QID but NO enwiki sitelink, try the article
  by SCIENTIFIC NAME before giving up: fetchArticlePlaintext(sciName)
  — enwiki redirects binomials ("Numenius hudsonicus" → the article).
  Accept the redirect target; store the actual wikipedia_title (the
  About card already cites it). If that misses too → no_article as
  today.
- Risk disclosed: a still-lumped enwiki may serve the COMPLEX article
  (old "Whimbrel") for both daughters — judged better than an empty
  card; the cited title makes it honest. Reviewers to confirm.
- The weekly no_mapping retry lane extends to resolution='no_sitelink'
  rows (same clock discipline: every attempt restamps; bounded weekly;
  the anti-loop regression pattern from fdb3d40 applies).

## 4 — Bulk US pre-load: DEFER

Gaylon walked this back after the scope clarification: enrichment
scope = seen ∪ frequency ∪ photos, so a STATEWIDE LOAD already brings
that state's whole reported avifauna into scope. Instead of a bulk
runner: one Help sentence documenting that lever. Revisit only if
on-demand + statewide coverage still leaves gaps in practice.

## Tests
enrichOneNow outcome matrix (mapped+article / mapped+no-sitelink+sci
rescue / no-mapping+fallback / rate-limit → fallback-to-enqueue);
scheduled-flag derivation (recurring + future next_retry_at only);
label content; weekly lane selects aged no_sitelink rows and restamp
clears (DB pin, mirrors the no_mapping pin); chip skips scheduled.

## Sequencing
Two commits (GROK pin): A = honest labels / scheduled-vs-queued /
chip+poll skip / hub line; B = shared sci-name wiki fallback + weekly
lane + enrichOneNow + admin action + About note + Help sentence.
AGY advisory → GROK pins → build → CODEX1+GROK dual review → Gaylon's
deploy word.

## GROK rulings (binding) — 2026-08-19

Design-only review of this doc at `66c3250`. AGY is advisory and offline;
these pins are the binding layer. No code in this turn. Independently
read the refresh action, jobs API + chip, `wikiStaleCodes` / unit
`rescued` path (the fdb3d40 anti-loop), `fetchArticlePlaintext`
(`redirects=1`, stores `page.title`), and the About card citation.

### (a) Chip skips scheduled — YES. No "minimal" chip presence.

The chip exists to narrate **actual work**. A pending daily singleton
with `next_retry_at` tomorrow is not work. A ghost "Load queued —
Enrichment scan (system)" for 24 hours is the bug Gaylon hit.

1. **`scheduled: true` derivation (API only).** True iff
   `type ∈ {scan_enrichment, scan_need_alerts}` AND `status === 'pending'`
   AND `next_retry_at > now` AND `progress.phase !== 'waiting_retry'`.
   Waiting-retry jobs are **not** scheduled; they keep today's
   "Load retrying soon" copy. Need-alerts is included so that singleton
   cannot become the next all-day chip ghost. No other types.

2. **Chip: skip entirely.** `jobsPoll.active` / layout chip ignore
   `scheduled === true`. If the only pending rows are scheduled, **hide
   the chip**. Do not invent a calm "scan tonight" chip — that is hub
   information, not a global affordance.

3. **Poller cadence.** Scheduled jobs are **not active** for
   `nextIntervalMs`. A scheduled-only set returns `null` (idle) after
   the grace poll — today's 2.5s loop against a tomorrow timer is how
   the chip stays lit all day. `track()` still wakes the poller when a
   real job is enqueued.

4. **Hub line — enrichment scan only.** On `/forecast/data` Background
   loads, **own muted line under the h2**, before worker-dead / stale
   notices, **not** in the queued `<ul>`:
   `Next enrichment scan — tomorrow 11:39 PM ET`.
   Format with `FORECAST_CALENDAR_TZ` + `" ET"` (Home as-of precedent;
   droplet SSRs in UTC). Relative day: `today` / `tomorrow` / weekday
   date, then the time. **Do not** add a "next need-alert scan" line in
   this change. SSR the ISO from the loader (`nextEnrichmentScanAt`) so
   the line does not depend on the poller. A scheduled `scan_enrichment`
   row must never render as "queued" in the jobs list (skip it there;
   the dedicated line covers it). Empty copy "No loads running or queued"
   ignores scheduled rows.

### (b) Sci-name article fallback — ACCEPT. Note only on the fallback path.

Accept `fetchArticlePlaintext(sciName)` when Wikidata returned a QID
and **no** enwiki sitelink. `redirects=1` already follows binomials;
store the **actual** `page.title` (About already cites it). Miss →
`markWikiNoArticle` as today. **Never fetch by comName** (homonyms).
Gate on `validSciName`; invalid sci → skip fallback, `no_article`.

**Keep `resolution = 'no_sitelink'` on both hit and miss.** That is
Wikidata truth. A hit is a Wikipedia convenience, not a sitelink.

**Visible note — fallback-served only**, not a generic name-mismatch
detector (eBird vs enwiki English-name drift — Rock Pigeon / Rock dove,
Gray / Grey — would spam the card). Trigger:
`resolution === 'no_sitelink' && wiki_status === 'ok'`. One muted
sentence under the extract:

`Wikipedia has no sitelink for this taxon — showing "{wikipedia_title}".`

Source & license citation stays. Empty-state copy for a miss stays
"No Wikipedia article for this species" (no new parenthetical).

### (c) Sync refresh — 20s wiki only; AI stays queued.

`enrichOneNow(code, { signal })` in `species-enrichment.ts` is a
**shared** pipeline (see (d)), not an action-only fork. Action
`refresh_enrichment` (admin gate unchanged) **awaits** it, then
`invalidate` so the About card paints in-response.

- Wall budget **20s AbortSignal** covering SPARQL + wiki. Pass that
  signal into the fetches — do not let wikipedia.ts's 30s default
  overrun the action.
- **Never run AI inline.** Wiki success + AI due → enqueue the
  existing `aiOnly` chunk (`dedupKeys.enrichAiChunk`, existing route /
  dedup). Wiki success + AI already current for this rev → no enqueue.
- **No AI enqueue on `no_article`.**
- Transient / abort / rate-limit: **do not** `markWikiError` (the
  worker will write). Leave the row unchanged. Fall back to today's
  `enrich_species` one-code `force: true` enqueue. Truthful copy:
  `Couldn't refresh now — queued to retry.`
- Outcome copy (form `message`, existing `.ok` flash):
  - wiki ok + AI queued → `Article loaded — field craft is being written.`
  - wiki ok + AI not due → `Article loaded.`
  - no_article after fallback → `No Wikipedia article found.`
- Button busy text: **`Refreshing…`** (not `Queuing…`). 48px stays.
- Queue semantics otherwise unchanged; no new job types.

### (d) Skip-review pins (the ones that prevent another fdb3d40)

1. **One function, two callers.** The sci-name wiki fallback lives in
   one helper used by **both** `enrichOneNow` and the worker unit path.
   If only the action has it, the weekly lane restamps `no_article`
   forever and Whimbrel never heals unless Gaylon is on the page.

2. **Do NOT copy the `no_mapping` `rescued` predicate onto
   `no_sitelink`.** `fetchWikidataBatch` returns a QID for sitelink-less
   rows every time, so `resolved.has(code)` is almost always true.
   Using that as rescue would re-hit Wikipedia on every 15-minute drain
   for every split survivor. Open the sci-name wiki path only when
   `force` OR `retry_due` OR the skip probe is false (missing / error /
   180d-stale). Fresh `no_sitelink` + WDQS hit → **fresh-skip**.

3. **Weekly lane is miss-only.** Do **not** use the bare
   `resolution = 'no_sitelink' AND clock` (that weekly-refetches
   successful fallback articles). Pin:

   `resolution = 'no_sitelink' AND wiki_status IS DISTINCT FROM 'ok'
    AND wiki_fetched_at < NOW() - INTERVAL '${ERROR_RETRY_DAYS} days'`

   Hit → `upsertWikiOk`, resolution stays `no_sitelink`, `wiki_status='ok'`,
   180d refresh applies. Miss → `markWikiNoArticle` restamps (same
   anti-loop as fdb3d40). DB-gated test: 8-day-old `no_sitelink` +
   `no_article` IS selected; same row with `wiki_status='ok'` is NOT;
   a restamp removes the miss.

4. **Manual label — exact string, no double prefix.**
   `displayName` today is `Enrich species data — ${label}`. Setting
   label to `Species data — {comName}` produces
   `Enrich species data — Species data — Hudsonian Whimbrel`. Pin:
   a one-code manual refresh (`dedupKeys.enrichSpeciesOne` /
   `payload.force && codes.length === 1`) displays **exactly**
   `Species data — {comName}`. Label is just `comName`.

5. **Help (B, one sentence, Field guide section).** Statewide load
   already brings that state's reported avifauna (`seen ∪ frequency ∪
   photos`) into enrichment scope. No bulk-US runner. Revisit only if
   on-demand + statewide still leaves gaps.

6. **Tests (in addition to the drafted matrix).**
   - scheduled derivation: recurring + future `next_retry_at` only;
     waiting_retry is false; other types false.
   - chip / `nextIntervalMs`: scheduled-only → no chip, idle cadence.
   - displayName exact string, no double prefix.
   - enrichOneNow: mapped+article; no_sitelink+sci rescue (stores
     redirected title, resolution stays `no_sitelink`); no_sitelink+miss
     → `no_article`; abort/rate-limit → no `markWikiError`, caller
     falls back to enqueue; AI never called inline; AI not enqueued on
     miss.
   - Worker anti-loop: fresh `no_sitelink` + WDQS hit does **not**
     call `fetchArticlePlaintext`.
   - Weekly DB pins in (d)3.
   - About note trigger is fallback-served only.

7. **Two commits A then B** as under Sequencing. Dual review. Hold
   for Gaylon's deploy word. No push / no deploy from this turn.

Plan is pinned. Ready for the implement branch when you are.
