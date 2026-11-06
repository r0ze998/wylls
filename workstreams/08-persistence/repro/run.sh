#!/usr/bin/env bash
# Runs the workstream-08 season-end reproductions (season_end_repro.rs) in LiteSVM.
#
#   workstreams/08-persistence/repro/run.sh [WORK_DIR]
#
# Nothing is written inside the repository: the test-beacon program build, a copy of
# permutation-frontier/svm-tests (path dependencies rewritten to this checkout) and the test
# target all go to WORK_DIR (default: ${TMPDIR:-/tmp}/wylls-08-repro).
#
# Needs: Agave 3.1.9 (cargo-build-sbf, platform-tools v1.52) on PATH, the 1.89.0 toolchain for
# the program build and 1.95.0 for the tests (the same as permutation-frontier/svm-tests/run.sh).
# Set PSF_SO_TEST_BEACON to an existing test-beacon .so to skip the program build.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"
work="${1:-${TMPDIR:-/tmp}/wylls-08-repro}"
mkdir -p "$work"

if [ -z "${PSF_SO_TEST_BEACON:-}" ]; then
  want="solana-cargo-build-sbf 3.1.9"
  have="$(cargo-build-sbf --version 2>/dev/null | head -1 || true)"
  [ "$have" = "$want" ] || { echo "need $want on PATH (have: ${have:-none})" >&2; exit 1; }
  CARGO_TARGET_DIR="$work/target-sbf" cargo-build-sbf \
    --manifest-path "$repo/permutation-frontier/Cargo.toml" \
    --tools-version v1.52 --arch v2 --sbf-out-dir "$work/deploy-test-beacon" \
    --features test-beacon -- --locked
  export PSF_SO_TEST_BEACON="$work/deploy-test-beacon/permutation_frontier.so"
  grep -q PSF_TEST_BEACON_BUILD "$PSF_SO_TEST_BEACON" || { echo "not a test-beacon build" >&2; exit 3; }
fi

rm -rf "$work/svm"
cp -R "$repo/permutation-frontier/svm-tests" "$work/svm"
sed -i \
  -e "s#path = \"../../frontier-abi\"#path = \"$repo/frontier-abi\"#" \
  -e "s#path = \"../../frontier-node/crates/fclient\"#path = \"$repo/frontier-node/crates/fclient\"#" \
  -e "s#path = \"../../permutation-rules\"#path = \"$repo/permutation-rules\"#" \
  "$work/svm/Cargo.toml"
cat "$work/svm/tests/caravan.rs" "$here/season_end_repro.rs" > "$work/svm/tests/season_end_repro.rs"

cd "$work/svm"
CARGO_TARGET_DIR="$work/target-svm" cargo test --locked --test season_end_repro -- repro --nocapture
