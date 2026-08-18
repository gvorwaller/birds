-- 0022: 'yielded' job event (Hotspot Workspace Phase 2, CODEX1 P1 on 2171eb7).
-- A frequency job that hits its BATCH_TIME_BUDGET_MS chunk boundary goes back
-- to pending with enqueued_at reset (queue fairness: jobs that arrived during
-- the chunk claim first) and records this event with the chunk summary.
-- The CHECK is name-stable (added by 0015; pattern per 0016/0020).

ALTER TABLE job_events DROP CONSTRAINT job_events_action_check;
ALTER TABLE job_events ADD CONSTRAINT job_events_action_check CHECK (action IN
    ('enqueued','deduped','claimed','unit_ok','unit_failed','unit_skipped',
     'progress','retry_scheduled','reclaimed','interrupted','yielded',
     'completed','failed','cancelled'));
