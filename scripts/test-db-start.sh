#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/test-env.sh
source "$SCRIPT_DIR/lib/test-env.sh"

ENV_ARG="$(parse_env_arg "$@")"
load_test_env "$ENV_ARG"
require_test_safety

INITDB_BIN="$(find_pg_bin initdb)"
PG_CTL_BIN="$(find_pg_bin pg_ctl)"
PSQL_BIN="$(find_pg_bin psql)"
SUPERUSER="${BIRDS_TEST_SUPERUSER:-$(id -un)}"

mkdir -p "$REPO_ROOT/.local"

if [[ ! -f "$BIRDS_TEST_PGDATA/PG_VERSION" ]]; then
  echo "Initializing local test Postgres cluster at $BIRDS_TEST_PGDATA"
  "$INITDB_BIN" -D "$BIRDS_TEST_PGDATA" --auth-local=trust --auth-host=scram-sha-256 --no-instructions >/dev/null
fi

if "$PG_CTL_BIN" -D "$BIRDS_TEST_PGDATA" status >/dev/null 2>&1; then
  echo "Local test Postgres already running."
else
  echo "Starting local test Postgres on $PGHOST:$PGPORT"
  "$PG_CTL_BIN" -D "$BIRDS_TEST_PGDATA" -l "$BIRDS_TEST_PGLOG" -o "-p $PGPORT -h $PGHOST" -w start
fi

env -u PGHOST -u PGUSER -u PGPASSWORD "$PSQL_BIN" -p "$PGPORT" -d postgres -U "$SUPERUSER" -v ON_ERROR_STOP=1 \
  -v owner_user="$MIGRATION_PGUSER" \
  -v owner_pw="$MIGRATION_PGPASSWORD" \
  -v app_user="$PGUSER" \
  -v app_pw="$PGPASSWORD" \
  -v db_name="$PGDATABASE" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'owner_user', :'owner_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'owner_user', :'owner_pw') \gexec

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'app_user', :'app_pw') \gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'db_name', :'owner_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec
SQL

echo "Ready: $PGHOST:$PGPORT/$PGDATABASE"
