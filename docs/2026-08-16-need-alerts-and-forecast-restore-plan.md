# Need alerts (ntfy push) + Forecast location-revert bug — plan

2026-08-16 · **Rev 2** — incorporates CODEX1 plan review (8 findings, #1–#8)
and GROK plan review (§1–§4 + gap list). Gaylon's channel ruling: **ntfy.sh
push** (email/Web Push deferred; adapter stays pluggable).

Two work items, one round: (A) the V2 backlog's need-alert notifications on
the shipped worker/queue; (B) td-671082, Forecast reverting to home after
visiting /admin.

---

## Part A — "Rare bird you NEED was just reported near you" (ntfy push)

### A0. Semantics (v1)

A **need alert** fires when eBird's *notable* feed near a user's home reports
a species NOT on that user's life list — "rare + lifer", the high-signal
case. ("Any lifer nearby" is a later opt-in; it needs the noisier full
recent-obs feed.)

- Source: `notableNearbyObs(apiKey, homeLat, homeLng, radiusKm, back=1)` —
  cache-first (`geonote:*`, OBS_TTL_MIN=30) so scans are polite.
- **Never notify from stale cache (CODEX1 #4):** the cached-fetch result's
  `stale` flag is checked; stale → that user is a `unit_skipped`
  ('stale-cache') and the next scan retries. Handler test required.
- Need = `!seenSet(userId).has(speciesCode)`.
- **Per-user credentials (sacred):** each user's scan uses THEIR API key.
  No key / no home / no topic / disabled → `unit_skipped` with reason.
- Unreviewed/provisional notables included — marked in the TITLE (GROK §2):
  lock screens often show title only, so body-only honesty is not enough.

### A1. Migration 0016

1. `jobs.type` CHECK gains `'scan_need_alerts'` (drop + re-add). The
  `JobType` union, handlers switch, startup ensure, and CHECK all change
  together (GROK gap list).
2. `user_alert_prefs`:
   - `user_id INT PK REFERENCES users(id) ON DELETE CASCADE`
   - `enabled BOOLEAN NOT NULL DEFAULT FALSE`
   - `ntfy_topic_enc TEXT` — encrypted at rest (existing `encryptSecret`).
     A topic name IS the capability to send/read the user's alerts — same
     sacred handling as eBird creds: never in payloads/events/results/
     progress/logs, and never inside error messages or URLs recorded
     anywhere (CODEX1 #4). Topic syntax validated at save:
     `^[A-Za-z0-9_-]{8,64}$` (reject URLs/whitespace/short guessables;
     Settings copy says "treat it like a password — long and random").
   - `radius_km INT NOT NULL DEFAULT 40 CHECK (radius_km BETWEEN 1 AND 50)`
   - `realert_days INT NOT NULL DEFAULT 7 CHECK (realert_days BETWEEN 1 AND 30)`
   - `CHECK (NOT enabled OR ntfy_topic_enc IS NOT NULL)` (CODEX1 #7) — and
     the CRUD action enforces it with a friendly error before the DB does.
   - `created_at/updated_at TIMESTAMPTZ` — `updated_at` SET by every CRUD
     write (no trigger).
3. `need_alerts_sent`:
   - `user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE`
   - `species_code TEXT NOT NULL`, `PRIMARY KEY (user_id, species_code)`
   - `first_loc_id TEXT`, `first_obs_dt TEXT`, `sub_id TEXT` (audit;
     `EbirdObs` gains `subId` — the API returns it), `sent_at TIMESTAMPTZ`
     UPDATEd on re-alert.
   - Dedup rule: once per (user, species) per rolling `realert_days`.
   - **Retention: intentionally permanent** (CODEX1 #7 — the queue's
     pruneHistory does NOT touch this table; one small row per user/species
     is the point: it's the "have I ever pinged you about this bird"
     memory).

### A2. Recurring scan — atomic handoff + reconciliation (CODEX1 #1, #2)

- One global `scan_need_alerts` job, dedup `scan_need_alerts:global`,
  payload `{}`.
- **Ownership:** `requested_by` = the lowest-id admin (Gaylon); the
  successor copies it (GROK gap list). /admin shows that name — true enough
  ("system (Gaylon)" label in displayName for this type). No schema change.
- **Atomic handoff:** a new queue primitive `terminalizeAndReschedule(jobId,
  expectedAttempts, outcome, runAfterMs)` runs ONE transaction: the existing
  CAS terminal UPDATE (succeeded/failed, cancel still honored by the CASE)
  + INSERT of the successor with `next_retry_at = NOW() + interval`
  **+ BOTH audit events in the same transaction** — the terminal event and
  the successor's `enqueued` (details: `scheduled`) event (CODEX1 Rev-2
  addendum #2: the existing record-after-transition pattern would let a
  crash-after-commit leave correct recurrence rows with missing /admin
  history). Rollback/commit tests pin all four writes (two rows, two
  events) together. Because the current row leaves the active state inside
  the same txn, the partial-unique dedup index admits the successor — no
  self-dedup (CODEX1 #1), no crash gap between complete and enqueue. Fired
  only on TERMINAL outcomes; `scheduleRetry` (waiting_retry) does NOT
  reschedule — the retrying row still holds the dedup key (GROK gap list).
- **Reconciliation backstop:** the worker's idle tick (every POLL_IDLE_MS,
  cheap indexed SELECT on the dedup key) ensures an active singleton exists
  and enqueues one if not — repairs a chain lost to ANY cause (successor
  insert raced, admin cancellation, manual DB surgery) without a restart
  (CODEX1 #1).
- **Cancellation:** `requestCancel` returns `'noop'` for `scan_need_alerts`
  (server-side guard) and the hub/admin hide Cancel for it — an admin
  disables alerts via Settings, not by killing the scheduler (CODEX1 #2).
  (Reconciliation would resurrect it anyway; the guard makes intent clear.)
- `enqueueJob` gains optional `runAfterMs` (INSERT-time `next_retry_at`;
  `claimNextJob` already gates). Event details distinguish `scheduled` from
  `waiting_retry` so /admin does not lie (GROK gap list).
- Interval: 30 min = OBS_TTL_MIN; faster is pure waste (GROK §4).

### A3. Scan handler — isolation, delivery semantics, content

**Shape:** one global job, unit = one enabled user (fine at household scale;
per-user child fanout is the documented scale-up path, not v1 — CODEX1 #5):
- Per-user time budget (60 s) — one hung user cannot starve the rest.
- Per-user failures are `unit_failed` and isolated, BUT the aggregate rule
  (CODEX1 #5): if EVERY eligible user failed (0 completed units), the job
  takes the queue's retry schedule (scheduleRetry) instead of completing —
  100% upstream failure must not read as success. The reconciliation tick
  still guarantees a live chain either way.
- Result: `{usersScanned, alertsSent, skipped, failed}` — counts only.

**Delivery semantics — explicit at-least-once (CODEX1 #3):** ntfy has no
idempotency token, so exactly-once is not on offer. Order per species:
send → immediately upsert `need_alerts_sent` (per-species write, not batched
at scan end). The crash window between send and write means a rare duplicate
push after a worker death — accepted and documented; the alternative
(record-first) silently LOSES alerts, which is worse for this feature. A
handler test simulates the window (DB write fails after send → next scan
re-sends → single upsert).

**Per-scan behavior (GROK §2):**
- One push per (user, species) per scan; the CLOSEST qualifying observation
  wins; `and N more` appended when a species shows at multiple locations.
- **Per-scan cap: 5 pushes per user**; the remainder waits for the next
  window (first-enable against a fat notable feed must not fire a dozen
  pushes at once). No daily cap — this is a burst bound, not a quota.
- Title: `Lifer nearby: Snail Kite` / `Lifer nearby: Snail Kite
  (unconfirmed)` when `!obsReviewed || !obsValid`.
- Body: `{locName} · {N} mi from home · {weekday} {time} · {howMany}` —
  "from home" spelled out (a birder mid-field must not read it as
  "from me"). Self-contained: the click URL is a nicety (it opens Safari's
  separate cookie jar, possibly logged out — GROK §1), never load-bearing.
- Click URL: **ABSOLUTE** —
  `https://birds.gaylon.photos/forecast/species?species={code}&region={home state}`
  from a configured canonical origin (ntfy's Click header expects a full
  URL; a notification client has no origin to resolve a bare path against —
  CODEX1 Rev-2 addendum #1). Tests assert both normal and private-location
  variants are absolute, private stays species-only.
- **Private locations (CODEX1 #6):** `locationPrivate` → body is the fixed
  phrase `Private location within your alert radius` — no locName, no
  distance, no locId, no location-bearing click params (species-only URL).
- `sendNtfy(topic, msg, fetcher?)` in `src/lib/server/ntfy.ts`: POST
  `https://ntfy.sh/<encodeURIComponent(topic)>`, Title/Click/Tags headers,
  timeout-bounded, injected fetcher. Errors are typed WITHOUT the URL or
  topic in the message (CODEX1 #4) — the red-team test asserts the literal
  topic string absent from every recorded event/error/result/progress
  value, not just generic credential shapes.

### A4. Settings UI (GROK §1)

"Need alerts" card (non-viewer): enable toggle (rejected with a friendly
error if no topic saved); topic input (write-only like the eBird password —
"saved", replace-not-reveal); radius + re-alert window selects; **Test
notification** button — synchronous, uses the SAVED decrypted topic when the
input is empty, distinct title `Need-alerts test` (never the lifer format).
Copy states the iOS realities: "Sent — if your phone stayed quiet, check
that the ntfy app is subscribed to this exact topic, notifications are
allowed, and Focus isn't silencing ntfy"; quiet hours are your phone's
Focus schedule (server-side quiet hours deferred — no timezone footgun this
round, GROK §4).

### A5. Tests + verification

- Pure `need-alerts-policy.ts`: candidate filtering (need ∩ notable),
  re-alert window math, closest-obs-wins + "and N more", per-scan cap,
  private-location content rule, unconfirmed title rule.
- Adapter: sendNtfy headers/timeout/typed errors (injected fetcher); topic
  validation matrix.
- Handler: happy path; stale-cache skip (CODEX1 #4); per-user failure
  isolation; ALL-failed → retry not success (CODEX1 #5); at-least-once crash
  window (CODEX1 #3); topic red-team; skip reasons.
- Queue: `terminalizeAndReschedule` atomicity (successor exists+gated in the
  same txn; cancel-flag still wins; no successor on waiting_retry);
  `runAfterMs` gating; reconciliation tick enqueues when absent, no-ops when
  active; requestCancel noop for the type.
- DB: prefs CHECKs, sent-table window round-trip.
- Live: real scan on test cluster with a throwaway topic → phone push seen;
  GROK Safari pass on the Settings card.

---

## Part B — td-671082: Forecast reverts to home after visiting /admin

### B0. Symptom + code path

The remembered-search restore in `ForecastTabs.svelte` is a mount-time
`$effect` that `goto()`s the saved search on bare arrivals. Gaylon reports it
fails specifically after /admin → Forecast (nav link). A bare `/forecast`
loader legitimately falls back to saved home — so the "revert" IS a failed
restore, not a second writer (GROK §3).

### B1. Evidence first (cs.md mandate)

Instrument (console only, nothing persisted — CODEX1 #8): navigation
from/to + type, `page.url`, the `params` prop, the localStorage key/value
read, the helper's decision, and goto resolution/rejection REASON.

- **H1 (primary; matches GROK's original #1 finding):** the restore goto
  rejects (superseded) during the still-settling navigation; `.catch` resets
  `lastRestoreCheck` but nothing re-runs the `$effect` (its deps didn't
  change) → bare page stands. Admin-specific = heaviest payload shifting
  timing, not a special URL (GROK §3).
- **H2 (cheap rule-out):** jobsPoll invalidateAll — cannot change the URL;
  log and dismiss.

### B2. Fix direction (confirmed against the repro before committing)

- Extract the restore decision to a PURE helper
  (`src/lib/forecast-restore.ts`): bare-vs-identity detection (identity =
  key PRESENT, so explicit-clear-with-empty-keys wins — test that exact
  case, CODEX1 #8), saved-identity check, month/dist merge.
- Trigger via **`afterNavigate`** (registered synchronously at component
  init; computes from the CURRENT `page.url` inside the callback, never a
  stale prop snapshot — CODEX1 #8). Keep the SAVE `$effect` as-is; only the
  restore moves (GROK §3).
- **Loop guard:** the restore's own goto fires afterNavigate again — the
  helper no-ops when identity keys are present; test the no-loop property
  (single replaceState, one extra afterNavigate, then quiescent).
- **Same-tick trap (GROK §3):** goto inside afterNavigate on the same tick
  is flaky — queue via `queueMicrotask`/rAF, and keep the rejection
  instrumentation to verify.
- Pure tests CANNOT prove the lifecycle race — a browser-level regression
  (GROK charter below) is part of done (CODEX1 #8).
- If the repro contradicts H1, follow the evidence; the helper extraction
  stands regardless.

### B3. GROK Safari charter (390px + desktop, marcus + family)

1. Baseline: set St. Petersburg → restore works from /forecast/data.
2. Cold /admin (wait for full 50-job paint) → Forecast NAV LINK (not Back) —
   instrument afterNavigate from/to, helper decision, goto outcome.
3. Same from /forecast/data (lighter page) — is admin unique or just slower?
4. Species-tab restore after /admin (`/forecast/species?…` remembered).
5. Month click on a restored page — month merges, place stays.
6. Explicit clear stays cleared across /admin → Forecast.
7. Per-user keys: marcus vs family, no leak.
8. Back-from-admin is NOT the bug path (history keeps the place) — nav link.
9. No restore loop: single replaceState, then quiescent.

---

## Delivery

One round: migration 0016 → queue primitives → policy/adapter/handler +
Settings card (Part A) alongside B1 repro → B2 fix; gates (check 0/0,
vitest, build); CODEX review → incorporate → GROK review incl. Safari
charters → incorporate → **stop and report to Gaylon before any
push/deploy**.

## Do NOT

Store or emit ntfy topics anywhere but encrypted-at-rest (including error
messages and URLs); notify from stale cache; put species lists in
events/results; add admin-credential fallbacks; add any daily cap (the
per-scan burst cap is not a quota); reschedule from waiting_retry; let the
recurring singleton be cancellable; regress the atomic-cancel/typed-error
invariants (memory: birds-app-v2-decisions).
