-- migrate: no-transaction
-- td-afba28: the app watches the sightings connectors. It records what each
-- one reports (version, process start), the outages it sees, and alerts the
-- owner once when a connector goes offline and once when it is back.
-- Plan: docs/2026-11-27-connector-health-plan-CC.md.
--
-- No transaction, like 0104 and for the same reason: connectors keep calling
-- while this runs, so each statement holds its locks only while it runs, and
-- each is idempotent. If one stops (lock_timeout on a busy moment), the deploy
-- stops before reloading anything and running it again finishes the rest.
SET lock_timeout = '15s';

-- What a connector last reported about itself in its request headers
-- (X-Connector-Version, X-Connector-Started), kept when a call carries none.
ALTER TABLE external_connectors
    ADD COLUMN IF NOT EXISTS version TEXT
        CONSTRAINT external_connectors_version_check CHECK (version IS NULL OR version ~ '^([0-9a-f]{7,40}|dev)$'),
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

-- When a source was last switched on or off. The switch is SQL-only, so a
-- trigger (below, after the outages table) keeps this true however it is
-- changed. An outage is never counted from before it (an old last check-in
-- can't raise one the moment a source is switched back on). Existing rows get
-- the migration time.
ALTER TABLE external_sources ADD COLUMN IF NOT EXISTS active_changed_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- A connector outage: a source whose connectors stopped checking in, seen by
-- the worker's check while it was still going on. Closed when a check-in
-- arrives (auth.ts, at that moment), or quietly when the source is switched off
-- or loses every usable token.
CREATE TABLE IF NOT EXISTS external_connector_outages (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_id     TEXT NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
    -- The source's newest check-in (non-revoked tokens) when it was detected.
    last_seen_at  TIMESTAMPTZ NOT NULL,
    detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at     TIMESTAMPTZ,
    closed_reason TEXT CHECK (closed_reason IN ('back_online', 'source_off', 'no_token')),
    CHECK ((closed_at IS NULL) = (closed_reason IS NULL)),
    -- For the alerts' composite foreign key: an alert names its outage's source.
    UNIQUE (id, source_id)
);
-- At most one open outage per source.
CREATE UNIQUE INDEX IF NOT EXISTS external_connector_outages_open_idx
    ON external_connector_outages (source_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS external_connector_outages_source_idx
    ON external_connector_outages (source_id, id DESC);

-- The switch's triggers. Before the row is written: date the change. After:
-- an outage still open from before the switch ends with it ('source_off'), so
-- an off/on cycle never carries an old episode (and its offline alert) into
-- the new activation (CODEX1 td-afba28 code review #1).
CREATE OR REPLACE FUNCTION external_sources_active_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- The moment the row changes, not the transaction's start (now()): a
    -- check-in another connection committed earlier inside a long switch
    -- transaction is then seen as before the switch (CODEX1 round 3).
    IF NEW.active IS DISTINCT FROM OLD.active THEN
        NEW.active_changed_at := clock_timestamp();
    END IF;
    RETURN NEW;
END
$$;
CREATE OR REPLACE TRIGGER external_sources_active_changed
    BEFORE UPDATE OF active ON external_sources
    FOR EACH ROW EXECUTE FUNCTION external_sources_active_changed();
CREATE OR REPLACE FUNCTION external_sources_active_closes_outages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Closed at the switch's own moment, so an outage the worker opened and
    -- committed inside this transaction never ends before it was detected
    -- (CODEX1 round 4).
    IF NEW.active IS DISTINCT FROM OLD.active THEN
        UPDATE external_connector_outages SET closed_at = NEW.active_changed_at, closed_reason = 'source_off'
         WHERE source_id = NEW.id AND closed_at IS NULL;
    END IF;
    RETURN NULL;
END
$$;
CREATE OR REPLACE TRIGGER external_sources_active_closes_outages
    AFTER UPDATE OF active ON external_sources
    FOR EACH ROW EXECUTE FUNCTION external_sources_active_closes_outages();

-- Connector alerts ride the 0104 alert table: they point at an outage, not a
-- load, and name no region. The plain UNIQUE (load_id, kind) the load writer
-- targets stays as it is (NULL load ids never collide). One statement, so the
-- kind check is never missing and every old row is checked once.
ALTER TABLE external_alerts ADD COLUMN IF NOT EXISTS outage_id BIGINT;
ALTER TABLE external_alerts
    ALTER COLUMN load_id DROP NOT NULL,
    ALTER COLUMN region_code DROP NOT NULL,
    DROP CONSTRAINT IF EXISTS external_alerts_kind_check,
    ADD CONSTRAINT external_alerts_kind_check
        CHECK (kind IN ('new_unmatched', 'refresh_failed', 'connector_offline', 'connector_online')),
    DROP CONSTRAINT IF EXISTS external_alerts_outage_fkey,
    ADD CONSTRAINT external_alerts_outage_fkey FOREIGN KEY (outage_id, source_id)
        REFERENCES external_connector_outages (id, source_id) ON DELETE CASCADE,
    DROP CONSTRAINT IF EXISTS external_alerts_target_check,
    ADD CONSTRAINT external_alerts_target_check CHECK ((outage_id IS NULL) = (load_id IS NOT NULL)),
    DROP CONSTRAINT IF EXISTS external_alerts_region_check,
    ADD CONSTRAINT external_alerts_region_check CHECK ((load_id IS NULL) = (region_code IS NULL)),
    DROP CONSTRAINT IF EXISTS external_alerts_outage_kind_check,
    ADD CONSTRAINT external_alerts_outage_kind_check
        CHECK ((outage_id IS NOT NULL) = (kind IN ('connector_offline', 'connector_online'))),
    DROP CONSTRAINT IF EXISTS external_alerts_outage_id_kind_key,
    ADD CONSTRAINT external_alerts_outage_id_kind_key UNIQUE (outage_id, kind);
