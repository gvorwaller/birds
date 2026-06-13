#!/usr/bin/env bash
# Deploy birds to the shared DigitalOcean droplet.
#
# Flow:
#   1. local pre-flight (clean tree, on main, pushed to origin)
#   2. (optional) push pending commits
#   3. SSH single-shot to root@134.199.211.199 (IP, never domain — cs.md):
#      a. git pull --ff-only
#      b. NODE_ENV=development npm ci   (devDeps needed for build)
#      c. npm run build
#      d. backend/db/migrate_pg.sh      (connects as birds_owner)
#      e. if deploy/nginx.conf checksum changed → copy + nginx -t + reload
#      f. pm2 startOrReload ecosystem.config.cjs --update-env
#      g. health-check: db==ok required; gallery_source is informational
#
# Idempotent: rerun is safe.
# Flags: --skip-push to redeploy current origin/main without new commits.

set -euo pipefail

DROPLET_IP="134.199.211.199"
APP_DIR="/opt/birds"
PM2_APP="birds"
NGINX_CONF_SRC="deploy/nginx.conf"
NGINX_CONF_DST="/etc/nginx/sites-available/birds.gaylon.photos"
NGINX_LINK="/etc/nginx/sites-enabled/birds.gaylon.photos"
HEALTH_URL_INTERNAL="http://127.0.0.1:3003/api/health"
HEALTH_URL_PUBLIC="https://birds.gaylon.photos/api/health"

SKIP_PUSH=0
for arg in "$@"; do
  case "$arg" in
    --skip-push) SKIP_PUSH=1 ;;
    -h|--help)
      cat <<EOF
Usage: $0 [--skip-push]

Deploys current main to ${DROPLET_IP}:${APP_DIR}.
Bails if working tree is dirty or local main is behind origin/main.
EOF
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mxx  %s\033[0m\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."

say "Local pre-flight"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "${CURRENT_BRANCH}" == "main" ]] || die "Not on main (on ${CURRENT_BRANCH}). Switch first."

if ! git diff-index --quiet HEAD --; then
  die "Working tree is dirty. Commit or stash before deploying."
fi
if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  warn "Untracked files present (not blocking)."
fi

git fetch --quiet origin main

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main)"

if [[ "${LOCAL_SHA}" != "${REMOTE_SHA}" ]]; then
  if [[ ${SKIP_PUSH} -eq 1 ]]; then
    die "Local and origin/main differ but --skip-push was passed."
  fi
  say "Pushing local main → origin"
  git push origin main
fi

NGINX_CHECKSUM_LOCAL=""
if [[ -f "${NGINX_CONF_SRC}" ]]; then
  NGINX_CHECKSUM_LOCAL=$(shasum -a 256 "${NGINX_CONF_SRC}" | awk '{print $1}')
fi

# --- Remote deploy ----------------------------------------------------------
say "SSH ${DROPLET_IP} for remote deploy"

ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
    "root@${DROPLET_IP}" \
    NGINX_CHECKSUM_LOCAL="${NGINX_CHECKSUM_LOCAL}" \
    APP_DIR="${APP_DIR}" PM2_APP="${PM2_APP}" \
    NGINX_CONF_SRC="${NGINX_CONF_SRC}" NGINX_CONF_DST="${NGINX_CONF_DST}" \
    NGINX_LINK="${NGINX_LINK}" \
    HEALTH_URL_INTERNAL="${HEALTH_URL_INTERNAL}" \
    bash -se <<'REMOTE'
set -euo pipefail

cd "${APP_DIR}"

echo "==> git pull --ff-only"
git pull --ff-only origin main

echo "==> npm ci (dev deps required for build)"
NODE_ENV=development npm ci --no-audit --no-fund

echo "==> build"
GIT_SHA="$(git rev-parse --short HEAD)" npm run build

echo "==> migrate DB"
./backend/db/migrate_pg.sh

if [[ -n "${NGINX_CHECKSUM_LOCAL}" ]] && [[ -f "${NGINX_CONF_DST}" ]]; then
  NGINX_CHECKSUM_REMOTE=$(sha256sum "${NGINX_CONF_DST}" | awk '{print $1}')
else
  NGINX_CHECKSUM_REMOTE="absent"
fi

if [[ "${NGINX_CHECKSUM_LOCAL}" != "${NGINX_CHECKSUM_REMOTE}" ]]; then
  echo "==> nginx config changed; installing and reloading"
  cp "${APP_DIR}/${NGINX_CONF_SRC}" "${NGINX_CONF_DST}"
  [[ -L "${NGINX_LINK}" ]] || ln -s "${NGINX_CONF_DST}" "${NGINX_LINK}"
  nginx -t
  systemctl reload nginx
else
  echo "==> nginx config unchanged"
fi

echo "==> pm2 (startOrReload from ecosystem config)"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

# Health gate: db must be ok. gallery_source is informational.
echo "==> health check (internal)"
for i in 1 2 3 4 5 6; do
  body=$(curl -fsS "${HEALTH_URL_INTERNAL}" || true)
  if [[ -n "${body}" ]]; then
    echo "${body}"
    db=$(printf '%s' "${body}" | sed -n 's/.*"db":"\([^"]*\)".*/\1/p')
    if [[ "${db}" == "ok" ]]; then
      echo "==> health OK (db=${db})"
      exit 0
    fi
  fi
  sleep 5
done

echo "!! health check failed" >&2
exit 1
REMOTE

say "Deploy complete."
say "Public health (if DNS is up): curl ${HEALTH_URL_PUBLIC}"
