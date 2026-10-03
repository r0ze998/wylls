#!/usr/bin/env bash
# Starts the playtest stack and its babysitter (PT-A), locally, on 127.0.0.1.
#
#   scripts/playtest-up.sh [--dry-run] [--fresh] [--no-wait] [--allow-stale]
#
# * Checks everything that can be checked first (binaries, the pinned release
#   .so, the drand archive, node and the relay's modules, the web client, ports
#   41100-41139, disk, power) and refuses to start when one fails.
# * Starts scripts/playtest-supervise.sh detached (own session) and under
#   caffeinate (idle, disk and, on AC power, system sleep are prevented for as
#   long as the babysitter lives). The babysitter runs `frontier-stack up` the
#   first time and `frontier-stack resume` every time after that, restarts it
#   when it dies, and runs the monitor and the hourly backup.
# * Waits for the herald, then prints the herald URL, the ONE cloudflared
#   command (it does NOT start a tunnel: that is your explicit go), and the
#   other scripts.
#
# With an existing run in the data directory it CONTINUES it (resume): the
# season, the chain, the invites already used. `--fresh` archives the run
# and the secrets (so old invites die with the old gate key) into
# $PLAYTEST_DATA/old/<stamp>/ and starts a new season: only when nothing of
# the old run is alive.
#
# A binary older than the Rust source it is built from is refused (rebuild:
# cd frontier-node && nice cargo build --offline --locked --release --workspace);
# --allow-stale (or PLAYTEST_ALLOW_STALE=1, for the selftest) overrides that.
#
# Nothing here starts a tunnel, installs, downloads or contacts a network.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=playtest-lib.sh
. "$HERE/playtest-lib.sh"

DRY=0; FRESH=0; WAIT=1; STALE_OK=${PLAYTEST_ALLOW_STALE:-0}
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-stale) STALE_OK=1 ;;
    --dry-run) DRY=1 ;;
    --fresh) FRESH=1 ;;
    --no-wait) WAIT=0 ;;
    -h|--help) pt_help "$0"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

problems=()
bad() { problems+=("$*"); }
sha() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }

# --- preflight
for b in frontier-stack frontier-localnet drand-replay frontier-keeper frontier-herald frontier-bots frontier-viewers; do
  [ -x "$PT_BIN/$b" ] || bad "missing $PT_BIN/$b (cd frontier-node && nice cargo build --offline --locked --release --workspace)"
done
# --- binaries newer than their sources
stale() { # stale <binary> <dir>...: a .rs under src/ (or a Cargo.toml) newer than the binary
  local bin="$PT_BIN/$1"; shift
  [ -x "$bin" ] || return 0
  local d hit
  for d in "$@"; do
    hit="$(find "$PT_ROOT/$d" \( -path '*/src/*' -name '*.rs' -o -name Cargo.toml \) -newer "$bin" -not -path '*/target/*' 2>/dev/null | head -1)"
    [ -n "$hit" ] && { echo "${hit#"$PT_ROOT"/}"; return 0; }
  done
  return 0
}
if [ $STALE_OK -eq 0 ]; then
  common="frontier-node/crates/fclient frontier-node/crates/findex frontier-abi permutation-rules"
  for pair in "frontier-stack:frontier-node/crates/stack frontier-node/crates/verify" \
              "frontier-herald:frontier-node/crates/herald" "frontier-viewers:frontier-node/crates/herald" \
              "frontier-keeper:frontier-node/crates/keeper" "frontier-localnet:frontier-node/crates/localnet" \
              "frontier-bots:frontier-node/crates/bots frontier-node/crates/agents" "drand-replay:frontier-node/crates/drand-replay"; do
    b="${pair%%:*}"; dirs="${pair#*:}"
    # shellcheck disable=SC2086
    hit="$(stale "$b" $dirs $common)"
    [ -z "$hit" ] || bad "$b is older than $hit: rebuild (cd frontier-node && nice cargo build --offline --locked --release --workspace), or --allow-stale"
  done
