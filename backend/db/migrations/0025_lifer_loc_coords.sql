-- 0025: user-scoped coordinates for personal life-list locations (td-2fbfc1).
--
-- Owner-derived pins (from authenticated checklist HTML) must never write
-- the communal ebird_locations table — hotspotPlace reads it by bare loc_id
-- with no user filter, so personal coords there would leak. This table
-- scopes them to the owner. The /life loader COALESCEs from both tables.
--
-- Also: add reason to lifer_loc_attempts (invalidate legacy rows that were
-- written by the old resolver before the owner-HTML path existed), and add
-- loc_resolution_status/error to user_ebird for honest /life disclosure
-- (the CSV import sets life_list_status='ok' before resolution runs, so a
-- resolver failure must not taint the import status — CC1 pin D).

CREATE TABLE lifer_loc_coords (
    user_id          integer     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_loc_id    text        NOT NULL,
    canonical_loc_id text,
    lat              float8      NOT NULL,
    lng              float8      NOT NULL,
    loc_name         text,
    source_sub_id    text        NOT NULL,
    provenance       text        NOT NULL DEFAULT 'checklist_owner',
    fetched_at       timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, source_loc_id)
);

-- Loc resolution status: separate from life_list_status (which tracks the
-- CSV import). Values: 'ok' | 'capped' | 'stopped' | 'error'.
ALTER TABLE user_ebird
    ADD COLUMN loc_resolution_status text,
    ADD COLUMN loc_resolution_error  text;

-- Reason column for lifer_loc_attempts. Nullable at first; candidate SQL
-- treats NULL and 'legacy_untrusted' as unattempted (distrust, not trust).
ALTER TABLE lifer_loc_attempts ADD COLUMN reason text;

-- Invalidate existing reason-less rows: they were written by the old
-- resolver which had no owner-HTML path. Mark them so the new resolver
-- retries with the owner fallback. No user-id literals.
UPDATE lifer_loc_attempts SET reason = 'legacy_untrusted' WHERE reason IS NULL;

-- Default privileges for the app role.
GRANT SELECT, INSERT, UPDATE, DELETE ON lifer_loc_coords TO birds_app;
