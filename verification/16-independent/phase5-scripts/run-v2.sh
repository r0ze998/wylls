#!/usr/bin/env bash
# Runs ⑯'s repro tests and the relevant suites on each pinned tree; one log per step.
S=${V16_WORK:?set V16_WORK to the directory holding the v2-* worktrees}
L=$S/logs-v2; mkdir -p "$L"
export CARGO_TERM_COLOR=never
step() { # step <name> <dir> <cmd...>
  local name="$1" dir="$2"; shift 2
  echo "### $name  ($(git -C "$dir" rev-parse HEAD))  $*" > "$L/$name.log"
  ( cd "$dir" && "$@" ) >> "$L/$name.log" 2>&1
  echo "exit=$?" >> "$L/$name.log"
  echo "$(date -u +%H:%M:%S) done $name $(tail -1 "$L/$name.log")" >> "$L/progress.txt"
}
FN=${V16_REPO:?set V16_REPO to the wylls checkout}/frontier-node/target
RT=${V16_REPO:?set V16_REPO to the wylls checkout}/target
# ⑱ priority: integration and ⑱'s branch
step int-keeper-v16   $S/v2-int/frontier-node env CARGO_TARGET_DIR=$FN cargo test --locked -p keeper --no-fail-fast --test v16_early_reveal --test v16_reveal_versions_fees
step w18-keeper-v16   $S/v2-w18/frontier-node env CARGO_TARGET_DIR=$FN cargo test --locked -p keeper --no-fail-fast --test v16_early_reveal --test v16_reveal_versions_fees
step int-node-v16     $S/v2-int/permutation-gateway node --test test/v16-public-ops.test.mjs test/v16-x402-settlement.test.mjs test/v16-agent-wallet-replay.test.mjs test/v16-agent-wallet-contention.test.mjs test/v16-web-caravan-holder.test.mjs test/v16-web-wallet-switch.test.mjs
step w18-node-v16     $S/v2-w18/permutation-gateway node --test test/v16-public-ops.test.mjs
step w17-node-v16     $S/v2-w17/permutation-gateway node --test test/v16-x402-settlement.test.mjs test/frontier-prize.test.mjs test/frontier-prize-accounts.test.mjs test/frontier-prize-shares.test.mjs
step w08-node         $S/v2-w08/permutation-gateway node --test test/v16-public-ops.test.mjs test/web-frontier-continuous.test.mjs
# full suites relevant to each priority
step int-keeper-all   $S/v2-int/frontier-node env CARGO_TARGET_DIR=$FN cargo test --locked -p keeper --no-fail-fast
step w18-keeper-all   $S/v2-w18/frontier-node env CARGO_TARGET_DIR=$FN cargo test --locked -p keeper --no-fail-fast
step w08-keeper-all   $S/v2-w08/frontier-node env CARGO_TARGET_DIR=$FN cargo test --locked -p keeper --no-fail-fast
step int-findex-all   $S/v2-int/frontier-node env CARGO_TARGET_DIR=$FN cargo test --locked -p findex --no-fail-fast
step w19-findex-all   $S/v2-w19/frontier-node env CARGO_TARGET_DIR=$FN cargo test --locked -p findex --no-fail-fast
step int-herald-v16   $S/v2-int/frontier-node env CARGO_TARGET_DIR=$FN cargo test --locked -p herald --no-fail-fast --test v16_caravan_holder
step int-verify-v16   $S/v2-int/frontier-node env CARGO_TARGET_DIR=$FN cargo test --locked -p verify --no-fail-fast --test v16_unknown_tag
step int-abi-v16      $S/v2-int env CARGO_TARGET_DIR=$RT cargo test --locked -p frontier-abi --no-fail-fast --test v16_period_boundary
step w08-abi-all      $S/v2-w08 env CARGO_TARGET_DIR=$RT cargo test --locked -p frontier-abi --no-fail-fast
step int-node-all     $S/v2-int/permutation-gateway npm test
echo "ALL DONE" >> "$L/progress.txt"
