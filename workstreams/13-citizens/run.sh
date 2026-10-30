#!/usr/bin/env bash
# Workstream 13: the residents' tests and the demo, locally only.
#
#   workstreams/13-citizens/run.sh
#
# Needs Node 20+ and `npm ci --prefix permutation-gateway` (the residents
# import the gateway's modules, unchanged). No chain, no model, no network,
# no key; it refuses to run with a paid-API key in the environment. Writes
# results/: the test log, and the demo's summary and transcript for a plain
# run and for a run restarted at bell 70.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$here/results"
mkdir -p "$out"
work="$(mktemp -d "${TMPDIR:-/tmp}/ws13.XXXXXX")"
trap 'rm -rf "$work"' EXIT
( cd "$here" && node --test test/*.test.mjs ) 2>&1 | tee "$out/tests.log" | grep -E '^# (tests|pass|fail)'
node "$here/demo/run-demo.mjs" --out "$work/plain" --bells 200 > /dev/null
node "$here/demo/run-demo.mjs" --out "$work/restart" --bells 200 --restart-at 70 > /dev/null
cp "$work/plain/summary.json" "$out/demo-summary.json"
cp "$work/plain/transcript.md" "$out/demo-transcript.ja.md"
cp "$work/restart/summary.json" "$out/demo-restart-summary.json"
norm() { sed -E 's/[0-9a-f]{16}/ID/g; /restart:/d' "$1" | sha256sum | cut -d' ' -f1; }
a="$(norm "$work/plain/transcript.md")"; b="$(norm "$work/restart/transcript.md")"
echo "ws13: transcript plain $a restart $b $([ "$a" = "$b" ] && echo same || echo DIFFERENT)" | tee "$out/restart-compare.log"
echo "ws13: results in $out (root $root)"
