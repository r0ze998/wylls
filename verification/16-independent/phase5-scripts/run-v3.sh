#!/usr/bin/env bash
# ⑯ phase 5, second batch: new ⑯ tests (findex gaps, BeaconLog restart, early API owner material). Runs after run-v2.sh.
S=${V16_WORK:?set V16_WORK to the directory holding the v2-* worktrees}
L=$S/logs-v3; mkdir -p "$L"
until grep -q 'ALL DONE' $S/logs-v2/progress.txt; do sleep 15; done
export CARGO_TERM_COLOR=never
step() {
  local name="$1" dir="$2"; shift 2
  { echo "### $name  HEAD $(git -C "$dir" rev-parse HEAD)  $*"; echo "### local additions:"; git -C "$dir" status --short; } > "$L/$name.log"
  ( cd "$dir" && "$@" ) >> "$L/$name.log" 2>&1
  echo "exit=$?" >> "$L/$name.log"
  echo "$(date -u +%H:%M:%S) done $name $(tail -1 "$L/$name.log")" >> "$L/progress.txt"
}
FN=${V16_REPO:?set V16_REPO to the wylls checkout}/frontier-node/target
G=${V16_REPO:?set V16_REPO to the wylls checkout}/frontier-node/crates/findex/tests/v16_history_gaps.rs
B=${V16_REPO:?set V16_REPO to the wylls checkout}/frontier-node/crates/keeper/tests/v16_beacon_restart.rs
cp $G $S/v2-int/frontier-node/crates/findex/tests/; cp $G $S/v2-w19/frontier-node/crates/findex/tests/
cp $B $S/v2-w08/frontier-node/crates/keeper/tests/
step int-findex-gaps  $S/v2-int/frontier-node env CARGO_TARGET_DIR=$FN cargo test --locked -p findex --no-fail-fast --test v16_history_gaps
step w19-findex-gaps  $S/v2-w19/frontier-node env CARGO_TARGET_DIR=$FN cargo test --locked -p findex --no-fail-fast --test v16_history_gaps
step int-beacon-restart $S/v2-int/frontier-node env CARGO_TARGET_DIR=$FN cargo test --locked -p keeper --no-fail-fast --test v16_beacon_restart -- --nocapture
step w08-beacon-restart $S/v2-w08/frontier-node env CARGO_TARGET_DIR=$FN cargo test --locked -p keeper --no-fail-fast --test v16_beacon_restart -- --nocapture
step int-early-api    $S/v2-int/frontier-node env CARGO_TARGET_DIR=$FN cargo test --locked -p keeper --no-fail-fast --test play -- --nocapture v16_api_owner_material_right_after_departure ws04_api_normal
echo ALL DONE >> $L/progress.txt
