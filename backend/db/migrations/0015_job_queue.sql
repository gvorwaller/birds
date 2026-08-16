-- Background eBird worker job queue (plan: docs/2026-08-15-ebird-worker-job-queue-plan.md).
-- Substrate: durable Postgres queue claimed with FOR UPDATE SKIP LOCKED
-- (madonnahist model); narration: append-only job_events + worker status/history
-- (BTC-dashboard model); plus dedup keys and persisted next_retry_at backoff.
-- Grants: covered by 0002's ALTER DEFAULT PRIVILEGES (birds_owner -> birds_app).

CREATE TABLE IF NOT EXISTS jobs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type          TEXT NOT NULL CHECK (type IN
                    ('load_hotspots','load_region','analyze_counties',
                     'refresh_loc','retry_loc','sync_lifelist','sync_taxonomy')),
    -- NEVER contains credentials/ciphertext — loc codes, names, counts only.
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                    ('pending','running','succeeded','failed','cancelled')),
    dedup_key     TEXT,
    requested_by  INT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    label         TEXT NOT NULL,
    attempts      INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts  INT NOT NULL DEFAULT 4 CHECK (max_attempts >= 1),
    next_retry_at TIMESTAMPTZ,
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    progress      JSONB NOT NULL DEFAULT '{}'::jsonb,
    result        JSONB,
    error         TEXT,
    enqueued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    heartbeat_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (enqueued_at) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedup_active_idx ON jobs (dedup_key)
    WHERE dedup_key IS NOT NULL AND status IN ('pending','running');
CREATE INDEX IF NOT EXISTS jobs_recent_idx ON jobs (enqueued_at DESC);

CREATE TABLE IF NOT EXISTS job_events (
    id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id  BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    action  TEXT NOT NULL CHECK (action IN
              ('enqueued','deduped','claimed','unit_ok','unit_failed','unit_skipped',
               'progress','retry_scheduled','reclaimed','interrupted',
               'completed','failed','cancelled')),
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- PG does not index FKs; the admin event-log expansion queries by job.
CREATE INDEX IF NOT EXISTS job_events_job_at_idx ON job_events (job_id, at);

CREATE TABLE IF NOT EXISTS worker_status (
    id             BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    pid            INT,
    version        TEXT,
    state          TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle','working','draining')),
    current_job_id BIGINT,
    started_at     TIMESTAMPTZ,
    heartbeat_at   TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the singleton so /api/health and the hub never special-case a missing row
-- beyond "worker: never" (heartbeat_at NULL).
INSERT INTO worker_status (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS worker_status_history (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pid            INT,
    version        TEXT,
    state          TEXT NOT NULL,
    current_job_id BIGINT,
    note           TEXT
);
