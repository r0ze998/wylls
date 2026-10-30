# The MCP play on a real local stack

`local-stack.mjs` plays the MCP flow end to end against a disposable local world. That world has `frontier-localnet` (a local test chain), the Frontier program, the keeper, the herald, and the relay with the agent wallet. Test USDC only, local ports only.

The relay must have [patch 0005](../../patches/0005-agent-wallet-sendcaravan.patch), which makes SendCaravan an agent action. The main tree stays unpatched: the stack runs its relay from a throwaway worktree through `PSF_REPO`, and every build comes from the main tree.

```sh
# 0. Builds (once): see docs/RUNNING.md §2
scripts/build-frontier.sh --features test-beacon && scripts/build-prize.sh
npm ci --prefix permutation-gateway && (cd frontier-node && cargo build --locked --release --workspace)

# 1. A worktree with patch 0005, its build outputs and node_modules linked to the main tree's
W=/tmp/ws03-gw; git worktree add --detach $W HEAD
git -C $W apply "$PWD/workstreams/03-composability/patches/0005-agent-wallet-sendcaravan.patch"
for d in permutation-frontier/target permutation-prize/target frontier-node/target permutation-gateway/node_modules; do ln -s "$PWD/$d" "$W/$d"; done

# 2. The stack (foreground; a second terminal for step 3). The agent keys live outside the run directory.
K=/tmp/ws03-agentkeys; mkdir -p $K
(cd $W && PSF_REPO=$W FRONTIER_AGENT_WALLET=1 FRONTIER_AGENT_RECONCILE_MS=3000 \
  FRONTIER_AGENT_CUSTODY_KEY_FILE=$K/agent-custody.json FRONTIER_AGENT_KEYS_DIR=$K/agent-keys \
  "$OLDPWD/frontier-node/target/release/frontier-stack" up --conquest --mode accel --beacon test-key --preseason-scale 2000 --scale 10 \
  --game-hours 16 --season-end-at-play-end --bots 0 --personas off --prize-so permutation-prize/target/deploy/permutation_prize.so \
  --entry-fee 25000000 --run-id ws03-mcp-$(date +%s) --base-port 41700 --season 92)

# 3. The play
WS03_E2E_HERALD=http://127.0.0.1:41740 WS03_E2E_RPC=http://127.0.0.1:41710 node workstreams/03-composability/mcp/e2e/local-stack.mjs

# 4. Clean up
frontier-node/target/release/frontier-stack down --run-id <the run id>; git worktree remove --force $W
```

The transcript goes to `workstreams/03-composability/results/mcp-local-stack.json`.
