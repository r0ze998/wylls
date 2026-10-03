#!/usr/bin/env bash
# Verifies or restores a playtest backup (PT-A; backups: scripts/playtest-backup.sh).
#
#   scripts/playtest-restore.sh --verify [BACKUP]   open the backup's chain on a spare port
#                                                   (127.0.0.1:41138, paused, then stopped),
#                                                   check the keepers' journals; change nothing
#   scripts/playtest-restore.sh [--with-secrets] BACKUP
#                                                   put the backup in place of the run
#
# BACKUP is a directory under $PLAYTEST_DATA/backups/ (default for --verify: the newest).
# A restore needs the stack stopped (scripts/playtest-down.sh). The current run
# directory is MOVED to $PLAYTEST_DATA/old/restore-<stamp>/ (never deleted); the
# logs are not part of a backup and start empty. The secrets (gate key, invite
# secret) are kept as they are unless --with-secrets, and refused if the gate
# key on disk is not the one the backup's season names. Then:
#   scripts/playtest-up.sh        (resumes: the chain re-executes its ledger from the
#                                  newest snapshot; the game clock is the slot count,
#                                  so the time since the backup is lost game time,
#                                  and players who joined since are not in the chain)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=playtest-lib.sh
. "$HERE/playtest-lib.sh"
umask 077
VERIFY=0; SECRETS=0; B=""
while [ $# -gt 0 ]; do
  case "$1" in
    --verify) VERIFY=1 ;;
    --with-secrets) SECRETS=1 ;;
    -h|--help) pt_help "$0"; exit 0 ;;
    -*) echo "unknown argument $1" >&2; exit 2 ;;
    *) B="$1" ;;
  esac
  shift
done
if [ -z "$B" ] && [ $VERIFY -eq 1 ]; then B="$PT_BACKUPS/$(ls -1 "$PT_BACKUPS" 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}$' | sort | tail -1)"; fi
case "$B" in /*) ;; ''|*) [ -d "$B" ] || B="$PT_BACKUPS/$B" ;; esac
[ -d "$B/run" ] || { echo "not a backup: $B (no run/)" >&2; exit 2; }
[ -f "$B/run/state.json" ] || { echo "the backup has no state.json" >&2; exit 2; }

fail=0
say() { printf '%s\n' "$*"; }
# --- the chain opens
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"; [ -n "${LPID:-}" ] && kill "$LPID" 2>/dev/null' EXIT
cp -R "$B/run/localnet" "$tmp/localnet"
snaps="$(ls -1 "$tmp"/localnet/snap-*.bin 2>/dev/null | wc -l | tr -d ' ')"
say "chain: $snaps snapshots, ledger $(stat -f %z "$tmp/localnet/ledger.wal" 2>/dev/null || echo missing) bytes"
"$PT_BIN/frontier-localnet" --port 41138 --ws-port 41139 --data-dir "$tmp/localnet" --start-paused > "$tmp/localnet.log" 2>&1 &
LPID=$!
up=0
for _ in $(seq 1 300); do
  r="$(curl -sf --max-time 2 -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"frontier_status","params":[]}' http://127.0.0.1:41138 2>/dev/null)" && [ -n "$r" ] && { up=1; break; }
  kill -0 "$LPID" 2>/dev/null || break
  sleep 1
done
if [ $up -eq 1 ]; then say "chain opens: $r"; else say "CHAIN DID NOT OPEN"; tail -5 "$tmp/localnet.log"; fail=1; fi
grep -E "recovered|cannot" "$tmp/localnet.log" | head -3
kill "$LPID" 2>/dev/null; wait "$LPID" 2>/dev/null; LPID=""
# --- the journals
for k in keeper-a keeper-b; do
  db="$B/run/$k/keeper.journal.sqlite"
  if [ -f "$db" ]; then
    chk="$(sqlite3 -readonly "$db" 'pragma integrity_check' 2>&1 | head -1)"
    n="$(sqlite3 -readonly "$db" 'select count(*) from attempts' 2>&1)"
    say "$k journal: integrity $chk, $n attempts"
    [ "$chk" = ok ] || fail=1
  else say "$k journal: MISSING"; fail=1; fi
done
[ -f "$B/run/relay/relay-state.json" ] && say "relay state: present ($(wc -c < "$B/run/relay/relay-state.json" | tr -d ' ') bytes)" || { say "relay state: MISSING"; fail=1; }
[ -f "$B/backup.json" ] && say "backup.json: $(tr -d '\n' < "$B/backup.json")"
if [ $VERIFY -eq 1 ]; then [ $fail -eq 0 ] && say "VERIFIED" || say "NOT VERIFIED"; exit $fail; fi
[ $fail -eq 0 ] || { echo "the backup does not verify; not restoring" >&2; exit 1; }

# --- restore
if bpid="$(pt_alive_pid "$PT_DATA/supervise.pid" playtest-supervise)"; then echo "the babysitter is running (pid $bpid): scripts/playtest-down.sh first" >&2; exit 1; fi
for pf in $(grep -o '"pid": *[0-9]*' "$PT_RUN/state.json" 2>/dev/null | grep -o '[0-9]*$'); do
  ps -o command= -p "$pf" 2>/dev/null | grep -qE 'frontier-|server.mjs' && { echo "a component of the run is still alive (pid $pf): scripts/playtest-down.sh first" >&2; exit 1; }
done
if [ $SECRETS -eq 0 ] && [ -f "$B/secrets/gate.key" ] && [ -f "$PT_SECRETS/gate.key" ] && ! cmp -s "$B/secrets/gate.key" "$PT_SECRETS/gate.key"; then
  echo "the gate key on disk is not the backup's: the restored season would not accept it. Use --with-secrets." >&2; exit 1
fi
old="$PT_DATA/old/restore-$(date +%Y%m%dT%H%M%S)"
mkdir -p -m 700 "$old"
[ -d "$PT_RUN" ] && mv "$PT_RUN" "$old/run-before-restore"
if [ $SECRETS -eq 1 ] && [ -d "$PT_SECRETS" ]; then mv "$PT_SECRETS" "$old/secrets-before-restore"; fi
mkdir -p -m 700 "$PT_RUNS"
cp -R "$B/run" "$PT_RUN"
mkdir -p "$PT_RUN/logs"
if [ $SECRETS -eq 1 ] || [ ! -d "$PT_SECRETS" ]; then cp -R "$B/secrets" "$PT_SECRETS"; fi
chmod -R go-rwx "$PT_RUN" "$PT_SECRETS" 2>/dev/null
rm -f "$PT_DATA/STOP" "$PT_DATA/LAG-ALARM" "$PT_DATA/HEALTH-ALARM"
say "restored $B into $PT_RUN (the previous run is in $old). Start it: scripts/playtest-up.sh"
