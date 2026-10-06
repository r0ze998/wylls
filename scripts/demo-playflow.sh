#!/usr/bin/env bash
# Record one player's play flow on the new Frontier UI, in Japanese and in
# English (permutation-gateway/screens/demo/record-playflow.mjs):
#
#   1. `frontier-stack check-ports` and `up` on a fresh local stack (Mode A,
#      test key, 20 bots, scale 20, 1 game day) at --base-port (default
#      41200: herald 41240; the offsets of frontier-node/configs/
#      demo-playflow.toml keep clear of base+10..39). Only 41200-41999 are accepted (default 41200-41299): 41000-41099
#      belong to the paused m1-exit season, 41041 to the design chat;
#   2. waits for the herald's season record and for play to begin (bell 1);
#   3. runs the recorder at 1920 x 1080 (dev wallet, captions, a pointer,
#      the waits fast-forwarded in the cut) into --out;
#   4. `frontier-stack down` (always, also on failure or Ctrl-C).
#
#   scripts/demo-playflow.sh [--out DIR] [--langs ja,en] [--until STEP]
#       [--pace 1] [--base-port 41200] [--scale 20] [--run-id ID]
#
# --out defaults to $DEMO_OUT, else <repo>/../../data/demo when the repo is
# a worktree under .claude/worktrees/, else ~/frontier-demo. Videos never go
# into the repository.
# Environment: FRONTIER_STACK (default frontier-node/target/release/
# frontier-stack; its directory also holds the sibling binaries unless
# FRONTIER_BIN says otherwise), SO (a test-beacon .so; default the stack's
# path under permutation-frontier/target/), PSF_REPO (default this repo, so
# the herald serves this tree's web/ and the run lives in this tree's
# frontier-node/.local/).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export PSF_REPO="${PSF_REPO:-$ROOT}"
S="${FRONTIER_STACK:-$ROOT/frontier-node/target/release/frontier-stack}"
BASE=41200
SCALE=20
LANGS=ja,en
UNTIL=""
PACE=1
RUN_ID="demo-playflow-$(date -u +%Y%m%d%H%M%S)"
case "$ROOT" in
  */.claude/worktrees/*) DEF_OUT="${ROOT%%/.claude/worktrees/*}/.claude/data/demo" ;;
  *) DEF_OUT="$HOME/frontier-demo" ;;
esac
OUT="${DEMO_OUT:-$DEF_OUT}"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --langs) LANGS="$2"; shift 2 ;;
    --until) UNTIL="$2"; shift 2 ;;
    --pace) PACE="$2"; shift 2 ;;
    --base-port) BASE="$2"; shift 2 ;;
    --scale) SCALE="$2"; shift 2 ;;
    --run-id) RUN_ID="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
if [ "$BASE" -lt 41200 ] || [ $((BASE + 99)) -gt 41999 ] || [ $((BASE % 100)) -ne 0 ]; then
  echo "--base-port must be a multiple of 100 in 41200..41900 (41000-41099 are the m1-exit season's)" >&2
  exit 2
fi
case "$OUT" in "$ROOT"/*) echo "--out must be outside the repository ($ROOT)" >&2; exit 2 ;; esac
[ -x "$S" ] || { echo "no frontier-stack at $S (build frontier-node or set FRONTIER_STACK)" >&2; exit 2; }
HERALD="http://127.0.0.1:$((BASE + 40))"
mkdir -p "$OUT"
LOG="$OUT/stack-$RUN_ID.log"
cd "$ROOT" || exit 2

CFG=frontier-node/configs/demo-playflow.toml
"$S" check-ports --config "$CFG" --base-port "$BASE" || exit 1
SO_ARGS=()
[ -n "${SO:-}" ] && SO_ARGS=(--so "$SO")
"$S" up --config "$CFG" --mode accel --beacon test-key --scale "$SCALE" --days 1 --bots 20 --run-id "$RUN_ID" \
  --base-port "$BASE" ${SO_ARGS[@]+"${SO_ARGS[@]}"} > "$LOG" 2>&1 &
UP_PID=$!
cleanup() {
  "$S" down --run-id "$RUN_ID" >> "$LOG" 2>&1
  kill "$UP_PID" 2>/dev/null
  wait "$UP_PID" 2>/dev/null
  echo "stack $RUN_ID down"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

deadline=$((SECONDS + 600))
until curl -sf "$HERALD/h/season" > /dev/null; do
  if ! kill -0 "$UP_PID" 2>/dev/null || [ $SECONDS -ge $deadline ]; then
    echo "the stack did not come up (see $LOG)" >&2
    exit 1
  fi
  sleep 2
done
until curl -sf "$HERALD/h/season" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.exit(Number(j.latestUnix)>=Number(j.genesisTs)+Number(j.bellSecs??600)?0:1)})'; do
  if ! kill -0 "$UP_PID" 2>/dev/null || [ $SECONDS -ge $deadline ]; then
    echo "the season did not start (see $LOG)" >&2
    exit 1
  fi
  sleep 2
done
echo "stack $RUN_ID up: herald $HERALD (1 game day at ${SCALE}x); recording $LANGS into $OUT"

cd "$ROOT/permutation-gateway/screens" || exit 2
DEMO_HERALD="$HERALD" DEMO_LANGS="$LANGS" DEMO_OUT="$OUT" DEMO_UNTIL="$UNTIL" DEMO_PACE="$PACE" \
  node demo/record-playflow.mjs
