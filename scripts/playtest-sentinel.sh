#!/usr/bin/env bash
# A tiny second watcher for the one thing the babysitter cannot watch: the babysitter itself (PT-E).
#
#   scripts/playtest-sentinel.sh [--once] [--every SECS]
#
# Every minute it checks that
#   * the babysitter (playtest-supervise.sh) is alive,
#   * the monitor wrote status/status.json in the last 5 minutes (a Mac that slept, a hung probe),
#   * no HEALTH-ALARM or LAG-ALARM file exists,
# and, when one of them fails, says so on this Mac: a notification and a spoken line (osascript, say),
# at most once every 10 minutes per problem. Nothing leaves the machine; no network. It does NOT restart
# anything. Run it in a Terminal tab of its own (or under `caffeinate -i`): it uses nothing but the files
# of the data directory. It stays silent while a STOP file exists (playtest-down.sh) and exits after --once.
#
# PT_NOTIFY=0 turns the sound off (tests); PT_NOTIFY=print appends the would-be commands to <data>/logs/notify.log.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=playtest-lib.sh
. "$HERE/playtest-lib.sh"
ONCE=0; EVERY=60
while [ $# -gt 0 ]; do
  case "$1" in
    --once) ONCE=1 ;;
    --every) EVERY="$2"; shift ;;
    -h|--help) pt_help "$0"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

say_it() { # say_it <title> <text>
  local mode="${PT_NOTIFY:-1}"
  [ "$mode" = 0 ] && return 0
  local t="${2//\"/ }" h="${1//\"/ }"
  if [ "$mode" = print ]; then
    mkdir -p "$PT_LOGS"; printf '%s osascript display notification "%s" with title "%s" | say %s\n' "$(date -u +%FT%TZ)" "$t" "$h" "$h" >> "$PT_LOGS/notify.log"; return 0
  fi
  osascript -e "display notification \"$t\" with title \"$h\" sound name \"Basso\"" >/dev/null 2>&1 || true
  (say "$h" >/dev/null 2>&1 &) || true
}

declare -a LAST_KEYS=() LAST_AT=()
throttled() { # throttled <key>: 0 when this problem was announced less than 10 minutes ago
  local k="$1" now i; now=$(date +%s)
  for i in "${!LAST_KEYS[@]}"; do
    if [ "${LAST_KEYS[$i]}" = "$k" ]; then
      if [ $((now - LAST_AT[i])) -lt 600 ]; then return 0; fi
      LAST_AT[i]=$now; return 1
    fi
  done
  LAST_KEYS+=("$k"); LAST_AT+=("$now"); return 1
}

check() {
  [ -e "$PT_DATA/STOP" ] && return 0
  local problems=()
  pt_alive_pid "$PT_DATA/supervise.pid" playtest-supervise >/dev/null || problems+=("babysitter-down|the babysitter is not running: nothing restarts the game. Run scripts/playtest-up.sh")
  local st="$PT_STATUS/status.json" age
  if [ -f "$st" ]; then
    age=$(( $(date +%s) - $(stat -f %m "$st" 2>/dev/null || echo 0) ))
    [ "$age" -gt 300 ] && problems+=("monitor-stale|the monitor has not written a status for $((age / 60)) minutes (the Mac slept or the babysitter hangs)")
  else
    problems+=("monitor-stale|there is no status file yet")
  fi
  [ -e "$PT_DATA/HEALTH-ALARM" ] && problems+=("health-alarm|HEALTH-ALARM is present: scripts/playtest-status.sh")
  [ -e "$PT_DATA/LAG-ALARM" ] && problems+=("lag-alarm|LAG-ALARM is present: scripts/playtest-status.sh")
  local p
  for p in ${problems[@]+"${problems[@]}"}; do
    pt_log "sentinel: ${p%%|*}: ${p#*|}"
    throttled "${p%%|*}" || say_it "Wylls playtest ${p%%|*}" "${p#*|}"
  done
  [ ${#problems[@]} -eq 0 ] && return 0 || return 1
}

if [ $ONCE -eq 1 ]; then check; exit $?; fi
pt_log "sentinel: watching $PT_DATA every ${EVERY}s (first look after a grace of ${PT_SENTINEL_GRACE:-240}s: the babysitter and the first status take a moment)"
sleep "${PT_SENTINEL_GRACE:-240}"
while :; do check || true; sleep "$EVERY"; done
