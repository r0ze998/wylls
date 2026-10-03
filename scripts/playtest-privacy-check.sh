#!/usr/bin/env bash
# Looks for IP addresses in every file the playtest keeps (PT-E): the tester guide says none is written to
# any file of ours. Read-only. Run it once after the first requests through the tunnel and again after the
# first day; exit 0 when nothing is found, 1 when something is (the lines are printed with the file name, the
# address masked to its first two groups).
#
#   scripts/playtest-privacy-check.sh [--extra-ip A.B.C.D ...]
#
# Looked at: the run directory (relay state and event log, component logs, events.jsonl, herald files that are
# text), logs/, status/, backups/ and the invites directory are NOT read for codes (only the first three are
# searched; the invite CSVs hold codes and fragments, never addresses). Loopback (127.*), 0.0.0.0 and the
# sponsor's own bind lines are ignored. Binary files (the chain's ledger, snapshots, SQLite) are searched as text
# for dotted quads and for each --extra-ip given (use it with a TEST-NET address you used in a drill).
# A finding in a binary file can be a number that merely looks like an address: the file name tells you which.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=playtest-lib.sh
. "$HERE/playtest-lib.sh"
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --extra-ip) EXTRA+=("$2"); shift ;;
    -h|--help) pt_help "$0"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
found=0
RE='(^|[^0-9.])([0-9]{1,3}\.){3}[0-9]{1,3}($|[^0-9.])'
scan() { # scan <path>: dotted quads that are not loopback/any/private-bind noise
  local f="$1" hits
  hits="$(LC_ALL=C grep -a -o -E "$RE" "$f" 2>/dev/null | LC_ALL=C grep -a -o -E '([0-9]{1,3}\.){3}[0-9]{1,3}' | LC_ALL=C grep -a -v -E '^(127\.|0\.0\.0\.0$|255\.255\.|1\.1\.1\.1$)' | sort -u | head -5)"
  # four numbers with a group above 255 are not an address
  hits="$(printf '%s\n' "$hits" | awk -F. 'NF == 4 && $1 <= 255 && $2 <= 255 && $3 <= 255 && $4 <= 255')"
  if [ -n "$hits" ]; then
    printf 'FOUND  %s\n' "$f"
    printf '%s\n' "$hits" | awk -F. '{ printf "         %s.%s.x.x\n", $1, $2 }'
    found=1
  fi
}
roots=("$PT_RUN" "$PT_LOGS" "$PT_STATUS")
[ -d "$PT_BACKUPS" ] && roots+=("$PT_BACKUPS")
n=0
for r in "${roots[@]}"; do
  [ -d "$r" ] || continue
  while IFS= read -r f; do
    case "$f" in *.sock|*/secrets/*|*/keys/*|*token*) continue ;; esac
    n=$((n + 1)); scan "$f"
    for ip in ${EXTRA[@]+"${EXTRA[@]}"}; do
      if LC_ALL=C grep -a -q -F -- "$ip" "$f" 2>/dev/null; then printf 'FOUND  %s contains the given address %s\n' "$f" "$ip"; found=1; fi
    done
  done < <(find "$r" -type f -size -300M 2>/dev/null)
done
echo "searched $n files under $PT_RUN, $PT_LOGS, $PT_STATUS${PT_BACKUPS:+, $PT_BACKUPS}"
if [ $found -eq 0 ]; then echo "OK: no IP address found in the files the playtest keeps."; else echo "NOT OK: see FOUND lines above."; fi
exit $found
