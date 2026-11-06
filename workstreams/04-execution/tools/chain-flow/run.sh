#!/bin/sh
# Chain flow (workstream 04): NFT join -> authority revoked by a transfer -> caravan -> memory -> outcome -> (prize),
# on one tree. No key is generated, derived or signed in any stage (the Node stage runs under
# scripts/ci/no-keys-guard.mjs; the Rust stages use literal addresses and program-computed PDAs only).
#
#   A  e2e-native, --features nft: the game program's own JoinResident / ResidentAct (tests/chain_nft.rs)
#   B  runexec: the NFT Citizen's cargo-only caravan on the simulated world (tests/chain_caravan.rs, --ignored)
#   C  12 memory, D 15 outcome, E prize (not run): tools/chain-flow/stages-cde.mjs
#
# Usage: tools/chain-flow/run.sh [OUT_DIR]   (default: a new directory under ${TMPDIR:-/tmp})
# Offline: cargo --offline (the dependencies must already be fetched).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
ws04=$(cd "$here/../.." && pwd)
root=$(cd "$ws04/../.." && pwd)
out=${1:-$(mktemp -d "${TMPDIR:-/tmp}/chain-flow.XXXXXX")}
mkdir -p "$out"
out=$(cd "$out" && pwd)
CHAIN_OUT=$out
export CHAIN_OUT

echo "== A: NFT join and transfer (game program, host build)"
(cd "$ws04/e2e-native" && cargo test --offline --features nft --test chain_nft -- --test-threads 1)
test -s "$out/a-join.json"

echo "== B: the Citizen's caravan (run executor, simulated world)"
(cd "$ws04" && cargo test --offline --test chain_caravan -- --ignored --test-threads 1)
test -s "$out/b-caravan.json"

echo "== C, D, E: memory (12), outcome (15), prize (not run)"
(cd "$root" && node --import ./scripts/ci/no-keys-guard.mjs workstreams/04-execution/tools/chain-flow/stages-cde.mjs)

echo "== outputs in $out"
ls -l "$out"
