#!/bin/sh
# ⑯ phase 17: ④'s pushed candidate af41e617 — chain flow, fixtures, mutations, ⑯ caravan probe.
S=/tmp/claude-0/-home-user-wylls/47a54b0f-427a-5cca-bc82-feb7c5056956/scratchpad
W=$S/v25; L=$S/logs-v25; C=$W/workstreams/04-execution/tools/chain-flow
export CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never
hdr(){ echo "### $1 HEAD $(git -C $W rev-parse HEAD) tree $(git -C $W rev-parse HEAD^{tree})"; git -C $W status --short; }
p(){ echo "$(date -u +%H:%M:%S) $*" >> $L/progress.txt; }
{ hdr fetch; (cd $W/workstreams/04-execution && cargo fetch --locked) ; echo exit=$?; } > $L/fetch.log 2>&1; p fetch $(tail -1 $L/fetch.log)
OUT=$S/v25-out; mkdir -p $OUT
{ hdr run.sh; sh $C/run.sh $OUT; echo exit=$?; } > $L/run-sh.log 2>&1; p run.sh $(tail -1 $L/run-sh.log)
{ hdr committed; cd $W && node --import ./scripts/ci/no-keys-guard.mjs $C/check-fixtures.mjs; echo exit=$?; } > $L/committed-check.log 2>&1; p committed $(tail -1 $L/committed-check.log)
{ hdr cmp; for f in $(ls $C/fixtures-20261106); do if cmp -s $C/fixtures-20261106/$f $OUT/$f; then echo "same $f"; else echo "DIFF $f"; fi; done; } > $L/cmp.log 2>&1; p cmp $(grep -c '^same' $L/cmp.log) same $(grep -c '^DIFF' $L/cmp.log) diff
M=$S/v25-mut; mkdir -p $M
python3 -I /home/user/wylls/verification/16-independent/scripts/mutate-chain.py $OUT $M > $L/mutations-made.log 2>&1
: > $L/mutations.log
for d in $(ls $M); do (cd $W && node --import ./scripts/ci/no-keys-guard.mjs $C/check-fixtures.mjs $M/$d) > $L/mut-$d.log 2>&1; e=$?; echo "$d exit=$e $(grep -c '^ok' $L/mut-$d.log) ok; $(grep -E '^FAIL' $L/mut-$d.log | tr '\n' ' ') $(tail -1 $L/mut-$d.log)" >> $L/mutations.log; done; p mutations done
{ hdr caravan-probe; cd $W/workstreams/04-execution && cargo test --offline --test v16_chain_caravan_faults -- --test-threads 1; echo exit=$?; } > $L/v16-caravan-faults.log 2>&1; p probe $(tail -1 $L/v16-caravan-faults.log)

{ hdr ws04-all; cd $W/workstreams/04-execution && cargo test --offline --no-fail-fast -- --test-threads 1; echo exit=$?; } > $L/ws04-all.log 2>&1; p ws04-all $(tail -1 $L/ws04-all.log)
{ hdr e2e-native; cd $W/workstreams/04-execution/e2e-native && cargo test --offline --no-fail-fast --features nft -- --test-threads 1; echo exit=$?; } > $L/e2e-native.log 2>&1; p e2e-native $(tail -1 $L/e2e-native.log)
{ hdr runs-client; cd $W && node --import ./scripts/ci/no-keys-guard.mjs --test workstreams/04-execution/clients/runs.test.mjs; echo exit=$?; } > $L/runs-client.log 2>&1; p runs-client $(tail -1 $L/runs-client.log)
p ALL DONE
