-- td-78a7b1 (Gaylon P1, 2026-08-18): alerts link to the ACTUAL eBird
-- report(s) that triggered them. Per his 2026-08-18 ruling, ALL reports get
-- full detail — no public/private split.
--
-- reports: the triggering observations for the alert, verbatim at send time:
-- [{subId, locName, obsDt, distanceMi}, ...] closest-first, UNCAPPED
-- (CODEX1: no silent truncation — every triggering report persists).

BEGIN;

ALTER TABLE need_alert_log
    ADD COLUMN IF NOT EXISTS reports JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
