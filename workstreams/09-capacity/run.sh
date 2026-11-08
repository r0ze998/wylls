#!/usr/bin/env bash
# Workstream 09: build, test and demo the capacity kernel and its bridge to
# workstream 10's custody, then the core in this tree (workstream 4's
# candidate with patch 0001 applied and the capacity preview).
#
#   workstreams/09-capacity/run.sh            # everything
#   workstreams/09-capacity/run.sh --no-patch # skip the core stage
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
cargo test -q 2>&1 | tee "$out/kernel-tests.log" | grep -E "^test result|FAILED|panicked"
# 09's numbers as workstream 4 allocated them (provisional, src/abi.rs).
echo "## --features abi-04-provisional" >> "$out/kernel-tests.log"
cargo clippy -q --all-targets --features abi-04-provisional -- -D warnings
cargo test -q --features abi-04-provisional --test abi 2>&1 | tee -a "$out/kernel-tests.log" | grep -E "^test result|FAILED|panicked"
grep -q FAILED "$out/kernel-tests.log" && { echo "kernel tests failed" >&2; exit 1; }
cargo test -q --release --test contention -- --nocapture 2>&1 | grep -E "applied per kind" > "$out/contention-coverage.log"
cargo test -q --release --test continuity a_long_run -- --nocapture 2>&1 | grep -E "long run:" > "$out/continuity-long-run.log"
cargo run -q --example demo > "$out/demo.txt"
echo "demo: $out/demo.txt ($(wc -l < "$out/demo.txt") lines)"

echo "== bridge10 (09 <-> 10, against workstream 10's pinned crates) =="
# Workstream 10's crates are not in this branch. They are checked out from
# workstream 10's branch at its latest commit (563407d9: its adapter no
# longer has a connection of its own, c27b95eb, so this bridge is the one
# connection), and their trees are checked (custody: the kernel;
# adapter-09: 09's Custody trait on 10's lots).
pin10=563407d96e74934fd82141bf9ad09980ea94bf75
tree10=b91cbfdd0da956148cbbecc1f7d639a03999a58c
tree10a=8d68b5dce11c2536932115fbb4436b3a8ce9a35b
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
# The sources only (a build directory is never copied).
tar -C "$here" --exclude=target -cf - kernel bridge10 | tar -x -C "$btmp/w/workstreams/09-capacity"
(
  cd "$btmp/w/workstreams/09-capacity/bridge10"
  export CARGO_TARGET_DIR="$here/bridge10/target"
  cargo fmt -- --check
  cargo clippy -q --all-targets -- -D warnings
  cargo test -q -- --nocapture 2>&1 | grep -E "^test result|FAILED|panicked|random:|accounting:"
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

# The core in this tree: workstream 4's candidate with workstream 09's core
# commits on it (patch 0001 applied; the capacity preview behind its
# feature). Only host tests: no SBF, no LiteSVM, no verifier tests (their
# shared helpers sign), no Node test that needs keys.
echo "== the core in this tree (patch 0001, capacity preview) =="
git -C "$root" apply --check -R "$here/patches/0001-holding-lent-workshops.patch" ||
  { echo "patch 0001 is not applied in this tree" >&2; exit 1; }
(
  cd "$root"
  {
    echo "# core at $(git -C "$root" rev-parse HEAD)"
    for args in "-p permutation-rules" "-p permutation-rules --features capacity-preview" \
      "-p frontier-abi" "-p frontier-abi --features capacity-preview" \
      "-p permutation-frontier" "-p permutation-frontier --features capacity-preview" \
      "-p permutation-frontier --features custody-preview" \
      "-p permutation-frontier --features capacity-preview,custody-preview"; do
      echo "## cargo test $args"
      # shellcheck disable=SC2086
      cargo test -q $args 2>&1 | grep -E "^test result|FAILED|panicked|^error"
    done
    # Clippy of the capacity builds, judged on workstream 09's files only
    # (a finding in the base is counted, not hidden, and fails nothing here).
    for f in capacity-preview capacity-preview,custody-preview; do
      echo "## clippy permutation-frontier --features $f"
      c="$(cargo clippy -q -p permutation-frontier --features "$f" --all-targets -- -D warnings 2>&1 || true)"
      mine="$(printf '%s\n' "$c" | grep -E -- '--> (permutation-frontier/src/(proc/capacity|capacity_runtime_tests)|frontier-abi/src/capacity|permutation-rules/src/frontier/capacity)' || true)"
      [ -n "$mine" ] && printf 'error: clippy in workstream 09 files\n%s\n' "$mine"
      echo "clippy findings outside workstream 09's files: $(printf '%s\n' "$c" | grep -cE -- '^\s+--> ' || true)"
    done
    echo "## kernel with --features core-patch-0001 (the rules port compared with the kernel)"
    (cd workstreams/09-capacity/kernel && cargo test -q --release --features core-patch-0001 -- --nocapture 2>&1 |
      grep -E "^test result|FAILED|panicked|rules port:")
  } | tee "$out/core-tests.log"
)
if grep -qE "FAILED|^error" "$out/core-tests.log"; then
  echo "core tests failed" >&2
  exit 1
fi
echo "ok"
