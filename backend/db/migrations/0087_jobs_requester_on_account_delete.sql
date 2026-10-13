-- td-12bd33: an admin can delete an account. The finished jobs it requested
-- stay as history (hotspot pages and Hotspots & data read their last runs),
-- with no requester; a pending or running job always keeps its requester, so
-- the worker never runs a job without the account whose eBird key and role it
-- uses. Deleting an account that still has a live job fails on the CHECK below
-- (the delete action cancels pending jobs and refuses running ones first).
--
-- Wrapped in one transaction by migrate_pg.sh; jobs is small (~7k rows on
-- prod). The constraint swap takes ACCESS EXCLUSIVE on jobs while the old
-- worker still runs: a 5 s lock_timeout aborts the whole migration (nothing
-- applied, deploy stops before the PM2 reload) instead of queueing every
-- reader behind a claim transaction (as 0084). Retry the deploy.
SET LOCAL lock_timeout = '5s';
ALTER TABLE jobs ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE jobs ADD CONSTRAINT jobs_live_requester_check
    CHECK (requested_by IS NOT NULL OR status IN ('succeeded', 'failed', 'cancelled'));
ALTER TABLE jobs DROP CONSTRAINT jobs_requested_by_fkey;
ALTER TABLE jobs ADD CONSTRAINT jobs_requested_by_fkey
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL;
