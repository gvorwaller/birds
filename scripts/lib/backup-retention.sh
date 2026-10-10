#!/bin/bash
# Dated retention for the prod pg_dump (td-cf46cf).
#
# backup-pg.sh overwrites prod/birds.pgdump every night and the Carbon Copy
# Cloner task that copies data/backup/ to the NAS mirrors it with SafetyNet
# off (verified 2026-10-09), so without this there is exactly one day of
# history: a bad change noticed a day late would already be in the backup.
#
# keep_dated_dump  <dump> <history_dir> <yyyy-mm-dd>
#   Hard-links the verified dump as history/birds-<day>.pgdump. A hard link
#   costs no space here (the next night's dump is a NEW file moved into place,
#   so the link keeps the old bytes); the NAS copy stores each file in full.
# prune_dated_dumps <history_dir> <yyyy-mm-dd today>
#   Keeps the last 7 days, plus Sunday dumps from the last 35 days (≈ 4
#   weekly); deletes older birds-*.pgdump files. Never touches other files.

keep_dated_dump() {
  local dump=$1 dir=$2 day=$3
  mkdir -p "${dir}"
  ln -f "${dump}" "${dir}/birds-${day}.pgdump"
}

# Days between two yyyy-mm-dd dates (BSD/macOS date; UTC so DST can't skew).
_days_between() {
  local a b
  a=$(TZ=UTC date -j -f %Y-%m-%d "$1" +%s) || return 1
  b=$(TZ=UTC date -j -f %Y-%m-%d "$2" +%s) || return 1
  echo $(( (b - a) / 86400 ))
}

prune_dated_dumps() {
  # Returns non-zero if any dump that should go could not be removed. Callers
  # run this in an `if`, where errexit is suspended, so failures must be
  # counted explicitly (CODEX1).
  local dir=$1 today=$2 f day age dow failed=0
  [[ -d "${dir}" ]] || return 0
  for f in "${dir}"/birds-*.pgdump; do
    [[ -e "${f}" ]] || continue
    day=$(basename "${f}" .pgdump); day=${day#birds-}
    [[ "${day}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
    age=$(_days_between "${day}" "${today}") || continue
    (( age < 7 )) && continue
    dow=$(TZ=UTC date -j -f %Y-%m-%d "${day}" +%u)
    (( dow == 7 && age < 35 )) && continue
    rm -f "${f}" || failed=1
  done
  return "${failed}"
}
