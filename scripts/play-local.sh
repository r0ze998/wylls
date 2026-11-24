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
#               With --demo instead: the capture demo (compressed clock, memory-only, not resumable). With --wide
#               instead: the wide world (map grown to ring 128, wide land open, compressed clock, memory-only).
#               Optional operator AI residents (TEST keys), at war by default (--ai-peaceful). Nothing here touches devnet, mainnet, a wallet or a real key.
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

  --ai N          operator AI residents in the world, 0-4 (default 2; --resume keeps the kept world's number).
                  They are AT WAR by default (TEST-only launcher option --operator-war): besides building and
                  training they muster hosts and march on other nations' reachable keeps (siege, capture), one
                  action per resident per turn, in every world (kept, --random-map, --wide, --demo)
  --ai-peaceful   the AI residents do not march on keeps: they build, harvest, train and muster (in a --wide world
                  they still take rim and wide-land villages and send expeditions)
  --two           TWO people in ONE world (TEST-ONLY launcher option --contest-pair): the second person opens the
                  same page in another browser (or this browser at http://127.0.0.1:<port>/ instead of localhost)
                  and presses the same start button; the first start waits for the second (about 4 minutes, then
                  press again). Kept worlds and --demo alike; --resume brings the same two back (either may press).
                  Not with --wide or --external
  --demo          the 15-minute capture demo instead of a kept world: compressed clock, land preview, memory-only
                  (a stop ends it for good; not resumable; not with --resume or --wide)
  --speed N       with --demo or --wide: the compressed TEST clock, 10-60 (default 60: a turn is 10 s; the faster
                  the clock, the further a loaded machine's provinces trail the chain: try 15 to watch a war)
  --minutes N     the world's life in minutes, 15-240 (default 90; use 240 to play --wide to the end)
  --port BASE     the page's port; the world takes BASE+4 onwards (default 41920; all within 41000-41999):
                  22 ports from BASE (14 with --ai 0), 8 more with --external and 1 for its MCP server.
                  The browser keeps a kept world's key per address, so --resume uses the kept world's port.
                  The page answers at http://localhost:BASE/ and http://127.0.0.1:BASE/ only (loopback; any
                  other host name or machine is refused: PLAY-LOCAL §9)
  --lang ja|en    language of this script's messages (default: from $LANG). The page itself follows the
                  browser's language; its top-right button switches 日本語 ⇄ English.
  --fresh         start a brand-new kept world (the default without --resume)
  --resume        reopen the last kept world: the same chain, village and AI residents (same browser, same port)
  --wide          the WIDE version (TEST-ONLY launcher option --wide-land): the world's Season is the devnet wide
                  preset S1_DEVNET_WIDE_7D, and during its setup the program's own instructions grow the map one ring
                  per bell (a synthetic setup clock) to the rim, ring 128, and open the wide land, rings 129-131, with
                  one test participant per nation. Its Season frees the centre (rings 0-1 ordinary land) and every
                  nation gets real homes on the rim: the page files your first village on the rim, and from it the village
                  screen's "Found a village on the wide land" (「広い土地に村を出す」) claims wide land (AI residents do the same). Then a TEST clock of
                  ×--speed (default 60, 10-60): a rim village saves the cost the claim card shows (the program's price:
                  800 food and wood, 400 stone, 200 gold for a second village) in 30-60 min at 60. A rim host
                  marches into the wide land by "Prepare a boundary route" (「境界への道を準備」; after "Check terrain and time" press the card's
                  "Use a turn that leaves time to send (N)" for the arrival turn: docs/frontier/PLAY-LOCAL.md §4); a wide village's "Next step (wide land)" (「次の一手（広い土地）」) marches
                  wide to wide (local-only feature; press once per step, the card waits and sends by itself, also while another village is open). The ordinary map and the "World" chart (「全体図」) draw the wide land as far as you have
                  seen it (fog of war: no "Records" view). The wide land starts NEUTRAL (every wide keep unowned, 50
                  troops; a claim also reaches 3 provinces from your nation's land, and land opens where nations go),
                  and it has PLAYER LAND: "Claim a tile" (「1マス取る」) on the same card takes one tile a turn for ore
                  (10, +2% per tile owned), kept up with the first village's food; a village stands only on your own
                  tile, so "Found a village here" (「ここに村を出す」) takes two presses (PLAY-LOCAL §4.1).
                  Memory-only: a stop ends it (not with --demo, --resume, --fresh, --two or --coexist; --external works)
  --random-map    give the NEW world its own map (TEST-ONLY launcher option --fresh-map). Without it every local
                  world has the same map: the local chain always starts at one fixed clock origin, so every world
                  draws the same genesis seed. With it the world starts at a randomly picked earlier origin and the
                  program derives another seed by its unchanged rules. Not with --resume (a kept world keeps its map)
  --coexist       TEST-ONLY: the kept world runs the ②+⑨+⑩ COEXIST lane (rights + capacity + custody in one program:
                  scripts/build-frontier-localnet-coexist-sbf.sh, version 0x7805, RULESET_HASH_V4; workstream 4's
                  allocation rev 8; launcher option --coexist local-coexist-v1). The page is the usual one, plus ②
                  rights: issue a Grant from a workshop village, StockSwap into the grantee's Vault, haul it out by
                  caravan, revoke. The grantee must be another player, so the whole loop needs --two (two browser
                  windows will do): `--coexist --demo --two`, about 10 minutes, step by step in docs/frontier/PLAY-LOCAL.md
                  §10 (日本語: PLAY-LOCAL.ja.md §10). Works with --ai, --two, --random-map and --resume (a kept coexist world resumes as
                  one), with --external, and with --demo --speed N (the capture demo's TEST clock: at the natural clock a Vault's 200 wood
                  + 200 stone + 50 gold take most of a day); not with --wide. Its runners, herald and tools are built with their `coexist-lane`
                  feature into $STATE/coexist-bin/ (cargo links them in the shared target dir first, so the
                  next plain world relinks its own binaries: a few seconds). The same world has the preview card
                  "Storage and workshop lending (test)" (「預かりと工房貸し（試験）」): ⑨ lend a workshop, ⑩ keep another's ore, and the losses as real orders
                  (seize a storehouse, stop a caravan and take or burn it): PLAY-LOCAL §12
  --coexist-node  TEST-ONLY, no page: the node localnet-coexist-play alone serves a ②+⑨+⑩ chain on 127.0.0.1:BASE
                  (RPC) and BASE+1 (WebSocket), lands a StockSwap, a capacity loan and a custody lot in it, prints its
                  metadata (one JSON line) and runs until Ctrl-C. Memory-only, alone (no other option but --port)
  --external ADDR[,ADDR]
                  TEST-ONLY: admit up to two EXTERNAL AI residents (⑬ independent residents, ⑤ option B; launcher
                  option --external-residents) by their PUBLIC addresses. Each runs in its own process with its own
                  TEST key (never given to this script) and joins the next world like a newcomer: the player's own
                  funding amount, a relay pinned to its wallet, a public world proxy of its own; same rules, same
                  refusals, no AI mark on the page. With it the ③ MCP server for the world starts READ-ONLY on
                  loopback (127.0.0.1, after the world's ports; only read tools, a link is the resident's own wallet).
                  Reference resident: workstreams/03-composability/mcp/examples/external-resident/ (README "plug in
                  your own AI"). Workstream ⑬'s resident is another client of the same path, and its own option
                  --plan lets ④'s plan store run multi-turn plans (workstreams/13-citizens/resident/local/client.mjs;
                  PLAY-LOCAL §11). Kept worlds, --demo, --wide (a rim first village by request, FileTicket, as the
                  page's; workstream ⑬'s resident also sends the wide land's orders there: wide claim, wide village
                  train / muster / march, expedition), --ai, --random-map, --coexist, --resume; not --two
  --no-mcp        with --external: do not start the read-only MCP server
  --no-coop-board do not attach workstream 01's co-op board (requests across nations; launcher option
                  --coop-board ws01-board-v1, on by default) and its ⑮ titles card. With the board, Village → Trade and defences (村 → 交易と防備) →
                  "Open requests across nations" (「国をまたぐ依頼を開く」) opens it; a caravan to a request you accepted ("① Request destination") is sent from
                  the game in --coexist worlds (the lane that carries caravans); delivering to another nation's
                  request that reaches its amount earns the ⑮ title "Answered a request" (「依頼に応えた」; no win, score or prize effect);
                  see PLAY-LOCAL §13
  --no-world-goals do not judge the world's goals (launcher option --world-goals flag-keeps-v2, on by default): the
                  flag keeps — a nation that holds as many flag keeps CAPTURED from other nations as half of the
                  designated ones (gold pennants on the map), each for 144 turns, achieves the round (its own starting
                  flag keeps do not count); Nation & territory (国と領土) → "World goals" (「世界の目標」) shows the progress and,
                  after an achievement, the prize it WOULD have paid (simulated: no money moves)
  --flag-keeps-hold N   TEST only: the hold time of the flag keeps in turns (default 144 = 24 hours of the chain clock)
  --flag-keeps-need N   TEST only: how many CAPTURED flag keeps a nation must hold (default: half of them, rounded up;
                        never more than the flag keeps of the other nations)
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
AI=2 PEACEFUL=0 SPEED=60 MINUTES=90 PORT=41920 DEMO=0 WIDE=0 PORT_SET=0 AI_SET=0 SPEED_SET=0 FRESH=0 RESUME=0 RANDOM_MAP=0 REBUILD=0 NOBUILD=0 NOOPEN=0 CHECKONLY=0 PLAN=0 CLUSTER=localnet TWO=0 TWO_SET=0 COEXIST=0 COEXIST_NODE=0 EXTERNAL='' NO_MCP=0 COOP=1 GOALS=1 FK_HOLD='' FK_NEED=''
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
    --ai-peaceful) PEACEFUL=1; shift ;;
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
    --coexist) COEXIST=1; shift ;;
    --coexist-node) COEXIST_NODE=1; shift ;;
    --external) need_val "$@"; EXTERNAL="$2"; shift 2 ;;
    --no-mcp) NO_MCP=1; shift ;;
    --no-coop-board) COOP=0; shift ;;
    --no-world-goals) GOALS=0; shift ;;
    --flag-keeps-hold) need_val "$@"; FK_HOLD="$2"; shift 2 ;;
    --flag-keeps-need) need_val "$@"; FK_NEED="$2"; shift 2 ;;
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
EXTERNAL_SET=0; if [ -n "$EXTERNAL" ]; then EXTERNAL_SET=1; fi
if [ "$COEXIST_NODE" = 1 ]; then
  for f in "DEMO:--demo" "WIDE:--wide" "TWO:--two" "RESUME:--resume" "RANDOM_MAP:--random-map" "AI_SET:--ai" "SPEED_SET:--speed" "COEXIST:--coexist" "EXTERNAL_SET:--external"; do
    v="${f%%:*}"
    if [ "${!v}" = 1 ]; then
      err "--coexist-node は ${f#*:} と一緒には使えません (ページなし・AI なし・メモリだけのノードです)" \
          "--coexist-node cannot be combined with ${f#*:} (a node alone: no page, no AI residents, memory only)"; exit 2
    fi
  done
  AI=0
