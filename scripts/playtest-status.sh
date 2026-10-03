#!/usr/bin/env bash
# The playtest's health report (PT-A): bell, the bell every province is
# resolved through and the lag, last anchored / clash-resolved bell, chain,
# herald fold lag, keepers' queues and payer pools, the relay pool, invites
# issued and joined, every process (pid, uptime, restarts), every port (and
# that only loopback listens), disk, backups, keep-awake, the tunnel, the
# alarm files.
#
#   scripts/playtest-status.sh [--json]
#
# Exit 0 healthy, 1 an alarm is active, 2 the stack is down. Probes live (a
# few seconds); the supervisor's own 30-second record is
# $PLAYTEST_DATA/status/status.json (history.jsonl, alarms.jsonl, gaps.jsonl).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=playtest-lib.sh
. "$HERE/playtest-lib.sh"
case "${1:-}" in -h|--help) pt_help "$0"; exit 0 ;; esac
export PT_DATA PT_RUN PT_RUN_ID
exec "$PT_NODE" "$HERE/playtest-watch.mjs" status "$@"
