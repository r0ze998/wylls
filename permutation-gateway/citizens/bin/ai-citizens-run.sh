#!/usr/bin/env bash
# One local run of the AI citizens (AI-CITIZENS contract v1.2 section 1.1, 7.1, 8.4; unit AC5). Local test chain only.
#
#   permutation-gateway/citizens/bin/ai-citizens-run.sh --stack permutation-gateway/citizens/stack/ai-citizens.toml \
#       --citizens-config permutation-gateway/citizens/config/main.json [--ab A|B --rep N] [--run-id ID] [--deck deck-k]
#       [--seat-script FILE] [--check | --dry-run]
#
#   --check     the guards only (run before every start as well): no paid-API key variable or key file, the old gateway
#               not running, no uncommitted change under the guarded paths, only ports in 41901-41999 (the stack's base is
#               41900; never 41000-41899 or a reserved port), none busy, a citizens config that names loopback URLs only,
#               and no held stack lock. Exit 1 with every reason when any fails.
#   --dry-run   the guards, then the plan (every command in start order), starting nothing.
#
# Start order (8.4): guards and lock -> llama check (/props alias, /health on 41901, then, once the commitments are built, the live
# server's /props and command line against them) -> RUNS.md entry (committed locally)
# -> registrar `commit` (background, before the stack: it polls getHealth, airdrops its key and sends the commit memo at
# once) -> `frontier-stack up` -> wait for phase running -> citizens service (mind, social, serve) under the Node
# permission model -> registrar `deal`, `run` -> the AI fleet (n AI citizens and the presenter seat) -> A/B seat script ->
# the scenario census. At the end: registrar `publish` (anchors index, the season-end trigger), the END line of RUNS.md,
# every child stopped in reverse order, the lock released. Every child starts without the paid-API variables.
#
# Files: AI_DIR = .local/frontier/ai/<run id>/ with pub/ (served as /h/ai/*), state/ (private to the citizens service),
# keys/ (registrar key, the seat key and the per-bell anchor claims; the service never reads it), logs/.
# The lock (contract v1.3 R9) is ONE file shared by every worktree of the repository: <git common dir>/wylls-ai-stack.lock
# ({pid, unit, run_id, started}), so two worktrees cannot start two stacks on the 41900 block; a stale lock (its pid is gone) is
# taken over race-free (citizens/lock.mjs). AI_STACK_LOCK overrides the path (tests).
#
# A non-smoke run (a citizens config not named smoke.json) MUST set AI_MODEL (the gguf file) and AI_LLAMA_DIR (the llama.cpp
# tree): the guards refuse without them, the commitments carry the measured sha256 and tree sha256, and bin/llama-check.mjs compares
# the live llama-server (/props and its command line) with the commitments before anything starts. A smoke run may leave both
# unset; its commitments then say "unmeasured".
#
# Environment: AI_REPO (repository root), AI_UNIT (name in the lock), AI_STACK_LOCK, FRONTIER_BIN
# (directory of frontier-stack, frontier-bots, ...; default frontier-node/target/release), AI_NODE (node binary),
# AI_STACK_RUNS (the stack's runs directory; default frontier-node/.local/frontier), AI_MODEL (the gguf), AI_LLAMA_DIR (the
# llama.cpp tree), AI_LLAMA_ARGV_JSON (tests only: a recorded {ps_args, binary_realpath} for the llama check), AI_WAIT_LAST_SECS (the
# bounded wait of `registrar publish` for the last closed bell's talk and minds files, default 60; FB1).
set -u
set -o pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=${AI_REPO:-$(cd "$HERE/../../.." && pwd)}
NODE=${AI_NODE:-node}
GUARDS="$HERE/run-guards.mjs"
REGISTRAR="$REPO/permutation-gateway/citizens/registrar.mjs"
RUNS_REL=docs/frontier/ai-citizens/RUNS.md
RUNS_MD="$REPO/$RUNS_REL"
LOCK=${AI_STACK_LOCK:-$("$NODE" "$GUARDS" lock-path --repo "$REPO")}
STACK_RUNS=${AI_STACK_RUNS:-$REPO/frontier-node/.local/frontier}
FBIN=${FRONTIER_BIN:-$REPO/frontier-node/target/release}
UNIT=${AI_UNIT:-ai-run}
# The paid-API variables every child is started without (the same names run-guards.mjs refuses).
UNSET_VARS="ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_API_KEY OPENAI_API_KEY AZURE_OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY MISTRAL_API_KEY COHERE_API_KEY XAI_API_KEY GROQ_API_KEY OPENROUTER_API_KEY DEEPSEEK_API_KEY TOGETHER_API_KEY PERPLEXITY_API_KEY FIREWORKS_API_KEY"

