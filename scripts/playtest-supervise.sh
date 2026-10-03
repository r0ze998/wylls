#!/usr/bin/env bash
# The playtest's babysitter (PT-A): keeps `frontier-stack` alive for the whole
# playtest and runs the monitor. Started by scripts/playtest-up.sh (detached,
# under caffeinate); stopped by scripts/playtest-down.sh (which creates the
# STOP file first). Never run it twice: it refuses when another one is alive.
#
# What it does, forever:
#   * the first time (no season in the run directory) `frontier-stack up`;
#     every time after that `frontier-stack resume` (same run, same season; the
#     chain recovers from its ledger and snapshots, the keepers from their
#     journals, the relay from its state file). The stack's own supervisor
#     restarts every component that dies; this script restarts the stack
#     itself, with a back-off (10 s, 20 s, ... 5 min) when it keeps failing
#     quickly, and gives up on a first start that fails three times;
#   * every 30 s runs `playtest-watch.mjs tick`: health report, alarm files,
#     log rotation and the hourly backup;
#   * stops when STOP exists (playtest-down.sh), or when the stack finishes
#     the season (exit 0).
#
# Exit codes: 0 stopped on purpose or the season is over, 1 gave up on a first
# start, 3 another babysitter is alive.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=playtest-lib.sh
. "$HERE/playtest-lib.sh"

mkdir -p "$PT_LOGS" "$PT_STATUS"
chmod 700 "$PT_DATA" 2>/dev/null || true
if other="$(pt_alive_pid "$PT_DATA/supervise.pid" playtest-supervise)" && [ "$other" != "$$" ]; then
  echo "playtest-supervise: already running (pid $other)" >&2
  exit 3
fi
echo $$ > "$PT_DATA/supervise.pid"

export PSF_REPO="$PT_ROOT"
export FRONTIER_BIN="$PT_BIN"
export PATH="$(dirname "$PT_NODE"):$PATH"
export PT_DATA PT_RUN PT_RUN_ID
export PT_BACKUP="$HERE/playtest-backup.sh"
STACK_LOG="$PT_LOGS/stack.log"
TICK_SECS="${PLAYTEST_TICK_SECS:-30}"
STACK_PID=""
FAST_FAILS=0
FIRST_FAILS=0
LAST_TICK=0

has_season() {
  [ -f "$PT_RUN/state.json" ] || return 1
  "$PT_NODE" -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(s.play && s.play.genesis_ts ? 0 : 1)' "$PT_RUN/state.json" 2>/dev/null
}

start_stack() {
  local cfg cmd
  cfg="$(pt_effective_config)"
  if has_season; then cmd=resume; else cmd=up; fi
  START_CMD="$cmd"
  START_AT=$SECONDS
  pt_log "starting: frontier-stack $cmd (run $PT_RUN_ID)"
  # nice: the machine is shared; the game is light.
  nice -n 5 "$PT_STACK" "$cmd" --config "$cfg" >> "$STACK_LOG" 2>&1 &
  STACK_PID=$!
  echo "$STACK_PID" > "$PT_DATA/stack.pid"
}

on_term() {
  pt_log "playtest-supervise: signal received; leaving the stack as it is"
  rm -f "$PT_DATA/supervise.pid"
  exit 0
}
trap on_term TERM INT HUP

pt_log "playtest-supervise: pid $$, config $PT_CONFIG, data $PT_DATA"
while :; do
  if [ -e "$PT_DATA/STOP" ]; then
    # playtest-down.sh is stopping the stack; wait for the supervisor to go.
    if [ -n "$STACK_PID" ] && kill -0 "$STACK_PID" 2>/dev/null; then sleep 2; continue; fi
    pt_log "playtest-supervise: STOP requested; done"
    break
  fi
  if [ -z "$STACK_PID" ] || ! kill -0 "$STACK_PID" 2>/dev/null; then
    if [ -n "$STACK_PID" ]; then
      wait "$STACK_PID"; code=$?
      ran=$((SECONDS - START_AT))
      pt_log "frontier-stack ($START_CMD) exited with $code after ${ran}s"
      if [ -e "$PT_DATA/STOP" ]; then continue; fi
      if [ "$code" -eq 0 ]; then
        pt_log "playtest-supervise: the stack finished the season (exit 0); leaving the services up for the report"
        break
      fi
      if [ "$START_CMD" = up ] && ! has_season; then
        FIRST_FAILS=$((FIRST_FAILS + 1))
        if [ "$FIRST_FAILS" -ge 3 ]; then
          pt_log "playtest-supervise: the first start failed $FIRST_FAILS times (see $STACK_LOG); giving up"
          rm -f "$PT_DATA/supervise.pid"
          exit 1
        fi
      fi
      if [ "$ran" -lt 600 ]; then FAST_FAILS=$((FAST_FAILS + 1)); else FAST_FAILS=0; fi
      n=$((FAST_FAILS > 0 ? FAST_FAILS - 1 : 0))
      [ "$n" -gt 5 ] && n=5
      wait_s=$((10 << n))
      [ "$wait_s" -gt 300 ] && wait_s=300
      pt_log "restarting in ${wait_s}s (quick failures in a row: $FAST_FAILS)"
      for _ in $(seq 1 "$wait_s"); do [ -e "$PT_DATA/STOP" ] && break; sleep 1; done
      [ -e "$PT_DATA/STOP" ] && continue
    fi
    start_stack
  fi
  now=$SECONDS
  if [ $((now - LAST_TICK)) -ge "$TICK_SECS" ]; then
    LAST_TICK=$now
    "$PT_NODE" "$HERE/playtest-watch.mjs" tick >> "$PT_LOGS/watch.log" 2>&1 || pt_log "monitor tick failed (see watch.log)"
  fi
  sleep 3
done
rm -f "$PT_DATA/supervise.pid" "$PT_DATA/stack.pid"
exit 0