fi
SO_REL="$(pt_cfg_in paths so)"; SO_REL="${SO_REL:-permutation-frontier/target/deploy/permutation_frontier.so}"
SO="$PT_ROOT/$SO_REL"
WANT_SO="$(pt_cfg_in paths so_sha256)"
if [ ! -f "$SO" ]; then bad "missing the release .so $SO (scripts/build-frontier.sh)"
elif [ -n "$WANT_SO" ] && [ "$(sha "$SO")" != "$WANT_SO" ]; then bad "the .so's sha256 is $(sha "$SO"), the config pins $WANT_SO"; fi
ARCH="$PT_ROOT/$(pt_cfg_in paths archive)"
[ -f "$ARCH/manifest.json" ] || bad "no drand archive manifest at $ARCH"
"$PT_NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null || bad "node >= 20 is needed ($PT_NODE)"
[ -d "$PT_ROOT/permutation-gateway/node_modules/@solana/web3.js" ] || bad "permutation-gateway/node_modules is missing (symlink an existing one; no installs here)"
[ -f "$PT_ROOT/permutation-server/web/frontier/index.html" ] || bad "the web client is missing under permutation-server/web/frontier/"
command -v caffeinate >/dev/null || bad "caffeinate is missing"
command -v sqlite3 >/dev/null || bad "sqlite3 is missing (backups)"
free_gb=$(( $(pt_free_kb) / 1048576 ))
[ "$free_gb" -ge 40 ] || bad "only $free_gb GB free on the data volume (need 40)"
power="$(pmset -g batt 2>/dev/null | head -1)"
case "$power" in *"AC Power"*) ;; *) echo "WARNING: not on AC power ($power): caffeinate -s cannot hold the system awake on battery; plug in" ;; esac

# --- existing run, babysitter
if bpid="$(pt_alive_pid "$PT_DATA/supervise.pid" playtest-supervise)"; then
  if [ $FRESH -eq 1 ]; then echo "--fresh: the babysitter is running (pid $bpid): scripts/playtest-down.sh first" >&2; exit 1; fi
  echo "the babysitter is already running (pid $bpid): nothing to do (scripts/playtest-status.sh)"; exit 0
fi
if [ $DRY -eq 1 ]; then
  CFG="$(mktemp -t psf-playtest-cfg.XXXXXX)"; trap 'rm -f "$CFG"' EXIT
  pt_effective_config "$CFG" > /dev/null
else
  mkdir -p -m 700 "$PT_DATA" "$PT_LOGS" "$PT_STATUS"
  chmod 700 "$PT_DATA"
  CFG="$(pt_effective_config)"
fi
if [ -f "$PT_RUN/state.json" ]; then
  if [ $FRESH -eq 1 ]; then
    alive="$("$PT_NODE" -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]));const cp=require("child_process");const out=[];for(const [n,c] of Object.entries(s.components||{})){if(!c.pid)continue;let cmd="";try{cmd=cp.execFileSync("ps",["-o","command=","-p",String(c.pid)],{encoding:"utf8"})}catch{}if(cmd.includes(require("path").basename(c.spec.program)))out.push(n)}console.log(out.join(" "))' "$PT_RUN/state.json" 2>/dev/null)"
    [ -z "$alive" ] || bad "--fresh: components of the old run are still alive ($alive): scripts/playtest-down.sh first"
  else
    echo "an earlier run exists in $PT_RUN: it will be CONTINUED (resume). Use --fresh for a new season."
  fi
fi

