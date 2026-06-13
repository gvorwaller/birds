#!/usr/bin/env bash
# Snapshot the birds PostgreSQL database + the droplet-only artifacts.
#
# Most birds data is re-derivable (eBird cache, taxonomy, life list re-sync from
# eBird; photos live on gaylon.photos). The irreplaceable rows are trips,
# trip_stops, species_match_overrides, user_ebird (credentials), and users
# (home). pg_dump uses a single MVCC snapshot — safe while the app serves.
#
# Outputs under <project>/data/backup/:
#   prod/birds.pgdump         — prod DB (port 5436), pg_dump -Fc, pulled via SSH
#   prod/.env                 — /opt/birds/.env (600, contains secrets)
#   prod/nginx.conf           — /etc/nginx/sites-available/birds.gaylon.photos
#   prod/postgresql.conf      — /etc/postgresql/17/birds/postgresql.conf
#   prod/pg_hba.conf          — /etc/postgresql/17/birds/pg_hba.conf
#   prod/pm2-birds.json       — pm2 jlist filtered to the birds app
#   prod/PULL_OK_AT           — ISO-8601 timestamp on success
#   local/birds.pgdump        — local test DB (with --local), pg_dump -Fc
#
# Flags:
#   --local-only   dump the local test DB (port 5436 / birds_test) only, no SSH
#   (default)      pull the prod snapshot

set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

DROPLET_IP="134.199.211.199"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKUP_DIR="${PROJECT_ROOT}/data/backup"

LOCAL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --local-only) LOCAL_ONLY=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mxx  %s\033[0m\n' "$*" >&2; exit 1; }

if [[ "${LOCAL_ONLY}" -eq 1 ]]; then
  say "Local test DB snapshot"
  mkdir -p "${BACKUP_DIR}/local"
  ENV_FILE="${PROJECT_ROOT}/.env.test"
  [[ -f "$ENV_FILE" ]] || die "No .env.test found for local dump."
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  PGPASSWORD="${PGPASSWORD}" pg_dump -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-15436}" \
    -U "${PGUSER:-birds_app}" -Fc "${PGDATABASE:-birds_test}" > "${BACKUP_DIR}/local/birds.pgdump"
  say "Wrote ${BACKUP_DIR}/local/birds.pgdump"
  exit 0
fi

say "Prod snapshot from ${DROPLET_IP}"
PROD="${BACKUP_DIR}/prod"
mkdir -p "${PROD}"

say "DB dump (birds @ 5436)"
ssh -o BatchMode=yes -o ConnectTimeout=15 "root@${DROPLET_IP}" \
  "sudo -u postgres pg_dump -p 5436 -Fc birds" > "${PROD}/birds.pgdump" \
  || die "pg_dump pull failed"

say "Droplet artifacts"
ssh -o BatchMode=yes "root@${DROPLET_IP}" 'cat /opt/birds/.env' > "${PROD}/.env" && chmod 600 "${PROD}/.env"
ssh -o BatchMode=yes "root@${DROPLET_IP}" 'cat /etc/nginx/sites-available/birds.gaylon.photos' > "${PROD}/nginx.conf"
ssh -o BatchMode=yes "root@${DROPLET_IP}" 'cat /etc/postgresql/17/birds/postgresql.conf' > "${PROD}/postgresql.conf" || true
ssh -o BatchMode=yes "root@${DROPLET_IP}" 'cat /etc/postgresql/17/birds/pg_hba.conf' > "${PROD}/pg_hba.conf" || true
ssh -o BatchMode=yes "root@${DROPLET_IP}" "pm2 jlist 2>/dev/null | python3 -c 'import sys,json;print(json.dumps([a for a in json.load(sys.stdin) if a[\"name\"]==\"birds\"],indent=2))'" > "${PROD}/pm2-birds.json" || true

date -u +"%Y-%m-%dT%H:%M:%SZ" > "${PROD}/PULL_OK_AT"
say "Done. Snapshot in ${PROD}/"
ls -la "${PROD}/"
