#!/bin/sh
# Chain flow (workstream 04): NFT join -> authority revoked by a transfer -> caravan -> memory -> outcome -> (prize),
# on one tree. No keypair is generated and nothing is signed in any stage (the Node stages run under
# scripts/ci/no-keys-guard.mjs); stages A and B do compute PDAs (see below).
#
#   A  e2e-native, --features nft: the game program's own JoinResident / ResidentAct (tests/chain_nft.rs)
#   B  runexec: the NFT Citizen's cargo-only caravan on the simulated world (tests/chain_caravan.rs, --ignored)
#   C  12 memory, D 15 outcome, E prize (not run): tools/chain-flow/stages-cde.mjs
#
# Stages A and B COMPUTE PDAs (the program finds the Season, link, policy and with-seed Citizen addresses). The
# owner's rule (2026-11-06) forbids key generation, derivation INCLUDING PDAs, and signing, so by default this script
# runs only the PDA-free check of the fixed outputs (check-fixtures.mjs). Stages A-E run only with
# CHAIN_PDA=approved, which needs the owner's explicit approval.
#
# Usage: tools/chain-flow/run.sh [OUT_DIR]   (default: a new directory under ${TMPDIR:-/tmp})
# Offline: cargo --offline (the dependencies must already be fetched).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
ws04=$(cd "$here/../.." && pwd)
root=$(cd "$ws04/../.." && pwd)
if [ "${CHAIN_PDA:-}" != approved ]; then
  echo "== stages A-E not run (they compute PDAs; CHAIN_PDA=approved needs the owner's approval)"
  echo "== PDA-free check of the fixed outputs (fixtures-20261106)"
  cd "$root" && exec node --import ./scripts/ci/no-keys-guard.mjs workstreams/04-execution/tools/chain-flow/check-fixtures.mjs
fi
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
