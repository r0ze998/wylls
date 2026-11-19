#!/usr/bin/env bash
# One command for a TEST-ONLY local play-check of the playable lane (expedition / wide land / conquest).
#
#   scripts/play-local.sh                 # check tools, build what changed, start a world, open the page
#   scripts/play-local.sh --help
#
# What it does, in order (each phase is timed):
#   1. check  — Rust 1.89.0 + 1.95.0 (rustup), cargo-build-sbf 3.1.9 + platform-tools v1.52, Node >= 20, git,
#               shasum, curl, lsof, free disk, free ports. It only REPORTS what is missing: it never installs anything.
#   2. build  — the localnet land SBF artefact (never deployable, program id [0x45; 32]) and the debug runners, herald
#               and relay tools, with exactly the features of the local playable lane. Skipped when the sources are
#               unchanged since the last good build (a stamp under .local/play-local/), unless --rebuild.
#   3. start  — the local-play launcher (permutation-gateway/src/frontier/local-play-launcher.mjs) with a TEST-only
#               world. By default a KEPT world (launcher --continuous + --persist, PR #38): the natural 1x clock, a
#               world that does not end by the rules, its chain kept on disk under .local/play-local/kept/, the page's
#               test key kept in this browser (non-extractable), so --resume reopens the same village after a stop.
#               With --demo instead: the capture demo (compressed clock, memory-only, not resumable). Optional
#               operator AI residents (TEST keys). Nothing here touches devnet, mainnet, a wallet or a real key.
#   4. open   — prints the page address and opens it in the default browser (unless --no-open).
#   5. stop   — Ctrl-C ends every world of the launcher (the launcher's own close path), then prints where the logs are.
#               (Started as a background job from a script, SIGINT is ignored by bash itself: stop it with kill -TERM.)
#
# Exit codes: 0 ok / stopped by Ctrl-C, 2 bad arguments, 3 a tool is missing, 4 refused (not a TEST cluster),
#             5 not available on this checkout (e.g. --resume before persistence is merged), 6 ports busy / disk low,
#             7 build failed, 8 the launcher did not come up.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${PLAY_LOCAL_STATE:-$ROOT/.local/play-local}"
LAUNCHER="$ROOT/permutation-gateway/src/frontier/local-play-launcher.mjs"
SOLANA_BIN="$HOME/.local/share/solana/install/active_release/bin"
TOOLS="$HOME/.cache/solana/v1.52/platform-tools"

