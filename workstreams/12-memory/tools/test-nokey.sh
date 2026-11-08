#!/bin/sh
# Workstream 12's tests with key generation, derivation and signing disabled (tools/nokey-guard.mjs).
# Each test ends in one of four ways:
#   ran        passed without any key operation
#   needs-key  stopped at the guard before making or using a key: a test of signed allocations, NOT run here
#              (no tool of workstream 12 runs those tests: none enables signing)
#   skipped    skipped with its stated reason
#   FAILED     failed for any other reason: a real failure (exit status 1)
#   sh workstreams/12-memory/tools/test-nokey.sh [test files...]      (default: test/*.test.mjs)
#   NOKEY_LIST_RAN=1 also lists the tests that ran.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
[ $# -gt 0 ] || set -- "$here"/test/*.test.mjs
for f in "$@"; do
  echo "@@file $(basename "$f")"
  node --import "$here/tools/nokey-guard.mjs" --test --test-reporter=tap "$f" 2>&1
done | node "$here/tools/nokey-summary.mjs"
