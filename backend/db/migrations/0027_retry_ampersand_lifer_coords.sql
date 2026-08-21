-- Migration 0026 retried the false negatives, but its companion parser still
-- modeled the live assignment pair with a comma. The owner checklist actually
-- emits lat=N&lng=N, so those retries were persisted as no_coords once more.
-- Distrust them one final time now that the parser matches the observed page.
UPDATE lifer_loc_attempts
   SET reason = 'legacy_untrusted'
 WHERE reason = 'no_coords';
