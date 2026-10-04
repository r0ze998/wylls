#!/usr/bin/env bash
# AI ownership check (AI-CITIZENS contract v1.2 section 0.2, 10.2 G10, 11.1; unit AC5). The logic is copied from MC's
# scripts/cq-ownership-check.sh (it exists only on the cq branches), adapted to the AI rules.
#
#   permutation-gateway/citizens/bin/ai-hook-check.sh [options] [REV]       (REV defaults to HEAD)
#   permutation-gateway/citizens/bin/ai-hook-check.sh --self-test
#
# Fails (exit 1) when a commit in BASE..REV (every commit, whatever parent it came through)
#   - touches an MC file (the union of docs/frontier/ai-citizens/MC-FILES-*.txt at REV, plus --mc-list files) or a
#     never-edit path of contract 11.1, other than the hook files below;
#   - edits a hook file (frontier-node/crates/bots/src/{bot,fleet,main,lib}.rs, and bots/Cargo.toml for the one
#     `sha2` line) outside an `// AI hook` ... `// AI hook end` block (`# AI hook` in TOML), removes a line there,
#     leaves a block unclosed, or lets a block exceed 30 lines;
#   - edits any other file that already exists at BASE (the integrator's files are listed below);
#   - adds a file outside the AI directories (0.2) and the integrator's files.
# A marker must stand alone on its line (leading blanks allowed); code before it makes it no marker.
# Commits reachable from an --exclude REF (for example frontier/unify at I-C) are exempt, and a merge counts for its
# own edits only (the lines it adds against every parent).
#
# Options:
#   --base REF          default 30ba411 (the contract's base)
#   --mc-list FILE      one more MC file list (repeatable); the committed MC-FILES-*.txt are always read
#   --exclude REF       commits reachable from REF are not checked (repeatable)
#   --repo DIR          the repository (default: this script's checkout)
#   -q                  print violations and the verdict only
# Exit: 0 clean, 1 violations, 2 usage or git errors. Portable to macOS bash 3.2 (no associative arrays).
set -u
set -f   # the path patterns below are case patterns, never globs

