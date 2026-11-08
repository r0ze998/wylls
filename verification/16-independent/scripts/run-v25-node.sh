#!/bin/sh
# ⑯ phase 17: verifier, findex, herald on ④'s af41e617 (key-free tests only; see REPORT §18).
S=/tmp/claude-0/-home-user-wylls/47a54b0f-427a-5cca-bc82-feb7c5056956/scratchpad
W=$S/v25; L=$S/logs-v25
export CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never
step(){ n=$1; shift; { echo "### $n HEAD $(git -C $W rev-parse HEAD) tree $(git -C $W rev-parse HEAD^{tree})"; git -C $W status --short; } > $L/$n.log; (cd $W/frontier-node && "$@") >> $L/$n.log 2>&1; echo "exit=$?" >> $L/$n.log; echo "$(date -u +%H:%M:%S) $n $(tail -1 $L/$n.log)" >> $L/progress.txt; }
step verify cargo test --locked --offline --no-fail-fast -p verify --lib --test camp_clear --test custody --test custody_history --test custody_state --test evidence --test history --test ledger_history --test missing_state --test new_bands --test open_items --test resident_ledger --test unit --test ws04_scan_resident --test history_assurance --test v16_v27_gate --test v16_cpi_keyfree
step verify-fixtures cargo test --locked --offline -p verify --test fixtures -- --skip march_fixture_is_fresh
step findex-ingest-keyfree cargo test --locked --offline -p findex --test ingest -- --exact rpc_poll_pages_back_to_the_last_signature rpc_poll_refuses_a_server_that_ignores_before rpc_poll_refuses_a_history_gap rpc_poll_tolerates_another_order_within_a_slot
step findex cargo test --locked --offline --no-fail-fast -p findex --lib --test coverage --test ledger --test no_hidden_gap --test open_items --test store_failure --test ws04_feed_scan --test ws04_join_adversarial --test wide_typed_index --test v16_history_gaps --test v16_history_coverage -- --test-threads=1
step localnet-feed-scan cargo test --locked --offline -p localnet --lib feed_scan_tests::
step herald cargo test --locked --offline -p herald --test ingest_health --test wide --test wide_capture --test wide_index_read -- --test-threads=1
step keeper-wide cargo test --locked --offline --no-fail-fast -p keeper --features wide-world-experimental --test wide_duties --test wide_discovery --test wide_reveal --test wide_snapshot_rpc --test wide_feed_guard -- --test-threads=1
echo "$(date -u +%H:%M:%S) NODE ALL DONE" >> $L/progress.txt
cd $W
{ echo "### abi-world-index HEAD $(git -C $W rev-parse HEAD)"; cargo test --locked --offline -p frontier-abi --lib world_index -- --test-threads=1; echo "exit=$?"; } > $L/abi-world-index.log 2>&1; echo "$(date -u +%H:%M:%S) abi-world-index $(tail -1 $L/abi-world-index.log)" >> $L/progress.txt
for feat in "" "--features wide-world-experimental"; do n=frontier-map-growth${feat:+-wide}; { echo "### $n HEAD $(git -C $W rev-parse HEAD)"; cargo test --locked --offline -p permutation-frontier --lib $feat map_growth -- --test-threads=1; echo "exit=$?"; } > $L/$n.log 2>&1; echo "$(date -u +%H:%M:%S) $n $(tail -1 $L/$n.log)" >> $L/progress.txt; done
echo "$(date -u +%H:%M:%S) FRONTIER DONE" >> $L/progress.txt
cd $W/frontier-node
step(){ n=$1; shift; { echo "### $n HEAD $(git -C $W rev-parse HEAD) tree $(git -C $W rev-parse HEAD^{tree})"; git -C $W status --short; } > $L/$n.log; (cd $W/frontier-node && "$@") >> $L/$n.log 2>&1; echo "exit=$?" >> $L/$n.log; echo "$(date -u +%H:%M:%S) $n $(tail -1 $L/$n.log)" >> $L/progress.txt; }
step verify-wide cargo test --locked --offline --no-fail-fast -p verify --features wide-world-experimental --lib --test v16_vw_unknown --test history --test ledger_history --test history_assurance --test resident_ledger --test ws04_scan_resident --test new_bands --test evidence -- --test-threads=1
step findex-wide cargo test --locked --offline -p findex --features wide-records-experimental --test wide_typed_index -- --test-threads=1
step herald-wide cargo test --locked --offline -p herald --features wide-world-experimental --test wide --test wide_capture -- --test-threads=1
cd $W
{ echo "### abi-world-index-feat HEAD $(git -C $W rev-parse HEAD)"; cargo test --locked --offline -p frontier-abi --features world-index-experimental --lib world_index -- --test-threads=1; echo "exit=$?"; } > $L/abi-world-index-feat.log 2>&1; echo "$(date -u +%H:%M:%S) abi-world-index-feat $(tail -1 $L/abi-world-index-feat.log)" >> $L/progress.txt
echo "$(date -u +%H:%M:%S) WIDE DONE" >> $L/progress.txt