STACK=
CCONFIG=
AB=
REP=
RUN_ID=
DECK=
SEAT_SCRIPT=
CHECK=0
DRY=0
NO_BUSY=0
WAIT_STACK=${AI_WAIT_STACK_SECS:-1200}
WAIT_SERVICE=${AI_WAIT_SERVICE_SECS:-120}

die() { echo "ai-citizens-run: $*" >&2; exit 2; }
usage() { sed -n '2,/^set -u/p' "$0" | sed '$d'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --stack) STACK=${2:?}; shift 2 ;;
    --citizens-config) CCONFIG=${2:?}; shift 2 ;;
    --ab) AB=${2:?}; shift 2 ;;
    --rep) REP=${2:?}; shift 2 ;;
    --run-id) RUN_ID=${2:?}; shift 2 ;;
    --deck) DECK=${2:?}; shift 2 ;;
    --seat-script) SEAT_SCRIPT=${2:?}; shift 2 ;;
    --check) CHECK=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --no-busy-check) NO_BUSY=1; shift ;;   # tests only: the guard unit tests bind no stack
    -h|--help) usage; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done
[ -n "$STACK" ] || die "--stack is required"
[ -n "$CCONFIG" ] || die "--citizens-config is required"
[ -f "$STACK" ] || die "no such stack config: $STACK"
[ -f "$CCONFIG" ] || die "no such citizens config: $CCONFIG"
case "$STACK" in /*) ;; *) STACK=$(cd "$(dirname "$STACK")" && pwd)/$(basename "$STACK") ;; esac
case "$CCONFIG" in /*) ;; *) CCONFIG=$(cd "$(dirname "$CCONFIG")" && pwd)/$(basename "$CCONFIG") ;; esac
if [ -n "$AB" ] && [ -z "$REP" ]; then die "--ab needs --rep"; fi
if [ -n "$REP" ] && [ -z "$AB" ]; then die "--rep needs --ab"; fi

# ------------------------------------------------------------------ guards
GUARD_ARGS=(check --repo "$REPO" --stack "$STACK" --citizens-config "$CCONFIG" --lock-file "$LOCK")
[ -z "$AB" ] || GUARD_ARGS+=(--ab "$AB" --rep "$REP")
[ "$NO_BUSY" = 0 ] || GUARD_ARGS+=(--no-busy-check)
"$NODE" "$GUARDS" "${GUARD_ARGS[@]}" || exit 1
[ "$CHECK" = 0 ] || exit 0

# ------------------------------------------------------------------ derived values
tomlval() { # tomlval KEY: a top-level `key = value` of the stack config
  sed -n "s/^$1[[:space:]]*=[[:space:]]*\"\{0,1\}\([^\"#]*[^\"# ]\)\"\{0,1\}[[:space:]]*\(#.*\)\{0,1\}$/\1/p" "$STACK" | head -1
}
cfgval() { # cfgval JSON-PATH DEFAULT: a value of the citizens config
  "$NODE" -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); let v = c; for (const k of process.argv[2].split(".")) v = v?.[k]; process.stdout.write(String(v ?? process.argv[3]));' "$CCONFIG" "$1" "$2"
}
BASE=$(tomlval base_port)
BOT_SEED=$(tomlval bot_seed)
SEASON_ID=$(tomlval season_id)
SCALE=$(tomlval scale)
STACK_RUN_ID=$(tomlval run_id)
DAYS=$(tomlval days)
[ -n "$DAYS" ] || DAYS=1
DAYS=${DAYS%%.*}
STACK_NAME=$(basename "$STACK" .toml)
if [ -z "$DECK" ]; then
  case "$STACK_NAME" in
    ai-citizens) DECK=deck-3 ;;
    ai-ab) DECK=deck-2 ;;
    ai-smoke) DECK=deck-1 ;;
    *) die "no default deck for $STACK_NAME: pass --deck deck-1|deck-2|deck-3" ;;
  esac
fi
case "$DECK" in deck-1) N=6 ;; deck-2) N=12 ;; deck-3) N=18 ;; *) die "deck $DECK: deck-1 (6 AI), deck-2 (12) or deck-3 (18)" ;; esac
if [ -n "$AB" ]; then
  BOT_SEED=$((32 + REP)); SEASON_ID=$BOT_SEED
  [ -n "$RUN_ID" ] || RUN_ID="ai-ab-$AB-$REP"
fi
[ -n "$RUN_ID" ] || RUN_ID=$STACK_RUN_ID
case "$RUN_ID" in *[!A-Za-z0-9_-]*|'') die "run id $RUN_ID: letters, digits, - and _ only" ;; esac
P_RPC=$((BASE + 10)); P_HERALD=$((BASE + 40)); P_RELAY=$((BASE + 33)); P_BOTS=$((BASE + 70))
RPC="http://127.0.0.1:$P_RPC"; HERALD="http://127.0.0.1:$P_HERALD"; RELAY="http://127.0.0.1:$P_RELAY"
LLM=$(cfgval llm.url http://127.0.0.1:41901)
LLM_ALIAS=$(cfgval llm.alias gemma-4-26b-a4b-it)
MIND_PORT=$(cfgval ports.mind 41980); SOCIAL_PORT=$(cfgval ports.social 41981); SERVE_PORT=$(cfgval serve.port 41902)
SERVE="http://127.0.0.1:$SERVE_PORT"
AI_ROOT="$REPO/.local/frontier/ai"
AI_DIR="$AI_ROOT/$RUN_ID"
PUB="$AI_DIR/pub"; STATE="$AI_DIR/state"; KEYS="$AI_DIR/keys"; LOGS="$AI_DIR/logs"
CTOML="$AI_DIR/stack.toml"
CPUB=permutation-gateway/citizens

UNSET=()
for v in $UNSET_VARS; do UNSET+=(-u "$v"); done

# What the citizens service may read (1.3 C1): the flag list is pinned by the service itself (`server.mjs
# --print-permission-flags`, AC1a: one --allow-fs-read flag per path, because Node 20.19.4 refuses a comma list with more
# than one entry; real paths on macOS), plus the config file. AI_PERM_EXTRA adds one more path.
PERM_FLAGS=()
perm_flags() {
  PERM_FLAGS=()
  local l
  if [ ! -f "$REPO/$CPUB/server.mjs" ]; then # a plan in a tree without the service: the directories alone
    PERM_FLAGS=(--experimental-permission "--allow-fs-read=$AI_DIR/state" "--allow-fs-read=$AI_DIR/pub" "--allow-fs-write=$AI_DIR/state" "--allow-fs-write=$AI_DIR/pub")
    PERM_FLAGS+=("--allow-fs-read=$CCONFIG")
    return 0
  fi
  while IFS= read -r l; do [ -z "$l" ] || PERM_FLAGS+=("$l"); done < <("$NODE" "$REPO/$CPUB/server.mjs" --print-permission-flags --ai-dir "$AI_DIR")
  PERM_FLAGS+=("--allow-fs-read=$CCONFIG")
  [ -z "${AI_PERM_EXTRA:-}" ] || PERM_FLAGS+=("--allow-fs-read=$AI_PERM_EXTRA")
}

# ------------------------------------------------------------------ process handling
PIDS=()
STATUS=aborted
DETAIL="stopped before the end"
bg() { # bg NAME CMD...: a background child without the paid-API variables, its output in logs/NAME.log
  local name=$1; shift
  if [ "$DRY" = 1 ]; then echo "PLAN start $name: $*"; return 0; fi
  env "${UNSET[@]}" "$@" >"$LOGS/$name.log" 2>&1 &
  PIDS+=("$name:$!")
  echo "$name $!" >>"$AI_DIR/pids"
  echo "started $name (pid $!)"
}
fg() { # fg NAME CMD...: a foreground step
  local name=$1; shift
  if [ "$DRY" = 1 ]; then echo "PLAN run $name: $*"; return 0; fi
  env "${UNSET[@]}" "$@"
}
stop_all() {
  local i entry name pid
  for ((i = ${#PIDS[@]} - 1; i >= 0; i--)); do
    entry=${PIDS[$i]}; name=${entry%%:*}; pid=${entry##*:}
    kill -0 "$pid" 2>/dev/null || continue
    echo "stopping $name (pid $pid)"
    kill "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null || true
  done
  PIDS=()
}
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$DRY" = 0 ] && [ -d "$AI_DIR" ]; then
    stop_all
    if [ -f "$STACK_RUNS/$RUN_ID/state.json" ]; then
      env "${UNSET[@]}" FRONTIER_BIN="$FBIN" PSF_REPO="$REPO" "$FBIN/frontier-stack" down --run-id "$RUN_ID" >>"$LOGS/stack-down.log" 2>&1 || true
    fi
    if [ -f "$RUNS_MD" ] && [ "${RUNS_ADDED:-0}" = 1 ]; then
      "$NODE" "$REGISTRAR" runs-end --run-id "$RUN_ID" --status "$STATUS" --detail "$DETAIL" --file "$RUNS_MD" >/dev/null 2>&1 || true
    fi
    "$NODE" "$GUARDS" lock-release --lock-file "$LOCK" --run-id "$RUN_ID" || true
    echo "run $RUN_ID: $STATUS ($DETAIL); AI_DIR $AI_DIR"
  fi
  exit "$rc"
}
fail() { DETAIL=$1; echo "ai-citizens-run: $1" >&2; exit 1; }

wait_http() { # wait_http URL SECONDS
  local url=$1 secs=$2 t=0
  while [ "$t" -lt "$secs" ]; do
    curl -sf -m 3 "$url" >/dev/null 2>&1 && return 0
    sleep 2; t=$((t + 2))
  done
  return 1
}
stack_phase() { sed -n 's/.*"phase": *"\([a-z]*\)".*/\1/p' "$STACK_RUNS/$RUN_ID/state.json" 2>/dev/null | head -1; }
child_alive() { local want=$1 e; for e in ${PIDS[@]+"${PIDS[@]}"}; do [ "${e%%:*}" = "$want" ] && kill -0 "${e##*:}" 2>/dev/null && return 0; done; return 1; }

