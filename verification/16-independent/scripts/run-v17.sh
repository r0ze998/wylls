#!/usr/bin/env bash
S=/tmp/claude-0/-home-user-wylls/47a54b0f-427a-5cca-bc82-feb7c5056956/scratchpad; W=$S/v12-int; L=$S/logs-v16
export CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never CARGO_TARGET_DIR=/home/user/wylls/frontier-node/target
{ echo "### 6984acfa verify HEAD $(git -C $W rev-parse HEAD) tree $(git -C $W rev-parse HEAD^{tree})"; git -C $W status --short | grep -v node_modules
  cd $W/frontier-node && cargo test --locked -p verify --lib checks::v27_residents -- --test-threads=1
  cargo test --locked --no-fail-fast -p verify --test v16_v27_gate --test v16_cpi_keyfree --test evidence --test new_bands -- --test-threads=1; echo exit=$?; } > $L/6984-verify.log 2>&1
