#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/test-env.sh
source "$SCRIPT_DIR/lib/test-env.sh"

ENV_ARG="$(parse_env_arg "$@")"
load_test_env "$ENV_ARG"
require_test_safety

"$SCRIPT_DIR/test-db-start.sh" --env "$TEST_ENV_FILE"

PSQL_BIN="$(find_pg_bin psql)"
SUPERUSER="${BIRDS_TEST_SUPERUSER:-$(id -un)}"

echo "Dropping and recreating $PGDATABASE on $PGHOST:$PGPORT"
env -u PGHOST -u PGUSER -u PGPASSWORD "$PSQL_BIN" -p "$PGPORT" -d postgres -U "$SUPERUSER" -v ON_ERROR_STOP=1 \
  -v db_name="$PGDATABASE" \
  -v owner_user="$MIGRATION_PGUSER" <<'SQL'
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'db_name'
  AND pid <> pg_backend_pid();

SELECT format('DROP DATABASE IF EXISTS %I', :'db_name') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db_name', :'owner_user') \gexec
SQL

# The ribbon fixture marker (.local/ribbon-fixture-marker.json) is bound to
# the OLD database's identity (pg_database.oid), which just changed — a
# marker surviving this reset would describe a database that no longer
# exists. Remove it so unseed-ribbon-fixture.mjs never trusts it (CC1 P2-1;
# owned here, by the thing that invalidates it, not by seed/unseed).
MARKER="$SCRIPT_DIR/../.local/ribbon-fixture-marker.json"
if [ -f "$MARKER" ]; then
  rm -f "$MARKER"
  echo "Removed stale ribbon fixture marker ($MARKER)."
fi

echo "Reset complete. Run scripts/test-db-migrate.sh next."
