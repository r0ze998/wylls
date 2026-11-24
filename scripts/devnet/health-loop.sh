#!/bin/zsh
# health-loop: run health.mjs every INTERVAL seconds until UNTIL (unix time), appending to LOG.
# Read-only like health.mjs (no process of the stack is touched). Start it detached:
#   nohup zsh scripts/devnet/health-loop.sh >/dev/null 2>&1 &
# Stop it: `touch $STOP` (it exits before its next run), or `kill $(cat $PIDFILE)`.
# Env (defaults in brackets): UNTIL [1795550400 = 2026-11-25 05:00 JST], INTERVAL [600],
#   FAST_FROM/FAST_TO/FAST_INTERVAL [02:12–03:30 JST 11-25 / 120 s: season 2's CreateSeason → joinable window],
#   STATE_DIR [~/Projects/wylls-grok-state], NODE [/opt/homebrew/opt/node@20/bin/node],
#   HEALTH_ARGS [empty]: extra health.mjs options, split on spaces (e.g. HEALTH_ARGS=--no-world-yet).
# World creation postponed (no world yet): `touch $S/logs/devnet-create-postponed` (or <run-dir>/world-postponed, or
# HEALTH_ARGS=--no-world-yet) — health.mjs then expects no driver / gateway / keeper A; no restart of this loop is needed
# for a marker. The FAST_* window then only means more frequent runs.
set -u
HERE=${0:A:h}
S=${STATE_DIR:-$HOME/Projects/wylls-grok-state}
LOG=$S/logs/devnet-health.log
PIDFILE=$S/logs/devnet-health-loop.pid
STOP=$S/logs/devnet-health.stop
STATE=$S/evidence/devnet-health/state.json
REPORT=$S/reports/devnet-health.md
NODE=${NODE:-/opt/homebrew/opt/node@20/bin/node}
UNTIL=${UNTIL:-1795550400}
INTERVAL=${INTERVAL:-600}
FAST_FROM=${FAST_FROM:-1795540320}
FAST_TO=${FAST_TO:-1795545000}
FAST_INTERVAL=${FAST_INTERVAL:-120}
mkdir -p ${STATE:h}
print -r -- $$ > $PIDFILE
rm -f $STOP
print -r -- "=== $(date '+%F %T %Z') health-loop pid $$ start; until $(date -r $UNTIL '+%F %T %Z'); stop: touch $STOP" >> $LOG
while (( $(date +%s) < UNTIL )); do
  [[ -e $STOP ]] && { print -r -- "=== $(date '+%F %T %Z') stop file seen; exiting" >> $LOG; break; }
  $NODE $HERE/health.mjs --state $STATE --report $REPORT ${=HEALTH_ARGS:-} >> $LOG 2>&1
  print -r -- "--- exit $?" >> $LOG
  now=$(date +%s)
  if (( now >= FAST_FROM && now < FAST_TO )); then step=$FAST_INTERVAL; else step=$INTERVAL; fi
  # sleep in 30 s slices so the stop file is honoured quickly
  end=$(( now + step ))
  while (( $(date +%s) < end )) && [[ ! -e $STOP ]]; do sleep 30; done
done
{
  print -r -- "=== $(date '+%F %T %Z') health-loop pid $$ end; timeline:"
  $NODE $HERE/health.mjs --timeline --state $STATE ${=HEALTH_ARGS:-}
} >> $LOG 2>&1
if [[ -f $REPORT ]]; then
  {
    print -r -- ""
    print -r -- "## Timeline at loop end ($(date '+%F %T %Z'), written by health-loop.sh)"
    print -r -- ""
    print -r -- '```'
    $NODE $HERE/health.mjs --timeline --state $STATE ${=HEALTH_ARGS:-}
    print -r -- '```'
  } >> $REPORT 2>&1
fi
rm -f $PIDFILE
