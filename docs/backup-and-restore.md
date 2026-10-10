# Backups and restore drill

How the production database is backed up, what history exists, and how to
prove a backup restores. Agent-run; there is no owner step. Verified
2026-10-09/10 (td-cf46cf).

## What runs, where it lands

| Step | When | Where | Evidence |
|---|---|---|---|
| `scripts/backup-pg.sh` (Carbon Copy Cloner pre-flight) | nightly 01:05 local | droplet: `pg_dump -Fc` of `birds` (5436) → scp to this Mac | `data/backup/preflight.log`, `data/backup/prod/PULL_OK_AT` |
| Dump verified (`pg_restore -l`) | same run | `data/backup/prod/birds.pgdump` (~363 MB) | log line `prod snapshot ok` |
| Dated history (td-cf46cf) | same run | `data/backup/prod/history/birds-<UTC day>.pgdump` | log line `history: N dated dump(s)` |
| CCC task "birds repo backup" | right after | the whole repo, incl. `data/backup/`, to SMB share `birds` on the Synology NAS | `ccc -h` (task history), all Success |

Also pulled each night (same folder): prod `.env` (mode 600), nginx site
config, `postgresql.conf`, `pg_hba.conf`, the PM2 entry (secrets redacted).

**History.** CCC mirrors with SafetyNet **off** and no root-level
protection, so it also deletes from the NAS whatever left `data/backup/`: the
NAS holds exactly the local folder and nothing older. Dated history comes only from
`scripts/lib/backup-retention.sh`: the last **7 days** plus **Sunday dumps
younger than 35 days** (≈ 11 files). On the Mac each dated file is a hard link
to that night's dump (no extra space); on the NAS each may be a full copy (CCC over SMB is not verified to keep hard links)
(≈ 4 GB total). Time Machine on this Mac is local-snapshot only and is not a
backup of record.

## Restore drill (repeatable, ~5 minutes, never touches prod)

Run against the local PG17 test cluster (127.0.0.1:15436) into a scratch
database — never `birds` on the droplet and never `birds_test`.

```bash
cd ~/birds
unset PGHOST PGUSER PGPASSWORD                      # use the local superuser socket
B=/opt/homebrew/opt/postgresql@17/bin
DUMP=data/backup/prod/birds.pgdump                  # or a dated file under history/
$B/psql -p 15436 -d postgres -c "CREATE DATABASE birds_bench_drill"
time $B/pg_restore -p 15436 -d birds_bench_drill --no-owner --no-privileges -j 6 "$DUMP"
# Row counts to compare with prod (read-only on prod):
Q="SELECT 'users',count(*) FROM users UNION ALL SELECT 'trips',count(*) FROM trips
   UNION ALL SELECT 'seen_species',count(*) FROM seen_species
   UNION ALL SELECT 'taxonomy_cache',count(*) FROM taxonomy_cache
   UNION ALL SELECT 'species_frequency',count(*) FROM species_frequency
   UNION ALL SELECT 'migrations',count(*) FROM admin.schema_migrations"
$B/psql -p 15436 -d birds_bench_drill -At -c "$Q"
$B/psql -p 15436 -d postgres -c "DROP DATABASE birds_bench_drill"
```

Pass = `pg_restore` exits 0 with no errors and the counts match **the dump's
own moment**, not prod now: run the same query on prod right after the
nightly dump (or read the drill log below), or compare against prod and
explain each difference by activity since `PULL_OK_AT` (users, life lists,
taxonomy, frequency loads and jobs all move).

Drill log:

| Date | Dump | Result |
|---|---|---|
| 2026-10-09 | nightly 05:07Z | rc 0, 107 s on the M4; users 11, trips 12, seen_species 720, taxonomy_cache 17,891, species_frequency 38,601,518, migrations 80 — all equal to prod (jobs 6,931 vs 6,958) |

## Restoring prod for real

Not scripted on purpose — it is a rare, owner-confirmed operation. Outline:
stop `birds` and `birds-worker` in PM2, `pg_restore --clean --if-exists` the
chosen dump into `birds` on 5436 as `birds_owner`, run
`backend/db/migrate_pg.sh` (in case the dump predates a migration), restart
PM2, check `/api/health`. Stored eBird credentials decrypt only with the
prod `.env`'s `EBIRD_KEY_SECRET` (kept alongside the dump).

## Benchmarks on a restored copy

`scripts/bench-taxonomy-sync.ts` (td-861855) restores into a `birds_bench*`
scratch database and refuses any other name. On the droplet, restore with a
`pg_restore -L` list that skips the data of `species_frequency`,
`species_month_freq` and `species_band_month_freq` (~6.9 GB of 7.2 GB) to keep
the shared droplet's memory free; drop the scratch DB afterwards.
