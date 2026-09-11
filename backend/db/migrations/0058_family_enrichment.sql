BEGIN;
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK(type IN
 ('load_hotspots','load_region','analyze_counties','refresh_loc','retry_loc','sync_lifelist',
 'sync_taxonomy','scan_need_alerts','enrich_species','scan_enrichment','enrich_species_media',
 'enrich_species_inat','enrich_families'));
-- Independent of taxonomy_cache: taxonomy sync replaces that table transactionally.
CREATE TABLE family_enrichment (
 family_code TEXT PRIMARY KEY,
 input_hash TEXT NOT NULL,
 published_hash TEXT,
 content JSONB,
 source JSONB,
 model TEXT,
 verifier_model TEXT,
 generated_at TIMESTAMPTZ,
 status TEXT NOT NULL CHECK(status IN ('pending','ready','no_source','error')),
 last_error TEXT,
 attempted_at TIMESTAMPTZ,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 failures INT NOT NULL DEFAULT 0,
 pending_source JSONB,
 pending_draft JSONB,
 pending_model TEXT
);
CREATE TABLE family_enrichment_control (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
 paused BOOLEAN NOT NULL DEFAULT FALSE,
 blocked_until TIMESTAMPTZ,
 reason TEXT
);
INSERT INTO family_enrichment_control(singleton) VALUES(TRUE);
GRANT SELECT,INSERT,UPDATE,DELETE ON family_enrichment, family_enrichment_control TO birds_app;
COMMIT;
