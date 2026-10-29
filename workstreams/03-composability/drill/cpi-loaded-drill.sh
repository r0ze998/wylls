#!/usr/bin/env bash
# Workstream 03 validator drill: does a CPI target's ProgramData count
# toward SIMD-0186's loaded-data limit? (courier-tests/tests/validator_drill.rs)
#
#   workstreams/03-composability/drill/cpi-loaded-drill.sh [out-dir]
#
# Starts the installed solana-test-validator 3.1.9 on 41280 (RPC), 41281
# (pubsub), 41285 (gossip), 41286 (faucet), 41300-41340 (not the core
# drill's ports), deploys the harness probe padded to the Frontier release
# .so's size (the Frontier program needs BLS12-381 syscalls 3.1.9 lacks) and
# the courier's hostile test build, runs the ignored drill test and stops
# the validator. Local only: nothing is sent to devnet or mainnet.
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
probe="$root/permutation-frontier/svm-tests/probe"
out="${1:-$(mktemp -d "${TMPDIR:-/tmp}/courier-drill.XXXXXX")}"
mkdir -p "$out"
RPC=41280; GOSSIP=41285; FAUCET=41286; DYN=41300-41340
URL="http://127.0.0.1:$RPC"

want="solana-test-validator 3.1.9"
have="$(solana-test-validator --version | cut -d' ' -f1-2)"
[ "$have" = "$want" ] || { echo "need $want (have $have)" >&2; exit 1; }

so_len="$(wc -c < "$root/permutation-frontier/target/deploy/permutation_frontier.so" | tr -d ' ')"
( cd "$probe" && cargo-build-sbf --tools-version v1.52 --arch v2 --sbf-out-dir "$out/probe" -- --locked >/dev/null 2>&1 )
base="$(wc -c < "$out/probe/psf_probe.so" | tr -d ' ')"
pad=$(( so_len > base ? so_len - base : 0 ))
( cd "$probe" && PSF_PROBE_PAD="$pad" CARGO_TARGET_DIR="$out/probe-target" \
    cargo-build-sbf --tools-version v1.52 --arch v2 --sbf-out-dir "$out/probe-padded" -- --locked >/dev/null 2>&1 )
big="$out/probe-padded/psf_probe.so"
courier="$here/courier/target/deploy-hostile/wylls_courier.so"
[ -f "$courier" ] || { echo "build the courier first: $here/run.sh" >&2; exit 1; }
len="$(wc -c < "$big" | tr -d ' ')"
max_len=$(( ( (len * 5 + 3) / 4 + 4095 ) / 4096 * 4096 ))
echo "drill: big program $len B (Frontier .so $so_len B), max_len $max_len" | tee "$out/drill.log"

solana-test-validator --ledger "$out/ledger" --reset --quiet --bind-address 127.0.0.1 \
  --rpc-port "$RPC" --gossip-port "$GOSSIP" --faucet-port "$FAUCET" --dynamic-port-range "$DYN" \
  >"$out/validator.out" 2>&1 &
vpid=$!
trap 'kill "$vpid" 2>/dev/null || true; wait "$vpid" 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do
  if solana --url "$URL" cluster-version >/dev/null 2>&1; then break; fi
  sleep 0.5
done
solana --url "$URL" cluster-version | tee -a "$out/drill.log"
for k in payer big courier; do solana-keygen new --no-bip39-passphrase --silent --force -o "$out/$k.json" >/dev/null; done
solana --url "$URL" airdrop 500 --keypair "$out/payer.json" >/dev/null
solana --url "$URL" --keypair "$out/payer.json" program deploy --program-id "$out/big.json" --max-len "$max_len" "$big" | tee -a "$out/drill.log"
solana --url "$URL" --keypair "$out/payer.json" program deploy --program-id "$out/courier.json" "$courier" | tee -a "$out/drill.log"
( cd "$here/courier-tests" && COURIER_DRILL_RPC="$URL" \
    COURIER_DRILL_BIG="$(solana-keygen pubkey "$out/big.json")" \
    COURIER_DRILL_COURIER="$(solana-keygen pubkey "$out/courier.json")" \
    COURIER_DRILL_KEYPAIR="$out/payer.json" COURIER_DRILL_OUT="$out/drill.json" \
    cargo test --locked --test validator_drill -- --ignored --nocapture ) 2>&1 | tee -a "$out/drill.log"
echo "drill: log in $out/drill.log, result in $out/drill.json"
