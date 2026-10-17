-- Operations markers (td-a47c0d slice 1b): facts that happen outside the app
-- but that Admin → Server health shows. 'backup' = the owner's Mac pulled and
-- verified a prod pg_dump; scripts/backup-pg.sh records it over SSH as the
-- postgres superuser, the same way it runs pg_dump. The app only reads: one
-- row per marker, replaced on each success, so nothing here needs pruning.
CREATE TABLE ops_markers (
  name TEXT PRIMARY KEY CHECK (name IN ('backup')),
  at TIMESTAMPTZ NOT NULL,
  bytes BIGINT CHECK (bytes IS NULL OR bytes >= 0)
);
-- 0002's default privileges give birds_app INSERT/UPDATE/DELETE on every new
-- table; take them back so the app cannot fake or erase a backup record.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ops_markers FROM birds_app;
GRANT SELECT ON ops_markers TO birds_app;
