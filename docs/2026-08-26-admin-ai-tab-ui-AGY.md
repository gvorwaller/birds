# Admin AI tab — UI/UX design (AGY, 2026-08-26)

**Status:** Accepted as the implementation starting point for the UI step of
`docs/2026-08-26-ai-foundation-model-control-usage-meter-plan.md`, with the
corrections below. AGY's full proposal (markup + scoped CSS) arrived via relay;
the load-bearing decisions and sketches are preserved here so the implementer
works from a file, not relay history.

## Corrections applied against verified codebase facts (CC)

1. `#fff8f8` on `.compare-col.error` is a hardcoded literal — breaks dark
   theme and violates the no-new-colors rule. Use `border-color: var(--danger)`
   with the normal `var(--bg)` background (`--danger` EXISTS in the theme —
   verified; `--danger-soft` does not).
2. Quick-pick pills: `belkin` → **`belkin1`** (the code as written matches
   nothing). More importantly, pills come from **loader data** (a small query
   for wiki-ok in-scope species), not a hardcoded array — hardcoding species
   in the UI is exactly the BTC-dashboard catalog-duplication defect this plan
   exists to avoid. All four suggested species verified wiki-ok:
   dowwoo, belkin1, grbher3, pilwoo.
3. Species free-text input: a "client-side wiki check" is impossible — the
   guard is **server-side in the action** (species exists + wiki_status='ok',
   friendly error otherwise).
4. Compare grid: `repeat(var(--cols))` from 640px gives ~150px columns at 4
   models — unreadable. **2 columns at 640, 4 at 1024**, stacked below 640.
   (Drop the "swipeable cards" prose — the stacked CSS AGY actually wrote is
   the right answer.)
5. Abort explanation as a tooltip is hover-only — mobile-hostile. Always a
   **visible caption** (AGY's compare cells already do this; the ledger row
   must too).
6. Reuse the **existing modal pattern in `trips/[id]/+page.svelte`** rather
   than introducing a second overlay/dialog implementation.
7. The "High burn" badge threshold ($15/day) is a named constant, not a magic
   number. The modal example's "Claude 3.5 Sonnet" is not a registry model —
   cosmetic, examples render from the registry.

## Adopted design decisions (AGY, verbatim in spirit)

- **Tab label: "AI & Cost"** — the word Cost in the tab answers the actual
  anxiety before a single click.
- **Panel order by decision hierarchy**: (1) at-a-glance meter, (2) model
  controls, (3) Compare Lab, (4) recent-calls ledger.
- **Meter: dollars dominant, tokens subordinate.** Four stat tiles
  (Today / 7d / 30d / All-time): large `$X.XX`, micro-subline
  `N calls · N tok`. 2-col grid on phone, 4-col ≥640. A burn badge
  (`data-color` ok/warn + text) flags an unusual day.
- **Model controls are radio-CARDS, not a bare `<select>`** — each option
  shows label + `$in/$out per MTok` + one-line profile, because a `<select>`
  conceals a 5–25× price differential at the moment of choice. Two surface
  cards (Enrichment: "worker batch jobs"; Guidance: "live trip requests"),
  each with an Active badge.
- **Confirmation modal shows a cost DIFF**, not just "are you sure":
  current model+rates → new model+rates with the multiplier called out
  (~1.6x cost increase), plus the future-calls-only scope sentence. Cancel /
  Confirm, 48px.
- **Compare Lab columns are structured, not blobs**: per-model column with a
  metrics head (dollars big, latency, in/out/thinking tokens, a Fallback
  badge when served≠requested), then sectioned output (Field Craft /
  Similar Species), then an error/abort cell with the visible
  "aborted calls may still incur provider cost" caption.
- **Explicit render states**: empty ledger placeholder ("No AI calls recorded
  yet. Ledger begins on first API call." — no invented date); aborts cost "—"
  never $0.00; refusals "$0.00 (refusal)" + warn badge (genuinely $0, distinct
  from aborts); "Rate unavail" badge for unknown served models; a subtitle
  stating the live poller updates worker state only, Refresh updates the meter.
- **In-flight compare**: single-flight button ("Benchmarking 4 models
  (~14s)…"), skeleton columns with elapsed timer.

## AGY's markup & CSS sketches

The full Svelte sketches (stat tiles + breakdown table; surface cards +
radio-options + confirmation modal with diff-box; compare form with quick-pill
picker + checkbox model set + result columns) and the scoped CSS arrived via
relay 2026-08-26T14:48Z and are the implementation starting point, subject to
the seven corrections above. Key CSS decisions: stat tiles on `var(--bg)`
inside the card; `.model-option` as 48px bordered buttons with
`--accent`/`--accent-soft` selected state; modal reusing the house overlay;
compare columns bordered `var(--danger)` on error with no background tint.
