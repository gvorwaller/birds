-- td-493c58: the taxonomy refresh re-matches external sources (plan:
-- docs/2026-10-31-taxonomy-sources-rematch-plan-CC.md).
--
-- External sources keep the eBird species code each upstream taxon was
-- matched to by scientific name. A taxonomy sync now re-matches them, and the
-- matcher falls back to the names eBird used before (taxonomy_backup_rows), so
-- a genus move keeps its species and a split moves to the right one.
--
-- For each run and source: a BASELINE of the matches (copied with the
-- before-sync backup, or just before a re-match when a run has none), and
-- the taxa whose species changed between that baseline and the re-match.
-- The diff is always baseline → now, so a replay records the same thing
-- whoever re-matched in between.

ALTER TABLE external_taxa DROP CONSTRAINT external_taxa_match_reason_check;
ALTER TABLE external_taxa ADD CONSTRAINT external_taxa_match_reason_check CHECK (match_reason IS NULL
    OR match_reason IN ('override', 'scientific', 'subspecies', 'former_name', 'no_match', 'ambiguous',
                        'override_code_missing', 'not_species'));

CREATE TABLE taxonomy_source_rematches (
    run_id        BIGINT NOT NULL REFERENCES taxonomy_runs(id) ON DELETE CASCADE,
    source_id     TEXT NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
    -- before_sync: copied with the run's before-sync backup; before_rematch:
    -- copied just before the re-match (a run or source that had none).
    baseline_kind TEXT NOT NULL CHECK (baseline_kind IN ('before_sync', 'before_rematch')),
    baseline_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    -- Set by each re-match (NULL = not re-matched yet).
    rematched_at  TIMESTAMPTZ,
    moved         INT CHECK (moved >= 0),
    lost          INT CHECK (lost >= 0),
    gained        INT CHECK (gained >= 0),
    kept_former   INT CHECK (kept_former >= 0),
    PRIMARY KEY (run_id, source_id)
);

CREATE TABLE taxonomy_source_baseline (
    run_id            BIGINT NOT NULL,
    source_id         TEXT NOT NULL,
    upstream_taxon_id TEXT NOT NULL,
    canonical_name    TEXT NOT NULL,
    species_code      TEXT,
    match_reason      TEXT,
    PRIMARY KEY (run_id, source_id, upstream_taxon_id, canonical_name),
    FOREIGN KEY (run_id, source_id) REFERENCES taxonomy_source_rematches(run_id, source_id) ON DELETE CASCADE
);

CREATE TABLE taxonomy_source_changes (
    run_id            BIGINT NOT NULL,
    source_id         TEXT NOT NULL,
    upstream_taxon_id TEXT NOT NULL,
    canonical_name    TEXT NOT NULL,
    local_name        TEXT,
    old_code          TEXT,
    new_code          TEXT,
    old_reason        TEXT,
    new_reason        TEXT,
    -- Distinct places in the pair's own raw rows (monthly counts, records,
    -- recent reports): independent of any match.
    places            INT NOT NULL DEFAULT 0 CHECK (places >= 0),
    PRIMARY KEY (run_id, source_id, upstream_taxon_id, canonical_name),
    FOREIGN KEY (run_id, source_id) REFERENCES taxonomy_source_rematches(run_id, source_id) ON DELETE CASCADE
);
