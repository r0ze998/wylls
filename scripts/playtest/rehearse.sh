#!/usr/bin/env bash
# One rehearsal of the friends' playtest, end to end, on this Mac only (PT-C): a stack at a chosen clock, an https
# stand-in for the tunnel, ~20 scripted friends (crowd.mjs), the drills (drills.mjs), a CPU/memory sampler, and at
# the end the numbers (crowd-report.mjs, playtest-metrics.mjs). Nothing here starts a real tunnel.
#
#   scripts/playtest/rehearse.sh --out DIR --scale N [--minutes M] [--testers 20] [--bots 60] [--port-shift 0]
#        [--tunnel-port 41102] [--plan "kill:keeper-a@25,..."] [--arrive-min 30] [--gap-mult 1] [--invites 26]
#        [--seed 1] [--keep-up] [--detach]
#
#   --out         everything of this rehearsal goes here (data/, config.toml, crowd/, drills.jsonl, sys.jsonl, results/, logs/)
#   --scale       the clock: 1 = the real clock, 10 = ten times faster. Ports: 41112-41123 shifted by --port-shift
#                 (12 for a second stack beside the first); the https stand-in listens on --tunnel-port (41100-41111)
#   --minutes     length of the crowd's play after the world opens (default 180)
#   --plan        drills, `kind@minutes after the crowd starts`, see drills.mjs ("" = none)
#   --detach      run in the background (nohup), write logs/rehearse.log and the exit code to logs/rc; returns at once
#   --keep-up     leave the stack running at the end (default: playtest-down.sh)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT=""; SCALE=1; MIN=180; TESTERS=20; BOTS=60; SHIFT=0; TPORT=41102; PLAN=""; ARRIVE=30; GAPM=1; NINV=26; SEED=1; KEEP=0; DETACH=0; THINK=4; WAITOPEN=60
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;; --scale) SCALE="$2"; shift 2 ;; --minutes) MIN="$2"; shift 2 ;; --testers) TESTERS="$2"; shift 2 ;;
    --bots) BOTS="$2"; shift 2 ;; --port-shift) SHIFT="$2"; shift 2 ;; --tunnel-port) TPORT="$2"; shift 2 ;; --plan) PLAN="$2"; shift 2 ;;
    --arrive-min) ARRIVE="$2"; shift 2 ;; --gap-mult) GAPM="$2"; shift 2 ;; --invites) NINV="$2"; shift 2 ;; --seed) SEED="$2"; shift 2 ;;
    --think) THINK="$2"; shift 2 ;; --keep-up) KEEP=1; shift ;; --detach) DETACH=1; shift ;;
    -h|--help) awk 'NR>1 && !/^#/ {exit} NR>1 {sub(/^# ?/,""); print}' "$0"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$OUT" ] || { echo "--out DIR is required" >&2; exit 2; }
mkdir -p "$OUT/logs" "$OUT/results" "$OUT/crowd"
OUT="$(cd "$OUT" && pwd)"
if [ $DETACH -eq 1 ]; then
  args=(--out "$OUT" --scale "$SCALE" --minutes "$MIN" --testers "$TESTERS" --bots "$BOTS" --port-shift "$SHIFT" --tunnel-port "$TPORT" --arrive-min "$ARRIVE" --gap-mult "$GAPM" --invites "$NINV" --seed "$SEED" --think "$THINK")
  [ -n "$PLAN" ] && args+=(--plan "$PLAN"); [ $KEEP -eq 1 ] && args+=(--keep-up)
  perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' -- nohup bash -c '"$0" "$@"; echo $? > "'"$OUT"'/logs/rc"' "$0" "${args[@]}" > "$OUT/logs/rehearse.log" 2>&1 < /dev/null &
  echo "rehearsal started in the background (pid $!); log $OUT/logs/rehearse.log, exit code will be in $OUT/logs/rc"
  exit 0
fi
ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
say() { echo "$(ts) $*"; }
RUN_ID="ptc-$(basename "$OUT")"
CFG="$OUT/config.toml"
node "$HERE/mkconfig.mjs" --out "$CFG" --run-id "$RUN_ID" --scale "$SCALE" --bots "$BOTS" --port-shift "$SHIFT" > /dev/null || exit 1
export PLAYTEST_DATA="$OUT/data" PLAYTEST_CONFIG="$CFG" PLAYTEST_RUN_ID="$RUN_ID"
. "$ROOT/scripts/playtest-lib.sh"
HERALD="$PT_HERALD_PORT"; RELAYPUB=$((PT_BASE_PORT + $(pt_cfg_in ports relay_public)))
say "rehearsal $RUN_ID: scale $SCALE, $TESTERS testers, $BOTS bots, crowd $MIN min; herald $HERALD, relay $RELAYPUB, https stand-in $TPORT"

say "stack up"
nice -n 5 "$ROOT/scripts/playtest-up.sh" --no-wait > "$OUT/logs/up.log" 2>&1 || { cat "$OUT/logs/up.log"; exit 1; }
until curl -sf "http://127.0.0.1:$HERALD/h/season" > /dev/null; do sleep 2; done
until curl -sf "http://127.0.0.1:$RELAYPUB/f/season" > /dev/null; do sleep 2; done
say "stack answers"
"$ROOT/scripts/playtest-invite.sh" "$NINV" --label friends-crowd --base-url "http://127.0.0.1:$HERALD" --out "$OUT/invites.csv" 2> "$OUT/logs/invite.log" || { cat "$OUT/logs/invite.log"; exit 1; }
chmod 600 "$OUT/invites.csv"

