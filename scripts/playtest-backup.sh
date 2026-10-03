#!/usr/bin/env bash
# One backup of the running playtest (PT-A). Run by the monitor every hour
# (scripts/playtest-watch.mjs tick) and by playtest-down.sh; safe to run by
# hand at any time, while the stack is up.
#
#   scripts/playtest-backup.sh [--to DIR]       (default: $PLAYTEST_DATA/backups/<stamp>)
#
# What is copied (all under the data root; a backup is a directory with the
# same layout as the run, plus secrets/):
#   * the chain: the newest snapshots, THEN the ledger WAL (this order: a
#     restore re-executes the WAL from the newest snapshot it holds, so the
#     WAL copy must not be older than any snapshot copy; a torn last record
#     is cut off by the chain on open);
#   * the keepers' journals through `sqlite3 .backup` (a consistent copy of a
#     live WAL database; `pragma integrity_check` is run on every copy);
#   * the relay's state and event log, the bots' journal, invites and
#     reports, the herald's checkpoint and archive, state.json, events.jsonl,
#     metrics, the run's keys, and secrets/ (gate key, invite secret);
#   * backup.json: what was copied, the chain slot and bell at the time.
# Copies are APFS clones (cp -c: instant, no extra space until a file
# changes) where the volume supports it, plain copies otherwise. Everything
# is mode 0600 / 0700.
#
# Retention: every backup of the last 24 hours, then the first of each UTC
# day, at most 120 in all. A backup on the same disk protects against a bad
# restart, a corrupted file or a mistake, not against losing the disk: set
# PLAYTEST_BACKUP_COPY_TO=/some/other/volume/dir to also rsync the newest
# backup there after each run.
#
# Restore: docs/frontier/playtest/PT-A-OPS.md section 7 (scripts/playtest-restore.sh).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=playtest-lib.sh
. "$HERE/playtest-lib.sh"
umask 077

to=""
while [ $# -gt 0 ]; do
  case "$1" in
    --to) to="$2"; shift 2 ;;
    -h|--help) pt_help "$0"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

[ -f "$PT_RUN/state.json" ] || { echo "no run at $PT_RUN" >&2; exit 2; }
LOCK="$PT_DATA/.backup.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  old="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then echo "a backup is already running (pid $old)" >&2; exit 3; fi
  rm -rf "$LOCK"; mkdir "$LOCK" || exit 3
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

stamp="$(date +%Y%m%dT%H%M%S)"
mkdir -p "$PT_BACKUPS"; chmod 700 "$PT_BACKUPS"
final="${to:-$PT_BACKUPS/$stamp}"
dest="$PT_BACKUPS/.partial-$stamp"
[ -n "$to" ] && dest="$to"
mkdir -p "$dest/run"
t0=$SECONDS
ok=true
note() { printf '%s\n' "$*" >> "$dest/backup.log"; }

# cp -c clones on APFS; fall back to a plain copy.
cpf() { cp -c -p "$1" "$2" 2>/dev/null || cp -p "$1" "$2"; }
cpr() { cp -c -R -p "$1" "$2" 2>/dev/null || cp -R -p "$1" "$2"; }

# --- the chain: snapshots, then the ledger
mkdir -p "$dest/run/localnet"
for f in $(ls -1 "$PT_RUN"/localnet/snap-*.bin 2>/dev/null | sort); do cpf "$f" "$dest/run/localnet/" || { ok=false; note "snapshot $f failed"; }; done
[ -f "$PT_RUN/localnet/ledger.wal" ] && { cpf "$PT_RUN/localnet/ledger.wal" "$dest/run/localnet/" || { ok=false; note "ledger.wal failed"; }; }

# --- the keepers' journals
for k in keeper-a keeper-b; do
  mkdir -p "$dest/run/$k"
  db="$PT_RUN/$k/keeper.journal.sqlite"
  if [ -f "$db" ]; then
    if sqlite3 "$db" ".backup '$dest/run/$k/keeper.journal.sqlite'" 2>>"$dest/backup.log"; then
      chk="$(sqlite3 "$dest/run/$k/keeper.journal.sqlite" 'pragma integrity_check' 2>&1 | head -1)"
      [ "$chk" = ok ] || { ok=false; note "$k journal integrity_check: $chk"; }
    else ok=false; note "$k journal .backup failed"; fi
  fi
  for f in keeper.toml keeper.seed keeper.token beneficiary.key; do [ -f "$PT_RUN/$k/$f" ] && cpf "$PT_RUN/$k/$f" "$dest/run/$k/"; done
