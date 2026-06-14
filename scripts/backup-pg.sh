#!/bin/bash
# Snapshot the birds PostgreSQL database and droplet-only artifacts.
#
# Intended use: Carbon Copy Cloner pre-flight script, before CCC copies the
# data/backup/ directory to backup storage. Also safe to run manually.
#
# Most birds data is re-derivable, but trips, users/home settings,
# user_ebird credentials, species_match_overrides, and photo_links are worth
# preserving. pg_dump uses a single MVCC snapshot, so it is safe while the app
# serves requests.
#
# Outputs under <project>/data/backup/:
#   prod/birds.pgdump         - prod DB (port 5436), pg_dump -Fc, pulled via SSH
#   prod/.env                 - /opt/birds/.env (600, contains secrets)
#   prod/nginx.conf           - /etc/nginx/sites-available/birds.gaylon.photos
#   prod/postgresql.conf      - /etc/postgresql/17/birds/postgresql.conf
#   prod/pg_hba.conf          - /etc/postgresql/17/birds/pg_hba.conf
#   prod/pm2-birds.json       - pm2 jlist filtered to the birds app, secrets redacted
#   prod/PULL_OK_AT           - ISO-8601 timestamp on success
#   local/birds.pgdump        - local test DB dump when --local-only is used
#   preflight.log             - tee of every run (uid, args, stdout, stderr)
#
# Flags:
#   --local-only   dump the local test DB only, no SSH
#   -h, --help     show this header
#
# CCC passes positional arguments (source, destination, prior exit code) to
# preflight scripts. This script ignores non-flag positional args so CCC's
# calling convention does not break normal operation.

set -euo pipefail

# CCC may invoke us with a stripped PATH. Keep system paths explicit and find
# Homebrew PostgreSQL client tools below instead of relying on shell startup.
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"

DROPLET="root@134.199.211.199"
PROD_APP_DIR="/opt/birds"
PROD_PG_CLUSTER_DIR="/etc/postgresql/17/birds"
PROD_NGINX_CONF="/etc/nginx/sites-available/birds.gaylon.photos"
PROD_DB_NAME="birds"
PROD_DB_PORT="5436"
PROD_PM2_NAME="birds"

OWNER_USER="gaylonvorwaller"
OWNER_GROUP="staff"
USER_HOME="/Users/${OWNER_USER}"
USER_SSH_DIR="${USER_HOME}/.ssh"
USER_SSH_KEY="${USER_SSH_DIR}/id_ed25519"
USER_KNOWN_HOSTS="${USER_SSH_DIR}/known_hosts"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKUP_DIR="${PROJECT_ROOT}/data/backup"

LOCAL_BACKUP_DIR="${BACKUP_DIR}/local"
LOCAL_DUMP="${LOCAL_BACKUP_DIR}/birds.pgdump"
LOCAL_PULL_MARKER="${LOCAL_BACKUP_DIR}/PULL_OK_AT"
LOCAL_FAIL_MARKER="${LOCAL_BACKUP_DIR}/FAILED_AT"
LOCAL_FAIL_REASON="${LOCAL_BACKUP_DIR}/FAILED_REASON"

PROD_BACKUP_DIR="${BACKUP_DIR}/prod"
PROD_DUMP="${PROD_BACKUP_DIR}/birds.pgdump"
PROD_ENV_DEST="${PROD_BACKUP_DIR}/.env"
PROD_NGINX_DEST="${PROD_BACKUP_DIR}/nginx.conf"
PROD_PGCONF_DEST="${PROD_BACKUP_DIR}/postgresql.conf"
PROD_PGHBA_DEST="${PROD_BACKUP_DIR}/pg_hba.conf"
PROD_PM2_DEST="${PROD_BACKUP_DIR}/pm2-birds.json"
PROD_PULL_MARKER="${PROD_BACKUP_DIR}/PULL_OK_AT"
LOG_FILE="${BACKUP_DIR}/preflight.log"

mkdir -p "${BACKUP_DIR}" "${LOCAL_BACKUP_DIR}" "${PROD_BACKUP_DIR}"
{
  echo "===== $(/bin/date -u +%Y-%m-%dT%H:%M:%SZ) preflight start ====="
  echo "uid=$EUID user=$(/usr/bin/id -un 2>/dev/null || echo ?) home=${HOME:-?} pwd=$(pwd)"
  echo "path=${PATH:-?}"
  echo "args=$*"
} >> "${LOG_FILE}"
exec > >(/usr/bin/tee -a "${LOG_FILE}") 2> >(/usr/bin/tee -a "${LOG_FILE}" >&2)

restore_ownership() {
  if [[ $EUID -eq 0 ]]; then
    /usr/sbin/chown -R "${OWNER_USER}:${OWNER_GROUP}" "${BACKUP_DIR}" 2>/dev/null || true
  fi
}
trap restore_ownership EXIT

