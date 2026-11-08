#!/bin/sh
# ⑯: ⑬'s full keyless suite with the real integrations (④ runexec built from this tree, ⑤ 10e74967, ⑫/⑬ from this tree),
# following workstreams/13-citizens/INTEGRATION-WS04-20261108.ja.md §5. Arg: worktree name (v24 or v24-13).
S=/tmp/claude-0/-home-user-wylls/47a54b0f-427a-5cca-bc82-feb7c5056956/scratchpad
W=$S/$1; L=$S/logs-v27; G=$L/ws13-full-guard-$1.log; : > $G
B=$S/v25/workstreams/04-execution/target/debug/runexec
echo "### ws13-full $1 HEAD $(git -C $W rev-parse HEAD) tree-of-13 $(git -C $W rev-parse HEAD:workstreams/13-citizens) worktree-13 $(cd $W && git add -A workstreams/13-citizens && git write-tree) runexec sha256 $(sha256sum $B | cut -c1-64) ws05 $(git -C $S/w05 rev-parse HEAD)" > $L/ws13-full-$1.log
files=$(ls $W/workstreams/13-citizens/test/*.test.mjs | grep -v ws12-public-evidence.test.mjs)
cd $W/permutation-gateway && env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u WS13_WITH_KEYS \
  NODE_OPTIONS="--import $W/scripts/ci/no-keys-guard.mjs --import $W/workstreams/13-citizens/test/keyless-guard.mjs" \
  WS13_GUARD_LOG=$G WS05_ROOT=$S/w05 WS05_EXPECT=10e749677d96301766c2930a8f903baf28cce0bc WS12_ROOT=$W WS13_ROOT=$W WS16_REAL_VIEWS=/home/user/wylls/verification/16-independent/probes/fixtures/v16-real-views-20db3313.jsonl \
  WS04_ACTS_CLIENT=$W/workstreams/04-execution/clients/acts.mjs WS04_RUNS_CLIENT=$W/workstreams/04-execution/clients/runs.mjs \
  RUNEXEC_BIN=$B RUNEXEC_VIEW_BIN=$B timeout 3000 node --test $files >> $L/ws13-full-$1.log 2>&1
echo exit=$? >> $L/ws13-full-$1.log
