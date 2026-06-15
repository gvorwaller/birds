#!/usr/bin/env bash
# One-shot: bring up the local PostgreSQL 17 test cluster and apply migrations.
#
#   - Cluster:  127.0.0.1:15436, database birds_test (matches prod, which is PG17).
#   - Idempotent: safe to run repeatedly. Inits the data dir on first run,
#     starts it if stopped, ensures the birds_owner/birds_app roles + database,
#     then runs any pending migrations.
#   - Reads .env.test for ports, passwords, and BIRDS_ENV=test safety guards.
#
# After this, run the app against the test DB:
#   npx vite dev --host 127.0.0.1 --port 5178 --strictPort --mode test
#
# See CLAUDE.md → "Local development & test database" for the full story.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# test-db-migrate.sh starts the cluster (via test-db-start.sh) and then migrates.
"$SCRIPT_DIR/test-db-migrate.sh" "$@"

echo
echo "Local test DB ready: 127.0.0.1:15436 / birds_test (PostgreSQL 17)."
echo "Run the app in test mode:"
echo "  npx vite dev --host 127.0.0.1 --port 5178 --strictPort --mode test"
