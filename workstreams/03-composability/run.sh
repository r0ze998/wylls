#!/usr/bin/env bash
# Workstream 03: build the courier sample and run its checks, locally only.
#
#   workstreams/03-composability/run.sh            # build, LiteSVM tests, relay classifier check
#   workstreams/03-composability/run.sh --drill    # also the solana-test-validator drill
#
# Needs Agave 3.1.9 (cargo-build-sbf, platform-tools v1.52; the core CI's
# install), Rust 1.95.0 (rust-toolchain.toml of courier-tests) and Node 20+.
# The Frontier program's builds are made by scripts/build-frontier.sh unless
# they exist (WS03_REBUILD_FRONTIER=1 forces them). Results go to results/.
# Nothing is deployed or sent to a network; the drill's validator is local.
set -euo pipefail
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
drill=0
[ "${1:-}" = "--drill" ] && drill=1

rel="$root/permutation-frontier/target/deploy/permutation_frontier.so"
tb="$root/permutation-frontier/target/deploy-test-beacon/permutation_frontier.so"
if [ "${WS03_REBUILD_FRONTIER:-0}" = 1 ] || [ ! -f "$rel" ]; then "$root/scripts/build-frontier.sh"; fi
if [ "${WS03_REBUILD_FRONTIER:-0}" = 1 ] || [ ! -f "$tb" ]; then "$root/scripts/build-frontier.sh" --features test-beacon; fi

( cd "$here/courier" && cargo-build-sbf --tools-version v1.52 --arch v2 --sbf-out-dir target/deploy -- --locked )
( cd "$here/courier" && cargo-build-sbf --tools-version v1.52 --arch v2 --sbf-out-dir target/deploy-hostile --features hostile -- --locked )
for f in "$here/courier/target/deploy/wylls_courier.so" "$here/courier/target/deploy-hostile/wylls_courier.so"; do
  echo "ws03: $f $(wc -c < "$f" | tr -d ' ') B sha256 $(shasum -a 256 "$f" | cut -d' ' -f1)"
done

mkdir -p "$here/results"
export PSF_SO="$rel" PSF_SO_TEST_BEACON="$tb"
export COURIER_MEASURE_OUT="$here/results/measure-sendcaravan.json"
export COURIER_SETUP_OUT="$here/results/measure-delegation-setup.json"
# Shares the core harness's target directory when its lock matches (it is a copy).
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/permutation-frontier/svm-tests/target}"
( cd "$here/courier-tests" && WS03_MATRIX_OUT="$here/generated/instruction-matrix.generated.ja.md" cargo test --locked -- --nocapture ) 2>&1 | tee "$here/results/courier-tests.log"
( cd "$root" && node --test workstreams/03-composability/relay-check/relay-shape.test.mjs ) 2>&1 | tee "$here/results/relay-check.log"
if [ "$drill" = 1 ]; then
  d="$(mktemp -d "${TMPDIR:-/tmp}/courier-drill.XXXXXX")"
  "$here/drill/cpi-loaded-drill.sh" "$d"
  cp "$d/drill.json" "$here/results/drill-cpi-loaded.json"
  grep '^drill:' "$d/drill.log" > "$here/results/drill-cpi-loaded.log"
fi
echo "ws03: results in $here/results"
