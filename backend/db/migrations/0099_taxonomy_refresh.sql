-- td-6093ae: Admin → Taxonomy refresh (plan: docs/2026-10-30-taxonomy-refresh-plan-CC.md).
--
-- The eBird taxonomy sync overwrites taxonomy_cache, so what a split or lump
-- changed was lost and nothing could say which stored frequency locations
-- need a reload. A taxonomy refresh RUN now backs the taxonomy up before and
-- after the sync, compares the two backups, and keeps the locations to reload
-- with their refresh batches. Everything is kept: a backup is about 18k rows,
-- once a year. Nothing cascades from users or jobs (job ids are plain: jobs
-- are pruned after 90 days).

CREATE TABLE taxonomy_runs (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    requested_by   INT REFERENCES users(id) ON DELETE SET NULL,
    actor_label    TEXT,
    job_id         BIGINT,
    -- The last stage COMPLETED; a retry resumes after it.
    stage          TEXT NOT NULL DEFAULT 'started' CHECK (stage IN
                     ('started','backed_up','applied','after_backed_up','compared','done')),
    failed_stage   TEXT,
    error          TEXT,
    before_id      BIGINT,
    after_id       BIGINT,
    -- Which replacement committed: written inside the replacement transaction.
    target_hash    TEXT,
    target_version TEXT,
    applied_at     TIMESTAMPTZ,
    compared_at    TIMESTAMPTZ,
    counts         JSONB,
    superseded_by  BIGINT REFERENCES taxonomy_runs(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE taxonomy_backups (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    taken_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() UNIQUE,
    run_id            BIGINT NOT NULL REFERENCES taxonomy_runs(id) ON DELETE RESTRICT,
    kind              TEXT NOT NULL CHECK (kind IN ('before_sync','after_sync')),
    taxa              INT NOT NULL CHECK (taxa >= 0),
    -- MAX(taxonomy_cache.fetched_at) at backup time: when that taxonomy was fetched.
    source_fetched_at TIMESTAMPTZ,
    ebird_version     TEXT,
    UNIQUE (run_id, kind)
);

ALTER TABLE taxonomy_runs
  ADD CONSTRAINT taxonomy_runs_before_fk FOREIGN KEY (before_id) REFERENCES taxonomy_backups(id) ON DELETE RESTRICT,
  ADD CONSTRAINT taxonomy_runs_after_fk FOREIGN KEY (after_id) REFERENCES taxonomy_backups(id) ON DELETE RESTRICT;

-- Every taxonomy_cache business column (0001 + 0057).
CREATE TABLE taxonomy_backup_rows (
    backup_id       BIGINT NOT NULL REFERENCES taxonomy_backups(id) ON DELETE CASCADE,
    species_code    TEXT NOT NULL,
    com_name        TEXT NOT NULL,
    sci_name        TEXT NOT NULL,
    category        TEXT NOT NULL,
    family          TEXT,
    taxon_order     NUMERIC,
    order_name      TEXT,
    family_code     TEXT,
    family_sci_name TEXT,
    banding_codes   TEXT[],
    report_as       TEXT,
    extinct         BOOLEAN,
    PRIMARY KEY (backup_id, species_code)
);

CREATE TABLE taxonomy_changes (
    run_id       BIGINT NOT NULL REFERENCES taxonomy_runs(id) ON DELETE CASCADE,
    taxon_code   TEXT NOT NULL,
    kinds        TEXT[] NOT NULL,
    old_com_name TEXT,
    new_com_name TEXT,
    old_sci_name TEXT,
    new_sci_name TEXT,
    old_category TEXT,
    new_category TEXT,
    old_report_as TEXT,
    new_report_as TEXT,
    -- Its stored frequency rows need a reload (see classifyChanges).
    affects      BOOLEAN NOT NULL DEFAULT FALSE,
    locations    INT NOT NULL DEFAULT 0 CHECK (locations >= 0),
    PRIMARY KEY (run_id, taxon_code)
);

CREATE TABLE taxonomy_refresh_batches (
    run_id       BIGINT NOT NULL REFERENCES taxonomy_runs(id) ON DELETE CASCADE,
    batch_no     INT NOT NULL CHECK (batch_no >= 1),
    job_id       BIGINT,
    requested_by INT REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (run_id, batch_no)
);

CREATE TABLE taxonomy_refresh_locations (
    run_id        BIGINT NOT NULL REFERENCES taxonomy_runs(id) ON DELETE CASCADE,
    loc_code      TEXT NOT NULL,
    loc_kind      TEXT NOT NULL CHECK (loc_kind IN ('region','hotspot')),
    loc_name      TEXT NOT NULL,
    region_code   TEXT,
    reasons       TEXT[] NOT NULL,
    species_codes TEXT[] NOT NULL DEFAULT '{}',
    batch_no      INT,
    dispatched_at TIMESTAMPTZ,
    last_error    TEXT,
    PRIMARY KEY (run_id, loc_code),
    FOREIGN KEY (run_id, batch_no) REFERENCES taxonomy_refresh_batches(run_id, batch_no),
    CHECK (reasons <@ ARRAY['changed_species','now_matches','loaded_since_sync','carried_over']::TEXT[]
           AND cardinality(reasons) > 0)
);
CREATE INDEX taxonomy_refresh_locations_batch_idx ON taxonomy_refresh_locations (run_id, batch_no);

-- At most one run before its comparison, failed or not: a failed run is
-- resumed ("Try again"), never replaced. A new run would back up a taxonomy
-- the failed run may already have replaced and compare it with itself.
CREATE UNIQUE INDEX taxonomy_runs_one_open_idx ON taxonomy_runs ((TRUE))
  WHERE stage IN ('started','backed_up','applied','after_backed_up');
