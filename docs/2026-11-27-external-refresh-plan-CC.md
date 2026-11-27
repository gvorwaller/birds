# External sources: automatic refresh, new-taxon alerts, nominate auto-match (td-9fe839)

Rev 3, 2026-11-27. Rev 1 was reviewed by CODEX1 (`[C-n]` tags) and rev 2 by AGY4 (`[A-n]` tags); both sets of findings are taken in.

## Context

Owner request (2026-11-27):
- Keep the Norway (Artskart) and Sweden (Artportalen) reports current, from the last load through today, without having to remember to reload.
- Be told when a reload brings taxa that need a manual match. He rarely opens Admin now.
- "The app should take the liberty of matching the taxa when the eBird name is 'xxx yyy' and the import name is 'xxx yyy yyy'."

What exists today:
- **Manual reload:** Admin → Sources → **Load a region** → **Queue load**. The region list shows "loaded N ago".
- A load is a **full replace**:
  - newest complete months: 24 for Norway, 12 for Sweden
  - plus Latest reports through today
  - about 4–5 minutes per county
- Every surface reads the published tables, so a finished load updates all of them: Where and when, the near-card, Species, Hotspots & data.
- The reports page shows Reload only after a failed reload.

Prod facts (read-only, 2026-11-27):
- **Loads:** 6 done loads — NO-03 and NO-18 on 10-29, SE-AB and SE-F on 11-20.
- **Unmatched:** `external_unmatched` = 0 rows.
- **Hand matches:** 35 overrides.
  - 18 are nominate trinomials, and **all 18 went to the parent species**.
  - 16 are other trinomials, including *Corvus corone cornix* → Hooded Crow (not the parent).
- **Push:** the admin has 2 push devices (iPhone Safari PWA).
- **Memory:** a Stockholm load peaks at about 89% of PM2 `max_memory_restart`.

## 1. Automatic refresh

**Settings (migration 0104):**
- `external_sources.refresh_days int NULL`. NULL means Off.
- Admin → Sources card: **Refresh loaded regions: Off / Weekly / Every 2 weeks / Monthly**.
- Default for both sources: Weekly. The owner can change it.

**Load origin [C-4]:** `external_loads.origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','auto'))`. Origin is set when the load is created. A collided request keeps the existing load's own origin.

**Recurring job `refresh_external_sources`:**
- It is a system-recurring singleton in birds-worker and runs **hourly**.
- It uses the full recurring wiring [C-2]:
  - the `jobs_type_check` allowlist widened in 0104, keeping every current type
  - `RECURRING_TYPES`
  - dispatch
  - startup and idle reconciliation (`worker/index.ts`)
  - scheduled-job presentation (`job-policy.ts`)
  - `terminalizeAndReschedule`

**What one pass does:** it first runs `expireLeases(c, null)`. Without that, a dead connector's expired automatic lease would block every source until the daily sweep [A-2]. It then queues at most ONE automatic load in the whole app.
- Nothing is queued while any `origin='auto'` load is active, in either source.
- This keeps Norway and Sweden from loading at the same time [C-9]. Their PM2 processes are separate, so a per-connector limit would not prevent that.
- It is also gentle on the providers.
- With about 4–6 regions refreshed weekly, an hourly pass is plenty.

**Which region is due:**
- The source is `active` and has `refresh_days` set.
- The region is `queueable` and has a published `done` load.
- That load's **`retrieved_at`** is older than `refresh_days` [C-3]. `created_at` only fixes the month window.
- AND no `origin='auto'` load for that region was **created** in the last `refresh_days`, whatever its status.
  - This is the cooldown: a failed automatic attempt is not retried until the next interval [C-3].
  - It needs no new state table.
- If several regions are due, the oldest `retrieved_at` goes first.

