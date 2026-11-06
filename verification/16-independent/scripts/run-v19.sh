#!/usr/bin/env bash
S=/tmp/claude-0/-home-user-wylls/47a54b0f-427a-5cca-bc82-feb7c5056956/scratchpad; W=$S/v19-r2; L=$S/logs-v19; mkdir -p $L
export CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never CARGO_TARGET_DIR=/home/user/wylls/frontier-node/target
step(){ local n=$1; shift; { echo "### $n HEAD $(git -C $W rev-parse HEAD) tree $(git -C $W rev-parse HEAD^{tree})"; git -C $W status --short; } > $L/$n.log; (cd $W/frontier-node && "$@") >> $L/$n.log 2>&1; echo "exit=$?" >> $L/$n.log; echo "$(date -u +%H:%M:%S) $n $(tail -1 $L/$n.log)" >> $L/progress.txt; }
step findex cargo test --locked --no-fail-fast -p findex --test coverage --test no_hidden_gap --test store_failure --test v16_history_gaps -- --test-threads=1
step herald cargo test --locked -p herald --test ingest_health -- --test-threads=1
step verify cargo test --locked -p verify --test history -- --test-threads=1
echo ALL DONE >> $L/progress.txt
