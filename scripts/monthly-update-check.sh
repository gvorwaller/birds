#!/bin/bash
# Monthly update check (td-626d50 follow-up). Runs from the LaunchAgent
# com.gaylon.birds-update-check (1st of each month; launchd runs a missed
# slot at the next wake). Agent/automation tool — never an owner step.
#
# Checks, all read-only:
#   droplet  pgdg/nodesource/kernel/nginx/openssl packages pending (these are
#            NOT covered by unattended-upgrades — owner decision 2026-10-10:
#            keep them manual), /var/run/reboot-required, Node major vs EOL
#   birds    npm audit (minus scripts/update-check-accepted.txt) and
#            in-range updates (npm outdated: wanted != current)
# Output:   ~/Library/Logs/birds-update-check/<YYYY-MM>.md every run. If any
#           item needs action: one td task "Monthly update check <YYYY-MM>"
#           (not duplicated on a re-run) and a macOS notification.
#
# Flags: --no-td  write the report only (testing).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# launchd gives a bare PATH: find Homebrew, td and the newest nvm Node.
NODE_BIN="$(ls -d "${HOME}"/.nvm/versions/node/v*/bin 2>/dev/null | sort -V | tail -1)"
export PATH="${NODE_BIN}:${HOME}/go/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
OPS_ENV="${BIRDS_OPS_ENV:-${PROJECT_ROOT}/.local/ops.env}"
ACCEPTED_FILE="${SCRIPT_DIR}/update-check-accepted.txt"
MONTH="$(date +%Y-%m)"
LOG_DIR="${HOME}/Library/Logs/birds-update-check"
REPORT="${LOG_DIR}/${MONTH}.md"
NODE22_EOL="2027-04-30"
FILE_TD=1
[[ "${1:-}" == "--no-td" ]] && FILE_TD=0

mkdir -p "${LOG_DIR}"
cd "${PROJECT_ROOT}" || exit 1
items=()          # one line per actionable item
notes=()          # informational lines

# ── droplet ──────────────────────────────────────────────────────────────
if [[ -f "${OPS_ENV}" ]]; then
  # shellcheck disable=SC1090
  source "${OPS_ENV}"
fi
if [[ -n "${BIRDS_DROPLET_SSH:-}" ]]; then
  droplet="$(ssh -o BatchMode=yes -o ConnectTimeout=15 "${BIRDS_DROPLET_SSH}" '
    apt list --upgradable 2>/dev/null | grep -E "^(postgresql|libpq|nodejs|linux-image|nginx|openssl|libssl)" | cut -d" " -f1,2,6 | tr -d "]"
    echo "@@reboot $( [ -f /var/run/reboot-required ] && echo yes || echo no )"
    echo "@@kernel $(uname -r) latest=$(ls -t /boot/vmlinuz-* | head -1 | sed s,/boot/vmlinuz-,,)"
    echo "@@node $(node --version)"
  ' 2>&1)"
  if [[ $? -ne 0 ]]; then
    items+=("Droplet unreachable for the update check: ${droplet//$'\n'/ }")
  else
    while IFS= read -r line; do
      case "${line}" in
        "@@reboot yes") items+=("Droplet: a reboot is pending (/var/run/reboot-required)") ;;
        "@@reboot no") ;;
        @@kernel*) notes+=("Droplet kernel: ${line#@@kernel }") ;;
        @@node*)
          node_v="${line#@@node }"; notes+=("Droplet Node: ${node_v}")
          if [[ "${node_v}" == v22.* && "$(date +%Y-%m-%d)" > "2027-01-01" ]]; then
            items+=("Droplet Node ${node_v}: Node 22 ends ${NODE22_EOL} — move to Node 24 LTS (td-4701cd)")
          fi ;;
        "") ;;
        *) items+=("Droplet package update pending: ${line}") ;;
      esac
    done <<< "${droplet}"
  fi
