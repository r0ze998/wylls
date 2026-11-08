#!/bin/sh
# ⑯ phase 18: ④'s final candidate 7535a17e, in the worktree v25 (checked out at 7535a17e). Key-free only:
# no native-crypto-tests, no local-demo feature, no key-using test file. Each phase's build output is removed once logged.
S=/tmp/claude-0/-home-user-wylls/47a54b0f-427a-5cca-bc82-feb7c5056956/scratchpad
W=$S/v25; L=$S/logs-v27; C=$W/workstreams/04-execution/tools/chain-flow; mkdir -p $L
export CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never
p(){ echo "$(date -u +%H:%M:%S) $*" >> $L/progress.txt; }
hdr(){ echo "### $1 HEAD $(git -C $W rev-parse HEAD) tree $(git -C $W rev-parse HEAD^{tree})"; git -C $W status --short | grep -v '^??'; }
step(){ d=$1; n=$2; shift 2; { hdr $n; (cd $d && "$@"); echo "exit=$?"; } > $L/$n.log 2>&1; p "$n $(tail -1 $L/$n.log)"; }
FN=$W/frontier-node
# A. frontier-node
step $FN verify cargo test --locked --offline --no-fail-fast -p verify --lib --test camp_clear --test custody --test custody_history --test custody_state --test custody_replay --test custody_replay_caravans --test evidence --test history --test history_assurance --test ledger_history --test missing_state --test new_bands --test open_items --test resident_ledger --test unit --test ws04_scan_resident --test rights_replay --test v16_v27_gate --test v16_cpi_keyfree -- --test-threads=1
step $FN verify-fixtures cargo test --locked --offline -p verify --test fixtures -- --skip march_fixture_is_fresh
step $FN verify-wide cargo test --locked --offline --no-fail-fast -p verify --features wide-world-experimental --lib --test v16_vw_unknown --test history --test new_bands -- --test-threads=1
step $FN verify-economy cargo test --locked --offline --no-fail-fast -p verify --features wide-economy-experimental --lib --test wide_economy -- --test-threads=1
step $FN keeper-wide cargo test --locked --offline --no-fail-fast -p keeper --features wide-world-experimental --test wide_duties --test wide_discovery --test wide_reveal --test wide_snapshot_rpc --test wide_feed_guard --test wide_economy_index -- --test-threads=1
step $FN findex cargo test --locked --offline --no-fail-fast -p findex --lib --test coverage --test ledger --test no_hidden_gap --test open_items --test store_failure --test ws04_feed_scan --test ws04_join_adversarial --test v16_history_gaps --test v16_history_coverage -- --test-threads=1
step $FN findex-ingest-keyfree cargo test --locked --offline -p findex --test ingest -- --exact rpc_poll_pages_back_to_the_last_signature rpc_poll_refuses_a_server_that_ignores_before rpc_poll_refuses_a_history_gap rpc_poll_tolerates_another_order_within_a_slot
step $FN findex-wide cargo test --locked --offline -p findex --features wide-records-experimental --test wide_typed_index -- --test-threads=1
step $FN herald cargo test --locked --offline -p herald --test ingest_health --test wide_index_read -- --test-threads=1
step $FN herald-wide cargo test --locked --offline -p herald --features wide-world-experimental --test wide --test wide_capture -- --test-threads=1
step $FN localnet-feed-scan cargo test --locked --offline -p localnet --lib feed_scan_tests::
rm -rf $FN/target; p "frontier-node target removed"
# B. root workspace: world_index, and the wide land / economy / return host tests (map_growth_runtime_tests::wide_land only;
#    the rest of map growth is ⑧'s)
step $W abi-world-index cargo test --locked --offline -p frontier-abi --features world-index-experimental --lib world_index -- --test-threads=1
step $W frontier-wide-land cargo test --locked --offline -p permutation-frontier --features wide-world-experimental --lib map_growth_runtime_tests::wide_land -- --test-threads=1
rm -rf $W/target; p "root target removed"
# C. workstream 04: chain flow, fixtures, mutations, ⑯'s probes, all tests, e2e-native, the runs client
OUT=$S/v27-out; mkdir -p $OUT
{ hdr run.sh; sh $C/run.sh $OUT; echo exit=$?; } > $L/run-sh.log 2>&1; p "run.sh $(tail -1 $L/run-sh.log)"
{ hdr committed; cd $W && node --import ./scripts/ci/no-keys-guard.mjs $C/check-fixtures.mjs; echo exit=$?; } > $L/committed-check.log 2>&1; p "committed $(tail -1 $L/committed-check.log)"
{ hdr cmp; for f in $(ls $C/fixtures-20261106); do if cmp -s $C/fixtures-20261106/$f $OUT/$f; then echo "same $f"; else echo "DIFF $f"; fi; done; } > $L/cmp.log 2>&1; p "cmp $(grep -c '^same' $L/cmp.log) same $(grep -c '^DIFF' $L/cmp.log) diff"
M=$S/v27-mut; mkdir -p $M; python3 -I /home/user/wylls/verification/16-independent/scripts/mutate-chain.py $OUT $M > $L/mutations-made.log 2>&1
: > $L/mutations.log; for d in $(ls $M); do (cd $W && node --import ./scripts/ci/no-keys-guard.mjs $C/check-fixtures.mjs $M/$d) > $L/mut-$d.log 2>&1; echo "$d exit=$? $(grep -E '^FAIL' $L/mut-$d.log | head -2 | tr '\n' ' ')" >> $L/mutations.log; done; p "mutations $(grep -c 'exit=1' $L/mutations.log)/$(wc -l < $L/mutations.log) detected"
step $W/workstreams/04-execution ws04-all cargo test --offline --no-fail-fast -- --test-threads 1
step $W/workstreams/04-execution/e2e-native e2e-native cargo test --offline --no-fail-fast --features nft -- --test-threads 1
B=$W/workstreams/04-execution/target/debug/runexec
{ hdr runs-client; cd $W && RUNEXEC_BIN=$B node --import ./scripts/ci/no-keys-guard.mjs --test workstreams/04-execution/clients/runs.test.mjs; echo exit=$?; } > $L/runs-client.log 2>&1; p "runs-client $(tail -1 $L/runs-client.log)"
p "RUST DONE"