# ------------------------------------------------------------------ the plan (dry run) or the run
echo "run $RUN_ID: stack $STACK_NAME base $BASE (herald $P_HERALD, rpc $P_RPC), $N AI citizens + the presenter seat ($DECK), bot seed $BOT_SEED, season $SEASON_ID${AB:+, arm $AB rep $REP}"
if [ "$DRY" = 0 ]; then
  [ ! -e "$AI_DIR" ] || die "$AI_DIR exists: a run id is used once (pass --run-id, for example $RUN_ID-2)"
  [ -x "$FBIN/frontier-stack" ] && [ -x "$FBIN/frontier-bots" ] || die "frontier-stack and frontier-bots are not in $FBIN (build: cd frontier-node && cargo build --release --workspace; or set FRONTIER_BIN)"
  [ -f "$REPO/$CPUB/server.mjs" ] || die "$CPUB/server.mjs is missing (unit AC1a is not merged here): there is no citizens service to start"
  mkdir -p "$AI_ROOT" "$AI_DIR" "$PUB" "$STATE" "$LOGS"
  mkdir -m 700 -p "$KEYS"
  "$NODE" "$GUARDS" lock-take --lock-file "$LOCK" --unit "$UNIT" --run-id "$RUN_ID" --pid $$ || { rmdir "$KEYS" "$LOGS" "$STATE" "$PUB" "$AI_DIR" 2>/dev/null; exit 1; }
  trap cleanup EXIT INT TERM