done

# --- relay, bots, herald, keys, the run's own files
mkdir -p "$dest/run/relay" "$dest/run/bots" "$dest/run/keys"
for f in "$PT_RUN"/relay/*; do [ -f "$f" ] && cpf "$f" "$dest/run/relay/"; done
for f in "$PT_RUN"/bots/*; do [ -e "$f" ] && cpr "$f" "$dest/run/bots/"; done
[ -d "$PT_RUN/keys" ] && cpr "$PT_RUN/keys/." "$dest/run/keys/"
[ -d "$PT_RUN/herald" ] && cpr "$PT_RUN/herald" "$dest/run/herald"
[ -d "$PT_RUN/metrics" ] && cpr "$PT_RUN/metrics" "$dest/run/metrics"
for f in state.json events.jsonl; do [ -f "$PT_RUN/$f" ] && cpf "$PT_RUN/$f" "$dest/run/"; done
[ -d "$PT_SECRETS" ] && cpr "$PT_SECRETS" "$dest/secrets"
[ -f "$PT_DATA/launch.json" ] && cpf "$PT_DATA/launch.json" "$dest/"

# --- what it is
slot="null"; game="null"; bell="null"
if [ -f "$PT_STATUS/status.json" ]; then
  slot="$("$PT_NODE" -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(JSON.stringify([s.chain&&s.chain.slot,s.chain&&s.chain.game_unix,s.bell&&s.bell.now]))' "$PT_STATUS/status.json" 2>/dev/null || echo '[null,null,null]')"
fi
wal_bytes="$(stat -f %z "$dest/run/localnet/ledger.wal" 2>/dev/null || echo 0)"
snaps="$(ls -1 "$dest"/run/localnet/snap-*.bin 2>/dev/null | wc -l | tr -d ' ')"
printf '{"stamp": "%s", "ok": %s, "secs": %d, "run_id": "%s", "slot_game_bell": %s, "ledger_bytes": %s, "snapshots": %s}\n' \
  "$stamp" "$ok" $((SECONDS - t0)) "$PT_RUN_ID" "$slot" "$wal_bytes" "$snaps" > "$dest/backup.json"
chmod -R go-rwx "$dest" 2>/dev/null || true

if [ -z "$to" ]; then
  if $ok; then mv "$dest" "$final"; else mv "$dest" "$PT_BACKUPS/$stamp.FAILED"; echo "backup $stamp FAILED (see $PT_BACKUPS/$stamp.FAILED/backup.log)" >&2; exit 1; fi
fi

# --- retention (only our own stamped directories)
now_s="$(date +%s)"
declare -a keep_day=()
for d in $(ls -1 "$PT_BACKUPS" 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}$' | sort); do
  mt="$(stat -f %m "$PT_BACKUPS/$d")"
  if [ $((now_s - mt)) -gt 86400 ]; then
    day="${d:0:8}"
    seen=0; for k in ${keep_day[@]+"${keep_day[@]}"}; do [ "$k" = "$day" ] && seen=1; done
    if [ $seen -eq 1 ]; then rm -rf "${PT_BACKUPS:?}/$d"; else keep_day+=("$day"); fi
  fi
done
total="$(ls -1 "$PT_BACKUPS" 2>/dev/null | grep -cE '^[0-9]{8}T[0-9]{6}$')"
if [ "$total" -gt 120 ]; then
  for d in $(ls -1 "$PT_BACKUPS" | grep -E '^[0-9]{8}T[0-9]{6}$' | sort | head -n $((total - 120))); do rm -rf "${PT_BACKUPS:?}/$d"; done
fi

# --- an off-disk copy of the newest backup, when asked
if [ -n "${PLAYTEST_BACKUP_COPY_TO:-}" ] && [ -z "$to" ]; then
  mkdir -p "$PLAYTEST_BACKUP_COPY_TO" && rsync -a "$final" "$PLAYTEST_BACKUP_COPY_TO/" || echo "off-disk copy to $PLAYTEST_BACKUP_COPY_TO failed" >&2
fi
echo "backup $stamp ok in $((SECONDS - t0)) s: $final"
