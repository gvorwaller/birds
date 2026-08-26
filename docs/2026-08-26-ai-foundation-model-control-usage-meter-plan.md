# AI foundation: model control + usage meter — plan (td-015838, td-09be7a)

**Date:** 2026-08-26
**Status:** Reviewed (internal critique + CODEX1 adversarial, all findings folded) — awaiting owner go to implement
**td:** `td-015838` (model dropdown) + `td-09be7a` (usage/cost meter) — one shared foundation
**Reviews:** internal Plan-agent critique folded in (two real counting bugs:
per-outcome recording undercounting the retry loop up to 3x; the failure-path
envelope discarded exactly where the meter's diagnostic payoff lives). CODEX1
adversarial review folded in (2 P0 + 5 P1, all verified — see the marked
sections; verdict was BLOCKED until these revisions, now applied). CODEX1 also
independently confirmed: the per-model shape claims, structured-outputs support
on all four dropdown models, the per-annotate metering seam, migration safety
while the worker drains, and that the COMPARE RUNNER STAYS IN V1 — the td's
acceptance criterion is sample output, and dropdowns+meter alone do not satisfy
it.


## Context

Yesterday's enrichment backfill cost ~$74 against an expected ~$50/**year**
steady state, and the only way to know was reconstructing it from job counts
after the fact. Regions keep expanding and more AI surfaces are coming, so this
is **foundation work, not two widgets**: a persisted app-config mechanism, a
per-model request registry, a metering chokepoint, and an append-only usage
ledger — with the model dropdowns and the admin meter tab as first consumers.

Decisions made with Gaylon (2026-08-26):
- **Anthropic-only, provider-ready** — dropdown lists Claude models; schema,
  registry and ledger carry `provider` so Gemini slots in later w/o migration.
- **Per-surface settings** — `ai.model.enrichment` and `ai.model.guidance`.
- **Future calls only** — switching never regenerates the corpus (full pass ≈
  $50); per-row provenance already exists (`ai_model`/`similar_model`).
- **Store tokens, compute dollars at render** — with effective-dated rates
  (see Pricing), so rate changes never corrupt history.

## Verified ground truth (explores, 2026-08-26)

- **Two AI call sites, different processes, no shared chokepoint today.**
  `generateSpeciesAnnotation` runs ONLY in the worker — one importer
  (`job-handlers.ts:90`), one call site (the `annotate()` closure ~:1354)
  reached from three `runAiStage` branches. The Refresh page action never calls
  it; it enqueues an `aiOnly` job. `generateFieldTips` runs ONLY in the web
  process (trips `field_tips` action) — Sonnet 4.6 hardcoded separately, no
  fetcher injection, no structured outputs.
- **No config storage exists anywhere** (full migration inventory 0001–0033);
  all runtime config is env-only. This is the schema's first.
- **No worker push channel exists** (no LISTEN/NOTIFY; jobs polling every 2s is
  the only mechanism) → the worker re-reads the model setting per AI call — a
  PK lookup on a tiny table, consistent with the poll-and-reconcile house style.
- **Admin page has no tabs**; the pattern to copy is the `.seg` tablist in
  `life/+page.svelte:345-360` (role="tablist", aria-selected, 48px, CSS
  :622-642). Existing admin cards sit unchanged inside a Status panel.
- **The retry loop calls the API up to 3× per species**
  (`SIMILAR_EMPTY_RETRIES`), and the `nothingToDo` fresh-skip calls it 0×.
  Therefore usage recording MUST be per API call, never per outcome.
- **nginx `proxy_read_timeout 60s`** (`deploy/nginx.conf:13`) bounds any web
  action — sequential multi-model compare calls will 504 while still billing.

## BTC-dashboard reference — copy the shape, fix the defects

Copy: the uniform response envelope (content + provider + model + usage +
latency), echoing served model back with every result, non-fatal init when a
provider key is missing. Fix (live defects there): catalog duplicated 4× with
unused discovery endpoints → ONE server registry, admin UI gets the list from
loader data; choice persisted only as a side effect of response caching →
durable `app_config`; no server-side model allowlist → validate against the
registry; inconsistent per-adapter max_tokens → per-model builder owns params;
usage returned but never priced → the ledger.
*(Separately flagged: BTC-dashboard has a plaintext OpenAI key in git history —
`backend/db/migrations/old/2025-09-04-001...sql` — rotate it at OpenAI.)*

## Architecture

```
app_config (DB) ──► ai-call.ts (chokepoint) ──► ai-models.ts (registry)
                       │    resolve model per call        buildRequest per model
                       │    time + record EVERY call      extractEnvelope
                       ▼
                    ai_usage (ledger, append-only by GRANT)
Consumers: worker annotate() closure · trips guidance action · admin compare
```

**Why a chokepoint instead of caller-side recording (critique verdicts 1–2,
both were real bugs in the draft):**
- *Undercount:* the retry loop makes up to 3 billed calls per species;
  outcome-level recording writes 1 row. The meter exists because of a $74
  surprise; a silent up-to-3× undercount on retry-heavy species is the same
  disease.
- *The kitmur diagnostic didn't work as drafted:* a max_tokens truncation is a
  200 whose `usage` and `stop_reason:'max_tokens'` are in hand when
  `parseAnnotation` throws — riding usage only on the success return discards
  exactly the failure row the meter exists to capture. Fix: the envelope is
  extracted before parsing and **attached to `EnrichmentAiError`** on every
  post-200 throw; the chokepoint records from success or from the error.

## Schema — migration `0034_ai_config_usage.sql`

House-style header comment; **no seed rows** (absent key ⇒ compiled default).

```sql
CREATE TABLE app_config (
  key        TEXT PRIMARY KEY,          -- 'ai.model.enrichment' | 'ai.model.guidance'
  value      JSONB NOT NULL,            -- {"provider":"anthropic","model":"claude-opus-5"}
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ONE ROW PER BILLED ATTEMPT, not per logical call (CODEX1 P0-2). Under Opus
-- 5's fallbacks, a declined primary can produce BILLED partial output that
-- appears only in usage.iterations — top-level usage covers the final served
-- attempt alone. A single row per call silently drops that spend, which is the
-- exact disease this ledger exists to cure. A call with no fallback = 1 row;
-- a fallback chain = 1 row per iteration, grouped by call_id.
CREATE TABLE ai_usage (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  call_id         UUID NOT NULL,        -- groups the attempts of one API call
  attempt_index   SMALLINT NOT NULL DEFAULT 0,
  attempt_type    TEXT,                 -- 'message' | 'fallback_message' | null (no iterations)
  is_final        BOOLEAN NOT NULL DEFAULT TRUE,  -- the attempt that produced the response
  provider        TEXT NOT NULL DEFAULT 'anthropic',
  requested_model TEXT NOT NULL,
  served_model    TEXT,                 -- this ATTEMPT's model (fallback ≠ requested;
                                        -- routing is server-defined — never assume opus-4-8)
  purpose         TEXT NOT NULL,        -- 'enrichment' | 'guidance' | 'compare'
  species_code    TEXT,
  job_id          BIGINT,               -- no FK: ledger must never block job pruning
  request_id      TEXT,                 -- Anthropic request-id header; captured on
                                        -- ERROR responses too — that is when support wants it
  http_status     INT,                  -- non-2xx diagnosis (CODEX1 P1-3)
  provider_error_type TEXT,             -- Anthropic error.type on failures
  input_tokens    INT, output_tokens INT,
  thinking_tokens INT,                  -- BREAKDOWN of output_tokens, not additional.
                                        -- Pricing uses output_tokens alone; summing both
                                        -- double-bills. Comment this ON THE COLUMN.
  cache_read_tokens INT,
  cache_write_5m_tokens INT,            -- cache_creation.ephemeral_5m_input_tokens (1.25x)
  cache_write_1h_tokens INT,            -- cache_creation.ephemeral_1h_input_tokens (2x)
                                        -- collapsing these makes history unpriceable the
                                        -- day 1h caching appears (CODEX1 P1-6)
  stop_reason     TEXT, duration_ms INT,
  ok              BOOLEAN NOT NULL,
  error           TEXT                  -- sanitizeErrorText() output ONLY
);
CREATE INDEX ai_usage_at_idx ON ai_usage (at DESC);
-- The unique index doubles as the call_id lookup (CODEX1 unblock note):
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_attempt_uq UNIQUE (call_id, attempt_index);
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_attempt_ck CHECK (attempt_index >= 0);
-- "Exactly one is_final=true per call_id" is cross-row and stays a TESTED
-- insertion-discipline invariant, not a CHECK — enforce in the fallback test.

-- APPEND-ONLY REQUIRES REVOKE, NOT GRANT (CODEX1 P0-1). Migration 0002's
-- ALTER DEFAULT PRIVILEGES already hands birds_app SELECT/INSERT/UPDATE/DELETE
-- on every birds_owner-created table at CREATE time, and GRANT never removes
-- privileges — so the draft's "GRANT SELECT, INSERT" enforced nothing. The
-- claim "append-only by role" is only true after:
REVOKE UPDATE, DELETE ON ai_usage FROM birds_app;
-- app_config keeps the default SELECT/INSERT/UPDATE (no DELETE needed but
-- harmless); made explicit for the reader:
GRANT SELECT, INSERT, UPDATE ON app_config TO birds_app;
```

Migration is additive and safe to apply while the worker is mid-drain.

## Server modules (new)

**`src/lib/server/ai-models.ts`** — the registry. Pure: no `$env`, no DB.

```ts
interface AiCallParts {
  system: string; user: string;
  schema?: Record<string, unknown>;   // output_config.format json_schema
  maxOutputTokens: number;            // the ANSWER budget, thinking-exclusive
  effort?: 'low'|'medium'|'high';     // registry clamps or DROPS per model
}
interface BuiltRequest {
  headers: Record<string,string>;     // beta headers ONLY — NEVER auth
  body: Record<string, unknown>;
}
interface ModelEntry {
  id: string; provider: 'anthropic'; label: string;
  pricing: PricingWindow[];           // effective-dated; incl. cacheRead/WritePerMTok
  buildRequest(parts: AiCallParts): BuiltRequest;
}
resolveModel(configValue): ModelEntry  // unknown/removed id → compiled default + warn
extractEnvelope(data): CallEnvelope[]  // ONE PER ATTEMPT: reads usage.iterations
                                       // when present (fallbacks), else one entry
                                       // from top-level usage; each carries model,
                                       // stopReason, all token fields incl. the
                                       // 5m/1h cache-write split
```

Entries: `claude-opus-5` (adaptive thinking, effort through, `fallbacks:
'default'` + `server-side-fallback-2026-07-01` header, max_tokens = answer
budget + thinking headroom) · `claude-sonnet-5` (adaptive default, headroom,
no fallbacks) · `claude-sonnet-4-6` (NO thinking field, no fallbacks,
max_tokens = answer budget) · `claude-haiku-4-5` (no thinking, **drop effort
entirely** — 400s) · `claude-opus-4-8` **pricing-only** (it is where Opus 5
fallbacks route; the meter must price it, "rate unavailable" for anything else,
never NaN).

Pricing windows: Sonnet 5 intro $2/$10 through 2026-08-31 then $3/$15 — matched
against `ai_usage.at` at render. Cost math uses **served_model** and
`output_tokens` (thinking shown as breakdown only).

**Structural key-leak guarantee** (claimable because tested): `buildRequest`
never sees the API key; the chokepoint merges `x-api-key`/`anthropic-version`
at fetch time. Registry output is snapshot-testable and cannot leak the key.

**`src/lib/server/app-config.ts`** — `getConfig(key, fallback)` catches DB
errors → returns fallback + `console.error` (a config blip must leave the AI
stage no worse off than today, never burning a species' 7-day window).
`setConfig` validates model ids against the registry, rejects unknowns.

**`src/lib/server/ai-usage.ts`** — `recordUsage(row)` never throws (metering
failure must not fail the metered call — exercised in tests by a rejecting
mock); sanitizes `error` via existing `sanitizeErrorText`. Aggregates: totals
today/7d/30d/all; by served_model × purpose with dollars; recent 50 calls;
error/stop_reason counts. **Compare rows are included in totals** and broken
out by purpose — excluding real spend recreates the blind spot.

**`src/lib/server/ai-call.ts`** — the chokepoint:
`meteredAiCall({purpose, configKey, speciesCode?, jobId?, modelOverride?,
timeoutMs?, run})` → resolve model per call → time → record **one row per
billed attempt** (a fallback chain writes one row per `usage.iterations` entry,
shared `call_id`; a plain call writes one) → return an **attempt object**
`{result, requestedModel, servedModel, envelope}` / rethrow. All three
consumers go through it.

- **Provenance travels with the attempt (CODEX1 P1-4).** The retry loop's
  keep-best logic swaps whole attempt objects atomically, and `upsertAiData`
  stamps the KEPT attempt's `servedModel` — never "the model most recently
  resolved", which can differ when config changes between retries or a
  fallback serves the response.
- **One error contract for every consumer (CODEX1 P1-3).** A shared
  `AiCallEnvelope` is populated the moment headers/body are available —
  request-id, http_status, provider `error.type`, tokens, stop_reason — and
  attached to BOTH `EnrichmentAiError` and `GuidanceError` on every throw:
  post-200 parse failures AND non-2xx responses. The draft only enveloped
  enrichment's post-200 path; guidance's refusal/malformed-200 throws and both
  modules' HTTP-error paths discarded exactly the request-id that support asks
  for on failures.

## Server modules (changed)

**`ai-enrichment.ts`** — `generateSpeciesAnnotation(input, model: ModelEntry,
fetcher?)`; inline request body replaced by `model.buildRequest({system: SYSTEM,
user: buildUserPrompt(input), schema: buildOutputSchema(...), maxOutputTokens:
~2000, effort: 'medium'})`; returns `{annotation, envelope}`;
`EnrichmentAiError` gains optional `envelope`, populated on every post-200
throw (refusal, unreadable JSON, tide contradiction, empty field craft).
Prompt/schema/validators untouched; module stays DB-free; existing
mocked-fetcher tests stay green. `AI_MODEL` becomes the compiled default.

**`job-handlers.ts`** — only the `annotate()` closure changes: it becomes a
`meteredAiCall` invocation (`purpose:'enrichment'`, `speciesCode`, `jobId`).
`upsertAiData`'s `model:` stamp uses the model actually resolved, not the
constant. Retry loop and all three `runAiStage` sites untouched.

**`ai-guidance.ts`** — model from config (`ai.model.guidance`, default
`claude-sonnet-4-6`) via registry; call through `meteredAiCall`
(`purpose:'guidance'`). **No structured outputs in v1** (its array-root JSON
works; converting is a behavior change with its own test burden — cut).
`GuidanceError`'s message/UX contract is unchanged, but it **gains the shared
envelope field** (CODEX1 P1-3): today its refusal and malformed-200 throws at
ai-guidance.ts:100-119 discard model/usage/stop_reason — the same bug already
fixed on the enrichment side, in the module the draft left untouched.

## Admin UI

**`admin/+page.server.ts`** — loader adds registry list + current config +
meter aggregates. New actions `set_ai_model` (admin re-check, registry
validation) and `run_compare`. **Every action — including the existing
`nudge_enrichment` — returns a `kind` discriminant**, and every render site
checks it: SvelteKit has one `ActionData` slot, and without this a compare
result renders under the nudge button (a change to existing markup the draft
missed).

**`admin/+page.svelte`** — `.seg` tablist (Status | AI); existing cards move
unchanged into the Status panel; nudge feedback re-keyed on
`form.kind === 'nudge'`; the live status poller is untouched and never paused
(worker state is why the admin is on this page). Tab choice is local `$state`.

AI tab: two dropdowns with **modal confirmation** on change (cs.md: no
toasts); the meter (totals, $ by served_model × purpose, recent calls,
error/stop_reason breakdown, and an explicit "ledger starts <date>" note so
yesterday's $74 not appearing is understood); the compare runner.

**Compare runner** (STAYS IN V1 — CODEX1 adjudicated: td-015838's acceptance
criterion is "show sample output", and dropdowns+meter alone do not satisfy
it): dry-runs the real annotation for dowwoo (via `aiStageInputFor` +
`similarCandidatesFor` — plain DB reads, already importable web-side) across
selected models, `purpose:'compare'`, never persisted to species tables.

Timeout must be REAL, not a race (CODEX1 P1-5): a `Promise.race` returns while
the fetch keeps running and billing, so the 45s "cap" in the draft was not
implementable and could create unmetered spend. Instead:
- `meteredAiCall` accepts `timeoutMs`, threaded as an actual `AbortSignal`
  into the provider fetch (compare uses ~45s; enrichment keeps 120s).
- `Promise.all` across selected models; per-model aborts render as failed
  cells. **Disclosed in Help: an aborted call may still incur provider cost
  that the ledger cannot see** — the row records the abort (`ok=false`,
  `error='aborted at 45s'`, tokens NULL); it is an event record there, not a
  cost receipt. This is the honest version of the draft's "rows are the
  receipt" claim, which was wrong for aborts.
- **Single-flight enforced server-side** (module-level in-flight guard in the
  action), not just a disabled button; a duplicate submit returns the
  in-progress state. **Scope: valid ONLY under the current single-web-process
  deployment** (PM2 fork, 1 instance) — not globally durable. If the app ever
  runs multiple web processes, move the guard to a DB advisory lock or a
  queued job (CODEX1).
- Checkbox set drawn from the registry only. Label results task-level
  apples-to-apples (same prompt/schema/answer budget) — request params
  deliberately differ per model; do not claim parameter-level parity.
- nginx context: 60s `proxy_read_timeout`; parallel worst-case ≈ one call.

**Help + About** (cs.md, same change): future-calls-only semantics; what the
meter counts (compare spend is real and included; fallback-served calls may
show a different model than requested; ledger starts at deploy).

## Implementation order

1. Migration 0034
2. `ai-models.ts` + tests (the lesson-encoding snapshots)
3. `app-config.ts` + `ai-usage.ts` + tests
4. `ai-call.ts` + tests
5. Enrichment rewire (`ai-enrichment.ts` + the `annotate()` closure)
6. Guidance rewire
7. Admin UI (tablist, dropdowns, meter; compare last) + Help/About

## Verification

- **NEW `ai-models.test.ts`** (pure): opus-5 body has adaptive thinking +
  fallbacks + the `-2026-07-01` beta header; sonnet-4-6 body has **no
  `thinking` key and no beta header**; haiku body has **no `effort` key**;
  every entry's headers **do not contain `x-api-key`** (the leak guarantee,
  tested as the property it is); max_tokens headroom differs opus vs 4-6;
  `resolveModel('nonexistent')` → compiled default; Sonnet 5 pricing returns
  intro vs post-intro rate by date; `extractEnvelope` reads
  `output_tokens_details.thinking_tokens` and `response.model`.
- **EXTEND `ai-enrichment.test.ts`**: envelope on success; **max_tokens
  truncation attaches envelope with stop_reason to the thrown error** (the
  kitmur test, exercising what it is named for); refusal likewise; served ≠
  requested model propagates.
- **NEW `ai-call.test.ts`**: one row per call on success and failure (with
  stop_reason on the failure); recordUsage rejection does not fail the call
  (mock actually rejects); config-read rejection falls back to the compiled
  default and proceeds.
- **EXTEND `job-handlers.test.ts`**: retry loop → **3 calls = 3 usage rows**
  (the undercount regression); `nothingToDo` skip = 0 rows; mid-chunk config
  change → per-row model stamps differ correctly.
- **DB-backed**: app_config round-trip; setConfig rejects unknown ids;
  aggregates over seeded rows incl. a compare row (in totals AND purpose
  breakdown) and an unknown served model ("rate unavailable", not NaN).
- **NEW `admin` actions test**: non-admin → 403 on both actions; unknown model
  rejected; every action result carries `kind` (pins the form-slot fix,
  including nudge).
- **DB-backed grants test (CODEX1 P0-1)**: as `birds_app`, INSERT into
  ai_usage succeeds and UPDATE/DELETE **fail** — the append-only claim is
  tested, not asserted. (The draft's GRANT enforced nothing: 0002's default
  privileges already include UPDATE/DELETE and GRANT never removes.)
- **Fallback attempt test (CODEX1 P0-2)**: a mocked two-attempt fallback
  response (declining primary WITH nonzero billed output in
  `usage.iterations`, fallback serving) writes two rows sharing `call_id`,
  prices each attempt by its own served model, the meter's total includes the
  declined attempt's spend, and **exactly one row has `is_final=true`** (the
  cross-row invariant a CHECK cannot express — tested insertion discipline).
- **Retry provenance tests (CODEX1 P1-4)**: attempt A kept after a worse B →
  stamped model is A's; better B replaces A → B's; fallback-served attempt →
  stamp is the served model, not the requested one.
- **Guidance integration tests (CODEX1 P1-7 — no guidance test file exists
  today, so generic ai-call tests can pass while guidance bypasses metering)**:
  success, malformed-200, refusal, and non-2xx each write exactly one ledger
  row with envelope fields (request_id, http_status, provider_error_type on
  the failure paths).
- **Compare action tests**: parallel result isolation; abort writes an
  `ok=false` row with NULL tokens; duplicate submit is rejected server-side.
- **Mixed cache pricing test (CODEX1 P1-6)**: seeded rows with 5m and 1h
  cache-write tokens price at 1.25x and 2x respectively.
- **Live smoke**: one compare across all four models (doubles as the Haiku
  structured-outputs confirmation and the only real-400 test).
- **Manual on prod**: switch enrichment to Sonnet 4.6 → Refresh one species →
  ai_usage row shows requested+served model and the species row's `ai_model`
  matches → switch back. Meter renders.
- `npm run check` 0 errors; `npm run build`; full `npm test` (1 pre-existing
  failure expected). Mobile: 48px targets, no horizontal scroll <640px.
