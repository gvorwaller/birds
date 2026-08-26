-- AI foundation: runtime config + usage ledger (td-015838, td-09be7a).
-- Plan: docs/2026-08-26-ai-foundation-model-control-usage-meter-plan.md
--
-- app_config is the schema's FIRST mutable runtime configuration (verified:
-- nothing in 0001-0033 stores config; everything was env-only). Generic
-- key/value on purpose — the model settings are the first consumers, not the
-- last. NO seed rows: an absent key means "use the compiled default", which is
-- deploy-order-independent and keeps exactly one source for each default.
CREATE TABLE app_config (
    key        TEXT PRIMARY KEY,          -- e.g. 'ai.model.enrichment'
    value      JSONB NOT NULL,            -- {"provider":"anthropic","model":"claude-opus-5"}
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- 0002's ALTER DEFAULT PRIVILEGES already gives birds_app full DML here; this
-- GRANT is documentation, not restriction (it does NOT remove the DELETE the
-- defaults granted — harmless on a two-key table, but do not read this line
-- as enforcing anything).
GRANT SELECT, INSERT, UPDATE ON app_config TO birds_app;

-- ai_usage: ONE ROW PER BILLED-OR-EVENT ATTEMPT, not per logical call.
-- Under Opus 5's server-side fallbacks a declined primary can carry BILLED
-- partial output that appears only in usage.iterations — top-level usage
-- covers the served attempt alone. A single row per call silently drops that
-- spend, which is the exact blindness this ledger exists to cure. A plain
-- call writes 1 row; a fallback chain writes 1 row per iteration, grouped by
-- call_id, inserted in ONE statement (a partial chain write cannot be
-- repaired: DELETE is revoked below).
CREATE TABLE ai_usage (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    call_id         UUID NOT NULL,        -- groups the attempts of one API call
    attempt_index   SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_index >= 0),
    attempt_type    TEXT,                 -- 'message' | 'fallback_message' | NULL
    is_final        BOOLEAN NOT NULL DEFAULT TRUE,
                                          -- the attempt that produced the response.
                                          -- "exactly one per call_id" is cross-row and
                                          -- enforced by insertion discipline + test,
                                          -- not by a CHECK.
    provider        TEXT NOT NULL DEFAULT 'anthropic',
    requested_model TEXT NOT NULL,
    served_model    TEXT,                 -- THIS attempt's model. Fallback routing is
                                          -- server-defined: never assume opus-4-8.
    purpose         TEXT NOT NULL,        -- 'enrichment' | 'guidance' | 'compare'
    species_code    TEXT,
    job_id          BIGINT,               -- deliberately NO FK: the ledger is forever
                                          -- and must never block job pruning
    request_id      TEXT,                 -- Anthropic request-id header; captured on
                                          -- ERROR responses too — that is when
                                          -- support asks for it
    http_status     INT,
    provider_error_type TEXT,             -- Anthropic error.type on failures
    input_tokens    INT,                  -- UNCACHED input only (total prompt =
                                          -- input + cache_read + cache writes)
    output_tokens   INT,
    thinking_tokens INT,                  -- BREAKDOWN of output_tokens, NOT additional.
                                          -- Never price it: output_tokens already
                                          -- includes it, and summing both double-bills.
    cache_read_tokens     INT,            -- billed at 0.1x input rate
    cache_write_5m_tokens INT,            -- cache_creation.ephemeral_5m (1.25x input)
    cache_write_1h_tokens INT,            -- cache_creation.ephemeral_1h (2x input) —
                                          -- these two SUM to cache_creation_input_tokens;
                                          -- collapsing them makes history unpriceable
    stop_reason     TEXT,
    duration_ms     INT,
    ok              BOOLEAN NOT NULL,
    billed          BOOLEAN NOT NULL DEFAULT TRUE,
                                          -- REPORTED != CHARGED. Anthropic reports
                                          -- tokens for attempts it does not bill: a
                                          -- pre-output refusal and a declined fallback
                                          -- primary with output 0 both carry usage at
                                          -- $0. Discriminator: an attempt is billed iff
                                          -- it produced output (output_tokens > 0);
                                          -- refusal-with-0-output is an event row.
                                          -- Dollar aggregates sum ONLY billed rows.
    error           TEXT                  -- sanitizeErrorText() output ONLY — never a
                                          -- raw provider payload or fetch headers
);
CREATE INDEX ai_usage_at_idx ON ai_usage (at DESC);
-- Doubles as the call_id lookup:
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_attempt_uq UNIQUE (call_id, attempt_index);

-- APPEND-ONLY REQUIRES REVOKE, NOT GRANT: 0002's default privileges already
-- handed birds_app UPDATE/DELETE at CREATE time, and GRANT never removes.
-- Measured on the test cluster (2026-08-26): after this REVOKE an identity
-- table still accepts INSERT as birds_app (0002's default SEQUENCE privileges
-- survive) and rejects UPDATE and DELETE with permission denied.
REVOKE UPDATE, DELETE ON ai_usage FROM birds_app;