usage() {
  sed -n '2,28p' "$0"
}

LOCAL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --local-only) LOCAL_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    --*|-?)
      echo "[backup-pg] unknown flag: ${arg}" >&2
      exit 2
      ;;
    *) ;; # CCC positional args
  esac
done

require_command() {
  local cmd=$1
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "[backup-pg] required command not found: ${cmd}" >&2
    exit 2
  fi
}

find_pg_bin() {
  local name=$1
  local dir
  for dir in \
    /opt/homebrew/opt/libpq/bin \
    /opt/homebrew/opt/postgresql@17/bin \
    /opt/homebrew/opt/postgresql@16/bin \
    /opt/homebrew/Cellar/libpq/*/bin \
    /opt/homebrew/Cellar/postgresql@*/*/bin \
    /usr/local/opt/libpq/bin \
    /usr/local/opt/postgresql@17/bin \
    /usr/local/opt/postgresql@16/bin \
    /usr/local/Cellar/libpq/*/bin \
    /usr/local/Cellar/postgresql@*/*/bin; do
    if [[ -x "${dir}/${name}" ]]; then
      printf '%s\n' "${dir}/${name}"
      return 0
    fi
  done
  if command -v "${name}" >/dev/null 2>&1; then
    command -v "${name}"
    return 0
  fi
  echo "[backup-pg] required PostgreSQL client not found: ${name}" >&2
  exit 2
}

size_of() {
  /usr/bin/stat -f%z "$1" 2>/dev/null || /usr/bin/wc -c < "$1"
}

verify_dump() {
  local dump=$1
  if ! "${PG_RESTORE_BIN}" -l "${dump}" >/dev/null 2>&1; then
    echo "[backup-pg] dump verification failed: ${dump}" >&2
    return 1
  fi
}

PG_DUMP_BIN="$(find_pg_bin pg_dump)"
PG_RESTORE_BIN="$(find_pg_bin pg_restore)"
require_command ssh
require_command scp

if [[ "${LOCAL_ONLY}" -eq 1 ]]; then
  echo "[backup-pg] local test DB snapshot"
  ENV_FILE="${PROJECT_ROOT}/.env.test"
  if [[ ! -f "${ENV_FILE}" ]]; then
    rm -f "${LOCAL_PULL_MARKER}"
    /bin/date -u +%Y-%m-%dT%H:%M:%SZ > "${LOCAL_FAIL_MARKER}"
    printf '%s\n' "No .env.test found for local dump" > "${LOCAL_FAIL_REASON}"
    echo "[backup-pg] No .env.test found for local dump" >&2
    exit 1
  fi

  # shellcheck disable=SC1090
  set -a; source "${ENV_FILE}"; set +a

  "${PG_DUMP_BIN}" \
    -h "${PGHOST:-127.0.0.1}" \
    -p "${PGPORT:-15436}" \
    -U "${PGUSER:-birds_app}" \
    -d "${PGDATABASE:-birds_test}" \
    -Fc --no-owner --no-privileges \
    -f "${LOCAL_DUMP}.tmp"

  mv -f "${LOCAL_DUMP}.tmp" "${LOCAL_DUMP}"
  verify_dump "${LOCAL_DUMP}"
  /bin/date -u +%Y-%m-%dT%H:%M:%SZ > "${LOCAL_PULL_MARKER}"
  rm -f "${LOCAL_FAIL_MARKER}" "${LOCAL_FAIL_REASON}"
  echo "[backup-pg] local snapshot ok: ${LOCAL_DUMP} ($(size_of "${LOCAL_DUMP}") bytes)"
  exit 0
fi

if [[ ! -f "${USER_SSH_KEY}" ]]; then
  echo "[backup-pg] SSH key not found: ${USER_SSH_KEY}" >&2
  exit 2
fi

SSH_OPTS=(
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=5
  -o ServerAliveCountMax=3
  -o IdentitiesOnly=yes
  -i "${USER_SSH_KEY}"
  -o "UserKnownHostsFile=${USER_KNOWN_HOSTS}"
)

PROD_TMP_DUMP="/tmp/birds-ccc-pull.pgdump"
PROD_TMP_PM2="/tmp/birds-ccc-pm2.json"

echo "[backup-pg] prod snapshot from ${DROPLET}"

set +e

ssh "${SSH_OPTS[@]}" "${DROPLET}" \
  "sudo -u postgres pg_dump -p '${PROD_DB_PORT}' -d '${PROD_DB_NAME}' -Fc --no-owner --no-privileges -f '${PROD_TMP_DUMP}' && chmod 644 '${PROD_TMP_DUMP}'"
SSH_DUMP_RC=$?
if [[ ${SSH_DUMP_RC} -ne 0 ]]; then
  echo "[backup-pg] prod pg_dump via SSH failed (rc=${SSH_DUMP_RC})" >&2
  rm -f "${PROD_PULL_MARKER}"
  exit 3