if [ ${#problems[@]} -gt 0 ]; then
  echo "playtest-up: not starting; fix these first:" >&2
  printf '  - %s\n' "${problems[@]}" >&2
  exit 1
fi
PORTS_OUT="$(mktemp -t psf-playtest-ports.XXXXXX)"
if ! "$PT_STACK" check-ports --config "$CFG" > "$PORTS_OUT" 2>&1; then
  if [ -f "$PT_RUN/state.json" ] && [ $FRESH -eq 0 ]; then :; else
    echo "playtest-up: the ports are not free:" >&2; cat "$PORTS_OUT" >&2; rm -f "$PORTS_OUT"; exit 1
  fi
fi
rm -f "$PORTS_OUT"

echo "playtest-up: preflight ok (binaries, pinned .so ${WANT_SO:0:8}..., archive, node $("$PT_NODE" --version), $free_gb GB free)"
echo "  config   $PT_CONFIG"
echo "  data     $PT_DATA   (outside git)"
echo "  run      $PT_RUN_ID   ports $PT_BASE_PORT+ (herald $PT_HERALD_PORT)"
if [ $DRY -eq 1 ]; then echo "(dry run: nothing started)"; exit 0; fi

if [ $FRESH -eq 1 ] && { [ -d "$PT_RUN" ] || [ -d "$PT_SECRETS" ]; }; then
  old="$PT_DATA/old/$(date +%Y%m%dT%H%M%S)"
  mkdir -p -m 700 "$old"
  [ -d "$PT_RUN" ] && mv "$PT_RUN" "$old/run"
  [ -d "$PT_SECRETS" ] && mv "$PT_SECRETS" "$old/secrets"
  rm -f "$PT_DATA/LAG-ALARM" "$PT_DATA/HEALTH-ALARM" "$PT_STATUS/status.json"
  echo "archived the old run and its secrets into $old"
fi
rm -f "$PT_DATA/STOP"

# --- what is about to run (for the honest record)
{
  printf '{\n'
  printf '  "started": "%s",\n' "$(date -u +%FT%TZ)"
  printf '  "git_head": "%s",\n' "$(git -C "$PT_ROOT" rev-parse HEAD 2>/dev/null)"
  printf '  "git_branch": "%s",\n' "$(git -C "$PT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  printf '  "git_dirty": %s,\n' "$([ -n "$(git -C "$PT_ROOT" status --porcelain -- frontier-node permutation-gateway permutation-server frontier-abi permutation-rules scripts 2>/dev/null)" ] && echo true || echo false)"
  printf '  "config_sha256": "%s",\n' "$(sha "$PT_CONFIG")"
  printf '  "so_sha256": "%s",\n' "$(sha "$SO")"
  printf '  "node": "%s",\n' "$("$PT_NODE" --version)"
  printf '  "macos": "%s",\n' "$(sw_vers -productVersion 2>/dev/null)"
  printf '  "binaries": {'
  first=1
  for b in frontier-stack frontier-localnet drand-replay frontier-keeper frontier-herald frontier-bots; do
    [ $first -eq 1 ] || printf ', '; first=0
    printf '"%s": "%s"' "$b" "$(sha "$PT_BIN/$b")"
  done
  printf '}\n}\n'
} > "$PT_DATA/launch.json.new" && { [ -f "$PT_DATA/launch.json" ] && cp "$PT_DATA/launch.json" "$PT_DATA/launch-prev-$(date +%Y%m%dT%H%M%S).json"; mv "$PT_DATA/launch.json.new" "$PT_DATA/launch.json"; }

# --- start the babysitter, detached, under caffeinate
perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' -- nohup bash "$HERE/playtest-supervise.sh" >> "$PT_LOGS/supervise.log" 2>&1 < /dev/null &
BPID=$!
perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' -- nohup caffeinate -i -m -s -w "$BPID" > /dev/null 2>&1 < /dev/null &
disown 2>/dev/null || true
echo "babysitter started (pid $BPID), caffeinate attached"

if [ $WAIT -eq 1 ]; then
  echo "waiting for the herald on 127.0.0.1:$PT_HERALD_PORT (the first start takes about a minute) ..."
  deadline=$((SECONDS + 900))
  until curl -sf "http://127.0.0.1:$PT_HERALD_PORT/h/season" > /dev/null; do
    if ! kill -0 "$BPID" 2>/dev/null || [ $SECONDS -ge $deadline ]; then
      echo "the herald did not come up: see $PT_LOGS/stack.log and $PT_LOGS/supervise.log" >&2
      exit 1
    fi
    sleep 2
  done
  echo "the herald answers."
fi

cat <<EOF

UP. Local only; nothing is exposed until you start the tunnel.

  game page (local)   http://127.0.0.1:$PT_HERALD_PORT/frontier/frontier/
  health              scripts/playtest-status.sh        (alarm files: $PT_DATA/LAG-ALARM, HEALTH-ALARM)
  invites             scripts/playtest-invite.sh 20 --label friends-1 --base-url https://<your-tunnel-host>
  stop                scripts/playtest-down.sh

The ONE command that exposes the herald (and nothing else) -- run it yourself when you say go:

  /opt/homebrew/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:$PT_HERALD_PORT --logfile "$PT_LOGS/cloudflared.log"

It prints a random https://<words>.trycloudflare.com URL; every restart of cloudflared gives a NEW one
(invites stay valid, only the link changes). Keep the Mac on AC power; see docs/frontier/playtest/PT-A-OPS.md.
EOF