**Admitting the load [C-2][C-3][C-4]:**
- It runs in ONE claim-fenced transaction (`withClaimTx`) through a new `queueExternalLoadTx(c, …)`. The existing `queueExternalLoad` becomes a wrapper around it.
- Lock order follows `finishLoad`: `external_sources FOR SHARE`, then the source advisory lock, then the region map row `FOR SHARE` [A-5].
  - The advisory lock is taken with `pg_try_advisory_xact_lock`. If a finish holds it, the pass skips to the next candidate (or the next hour) instead of waiting inside the claim.
  - Close (`setRegionOpen`: the region's loads, then the map) never waits on a load row the pass holds, because admission only inserts.
- It then re-checks everything: active, `refresh_days` set, still queueable, the region's current done load is the one selected, no active load, cooldown.
- A closed or disabled region found during this re-check is skipped, and the pass goes on to the next candidate.
- `requested_by` = the current lowest-id admin, looked up fresh each pass. The previous requester is never used.

**Disabling a source** (`active=false`): its queued loads go through the existing path (they are already never claimed or written). The scan skips it. Turning refresh **Off** only stops new automatic loads; one that is already queued or running still finishes.

**Reload loaded regions (N)** (Admin card button, hidden when N = 0) [A-9]:
- It queues a manual-origin load for every loaded, queueable region of that source without an active load.
- It ignores age and the Off/interval setting.
- The connector still runs them one at a time.
- The refresh setting is a `<select>` with its own **Save** button, like the rest of the panel.

## 2. Owner alerts (push) [C-1][C-5][C-6][C-7]

**Event table (0104):** `external_alerts`

| Column | Meaning |
|---|---|
| id | — |
| source_id | — |
| region_code | — |
| kind | `'new_unmatched'` or `'refresh_failed'` |
| load_id | the load that caused it |
| taxa jsonb | `[{id, name, reports}]`, or NULL |
| error | text |
| created_at | — |
| status | `'pending'`, `'sent'`, `'dropped'` (nothing left to say at send time) or `'gave_up'` |
| attempts | — |
| next_attempt_at | — |
| sent_at | — |

Events are created **only for new outcomes**, in the same transaction as the outcome. Historical loads never create events [C-5].

**`new_unmatched`** [C-1]:
- In `finishLoad`, after `lockSourceDerived` and **before** `publish()` deletes anything, read the **source-wide** outstanding unmatched ids (all regions).
- After `publish()`, the new ids = the region's published unmatched ids minus that set.
- If any are new, insert the event in the same transaction. A rollback therefore leaves no event.
- A taxon already outstanding in county A that also appears in county B is not new. Admin groups the list by (source, taxon).
- A taxon that is matched, or that disappeared everywhere, and later comes back unmatched starts a new episode and is alerted again.
- `deriveSpecies` stays side-effect-free. Re-match, saving or removing an override, and manual rebuilds create **no** events: the owner is in Admin when those run, and the list updates live.

**`refresh_failed`:**
- Created when an **`origin='auto'`** load reaches a terminal failure, in the same transaction. That happens in BOTH places [A-1]:
  - `failLoad`: a non-retryable failure, or attempts used up
  - `expireLeases`: attempts used up. An OOM-killed connector never calls `failLoad`.
- Not created for a failure caused by deliberately closing the region (`admin.ts` close path) [C-4].
- Not created for manual loads, whose failure the owner sees in the job chip.

**Sending:**
- The same recurring job delivers pending events every pass. It does this even when refresh is Off, since manual loads also produce `new_unmatched`.
- Recipients are every push subscription of every **current** admin.
- Delivery follows the existing need-alert semantics (`job-handlers.ts` ~969–1009):
  - The event is `sent` once any device accepts.
  - 404/410 subscriptions are pruned.
  - Transient failures retry with backoff (`next_attempt_at`) up to 5 attempts, then `gave_up`.
  - Per-device exactly-once is not promised. After an uncertain send, a device may show the alert twice. This is documented [C-6].
- At send time:
  - `new_unmatched` lists only its still-unmatched taxa. If none are left (the owner already matched them in Admin), it is marked `dropped` without a push [C-5][A-7c].
  - `refresh_failed` is marked `dropped` without a push if the region has a newer `done` load [A-4].
- No subscriptions (or all pruned): the event stays `pending`, with no `attempts` increment and no hourly write [A-6]. Admin shows it.
- `tag` = `ext-<source>-<region>-<kind>`, so Stockholm never hides Jönköping [C-6].

**Text [A-11]:**
- Title "Sweden: 1 new taxon to match" or "Sweden: 3 new taxa to match". Body "Stockholms län: Larus …, Anser … +1 more", with at most 2–3 names.
- Failure: title "Sweden: Stockholms län refresh failed", body "Previous data kept."

**URL [C-7][A-3]:**
- `new_unmatched` → `/admin?tab=sources&unmatched=<source>#source-<source>-unmatched` (same form as `TaxonomyPanel.svelte:488`)
- `refresh_failed` → `/admin?tab=sources#source-<source>`

**In Admin → Sources [A-8][A-9]:**
- An attention line right under the source subtitle, in the `.warn-line` style. It is hidden when there's nothing to report and uses singular/plural ("1 taxon needs a match"). The count links to the Unmatched section.
- A failed automatic refresh shows only while it is newer than the region's published load [A-4].
- A **New** badge on unmatched rows named by events from the last 30 days. Those rows sort first.
- The Loads list shows an **Auto** badge instead of "by Gaylon" for `origin='auto'` loads.

## 3. Nominate auto-match [C-8]

The rule covers "Genus sp sp" (third word = second word) only. *Corvus corone cornix* shows why a general "drop the third word" rule is wrong.

**Exact full-name evidence always wins.** New order in `resolveMatches` (`taxa.ts`):
1. override
2. exact species
3. exact issf/form
4. former full name
5. **nominate fallback**

The nominate fallback applies only when the full trinomial has **no evidence at all**:
- no current species/issf/form row with that name. `loadMatchTaxonomy` reads those three categories, and an issf/form whose `report_as` is invalid counts as evidence [A-7a].
- and no former-name rows

It then looks up "Genus sp" among today's species:
- 1 hit → `{code, method: 'nominate'}`
- 2 or more → `ambiguous`
- 0 → `no_match`

Conflicting or unresolved full-name evidence stays for review.

**Mechanics:**
- `matchExternalTaxa`'s first pass runs with the fallback disabled.
- It fetches former names for the no_match names, as today.
- The second pass enables the fallback, even when it found no former rows.

**Plumbing:**
- 0104 widens 0100's named `match_reason` CHECK to add `'nominate'`, keeping every existing value including `former_name`.
- `TaxonMatch` type, `AdminMatched.method` doc.
- `METHOD` label in `SourcesPanel.svelte`: "matched as its species (nominate subspecies)".
- The `taxa.ts` header comment names the exception.
- Existing overrides stay ("your match").

**Tests:**
- nominate → parent
- two parent hits → ambiguous
- *Corvus corone cornix* stays unmatched
- an override beats it
- an exact issf with a different `report_as` beats it
- an issf with an invalid `report_as` stays unmatched
- a former full name pointing elsewhere wins or is ambiguous, never the guess

## 4. Reports page [C-10]

- "Reports through {date}" comes from the validated `source_snapshot.through` (both connectors write it) and is exposed through `reports.ts`.
  - It goes at the bottom with the Reload button, in `ExternalAttribution`, replacing "retrieved".
  - It never sits beside the complete-months caption, because the monthly counts stop at `window_end` [A-10].
- **Reload {region}** (secondary) shows whenever data is loaded, keeping the `canLoad`, `queueable` and no-active-load gates. It uses the existing `queueExternalLoadAction` (manual origin).
- `page-render.test.ts:117`, which asserts no Reload without a failure, is updated [A-7d].

## 5. Help + Version History [A-12]

**Help `#other-sources`** (user-facing, kept brief):
- reports refresh automatically
- the Reload button
- previous data is kept if a reload fails

**New "Admin: Sources" accordion** at the bottom, beside Admin: Worker control and Admin: Taxonomy refresh:
- the refresh setting
- Reload loaded regions
- owner push alerts and where they open
- the nominate rule

**Version History** goes in `src/routes/about/+page.svelte` [A-7b].

## Files

| File | Change |
|---|---|
| `backend/db/migrations/0104_external_refresh.sql` | `refresh_days`, `origin`, `external_alerts`, `jobs_type_check`, `match_reason` |
| `src/lib/server/external-sources/lifecycle.ts` | `queueExternalLoadTx`, origin, the before/after unmatched diff in finish, the `refresh_failed` event on terminal failure |
| `src/lib/server/external-sources/refresh.ts` (new) | due-region selection, admission, alert delivery |
| `src/lib/server/jobs.ts`, `job-handlers.ts`, `job-policy.ts`, `src/worker/index.ts` | the recurring job |
| `src/lib/server/external-sources/taxa.ts` | the nominate fallback |
| `src/lib/server/external-sources/admin.ts`, `reports.ts` | settings, attention, New badge, `through` |
| `src/routes/admin/+page.server.ts`, `src/lib/components/admin/SourcesPanel.svelte` | setting, reload-all, attention, badge, METHOD label |
| `src/routes/reports/[source]/[region]/+page.svelte` | Reload, Reports through |
| `src/routes/help/+page.svelte`, `src/routes/about/+page.svelte` | Help, Version History |

## Verification [C-9]

**DB tests (birds_test):** fixtures use an owned test source and region, controlled time and a stub push adapter. Never shared SE-F/NO rows, never live SOS/Artskart.
- **Scan:**
  - Only loaded, open, stale regions are queued.
  - Cooldown after an automatic failure.
  - One automatic load app-wide.
  - Raced close/disable is skipped.
  - A manual load finishing between selection and admission → no queue.
  - Boot, lost chain and reclaimed worker.
  - A dead connector's expired auto lease is expired by the pass, not left blocking.
  - Advisory lock busy → skip.
- **Alerts:**
  - An unchanged reload creates no event.
  - A → B is not new.
  - A genuinely new taxon → an event.
  - Rollback leaves no event.
  - Concurrent finishes.
  - Re-match creates no event.
  - Supersession keeps a pending event.
  - Close-induced failure → no event.
  - An auto load used up through `expireLeases` → `refresh_failed`.
  - `refresh_failed` dropped after a newer done load.
  - A partly matched event's push lists only the remaining taxa.
  - Historical loads → none.
  - Delivery: partial device success, 410 prune, retry/backoff, gave_up, already-matched suppression, no subscriptions.
- **Matcher:** the unit tests in §3.

**End to end, locally:** the connector scenario fixture through `dev:test`, then a check that the reports page, the near-card and Admin "loaded …" all move forward.

**On a real device:** iOS push display and a cold click into Admin → Sources.

**Gates:**
- `npm run check`
- the full suite
- CODEX1 code review at **high** effort (migration + concurrency)
- a UI test of Admin → Sources and the reports page in all 5 themes

Deploy only with an explicit owner go.