fi
if [ "$COEXIST" = 1 ]; then
  if [ "$WIDE" = 1 ]; then
    err "--coexist は --wide と一緒には使えません (広い版は別の世界です)" "--coexist cannot be combined with --wide (the wide version is another world)"; exit 2
  fi
  if ! grep -q "COEXIST_MODE" "$LAUNCHER" 2>/dev/null; then
    err "--coexist: このチェックアウトのランチャーは ②⑨⑩ の世界 (--coexist local-coexist-v1) をまだ知りません。" "--coexist: the launcher on this checkout has no coexist worlds (--coexist local-coexist-v1) yet."; exit 5
  fi
fi
if [ "$RANDOM_MAP" = 1 ] && [ "$RESUME" = 1 ]; then err "--random-map は --resume と一緒には使えません (保存した世界は作ったときの地図のままです)" "--random-map cannot be combined with --resume (a kept world keeps the map it was made with)"; exit 2; fi
# (the fresh map: only when the launcher on this checkout knows it; refused, never faked, otherwise)
FRESH_MAP_WORD="$(sed -n "s/.*FRESH_MAP_MODE = '\([a-z0-9-]*\)'.*/\1/p" "$LAUNCHER" 2>/dev/null | head -1)"
if [ "$RANDOM_MAP" = 1 ] && [ -z "$FRESH_MAP_WORD" ]; then
  err "--random-map: このチェックアウトのランチャーには世界ごとの新しい地図 (--fresh-map) がまだありません。地図は毎回同じです。" \
      "--random-map: the launcher on this checkout has no per-world fresh map (--fresh-map) yet; every local world has the same map."
  exit 5
