#!/bin/sh
# Workstream 12 against the integration candidate's real code (workstreams 4, 8, 13), without changing that branch:
# a temporary worktree of REF, this tree's workstreams/12-memory copied over it, then
#   - 12's tests (the real-13 tests run there instead of skipping; the full resident run needs 13's npm
#     dependencies and skips with the reason when they are not installed),
#   - 13's own tests of the 12->13 sidecar and adapter (where REF has them), against this 12,
#   - with --regen-ws04: build 4's runexec, rerun its demo scenarios and diff the receipt vectors in
#     fixtures/ws04-receipts, and read each real store with adapters/canonical.mjs (needs cargo; the
#     vectors' provenance names the commit they came from).
#   sh workstreams/12-memory/tools/check-integration.sh [REF | FILE.bundle#SHA] [--regen-ws04]
# A commit that is not on GitHub can be checked from a git bundle: FILE.bundle#SHA fetches SHA from the bundle
# (after `git bundle verify`) into this clone's object store without touching any branch.
# Tests run with key generation, derivation and signing disabled (tools/test-nokey.sh); tests that need a key are
# listed as needs-key and not run. There is no mode that runs them.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
ref=${1:-origin/integration/ws09-13-v16-d0949fd4}
regen=${2:-}
case "$ref" in
  *.bundle\#*)
    bundle=${ref%%#*}; ref=${ref#*#}
    git -C "$repo" bundle verify "$bundle" >/dev/null
    git -C "$repo" fetch -q "$bundle" "$ref" 2>/dev/null || git -C "$repo" fetch -q "$bundle" "refs/*:refs/ws12-check/*"
    git -C "$repo" cat-file -e "$ref^{commit}" ;;
esac
wt=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || true' EXIT
git -C "$repo" worktree add -q --detach "$wt" "$ref"
echo "integration ref: $ref = $(git -C "$wt" rev-parse HEAD)"
cp -R "$here/." "$wt/workstreams/12-memory/"
cd "$wt"
echo "== 12's tests on the integration tree (no key operations)"
sh workstreams/12-memory/tools/test-nokey.sh || true
echo "== 13's own ws12 tests against this 12 (those present at REF)"
export WS12_EA0636EB="$wt" # 13's name for "a tree with workstream 12": here, this 12 overlaid on REF
for t in workstreams/13-citizens/test/ws12-public-evidence.test.mjs workstreams/13-citizens/test/ws12-adapter.test.mjs \
         workstreams/13-citizens/test/ws12-identity-clock.test.mjs workstreams/13-citizens/test/ws12-canonical.test.mjs; do
  [ -f "$t" ] || { echo "$t: not at this ref"; continue; }
  echo "-- $t"
  sh workstreams/12-memory/tools/test-nokey.sh "$t" || true
  node --import ./workstreams/12-memory/tools/nokey-guard.mjs --test "$t" 2>&1 | grep -E "ERR_MODULE_NOT_FOUND" | head -1 || true
done
if [ "$regen" = "--regen-ws04" ]; then
  echo "== 4's receipt vectors"
  (cd workstreams/04-execution && cargo build -q --release --bin runexec)
  out=$(mktemp -d)
  for sc in happy crash raid lost-response; do
    workstreams/04-execution/target/release/runexec demo --db "$out/$sc.db" --scenario "$sc" >/dev/null
    python3 -I - "$out/$sc.db" "$here/fixtures/ws04-receipts/$sc.json" "$sc" <<'PY'
import sqlite3, json, sys
db, fixture, sc = sys.argv[1:4]
c = sqlite3.connect(db)
now = [dict(run_id=r[0], kind=r[1], subject=r[2], source=r[3], slot=r[4], body_json=r[5]) for r in c.execute('select run_id,kind,subject,source,slot,body from receipts order by slot,kind,subject,source')]
was = json.load(open(fixture))['receipts']
print(sc, 'receipts identical' if now == was else 'RECEIPTS DIFFER')
PY
    WS04_DB="$out/$sc.db" WS04_SCENARIO="$sc" node --import ./workstreams/12-memory/tools/nokey-guard.mjs --test --test-name-pattern="real store" workstreams/12-memory/test/adapters-canonical.test.mjs 2>&1 | grep -E "^(not )?ok" || true
  done
fi
