#!/usr/bin/env bash
# Shared helpers for the isolated local test environment (birds).
# Test cluster: 127.0.0.1:15436, database birds_test.
# Reserved ports (NEVER): 5433=BTC-dashboard, 5434=madonnahist, 5435=prod tunnel.

find_repo_root() {
  local dir
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  printf '%s\n' "$dir"
}

resolve_env_file() {
  local repo_root="$1"
  local env_file="${2:-$repo_root/.env.test}"
  if [[ "$env_file" != /* ]]; then
    env_file="$repo_root/$env_file"
  fi
  printf '%s\n' "$env_file"
}

load_test_env() {
  REPO_ROOT="$(find_repo_root)"
  TEST_ENV_FILE="$(resolve_env_file "$REPO_ROOT" "${1:-}")"

  if [[ ! -f "$TEST_ENV_FILE" ]]; then
    echo "ERROR: test env file not found: $TEST_ENV_FILE" >&2
    echo "Copy .env.test.example to .env.test and adjust local-only values." >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  source "$TEST_ENV_FILE"
  set +a

  PGHOST="${PGHOST:-127.0.0.1}"
  PGPORT="${PGPORT:-15436}"
  PGDATABASE="${PGDATABASE:-birds_test}"
  PGUSER="${PGUSER:-birds_app}"
  PGPASSWORD="${PGPASSWORD:-}"
  MIGRATION_PGUSER="${MIGRATION_PGUSER:-birds_owner}"
  MIGRATION_PGPASSWORD="${MIGRATION_PGPASSWORD:-}"
  BIRDS_TEST_PGDATA="${BIRDS_TEST_PGDATA:-$REPO_ROOT/.local/postgres-test}"
  BIRDS_TEST_PGLOG="${BIRDS_TEST_PGLOG:-$REPO_ROOT/.local/postgres-test.log}"
}

require_test_safety() {
  if [[ "${BIRDS_ENV:-}" != "test" ]]; then
    echo "ERROR: BIRDS_ENV must be 'test' for local test DB commands." >&2
    exit 1
  fi

  if [[ "$PGPORT" == "5433" || "$PGPORT" == "5434" || "$PGPORT" == "5435" ]]; then
    echo "ERROR: refusing reserved port $PGPORT (5433=BTC-dashboard, 5434=madonnahist, 5435=production tunnel)." >&2
    exit 1
  fi

  if [[ "$PGDATABASE" == "birds" ]]; then
    echo "ERROR: refusing production database name 'birds' for local tests." >&2
    exit 1
  fi

  if [[ "$PGUSER" != "birds_app" || "$MIGRATION_PGUSER" != "birds_owner" ]]; then
    echo "ERROR: migrations hard-code canonical role names; isolated tests must use:" >&2
    echo "  PGUSER=birds_app" >&2
    echo "  MIGRATION_PGUSER=birds_owner" >&2
    exit 1
  fi

  if [[ -z "$PGPASSWORD" || -z "$MIGRATION_PGPASSWORD" ]]; then
    echo "ERROR: test DB role passwords must be set in $TEST_ENV_FILE." >&2
    exit 1
  fi
}

parse_env_arg() {
  local env_file=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env)
        if [[ -z "${2:-}" ]]; then
          echo "ERROR: --env requires a file path" >&2
          exit 1
        fi
        env_file="$2"
        shift 2
        ;;
      *)
        echo "ERROR: unknown argument: $1" >&2
        exit 1
        ;;
    esac
  done
  printf '%s\n' "$env_file"
}

find_pg_bin() {
  local name="$1"
  if [[ -x "/opt/homebrew/opt/postgresql@17/bin/$name" ]]; then
    printf '%s\n' "/opt/homebrew/opt/postgresql@17/bin/$name"
  elif command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
  else
    echo "ERROR: $name not found. Install PostgreSQL 17 or add it to PATH." >&2
    exit 1
  fi
}