else
  echo "PLAN lock $LOCK (unit $UNIT, run $RUN_ID, pid of this script)"
  echo "PLAN dirs $AI_DIR/{pub,state,keys,logs} (keys mode 700)"
fi

# The rep's copy of the stack config (A/B) or the run's copy: what the commitments hash.
if [ "$DRY" = 0 ]; then
  sed -e "s/^run_id[[:space:]]*=.*/run_id = \"$RUN_ID\"/" -e "s/^bot_seed[[:space:]]*=.*/bot_seed = $BOT_SEED/" -e "s/^season_id[[:space:]]*=.*/season_id = $SEASON_ID/" "$STACK" >"$CTOML"
else
  echo "PLAN write $CTOML (run_id $RUN_ID, bot_seed $BOT_SEED, season_id $SEASON_ID)"
fi

# llama: alias and health (the model server is started by AC1a's start-pinned.sh, never here)
if [ "$DRY" = 0 ]; then
  curl -sf -m 5 "$LLM/health" >/dev/null || fail "llama-server is not healthy on $LLM (start citizens/llama/start-pinned.sh first)"
  # The alias is read from /props (model_alias) or, failing that, /v1/models (id): either must name the pinned alias.
  seen=$({ curl -sf -m 5 "$LLM/props"; echo; curl -sf -m 5 "$LLM/v1/models"; } 2>/dev/null)
  case "$seen" in *"\"$LLM_ALIAS\""*) ;; *) fail "llama-server on $LLM does not report the alias $LLM_ALIAS (/props, /v1/models)" ;; esac
