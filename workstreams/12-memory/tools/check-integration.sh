#!/bin/sh
# Workstream 12 against the integration candidate's real code (workstreams 4, 8, 13), without changing that branch:
# a temporary worktree of REF, this tree's workstreams/12-memory copied over it, then
#   - 12's tests (the real-13 tests run there instead of skipping; the full resident run needs 13's npm
#     dependencies and skips with the reason when they are not installed),
#   - 13's own test of the 12->13 public-evidence sidecar, against this 12,
#   - with --regen-ws04: build 4's runexec, rerun its demo scenarios and diff the receipt vectors in
#     fixtures/ws04-receipts (needs cargo; the vectors' provenance names the commit they came from).
#   sh workstreams/12-memory/tools/check-integration.sh [REF] [--regen-ws04]
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
ref=${1:-origin/integration/ws09-13-v16-d0949fd4}
regen=${2:-}
wt=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || true' EXIT
git -C "$repo" worktree add -q --detach "$wt" "$ref"
echo "integration ref: $ref = $(git -C "$wt" rev-parse HEAD)"
cp -R "$here/." "$wt/workstreams/12-memory/"
cd "$wt"
echo "== 12's tests on the integration tree"
node --test workstreams/12-memory/test/*.test.mjs 2>&1 | grep -E "^# (tests|pass|fail|skipped)|^not ok|# SKIP" || true
echo "== 13's ws12-public-evidence test against this 12"
node --test workstreams/13-citizens/test/ws12-public-evidence.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)|^not ok" || true
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
  done
fi
