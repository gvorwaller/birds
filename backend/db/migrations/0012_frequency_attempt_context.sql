-- Failed forecast-data loads must be self-describing in the UI (name + state,
-- not a bare locId) and retryable. Record the intended location's context at
-- attempt time — the attempt row is the only trace when the fetch fails, since
-- frequency_fetch only gets a row on success.

ALTER TABLE frequency_fetch_attempts
    ADD COLUMN IF NOT EXISTS loc_kind    TEXT CHECK (loc_kind IN ('region', 'hotspot')),
    ADD COLUMN IF NOT EXISTS loc_name    TEXT,
    ADD COLUMN IF NOT EXISTS region_code TEXT;  -- e.g. 'US-ME' for a hotspot's state