else
  items+=("No BIRDS_DROPLET_SSH in .local/ops.env — droplet not checked")
fi

# ── birds npm ────────────────────────────────────────────────────────────
# A finding is accepted when the package is listed, or when it is flagged only
# through dependencies that are all accepted (e.g. Kit flagged via cookie).
accepted_list="$(grep -vE '^\s*(#|$)' "${ACCEPTED_FILE}" 2>/dev/null | awk '{print $1}' | paste -sd, -)"
audit="$(npm audit --json 2>/dev/null | ACCEPTED="${accepted_list}" node -e '
  const ok = new Set((process.env.ACCEPTED || "").split(",").filter(Boolean));
  let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
    let v; try { v = JSON.parse(s).vulnerabilities || {}; } catch { console.log("error -"); return; }
    const isOk = (k, seen = new Set()) => {
      if (ok.has(k)) return true;
      if (seen.has(k) || !v[k]) return false;
      seen.add(k);
      return v[k].via.every((x) => typeof x === "string" && isOk(x, seen));
    };
    for (const [k, x] of Object.entries(v))
      console.log((isOk(k) ? "accepted " : "action ") + k + " " + x.severity +
        (x.via.every((y) => typeof y === "string") ? " (via " + x.via.join(", ") + ")" : ""));
  })')"
while IFS= read -r line; do
  [[ -z "${line}" ]] && continue
  case "${line}" in
    "error -") items+=("npm audit failed to run") ;;
    accepted*) notes+=("npm audit (accepted): ${line#accepted }") ;;
    action*) items+=("npm audit: ${line#action } — see 'npm audit' in ~/birds") ;;
  esac
done <<< "${audit}"

outdated="$(npm outdated --json 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
    try { for (const [k, x] of Object.entries(JSON.parse(s || "{}")))
      console.log((x.current !== x.wanted ? "inrange " : "major ") + k + " " + x.current + " -> " + (x.current !== x.wanted ? x.wanted : x.latest)); } catch {} })')"
while IFS= read -r line; do
  [[ -z "${line}" ]] && continue
  case "${line}" in
    inrange*) notes+=("In-range update available: ${line#inrange }") ;;
    major*) notes+=("Major available (not urgent): ${line#major }") ;;
  esac
done <<< "${outdated}"

# ── report ───────────────────────────────────────────────────────────────
{
  echo "# Birds monthly update check — ${MONTH}"
  echo
  echo "_Run $(date '+%Y-%m-%d %H:%M %Z') by scripts/monthly-update-check.sh_"
  echo
  echo "## Needs action (${#items[@]})"
  if [[ ${#items[@]} -eq 0 ]]; then echo "- nothing"; else printf -- '- %s\n' "${items[@]}"; fi
  echo
  echo "## For information"
  printf -- '- %s\n' "${notes[@]:-none}"
  echo
  echo "Checklist before applying droplet updates: docs/2026-10-10-dependency-security-inventory.md and the"
  echo "PG release notes' Migration section; keep pgdg/nodesource manual (owner, 2026-10-10)."
} > "${REPORT}"
echo "[update-check] ${#items[@]} actionable item(s); report: ${REPORT}"

if [[ ${#items[@]} -gt 0 && ${FILE_TD} -eq 1 ]]; then
  title="Monthly update check ${MONTH}: ${#items[@]} item(s) need action"
  if td list -a -q "Monthly update check ${MONTH}" 2>/dev/null | grep -q "Monthly update check ${MONTH}"; then
    echo "[update-check] td task for ${MONTH} already exists — not duplicating"
  else
    td create "${title}" --type task --priority P2 --labels ops,deps --description-file "${REPORT}" 2>&1 | tail -1
  fi
  osascript -e "display notification \"${#items[@]} update item(s) — see td / ${REPORT}\" with title \"Birds monthly update check\"" >/dev/null 2>&1 || true
fi
exit 0
