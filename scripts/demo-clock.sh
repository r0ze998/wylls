#!/bin/sh
# The local test chain's clock, for recording a demo (local test chain only).
#   scripts/demo-clock.sh <base-port> status            the chain's status (slot, scale, paused, ...)
#   scripts/demo-clock.sh <base-port> turn              the current turn, as the herald sees it
#   scripts/demo-clock.sh <base-port> scale <n>         game seconds per real second (20 = a turn every 30 s)
#   scripts/demo-clock.sh <base-port> skip <turns>      run fast until that many turns have passed, then back to the scale set before
#   scripts/demo-clock.sh <base-port> pause             stop the chain's clock (no block until resume)
#   scripts/demo-clock.sh <base-port> resume            start it again (an AI season leaves the chain paused at its end)
# <base-port> is the stack's base: the chain answers on base+10, the herald on base+40.
# skip runs at x400 (a turn every 1.5 s) until 3 turns before the target, then at x60 (a turn every
# 10 s) so it stops on the turn asked for, and prints the turn reached.
# turn asks the herald up to 5 times, 1 s apart, before it gives up with one line.
# A skipped stretch must be marked "time skipped" in a recording.
set -eu
base=$1; cmd=${2:-status}
rpc_port=$((base + 10)); herald_port=$((base + 40))
rpc() { curl -s -m 5 "http://127.0.0.1:$rpc_port" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }
# One field of the chain's status, as JSON (scale: 20.0, paused: false).
status_field() {
  s=$(rpc frontier_status '[]') || s=
  S="$s" python3 -c "import os,sys,json;print(json.dumps(json.loads(os.environ['S'])['result'][sys.argv[1]]))" "$1" 2>/dev/null || {
    echo "demo-clock: the chain on port $rpc_port did not answer" >&2; return 1; }
}
turn_once() {
  s=$(curl -s -m 3 "http://127.0.0.1:$herald_port/h/season") || return 1
  n=$(curl -s -m 3 "http://127.0.0.1:$herald_port/h/status") || return 1
  S="$s" N="$n" python3 -c "import os,json;print((json.loads(os.environ['N'])['live'][1]-json.loads(os.environ['S'])['genesisTs'])//600)" 2>/dev/null
}
turn() {
  try=1
  while :; do
    if t=$(turn_once); then echo "$t"; return 0; fi
    [ "$try" -ge 5 ] && break
    try=$((try + 1)); sleep 1
  done
  echo "demo-clock: the herald on port $herald_port did not answer (5 tries)" >&2
  return 1
}
case "$cmd" in
  status) rpc frontier_status '[]'; echo ;;
  turn) turn ;;
  scale) rpc frontier_setScale "[$3]"; echo ;;
  pause) rpc frontier_pause '[]'; echo ;;
  resume) rpc frontier_resume '[]'; echo ;;
  skip)
    prev=$(status_field scale) || exit 1
    if [ "$(status_field paused)" = true ]; then
      echo "demo-clock: the chain is paused; resume it first" >&2; exit 1
    fi
    now=$(turn) || exit 1
    target=$((now + $3))
    restore() { rpc frontier_setScale "[$prev]" >/dev/null || true; }
    trap 'restore; exit 1' INT TERM
    # fast until 3 turns before the target, then slowly onto it
    for leg in "400 $((target - 3))" "60 $target"; do
      set -- $leg
      [ "$now" -ge "$2" ] && continue
      rpc frontier_setScale "[$1]" >/dev/null
      while [ "$now" -lt "$2" ]; do
        sleep 1
        now=$(turn) || { restore; exit 1; }
      done
    done
    restore
    echo "turn $now" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
