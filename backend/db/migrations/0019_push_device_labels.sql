-- Device list on Settings (Gaylon, 2026-08-16): "2 devices enrolled" should
-- say WHICH devices. The label is derived client-side from the user agent at
-- enrollment ("iPhone · Safari") and sanitized server-side; rows enrolled
-- before this migration stay NULL and display a platform guess from the push
-- service origin until the device re-enrolls (same endpoint → label backfills
-- in place).

BEGIN;

ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS device_label TEXT;

COMMIT;
