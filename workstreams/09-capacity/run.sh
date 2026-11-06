#!/usr/bin/env bash
# Workstream 09: build, test and demo the capacity kernel, then check core
# patch 0001 in a temporary worktree (the main checkout is never patched).
#
#   workstreams/09-capacity/run.sh            # everything
#   workstreams/09-capacity/run.sh --no-patch # skip the patched worktree
#
# The bridge10 stage needs workstream 10's pinned commit (fetched from the
# integration branch when missing).
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
# 09's numbers as workstream 4 allocated them (provisional, src/abi.rs).
echo "## --features abi-04-provisional" >> "$out/kernel-tests.log"
cargo clippy -q --all-targets --features abi-04-provisional -- -D warnings
cargo test -q --features abi-04-provisional --test abi 2>&1 | tee -a "$out/kernel-tests.log" | grep -E "^test result|FAILED|panicked" || true
grep -q FAILED "$out/kernel-tests.log" && { echo "kernel tests failed" >&2; exit 1; }
cargo test -q --release --test contention -- --nocapture 2>&1 | grep -E "applied per kind" > "$out/contention-coverage.log" || true
cargo test -q --release --test continuity a_long_run -- --nocapture 2>&1 | grep -E "long run:" > "$out/continuity-long-run.log" || true
cargo run -q --example demo > "$out/demo.txt"
echo "demo: $out/demo.txt ($(wc -l < "$out/demo.txt") lines)"

echo "== bridge10 (09 <-> 10, against workstream 10's pinned crates) =="
# Workstream 10's crates are not in this branch. They are checked out from
# workstream 10's branch at its latest commit (79fbce83; its custody and
# adapter-09 trees are those of b237b581, which put own lots and lots used
# under an order in one table), and their trees are checked (custody: the
# kernel; adapter-09: 09's Custody trait on 10's lots, and 10's own
# connection `connect` that tests/connect10.rs compares with the bridge).
pin10=79fbce834c321ff58040c3b8bbf98f018b58f5c0
tree10=b91cbfdd0da956148cbbecc1f7d639a03999a58c
tree10a=b8b5984c06d91b6a6000e5eeb07c9871e64e0627
if ! git -C "$root" cat-file -e "$pin10^{commit}" 2>/dev/null; then
  git -C "$root" fetch -q origin claude/great-babbage-3ogkqu || true
fi
if [ "$(git -C "$root" rev-parse "$pin10:workstreams/10-custody/custody" 2>/dev/null)" != "$tree10" ] ||
   [ "$(git -C "$root" rev-parse "$pin10:workstreams/10-custody/adapter-09" 2>/dev/null)" != "$tree10a" ]; then
  echo "workstream 10 pin $pin10 not available (trees $tree10, $tree10a)" >&2
  exit 1
fi
btmp="$(mktemp -d "${TMPDIR:-/tmp}/wylls-09b-XXXXXX")"
bclean() { rm -rf "$btmp"; }
trap bclean EXIT
mkdir -p "$btmp/w/workstreams/09-capacity"
git -C "$root" archive HEAD permutation-rules frontier-abi rust-toolchain.toml | tar -x -C "$btmp/w"
git -C "$root" archive "$pin10" workstreams/10-custody/custody workstreams/10-custody/adapter-09 | tar -x -C "$btmp/w"
cp -r "$here/kernel" "$here/bridge10" "$btmp/w/workstreams/09-capacity/"
rm -rf "$btmp/w/workstreams/09-capacity/kernel/target" "$btmp/w/workstreams/09-capacity/bridge10/target"
(
  cd "$btmp/w/workstreams/09-capacity/bridge10"
  export CARGO_TARGET_DIR="$here/bridge10/target"
  cargo fmt -- --check
  cargo clippy -q --all-targets -- -D warnings
  cargo test -q -- --nocapture 2>&1 | grep -E "^test result|FAILED|panicked|random:|accounting:|T5:"
) | tee "$out/bridge10-tests.log"
grep -q FAILED "$out/bridge10-tests.log" && { echo "bridge10 tests failed" >&2; exit 1; }
echo "# workstream 10 pin $pin10, trees custody $tree10 adapter-09 $tree10a" >> "$out/bridge10-tests.log"
# Workstream 10's own adapter tests against this kernel: the shared changes
# (ClaimSplit, apply_detailed, Refused, accounts) must not break them.
(
  cd "$btmp/w/workstreams/10-custody/adapter-09"
  export CARGO_TARGET_DIR="$here/bridge10/target"
  cargo test -q --release --features nine-refused 2>&1 | grep -E "^test result|FAILED|panicked"
) | tee "$out/w10-adapter-on-this-kernel.log"
grep -q FAILED "$out/w10-adapter-on-this-kernel.log" && { echo "workstream 10 adapter tests failed" >&2; exit 1; }
echo "# workstream 10 adapter-09 (tree $tree10a) against this branch's kernel" >> "$out/w10-adapter-on-this-kernel.log"
bclean
trap - EXIT

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