fi

scp "${SSH_OPTS[@]}" "${DROPLET}:${PROD_TMP_DUMP}" "${PROD_DUMP}.tmp"
SCP_DUMP_RC=$?

scp "${SSH_OPTS[@]}" "${DROPLET}:${PROD_APP_DIR}/.env" "${PROD_ENV_DEST}.tmp"
SCP_ENV_RC=$?
[[ ${SCP_ENV_RC} -eq 0 ]] && chmod 600 "${PROD_ENV_DEST}.tmp"

scp "${SSH_OPTS[@]}" "${DROPLET}:${PROD_NGINX_CONF}" "${PROD_NGINX_DEST}.tmp"
SCP_NGINX_RC=$?

ssh "${SSH_OPTS[@]}" "${DROPLET}" "cat '${PROD_PG_CLUSTER_DIR}/postgresql.conf'" > "${PROD_PGCONF_DEST}.tmp"
SSH_PGCONF_RC=$?

ssh "${SSH_OPTS[@]}" "${DROPLET}" "cat '${PROD_PG_CLUSTER_DIR}/pg_hba.conf'" > "${PROD_PGHBA_DEST}.tmp"
SSH_PGHBA_RC=$?

ssh "${SSH_OPTS[@]}" "${DROPLET}" \
  "pm2 jlist | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const SENS=/PASSWORD|SECRET|TOKEN|API.?KEY/i;const scrub=v=>{if(v&&typeof v===\"object\"){if(Array.isArray(v))return v.map(scrub);const o={};for(const k of Object.keys(v))o[k]=SENS.test(k)?\"<redacted>\":scrub(v[k]);return o;}return v;};const out=JSON.parse(d).filter(x=>x.name===\"${PROD_PM2_NAME}\").map(scrub);console.log(JSON.stringify(out,null,2));})' > '${PROD_TMP_PM2}' && chmod 644 '${PROD_TMP_PM2}'"
SSH_PM2_RC=$?
if [[ ${SSH_PM2_RC} -eq 0 ]]; then
  scp "${SSH_OPTS[@]}" "${DROPLET}:${PROD_TMP_PM2}" "${PROD_PM2_DEST}.tmp"
  SCP_PM2_RC=$?
else
  SCP_PM2_RC=1
fi

ssh "${SSH_OPTS[@]}" "${DROPLET}" "rm -f '${PROD_TMP_DUMP}' '${PROD_TMP_PM2}'" >/dev/null 2>&1

set -e

if [[ ${SCP_DUMP_RC} -ne 0 ]]; then
  echo "[backup-pg] scp of prod pg_dump failed (rc=${SCP_DUMP_RC})" >&2
  rm -f "${PROD_PULL_MARKER}" "${PROD_DUMP}.tmp"
  exit 3
fi

verify_dump "${PROD_DUMP}.tmp" || {
  rm -f "${PROD_PULL_MARKER}" "${PROD_DUMP}.tmp"
  exit 4
}
mv -f "${PROD_DUMP}.tmp" "${PROD_DUMP}"

warn_or_commit_tmp() {
  local rc=$1 label=$2 tmp=$3 dest=$4 mode=${5:-644}
  if [[ ${rc} -ne 0 ]]; then
    rm -f "${tmp}"
    echo "[backup-pg] WARN: ${label} pull failed (rc=${rc}) - ${dest}"
    return 0
  fi
  chmod "${mode}" "${tmp}" 2>/dev/null || true
  mv -f "${tmp}" "${dest}"
  echo "[backup-pg] ${label} ok: ${dest} ($(size_of "${dest}") bytes)"
}

warn_or_commit_tmp ${SCP_ENV_RC}    "prod .env"            "${PROD_ENV_DEST}.tmp"    "${PROD_ENV_DEST}"    600
warn_or_commit_tmp ${SCP_NGINX_RC}  "prod nginx.conf"      "${PROD_NGINX_DEST}.tmp"  "${PROD_NGINX_DEST}"  644
warn_or_commit_tmp ${SSH_PGCONF_RC} "prod postgresql.conf" "${PROD_PGCONF_DEST}.tmp" "${PROD_PGCONF_DEST}" 644
warn_or_commit_tmp ${SSH_PGHBA_RC}  "prod pg_hba.conf"     "${PROD_PGHBA_DEST}.tmp"  "${PROD_PGHBA_DEST}"  644
warn_or_commit_tmp ${SCP_PM2_RC}    "prod pm2 jlist"       "${PROD_PM2_DEST}.tmp"    "${PROD_PM2_DEST}"    644

/bin/date -u +%Y-%m-%dT%H:%M:%SZ > "${PROD_PULL_MARKER}"
echo "[backup-pg] prod snapshot ok: ${PROD_DUMP} ($(size_of "${PROD_DUMP}") bytes)"
