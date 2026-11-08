#!/bin/sh
# Workstream 12's key-free tests: only the audited files in tools/keyfree-tests.txt, each run with key generation,
# derivation and signing disabled (tools/nokey-guard.mjs) as a backstop. A listed test that reaches a key operation
# is a FAILURE (the audit was wrong), not a skip. Tests outside the list are not started.
#   sh workstreams/12-memory/tools/test-nokey.sh [test files...]   (default: the list; extra files must be audited)
#   NOKEY_LIST_RAN=1 also lists the tests that ran.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
if [ $# -eq 0 ]; then
  set --
  while IFS= read -r l; do case "$l" in ''|'#'*) ;; *) set -- "$@" "$here/$l" ;; esac; done < "$here/tools/keyfree-tests.txt"
fi
for f in "$@"; do
  echo "@@file $(basename "$f")"
  node --import "$here/tools/nokey-guard.mjs" --test --test-reporter=tap "$f" 2>&1
done | NOKEY_STRICT=1 node "$here/tools/nokey-summary.mjs"
