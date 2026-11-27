-- migrate: no-transaction
-- td-9fe839: external sources refresh themselves, tell the owner about new
-- unmatched taxa and failed automatic refreshes, and match nominate
-- subspecies on their own. Plan: docs/2026-11-27-external-refresh-plan-CC.md.
--
-- WHY NO TRANSACTION. Connectors keep ingesting while this runs, and their
-- calls lock external tables in more than one order (finish: a load, then its
-- source; claim: the source, then loads). One transaction holding locks on
-- several of these tables could deadlock with either (CODEX1 td-9fe839). So
-- each statement below runs on its own, holding its locks only while it runs
-- (a connector call may wait briefly for one, or it for a connector call),
-- and each is idempotent: if one fails (lock_timeout on
-- a busy moment), the deploy stops before reloading anything and running it
-- again finishes the rest.
SET lock_timeout = '15s';

-- How often a source's loaded regions are reloaded automatically, in days.
-- NULL = Off. The allowed values must match REFRESH_DAYS_OPTIONS in
-- src/lib/external-refresh-policy.ts.
ALTER TABLE external_sources
    ADD COLUMN IF NOT EXISTS refresh_days SMALLINT
        CONSTRAINT external_sources_refresh_days_check CHECK (refresh_days IS NULL OR refresh_days IN (7, 14, 30));
-- The two live sources start Weekly (owner, 2026-11-27); only while unset.
UPDATE external_sources SET refresh_days = 7 WHERE id IN ('artsobs', 'artportalen') AND refresh_days IS NULL;

-- Who started a load: a person ('manual') or the refresh job ('auto'). Set
-- when the load is created; every earlier load was started by a person.
ALTER TABLE external_loads
    ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual'
        CONSTRAINT external_loads_origin_check CHECK (origin IN ('manual', 'auto'));
CREATE INDEX IF NOT EXISTS external_loads_auto_idx ON external_loads (source_id, region_code, created_at DESC)
    WHERE origin = 'auto';

-- Owner alerts, created in the same transaction as the outcome they report
-- (a finish that published new unmatched taxa, or an automatic load that
-- failed for good) and delivered by push from the worker. Earlier loads never
-- get one. (Its foreign keys take SHARE ROW EXCLUSIVE on both referenced
-- tables for the moment the statement runs: a connector's heartbeat or finish
-- that writes a load waits that long, and this statement waits for one in
-- flight — brief blocking, not a deadlock, since no ingest step holds a lock
-- that conflicts with it while waiting for one this statement holds; checked
-- against the PostgreSQL 17 lock table by CODEX1.)
CREATE TABLE IF NOT EXISTS external_alerts (
    id              BIGSERIAL PRIMARY KEY,
    source_id       TEXT NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
    region_code     TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('new_unmatched', 'refresh_failed')),
    load_id         UUID NOT NULL REFERENCES external_loads(id) ON DELETE CASCADE,
    -- new_unmatched: [{"id": upstream taxon id, "name": canonical name, "reports": n}]
    taxa            JSONB,
    error           TEXT CHECK (error IS NULL OR length(error) <= 500),
    -- pending → sent (a device accepted it), dropped (nothing left to say at
    -- send time: the taxa were matched, or a newer load replaced the failed
    -- one), or gave_up (every attempt failed).
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dropped', 'gave_up')),
    attempts        SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error      TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    UNIQUE (load_id, kind),
    CHECK ((kind = 'new_unmatched') = (taxa IS NOT NULL)),
    CHECK ((status = 'pending') = (finished_at IS NULL))
);
CREATE INDEX IF NOT EXISTS external_alerts_pending_idx ON external_alerts (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS external_alerts_source_idx ON external_alerts (source_id, created_at DESC);

-- The refresh job (system-recurring, like the need-alert scan). One
-- statement, so the check is never missing.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check, ADD CONSTRAINT jobs_type_check CHECK (type IN
	('load_hotspots','load_region','analyze_counties','refresh_loc','retry_loc','sync_lifelist',
	 'sync_taxonomy','scan_need_alerts','enrich_species','scan_enrichment','enrich_species_media',
	 'enrich_species_inat','enrich_families','tag_repair',
	 'tag_consistency','tag_stage','tag_benchmark','tag_activate','tag_retire','tag_rollback',
	 'tag_draft_rules','tag_design_simulation','tag_eval_create','tag_gate_report',
	 'tag_preview','tag_family_refs','refresh_species_counts','repair_hotspot_coords',
	 'refresh_external_sources'));

-- A nominate subspecies matched as its one eBird species (taxa.ts).
ALTER TABLE external_taxa DROP CONSTRAINT IF EXISTS external_taxa_match_reason_check,
    ADD CONSTRAINT external_taxa_match_reason_check CHECK (match_reason IS NULL
    OR match_reason IN ('override', 'scientific', 'subspecies', 'former_name', 'nominate', 'no_match', 'ambiguous',
                        'override_code_missing', 'not_species'));
