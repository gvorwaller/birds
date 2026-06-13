#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/test-env.sh
source "$SCRIPT_DIR/lib/test-env.sh"

ENV_ARG="$(parse_env_arg "$@")"
load_test_env "$ENV_ARG"
require_test_safety

echo "Local test environment is safe:"
echo "  env file: $TEST_ENV_FILE"
echo "  database: $PGHOST:$PGPORT/$PGDATABASE"
echo "  app role: $PGUSER"
echo "  data dir: $BIRDS_TEST_PGDATA"
