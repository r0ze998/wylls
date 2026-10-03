#!/usr/bin/env bash
# Stops the playtest cleanly (PT-A): the babysitter first (so nothing restarts
# the stack), then the stack and every component in reverse start order (each
# gets SIGINT and 15 s before SIGKILL; the chain, the keepers' journals and
# the relay's state are all crash-safe, so even a kill -9 loses nothing but
# the last block), then one last backup of the quiet state.
#
#   scripts/playtest-down.sh [--no-backup]
#
# Keeps everything on disk: scripts/playtest-up.sh continues the same season
# (the game clock is the chain's slot count, so the time it was down is not
# game time). Does NOT stop cloudflared (it is yours): stop it with Ctrl-C in
# its terminal, or `kill $(cat <data>/cloudflared.pid)`; the players see the
# tunnel's error page meanwhile.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=playtest-lib.sh
. "$HERE/playtest-lib.sh"
BACKUP=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-backup) BACKUP=0 ;;
    -h|--help) pt_help "$0"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
export PSF_REPO="$PT_ROOT" FRONTIER_BIN="$PT_BIN" PT_DATA PT_RUN PT_RUN_ID

mkdir -p "$PT_DATA"
touch "$PT_DATA/STOP"
if [ -f "$PT_RUN/state.json" ]; then
  "$PT_STACK" down --run-id "$PT_RUN_ID" --runs-dir "$PT_RUNS"
else
  echo "no run at $PT_RUN (nothing to stop)"
fi
# the babysitter leaves once the stack is gone and STOP exists
if bpid="$(pt_alive_pid "$PT_DATA/supervise.pid" playtest-supervise)"; then
  for _ in $(seq 1 45); do kill -0 "$bpid" 2>/dev/null || break; sleep 2; done
  if kill -0 "$bpid" 2>/dev/null; then echo "the babysitter (pid $bpid) did not leave; terminating it"; kill "$bpid" 2>/dev/null; fi
fi
# PT-E: the sentinel (a second watcher, playtest-up.sh starts it) goes with it
if spid="$(pt_alive_pid "$PT_DATA/sentinel.pid" playtest-sentinel)"; then kill "$spid" 2>/dev/null; fi
rm -f "$PT_DATA/supervise.pid" "$PT_DATA/stack.pid" "$PT_DATA/sentinel.pid"
if [ $BACKUP -eq 1 ] && [ -f "$PT_RUN/state.json" ]; then
  bash "$HERE/playtest-backup.sh" || echo "WARNING: the final backup failed"
fi
if pgrep -f "cloudflared.*tunnel" > /dev/null 2>&1; then
  echo "NOTE: cloudflared is still running (it is not ours to stop): players reach nothing until you stop it or start the stack again."
fi
echo "stopped. Data kept in $PT_DATA; scripts/playtest-up.sh continues the season."
