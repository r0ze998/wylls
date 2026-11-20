#!/bin/sh
# Workstream 12: regenerate the demo artifacts and run the key-free regression tests (no network), both with key
# generation, derivation and signing disabled (tools/nokey-guard.mjs). The demo's allocation signatures come from
# fixtures/presigned-signatures.json (fixtures/presigned.mjs), so it signs nothing. Only the audited files of
# tools/keyfree-tests.txt run (adapters-ws13-real among them: 13's harness is keyless; it skips without the gateway's
# npm dependencies); the two key tests (allocation-signature, presigned-table) do not.
set -eu
cd "$(dirname "$0")"
node --import ./tools/nokey-guard.mjs demo/run-demo.mjs --json results/demo-output.json > results/demo-console.txt
tail -n 1 results/demo-console.txt
sh tools/test-nokey.sh