CERTS="$OUT/certs"; mkdir -p "$CERTS"
nohup node "$HERE/fake-tunnel.mjs" --listen "$TPORT" --herald "127.0.0.1:$HERALD" --cert-dir "$CERTS" --client-ip-from-header x-test-client --asleep-file "$OUT/ASLEEP" > "$OUT/logs/tunnel.log" 2>&1 &
TUNPID=$!; echo $TUNPID > "$OUT/tunnel.pid"
sleep 2; kill -0 $TUNPID 2>/dev/null || { cat "$OUT/logs/tunnel.log"; exit 1; }

# the crowd waits for the world to open (invite-check says "open"), then its clock starts
nohup nice -n 8 node "$HERE/crowd.mjs" --origin "https://wylls.test:$TPORT" --direct "http://127.0.0.1:$HERALD" --invites "$OUT/invites.csv" --out "$OUT/crowd" \
  --testers "$TESTERS" --minutes "$MIN" --arrive-min "$ARRIVE" --gap-mult "$GAPM" --think-median "$THINK" --seed "$SEED" --poll-s $([ "$SCALE" -ge 10 ] && echo 5 || echo 15) --wait-open-min "$WAITOPEN" > "$OUT/logs/crowd.log" 2>&1 &
CROWD=$!; echo $CROWD > "$OUT/crowd.pid"
nohup node "$HERE/sample.mjs" --state "$PT_RUN/state.json" --supervise-pid-file "$PT_DATA/supervise.pid" --crowd-pid "$CROWD" --extra "fake-tunnel=$TUNPID" --out "$OUT/sys.jsonl" --interval 30 --until-file "$OUT/SAMPLER-STOP" > "$OUT/logs/sample.log" 2>&1 &
SAMPLER=$!

if [ -n "$PLAN" ]; then
  # the drills' clock starts when the crowd's does: wait for "the world is open"
  until grep -q "starting the crowd\|starting anyway" "$OUT/logs/crowd.log" 2>/dev/null; do sleep 5; done
  START_MS=$(( $(date +%s) * 1000 ))
  nohup node "$HERE/drills.mjs" --data "$PT_DATA" --run "$RUN_ID" --herald "$HERALD" --relay "$RELAYPUB" --out "$OUT/drills.jsonl" --plan "$PLAN" \
    --asleep-file "$OUT/ASLEEP" --tunnel "https://wylls.test:$TPORT" --start-ms "$START_MS" > "$OUT/logs/drills.log" 2>&1 &
  DRILLS=$!
fi
say "crowd running (pid $CROWD)"
wait $CROWD; CROWD_RC=$?
say "crowd finished (exit $CROWD_RC)"
if [ -n "$PLAN" ]; then
  # give the last drill time to finish
  for _ in $(seq 1 120); do kill -0 "$DRILLS" 2>/dev/null || break; sleep 10; done
  kill "$DRILLS" 2>/dev/null
fi
sleep 30
touch "$OUT/SAMPLER-STOP"; sleep 2; kill $SAMPLER 2>/dev/null

say "results"
RES="$OUT/results"
node "$HERE/crowd-report.mjs" "$OUT/crowd/crowd-events.jsonl" --drills "$OUT/drills.jsonl" --json "$RES/crowd-report.json" > /dev/null 2>&1 || node "$HERE/crowd-report.mjs" "$OUT/crowd/crowd-events.jsonl" --json "$RES/crowd-report.json" > /dev/null
node "$ROOT/scripts/playtest-metrics.mjs" "$PT_RUN/relay/relay-events.jsonl" --herald "http://127.0.0.1:$HERALD" --gaps "$PT_DATA/status/gaps.jsonl" --json "$RES/metrics.json" --people > "$RES/metrics.txt" 2>&1
node "$HERE/metrics-validate.mjs" --crowd "$OUT/crowd/crowd-events.jsonl" --relay-log "$PT_RUN/relay/relay-events.jsonl" --invites "$OUT/invites.csv" > "$RES/metrics-validation.txt" 2>&1
"$ROOT/scripts/playtest-status.sh" > "$RES/status-end.txt" 2>&1
"$ROOT/scripts/playtest-status.sh" --json > "$RES/status-end.json" 2>&1
cp "$PT_RUN/relay/relay-events.jsonl" "$RES/relay-events.jsonl" 2>/dev/null
cp "$PT_DATA/status/history.jsonl" "$RES/status-history.jsonl" 2>/dev/null; cp "$PT_DATA/status/alarms.jsonl" "$RES/status-alarms.jsonl" 2>/dev/null; cp "$PT_DATA/status/gaps.jsonl" "$RES/status-gaps.jsonl" 2>/dev/null
cp -R "$PT_RUN/logs" "$RES/component-logs" 2>/dev/null
node "$HERE/run-summary.mjs" --run "$OUT" --json "$RES/run-summary.json" > /dev/null 2>"$OUT/logs/summary.err"
kill "$TUNPID" 2>/dev/null
if [ $KEEP -eq 0 ]; then say "stack down"; "$ROOT/scripts/playtest-down.sh" > "$OUT/logs/down.log" 2>&1; fi
say "done"
exit 0
