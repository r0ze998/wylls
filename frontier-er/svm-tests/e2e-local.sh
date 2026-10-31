#!/usr/bin/env bash
# Local end-to-end run of the candidate board program on a local base
# validator and a local MagicBlock ER (candidate; nothing public, nothing
# deployed). Prints one JSON line per observation to stdout.
#
#   frontier-er/svm-tests/e2e-local.sh WORK_DIR
#
# Needs (none installed by this script):
#   AGAVE_BIN   dir with solana-test-validator (Agave 4.2.2: MagicBlock 1.1.1's
#               committor sends transactions Agave 3.1.9 cannot deserialize)
#   MB_PKG      node_modules dir holding @magicblock-labs/ephemeral-validator 1.1.1
#               and its linux-x64 binary package
#   NOFILE_SHIM optional LD_PRELOAD shim: where the hard RLIMIT_NOFILE is below
#               1,000,000 and cannot be raised, the ER refuses to start; the shim
#               clamps its setrlimit request to the hard limit
#
# Ports (41000–41999 only, as the repository's): base 41680/41681 (ws),
# faucet 41690, gossip 41691, dynamic 41700–41740, ER 41670/41671. The ER also
# opens a metrics server on 0.0.0.0:9000 (not configurable from its CLI here).
#
# Sequence: setup → roundtrip (delegate, ER writes, duplicates, commit,
# commit-and-undelegate, base resumes) → open → ER stopped (hold, base
# refuses) → ER restarted on its storage (copy kept) → close → open → ER
# storage wiped and restarted (lost writes: the reconciler must stop).
set -euo pipefail
WORK="${1:?usage: e2e-local.sh WORK_DIR}"
: "${AGAVE_BIN:?}" "${MB_PKG:?}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SO="$HERE/../target/deploy/frontier_er_board.so"
E="$HERE/../target/debug/examples/er_e2e"
PROG=GURgmxeLRJ1swjHDtQhQdTjguNB6EZDmxSdGM3GC6Hrt
BASE=http://127.0.0.1:41680
ER=http://127.0.0.1:41670
mkdir -p "$WORK"
KEY="$WORK/auth.key"
rm -rf "$WORK/ledger" "$WORK/er-ledger" "$KEY" "$KEY.high"
[ -f "$SO" ] || { echo "build the program first (cargo-build-sbf --arch v2 in frontier-er/program)" >&2; exit 2; }
(cd "$HERE" && cargo build -q --example er_e2e)

# Each service runs in its own process group (setsid) so that stopping it
# also stops what its wrapper spawned (the base wrapper is a node script
# around solana-test-validator).
pids=()
cleanup() { for p in "${pids[@]}"; do kill -- "-$p" 2>/dev/null || true; done; }
trap cleanup EXIT

rpc_ok() { curl -s -m2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$1" | grep -q '"ok"'; }
ident_ok() { curl -s -m2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getIdentity"}' "$1" | grep -q identity; }
wait_for() { for _ in $(seq 1 120); do "$@" && return 0; sleep 1; done; echo "timeout: $*" >&2; return 1; }

if rpc_ok "$BASE" || ident_ok "$ER"; then echo "ports 41680/41670 already serve a chain: stop it first" >&2; exit 3; fi
PATH="$AGAVE_BIN:$PATH" setsid node "$MB_PKG/@magicblock-labs/ephemeral-validator/mbTestValidator.js" \
  --rpc-port 41680 --bpf-program "$PROG" "$SO" --faucet-port 41690 --gossip-port 41691 \
  --dynamic-port-range 41700-41740 --ledger "$WORK/ledger" --reset > "$WORK/base.log" 2>&1 &
pids+=($!)
wait_for rpc_ok "$BASE"

ER_BIN="$MB_PKG/@magicblock-labs/ephemeral-validator-linux-x64/bin/ephemeral-validator"
er_pid=""
start_er() {
  LD_PRELOAD="${NOFILE_SHIM:-}" RUST_LOG=info setsid "$ER_BIN" --no-tui --listen 127.0.0.1:41670 \
    --remotes "$BASE" --remotes ws://127.0.0.1:41681 --storage "$WORK/er-ledger" > "$WORK/er-$1.log" 2>&1 &
  er_pid=$!
  pids+=("$er_pid")
  wait_for ident_ok "$ER"
}
stop_er() { kill -- "-$er_pid"; wait "$er_pid" 2>/dev/null || true; sleep 2; }
run() { "$E" "$BASE" "$ER" "$KEY" "$1"; }

start_er 1
run setup
run roundtrip
run open
echo '{"step":"--- ER stopped mid-session ---"}'
stop_er
run status
run base-write
echo '{"step":"--- ER restarted on its storage ---"}'
start_er 2
run status
run close
run open
echo '{"step":"--- ER storage wiped, restarted ---"}'
stop_er
rm -rf "$WORK/er-ledger"
start_er 3
sleep 3
run status || true
