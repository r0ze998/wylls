#!/bin/sh
# Pinned llama-server for the AI citizens (contract v1.2 section 7.1 commitments "server.flags").
# Ported from LAB/start_server_41900.sh and LAB/start_server_41900_try.sh; the model path and
# alias are unchanged. Differences from the lab script: port 41901 (never 41900), one slot (-np 1,
# the only setting the spike showed bit-stable), thinking off (--reasoning off), context 16384.
# Usage: start-pinned.sh [logfile]   (exec; run in the background and stop it when done).
# Loopback only. No -v / --log-verbose (section 6.8 item 3).
LOG=${1:-}
MODEL=${AI_MODEL:-/Users/r0ze/Documents/Codex/2026-09-20/new-chat-2/outputs/.claude/data/models/gemma-4-26B-A4B-it-Q4_0.gguf}
BIN=${LLAMA_SERVER:-/opt/homebrew/bin/llama-server}
set -- -m "$MODEL" --alias gemma-4-26b-a4b-it --host 127.0.0.1 --port 41901 \
  --jinja --reasoning off -np 1 -c 16384 -ngl 999 -fa on --no-webui --metrics
if [ -n "$LOG" ]; then exec "$BIN" "$@" > "$LOG" 2>&1; fi
exec "$BIN" "$@"