else
  echo "PLAN check $LLM/health and $LLM/props alias $LLM_ALIAS"
fi

# slots, commitments (built before the RUNS.md entry, which carries their sha256), RUNS.md, the commit memo
fg slots "$NODE" "$REGISTRAR" slots --stack "$CTOML" --n "$N" --out "$AI_DIR/ai-slots.json" || fail "the slots file could not be written"
COMMIT_ARGS=(commit --ai-dir "$AI_DIR" --key "$KEYS/registrar.json" --stack "$CTOML" --citizens-config "$CCONFIG" --slots "$AI_DIR/ai-slots.json" --deck "$DECK" --run-id "$RUN_ID")
[ -z "$SEAT_SCRIPT" ] || COMMIT_ARGS+=(--seat-script "$SEAT_SCRIPT")
[ -z "${AI_MODEL:-}" ] || COMMIT_ARGS+=(--model "$AI_MODEL")
[ -z "${AI_LLAMA_DIR:-}" ] || COMMIT_ARGS+=(--llama-dir "$AI_LLAMA_DIR")
fg commit-prepare "$NODE" "$REGISTRAR" "${COMMIT_ARGS[@]}" --prepare-only || fail "the commitments could not be built"
# R9: the live llama-server (/props and its command line) against the commitments just built, before anything is started
LC_ARGS=(--llm "$LLM" --commitments "$PUB/commitments.json")
[ -z "${AI_MODEL:-}" ] || LC_ARGS+=(--ai-model "$AI_MODEL")
[ -z "${AI_LLAMA_DIR:-}" ] || LC_ARGS+=(--ai-llama-dir "$AI_LLAMA_DIR")
[ -z "${AI_LLAMA_ARGV_JSON:-}" ] || LC_ARGS+=(--argv-json "$AI_LLAMA_ARGV_JSON")
[ "$(basename "$CCONFIG")" != smoke.json ] || LC_ARGS+=(--smoke)
fg llama-check "$NODE" "$HERE/llama-check.mjs" "${LC_ARGS[@]}" || fail "the live llama-server does not match the commitments (see above)"
RUNS_ARGS=(runs-add --run-id "$RUN_ID" --commitments "$PUB/commitments.json" --file "$RUNS_MD")
[ -z "$AB" ] || RUNS_ARGS+=(--arm "$AB" --rep "$REP")
fg runs-add "$NODE" "$REGISTRAR" "${RUNS_ARGS[@]}" || fail "the RUNS.md entry could not be written"
if [ "$DRY" = 0 ]; then
  RUNS_ADDED=1
  git -C "$REPO" add "$RUNS_REL" && git -C "$REPO" commit -q -m "Wylls AI run: $RUN_ID" -- "$RUNS_REL" || fail "the RUNS.md entry could not be committed"
