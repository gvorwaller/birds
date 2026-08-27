-- Public trip share links (td-8b959f follow-up): one unguessable, revocable
-- URL per trip so a field sheet can be sent to someone without a login.
-- Revoked rows are kept as history; token generation is
-- randomBytes(32).toString('base64url') (session.ts precedent).
CREATE TABLE trip_shares (
    token      TEXT PRIMARY KEY,
    trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ            -- NULL = active
);
-- Single ACTIVE share per trip, enforced by the DB, not app discipline.
CREATE UNIQUE INDEX trip_shares_active_uq ON trip_shares (trip_id)
    WHERE revoked_at IS NULL;
-- 0002's ALTER DEFAULT PRIVILEGES already grants birds_app DML here (same
-- note as 0034): no GRANT needed, and none of it is restrictive.
