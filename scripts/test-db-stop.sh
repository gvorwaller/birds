#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/test-env.sh
source "$SCRIPT_DIR/lib/test-env.sh"

ENV_ARG="$(parse_env_arg "$@")"
load_test_env "$ENV_ARG"
require_test_safety

PG_CTL_BIN="$(find_pg_bin pg_ctl)"

if [[ ! -f "$BIRDS_TEST_PGDATA/PG_VERSION" ]]; then
  echo "No local test Postgres cluster found at $BIRDS_TEST_PGDATA"
  exit 0
fi

if "$PG_CTL_BIN" -D "$BIRDS_TEST_PGDATA" status >/dev/null 2>&1; then
  "$PG_CTL_BIN" -D "$BIRDS_TEST_PGDATA" -w stop
  echo "Stopped local test Postgres."
else
  echo "Local test Postgres is not running."
fi
