-- Persistent Admin control for the dedicated background worker (td-729717).
-- The request survives worker restarts/deploys; the live worker acknowledges it
-- cooperatively between work units and keeps heartbeating while paused.
ALTER TABLE worker_status
    ADD COLUMN pause_requested BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE worker_status DROP CONSTRAINT worker_status_state_check;
ALTER TABLE worker_status ADD CONSTRAINT worker_status_state_check
    CHECK (state IN ('idle','working','paused','draining'));
