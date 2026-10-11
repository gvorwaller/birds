# Rollback migrations (not auto-applied)

`backend/db/migrate_pg.sh` applies every `*.sql` under `backend/db/migrations/`
in sort order on every deploy. Files here are the written, reviewed rollback for
a specific forward migration; they run only when moved into `migrations/`, in the
same commit as the matching code revert, following that migration's deploy notes.

| File | Rolls back | Notes |
|---|---|---|
| `0051_drop_species_band_rollup.sql` | 0050 | Deploy with the worker paused; revert the `rebuildBandRollup` hook in `src/lib/server/barchart.ts` in the same commit. |
| `0084_revert_species_presence.sql` | 0083 | Deploy with the worker paused; revert Hotspots & data to the 0082 snapshot reader and restore the `refresh_species_counts` job in the same commit. Renumber if 0084 is taken by then. |
