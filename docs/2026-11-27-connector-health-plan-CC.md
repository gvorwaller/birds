# Sightings connectors: status in Server health, and alerts when one goes down

**Status:** plan rev 3 (2026-11-27): CODEX1 plan review folded in, tagged [C-n]; AGY4 plan review folded in, tagged [A-n]. td: td-afba28.
**Builds on:** td-9fe839, external refresh and owner alerts (`docs/2026-11-27-external-refresh-plan-CC.md`, deployed 19e8845).

## Goal (owner, 2026-11-27)

> "I'd like to know the status of the collector workers that actually hit the external sources and feed to the birds app. Could go as a section of 'server health' (admin) … I think there already is a warning if those workers are down, but I don't think it's monitored by the app."

The owner agreed to three things:
1. A **Sightings connectors** card in Admin → Server health.
2. The connector badge on the Sources card reflects how recently the connector checked in.
3. The app watches the connectors and sends a push: one when a connector of an active source has been offline more than **15 minutes**, and one when it is **back online**. That is one pair per outage, never repeats.

## What exists today (verified in code)

- **The deploy check.** `scripts/deploy-to-DO.sh` (`connector_state`) checks that both PM2 connector apps are `online` and stay online, but only during a deploy. Nothing checks afterwards.
- **The check-in.** Each connector calls `POST /api/ingest/loads/claim` every 10 s (`CLAIM_EVERY_MS`). During a load it also sends a heartbeat every 60 s (`HEARTBEAT_EVERY_MS`) and sends chunks. Every call goes through `authenticateConnector` (`src/lib/server/external-sources/auth.ts`), which writes `external_connectors.last_seen_at` at most every 5 s.
- **What the admin sees.** The Sources card's **Connector** fold shows "last seen …". Its badge reads **Active** for any connector that has ever been seen, however long ago, so it never shows one that is down.
- **Where the check-in is already used.** The refresh job (td-9fe839) uses it to skip a source with no connector heard from within `CONNECTOR_ALIVE_MINUTES` (5). A source whose connector is down silently gets no automatic loads.
- **No alert exists today.** The only code that sends push is need alerts and td-9fe839's `deliverAlerts`.
- **What the app doesn't know about a connector:** its version, when it started, its memory use, and PM2's restart count. The web app doesn't run PM2 commands, and this plan doesn't add any.
- **A source's on/off switch.** There is no app UI for it; it is changed by SQL only. Nothing records when it last changed.

## What the alerts promise (the contract) [C-1, C-3]

- **What counts as an outage:** a connector of an *eligible* source that has not checked in for more than 15 minutes, **seen to still be going on** by a check pass (every 5 minutes). A gap that ends between two passes is not alerted. You would hear about it only after it was already over.
- **An eligible source:**
  - is active
  - has at least one token that isn't revoked
  - has had at least one check-in on such a token
  - has been in that state for more than 15 minutes.
- **What you're told:** at most one "offline" and one "back online" event per outage. Both are durable rows written once (unique per outage and kind).
- **"Sent"** means at least one of the owner's current devices accepted the push. Another device may still have missed it.
- **Possible repeat:** if the worker dies after a push is accepted but before it records that, the push can be sent once more. This is the same rare duplicate the td-9fe839 Help already describes.
- **No "back online" without an "offline":** you are told "back online" only for an outage whose "offline" was actually sent. If the outage ended first, the pending "offline" is dropped and neither push goes out.
- **Timing:**
  - Typically 15–20 minutes after the last check-in.
  - Later if the worker is busy with a long job, paused, or the push needs a retry.
  - Never, if the server or the birds worker itself is down. The Worker card covers that case, and it is out of scope.

## Design

### 1. Connectors report their version and start time [C-6]

- **Headers.** `IngestClient` (`src/connectors/shared/ingest.ts`) takes `{ version, startedAt }` in its options. It sends them on every call as two headers:
  - `X-Connector-Version`
  - `X-Connector-Started` (ISO format)
