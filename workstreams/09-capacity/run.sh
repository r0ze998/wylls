#!/usr/bin/env bash
# Workstream 09: build, test and demo the capacity kernel, then check core
# patch 0001 in a temporary worktree (the main checkout is never patched).
#
#   workstreams/09-capacity/run.sh            # everything
#   workstreams/09-capacity/run.sh --no-patch # skip the patched worktree
#
# Writes results/*.log and results/demo.txt. Needs only the Rust toolchain
# of the root rust-toolchain.toml (1.89.0); no network after the crates are
# fetched, no Solana tools, no deploy.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$here/results"
mkdir -p "$out"
patch_too=1
[ "${1:-}" = "--no-patch" ] && patch_too=0

cd "$here/kernel"
echo "== kernel (unpatched rules crate, emulated lending) =="
cargo fmt -- --check
cargo clippy -q --all-targets -- -D warnings
cargo test -q 2>&1 | tee "$out/kernel-tests.log" | grep -E "^test result|FAILED|panicked" || true
grep -q FAILED "$out/kernel-tests.log" && { echo "kernel tests failed" >&2; exit 1; }
cargo test -q --release --test contention -- --nocapture 2>&1 | grep -E "applied per kind" > "$out/contention-coverage.log" || true
cargo run -q --example demo > "$out/demo.txt"
echo "demo: $out/demo.txt ($(wc -l < "$out/demo.txt") lines)"

[ "$patch_too" = 1 ] || exit 0

echo "== patch 0001 in a temporary worktree =="
tmp="$(mktemp -d "${TMPDIR:-/tmp}/wylls-09-XXXXXX")"
cleanup() { git -C "$root" worktree remove --force "$tmp/w" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
git -C "$root" worktree add -q --detach "$tmp/w" HEAD
# The kernel as it is in this checkout (it may not be committed yet).
rm -rf "$tmp/w/workstreams/09-capacity/kernel"
mkdir -p "$tmp/w/workstreams/09-capacity"
cp -r "$here/kernel" "$tmp/w/workstreams/09-capacity/kernel"
rm -rf "$tmp/w/workstreams/09-capacity/kernel/target"
git -C "$tmp/w" apply "$here/patches/0001-holding-lent-workshops.patch"
export CARGO_TARGET_DIR="$tmp/target"
(
  cd "$tmp/w"
  {
    echo "# patch 0001 on $(git -C "$root" rev-parse HEAD)"
    echo "## permutation-rules"
    cargo test -q -p permutation-rules 2>&1 | grep -E "^test result|FAILED|panicked"
    echo "## frontier-abi"
    cargo test -q -p frontier-abi 2>&1 | grep -E "^test result|FAILED|panicked"
    echo "## permutation-frontier (host)"
    cargo test -q -p permutation-frontier 2>&1 | grep -E "^test result|FAILED|panicked"
    echo "## kernel with --features core-patch-0001"
    (cd workstreams/09-capacity/kernel && cargo test -q --features core-patch-0001 2>&1 | grep -E "^test result|FAILED|panicked")
  } | tee "$out/patch-0001-tests.log"
)
if grep -q FAILED "$out/patch-0001-tests.log"; then
  echo "patch 0001 tests failed" >&2
  exit 1
fi
echo "ok"