fi
if [ "$WIDE" = 1 ] && { [ "$DEMO" = 1 ] || [ "$RESUME" = 1 ] || [ "$FRESH" = 1 ] || [ "$TWO" = 1 ]; }; then
  # (local-perf: the refusal names the options given with --wide, and how the wide version is started)
  WITH=(); for f in "DEMO:--demo" "RESUME:--resume" "FRESH:--fresh" "TWO:--two"; do v="${f%%:*}"; if [ "${!v}" = 1 ]; then WITH+=("${f#*:}"); fi; done
  err "--wide は ${WITH[*]} と一緒には使えません。広い版は \`--wide\` だけで起動します (例: scripts/play-local.sh --wide --ai 4 --random-map)。広い版はメモリだけの一人用の世界なので、--demo (攻略デモ)・--resume / --fresh (保存する世界)・--two (二人用) はありません。" \
      "--wide cannot be combined with ${WITH[*]}. The wide version is started with \`--wide\` alone (e.g. scripts/play-local.sh --wide --ai 4 --random-map). It is a memory-only world for one player: no --demo (capture demo), --resume / --fresh (kept worlds) or --two (two players)."
  exit 2
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
if [ "$NO_MCP" = 1 ] && [ "$EXTERNAL_SET" = 0 ]; then
  err "--no-mcp は --external と一緒にだけ使えます (MCP は外部の AI 住民のためだけに起動します)" "--no-mcp works only with --external (the MCP server is started only for external AI residents)"; exit 2
fi
if [ "$EXTERNAL_SET" = 1 ]; then
  # (the shape only: up to two distinct base58 addresses; the launcher checks each decodes to exactly 32 bytes)
  EXT_OK=1
  [[ "$EXTERNAL" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}(,[1-9A-HJ-NP-Za-km-z]{32,44})?$ ]] || EXT_OK=0
  if [[ "$EXTERNAL" == *,* ]] && [ "${EXTERNAL%%,*}" = "${EXTERNAL#*,}" ]; then EXT_OK=0; fi
  if [ "$EXT_OK" = 0 ]; then
    err "--external は公開アドレス (base58) を 1 つか、カンマで区切った別々の 2 つです (鍵ではありません)" "--external takes one public address (base58), or two different ones separated by a comma (never a key)"; exit 2
  fi
  # (external-wide: a --wide world takes them too — the rim route of a person's page, FileTicket — only the pair does not)
  if [ "$TWO" = 1 ]; then
    err "--external は --two と一緒には使えません (外部の AI 住民は一人用の世界に入ります)" \
        "--external cannot be combined with --two (external AI residents join a one-person world)"; exit 2
  fi
  if ! grep -q "EXTERNAL_RESIDENTS_MODE" "$LAUNCHER" 2>/dev/null; then
    err "--external: このチェックアウトのランチャーには外部の AI 住民 (--external-residents) がまだありません。" "--external: the launcher on this checkout has no external AI residents (--external-residents) yet."; exit 5
  fi
fi
MCP=0; if [ "$EXTERNAL_SET" = 1 ] && [ "$NO_MCP" = 0 ]; then MCP=1; fi
MCP_BIN="$ROOT/workstreams/03-composability/mcp/bin/wylls-mcp-local-play.mjs"
if [ "$MCP" = 1 ] && [ ! -f "$MCP_BIN" ]; then
  err "--external: このチェックアウトには読み取り専用の MCP サーバー ($MCP_BIN) がありません。--no-mcp を付けてください。" "--external: this checkout has no read-only MCP server ($MCP_BIN); add --no-mcp."; exit 5