# ------------------------------------------------------------------ messages (ja / en)
LANG_UI=""
say() {  # say <ja> <en>
  if [ "$LANG_UI" = ja ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi
}
err() { if [ "$LANG_UI" = ja ]; then printf 'play-local: %s\n' "$1" >&2; else printf 'play-local: %s\n' "$2" >&2; fi; }

usage() {
  cat <<'EOF'
scripts/play-local.sh [options]     TEST-ONLY local play-check (local in-memory chain, test keys only)

  --ai N          operator AI residents in the world, 0-4 (default 2; --resume keeps the kept world's number)
  --two           TWO people in ONE world (TEST-ONLY launcher option --contest-pair): the second person opens the
                  same page in another browser (or this browser at http://127.0.0.1:<port>/ instead of localhost)
                  and presses the same start button; the first start waits for the second (about 4 minutes, then
                  press again). Kept worlds and --demo alike; --resume brings the same two back (either may press)
  --demo          the 15-minute capture demo instead of a kept world: compressed clock, land preview, memory-only
                  (a stop ends it for good; not resumable)
  --speed N       with --demo: the compressed clock, 10-60 (default 60: a turn is 10 s; the land preview's
                  FoldLand folds as many turns as fit its compute at every speed since fix-march-held)
  --minutes N     the world's life in minutes, 15-240 (default 90)
  --port BASE     the page's port; the world takes BASE+4 onwards (default 41920; all within 41000-41999).
                  The browser keeps a kept world's key per address, so --resume uses the kept world's port.
  --lang ja|en    language of this script's messages (default: from $LANG). The page itself follows the
                  browser's language; its top-right button switches 日本語 ⇄ English.
  --fresh         start a brand-new kept world (the default without --resume)
  --resume        reopen the last kept world: the same chain, village and AI residents (same browser, same port)
  --wide          the WIDE version (TEST-ONLY launcher option --wide-land): the world's Season is the devnet wide
                  preset S1_DEVNET_WIDE_7D, and during its setup the program's own instructions grow the map one ring
                  per bell (a synthetic setup clock) to the rim, ring 128, and open the wide land, rings 129-131, with
                  one test participant per nation. Its Season frees the centre (rings 0-1 ordinary land) and every
                  nation gets real homes on the rim: the page offers a rim village first, and from it the village
                  screen's 「広い土地に村を出す」 claims wide land (AI residents do the same). Then a TEST clock of
                  ×--speed (default 60, 10-60): a rim village saves a claim's cost in about 30 min at 60. The page's
                  「記録」 (recorded world) view shows the wide land. Memory-only: a stop ends it (not with
                  --demo/--resume)
  --random-map    give the NEW world its own map (TEST-ONLY launcher option --fresh-map). Without it every local
                  world has the same map: the local chain always starts at one fixed clock origin, so every world
                  draws the same genesis seed. With it the world starts at a randomly picked earlier origin and the
                  program derives another seed by its unchanged rules. Not with --resume (a kept world keeps its map)
  --rebuild       build even when the sources are unchanged
  --no-build      never build; use what is there (refused if a binary is missing)
  --no-open       print the address only, do not open a browser
  --check-only    run the checks, print what is missing, and exit
  --print-plan    print the resolved settings and the launcher command, and exit (no checks, no build)
  --cluster NAME  only "localnet" is accepted: this script never talks to devnet, testnet or mainnet
  -h, --help      this text
EOF
}

# ------------------------------------------------------------------ arguments
AI=2 SPEED=60 MINUTES=90 PORT=41920 DEMO=0 WIDE=0 PORT_SET=0 AI_SET=0 SPEED_SET=0 FRESH=0 RESUME=0 RANDOM_MAP=0 REBUILD=0 NOBUILD=0 NOOPEN=0 CHECKONLY=0 PLAN=0 CLUSTER=localnet TWO=0 TWO_SET=0
case "${LANG:-}${LC_ALL:-}" in ja*|*ja_JP*) LANG_UI=ja ;; *) LANG_UI=en ;; esac

need_val() { [ $# -ge 2 ] && [ -n "$2" ] && [ "${2#--}" = "$2" ] || { err "$1 には値が必要です" "$1 needs a value"; exit 2; }; }
is_int() { [[ "$1" =~ ^[0-9]+$ ]] && [ "${#1}" -le 5 ]; }

ARGS=("$@")
# (the language first, so every later message is in it)
for ((i = 0; i < ${#ARGS[@]}; i++)); do
  if [ "${ARGS[$i]}" = --lang ]; then
    v="${ARGS[$((i + 1))]:-}"
    case "$v" in ja|en) LANG_UI="$v" ;; *) err "--lang は ja か en です" "--lang must be ja or en"; exit 2 ;; esac
  fi
done
while [ $# -gt 0 ]; do
  case "$1" in
    --ai) need_val "$@"; AI="$2"; AI_SET=1; shift 2 ;;
    --speed) need_val "$@"; SPEED="$2"; SPEED_SET=1; shift 2 ;;
    --demo) DEMO=1; shift ;;
    --wide) WIDE=1; shift ;;
    --two) TWO=1; TWO_SET=1; shift ;;
    --minutes) need_val "$@"; MINUTES="$2"; shift 2 ;;
    --port) need_val "$@"; PORT="$2"; PORT_SET=1; shift 2 ;;
    --lang) need_val "$@"; shift 2 ;;
    --cluster) need_val "$@"; CLUSTER="$2"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --resume) RESUME=1; shift ;;
    --random-map) RANDOM_MAP=1; shift ;;
    --rebuild) REBUILD=1; shift ;;
    --no-build) NOBUILD=1; shift ;;
    --no-open) NOOPEN=1; shift ;;
    --check-only) CHECKONLY=1; shift ;;
    --print-plan) PLAN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "知らない指定です: $1 (--help を見てください)" "unknown option: $1 (see --help)"; exit 2 ;;
  esac
done

# (TEST only: the one cluster this script can start is the in-memory local chain)
case "$CLUSTER" in
  localnet) ;;
  *) err "TEST 専用です。クラスタ \"$CLUSTER\" は拒否します (localnet のみ)。devnet/mainnet にはつなぎません。" \
         "TEST only: cluster \"$CLUSTER\" is refused (localnet only). This script never talks to devnet or mainnet."; exit 4 ;;
esac
for v in SOLANA_URL SOLANA_RPC_URL ANCHOR_PROVIDER_URL; do
  u="${!v:-}"
  if [ -n "$u" ] && ! [[ "$u" =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]+)?/?$ ]]; then
    err "TEST 専用です。環境変数 $v が localhost 以外 ($u) を指しているので止めます。unset してからもう一度どうぞ。" \
        "TEST only: \$$v points away from localhost ($u); refused. Unset it and run again."; exit 4
  fi
done
if [ "$FRESH" = 1 ] && [ "$RESUME" = 1 ]; then err "--fresh と --resume は同時に使えません" "--fresh and --resume cannot be combined"; exit 2; fi
if [ "$RANDOM_MAP" = 1 ] && [ "$RESUME" = 1 ]; then err "--random-map は --resume と一緒には使えません (保存した世界は作ったときの地図のままです)" "--random-map cannot be combined with --resume (a kept world keeps the map it was made with)"; exit 2; fi
# (the fresh map: only when the launcher on this checkout knows it; refused, never faked, otherwise)
FRESH_MAP_WORD="$(sed -n "s/.*FRESH_MAP_MODE = '\([a-z0-9-]*\)'.*/\1/p" "$LAUNCHER" 2>/dev/null | head -1)"
if [ "$RANDOM_MAP" = 1 ] && [ -z "$FRESH_MAP_WORD" ]; then
  err "--random-map: このチェックアウトのランチャーには世界ごとの新しい地図 (--fresh-map) がまだありません。地図は毎回同じです。" \
      "--random-map: the launcher on this checkout has no per-world fresh map (--fresh-map) yet; every local world has the same map."
  exit 5
