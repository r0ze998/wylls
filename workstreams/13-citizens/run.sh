#!/usr/bin/env bash
# Workstream 13: the residents' tests and the demo, locally only.
#
#   workstreams/13-citizens/run.sh              # KEYLESS (default): no key is generated, derived or used
#   workstreams/13-citizens/run.sh --with-keys  # the signed mode (WS13_WITH_KEYS=1): every participant makes an ed25519 test key
#
# The keyless run preloads test/keyless-guard.mjs: it sets WS13_KEYLESS=1 and makes every node:crypto key, signature
# and HMAC function, every @solana/web3.js PDA, keypair and signing function, and the repository's own PDA helper
# (client/src/solana-tx.mjs) throw, logging each attempt to $WS13_GUARD_LOG when set. So shared set-up cannot make,
# derive or use a key, or derive a PDA, by accident; tests that sign or check signatures skip.
# test/ws12-public-evidence.test.mjs imports this tree's workstream 12 fixture: it runs only when that fixture derives
# no key on import (workstream 12 1583026f and later); an older fixture derived keys from fixed seeds and is left out.
#
# Needs Node 20+ and `npm ci --prefix permutation-gateway` (the residents import the gateway's modules, unchanged).
# No chain, no model, no network, no API key; it refuses to run with a paid-API key in the environment. Writes
# results/: the test log, and the demo's summary and transcript for a plain run and for a run restarted at bell 70.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$here/results"
mkdir -p "$out"
work="$(mktemp -d "${TMPDIR:-/tmp}/ws13.XXXXXX")"
trap 'rm -rf "$work"' EXIT
if [ "${1:-}" = "--with-keys" ]; then
  mode=keyed; pre=(); files=("$here"/test/*.test.mjs); export WS13_WITH_KEYS=1
else
  mode=keyless; pre=(--import "$here/test/keyless-guard.mjs")
  # ws12-public-evidence imports this tree's workstream 12 fixture: kept only when that fixture derives no key on
  # import (1583026f and later: lazy keys).
  lazy12=no; grep -q lazyKeys "$root/workstreams/12-memory/fixtures/scenario.mjs" 2>/dev/null && lazy12=yes
  files=(); for f in "$here"/test/*.test.mjs; do [ "$(basename "$f")" = ws12-public-evidence.test.mjs ] && [ $lazy12 = no ] && continue; files+=("$f"); done
fi
echo "ws13: mode $mode"
( cd "$here" && node "${pre[@]}" --test "${files[@]}" ) 2>&1 | tee "$out/tests.log" | grep -E '^# (tests|pass|fail|skipped)'
node "${pre[@]}" "$here/demo/run-demo.mjs" --out "$work/plain" --bells 200 > /dev/null
node "${pre[@]}" "$here/demo/run-demo.mjs" --out "$work/restart" --bells 200 --restart-at 70 > /dev/null
cp "$work/plain/summary.json" "$out/demo-summary.json"
cp "$work/plain/transcript.md" "$out/demo-transcript.ja.md"
cp "$work/restart/summary.json" "$out/demo-restart-summary.json"
norm() { sed -E 's/[0-9a-f]{16}/ID/g; /restart:/d' "$1" | sha256sum | cut -d' ' -f1; }
a="$(norm "$work/plain/transcript.md")"; b="$(norm "$work/restart/transcript.md")"
echo "ws13: mode $mode transcript plain $a restart $b $([ "$a" = "$b" ] && echo same || echo DIFFERENT)" | tee "$out/restart-compare.log"
echo "ws13: results in $out (root $root)"