fi
if [ "$REBUILD" = 1 ] && [ "$NOBUILD" = 1 ]; then err "--rebuild と --no-build は同時に使えません" "--rebuild and --no-build cannot be combined"; exit 2; fi
is_int "$AI" && [ "$AI" -le 4 ] || { err "--ai は 0〜4 です" "--ai must be 0-4"; exit 2; }
is_int "$SPEED" && [ "$SPEED" -ge 10 ] && [ "$SPEED" -le 60 ] || { err "--speed は 10〜60 です" "--speed must be 10-60"; exit 2; }
is_int "$MINUTES" && [ "$MINUTES" -ge 15 ] && [ "$MINUTES" -le 240 ] || { err "--minutes は 15〜240 です" "--minutes must be 15-240"; exit 2; }
if [ -n "$FK_HOLD" ]; then is_int "$FK_HOLD" && [ "$FK_HOLD" -ge 1 ] && [ "$FK_HOLD" -le 100000 ] || { err "--flag-keeps-hold は 1〜100000 です" "--flag-keeps-hold must be 1-100000"; exit 2; }; fi
if [ -n "$FK_NEED" ]; then is_int "$FK_NEED" && [ "$FK_NEED" -ge 1 ] && [ "$FK_NEED" -le 12 ] || { err "--flag-keeps-need は 1〜12 です" "--flag-keeps-need must be 1-12"; exit 2; }; fi
if { [ -n "$FK_HOLD" ] || [ -n "$FK_NEED" ]; } && [ "$GOALS" = 0 ]; then err "--flag-keeps-hold / --flag-keeps-need は --no-world-goals と一緒には使えません" "--flag-keeps-hold / --flag-keeps-need cannot be combined with --no-world-goals"; exit 2; fi
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
# (the AI war, loop-play4 B-6: on by default whenever there are AI residents, in every world, when the launcher on this
#  checkout takes it outside the capture demo; refused, never faked, on an older one unless --ai-peaceful)
WAR_OK=0
if grep -q "OperatorWarNeedsResidentsTrial" "$LAUNCHER" 2>/dev/null; then WAR_OK=1; fi
WAR=1; if [ "$PEACEFUL" = 1 ]; then WAR=0; fi

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
  K_LANE="$(conf_get lane)"; K_LANE="${K_LANE:-plain}"
  if [ "$COEXIST" = 1 ] && [ "$K_LANE" != coexist ]; then
    err "--resume --coexist: 保存した世界は ②⑨⑩ の世界ではありません。" "--resume --coexist: the kept world is not a coexist world."; exit 5
  fi
  if [ "$K_LANE" = coexist ]; then COEXIST=1; fi
  PORT="$K_PORT"; AI="$K_AI"; TWO="$K_TWO"
fi
if [ "$WAR" = 1 ] && [ "$AI" -gt 0 ] 2>/dev/null && [ "$WAR_OK" = 0 ]; then
  err "このチェックアウトのランチャーでは、AI の戦争はデモの世界でしか使えません。--ai-peaceful を付けるか、新しいチェックアウトで試してください。" \
      "the launcher on this checkout runs the AI war only in the capture demo: add --ai-peaceful, or use a newer checkout."
  exit 5
fi

