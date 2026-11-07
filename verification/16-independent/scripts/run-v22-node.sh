#!/bin/sh
# ⑯ phase 14: verifier, findex, herald on ④'s 8234b8dd (key-free tests only; see REPORT §18).
S=/tmp/claude-0/-home-user-wylls/47a54b0f-427a-5cca-bc82-feb7c5056956/scratchpad
W=$S/v22-gh; L=$S/logs-v22
export CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never
step(){ n=$1; shift; { echo "### $n HEAD $(git -C $W rev-parse HEAD) tree $(git -C $W rev-parse HEAD^{tree})"; git -C $W status --short; } > $L/$n.log; (cd $W/frontier-node && "$@") >> $L/$n.log 2>&1; echo "exit=$?" >> $L/$n.log; echo "$(date -u +%H:%M:%S) $n $(tail -1 $L/$n.log)" >> $L/progress.txt; }
step verify cargo test --locked --offline --no-fail-fast -p verify --lib --test camp_clear --test custody --test custody_history --test custody_state --test evidence --test history --test ledger_history --test missing_state --test new_bands --test open_items --test resident_ledger --test unit --test ws04_scan_resident --test v16_v27_gate --test v16_cpi_keyfree
step verify-fixtures cargo test --locked --offline -p verify --test fixtures -- --skip march_fixture_is_fresh
step findex-ingest-keyfree cargo test --locked --offline -p findex --test ingest -- --exact rpc_poll_pages_back_to_the_last_signature rpc_poll_refuses_a_server_that_ignores_before rpc_poll_refuses_a_history_gap rpc_poll_tolerates_another_order_within_a_slot
step findex cargo test --locked --offline --no-fail-fast -p findex --lib --test coverage --test ledger --test no_hidden_gap --test open_items --test store_failure --test ws04_feed_scan --test ws04_join_adversarial --test v16_history_gaps --test v16_history_coverage -- --test-threads=1
step localnet-feed-scan cargo test --locked --offline -p localnet --lib feed_scan_tests::
step herald cargo test --locked --offline -p herald --test ingest_health -- --test-threads=1
echo "$(date -u +%H:%M:%S) NODE ALL DONE" >> $L/progress.txt
