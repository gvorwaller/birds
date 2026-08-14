-- Group forecast data by state on /forecast/data (GBV request 2026-08-12):
-- hotspots need to know their state to nest under it. Counties/states can be
-- derived from their loc_code; hotspot rows get the column populated by
-- storeFrequencies going forward and backfilled organically on refresh.

ALTER TABLE frequency_fetch
    ADD COLUMN IF NOT EXISTS region_code TEXT;  -- e.g. 'US-ME' (state of this loc)

-- Backfill what is derivable: states are their own region; counties embed it.
UPDATE frequency_fetch
   SET region_code = CASE
         WHEN loc_code ~ '^US-[A-Z]{2}$' THEN loc_code
         WHEN loc_code ~ '^US-[A-Z]{2}-' THEN substring(loc_code from 1 for 5)
         ELSE region_code
       END
 WHERE region_code IS NULL;

-- Hotspot loc_codes (L*) are not derivable from the code. They stay NULL
-- until the next storeFrequencies write. /forecast/data groups on this
-- column; counties also fall back to parsing US-XX-NNN from loc_code.
