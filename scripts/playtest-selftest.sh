#!/usr/bin/env bash
# The playtest's own smoke test (PT-A), localhost only: brings the stack up in a
# THROW-AWAY data directory (never the real one), makes an invite, joins once
# through the herald in a headless browser, looks at the health report, kills one
# component and the supervisor to see them come back, takes and verifies a
# backup, and shuts everything down cleanly.
#
#   scripts/playtest-selftest.sh [--bots N] [--data DIR] [--keep] [--join-timeout-min M]
#
# It uses the real config's ports (41112-41123), so it refuses to run while the
# real playtest (or anything else) holds them. Wall time: about 20 minutes at
# 1x: the season's first bell must pass before a Join is accepted (genesis is
# about 9 minutes after the start, joins open one bell later). Exit 0 only if
# every step passed. Needs playwright-core (see playtest-join-check.mjs).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BOTS=12; DATA=""; KEEP=0; JOIN_MIN=40
while [ $# -gt 0 ]; do
  case "$1" in
    --bots) BOTS="$2"; shift 2 ;;
    --data) DATA="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --join-timeout-min) JOIN_MIN="$2"; shift 2 ;;
    -h|--help) pt_help "$0"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$DATA" ] || DATA="$(mktemp -d "${TMPDIR:-/tmp}/psf-playtest-selftest.XXXXXX")"
case "$DATA" in */playtest|*/playtest/) echo "refusing to use a directory named playtest (the real data root)" >&2; exit 2 ;; esac
mkdir -p "$DATA"
SRC="${PLAYTEST_CONFIG:-$ROOT/frontier-node/configs/playtest-1x.toml}"
CFG="$DATA/selftest-config.toml"
# only the top-level keys (before the first [section]): `bots = 22` under [ports] is a port offset
awk -v bots="$BOTS" 'BEGIN { top = 1 } /^\[/ { top = 0 } top && $1 == "run_id" && $2 == "=" { print "run_id = \"playtest-selftest\""; next } top && $1 == "bots" && $2 == "=" { print "bots = " bots; next } { print }' "$SRC" > "$CFG"
export PLAYTEST_DATA="$DATA" PLAYTEST_CONFIG="$CFG"
FAIL=0
step() { printf '\n== %s\n' "$*"; }
ok() { printf 'PASS  %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAIL=1; }

step "up"
"$HERE/playtest-up.sh" || { bad "playtest-up.sh"; exit 1; }
. "$HERE/playtest-lib.sh"
ok "stack up; herald http://127.0.0.1:$PT_HERALD_PORT"

step "invite"
"$HERE/playtest-invite.sh" 2 --label selftest --base-url "http://127.0.0.1:$PT_HERALD_PORT" || bad "playtest-invite.sh"
CSV="$(ls -1t "$DATA"/invites/*.csv 2>/dev/null | head -1)"
CODE="$(sed -n 2p "$CSV" | cut -d, -f1)"
[ -n "$CODE" ] && ok "invite CSV $CSV ($(($(wc -l < "$CSV") - 1)) codes)" || bad "no invite code"

step "join through the herald (headless browser; waits for the first bell)"
"$PT_NODE" "$HERE/playtest-join-check.mjs" --herald "http://127.0.0.1:$PT_HERALD_PORT" --invite "$CODE" --wait-min "$JOIN_MIN" && ok "joined" || bad "join"
step "the relay's event log records the join (invite nonce, wallet, signature)"
python3 - "$PT_RUN/relay/relay-events.jsonl" <<'PY' && ok "relay event log has the join" || bad "relay event log has no join"
import json, sys
ev = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
assert any(e["event"] == "join" and e["invite"] for e in ev), ev
PY

step "status"
"$HERE/playtest-status.sh" | sed -n 1,14p
"$HERE/playtest-status.sh" --json > "$DATA/status-selftest.json"; rc=$?
[ $rc -eq 0 ] && ok "status healthy (exit 0)" || bad "status exit $rc"

step "kill -9 the relay: the stack supervisor restarts it"
rp="$(python3 -c "import json;print(json.load(open('$PT_RUN/state.json'))['components']['relay']['pid'])")"
kill -9 "$rp"; sleep 12
np="$(python3 -c "import json;print(json.load(open('$PT_RUN/state.json'))['components']['relay']['pid'])")"
[ "$np" != "$rp" ] && kill -0 "$np" 2>/dev/null && ok "relay restarted ($rp -> $np)" || bad "relay not restarted"

step "kill -9 the stack supervisor: the babysitter resumes the same run"
sp="$(cat "$DATA/stack.pid")"
kill -9 "$sp"; sleep 40
"$HERE/playtest-status.sh" > "$DATA/status-after-resume.txt"; rc=$?
[ $rc -eq 0 ] && grep -q "1 resume" "$DATA/status-after-resume.txt" && ok "resumed (status healthy, 1 resume)" || { bad "resume (status exit $rc)"; sed -n 1,6p "$DATA/status-after-resume.txt"; }

step "backup and verify"
"$HERE/playtest-backup.sh" && ok "backup" || bad "backup"
"$HERE/playtest-restore.sh" --verify && ok "backup verifies (chain opens, journals intact)" || bad "backup verify"

step "down"
"$HERE/playtest-down.sh" && ok "down" || bad "down"
ports_up="$(lsof -nP -iTCP:$PT_HERALD_PORT -iTCP:$((PT_BASE_PORT + $(pt_cfg_in ports localnet))) -sTCP:LISTEN 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')"
[ "$ports_up" = 0 ] && ok "no listener left on the playtest ports" || bad "$ports_up listeners left on the playtest ports"
sleep 1
[ ! -e "$DATA/supervise.pid" ] && ok "babysitter gone" || bad "babysitter pid file remains"
[ $KEEP -eq 1 ] || { echo "removing the throw-away data directory $DATA"; rm -rf "$DATA"; }
echo
[ $FAIL -eq 0 ] && { echo "SELFTEST PASSED"; exit 0; } || { echo "SELFTEST FAILED"; exit 1; }
