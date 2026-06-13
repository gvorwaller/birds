#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/test-env.sh
source "$SCRIPT_DIR/lib/test-env.sh"

ENV_ARG="$(parse_env_arg "$@")"
load_test_env "$ENV_ARG"
require_test_safety

"$SCRIPT_DIR/test-db-start.sh" --env "$TEST_ENV_FILE"
"$REPO_ROOT/backend/db/migrate_pg.sh" --env "$TEST_ENV_FILE"
