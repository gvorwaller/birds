-- A final worker sample records a clean drain. Abrupt exits deliberately leave
-- these fields NULL so the admin UI reports the end reason as unknown rather
-- than inventing a cause from the last observed RSS value.
ALTER TABLE process_memory_samples
  ADD COLUMN ended_at TIMESTAMPTZ,
  ADD COLUMN end_reason TEXT CHECK (end_reason IN ('graceful shutdown'));