fi
if [ "$WIDE" = 1 ] && { [ "$DEMO" = 1 ] || [ "$RESUME" = 1 ] || [ "$FRESH" = 1 ] || [ "$TWO" = 1 ]; }; then
  err "--wide は --demo / --resume / --fresh / --two と一緒には使えません (広い版はメモリだけの一人用の世界です)" "--wide cannot be combined with --demo, --resume, --fresh or --two (the wide version is a memory-only world for one player)"; exit 2
fi
# (the wide world's TEST clock: only when the launcher on this checkout takes --wide-scale; refused, never faked, otherwise)
if [ "$WIDE" = 1 ] && ! grep -q "'wide-scale'" "$LAUNCHER" 2>/dev/null; then
  if [ "$SPEED_SET" = 1 ]; then err "--wide --speed: このチェックアウトのランチャーには広い版の時計 (--wide-scale) がありません。" "--wide --speed: the launcher on this checkout has no wide clock (--wide-scale)."; exit 5; fi
  WIDE_SCALE_OK=0
else
  WIDE_SCALE_OK=1
fi
# (the wide land: only when the launcher on this checkout knows it; refused, never faked, otherwise)
WIDE_WORD="$(sed -n "s/.*WIDE_LAND_MODE = '\([a-z0-9-]*\)'.*/\1/p" "$LAUNCHER" 2>/dev/null | head -1)"
if [ "$WIDE" = 1 ] && [ -z "$WIDE_WORD" ]; then
  err "--wide: このチェックアウトのランチャーには広い版 (--wide-land) がまだありません。" "--wide: the launcher on this checkout has no wide land (--wide-land) yet."
  exit 5
fi
if [ "$DEMO" = 1 ] && [ "$RESUME" = 1 ]; then err "--demo の世界は保存されないので --resume できません" "--demo worlds are not kept, so they cannot be resumed (--resume)"; exit 2; fi
if [ "$DEMO" = 0 ] && [ "$WIDE" = 0 ] && [ "$SPEED_SET" = 1 ]; then err "--speed は --demo か --wide と一緒にだけ使えます (保存する世界は通常の速さです)" "--speed works only with --demo or --wide (a kept world runs at the natural speed)"; exit 2; fi
# (two people in one world: only when the launcher on this checkout takes the pair on a natural world — B16, fix-b14-b16)
PAIR_WORD="$(sed -n "s/.*CONTEST_PAIR_MODE = '\([a-z0-9-]*\)'.*/\1/p" "$LAUNCHER" 2>/dev/null | head -1)"
if [ "$TWO" = 1 ] && { [ -z "$PAIR_WORD" ] || ! grep -q "out\['capture-demo'\] === undefined && !natural" "$LAUNCHER" 2>/dev/null; }; then
  err "--two: このチェックアウトのランチャーは、二人で一つの世界 (--contest-pair を普通の世界で) にまだ対応していません。" \
      "--two: the launcher on this checkout cannot yet put two people in one world (--contest-pair on a natural world)."
  exit 5
