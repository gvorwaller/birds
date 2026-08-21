-- The owner-checklist parser deployed before this migration did not recognize
-- the live JSP's lat=N,lng=N assignments. It consequently persisted false
-- no_coords negatives. Distrust those rows once so the corrected parser gets
-- another attempt; genuine negatives will be written back as no_coords.
UPDATE lifer_loc_attempts
   SET reason = 'legacy_untrusted'
 WHERE reason = 'no_coords';
