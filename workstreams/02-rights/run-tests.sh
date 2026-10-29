#!/usr/bin/env bash
# Workstream 02-rights: the checks behind README.ja.md's test table.
#   workstreams/02-rights/run-tests.sh
# Host only (Rust 1.89 from rust-toolchain.toml). Does NOT build SBF or run
# LiteSVM (that needs Agave 3.1.9; see README.ja.md, "未実行").
set -euo pipefail
cd "$(dirname "$0")/../.."
cargo fmt --all -- --check
cargo clippy --locked -p permutation-frontier -p frontier-abi --all-targets -- -D warnings
cargo check --locked -p permutation-frontier --no-default-features
cargo test --locked -p frontier-abi --lib v2::rights
cargo test --locked -p permutation-frontier --lib proc::rights
# The crates' whole suites (no regression elsewhere).
cargo test --locked -p frontier-abi -p permutation-frontier
