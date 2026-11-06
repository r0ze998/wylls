#!/bin/sh
# Key-free run of ③'s MCP tests under two guards: workstream 04's scripts/ci/no-keys-guard.mjs (key generation,
# derivation, signing) and ./no-pda-guard.mjs (program-derived addresses). Run from the wallet tree's
# permutation-gateway directory so that both guards resolve @solana/web3.js as the code under test does.
#
#   WS03_GATEWAY_ROOT=<wallet tree>/permutation-gateway WS04_ROOT=<④ tree> WS05_ROOT=<⑤ tree> RUNEXEC_BIN=<runexec> \
#     sh workstreams/03-composability/mcp/test/keyfree/run-guarded.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
mcp=$(cd "$here/../.." && pwd)
: "${WS03_GATEWAY_ROOT:?set WS03_GATEWAY_ROOT}" "${WS04_ROOT:?set WS04_ROOT (for scripts/ci/no-keys-guard.mjs)}"
cd "$WS03_GATEWAY_ROOT"
exec node --import "$WS04_ROOT/scripts/ci/no-keys-guard.mjs" --import "$here/no-pda-guard.mjs" --test "$mcp/test/ws04-mapping.test.mjs" "$here"/*.test.mjs