else
  echo "PLAN commit RUNS.md: git commit -m \"Wylls AI run: $RUN_ID\""
fi
bg registrar-commit "$NODE" "$REGISTRAR" commit --ai-dir "$AI_DIR" --key "$KEYS/registrar.json" --stack "$CTOML" --citizens-config "$CCONFIG" --slots "$AI_DIR/ai-slots.json" --deck "$DECK" --reuse --wait-rpc "$RPC" --herald "$HERALD"

# the stack (localnet, drand test key, relay, herald, keepers, the script bots following the council)
bg stack env FRONTIER_BIN="$FBIN" PSF_REPO="$REPO" "$FBIN/frontier-stack" up --config "$CTOML"
if [ "$DRY" = 0 ]; then
  t=0
  while [ "$(stack_phase)" != running ]; do
    child_alive stack || fail "frontier-stack exited before it was running (see $LOGS/stack.log)"
    [ "$t" -lt "$WAIT_STACK" ] || fail "the stack was not running after $WAIT_STACK s"
    sleep 2; t=$((t + 2))
  done
  wait_http "$HERALD/h/season" 120 || fail "the herald does not answer /h/season"
else
  echo "PLAN wait until $STACK_RUNS/$RUN_ID/state.json has phase running, then $HERALD/h/season"
fi

# the citizens service (mind, social, serve) under the Node permission model; it holds no key
perm_flags
bg citizens "$NODE" "${PERM_FLAGS[@]}" "$REPO/$CPUB/server.mjs" \
  --herald "$HERALD" --llm "$LLM" --mind-port "$MIND_PORT" --social-port "$SOCIAL_PORT" --serve-port "$SERVE_PORT" --ai-dir "$AI_DIR" --config "$CCONFIG" --run-id "$RUN_ID" --season "$SEASON_ID"
if [ "$DRY" = 0 ]; then
  wait_http "$SERVE/serve-health" "$WAIT_SERVICE" || fail "the citizens service did not come up (see $LOGS/citizens.log)"
else
  echo "PLAN wait for $SERVE/serve-health and $STATE/mind.token"
fi

# the deal (public randomness of the test-key drand: not "dealt by public randomness"), the roster, the per-bell anchors
fg registrar-deal "$NODE" "$REGISTRAR" deal --ai-dir "$AI_DIR" --key "$KEYS/registrar.json" --herald "$HERALD" --stack "$CTOML" || fail "the deal failed (see above)"
bg registrar-run "$NODE" "$REGISTRAR" run --ai-dir "$AI_DIR" --key "$KEYS/registrar.json" --rpc "$RPC" --stack "$CTOML"

# the AI fleet: n AI citizens and the presenter seat (index 1000+n, no brain); the play window is what is left of the stack's
if [ "$DRY" = 0 ]; then
  now=$(curl -sf -m 5 "$HERALD/h/season" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).latestUnix)))')
  play_end=$(sed -n 's/.*"play_end": *\([0-9]*\).*/\1/p' "$STACK_RUNS/$RUN_ID/state.json" | head -1)
  HOURS=$("$NODE" -e 'const [n, e] = process.argv.slice(1).map(Number); process.stdout.write((Math.max(600, e - n) / 3600).toFixed(4))' "$now" "${play_end:-0}")
  [ -f "$STATE/mind.token" ] || fail "the mind token $STATE/mind.token does not exist"
