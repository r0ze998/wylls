#!/bin/zsh
# play2-land starter (template, 2026-11-16), fail-closed. TEST-ONLY local world, SYNTHETIC CLOCK x10: capture demo + land
# preview + contest pair, two ordinary memory-only wallets. NOT natural speed, NOT production. No NFT/transfer/session
# guard/prize/real funds/public issuance. Having this file is NOT permission to start a world (see README.md).
#
# Usage: play2-start.sh --config <file> [--preflight-only]
# The config is KEY=VALUE lines (play2.conf.example); it is parsed, never executed. Every key is required; a missing,
# empty, relative or unknown entry stops here. Window: everything ends by T0 + 150 min (watchdog SIGINT at T0 + 145).
# Order: preflight → guard + watchdog armed against THIS pid → both armed and alive, or stop → exec the launcher.
set -u
setopt pipefail
OPS=${0:A:h}
stop() { echo "STOP: $1"; exit 3; }

CONF="" PRE=0
while (( $# )); do
  case $1 in
    --config) (( $# >= 2 )) || stop "--config needs a file"; CONF=$2; shift 2 ;;
    --preflight-only) PRE=1; shift ;;
    *) stop "unknown argument $1" ;;
  esac
done
[ -n "$CONF" ] || stop "no --config given"
[ -f "$CONF" ] || stop "config $CONF not found"

PATH_KEYS=(EXPORT_ROOT FEATURE_DEBUG EXPEDITION_DEBUG PROGRAM_SO DATA_DIR)
SHA_KEYS=(SHA_PROGRAM_SO SHA_NATURAL_RUNNER SHA_HERALD SHA_EXPEDITION_RUNNER SHA_DEPART SHA_PREVIEW SHA_RESIDENT_PREPARE)
typeset -A C
while IFS= read -r line || [ -n "$line" ]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" == *=* ]] || stop "config line without '=': $line"
  k=${line%%=*} v=${line#*=}
  (( ${PATH_KEYS[(Ie)$k]} || ${SHA_KEYS[(Ie)$k]} )) || [ "$k" = EXPORT_COMMIT ] || stop "unknown config key $k"
  [[ "$v" == *[[:space:]\;\&\|\$\`\'\"]* ]] && stop "config value of $k has a space or shell character"
  C[$k]=$v
done < "$CONF"
for k in $PATH_KEYS; do [ -n "${C[$k]:-}" ] || stop "config $k missing"; [[ "${C[$k]}" == /* ]] || stop "config $k is not absolute"; done
for k in $SHA_KEYS; do [[ "${C[$k]:-}" =~ ^[0-9a-f]{64}$ ]] || stop "config $k is not a full sha256"; done
[[ "${C[EXPORT_COMMIT]:-}" =~ ^[0-9a-f]{40}$ ]] || stop "config EXPORT_COMMIT is not a full commit id"

X=$C[EXPORT_ROOT] T=$C[FEATURE_DEBUG] H=$C[EXPEDITION_DEBUG] SO=$C[PROGRAM_SO] DATA=$C[DATA_DIR]
typeset -A PIN
PIN=(
  $SO $C[SHA_PROGRAM_SO]
  $T/localnet-natural-play $C[SHA_NATURAL_RUNNER]
  $T/frontier-herald $C[SHA_HERALD]
  $H/localnet-expedition-play $C[SHA_EXPEDITION_RUNNER]
  $H/frontier-experimental-expedition-depart-prepare $C[SHA_DEPART]
  $H/frontier-original-expedition-preview $C[SHA_PREVIEW]
  $H/frontier-experimental-expedition-prepare $C[SHA_RESIDENT_PREPARE]
)

# ---------------------------------------------------------------- preflight
[ -e $DATA ] && stop "$DATA exists"
[ -d ${DATA:h} ] || stop "parent of $DATA missing"
[ -d $X ] || stop "no export $X"
[ "$(cat $X/EXPORT-SOURCE.txt 2>/dev/null)" = "export $X from $C[EXPORT_COMMIT]" ] || stop "export source is not $C[EXPORT_COMMIT]"
for p in {41960..41975}; do lsof -nP -iTCP:$p -sTCP:LISTEN > /dev/null 2>&1 && stop "port $p in use"; done
# (only a real launcher process: `node …/local-play-launcher.mjs …`; a process that merely names the file in its
#  arguments — an editor, a log tail, an agent session whose prompt mentions it — is not a launcher)
pgrep -f '^[^ ]*node [^ ]*local-play-launcher\.mjs( |$)' > /dev/null && stop "another launcher runs"
fk=$(df -k ${DATA:h} | tail -1 | awk '{print $4}'); (( fk >= 21 * 1024 * 1024 )) || stop "free $fk KiB < 21 GiB"
for f in ${(k)PIN}; do
  [ -f $f ] || stop "missing $f"
  got=$(shasum -a 256 $f | cut -d' ' -f1)
  [ "$got" = "$PIN[$f]" ] || stop "sha256 of $f is $got, expected $PIN[$f]"
done
echo "preflight ok $(date '+%F %T %Z'): export $C[EXPORT_COMMIT], 7 binaries equal, free $((fk / 1024 / 1024)) GiB, ports free"
(( PRE )) && exit 0

# ---------------------------------------------------------------- arm (fail-closed)
T0=$(date +%s)
RUN=${DATA:h}/play2-ops-run-$T0; mkdir $RUN || stop "cannot make $RUN"
LOG=$RUN/launcher.log
ME_START=$(ps -o lstart= -p $$)
common=(--state $RUN --target-pid $$ --target-start "$ME_START" --root $X --data $DATA --t0 $T0
        --count $LOG --count $RUN/guard.jsonl --count $RUN/watchdog.jsonl)
python3 -I $OPS/play2_ops.py guard $common --log $RUN/guard.jsonl & GP=$!
python3 -I $OPS/play2_ops.py watchdog $common --log $RUN/watchdog.jsonl --deadline $((T0 + 145 * 60)) & WP=$!
armed=0
for i in {1..80}; do
  [ -f $RUN/guard.armed ] && [ -f $RUN/watchdog.armed ] && { armed=1; break; }
  kill -0 $GP 2>/dev/null && kill -0 $WP 2>/dev/null || break
  sleep 0.25
done
ok_armed() { python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["pid"]==int(sys.argv[2]) else 1)' $1 $2; }
if (( ! armed )) || ! kill -0 $GP 2>/dev/null || ! kill -0 $WP 2>/dev/null \
   || ! ok_armed $RUN/guard.armed $GP || ! ok_armed $RUN/watchdog.armed $WP; then
  kill -0 $GP 2>/dev/null && kill $GP; kill -0 $WP 2>/dev/null && kill $WP
  stop "guard/watchdog not armed: no launcher started (see $RUN)"
fi
echo "armed: guard $GP, watchdog $WP; SIGINT at $(date -r $((T0 + 8700)) '+%T'), window ends $(date -r $((T0 + 9000)) '+%T')"
echo "start $(date '+%F %T %Z') export $C[EXPORT_COMMIT]" >> $LOG

# ---------------------------------------------------------------- the launcher (this pid)
cd $X && exec node permutation-gateway/src/frontier/local-play-launcher.mjs \
  --root $X --data $DATA --runner $H/localnet-expedition-play --natural-runner $T/localnet-natural-play \
  --world-preset local-natural-v1 --economy page-signed-v1 --march-trial local-march-trial-v1 --capture-demo capture-demo-v1 --demo-scale 10 \
  --world-option land-preview-v1 --contest-pair contest-pair-v1 \
  --herald $T/frontier-herald --depart $H/frontier-experimental-expedition-depart-prepare \
  --preview $H/frontier-original-expedition-preview --resident $H/frontier-experimental-expedition-prepare \
  --artifact $SO --artifact-sha $PIN[$SO] \
  --world-ttl-minutes 150 --port 41960 --world-port 41964 --herald-output compact-v2 >> $LOG 2>&1