# Ports, as the launcher counts them: the page on BASE, the worlds from BASE+4: two worlds × 5, plus 2 × 4 for the
# operator residents' relays when there are any. All within 41000-41999, none of 41904-41907 (reserved), never 41970
# (the relay refuses it).
is_int "$PORT" || { err "--port は数字です" "--port must be a number"; exit 2; }
PORT=$((10#$PORT)); WORLD_PORT=$((PORT + 4)); SPAN=$((2 * 5 + (AI > 0 ? 2 * 4 : 0)))
# (--external: the launcher's externalPorts — after the worlds' 2 x 5 and the operator relays' 2 x 4, two ports (proxy,
#  relay) per admitted address per world slot, 2 x 2 x 2 in all; the read-only MCP server takes the next port)
EXT_BASE=$((WORLD_PORT + SPAN))
if [ "$EXTERNAL_SET" = 1 ]; then SPAN=$((SPAN + 2 * 2 * 2)); fi
LAST=$((WORLD_PORT + SPAN - 1))
MCP_PORT=""
if [ "$MCP" = 1 ]; then MCP_PORT=$((LAST + 1)); LAST=$MCP_PORT; fi
# (--coexist-node: the node's RPC on BASE and its WebSocket on BASE+1, nothing else)
if [ "$COEXIST_NODE" = 1 ]; then LAST=$((PORT + 1)); fi
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
# (--coexist: the coexist .so, and the same binaries built with their `coexist-lane` feature, kept apart in their own
#  directory. cargo links them in the SHARED frontier-node/target/debug first — the default lane's own binaries are
#  replaced there until its next build, which is why a coexist build drops the default stamp below)
if [ "$COEXIST" = 1 ]; then
  T="$STATE/coexist-bin"
  SO_DIR="$ROOT/permutation-frontier/target/deploy-localnet-coexist-sbf"
  SO="$SO_DIR/permutation_frontier.so"
  STAMP="$STATE/build-coexist-lane.stamp"
fi
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
  if [ "$AI" -gt 0 ] && [ "$WAR" = 1 ]; then printf '%s\n' --operator-war operator-war-v1; fi
  if [ "$RANDOM_MAP" = 1 ]; then printf '%s\n' --fresh-map "$FRESH_MAP_WORD"; fi
  if [ "$TWO" = 1 ]; then printf '%s\n' --contest-pair "$PAIR_WORD"; fi
  if [ "$COEXIST" = 1 ]; then printf '%s\n' --coexist local-coexist-v1; fi
  if [ "$EXTERNAL_SET" = 1 ]; then printf '%s\n' --external-residents "$EXTERNAL"; fi
  # (fix-loop8, LP8-3: workstream 01's co-op board — requests across nations — and the ⑮ titles card come with every world
  #  unless --no-coop-board; only when this checkout's launcher knows the option)
  if [ "$COOP" = 1 ] && grep -q "COOP_BOARD_MODE" "$LAUNCHER" 2>/dev/null; then printf '%s\n' --coop-board ws01-board-v1; fi
  # (flag-keeps-slice-1: the world's goals judge — flag keeps, no money — with every world unless --no-world-goals;
  #  only when this checkout's launcher knows the option)
  if [ "$GOALS" = 1 ] && grep -q "WORLD_GOALS_MODE" "$LAUNCHER" 2>/dev/null; then
    printf '%s\n' --world-goals flag-keeps-v2
    if [ -n "$FK_HOLD" ]; then printf '%s\n' --flag-keeps-hold "$FK_HOLD"; fi
    if [ -n "$FK_NEED" ]; then printf '%s\n' --flag-keeps-need "$FK_NEED"; fi
  fi
}
# (the read-only MCP server reads the first world slot's first external resident's public proxy: its own /h/* and /gw)
MCP_HERALD="http://localhost:$EXT_BASE"
mcp_env() {
  printf '%s\n' WYLLS_MCP_TEST_AS=1 "WYLLS_MCP_PORT=$MCP_PORT" WYLLS_MCP_HOST=127.0.0.1 "WYLLS_MCP_HERALD=$MCP_HERALD" "WYLLS_MCP_RELAY=$MCP_HERALD/gw"
}

CO_SO_DIR="$ROOT/permutation-frontier/target/deploy-localnet-coexist-sbf"
CO_SO="$CO_SO_DIR/permutation_frontier.so"
CO_NODE="$T/localnet-coexist-play"
CO_STAMP="$STATE/build-coexist.stamp"
if [ "$PLAN" = 1 ] && [ "$COEXIST_NODE" = 1 ]; then
  echo "cluster=localnet"
  echo "test_only=yes"
  echo "lang=$LANG_UI"
  echo "world=coexist-node"
  echo "program_version=0x7805"
  echo "features=rights,capacity,custody (+ the playable lane: expedition, conquest kinds, wide land, land preview)"
  echo "port=$PORT"
  echo "ports=$PORT-$LAST"
  echo "build=$([ "$NOBUILD" = 1 ] && echo never || { [ "$REBUILD" = 1 ] && echo always || echo when-changed; })"
  echo "node=$CO_NODE --artifact $CO_SO --artifact-sha256 <sha256-of-so> --rpc-port $PORT --ws-port $((PORT + 1))"
  exit 0
fi
if [ "$PLAN" = 1 ]; then
  echo "cluster=localnet"
  echo "test_only=yes"
  echo "lang=$LANG_UI"
  echo "ai=$AI"
  echo "ai_war=$([ "$AI" -gt 0 ] && [ "$WAR" = 1 ] && echo yes || echo no)"
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
  if [ "$COEXIST" = 1 ]; then echo "lane=coexist"; echo "program_version=0x7805"; fi
  if [ "$EXTERNAL_SET" = 1 ]; then
    echo "external=$EXTERNAL"
    echo "external_proxy=$EXT_BASE"
    if [ "$MCP" = 1 ]; then echo "mcp=http://127.0.0.1:$MCP_PORT/mcp"; printf 'mcp_server='; mcp_env | tr '\n' ' '; echo "node $MCP_BIN"; else echo "mcp=off"; fi
  fi
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
if [ "$MCP" = 1 ] && command -v node >/dev/null; then
  # (the read-only MCP server imports permutation-gateway's client code, whose npm packages a fresh checkout lacks:
  #  load its modules once, start nothing)
  MCP_DIR="$(dirname "$(dirname "$MCP_BIN")")"
  if ! node --input-type=module -e "for (const f of ['src/local-play-game.mjs', 'src/auth.mjs', 'src/server.mjs', 'src/http.mjs']) await import(process.argv[1] + '/' + f);" "$MCP_DIR" >/dev/null 2>&1; then
    miss "npm packages of the read-only MCP server (--external)  →  (cd permutation-gateway && npm ci --ignore-scripts)   (or add --no-mcp)"
  fi
fi
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

# ------------------------------------------------------------------ --coexist-node: build and start the ②+⑨+⑩ node
if [ "$COEXIST_NODE" = 1 ]; then
  phase_start "2/3 ビルド (②⑨⑩)" "2/3 build (②+⑨+⑩)"
  mkdir -p "$STATE/logs"
  co_key() {
    local dirs=(permutation-frontier permutation-rules frontier-abi frontier-node rust-toolchain.toml scripts/build-frontier-localnet-coexist-sbf.sh)
    { git -C "$ROOT" rev-parse "${dirs[@]/#/HEAD:}" 2>/dev/null
      git -C "$ROOT" status --porcelain --untracked-files=normal -- "${dirs[@]}" 2>/dev/null | grep -v ' frontier-node/target/\| permutation-frontier/target/' || true
      git -C "$ROOT" diff HEAD -- "${dirs[@]}" 2>/dev/null || true
      echo "features: localnet-coexist-sbf / itest localnet-coexist-harness"
    } | shasum -a 256 | cut -d' ' -f1
  }
  CO_KEY="$(co_key)"
  if [ "$NOBUILD" = 1 ]; then
    { [ -f "$CO_SO" ] && [ -x "$CO_NODE" ]; } || { err "--no-build ですが、まだビルドされていないものがあります。" "--no-build, but the coexist .so or node is missing; drop --no-build."; exit 7; }
  elif [ "$REBUILD" = 0 ] && [ -f "$CO_SO" ] && [ -x "$CO_NODE" ] && [ -f "$CO_STAMP" ] && [ "$(cat "$CO_STAMP")" = "$CO_KEY" ]; then
    say "   最新です。ビルドを省きます (やり直すなら --rebuild)" "   up to date; skipping the build (--rebuild to force)"
  else
    rm -f "$CO_STAMP"
    say "   プログラム (②⑨⑩ の .so)..." "   program (the ②+⑨+⑩ .so)..."
    "$ROOT/scripts/build-frontier-localnet-coexist-sbf.sh" >"$STATE/logs/build-coexist-program.log" 2>&1 || {
      err "ビルド失敗: プログラム。ログ: $STATE/logs/build-coexist-program.log" "build failed: program. Log: $STATE/logs/build-coexist-program.log"
      tail -n 20 "$STATE/logs/build-coexist-program.log" >&2; exit 7; }
    say "   ノード (localnet-coexist-play)..." "   node (localnet-coexist-play)..."
    ( cd "$ROOT/frontier-node" && cargo build --locked -p itest --features localnet-coexist-harness --bin localnet-coexist-play ) >"$STATE/logs/build-coexist-node.log" 2>&1 || {
      err "ビルド失敗: ノード。ログ: $STATE/logs/build-coexist-node.log" "build failed: node. Log: $STATE/logs/build-coexist-node.log"
      tail -n 20 "$STATE/logs/build-coexist-node.log" >&2; exit 7; }
    echo "$CO_KEY" > "$CO_STAMP"
  fi
  CO_SHA="$(shasum -a 256 "$CO_SO" | cut -d' ' -f1)"
  say "   プログラム (.so) sha256 $CO_SHA (版 0x7805、配布しません)" "   program (.so) sha256 $CO_SHA (version 0x7805, never deployable)"
  phase_end build
  phase_start "3/3 起動 (Ctrl-C で止まります)" "3/3 start (Ctrl-C stops it)"
  say "   RPC http://127.0.0.1:$PORT  WebSocket ws://127.0.0.1:$((PORT + 1))  (ページはまだありません)" \
      "   RPC http://127.0.0.1:$PORT  WebSocket ws://127.0.0.1:$((PORT + 1))  (no page yet)"
  exec "$CO_NODE" --artifact "$CO_SO" --artifact-sha256 "$CO_SHA" --rpc-port "$PORT" --ws-port "$((PORT + 1))"
fi

# ------------------------------------------------------------------ 2. build
phase_start "2/4 ビルド" "2/4 build"
mkdir -p "$STATE/logs"
src_key() {  # the sources the binaries come from: tree hashes at HEAD + any uncommitted change in them
  local dirs=(permutation-frontier permutation-rules frontier-abi frontier-node rust-toolchain.toml)
  { git -C "$ROOT" rev-parse "${dirs[@]/#/HEAD:}" 2>/dev/null
    git -C "$ROOT" status --porcelain --untracked-files=normal -- "${dirs[@]}" 2>/dev/null | grep -v ' frontier-node/target/\| permutation-frontier/target/' || true
    git -C "$ROOT" diff HEAD -- "${dirs[@]}" 2>/dev/null || true
    if [ "$COEXIST" = 1 ]; then echo "coexist: coexist-sbf / itest localnet-coexist-lane-play / herald +coexist-lane,rights-records / keeper +coexist-lane"
    else echo "features: land-sbf / itest localnet-land-play / herald land-preview,wide-world-experimental,expedition-records-experimental / keeper expedition-dispatch-experimental"; fi
  } | shasum -a 256 | cut -d' ' -f1
}
all_built() { [ -f "$SO" ] || return 1; for b in "${BINS[@]}"; do [ -x "$T/$b" ] || return 1; done; }
# (loop-play6 LP6-2: the default lane runs its binaries straight from the shared target dir, and a coexist build links
#  coexist-featured ones there. A coexist stamp newer than the default one — or a default stamp that is gone — says the
#  last finished build in that dir was the coexist lane's: the default binaries are then NOT the default lane's, whatever
#  the default stamp says. This also covers a checkout whose coexist build ran before that build dropped the stamp)
shared_dir_is_this_lane() {
  [ "$COEXIST" = 1 ] && return 0
  if [ -f "$STATE/build-coexist-lane.stamp" ] && [ "$STATE/build-coexist-lane.stamp" -nt "$STAMP" ]; then return 1; fi
  return 0
}
KEY="$(src_key)"
if [ "$NOBUILD" = 1 ]; then
  all_built || { err "--no-build ですが、まだビルドされていないものがあります。--no-build を外してください。" "--no-build, but a binary is missing; drop --no-build."; exit 7; }
  shared_dir_is_this_lane || { err "--no-build ですが、いまあるバイナリは --coexist の世界のものです (最後のビルドが --coexist でした)。--no-build を外してください (数秒で作り直します)。" "--no-build, but the binaries on disk are the --coexist world's (the last build was a --coexist one); drop --no-build (the rebuild takes a few seconds)."; exit 7; }
  say "   ビルドしません (--no-build)" "   not building (--no-build)"
elif [ "$REBUILD" = 0 ] && all_built && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$KEY" ] && shared_dir_is_this_lane; then
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
  if [ "$COEXIST" = 1 ]; then
    # (the coexist lane: its own program, and the same binaries with `coexist-lane`, copied out of the shared target
    #  dir into $T so a later default build — which rebuilds them without the feature — never mixes the two)
    # (from the first cargo step on, the shared target dir holds coexist-featured binaries: the default lane's stamp
    #  must not call them "up to date", or the next plain world runs them and CreateSeason fails with Custom(1) —
    #  loop-play6. Dropped BEFORE the builds, so a failed or interrupted coexist build is covered too)
    rm -f "$STATE/build.stamp"
    build_step program "$ROOT/scripts/build-frontier-localnet-coexist-sbf.sh"
    build_step runners bash -c "cd '$ROOT/frontier-node' && cargo build --locked -p itest --features localnet-coexist-lane-play --bin localnet-natural-play --bin localnet-expedition-play"
    build_step herald bash -c "cd '$ROOT/frontier-node' && cargo build --locked -p herald --features land-preview,wide-world-experimental,expedition-records-experimental,coexist-lane,rights-records --bin frontier-herald"
    build_step tools bash -c "cd '$ROOT/frontier-node' && cargo build --locked -p keeper --features expedition-dispatch-experimental,coexist-lane --bin frontier-experimental-expedition-depart-prepare --bin frontier-original-expedition-preview --bin frontier-experimental-expedition-prepare"
    mkdir -p "$T"
    for b in "${BINS[@]}"; do cp -p "$ROOT/frontier-node/target/debug/$b" "$T/$b"; done
  else
  build_step program "$ROOT/scripts/build-frontier-localnet-land-sbf.sh"
  build_step runners bash -c "cd '$ROOT/frontier-node' && cargo build --locked -p itest --features localnet-land-play --bin localnet-natural-play --bin localnet-expedition-play"
  build_step herald bash -c "cd '$ROOT/frontier-node' && cargo build --locked -p herald --features land-preview,wide-world-experimental,expedition-records-experimental --bin frontier-herald"
  build_step tools bash -c "cd '$ROOT/frontier-node' && cargo build --locked -p keeper --features expedition-dispatch-experimental --bin frontier-experimental-expedition-depart-prepare --bin frontier-original-expedition-preview --bin frontier-experimental-expedition-prepare"
  fi
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
    echo "port=$PORT"; echo "ai=$AI"; echo "two=$TWO"; echo "sha256=$SHA"; echo "lane=$([ "$COEXIST" = 1 ] && echo coexist || echo plain)"; } > "$DATA/play-local.conf"
  echo "$DATA" > "$STATE/last-kept"
