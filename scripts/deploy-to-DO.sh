#!/usr/bin/env bash
# Deploy birds to the shared DigitalOcean droplet.
#
# Flow:
#   1. local pre-flight (clean tree, on main, pushed to origin)
#   2. (optional) push pending commits
#   3. SSH single-shot to the target in .local/ops.env (never the public domain):
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OPS_ENV="${BIRDS_OPS_ENV:-${PROJECT_ROOT}/.local/ops.env}"
if [[ -f "${OPS_ENV}" ]]; then
  # shellcheck disable=SC1090
  source "${OPS_ENV}"
fi
DROPLET_SSH="${BIRDS_DROPLET_SSH:-}"
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

Deploys current main to the configured droplet at ${APP_DIR}.
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

cd "${PROJECT_ROOT}"

[[ -n "${DROPLET_SSH}" ]] || die "Missing BIRDS_DROPLET_SSH. Define it in ${OPS_ENV}."

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
say "SSH configured droplet for remote deploy"

ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
    "${DROPLET_SSH}" \
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

# Health gate: db AND worker must be ok (a dead worker means loads queue
# silently forever — that must fail the deploy loudly). Worker needs a boot +
# first heartbeat, so the loop runs longer than the old db-only gate.
echo "==> pm2 process check"
if ! pm2 jlist | grep -q '"name":"birds-worker"'; then
  echo "!! birds-worker missing from pm2 process list" >&2
  exit 1
fi
# The sightings connectors (external sources: Norway, Sweden td-99eebf) idle
# without their secrets, so each must always be present and online. Present is
# not enough: each must stay online for 35 s, past PM2's min_uptime of 30 s
# (ecosystem.config.cjs), within 90 s, and BOTH must pass in the same pm2
# sample (one resetting while the other is up is a failure). pm2 can print
# warnings such as "[PM2][WARN] …" before the JSON, so the list is the first
# "[" from which the rest parses as a JSON array. Prints "<status> <uptime>
# <detail>": online and the smallest uptime only when every connector is online.
connector_state() {
  pm2 jlist | node -e '
    const NAMES = ["birds-connector-artsobs", "birds-connector-artportalen"];
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let list = null;
      for (let i = s.indexOf("["); i >= 0 && !list; i = s.indexOf("[", i + 1)) {
        try {
          const v = JSON.parse(s.slice(i));
          if (Array.isArray(v)) list = v;
        } catch {}
      }
      if (!list) return console.log("unreadable 0 -");
      const rows = NAMES.map((name) => {
        const p = list.find((x) => x && x.name === name);
        if (!p || !p.pm2_env) return { name, status: "missing", up: 0 };
        const status = String(p.pm2_env.status).replace(/\s+/g, "_");
        // A start time that is missing, zero, not a number or in the future is
        // not proof of uptime (CODEX1 R10): null would read as 1970.
        const started = p.pm2_env.pm_uptime;
        const sane = typeof started === "number" && Number.isFinite(started) && started > 0 && started <= Date.now();
        if (status === "online" && !sane) return { name, status: "bad_uptime", up: 0 };
        const up = status === "online" ? Math.floor((Date.now() - started) / 1000) : 0;
        return { name, status, up };
      });
      const bad = rows.find((r) => r.status !== "online");
      const detail = rows.map((r) => `${r.name.replace("birds-connector-", "")}=${r.status}:${r.up}`).join(",");
      console.log(bad ? `${bad.status} 0 ${detail}` : `online ${Math.min(...rows.map((r) => r.up))} ${detail}`);
    });'
}
conn_ok=0
for i in $(seq 1 18); do
  read -r conn_status conn_up conn_detail < <(connector_state || echo "unreadable 0 -")
  if [[ "${conn_status}" == "online" && "${conn_up}" -ge 35 ]]; then
    echo "==> sightings connectors online (${conn_detail})"
    conn_ok=1
    break
  fi
  sleep 5
done
if [[ "${conn_ok}" != 1 ]]; then
  echo "!! sightings connectors not staying online (${conn_detail:-status=${conn_status:-?}})" >&2
  exit 1
fi

echo "==> health check (internal)"
for i in $(seq 1 12); do
  body=$(curl -fsS "${HEALTH_URL_INTERNAL}" || true)
  if [[ -n "${body}" ]]; then
    echo "${body}"
    db=$(printf '%s' "${body}" | sed -n 's/.*"db":"\([^"]*\)".*/\1/p')
    worker=$(printf '%s' "${body}" | sed -n 's/.*"worker":"\([^"]*\)".*/\1/p')
    if [[ "${db}" == "ok" && "${worker}" == "ok" ]]; then
      echo "==> health OK (db=${db} worker=${worker})"
      # Hotspot search index (td-877997): the web process builds it at startup;
      # wait for it so the first search after the deploy does not. A slow
      # build only warns; searches still work (the first one waits for it).
      echo "==> waiting for the hotspot search index"
      for j in $(seq 1 36); do
        state=$(curl -fsS "${HEALTH_URL_INTERNAL}" | sed -n 's/.*"hub_index":"\([^"]*\)".*/\1/p' || true)
        if [[ "${state}" == "ready" ]]; then
          echo "==> hotspot search index ready (~$(( (j - 1) * 5 )) s after health OK)"
          exit 0
        fi
        sleep 5
      done
      echo "!! hotspot search index not ready after 180 s (state=${state:-?}); searches will build it" >&2
      exit 0
    fi
  fi
  sleep 5
done

echo "!! health check failed (db=${db:-?} worker=${worker:-?})" >&2
exit 1
REMOTE

say "Deploy complete."
say "Public health (if DNS is up): curl ${HEALTH_URL_PUBLIC}"