fi
if [ "$REBUILD" = 1 ] && [ "$NOBUILD" = 1 ]; then err "--rebuild と --no-build は同時に使えません" "--rebuild and --no-build cannot be combined"; exit 2; fi
is_int "$AI" && [ "$AI" -le 4 ] || { err "--ai は 0〜4 です" "--ai must be 0-4"; exit 2; }
is_int "$SPEED" && [ "$SPEED" -ge 10 ] && [ "$SPEED" -le 60 ] || { err "--speed は 10〜60 です" "--speed must be 10-60"; exit 2; }
is_int "$MINUTES" && [ "$MINUTES" -ge 15 ] && [ "$MINUTES" -le 240 ] || { err "--minutes は 15〜240 です" "--minutes must be 15-240"; exit 2; }
AI=$((10#$AI)); SPEED=$((10#$SPEED)); MINUTES=$((10#$MINUTES))

# (persistence: only when the launcher on this checkout knows it — PR #38; refused, never faked, otherwise)
HAS_PERSIST=0
if grep -q "'persist'" "$LAUNCHER" 2>/dev/null && grep -q "'continuous'" "$LAUNCHER" 2>/dev/null; then HAS_PERSIST=1; fi
if [ "$RESUME" = 1 ] && [ "$HAS_PERSIST" = 0 ]; then
  err "--resume はこのチェックアウトでは使えません: ランチャーに世界の保存 (PR #38 continuous + persist) がまだありません。毎回新しい世界で始めてください。" \
      "--resume is not available on this checkout: the launcher has no kept worlds yet (PR #38, continuous + persist). Every start is a new world."
  exit 5
fi
# (an old checkout without persistence: the capture demo is the only world there is)
if [ "$HAS_PERSIST" = 0 ]; then DEMO=1; fi

# The kept world: one directory per kept world under $STATE/kept/, the last one named in $STATE/last-kept. Its
# play-local.conf records what a resume must repeat: the port (the browser keeps the page's key per address), the
# operator residents (their kept keys) and the program's sha256 (the runner refuses another artefact).
RUN_ID="$(date +%Y%m%d-%H%M%S)"
KEPT_CONF=""
conf_get() { sed -n "s/^$1=\(.*\)$/\1/p" "$KEPT_CONF" | head -1; }
if [ "$RESUME" = 1 ]; then
  LASTK="$(cat "$STATE/last-kept" 2>/dev/null || true)"
  if [ -z "$LASTK" ] || [ ! -f "$LASTK/play-local.conf" ]; then
    err "--resume: 続きから遊べる世界がありません ($STATE/last-kept)。まず --resume なしで始めてください。" \
        "--resume: there is no kept world to resume ($STATE/last-kept). Start one first, without --resume."
    exit 5
  fi
  KEPT_CONF="$LASTK/play-local.conf"
  K_PORT="$(conf_get port)"; K_AI="$(conf_get ai)"; K_TWO="$(conf_get two)"; K_TWO="${K_TWO:-0}"
  if [ "$TWO_SET" = 1 ] && [ "$K_TWO" != 1 ]; then
    err "--resume: 保存した世界は一人用です。--two は付けられません (二人で遊ぶなら --fresh --two で新しく始めてください)。" \
        "--resume: the kept world is for one person; --two cannot be added (start a new one with --fresh --two)."
    exit 5
  fi
  if [ "$PORT_SET" = 1 ] && [ "$((10#$PORT))" != "$K_PORT" ]; then
    err "--resume: 保存した世界はポート $K_PORT です。ブラウザは鍵をアドレスごとに覚えるので、--port は変えられません。" \
        "--resume: the kept world uses port $K_PORT. The browser keeps the key per address, so --port cannot change."
    exit 5
  fi
  if [ "$AI_SET" = 1 ] && [ "$((10#$AI))" != "$K_AI" ]; then
    err "--resume: 保存した世界の AI 住民は $K_AI 人です。--ai は変えられません。" "--resume: the kept world has $K_AI AI resident(s); --ai cannot change."
    exit 5
  fi
  PORT="$K_PORT"; AI="$K_AI"; TWO="$K_TWO"
fi

# Ports, as the launcher counts them: the page on BASE, the worlds from BASE+4: two worlds × 5, plus 2 × 4 for the
# operator residents' relays when there are any. All within 41000-41999, none of 41904-41907 (reserved), never 41970
# (the relay refuses it).
is_int "$PORT" || { err "--port は数字です" "--port must be a number"; exit 2; }
PORT=$((10#$PORT)); WORLD_PORT=$((PORT + 4)); SPAN=$((2 * 5 + (AI > 0 ? 2 * 4 : 0)))
LAST=$((WORLD_PORT + SPAN - 1))
port_ok=1
[ "$PORT" -ge 41000 ] && [ "$LAST" -le 41999 ] || port_ok=0
for ((p = PORT; p <= LAST; p++)); do
  if [ "$p" -ge 41904 ] && [ "$p" -le 41907 ]; then port_ok=0; fi
  if [ "$p" -eq 41970 ]; then port_ok=0; fi
done
if [ "$port_ok" = 0 ]; then
  err "--port $PORT では ${PORT}〜$LAST を使います。41000〜41999 の中で、41904〜41907 と 41970 を含まない値にしてください (例: 41920)。" \
      "--port $PORT would use $PORT-$LAST: keep it within 41000-41999 and clear of 41904-41907 and 41970 (e.g. 41920)."
  exit 2
fi

# ------------------------------------------------------------------ the plan
T="$ROOT/frontier-node/target/debug"
SO_DIR="$ROOT/permutation-frontier/target/deploy-localnet-land-sbf"
SO="$SO_DIR/permutation_frontier.so"
BINS=(localnet-natural-play localnet-expedition-play frontier-herald frontier-experimental-expedition-depart-prepare frontier-original-expedition-preview frontier-experimental-expedition-prepare)
STAMP="$STATE/build.stamp"
KEPT=0; if [ "$DEMO" = 0 ] && [ "$WIDE" = 0 ]; then KEPT=1; fi
if [ "$RESUME" = 1 ]; then DATA="$LASTK"; elif [ "$DEMO" = 0 ] && [ "$WIDE" = 0 ]; then DATA="$STATE/kept/$RUN_ID"; else DATA="$STATE/worlds/$RUN_ID"; fi

launcher_args() {  # the launcher command line (artifact hash filled in at start)
  local sha="$1"
  printf '%s\n' "$LAUNCHER" --root "$ROOT" --data "$DATA" \
    --runner "$T/localnet-expedition-play" --natural-runner "$T/localnet-natural-play" \
    --world-preset local-natural-v1 --economy page-signed-v1 --march-trial local-march-trial-v1
  if [ "$WIDE" = 1 ]; then
    printf '%s\n' --wide-land "$WIDE_WORD"
    if [ "$WIDE_SCALE_OK" = 1 ]; then printf '%s\n' --wide-scale "$SPEED"; fi
    # (the herald's compact output: a 129-ring map every turn at the TEST clock outgrows the plain output's guard)
    if grep -q "out\['wide-land'\] === undefined) throw fault('HeraldOutputNeedsCaptureDemo')" "$LAUNCHER" 2>/dev/null; then printf '%s\n' --herald-output compact-v2; fi
  elif [ "$DEMO" = 0 ]; then
    local cm pm
    cm="$(sed -n "s/.*CONTINUOUS_MODE = '\([a-z0-9-]*\)'.*/\1/p" "$LAUNCHER" | head -1)"
    pm="$(sed -n "s/.*PERSIST_MODE = '\([a-z0-9-]*\)'.*/\1/p" "$LAUNCHER" | head -1)"
    printf '%s\n' --continuous "$cm" --persist "$pm"
  else
    printf '%s\n' --capture-demo capture-demo-v1 --demo-scale "$SPEED" --world-option land-preview-v1 --herald-output compact-v2
  fi
  printf '%s\n' --herald "$T/frontier-herald" --depart "$T/frontier-experimental-expedition-depart-prepare" \
    --preview "$T/frontier-original-expedition-preview" --resident "$T/frontier-experimental-expedition-prepare" \
    --artifact "$SO" --artifact-sha "$sha" --world-ttl-minutes "$MINUTES" --port "$PORT" --world-port "$WORLD_PORT"
  if [ "$AI" -gt 0 ]; then printf '%s\n' --operator-residents "$AI"; fi
  if [ "$RANDOM_MAP" = 1 ]; then printf '%s\n' --fresh-map "$FRESH_MAP_WORD"; fi
  if [ "$TWO" = 1 ]; then printf '%s\n' --contest-pair "$PAIR_WORD"; fi
}

if [ "$PLAN" = 1 ]; then
  echo "cluster=localnet"
  echo "test_only=yes"
  echo "lang=$LANG_UI"
  echo "ai=$AI"
  echo "speed=$([ "$DEMO" = 1 ] || [ "$WIDE" = 1 ] && echo "$SPEED" || echo natural)"
  echo "minutes=$MINUTES"
  echo "port=$PORT"
  echo "world_port=$WORLD_PORT"
  echo "ports=$PORT-$LAST"
  echo "world=$([ "$WIDE" = 1 ] && echo wide || { [ "$DEMO" = 1 ] && echo demo || echo kept; })"
  echo "mode=$([ "$RESUME" = 1 ] && echo resume || echo fresh)"
  echo "persist_available=$HAS_PERSIST"
  echo "map=$([ "$RANDOM_MAP" = 1 ] && echo fresh || echo fixed)"
  echo "players=$([ "$TWO" = 1 ] && echo two || echo one)"
  echo "build=$([ "$NOBUILD" = 1 ] && echo never || { [ "$REBUILD" = 1 ] && echo always || echo when-changed; })"
  echo "open=$([ "$NOOPEN" = 1 ] && echo no || echo yes)"
  echo "data=$DATA"
  printf 'launcher=node'; launcher_args '<sha256-of-so>' | while IFS= read -r a; do printf ' %s' "$a"; done; echo
  exit 0
fi

# ------------------------------------------------------------------ timing
PHASES=()
now() { python3 -c 'import time; print(f"{time.time():.1f}")' 2>/dev/null || date +%s; }
T_PHASE=""
phase_start() { T_PHASE="$(now)"; say "== $1" "== $2"; }
phase_end() { local d; d="$(awk -v a="$T_PHASE" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }')"; PHASES+=("$1 ${d}s"); say "   ($1: ${d} 秒)" "   ($1: ${d} s)"; }

# ------------------------------------------------------------------ 1. check
phase_start "1/4 道具の確認" "1/4 checking tools"
MISSING=()
miss() { MISSING+=("$1"); }
command -v git >/dev/null || miss "git  →  https://git-scm.com/ (macOS: xcode-select --install)"
command -v shasum >/dev/null || miss "shasum (perl)  →  macOS: built in; Linux: sudo apt install perl"
command -v curl >/dev/null || miss "curl"
command -v lsof >/dev/null || miss "lsof"
command -v python3 >/dev/null || miss "python3  →  macOS: xcode-select --install"
if command -v node >/dev/null; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$NODE_MAJOR" -ge 20 ] || miss "Node.js >= 20 (have $(node -v))  →  brew install node  (or https://nodejs.org/)"
else
  miss "Node.js >= 20  →  brew install node  (or https://nodejs.org/)"
fi
if command -v rustup >/dev/null; then
  TCS="$(rustup toolchain list 2>/dev/null || true)"
  grep -q '^1\.89\.0' <<<"$TCS" || miss "Rust 1.89.0 (the program)  →  rustup toolchain install 1.89.0 --profile minimal"
  grep -q '^1\.95\.0' <<<"$TCS" || miss "Rust 1.95.0 (frontier-node)  →  rustup toolchain install 1.95.0 --profile minimal"
else
  miss "rustup (Rust 1.89.0 and 1.95.0)  →  https://rustup.rs/ , then: rustup toolchain install 1.89.0 1.95.0 --profile minimal"
fi
SBF=""
if [ -x "$SOLANA_BIN/cargo-build-sbf" ]; then SBF="$SOLANA_BIN/cargo-build-sbf"; elif command -v cargo-build-sbf >/dev/null; then SBF="$(command -v cargo-build-sbf)"; fi
if [ -n "$SBF" ]; then
  SBFV="$("$SBF" --version 2>/dev/null | head -1 || true)"
  [ "$SBFV" = "solana-cargo-build-sbf 3.1.9" ] || miss "cargo-build-sbf 3.1.9 (have: ${SBFV:-unknown})  →  sh -c \"\$(curl -sSfL https://release.anza.xyz/v3.1.9/install)\""
else
  miss "cargo-build-sbf 3.1.9 (Solana CLI tools)  →  sh -c \"\$(curl -sSfL https://release.anza.xyz/v3.1.9/install)\""
fi
for t in "$TOOLS/rust/bin/rustc" "$TOOLS/llvm/bin/clang"; do
  [ -x "$t" ] || { miss "platform-tools v1.52 ($t)  →  once, with network: cargo-build-sbf --tools-version v1.52 --force-tools-install (in any SBF crate)"; break; }
done
FREE_GIB="$(df -Pk "$ROOT" | awk 'NR==2 { printf "%d", $4 / 1048576 }')"
NEED_GIB=6
[ -x "$T/localnet-natural-play" ] || NEED_GIB=20
[ "$FREE_GIB" -ge "$NEED_GIB" ] || miss "free disk >= ${NEED_GIB} GiB at $ROOT (have ${FREE_GIB} GiB)"
BUSY=()
if command -v lsof >/dev/null; then
  # (lsof exits 1 when nothing at all is listening: under pipefail that would end the check silently)
  LISTENING="$({ lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || true; } | awk 'NR > 1 { n = split($9, a, ":"); print a[n] }' | sort -u)"
  for ((p = PORT; p <= LAST; p++)); do
    if grep -qx "$p" <<<"$LISTENING"; then BUSY+=("$p"); fi
  done
fi
if [ "${#MISSING[@]}" -gt 0 ]; then
  say "足りないもの (このスクリプトは何もインストールしません):" "Missing (this script installs nothing):"
  for m in "${MISSING[@]}"; do echo "  - $m"; done
  exit 3
fi
if [ "${#BUSY[@]}" -gt 0 ]; then
  err "使うポートがふさがっています: ${BUSY[*]}。別の --port を選ぶか、そのプログラムを止めてください。" \
      "ports in use: ${BUSY[*]}. Pick another --port, or stop what is listening there."
  exit 6
fi
say "   すべてそろっています (Node $(node -v), 空き ${FREE_GIB} GiB, ポート ${PORT}〜$LAST 空き)" \
    "   all present (Node $(node -v), ${FREE_GIB} GiB free, ports $PORT-$LAST free)"
phase_end check
if [ "$CHECKONLY" = 1 ]; then exit 0; fi

# ------------------------------------------------------------------ 2. build
phase_start "2/4 ビルド" "2/4 build"
mkdir -p "$STATE/logs"
src_key() {  # the sources the binaries come from: tree hashes at HEAD + any uncommitted change in them
  local dirs=(permutation-frontier permutation-rules frontier-abi frontier-node rust-toolchain.toml)
  { git -C "$ROOT" rev-parse "${dirs[@]/#/HEAD:}" 2>/dev/null
    git -C "$ROOT" status --porcelain --untracked-files=normal -- "${dirs[@]}" 2>/dev/null | grep -v ' frontier-node/target/\| permutation-frontier/target/' || true
    git -C "$ROOT" diff HEAD -- "${dirs[@]}" 2>/dev/null || true
    echo "features: land-sbf / itest localnet-land-play / herald land-preview,wide-world-experimental / keeper expedition-dispatch-experimental"
  } | shasum -a 256 | cut -d' ' -f1
}
all_built() { [ -f "$SO" ] || return 1; for b in "${BINS[@]}"; do [ -x "$T/$b" ] || return 1; done; }
KEY="$(src_key)"
if [ "$NOBUILD" = 1 ]; then
  all_built || { err "--no-build ですが、まだビルドされていないものがあります。--no-build を外してください。" "--no-build, but a binary is missing; drop --no-build."; exit 7; }
  say "   ビルドしません (--no-build)" "   not building (--no-build)"
elif [ "$REBUILD" = 0 ] && all_built && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$KEY" ]; then
  say "   最新です。ビルドを省きます (やり直すなら --rebuild)" "   up to date; skipping the build (--rebuild to force)"
else
  rm -f "$STAMP"
  build_step() {  # build_step <name> <command...>
    local name="$1"; shift
    local t0; t0="$(now)"
    say "   - $name …" "   - $name …"
    if ! "$@" >"$STATE/logs/build-$name.log" 2>&1; then
      err "ビルド失敗: ${name}。ログ: $STATE/logs/build-$name.log" "build failed: $name. Log: $STATE/logs/build-$name.log"
      tail -n 20 "$STATE/logs/build-$name.log" >&2; exit 7
    fi
    PHASES+=("  build:$name $(awk -v a="$t0" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }')s")
  }
  # (key-free: cargo-build-sbf writes a REAL program keypair into an out dir that has none; a text placeholder
  #  stops that. The local lane's program id is the fixed [0x45; 32] anyway.)
  mkdir -p "$SO_DIR"
  [ -e "$SO_DIR/permutation_frontier-keypair.json" ] || echo "placeholder: play-local never makes a program key" > "$SO_DIR/permutation_frontier-keypair.json"
  # (the program's crates must be in the cargo cache: its build is offline; a first run fetches them once)
  build_step fetch-program bash -c "cd '$ROOT' && { CARGO_NET_OFFLINE=true cargo fetch --locked --manifest-path permutation-frontier/Cargo.toml || cargo fetch --locked --manifest-path permutation-frontier/Cargo.toml; }"
  build_step program "$ROOT/scripts/build-frontier-localnet-land-sbf.sh"
  build_step runners bash -c "cd '$ROOT/frontier-node' && cargo build --locked -p itest --features localnet-land-play --bin localnet-natural-play --bin localnet-expedition-play"
  build_step herald bash -c "cd '$ROOT/frontier-node' && cargo build --locked -p herald --features land-preview,wide-world-experimental --bin frontier-herald"
  build_step tools bash -c "cd '$ROOT/frontier-node' && cargo build --locked -p keeper --features expedition-dispatch-experimental --bin frontier-experimental-expedition-depart-prepare --bin frontier-original-expedition-preview --bin frontier-experimental-expedition-prepare"
  all_built || { err "ビルドは終わりましたが、できていないファイルがあります" "the build finished but a binary is missing"; exit 7; }
  src_key > "$STAMP"
fi
SHA="$(shasum -a 256 "$SO" | cut -d' ' -f1)"
say "   プログラム (.so) sha256 $SHA" "   program (.so) sha256 $SHA"
# (a kept world resumes only on the same program: the runner refuses another artefact; say so before it starts)
if [ "$RESUME" = 1 ] && [ "$(conf_get sha256)" != "$SHA" ]; then
  err "--resume: 保存した世界のプログラム ($(conf_get sha256 | cut -c1-12)…) と、いまビルドしたもの (${SHA:0:12}…) が違います (ソースが変わりました)。この世界は続けられません。--fresh で新しい世界を始めてください。" \
      "--resume: the kept world's program ($(conf_get sha256 | cut -c1-12)…) differs from the one built now (${SHA:0:12}…): the sources changed. This world cannot continue; start a new one with --fresh."
  exit 5
fi
phase_end build

# ------------------------------------------------------------------ 3. start
phase_start "3/4 TEST 用のローカル世界を起動" "3/4 starting the TEST-only local world"
mkdir -p "$DATA"
chmod 700 "$DATA" 2>/dev/null || true
LOG="$DATA/launcher-$RUN_ID.log"
if [ "$DEMO" = 0 ] && [ "$WIDE" = 0 ] && [ "$RESUME" = 0 ]; then
  # (a new kept world: what a resume must repeat, and the pointer --resume follows)
  { echo "# play-local kept world (TEST-ONLY, not for production): what --resume repeats"
    echo "created=$RUN_ID"; echo "commit=$(git -C "$ROOT" rev-parse --short HEAD)"
    echo "port=$PORT"; echo "ai=$AI"; echo "two=$TWO"; echo "sha256=$SHA"; } > "$DATA/play-local.conf"
  echo "$DATA" > "$STATE/last-kept"
fi
ARGV=()
while IFS= read -r a; do ARGV+=("$a"); done < <(launcher_args "$SHA")
{ echo "# play-local $RUN_ID (TEST-ONLY local world; commit $(git -C "$ROOT" rev-parse --short HEAD))"; printf 'node'; printf ' %q' "${ARGV[@]}"; echo; } >> "$DATA/command.txt"
node "${ARGV[@]}" >"$LOG" 2>&1 &
LPID=$!
echo "$LPID" > "$DATA/launcher.pid"

STOPPING=0
finish() {
  local code="${1:-0}"
  trap - INT TERM HUP
  if kill -0 "$LPID" 2>/dev/null; then
    say "" ""; say "== 止めています (世界を閉じてから終わります) …" "== stopping (closing every world first) …"
    kill -INT "$LPID" 2>/dev/null || true
    for _ in $(seq 1 60); do kill -0 "$LPID" 2>/dev/null || break; sleep 0.5; done
    if kill -0 "$LPID" 2>/dev/null; then kill -TERM "$LPID" 2>/dev/null || true; sleep 2; fi
  fi
  wait "$LPID" 2>/dev/null || true
  say "== 止めました。" "== stopped."
  say "   ログ:          $LOG" "   logs:          $LOG"
  if [ "$KEPT" = 1 ]; then
    say "   世界の記録:    $DATA/persist/<ページの公開アドレス>/ (run/ はチェーン、starts/<回>/ に runner / herald / relay / operators のログ)" \
        "   world records: $DATA/persist/<the page's address>/ (run/ is the chain; starts/<n>/ has the runner / herald / relay / operators logs)"
  else
    say "   世界の記録:    $DATA/ (世界ごとのフォルダに runner / herald / relay / operators のログ、stopped.json)" \
        "   world records: $DATA/ (one folder per world: runner / herald / relay / operators logs, stopped.json)"
  fi
  say "   起動コマンド:  $DATA/command.txt" "   command:       $DATA/command.txt"
  if [ "$KEPT" = 1 ]; then
    say "   この世界は保存されています。続きは同じブラウザで:  scripts/play-local.sh --resume" \
        "   This world is kept. To continue it later, in the same browser:  scripts/play-local.sh --resume"
    say "   (ページのテスト鍵はこのブラウザに保存されています。消すのはページのパネルの「このブラウザに保存した試験用の鍵を消す」です。)" \
        "   (The page's test key is kept in this browser; the page panel's 「このブラウザに保存した試験用の鍵を消す」 deletes it.)"
  else
    say "   ブラウザのタブは閉じてください (タブを閉じるとページのメモリ上のテスト鍵が消えます)。" \
        "   Close the browser tab now (closing it discards the page's memory-only test key)."
  fi
  say "   時間: ${PHASES[*]}" "   timing: ${PHASES[*]}"
  exit "$code"
}
trap 'STOPPING=1; finish 0' INT TERM HUP

URL=""
for _ in $(seq 1 120); do
  if ! kill -0 "$LPID" 2>/dev/null; then
    err "ランチャーが起動できませんでした。ログ: $LOG" "the launcher did not start. Log: $LOG"; tail -n 20 "$LOG" >&2; finish 8
  fi
  URL="$(sed -n 's/.*"open":"\([^"]*\)".*/\1/p' "$LOG" | head -1)"
  [ -n "$URL" ] && break
  sleep 0.5
done
[ -n "$URL" ] || { err "ランチャーが 60 秒以内に応答しませんでした。ログ: $LOG" "the launcher did not answer within 60 s. Log: $LOG"; finish 8; }
phase_end start

# ------------------------------------------------------------------ 4. open
phase_start "4/4 ページ" "4/4 the page"
say "" ""
say "   ▶ ブラウザで開いてください:  $URL" "   ▶ Open in your browser:  $URL"
if [ "$WIDE" = 1 ]; then
  say "   TEST 専用の広い版: 地図はリング 128 まで広がり、広い土地 (リング 129〜131) が開いています。時計は ×${SPEED} (1 ターン $((600 / SPEED)) 秒)。テスト鍵だけ。本物の鍵・SOL・devnet は使いません。止めると世界は終わります。" \
      "   TEST-ONLY wide version: the map is grown to ring 128 and the wide land (rings 129-131) is open. The clock runs at ×$SPEED (a turn is $((600 / SPEED)) s). Test keys only. No real key, SOL or devnet. A stop ends this world."
  say "   最初の村は辺境 (リング 128、広い土地のとなり) に置けます。村の画面の「広い土地に村を出す」で広い土地に 2 つめの村を出せます (費用が貯まったら)。" \
      "   Your first village can stand on the rim (ring 128, beside the wide land). The village screen's 「広い土地に村を出す」 claims a second village on the wide land (once the cost is saved)."
  say "   広い土地は地図の道具の「記録」ボタン (記録された世界・読み取り専用) で見られます。" "   The wide land is shown by the map tools' 「記録」 button (the recorded world, read-only)."
elif [ "$DEMO" = 1 ]; then
  say "   TEST 専用: ローカルのメモリ上のチェーン、×${SPEED} の時計、テスト鍵だけ。本物の鍵・SOL・devnet は使いません。止めると世界は終わります。" \
      "   TEST ONLY: in-memory local chain, ×$SPEED clock, test keys only. No real key, SOL or devnet. A stop ends this world."
else
  say "   TEST 専用: ローカルのチェーン (保存先 $DATA)、通常の速さ (1 ターン 10 分)、テスト鍵だけ。本物の鍵・SOL・devnet は使いません。" \
      "   TEST ONLY: a local chain kept in $DATA, the natural clock (a turn is 10 min), test keys only. No real key, SOL or devnet."
  if [ "$RESUME" = 1 ]; then say "   前回の世界を続けます (同じ村)。止めているあいだ、世界の時計は止まっていました。" "   Resuming the last world (the same village). Its clock stood still while it was stopped."; fi
fi
[ "$AI" -gt 0 ] && say "   AI 住民 $AI 人 (運営側のテスト住民) が同じ世界で動きます。" "   $AI operator AI resident(s) play in the same world."
if [ "$TWO" = 1 ]; then
  ALT_URL="$(printf '%s' "$URL" | sed 's#//localhost:#//127.0.0.1:#')"
  say "   二人で一つの世界です。2 人目は別のブラウザで $URL を開くか、同じブラウザなら $ALT_URL を開いて、同じボタンを押してください。" \
      "   Two people, one world. The second person opens $URL in another browser, or $ALT_URL in this browser, and presses the same button."
  say "   1 人目の開始は 2 人目が押すまで待ちます (約 4 分。過ぎたらもう一度押します)。テスト鍵はブラウザとアドレスごとに別なので、続きも同じブラウザ・同じアドレスで開きます。" \
      "   The first start waits for the second press (about 4 minutes; after that, press again). Each browser and address keeps its own test key, so continue later in the same browser at the same address."
fi
say "   言語はページ右上のボタンで 日本語 ⇄ English を切り替えます。" "   The page's top-right button switches 日本語 ⇄ English."
say "   止めるには Ctrl-C を押してください。" "   Press Ctrl-C to stop."
if [ "$NOOPEN" = 0 ]; then
  if command -v open >/dev/null && [ "$(uname)" = Darwin ]; then open "$URL" || true
  elif command -v xdg-open >/dev/null; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
fi
phase_end open
say "   時間: ${PHASES[*]}" "   timing: ${PHASES[*]}"

# (wait for the launcher. A terminal's Ctrl-C reaches the launcher too (same process group): it closes every world and
#  exits 0, and bash then skips its own INT trap because the child handled the signal itself. The launcher exits only
#  on a signal (a world's time running out ends that world, not the launcher), so 0 here means it was stopped.)
LCODE=0
wait "$LPID" 2>/dev/null || LCODE=$?
while kill -0 "$LPID" 2>/dev/null; do wait "$LPID" 2>/dev/null || true; done
if [ "$STOPPING" = 0 ]; then
  if [ "$LCODE" = 0 ]; then finish 0; fi
  err "ランチャーが予期せず終わりました (終了コード $LCODE)。ログ: $LOG" "the launcher ended unexpectedly (exit $LCODE). Log: $LOG"
  tail -n 20 "$LOG" >&2; finish 8
fi
