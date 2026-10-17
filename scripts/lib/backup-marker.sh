#!/bin/bash
# Records a verified prod backup on prod itself (td-a47c0d slice 1b), so
# Admin → Server health can show when the last one happened and flag it as
# stale. backup-pg.sh runs on the owner's Mac; without this, prod has no
# record of any backup.
#
# backup_marker_sql <bytes>
#   Prints the one statement that replaces the 'backup' row of ops_markers
#   (migration 0089) with now() and the dump's size. <bytes> must be digits.
# backup_marker_remote_sql <bytes>
#   The same statement behind lock and statement timeouts: a session holding
#   the row must make the write fail fast, never wait.
# run_with_deadline <seconds> <command...>
#   Runs the command, killing it once <seconds> pass. Returns its status, or
#   non-zero when it was killed.
# record_backup_marker <bytes> <droplet> <port> <db> <ssh opts...>
#   Runs the remote statement over SSH as the postgres superuser, the way
#   backup-pg.sh already runs pg_dump, within BACKUP_MARKER_DEADLINE_S
#   (default 60). Returns non-zero on any failure; the caller warns and keeps
#   the backup that just succeeded.

backup_marker_sql() {
  local bytes=${1//[[:space:]]/} # wc -c pads its count with spaces
  if [[ ! "${bytes}" =~ ^[0-9]+$ ]]; then
    echo "backup_marker_sql: bytes must be digits, got '${bytes}'" >&2
    return 1
  fi
  printf "INSERT INTO ops_markers (name, at, bytes) VALUES ('backup', now(), %s) ON CONFLICT (name) DO UPDATE SET at = EXCLUDED.at, bytes = EXCLUDED.bytes;" "${bytes}"
}

backup_marker_remote_sql() {
  local sql
  sql="$(backup_marker_sql "$1")" || return 1
  printf "SET lock_timeout = '5s'; SET statement_timeout = '15s'; %s" "${sql}"
}

run_with_deadline() {
  local secs=$1
  shift
  "$@" &
  local pid=$!
  # The watcher's output goes nowhere, so a sleep it leaves behind can never
  # hold the caller's stdout (CCC's log) open.
  ( sleep "${secs}" && kill -TERM "${pid}" ) </dev/null >/dev/null 2>&1 &
  local watcher=$!
  local rc=0
  wait "${pid}" || rc=$?
  kill "${watcher}" 2>/dev/null || true
  wait "${watcher}" 2>/dev/null || true
  return "${rc}"
}

record_backup_marker() {
  local bytes=$1 droplet=$2 port=$3 db=$4
  shift 4
  local sql
  sql="$(backup_marker_remote_sql "${bytes}")" || return 1
  [[ "${port}" =~ ^[0-9]+$ && "${db}" =~ ^[a-z_]+$ ]] || return 1
  # The statement has no double quotes, $ or backslashes, so it is safe
  # inside the remote command's double quotes.
  run_with_deadline "${BACKUP_MARKER_DEADLINE_S:-60}" ssh "$@" "${droplet}" \
    "sudo -u postgres env PGCONNECT_TIMEOUT=10 psql -X -q -v ON_ERROR_STOP=1 -p '${port}' -d '${db}' -c \"${sql}\""
}