fi
ARGV=()
while IFS= read -r a; do ARGV+=("$a"); done < <(launcher_args "$SHA")
{ echo "# play-local $RUN_ID (TEST-ONLY local world; commit $(git -C "$ROOT" rev-parse --short HEAD))"; printf 'node'; printf ' %q' "${ARGV[@]}"; echo; } >> "$DATA/command.txt"
# (external-wide-orders: the log exists BEFORE the launcher starts — the background job opens its redirect itself, so the
#  `sed` on "$LOG" below could run first and, under set -e / pipefail, end this script with the launcher left running)
: >"$LOG"
node "${ARGV[@]}" >"$LOG" 2>&1 &
LPID=$!
echo "$LPID" > "$DATA/launcher.pid"

STOPPING=0
MPID=""
finish() {
  local code="${1:-0}"
  trap - INT TERM HUP
  if [ -n "$MPID" ] && kill -0 "$MPID" 2>/dev/null; then
    kill -TERM "$MPID" 2>/dev/null || true
    for _ in $(seq 1 10); do kill -0 "$MPID" 2>/dev/null || break; sleep 0.2; done
    kill -KILL "$MPID" 2>/dev/null || true
  fi
  [ -n "$MPID" ] && { wait "$MPID" 2>/dev/null || true; }
  if kill -0 "$LPID" 2>/dev/null; then
    say "" ""; say "== 止めています (世界を閉じてから終わります) …" "== stopping (closing every world first) …"
    kill -INT "$LPID" 2>/dev/null || true
    for _ in $(seq 1 60); do kill -0 "$LPID" 2>/dev/null || break; sleep 0.5; done
    # (fix-loop6, LP6-3: a second signal ends the launcher at once — it ends its own world processes first; and the wait
    #  below must never hang: a launcher still there after that is killed)
    if kill -0 "$LPID" 2>/dev/null; then kill -TERM "$LPID" 2>/dev/null || true; sleep 2; fi
    if kill -0 "$LPID" 2>/dev/null; then kill -KILL "$LPID" 2>/dev/null || true; fi
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
  if [ -n "$MPID" ]; then say "   MCP のログ:    $MLOG" "   MCP log:       $MLOG"; fi
  if [ "$KEPT" = 1 ]; then
    say "   この世界は保存されています。続きは同じブラウザで:  scripts/play-local.sh --resume" \
        "   This world is kept. To continue it later, in the same browser:  scripts/play-local.sh --resume"
    say "   (ページのテスト鍵はこのブラウザに保存されています。消すのはページのパネルの「このブラウザに保存した試験用の鍵を消す」です。)" \
        "   (The page's test key is kept in this browser; the page panel's \"Delete the test key kept in this browser\" deletes it.)"
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
if [ "$MCP" = 1 ]; then
  # (TEST-ONLY ③: the read-only local-play MCP server, loopback only, for the external residents; it only GETs the
  #  world's public proxy, so it may start before a world exists and answers once the world is up)
  MLOG="$DATA/mcp-$RUN_ID.log"
  MENV=(); while IFS= read -r a; do MENV+=("$a"); done < <(mcp_env)
  env "${MENV[@]}" node "$MCP_BIN" >"$MLOG" 2>&1 &
  MPID=$!
  echo "$MPID" > "$DATA/mcp.pid"
  for _ in $(seq 1 40); do grep -q 'listening on' "$MLOG" 2>/dev/null && break; kill -0 "$MPID" 2>/dev/null || break; sleep 0.25; done
  if ! grep -q 'listening on' "$MLOG" 2>/dev/null; then
    err "読み取り専用の MCP サーバーが起動できませんでした。ログ: $MLOG" "the read-only MCP server did not start. Log: $MLOG"; tail -n 5 "$MLOG" >&2; finish 8
  fi
fi
phase_end start

# ------------------------------------------------------------------ 4. open
phase_start "4/4 ページ" "4/4 the page"
say "" ""
say "   ▶ ブラウザで開いてください:  $URL" "   ▶ Open in your browser:  $URL"
if [ "$WIDE" = 1 ]; then
  say "   TEST 専用の広い版: 地図はリング 128 まで広がり、広い土地 (リング 129〜131) が開いています。時計は ×${SPEED} (1 ターン $((600 / SPEED)) 秒)。テスト鍵だけ。本物の鍵・SOL・devnet は使いません。止めると世界は終わります。" \
      "   TEST-ONLY wide version: the map is grown to ring 128 and the wide land (rings 129-131) is open. The clock runs at ×$SPEED (a turn is $((600 / SPEED)) s). Test keys only. No real key, SOL or devnet. A stop ends this world."
  say "   最初の村は辺境 (リング 128、広い土地のとなり) に置けます。村の画面の「広い土地に村を出す」で広い土地に 2 つめの村を出せます (費用が貯まったら)。" \
      "   Your first village can stand on the rim (ring 128, beside the wide land). The village screen's \"Found a village on the wide land\" claims a second village on the wide land (once the cost is saved)."
  say "   広い土地は普通の地図と「全体図」の六つの角の外側に、見えたところまで描かれます (霧の世界: 「記録」の画面は出ません。docs/frontier/PLAY-LOCAL.ja.md §5)。" "   The wide land is drawn on the ordinary map and the \"World\" chart outside its six corners, as far as you have seen it (fog of war: no \"Records\" view; docs/frontier/PLAY-LOCAL.md §5)."
elif [ "$DEMO" = 1 ]; then
  say "   TEST 専用: ローカルのメモリ上のチェーン、×${SPEED} の時計、テスト鍵だけ。本物の鍵・SOL・devnet は使いません。止めると世界は終わります。" \
      "   TEST ONLY: in-memory local chain, ×$SPEED clock, test keys only. No real key, SOL or devnet. A stop ends this world."
else
  say "   TEST 専用: ローカルのチェーン (保存先 $DATA)、通常の速さ (1 ターン 10 分)、テスト鍵だけ。本物の鍵・SOL・devnet は使いません。" \
      "   TEST ONLY: a local chain kept in $DATA, the natural clock (a turn is 10 min), test keys only. No real key, SOL or devnet."
  if [ "$RESUME" = 1 ]; then say "   前回の世界を続けます (同じ村)。止めているあいだ、世界の時計は止まっていました。" "   Resuming the last world (the same village). Its clock stood still while it was stopped."; fi
fi
[ "$AI" -gt 0 ] && say "   AI 住民 $AI 人 (運営側のテスト住民) が同じ世界で動きます。" "   $AI operator AI resident(s) play in the same world."
[ "$AI" -gt 0 ] && [ "$WAR" = 1 ] && say "   AI の国は戦争中です: 届く他国の砦へ進軍し、包囲して奪います (1 ターンに 1 回の行動)。止めるには --ai-peaceful。" \
    "   The AI nations are at war: they march on reachable keeps of other nations, siege and capture them (one action per turn). --ai-peaceful turns it off."
if [ "$EXTERNAL_SET" = 1 ]; then
  LBASE="http://localhost:$PORT"
  say "   外部の AI 住民 (TEST): ${EXTERNAL} を受け入れます。あなたが「新しい世界を始める」を押すと、その世界に新しい住民として入ります (同じ規則・同じ拒否、ページに AI の印はありません)。" \
      "   External AI resident(s) (TEST) admitted: ${EXTERNAL}. When you press start, each joins your world as a newcomer (same rules, same refusals, no AI mark on the page)."
  say "   住民は自分のプロセスと自分のテスト鍵で動かします。例: node workstreams/03-composability/mcp/examples/external-resident/agent.mjs --launcher $LBASE --key <鍵ファイル>$([ "$MCP" = 1 ] && echo " --mcp http://127.0.0.1:$MCP_PORT/mcp")" \
      "   Each resident runs in its own process with its own TEST key, e.g.: node workstreams/03-composability/mcp/examples/external-resident/agent.mjs --launcher $LBASE --key <key file>$([ "$MCP" = 1 ] && echo " --mcp http://127.0.0.1:$MCP_PORT/mcp")"
  if [ "$MCP" = 1 ]; then
    say "   読み取り専用の MCP (③): http://127.0.0.1:$MCP_PORT/mcp (この機械だけ、読むツールだけ、つなぐのは住民自身の財布の署名)。" \
        "   Read-only MCP (③): http://127.0.0.1:$MCP_PORT/mcp (this machine only, read tools only, linked by the resident's own wallet signature)."
  fi
fi
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