else
  HOURS=HOURS_LEFT
fi
bg fleet "$FBIN/frontier-bots" --herald "$HERALD" --relay "$RELAY" --rpc "$RPC" --seed "$BOT_SEED" --first-index 1000 --bots $((N + 1)) --days "$DAYS" --game-hours "$HOURS" --scale "$SCALE" \
  --personas off --journal "$AI_DIR/fleet" --report "$AI_DIR/fleet/report.json" --control "127.0.0.1:$((BASE + 71))" \
  --ai-slots "$AI_DIR/ai-slots.json" --brain "http://127.0.0.1:$MIND_PORT" --brain-token-file "$STATE/mind.token" --follow-council --export-seat-key "$KEYS/seat.txt"

# The seat script casts the seat's ballot. A/B: the only difference between the arms (--arm). Any other run that names a seat script
# (--seat-script, which also marks the seat "scripted" in the roster and the page): the council script, a scripted ballot (origin 2) in
# every council period of nation 0 with options, no AI motion needed; it polls until this script stops it (SIGTERM) and says in its log
# and in pub/seat/ballots.json that the ballot is scripted. A roster that says "scripted" without a script casting ballots was the
# smoke-b4/b5 inconsistency (integ-B-NOTES.md, "seat ballot fix").
if [ -n "$AB" ] || [ -n "$SEAT_SCRIPT" ]; then
  SEAT_ARGS=(--ai-dir "$AI_DIR" --herald "$HERALD" --social "http://127.0.0.1:$SOCIAL_PORT" --key-file "$KEYS/seat.txt" --config "$CCONFIG" --stop-file "$STATE/seat.stop")
  rm -f "$STATE/seat.stop" # a leftover stop file from an earlier run in a reused AI_DIR would end the seat at its first poll
  [ -z "$AB" ] || SEAT_ARGS=(--arm "$AB" --rep "$REP" "${SEAT_ARGS[@]}")
  if [ -f "$REPO/$CPUB/ab/seat.mjs" ]; then
    bg seat "$NODE" "$REPO/$CPUB/ab/seat.mjs" "${SEAT_ARGS[@]}"
  elif [ "$DRY" = 1 ]; then echo "PLAN note: $CPUB/ab/seat.mjs (unit AC9) is not in this tree; a run with a seat script would refuse here"
  else fail "$CPUB/ab/seat.mjs is missing (unit AC9 is not merged here): a run with a seat script needs it"
  fi
fi

# the scenario census (reads the herald only; writes AI_DIR/census)
bg census "$NODE" "$REPO/$CPUB/scenario/census.mjs" --herald "$HERALD" --ai-dir "$AI_DIR"

if [ "$DRY" = 1 ]; then
  echo "PLAN wait for the fleet to exit, then for the stack phase complete; then registrar publish (waits up to AI_WAIT_LAST_SECS for the last closed bell's talk and minds files, one more anchor pass, anchor_gap for any closed bell without an anchor, then the index), the END line of RUNS.md, stop every child in reverse order, release the lock"
  echo "dry run: nothing was started or written"
  exit 0
fi

# ------------------------------------------------------------------ wait for the end
echo "running; follow with: tail -f $LOGS/*.log  (page: $SERVE/council.html)"
while child_alive fleet; do
  child_alive stack || fail "the stack stopped while the fleet was running"
  child_alive citizens || fail "the citizens service stopped while the fleet was running"
  sleep 5
done
echo "the fleet has exited; waiting for the stack to finish its drain"
t=0
while [ "$(stack_phase)" != complete ]; do
  child_alive stack || { [ "$(stack_phase)" = complete ] && break; fail "the stack stopped before it was complete (phase $(stack_phase))"; }
  [ "$t" -lt 7200 ] || fail "the stack was not complete 2 h after the fleet exited"
  sleep 5; t=$((t + 5))
