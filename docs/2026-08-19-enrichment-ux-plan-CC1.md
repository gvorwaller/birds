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
One commit (single coherent surface) unless review prefers a split;
AGY advisory → GROK pins → build → CODEX1+GROK dual review → Gaylon's
deploy word.
