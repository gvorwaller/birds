# Rollback migrations (not auto-applied)

`backend/db/migrate_pg.sh` applies every `*.sql` under `backend/db/migrations/`
in sort order on every deploy. Files here are the written, reviewed rollback for
a specific forward migration; they run only when moved into `migrations/`, in the
same commit as the matching code revert, following that migration's deploy notes.

| File | Rolls back | Notes |
|---|---|---|
| `0051_drop_species_band_rollup.sql` | 0050 | Deploy with the worker paused; revert the `rebuildBandRollup` hook in `src/lib/server/barchart.ts` in the same commit. |
| `0086_revert_species_presence.sql` | 0083 | Deploy with the worker paused; revert Hotspots & data to the 0082 snapshot reader and restore the `refresh_species_counts` job in the same commit. Renumber to the next free number when used. |
| `0086_revert_hotspot_coordinates.sql` | 0084 | Revert `hotspot-coordinates.ts`, the repair job and the load-time lookup in the same commit; cancel any pending `repair_hotspot_coords` job first. Renumber to the next free number when used. |
| `0086_revert_hotspot_catalog.sql` | 0085 | Revert the catalog stage of the coordinate repair in the same commit. Roll back 0085 before 0084. Renumber to the next free number when used. |
| `0087_revert_user_activity.sql` | 0086 | Revert the activity write in `src/hooks.server.ts` and the Admin → Users tab in the same commit. Renumber to the next free number when used. |
