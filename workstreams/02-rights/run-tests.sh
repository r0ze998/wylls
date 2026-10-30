#!/usr/bin/env bash
# Workstream 02-rights: the checks behind README.ja.md's test table.
#   workstreams/02-rights/run-tests.sh
# Host only. Does NOT build SBF or run LiteSVM (Agave 3.1.9 needed; see
# 07-VERIFICATION.ja.md §4): the LiteSVM suite is compiled, not run.
# Needs Rust 1.89.0 and 1.95.0 (rustfmt, clippy) and, for the Node test,
# `npm ci --ignore-scripts` in permutation-gateway.
set -euo pipefail
cd "$(dirname "$0")/../.."
root="$PWD"
# The program and the ABI (Rust 1.89, root workspace).
cargo fmt --all -- --check
cargo clippy --locked -p permutation-frontier -p frontier-abi --all-targets -- -D warnings
cargo check --locked -p permutation-frontier --no-default-features
cargo test --locked -p frontier-abi --lib v2::rights
cargo test --locked -p permutation-frontier --lib proc::rights
cargo test --locked -p frontier-abi -p permutation-frontier
# Mutation check: every safety check removed one at a time is detected.
out="$(python3 workstreams/02-rights/mutate.py)"
echo "$out"
if grep -q -e SURVIVED -e "NOT FOUND" <<<"$out"; then
  echo "mutation check failed" >&2
  exit 1
fi
# The verifier reproduction (Rust 1.95, frontier-node workspace).
(cd frontier-node && rustfmt +1.95.0 --edition 2021 --check crates/verify/tests/rights_replay.rs \
  && cargo clippy --locked -p verify --test rights_replay -- -D warnings \
  && cargo test --locked -p verify --test rights_replay)
# The LiteSVM suite: compiled only (no program .so here).
(cd permutation-frontier/svm-tests && rustfmt +1.95.0 --edition 2021 --check tests/rights.rs \
  && cargo clippy --locked --release --test rights -- -D warnings \
  && cargo test --locked --release --test rights --no-run)
# The agent wallet's off-chain policy boundary (Node 22).
node --test "$root/workstreams/02-rights/tests/agent-policy-boundary.test.mjs"
