#!/usr/bin/env bash
# The MC integrator's generator run (CONQUEST-CONTRACT §4.1, §4.2).
#
# Runs every existing generator of a committed, generated output, in
# dependency order, then (with --check) only their freshness checks:
#
#   1. permutation-rules/vectors/*.json      PSF_WRITE_VECTORS=1 cargo test (frontier_shared, frontier_conquest)
#   2. frontier-abi/vectors/{,v2/}*.json      cargo run -p frontier-abi --bin abi-vectors [-- --check]
#   3. permutation-gateway/test/frontier-vectors.json
#                                             frontier-node fclient vectors::tests::writes_frontier_vectors
#                                             (FRONTIER_VECTORS_CHECK=1 makes it a freshness check)
#   4. frontier-node/fixtures/cq/formats/**   herald cqfmt cq_formats_vectors_fresh (FRONTIER_WRITE_FIXTURES=1)
#                                             (only once herald/src/cqfmt.rs exists, CQ1-D)
#   5. permutation-server/web/frontier/abi.mjs
#                                             PSF_WRITE_ABI=1 node --test test/web-frontier-codec.test.mjs
#   6. permutation-gateway/client/src/frontier/abi-*.mjs, permutation-server/web/sdk/**
#                                             node permutation-gateway/scripts/sync-web-sdk.mjs [--check]
#   7. permutation-server/web/frontier/wasm/frontier.wasm{,.sha256}
#                                             scripts/build-wasm.sh [--check]
#   8. frontier-wasm/vectors/wasm-vectors.json
#                                             PSF_WRITE_VECTORS=1 cargo test (frontier-wasm)
#
#   scripts/cq-regen.sh                    write every generated output
#   scripts/cq-regen.sh --check            freshness checks only; exit 1 on the first stale output
#   scripts/cq-regen.sh --v1-unchanged REF exit 1 unless every M1 (v1) generated output is
#                                          byte-identical to REF (Wave 1 staging proof, §11)
#
# Builds use CARGO_BUILD_JOBS (default 6; the machine is shared).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-6}"
MODE=write
case "${1:-}" in
  "") ;;
  --check) MODE=check ;;
  --v1-unchanged) MODE=v1; REF="${2:?usage: $0 --v1-unchanged REF}" ;;
  *) echo "usage: $0 [--check | --v1-unchanged REF]" >&2; exit 2 ;;
esac

# Every M1 generated output (the v1 names). Wave 1 must leave them byte-identical.
V1_OUTPUTS=(
  permutation-rules/vectors/seal-vectors-v1.json
  permutation-rules/vectors/addr-vectors-v1.json
  permutation-rules/vectors/clock-vectors-v1.json
  frontier-abi/vectors/addresses.json frontier-abi/vectors/budgets.json frontier-abi/vectors/entries.json
  frontier-abi/vectors/errors.json frontier-abi/vectors/ix.json frontier-abi/vectors/layouts.json
  frontier-abi/vectors/logs.json frontier-abi/vectors/presets.json frontier-abi/vectors/tags.json
  permutation-gateway/test/frontier-vectors.json
  permutation-server/web/frontier/abi.mjs
  permutation-gateway/client/src/frontier
  permutation-server/web/sdk
  permutation-server/web/frontier/wasm
  frontier-wasm/vectors/wasm-vectors.json
)

if [ "$MODE" = v1 ]; then
  if git diff --quiet "$REF" -- "${V1_OUTPUTS[@]}"; then
    echo "cq-regen --v1-unchanged: every v1 generated output is byte-identical to $REF"
    exit 0
  fi
  echo "cq-regen --v1-unchanged: v1 generated outputs differ from $REF:" >&2
  git diff --stat "$REF" -- "${V1_OUTPUTS[@]}" >&2
  exit 1
fi

step() { echo "== cq-regen ($MODE): $*"; }

# 1. permutation-rules vectors
step "permutation-rules vectors"
RULES_TESTS=(--test frontier_shared)
[ -f permutation-rules/tests/frontier_conquest.rs ] && RULES_TESTS+=(--test frontier_conquest)
if [ "$MODE" = write ]; then
  PSF_WRITE_VECTORS=1 cargo test --locked -q -p permutation-rules "${RULES_TESTS[@]}"
else
  cargo test --locked -q -p permutation-rules "${RULES_TESTS[@]}"
fi

# 2. frontier-abi vectors (v1 and v2/)
step "frontier-abi vectors"
if [ "$MODE" = write ]; then
  cargo run --locked -q -p frontier-abi --bin abi-vectors
else
  cargo run --locked -q -p frontier-abi --bin abi-vectors -- --check
fi

# 3. frontier-vectors.json (fclient)
step "permutation-gateway/test/frontier-vectors.json"
if [ "$MODE" = write ]; then
  (cd frontier-node && cargo test --locked -q -p fclient --lib vectors::tests::writes_frontier_vectors)
else
  (cd frontier-node && FRONTIER_VECTORS_CHECK=1 cargo test --locked -q -p fclient --lib vectors::tests::writes_frontier_vectors)
  git diff --exit-code -- permutation-gateway/test/frontier-vectors.json
fi

# 4. herald MC format vectors (CQ1-D)
if [ -f frontier-node/crates/herald/src/cqfmt.rs ]; then
  step "frontier-node/fixtures/cq/formats"
  if [ "$MODE" = write ]; then
    (cd frontier-node && FRONTIER_WRITE_FIXTURES=1 cargo test --locked -q -p herald --lib cq_formats_vectors_fresh)
  else
    (cd frontier-node && cargo test --locked -q -p herald --lib cq_formats_vectors_fresh)
  fi
fi

# 5. web/frontier/abi.mjs
step "permutation-server/web/frontier/abi.mjs"
if [ "$MODE" = write ]; then
  (cd permutation-gateway && PSF_WRITE_ABI=1 node --test test/web-frontier-codec.test.mjs >/dev/null)
else
  (cd permutation-gateway && node --test test/web-frontier-codec.test.mjs >/dev/null)
fi

# 6. JS SDK (generated abi-*.mjs and the web copies)
step "SDK (sync-web-sdk.mjs)"
if [ "$MODE" = write ]; then
  node permutation-gateway/scripts/sync-web-sdk.mjs
else
  node permutation-gateway/scripts/sync-web-sdk.mjs --check
fi

# 7. WASM artefact
step "WASM (build-wasm.sh)"
if [ "$MODE" = write ]; then
  scripts/build-wasm.sh
else
  scripts/build-wasm.sh --check
fi

# 8. WASM vectors
step "frontier-wasm/vectors/wasm-vectors.json"
if [ "$MODE" = write ]; then
  (cd frontier-wasm && PSF_WRITE_VECTORS=1 cargo test --locked -q)
else
  (cd frontier-wasm && cargo test --locked -q)
fi

echo "cq-regen ($MODE): done"
