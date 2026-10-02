-- td-894144 open-ocean pilot — owner decision 2026-10-01: sea ducks (scoters,
-- eiders, Long-tailed Duck) winter on coasts and large lakes, so they are not
-- open ocean. The reported (non-gating) named case for Surf Scoter now expects
-- "no" (eval-design.ts). Named cases are part of the Preview design, so re-pin
-- tag_preview_design; a Preview made under the old design stops being current.
--
-- Wrapped in one transaction by migrate_pg.sh.

UPDATE public.tag_preview_design
   SET design_hash = 'ca2eebe15b00227bdb1ffe08064265b736194f1c79600877b23c09760b76fff4', pinned_at = now()
 WHERE tag = 'habitat:open-ocean';