- **Start time captured once.** Both `main.ts` files capture the start time **once, at process start, outside the polling loop.** They build `IngestClient` inside the loop (artsobs/main.ts:87, artportalen/main.ts:95), so every poll and retry reports the same timestamp. A restart changes it.
- **Why headers, not the body.** The claim body is checked with `exactKeys`. Headers are invisible to the older parsers, so mixed versions keep claiming in both directions during a deploy:
  - a new connector talking to the old app
  - an old connector talking to the new app (no headers means nothing is stored).
- **Where they're stored.** `authenticateConnector` stores them in new columns `external_connectors.version TEXT` and `started_at TIMESTAMPTZ`. This happens in the same throttled UPDATE that writes `last_seen_at`.
- **Validation:**
  - `version`: `^([0-9a-f]{7,40}|dev)$`
  - `started_at`: must parse, be no more than 5 minutes in the future and no older than 1 year
  - A bad or missing value leaves the stored value **unchanged**, using `COALESCE`, and never refuses the call.
- **How the UI treats them.** Absent metadata shows as "unknown". A mismatch is shown as "last reported version differs from the app's", not as a fact about the running process.

### 2. Pure policy module: `src/lib/connector-health-policy.ts`

- **Constants:**
  - `CONNECTOR_ONLINE_MS = 2 min`. A connector checks in every 10 s while polling and at least every 60 s while loading.
  - `CONNECTOR_OFFLINE_MS = 5 min`. `CONNECTOR_ALIVE_MINUTES` in `external-refresh-policy.ts` is derived from this.
  - `CONNECTOR_ALERT_AFTER_MS = 15 min`.
- **`connectorState(lastSeenAt, now)`** returns `'online' | 'quiet' | 'offline' | 'never'`.
- **`connectorPush(...)`** gives the wording. It is rebuilt at send time and for each device, from live rows:
  - **Offline:** "Sweden connector offline" / "Last heard from 18 min ago. Loads wait until it's back." This is true even when refresh is Off [A-3].
  - **Back online:** "Sweden connector back online" / "It was offline for 42 min." The duration runs from the outage's `last_seen_at` to its **recorded** `closed_at`, not to the send time.
  - **Durations scale [A-3]:** "18 min", "3 h 10 min", "2 d 4 h". A shared pure `spanWords(ms)` is unit-tested.
  - **Tap target:** `/admin?tab=health#sys-connectors` (§6).
  - **Push `tag` [A-3]:** `ext-{source_id}-connector`, shared by both kinds. "Back online" then replaces a stale "offline" banner in Notification Center. `deliverAlerts` builds the tag per kind, so the load alerts keep `ext-{source}-{region}-{kind}` and never contain "null".

### 3. Outages: evidence, detection, recovery [C-1, C-2, C-3]

**Schema (migration 0105):**
- **`external_sources.active_changed_at`:**
  - `TIMESTAMPTZ NOT NULL DEFAULT now()`
  - A `BEFORE UPDATE OF active` trigger sets it to `now()` whenever `active` actually changes. This covers the SQL-only switch, and an old `last_seen_at` can't open an outage right after the source is switched back on.