# The four hook files, and the one manifest line (the integrator's `sha2` line, 11.2).
HOOK_FILES='
frontier-node/crates/bots/src/bot.rs
frontier-node/crates/bots/src/fleet.rs
frontier-node/crates/bots/src/main.rs
frontier-node/crates/bots/src/lib.rs
frontier-node/crates/bots/Cargo.toml
'
# 11.1: never edited by any unit (case patterns; a trailing /* matches the whole subtree).
NEVER_PATTERNS='
permutation-frontier/*
frontier-abi/*
permutation-rules/*
frontier-wasm/*
frontier-sim/*
frontier-node/crates/herald/*
frontier-node/crates/agents/*
permutation-server/web/session.mjs
permutation-server/web/frontier/hud/*
permutation-server/web/frontier/art/*
permutation-server/web/frontier/people/*
permutation-server/web/frontier/screens/*
permutation-server/web/frontier/map/sprites.mjs
permutation-server/web/frontier/map/fmap.mjs
permutation-server/web/frontier/app.mjs
permutation-server/web/frontier/frontier.css
permutation-server/web/frontier/index.html
permutation-server/web/frontier/practice.html
permutation-server/web/frontier/spectate.html
permutation-server/web/frontier/fui.mjs
permutation-server/web/frontier/onboarding.mjs
permutation-server/web/frontier/controller.mjs
permutation-server/web/frontier/fstate.mjs
permutation-server/web/frontier/fjoin.mjs
permutation-server/web/lang/en-frontier-play.mjs
permutation-gateway/screens/*
permutation-gateway/src/advisor.mjs
permutation-gateway/src/server.mjs
'
# 0.2: where an AI unit may add files.
AI_DIRS='
permutation-gateway/citizens/*
permutation-gateway/test/citizens-*
permutation-gateway/test/fixtures/ai-*
frontier-node/crates/bots/src/ai/*
frontier-node/crates/bots/tests/ai_*
permutation-server/web/frontier/council.html
permutation-server/web/frontier/council/*
docs/frontier/ai-citizens/*
'
# 11.2: files the integrator owns (existing files it may edit, new files it may add).
INTEGRATOR_FILES='
docs/frontier/DECISIONS.md
.gitignore
frontier-node/Cargo.lock
Cargo.lock
permutation-gateway/package.json
permutation-gateway/package-lock.json
'
MAX_BLOCK=30

die() { echo "ai-hook-check: $*" >&2; exit 2; }

# ------------------------------------------------------------------ self-test
self_test() {
  local script tmp r fails=0
  script=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/ai-hook-XXXXXX") || die "mktemp"
  r=$tmp/repo
  export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
  export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
  g() { git -C "$r" -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@" >/dev/null 2>&1; }
  w() { mkdir -p "$(dirname "$r/$1")"; printf '%s\n' "$2" > "$r/$1"; }
  expect() { # expect CODE[:REASON-REGEX] DESCRIPTION ARGS...  (a violation must be reported for the named reason)
    local spec=$1 what=$2 got want why
    shift 2
    want=${spec%%:*}
    why=
    case "$spec" in *:*) why=${spec#*:} ;; esac
    "$script" -q --repo "$r" --base base0 "$@" >"$tmp/out" 2>&1; got=$?
    if [ "$got" = "$want" ] && { [ -z "$why" ] || grep -Eq "$why" "$tmp/out"; }; then echo "  ok   $what"; else echo "  FAIL $what (exit $got, want $want${why:+, reason /$why/})"; sed 's/^/       /' "$tmp/out"; fails=$((fails + 1)); fi
  }
  git init -q -b main "$r" || die "git init"
  w frontier-node/crates/bots/src/bot.rs 'fn bot() {
    one();
    two();
}'
  w frontier-node/crates/bots/src/lib.rs 'pub mod bot;'
  w frontier-node/crates/bots/Cargo.toml '[dependencies]
tokio = 1'
  w frontier-node/crates/herald/src/lib.rs 'pub mod a;'
  w frontier-node/crates/agents/src/policy.rs 'fn decide() {}'
  w permutation-server/web/frontier/app.mjs 'app'
  w permutation-server/web/frontier/herald.mjs 'herald'
  w permutation-server/web/frontier/fland.mjs 'fland'
  w permutation-server/web/session.mjs 'session'
  w permutation-gateway/src/advisor.mjs 'advisor'
  w permutation-gateway/src/frontier/app.mjs 'relay app'
  w docs/frontier/DECISIONS.md 'decisions'
  w docs/frontier/ai-citizens/MC-FILES-2026-10-03.txt 'permutation-server/web/frontier/herald.mjs
frontier-node/crates/bots/src/lib.rs
docs/frontier/DECISIONS.md
docs/mc-owned.md'
  w docs/mc-owned.md 'mc'
  w docs/plain.md 'plain'
  g add -A && g commit -m base && g tag base0
  # 1. clean: hook blocks in two files and the manifest, AI directories, docs of the contract folder
  g checkout -q -b ok base0
  w frontier-node/crates/bots/src/bot.rs 'fn bot() {
    one();
    // AI hook: brain
    if brain() { return; }
    // AI hook end
    two();
}'
  w frontier-node/crates/bots/src/lib.rs 'pub mod bot;
// AI hook
pub mod ai;
// AI hook end'
  w frontier-node/crates/bots/Cargo.toml '[dependencies]
tokio = 1
# AI hook
sha2 = 1
# AI hook end'
  w permutation-gateway/citizens/serve.mjs 'serve'
  w permutation-gateway/test/citizens-serve.test.mjs 'test'
  w permutation-gateway/test/fixtures/ai-deal-v1.json '{}'
  w frontier-node/crates/bots/src/ai/mod.rs 'mod'
  w frontier-node/crates/bots/tests/ai_wire.rs 'test'
  w permutation-server/web/frontier/council.html 'page'
  w permutation-server/web/frontier/council/main.mjs 'js'
  w docs/frontier/ai-citizens/AC5-NOTES.md 'notes'
  g add -A && g commit -m ok
  # a later edit inside the existing block, a second block, an integrator edit and a new MC-FILES list
  w frontier-node/crates/bots/src/bot.rs 'fn bot() {
    one();
    // AI hook: brain
    if brain() { return; }
    log();
    // AI hook end
    two();
    // AI hook: sink
    sink();
    // AI hook end
}'
  w docs/frontier/DECISIONS.md 'decisions
part X'
  w docs/frontier/ai-citizens/MC-FILES-2026-10-05.txt 'docs/plain.md'
  g add -A && g commit -m ok2
  # 2. an MC file
  g checkout -q -b mc base0 && w docs/mc-owned.md 'changed' && g add -A && g commit -m bad
  # 2b. a never-edit file (design chat)
  g checkout -q -b design base0 && w permutation-server/web/frontier/app.mjs 'app changed' && g add -A && g commit -m bad
  # 2c. never-edit: herald, agents, session.mjs, advisor.mjs (each its own branch)
  g checkout -q -b herald base0 && w frontier-node/crates/herald/src/lib.rs 'pub mod a;
pub mod b;' && g add -A && g commit -m bad
  g checkout -q -b agents base0 && w frontier-node/crates/agents/src/policy.rs 'fn decide() { x(); }' && g add -A && g commit -m bad
  g checkout -q -b session base0 && w permutation-server/web/session.mjs 'session2' && g add -A && g commit -m bad
  g checkout -q -b advisor base0 && w permutation-gateway/src/advisor.mjs 'advisor2' && g add -A && g commit -m bad
  # 2d. a new file under a never-edit tree
  g checkout -q -b newnever base0 && w frontier-node/crates/herald/src/ai.rs 'pub fn x() {}' && g add -A && g commit -m bad
  # 3. a hook file edited outside a block
  g checkout -q -b outside base0
  w frontier-node/crates/bots/src/bot.rs 'fn bot() {
    one();
    two();
    three();
}' && g add -A && g commit -m bad
  # 4. a removal outside a block
  g checkout -q -b remove base0
  w frontier-node/crates/bots/src/bot.rs 'fn bot() {
    one();
}' && g add -A && g commit -m bad
  # 5. an unclosed block
  g checkout -q -b unclosed base0
  w frontier-node/crates/bots/src/bot.rs 'fn bot() {
    one();
    // AI hook: never closed
    two();
}' && g add -A && g commit -m bad
  # 6. a marker with code before it is no marker; an opener with code before it opens no block
  g checkout -q -b inline base0
  w frontier-node/crates/bots/src/bot.rs 'fn bot() {
    one();
    evil(); // AI hook
    two();
}' && g add -A && g commit -m bad
  g checkout -q -b inlineopen base0
  w frontier-node/crates/bots/src/bot.rs 'fn bot() {
    one();
    evil(); // AI hook: sneaky
    // AI hook end
    two();
}' && g add -A && g commit -m bad
  # 7. a block of 31 lines, and one of exactly 30
  g checkout -q -b big base0
  { echo 'fn bot() {'; echo '    one();'; echo '    // AI hook: big'; for i in $(seq 1 31); do echo "    x$i();"; done; echo '    // AI hook end'; echo '    two();'; echo '}'; } > "$r/frontier-node/crates/bots/src/bot.rs" && g add -A && g commit -m bad
  g checkout -q -b edge base0
  { echo 'fn bot() {'; echo '    one();'; echo '    // AI hook: edge'; for i in $(seq 1 30); do echo "    x$i();"; done; echo '    // AI hook end'; echo '    two();'; echo '}'; } > "$r/frontier-node/crates/bots/src/bot.rs" && g add -A && g commit -m ok
  # 8. an existing file that is not a hook file, not the integrator's
  g checkout -q -b existing base0 && w docs/plain.md 'plain edited' && g add -A && g commit -m bad
  g checkout -q -b existing2 base0 && w permutation-server/web/frontier/fland.mjs 'fland2' && g add -A && g commit -m bad
  # 9. a new file outside the AI directories
  g checkout -q -b newfile base0 && w scripts/new.sh 'x' && g add -A && g commit -m bad
  g checkout -q -b newfile2 base0 && w permutation-gateway/src/frontier/ai.mjs 'x' && g add -A && g commit -m bad
  # 10. a `//` marker in a TOML file is no marker; a `#` marker in a Rust file is none either
  g checkout -q -b tomlslash base0
  w frontier-node/crates/bots/Cargo.toml '[dependencies]
tokio = 1
// AI hook
sha2 = 1
// AI hook end' && g add -A && g commit -m bad
  g checkout -q -b rshash base0
  w frontier-node/crates/bots/src/lib.rs 'pub mod bot;
# AI hook
pub mod ai;
# AI hook end' && g add -A && g commit -m bad
  # 11. a bad commit followed by its own revert: still reported (every commit is walked)
  g checkout -q -b revert base0
  w permutation-server/web/frontier/app.mjs 'app changed' && g add -A && g commit -m bad
  w permutation-server/web/frontier/app.mjs 'app' && g add -A && g commit -m revert
  # 12. a merge: a side branch brings a never-edit change; the merge itself is clean
  g checkout -q -b side base0 && w permutation-server/web/frontier/app.mjs 'via side' && g add -A && g commit -m side
  g checkout -q -b sidemerge base0 && w docs/frontier/ai-citizens/x.md 'x' && g add -A && g commit -m own
  g merge -q --no-ff -m 'merge side' side
  # 12b. a merge whose own resolution edits a hook file outside a block
  g checkout -q -b evilmerge base0 && w docs/frontier/ai-citizens/y.md 'y' && g add -A && g commit -m own
  g merge -q --no-ff --no-commit ok >/dev/null 2>&1
  w frontier-node/crates/bots/src/bot.rs 'fn bot() {
    // AI hook: brain
    if brain() { return; }
    // AI hook end
    sneaky();
}' && g add -A && g commit -m 'merge with an own edit'
  # 13. commits of another line (--exclude) are exempt
  g checkout -q -b mixed ok && w permutation-server/web/frontier/app.mjs 'foreign change' && g add -A && g commit -m foreign
  g tag foreign-tip
  g checkout -q -b mine foreign-tip && w docs/frontier/ai-citizens/z.md 'z' && g add -A && g commit -m own
  g checkout -q main

  echo "ai-hook-check self-test ($r)"
  expect 0 'hook blocks in the hook files and the manifest, AI directories, integrator files, MC-FILES lists' ok
  expect '1:an MC file' 'an MC file (from the committed MC-FILES list)' mc
  expect '1:never-edit path' 'a design-chat file' design
  expect '1:never-edit path' 'a herald file' herald
  expect '1:never-edit path' 'an agents file' agents
  expect '1:never-edit path' 'session.mjs' session
  expect '1:never-edit path' 'advisor.mjs' advisor
  expect '1:never-edit path' 'a new file under a never-edit tree' newnever
  expect '1:added lines outside an AI hook block' 'a hook file edited outside a block' outside
  expect '1:removed lines outside an AI hook block' 'a removal outside a block' remove
  expect '1:unclosed AI hook block' 'an unclosed block' unclosed
  expect '1:added lines outside an AI hook block' 'a marker with code before it is no marker' inline
  expect '1:added lines outside an AI hook block' 'an opener with code before it opens no block' inlineopen
  expect '1:longer than 30 lines' 'a block of 31 lines' big
  expect 0 'a block of exactly 30 lines' edge
  expect '1:an existing file outside an AI hook block' 'an existing file that is not a hook file' existing
  expect '1:an existing file outside an AI hook block' 'an existing web file outside the never-edit list' existing2
  expect '1:a new file outside the AI directories' 'a new file outside the AI directories (scripts/)' newfile
  expect '1:a new file outside the AI directories' 'a new file outside the AI directories (gateway src)' newfile2
  expect '1:added lines outside an AI hook block' 'a // marker in a TOML file is no marker' tomlslash
  expect '1:added lines outside an AI hook block' 'a # marker in a Rust file is no marker' rshash
  expect '1:never-edit path' 'a bad commit followed by its revert is still reported' revert
  expect '1:never-edit path' 'a side branch merged into a unit branch is counted' sidemerge
  expect "1:the merge's own lines outside an AI hook block" 'a merge counts for its own edits' evilmerge
  expect '1:never-edit path' 'a foreign commit is counted without --exclude' mine
  expect 0 'commits reachable from --exclude are exempt' --exclude foreign-tip mine
  expect 2 'an unknown revision is an error' nope
  expect 0 'extra MC list file does not break a clean branch' --mc-list "$tmp/none-needed.txt" ok
  rm -rf "$tmp"
  if [ "$fails" -eq 0 ]; then echo "self-test: PASS"; exit 0; fi
  echo "self-test: FAIL ($fails)"; exit 1
}

# ------------------------------------------------------------------ arguments
BASE=30ba411
EXCLUDES=
MC_EXTRA=
REPO=
QUIET=0
REV=
while [ $# -gt 0 ]; do
  case "$1" in
    --self-test) self_test ;;
    --base) BASE=${2:?}; shift 2 ;;
    --mc-list) MC_EXTRA="$MC_EXTRA ${2:?}"; shift 2 ;;
    --exclude) EXCLUDES="$EXCLUDES ${2:?}"; shift 2 ;;
    --repo) REPO=${2:?}; shift 2 ;;
    -q) QUIET=1; shift ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$REV" ] || die "one revision only"; REV=$1; shift ;;
  esac
done
[ -n "$REV" ] || REV=HEAD
if [ -z "$REPO" ]; then
  REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null) || die "not in a git checkout"
fi
G() { git -C "$REPO" -c core.quotepath=off "$@"; }
say() { [ "$QUIET" = 1 ] || echo "$@"; }

G rev-parse -q --verify "$BASE^{commit}" >/dev/null 2>&1 || die "base $BASE is not a commit here (--base)"
TIP=$(G rev-parse -q --verify "$REV^{commit}" 2>/dev/null) || die "no revision $REV"

# ------------------------------------------------------------------ the MC list (the union of every MC-FILES-*.txt at REV, plus --mc-list files)
MC=
LISTS=$(G ls-tree -r --name-only "$TIP" -- docs/frontier/ai-citizens 2>/dev/null | grep '/MC-FILES-[^/]*\.txt$' || true)
for f in $LISTS; do MC="$MC
$(G show "$TIP:$f")"; done
for f in $MC_EXTRA; do [ -f "$f" ] && MC="$MC
$(cat "$f")"; done
MC=$(printf '%s\n' "$MC" | grep -v '^[[:space:]]*$' | sort -u || true)
[ -n "$MC" ] || die "no MC file list found (docs/frontier/ai-citizens/MC-FILES-*.txt at $REV): refusing to pass without one"
NLISTS=$(printf '%s\n' "$LISTS" | grep -c . || true)

matches() { # matches FILE PATTERNS: a case-pattern match against the newline-separated PATTERNS
  local f=$1 p
  for p in $2; do
    # shellcheck disable=SC2254
    case "$f" in $p) return 0 ;; esac
  done
  return 1
}
in_list() { printf '%s\n' "$2" | grep -qxF -- "$1"; }
is_hook() { in_list "$1" "$(printf '%s' "$HOOK_FILES" | grep -v '^$')"; }
is_integrator() { in_list "$1" "$(printf '%s' "$INTEGRATOR_FILES" | grep -v '^$')"; }
is_never() { matches "$1" "$NEVER_PATTERNS"; }
is_ai_dir() { matches "$1" "$AI_DIRS"; }
is_mc() { in_list "$1" "$MC"; }
exists_at_base() { G cat-file -e "$BASE:$1" 2>/dev/null; }

# ------------------------------------------------------------------ hook blocks
# marker_of PATH → the comment prefix a marker needs in that file (// for Rust, # for TOML and shell).
marker_of() { case "$1" in *.rs) echo '//' ;; *.toml|*.sh) echo '#' ;; *) echo '//' ;; esac; }
# blocks REV PATH → "start end" lines of the AI hook blocks in that version.
# An unclosed block prints "U start start" (it covers only its opener).
blocks() {
  local pre
  pre=$(marker_of "$2")
  G show "$1:$2" 2>/dev/null | awk -v pre="$pre" '
    function isend(l) { return l ~ ("^[ \t]*" pre " AI hook end[ \t]*$") }
    function isopen(l) { return l ~ ("^[ \t]*" pre " AI hook([ \t:-].*)?$") && !isend(l) }
    isend($0) { if (open) { print s, NR; open = 0 } ; next }
    isopen($0) { if (open) print "U", s, s; s = NR; open = 1; next }
    END { if (open) print "U", s, s }'
}
# lines SIDE: from `git diff -U0` on stdin, the changed line numbers of the old (-) or new (+) side.
lines() {
  awk -v side="$1" '
    /^@@ / {
      for (i = 2; i <= 3; i++) {
        t = $i; sign = substr(t, 1, 1); t = substr(t, 2)
        n = split(t, a, ","); start = a[1] + 0; cnt = (n > 1) ? a[2] + 0 : 1
        if (sign == side) for (k = 0; k < cnt; k++) print start + k
      }
    }'
}
# combined_added: from `git diff-tree --cc -U0 C -- PATH` on stdin, the new line numbers of lines added against every parent.
combined_added() {
  awk '
    /^@@@/ {
      np = 0; while (substr($0, np + 1, 1) == "@") np++; np--
      for (i = 1; i <= NF; i++) if (substr($i, 1, 1) == "+") { split(substr($i, 2), a, ","); ln = a[1] + 0 }
      inh = 1; next
    }
    inh == 1 && /^[-+ ]/ {
      pre = substr($0, 1, np)
      if (index(pre, "-") > 0) next
      if (pre ~ /^[+]+$/) print ln
      ln++
      next
    }'
}
# outside BLOCKS: line numbers on stdin not inside any "start end" range.
outside() {
  awk -v B="$1" 'BEGIN { n = split(B, x, ";"); for (i = 1; i <= n; i++) if (x[i] != "") { split(x[i], y, " "); s[++m] = y[1]; e[m] = y[2] } }
    { ok = 0; for (i = 1; i <= m; i++) if ($1 >= s[i] && $1 <= e[i]) ok = 1; if (!ok) print $1 }'
}
# oversize BLOCKS: the blocks with more than MAX_BLOCK lines between their markers.
oversize() {
  awk -v B="$1" -v max="$MAX_BLOCK" 'BEGIN { n = split(B, x, ";"); for (i = 1; i <= n; i++) if (x[i] != "") { split(x[i], y, " "); if (y[2] - y[1] - 1 > max) printf "%d-%d(%d lines) ", y[1], y[2], y[2] - y[1] - 1 } }'
}

VIOL=0
violation() { VIOL=$((VIOL + 1)); echo "VIOLATION $1 $2: $3"; }

check_hook() { # commit path nparents
  local c=$1 f=$2 np=$3 nb ob bad big
  if ! G cat-file -e "$c:$f" 2>/dev/null; then violation "$c" "$f" "a hook file deleted"; return; fi
  if blocks "$c" "$f" | grep -q '^U '; then violation "$c" "$f" "an unclosed AI hook block"; fi
  nb=$(blocks "$c" "$f" | grep -v '^U ' | tr '\n' ';')
  big=$(oversize "$nb")
  [ -z "$big" ] || violation "$c" "$f" "an AI hook block longer than $MAX_BLOCK lines: $big"
  if [ "$np" -le 1 ]; then
    if [ "$np" -eq 0 ] || ! G cat-file -e "$c^:$f" 2>/dev/null; then
      if exists_at_base "$f"; then :; else violation "$c" "$f" "a hook file created"; return; fi
    fi
    ob=$(blocks "$c^" "$f" | grep -v '^U ' | tr '\n' ';')
    bad=$(G diff -U0 "$c^" "$c" -- "$f" | lines + | outside "$nb" | head -3 | tr '\n' ' ')
    [ -z "$bad" ] || violation "$c" "$f" "added lines outside an AI hook block (new lines $bad)"
    bad=$(G diff -U0 "$c^" "$c" -- "$f" | lines - | outside "$ob" | head -3 | tr '\n' ' ')
    [ -z "$bad" ] || violation "$c" "$f" "removed lines outside an AI hook block (old lines $bad)"
  else
    bad=$(G diff-tree --cc -U0 "$c" -- "$f" | combined_added | outside "$nb" | head -3 | tr '\n' ' ')
    [ -z "$bad" ] || violation "$c" "$f" "the merge's own lines outside an AI hook block (lines $bad)"
  fi
}

# ------------------------------------------------------------------ the walk
excl=
for e in $EXCLUDES; do
  G rev-parse -q --verify "$e^{commit}" >/dev/null 2>&1 || die "--exclude $e is not a commit here"
  excl="$excl --not $(G rev-parse "$e^{commit}")"
done
# shellcheck disable=SC2086
commits=$(G rev-list --reverse "$BASE..$TIP" $excl)
n=$(printf '%s\n' $commits | grep -c . || true)
say "ai-hook-check: $REV ($(G rev-parse --short "$TIP")) since $BASE: $n commit(s), $(printf '%s\n' "$MC" | grep -c .) MC file(s) from $NLISTS list(s)"
for c in $commits; do
  np=$(($(G rev-list --parents -n 1 "$c" | wc -w) - 1))
  if [ "$np" -le 1 ]; then
    files=$(G diff-tree --no-commit-id -r --no-renames --name-only --root "$c")
  else
    files=$(G diff-tree --no-commit-id -r --no-renames --name-only --cc "$c")
  fi
  for f in $files; do
    if is_hook "$f"; then check_hook "$c" "$f" "$np"
    elif is_never "$f"; then violation "$c" "$f" "a never-edit path (contract 11.1)"
    elif is_integrator "$f"; then :
    elif is_mc "$f"; then violation "$c" "$f" "an MC file (docs/frontier/ai-citizens/MC-FILES-*.txt)"
    elif exists_at_base "$f"; then violation "$c" "$f" "an existing file outside an AI hook block ($BASE has it)"
    elif is_ai_dir "$f"; then :
    else violation "$c" "$f" "a new file outside the AI directories (contract 0.2)"
    fi
  done
done

if [ "$VIOL" -gt 0 ]; then echo "ai-hook-check: FAIL ($VIOL violation(s))"; exit 1; fi
echo "ai-hook-check: PASS"
exit 0
