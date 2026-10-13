-- Rolls back 0087_jobs_requester_on_account_delete.sql (td-12bd33). Not
-- auto-applied: move it into migrations/ (renumbered to the next free number)
-- in the same commit as the code revert (Settings → User admin "Delete
-- account" and the job listing's LEFT JOIN). History rows left by deleted
-- accounts have no requester to restore, so they are discarded.
DELETE FROM jobs WHERE requested_by IS NULL;
ALTER TABLE jobs DROP CONSTRAINT jobs_requested_by_fkey;
ALTER TABLE jobs ADD CONSTRAINT jobs_requested_by_fkey
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE jobs DROP CONSTRAINT jobs_live_requester_check;
ALTER TABLE jobs ALTER COLUMN requested_by SET NOT NULL;