done
# FB1 (A2): the closer may be inside the tick that closes the last bell: publish waits (bounded, AI_WAIT_LAST_SECS, default 60) until every
# closed bell has its talk AND its minds file, runs one more anchor pass (it sends nothing to a paused chain: the stack pauses the chain
# when the season is complete, and a memo sent to it is never confirmed), gives every closed bell without an anchor a named anchor_gap,
# and only then writes the index. Its last line counts the closed bells against the anchored ones; that line goes into the END detail.
PUB_OUT=$("$NODE" "$REGISTRAR" publish --ai-dir "$AI_DIR" --key "$KEYS/registrar.json" --herald "$HERALD" --rpc "$RPC" --stack "$CTOML" --wait-last-secs "${AI_WAIT_LAST_SECS:-60}") || { printf '%s\n' "$PUB_OUT"; fail "the registrar's season-end publication failed"; }
printf '%s\n' "$PUB_OUT"
ANCHOR_NOTE=$(printf '%s\n' "$PUB_OUT" | sed -n 's/^anchors: \(.*\); season-end trigger written$/\1/p' | tail -1)
# integ-B: the service's audit watcher writes the season-end bundle (PUB/full) once STATE/season-end.json exists; wait for it (bounded),
# then run verify-minds (M1..M11, with M9 re-sent to the live llama-server) and the run report while the stack is still up. Neither
# result decides the run's status: their verdict and files are the evidence (PUB/verify-minds.json, AI_DIR/report.{json,md}).
t=0
while [ ! -f "$PUB/full/index.json" ] && [ "$t" -lt "${AI_WAIT_FULL_SECS:-120}" ]; do sleep 2; t=$((t + 2)); done
FULL_NOTE="season-end bundle written"
[ -f "$PUB/full/index.json" ] || FULL_NOTE="season-end bundle NOT written within ${AI_WAIT_FULL_SECS:-120} s"
echo "$FULL_NOTE"
VM_ARGS=(--herald "$HERALD" --rpc "$RPC" --ai-dir "$AI_DIR" --repo "$REPO" --stack "$CTOML" --citizens-config "$CCONFIG")
[ -z "${AI_MODEL:-}" ] || VM_ARGS+=(--model "$AI_MODEL")
[ -z "${AI_LLAMA_DIR:-}" ] || VM_ARGS+=(--llama-dir "$AI_LLAMA_DIR")
[ "${AI_VERIFY_LLM:-1}" = 0 ] || VM_ARGS+=(--llm "$LLM")
"$NODE" "$REPO/$CPUB/verify-minds.mjs" "${VM_ARGS[@]}" >"$LOGS/verify-minds.log" 2>&1
VM_RC=$?
case "$VM_RC" in 0) VM_VERDICT=PASS ;; 1) VM_VERDICT=FAIL ;; 3) VM_VERDICT=INCOMPLETE ;; *) VM_VERDICT="ERROR($VM_RC)" ;; esac
echo "verify-minds: $VM_VERDICT (see $LOGS/verify-minds.log)"
"$NODE" "$REPO/$CPUB/report.mjs" --ai-dir "$AI_DIR" --runs "$RUNS_MD" --out "$AI_DIR/report.json" --md "$AI_DIR/report.md" >"$LOGS/report.log" 2>&1 || echo "report.mjs failed (see $LOGS/report.log)"
STATUS=complete
DETAIL="stack complete, publication written (anchors: ${ANCHOR_NOTE:-not counted}); $FULL_NOTE; verify-minds $VM_VERDICT"
if [ -f "$PUB/anchors/commit.json" ] && grep -q '"status":"unaudited"' "$PUB/anchors/commit.json"; then DETAIL="stack complete, publication written; the commit memo came after genesis: unaudited"; fi
exit 0
