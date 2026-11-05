#!/usr/bin/env bash
# Workstream 11: build, lint and test the extension kernel on the host and
# write the logs to results/. No network beyond crates.io for the locked
# crates, no Solana toolchain, no deploy.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/ext-kernel"
out="$here/results"
mkdir -p "$out"
{
  echo "# $(date -u +%FT%TZ) $(git rev-parse HEAD) $(rustc --version)"
  cargo fmt -- --check
  cargo clippy --locked --all-targets -- -D warnings
  cargo test --locked -- --nocapture --test-threads=1
} 2>&1 | tee "$out/ext-kernel-tests.log"
cargo run --locked -q --example sizes | tee "$out/sizes.txt"