- **`external_connector_outages`:**
  - `id BIGINT IDENTITY`
  - `source_id` (FK, cascade)
  - `last_seen_at` (the source's newest eligible check-in when the outage was detected)
  - `detected_at`
  - `closed_at`
  - `closed_reason` (`back_online` / `source_off` / `no_token`)
  - `CHECK ((closed_at IS NULL) = (closed_reason IS NULL))`
  - `UNIQUE (id, source_id)` for the composite FK below
  - Partial unique index `(source_id) WHERE closed_at IS NULL`.
- **The source's last check-in** is defined as the newest `last_seen_at` among its **non-revoked** tokens. It is read from that one newest row, together with that row's version and start time.

**Recovery is recorded at check-in, so no sample can miss it:**
- In `authenticateConnector`, when the throttled `last_seen_at` UPDATE wrote a row, a second statement runs:
  `UPDATE external_connector_outages SET closed_at = now(), closed_reason = 'back_online' WHERE source_id = $1 AND closed_at IS NULL`.
- It is an indexed no-op almost always, at most once per 5 s per connector.
- So the "checks in at 12:01 and then stops" case closes the first outage at 12:01. The 12:16+ pass opens a new one. The two outages are never merged.

**Detection (in the 5-minute pass), per source:**
- The candidate list is every **active source plus every source with an open outage**, so a source that was switched off still gets its outage closed.
- For each source, in one transaction:
  1. Take `pg_advisory_xact_lock` on the source.
  2. **Lock that source's non-revoked token rows `FOR UPDATE`.** Auth's `last_seen_at` UPDATE on any of those rows now waits for this transaction. Either the check-in committed first, so detection sees it and opens nothing, or detection commits first. In that case auth's close statement runs after its UPDATE returns, sees the new outage row and closes it. That's why auth runs the close as a separate statement after the UPDATE.
  3. Re-read eligibility and the last check-in.
  4. Decide, in this order:
     - The source is no longer eligible (switched off, no non-revoked token, or no check-in on a non-revoked token) and an outage is open: close it with `source_off` / `no_token`. Nothing is sent, and any pending offline alert is dropped at delivery.
     - The source is eligible, has no open outage, and `now − greatest(last check-in, active_changed_at) > 15 min`: insert an outage and its `connector_offline` alert in the same transaction.
     - **Revoke-and-replace** (old token revoked, new token not seen yet) makes the source ineligible. Any open outage closes quietly, and the new token's first check-in makes it eligible again.
- **Back-online alerts are reconciled every pass, idempotently [C-3]:**
  - Insert a `connector_online` alert (`ON CONFLICT (outage_id, kind) DO NOTHING`) for every outage that is closed `back_online` **and** whose `connector_offline` alert is `sent`.
  - Whichever commits first (the closure at ingest or the send's status write), the next pass after both exist creates the event exactly once.
  - Only outages closed in the last 24 h are considered.

### 4. Alerts: schema and live predicates [C-2, C-5]

**`external_alerts` (migration 0105):**
- `kind` gains `'connector_offline'` and `'connector_online'`. The old check is replaced in **one** `ALTER TABLE … DROP CONSTRAINT IF EXISTS external_alerts_kind_check, ADD CONSTRAINT …` statement.
- `load_id` and `region_code` become nullable. **The plain `UNIQUE (load_id, kind)` stays as it is.** The live writer `lifecycle.ts` targets it with `ON CONFLICT`. With a NULL `load_id`, the connector rows never collide there.
- A new `outage_id BIGINT` column, with:
  - `FOREIGN KEY (outage_id, source_id) REFERENCES external_connector_outages (id, source_id) ON DELETE CASCADE`. A Norway alert can't point at a Sweden outage.
  - `UNIQUE (outage_id, kind)`.
- New checks:
  - `CHECK ((outage_id IS NULL) = (load_id IS NOT NULL))`
  - `CHECK ((load_id IS NULL) = (region_code IS NULL))`
  - `CHECK ((outage_id IS NOT NULL) = (kind IN ('connector_offline','connector_online')))`
- The 0104 `taxa` and `status` checks and every old row stay valid. Old load alerts satisfy every new check.

**`STILL_SAYS` and `messageFor` use one shared live predicate per kind.** That covers selection, the no-device sweep, each device's rebuild, and the locked final disposition, including the last try:
- **`connector_offline`:** the outage is still open, the source is still eligible, and the newest eligible check-in is **not newer than the outage's `last_seen_at`**. A check-in that landed between detection and send makes it false, even before auth's close statement commits.
- **`connector_online`:** all of these hold:
  - the outage is closed `back_online`
  - its offline alert was `sent`
  - no newer outage exists for the source
  - the source is still eligible
  - the newest eligible check-in is within `CONNECTOR_OFFLINE_MS`
  
  So a "back online" isn't sent while the connector has already gone quiet again.
- **Statuses:**
  - `sent`: a device accepted it.
  - `dropped`: nothing left to say.
  - `gave_up`: every try failed; this is terminal, and the UI says so (§6).

**Rollback note:**
- An older worker (0104 code) that sees the new kinds treats `STILL_SAYS` as false and drops them on its no-device sweep or at disposition.
- That only loses notifications. Open outages stay open, and a redeploy carries on.
- If the code were rolled back, the plan accepts that. The migration itself is never rolled back.

### 5. Job cadence: 5-minute health tick, hourly load admission [C-4]

- **Tick.** `REFRESH_TICK_MS` becomes 5 min. Lease expiry, give-up, outage detection, back-online reconciliation and alert delivery run every pass.
- **Load admission keeps the deployed pace.**
  - `queueOneDue` runs only when no automatic load was created app-wide in the last `AUTO_ADMIT_EVERY_MS = 55 min`.
  - The rule is "at most one automatic load started per hour". It is checked inside the same locked admission transaction.
  - This keeps pressure on the providers at today's level: at most about one automatic load an hour, not one every 5 minutes through a backlog.
- **Alert retries keep their hourly base.**
  - `ALERT_RETRY_BASE_MS = 60 min` replaces `REFRESH_TICK_MS` in `alertRetryDelayMs`: 55 / 115 / 235 / 475 min.
  - With 5-minute passes the observed retries land within 5 minutes after each of those. A test asserts the observed `next_attempt_at` and the pass that picks it up.
- **Deploy.** `ensureExternalRefresh` currently returns early when a successor is pending. It will **pull forward** a pending successor whose `next_retry_at` is more than one tick away (`UPDATE … SET next_retry_at = now() + tick, label = …`). The already-scheduled hourly successor therefore doesn't delay the first 5-minute pass by up to an hour. A test seeds an old hourly successor.
- **Labels.** The job label becomes `'every 5 min'`, and the Admin type name "Other sources check (system)".
- **Cost.** 288 job rows a day, kept 90 days, about 26k rows. The need-alert scan writes 96 a day.

### 6. Server health: "Sightings connectors" card [C-6, C-7]

**Server side:**
- `systemHealth()` gains `connectors: HealthCard<ConnectorHealth[]>` (`connectorHealth()`, card deadline) and `appVersion`. The card goes after Worker and Job queue.

**One row per registered source, active sources first:**
- **Status badge** (from `connectorState`; the same words on both tabs [A-4]):
  - Online (ok)
  - Quiet (warn)
  - Offline (error)
  - Never checked in (warn)
  - No token (neutral)
  - Source off (neutral; nothing else shown)
  
  The badge stays one word. The "since …" time goes only on the Outage line.
- **Last check-in.**
- **Doing:**
  - "Waiting for work"
  - "Loading Stockholm: {phase} {done}/{total}, started 3 min ago", from the active load
  - "{n} loads queued"
  - Both together: "Loading Stockholm … · 2 more queued" [A-4].
- **Last load:** "Oslo, done 2 h ago (automatic)" or "Stockholm, failed 1 d ago: …".
- **Refresh** is reported as a fact, not a promise [C-6], and kept to one line [A-4]:
  - "Refresh: Off"
  - or "Refresh: Weekly · oldest Nordland (loaded 6 d ago)"
  
  There are no wait-reason branches. The Sources card and the job queue already show the load state.
- **Process:**
  - "version {v} · up since {t}", from the same newest token row as the last check-in.
  - Missing values show as "unknown".
  - When the version differs, a warn badge reads "Last reported version differs from the app's ({appVersion})".
- **Outage:**
  - "Offline since …", followed by one of:
    - "you were notified"
    - "notification pending"
    - "the notification could not be delivered" (gave_up)
    - "no device to notify"
- **Link:** "Tokens and loads", to the source on the Sources tab.

**Links between the two tabs [A-1]:**
- The admin page reads `?tab=` only once, when it mounts (`+page.svelte:47–50`). Its tab buttons don't change the address.
- So both cross-tab links carry `data-sveltekit-reload`, as the unmatched link already does (`SourcesPanel.svelte:257`):
  - "Tokens and loads" → `/admin?tab=sources#source-{id}`
  - the Sources fold and attention line → `/admin?tab=health#sys-connectors`
- Every follow is then a fresh load that picks the right tab, whatever tab button was clicked before.
- Syncing the tab to the address is left out: it's a wider change to the admin page and not needed here.

**Deep link [C-7]:**
- The card is wrapped in an element with a stable `id="sys-connectors"` that exists before the data arrives.
- When the page opens with `#sys-connectors` in the address, the panel:
  - opens the card, even if it was collapsed before (CollapsibleCard gets an `open` override prop)
  - scrolls it into view once the first reading has rendered.
- The override applies once, on entry. The owner can still collapse the card afterwards, and the remembered collapsed state isn't overwritten until they toggle it [A-4].
- The admin page already picks the tab from `?tab=health`.
- A browser check (Playwright against `dev:test`) covers:
  - opening `/admin?tab=health#sys-connectors` with the card previously collapsed and a delayed `/api/admin/system-health`
  - following the "Tokens and loads" link from the mounted health tab.

### 7. Admin → Sources: badge reflects freshness [C-8]

- **The Connector fold:**
  - Its badge comes from `connectorState` (Online / Quiet / Offline / Never seen / Revoked).
  - Its summary reads "online, last seen 8 s ago".
- **Computed once, labelled.** The state is computed **server-side when the page loads**, never by aging the timestamp in the browser. It is labelled "as of {time}". A long-open tab therefore shows a dated reading, not a polling connector turning "offline".
- **"Last seen" ages against the same reading [A-2].** It is measured against the reading's own `asOf`, as `SystemHealthPanel`'s `relative(iso, h.now)` does, not against `Date.now()`. A re-render on a long-open tab, such as typing in "Find a taxon", can't produce "online, last seen 20 min ago".
- **Live status lives elsewhere.** The fold links to the Server health card, which refreshes every 30 s.
- **Attention line.** A "Connector offline since …" line joins the attention lines at the top of the card while an outage is open. It links to `/admin?tab=health#sys-connectors` [A-5].
- **Tests:**
  - an open-tab render with continuing check-ins (the state stays as read)
  - one with stopped check-ins (the state stays as read until a reload, then shows Offline).

### 8. Help and About

- **Help → Admin: Sources:**
  - the connector status words
  - the 15-minute offline push and the back-online push that follows it
  - an outage that ends between checks is not reported
  - "sent" means one device accepted it
  - nothing is sent if the server itself is down.
- **Help:** a line on the Server health card.
- **About:** a v0.1.6 bullet.

## Files

- **New:**
  - `backend/db/migrations/0105_connector_health.sql`: no-transaction, idempotent, `lock_timeout`, every statement safe while connectors and the 0104 worker are live.
  - `src/lib/connector-health-policy.ts`
- **Connectors:** `src/connectors/shared/ingest.ts`, `artsobs/main.ts`, `artportalen/main.ts`.
- **Server:**
  - `external-sources/auth.ts` (metadata and the recovery close)
  - `external-sources/refresh.ts` (detection, reconciliation, predicates, admission gate)
  - `external-refresh-policy.ts` (tick, retry base, admit interval)
  - `job-handlers.ts` (ensure pull-forward, label)
  - `job-policy.ts` (name)
  - `system-health.ts` (card)
  - `external-sources/admin.ts` (Sources state)
- **UI:** `CollapsibleCard.svelte` (open override), `SystemHealthPanel.svelte`, `SourcesPanel.svelte`, Help, About.

## Tests

- **Pure:**
  - `connectorState` boundaries
  - the push wording, including the duration taken from the recorded `closed_at`
  - `alertRetryDelayMs`.
- **Auth (DB):**
  - Headers are stored, throttled with `last_seen_at`.
  - Bad or missing values keep the stored value, and the call still succeeds.
  - The recovery close runs.
  - Two polls report one stable start time.
- **Connectors:**
  - `IngestClient` sends both headers on every call, including retries.
  - The start time is stable across loop iterations.
- **Outages (DB, owned source and admin, a stub send with a held promise where needed):**
  - Opens only after 15 min, and only for an eligible source.
  - Opens nothing within 15 min of `active_changed_at`.
  - A never-seen or revoke-and-replaced token opens nothing and closes an open outage quietly.
  - Doesn't open twice.
  - **"12:01 check-in then stop"** gives two outages.
  - A gap that ends between passes gives no alert.
  - Recovery during a held offline send:
    - the offline push stays `sent` (it was accepted)
    - the next pass creates exactly one back-online alert, in both commit orders.
  - Recovery before any send: offline is dropped and there is no back-online alert.
  - A check-in after candidate selection but before the first acceptance: dropped.
  - Switch-off while pending: closed quietly, offline dropped.
  - Final retry when no longer true: dropped, not gave_up.
  - No devices: the sweep drops what's no longer true and waits on the rest.
  - A stale back-online (connector quiet again, or a newer outage) is dropped.
  - Simulated claim loss mid-send.
  - Composite FK rejects a cross-source alert. The old load-alert insert still works.
  - Admission gate: a second due region is not admitted within 55 min, and is admitted after.
  - Pull-forward of an old hourly successor.
- **Migration:**
  - re-run on top of itself
  - a partially applied run
  - the old lifecycle insert after the migration
  - grants for the app role (insert, and the sequence).
- **Render:**
  - the Server health card in every state (version mismatch, unknown metadata, loading plus queued, refresh Off and Weekly, gave_up)
  - the Sources badge, its "as of" label, and "last seen" measured against asOf [A-2].
- **Browser:** the deep link, and both cross-tab links after a different tab button was clicked first [A-1] (§6).
- **Gate:** `npm run check`, full suite, build, then a CODEX1 code review, then an AGY4 code review after CODEX1's findings are fixed. Deploy only with the owner's explicit go.

## Code review changes (CODEX1, round 1)

- **[C-r1] Switch off/on.**
  - A second trigger on `external_sources` closes any open outage (`source_off`) whenever `active` changes, so an outage never survives an off/on cycle.
  - `STILL_SAYS` fences both connector kinds to the current activation: offline needs `detected_at >= active_changed_at`, and back-online needs `closed_at >= active_changed_at`.
- **[C-r2] One snapshot for opening an outage.** The outage `INSERT` re-decides silence and switch-on grace itself and copies the check-in it records from the same snapshot.
  - A token added during the check, that checks in before the check commits, leaves a newer check-in. The offline alert then drops and the next pass closes the outage as back online.
  - The two-connection interleaving itself isn't reproduced in a test.
- **[C-r3] Check-in in one transaction.**
  - `recordCheckIn` holds the source `FOR SHARE`, updates the token only while it is unrevoked, and closes the outage in the same transaction. A revoke or switch-off committing after the lookup makes it a no-op.
  - **Kept on purpose:** after revoke-and-replace, a check-in on the new token before the next pass closes the outage as `back_online`. The connector really is back, and the owner who was told "offline" is told "back online".
- **[C-r4] Remaining devices and takeovers.**
  - After the first device accepts, each further device gets a connector-alert send only if the connector facts still hold.
  - `markSent` records acceptance over a concurrent `dropped` or `gave_up`, so the back-online event still follows.
- **[C-r5] The card's work line.**
  - "Doing" lists every leased/staging load. One whose lease has expired shows as "lease expired, awaiting the next check" (round 2: the next pass may fail it rather than requeue it).
  - The empty refresh line reads "no loaded region open for refresh".
- **[C-r6] Wording.**
  - Help says "about one starts an hour at most".
  - "Sent" is worded as "accepted by the push service for at least one admin device" in Help and on the card (round 2).
  - Help says "about one automatic reload is queued an hour at most" (round 2: the gate is on queueing).
- **[C-r7] Tests.** The start-time fixture is relative to the test clock, and a retry-pickup test asserts the 55-minute delay, no pickup on the next pass, and pickup once due.

## Code review changes (CODEX1, round 2)

- **[C-r8] Source row held during the outage check.** `watchConnectors` takes the source row `FOR SHARE SKIP LOCKED` first and holds it to commit.
  - A switch off or on waits for the decision, and its trigger then sees and ends the committed outage.
  - A switch already in progress makes the pass skip that source until the next one.
  - **Test:** a two-connection regression uses the `afterOutageOpened` test hook. The switch is shown to block while the outage is uncommitted, the outage ends as `source_off`, and continued silence past the new grace period gives exactly one new push.

## Code review changes (CODEX1, round 3)

- **[C-r9] Switch stamped at the moment of the change.** The switch trigger stamps `active_changed_at` with `clock_timestamp()`, the moment the row changes, not `now()`, which is when the transaction started.
  - A recovery that another connection committed inside a long switch transaction then dates before the switch, so its back-online event is dropped as belonging to the old activation.
  - **Test:** a two-connection regression. It fails with `now()` and passes with `clock_timestamp()`.

## Code review changes (CODEX1, round 4)

- **[C-r10] Close time from the switch.** The switch's AFTER trigger closes an open outage with `closed_at = NEW.active_changed_at`, the switch's own moment, not the transaction start.
  - An outage the worker opened and committed inside a long switch transaction can then never end before it was detected.
  - **Test:** a two-connection regression. It fails with `now()` and passes with the fix.

## Code review changes (CODEX1, round 5)

- **[C-r11] Check-in close time.** A check-in's outage close uses `clock_timestamp()`. A check-in paused after its source lock, while the worker opens and commits an outage, then never closes it before it was detected.
  - **Test:** a two-connection regression. It pauses `recordCheckIn` after the source lock through a test-only hook, fails with `now()`, and passes with the fix.

## Code review changes (CODEX1, round 6: timestamp sweep)

- **[C-r12] Check-in time read after the lock.** `recordCheckIn` locks the due, unrevoked token row `FOR UPDATE` first, then writes `last_seen_at = clock_timestamp()`. It closes the outage with that same stored value, read back in SQL.
  - A check-in that waited on a load's `FOR SHARE` or on the worker's check can't record a stale time, which would make a real recovery look old and drop its back-online push.
  - **Tests:**
    - A two-connection wait test: the stored check-in is no earlier than the holder's release.
    - The paused check-in test also asserts `detected_at <= last_seen_at <= closed_at`.
- **[C-r13] Event-time history stamps.** These now use `clock_timestamp()`:
  - the outage's `detected_at` and its offline alert's `created_at`, set explicitly
  - the online alert's `created_at`
  - the worker's fallback closes
  - every alert `finished_at` (sent, dropped, gave_up)
  
  Each then records when the event happened, not when its transaction began. `refresh_failed` timing is unchanged.

## Code review changes (CODEX1, round 7)

- **[C-r14] Source row taken `FOR NO KEY UPDATE SKIP LOCKED`.** The worker's outage check now takes the source row this way, not `FOR SHARE`. That conflicts with every check-in's `FOR SHARE`, including one for a token issued after the token scan, so no check-in can be half-written while an outage is decided.
  - The worker skips the source on contention: a check-in, a switch, or a load step holding the row.
  - Check-ins wait only for the short decision. Foreign-key inserts take `FOR KEY SHARE`, which is compatible.
  - **Tests:**
    - The paused-check-in regression now covers both an existing token and a newly issued one, and expects the worker to skip.
    - A separate test asserts that a closing check-in records one moment for `last_seen_at` and `closed_at`.
    - The lock-wait and switch tests synchronize on `pg_blocking_pids`, not timers.
  - **Round 8:** a regression for a token issued after the token scan.
    - Inside `afterOutageOpened`, another connection inserts a new token and starts its check-in. The check-in is shown blocked on the worker's backend.
    - After the commit it closes the outage with `last_seen_at = closed_at >= detected_at`.
    - The comment at the outage INSERT is updated.
