BEGIN;
-- Additive only: preserve all existing publication hashes/content and schedules.
CREATE TABLE family_enrichment_diagnostics (
 id BIGSERIAL PRIMARY KEY,
 family_code TEXT NOT NULL REFERENCES family_enrichment(family_code) ON DELETE CASCADE,
 input_hash TEXT NOT NULL,
 resolver_version TEXT NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 outcome TEXT NOT NULL,
 diagnostics JSONB NOT NULL DEFAULT '[]',
 source JSONB,
 draft JSONB
);
CREATE INDEX family_enrichment_diagnostics_family_time ON family_enrichment_diagnostics(family_code,recorded_at DESC);
GRANT SELECT,INSERT ON family_enrichment_diagnostics TO birds_app;
GRANT USAGE,SELECT ON SEQUENCE family_enrichment_diagnostics_id_seq TO birds_app;
COMMIT;
