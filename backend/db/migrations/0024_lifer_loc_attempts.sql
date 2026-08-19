-- 0024: negative persistence for lifer loc resolution (GROK td-b5986c
-- REJECT). 0023 put loc_checked_at on seen_species — but importLifeList
-- DELETE+reINSERTs the synced rows every run, so stamps never survived a
-- re-import and dead loc_ids became candidates again (and, with the
-- alphabetical cap, could starve every later loc_id forever). Negatives are
-- keyed by (user_id, loc_id) in their own table, which the import replace
-- never touches. v1 never retries a negative (pin 2's "long TTL or never").

CREATE TABLE lifer_loc_attempts (
    user_id    integer     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    loc_id     text        NOT NULL,
    checked_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, loc_id)
);

ALTER TABLE seen_species DROP COLUMN loc_checked_at;
