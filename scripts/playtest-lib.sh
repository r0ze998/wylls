#!/usr/bin/env bash
# Shared settings of the playtest scripts (PT-A). Sourced, never run.
#
# Everything is relative to the repository root (the worktree these scripts
# live in) unless an environment variable says otherwise:
#
#   PLAYTEST_CONFIG   the stack config      (default frontier-node/configs/playtest-1x.toml)
#   PLAYTEST_DATA     data root, outside git (default <repo>/../../data/playtest = .claude/data/playtest)
#   PLAYTEST_BIN      directory of the release binaries (default frontier-node/target/release)
#   PLAYTEST_RUN_ID   the run id (default: `run_id` of the config)
#   PLAYTEST_NODE     node (default: node on PATH)
#
# Layout of $PLAYTEST_DATA (mode 0700, never in git):
#   secrets/            gate.key and invite.secret (0600): the relay's join-gate key and invite secret
#   runs/<run-id>/      the stack's run directory: state.json, events.jsonl, logs/, localnet/ (ledger
#                       WAL + snapshots), keeper-a|b/ (journals), relay/, herald/, bots/, metrics/, keys/
#   backups/<stamp>/    periodic backups (hourly, see playtest-backup.sh)
#   logs/               the supervisor's, monitor's and cloudflared's logs
#   logs-archive/       rotated, gzipped component logs
#   status/             status.json (latest), history.jsonl, alarms.jsonl, gaps.jsonl
#   invites/            invite CSVs made by playtest-invite.sh (0600)
#   LAG-ALARM, HEALTH-ALARM   present while the condition holds (JSON)
#   STOP                the operator asked for a stop (playtest-down.sh); the supervisor does not restart
#   supervise.pid, stack.pid  the supervisor's and the stack's pids
# No script prints the contents of a secret.

PT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PT_CONFIG="${PLAYTEST_CONFIG:-$PT_ROOT/frontier-node/configs/playtest-1x.toml}"
case "$PT_CONFIG" in /*) ;; *) PT_CONFIG="$PT_ROOT/$PT_CONFIG" ;; esac

# The data root: .claude/data/playtest, two levels above .claude/worktrees/<wt>.
if [ -n "${PLAYTEST_DATA:-}" ]; then
  PT_DATA="$PLAYTEST_DATA"
else
  PT_DATA="$(cd "$PT_ROOT/../.." 2>/dev/null && pwd)/data/playtest"
fi
PT_BIN="${PLAYTEST_BIN:-$PT_ROOT/frontier-node/target/release}"
PT_NODE="${PLAYTEST_NODE:-$(command -v node || echo node)}"
PT_STACK="$PT_BIN/frontier-stack"

# `key = value` of the config's top level (strings unquoted).
pt_cfg() {
  awk -v k="$1" '
    /^\[/ { exit }
    $1 == k && $2 == "=" { v = $0; sub(/^[^=]*=[ \t]*/, "", v); sub(/[ \t]*#.*$/, "", v); gsub(/"/, "", v); print v; exit }
  ' "$PT_CONFIG"
}
# `key = value` inside `[section]`.
pt_cfg_in() {
  awk -v s="$1" -v k="$2" '
    /^\[/ { cur = $0; gsub(/[\[\] \t]/, "", cur); next }
    cur == s && $1 == k && $2 == "=" { v = $0; sub(/^[^=]*=[ \t]*/, "", v); sub(/[ \t]*#.*$/, "", v); gsub(/"/, "", v); print v; exit }
  ' "$PT_CONFIG"
}

PT_RUN_ID="${PLAYTEST_RUN_ID:-$(pt_cfg run_id)}"
PT_RUN_ID="${PT_RUN_ID:-playtest-1}"
PT_RUNS="$PT_DATA/runs"
PT_RUN="$PT_RUNS/$PT_RUN_ID"
PT_SECRETS="$PT_DATA/secrets"
PT_LOGS="$PT_DATA/logs"
PT_STATUS="$PT_DATA/status"
PT_BACKUPS="$PT_DATA/backups"
PT_BASE_PORT="$(pt_cfg base_port)"
PT_BASE_PORT="${PT_BASE_PORT:-41100}"
PT_HERALD_PORT=$((PT_BASE_PORT + $(pt_cfg_in ports herald)))
PT_RELAY_OP_PORT=$((PT_BASE_PORT + $(pt_cfg_in ports relay_operator)))

# When the playtest data root is not the config's own (tests, rehearsals),
# the config's relative `runs` and `secrets_dir` must follow it: the scripts
# hand the stack a derived copy of the config (pt_effective_config).
pt_effective_config() {
  local out="${1:-$PT_DATA/effective-config.toml}"
  mkdir -p "$(dirname "$out")"
  awk -v runs="$PT_RUNS" -v sec="$PT_SECRETS" '
    /^\[/ { cur = $0; gsub(/[\[\] \t]/, "", cur) }
    cur == "paths" && $1 == "runs" && $2 == "=" { print "runs = \"" runs "\""; next }
    cur == "playtest" && $1 == "secrets_dir" && $2 == "=" { print "secrets_dir = \"" sec "\""; next }
    { print }
  ' "$PT_CONFIG" > "$out.tmp" && mv "$out.tmp" "$out"
  echo "$out"
}

# The leading comment block of a script, as its --help.
pt_help() { awk 'NR>1 && !/^#/ {exit} NR>1 {sub(/^# ?/,""); print}' "$1"; }

pt_log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

# The pid in $1 (a pid file) when that process is alive and its command line
# contains $2; nothing otherwise.
pt_alive_pid() {
  local f="$1" want="$2" p
  [ -f "$f" ] || return 1
  p="$(tr -dc '0-9' < "$f")"
  [ -n "$p" ] || return 1
  ps -o command= -p "$p" 2>/dev/null | grep -q -- "$want" || return 1
  echo "$p"
}

# Free kilobytes on the data volume.
pt_free_kb() {
  local d="$PT_DATA"
  while [ ! -d "$d" ] && [ "$d" != / ]; do d="$(dirname "$d")"; done
  df -k "$d" 2>/dev/null | awk 'NR == 2 { print $4 }'
}

# The operator's bearer token of the run (never printed by these scripts).
pt_operator_token_file() { echo "$PT_RUN/relay/operator.token"; }
