#!/usr/bin/env bash
# Applies the findex fix (A) and its reproduction tests (D, which need A)
# to a worktree and runs the tests (for the integrator, ④).
#
#   docs/frontier/er-candidate/verify-A.sh WORKTREE PATCH_DIR
#
# PATCH_DIR holds A-findex.patch and D-repro-tests.patch (the package's
# patches/). Nothing is committed; the worktree is left with the patches
# applied for inspection.
set -euo pipefail
WT="${1:?usage: verify-A.sh WORKTREE PATCH_DIR}"
P="${2:?usage: verify-A.sh WORKTREE PATCH_DIR}"
cd "$WT"
for p in A-findex D-repro-tests; do
  git apply --check "$P/$p.patch"
  git apply "$P/$p.patch"
  echo "applied $p"
done
cd frontier-node
cargo test --locked -p findex
cargo test --locked -p verify --test open_items
cargo test --locked --workspace
