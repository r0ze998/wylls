#!/usr/bin/env bash
# MC ownership check (CONQUEST-CONTRACT v1.1 §4.5, §12; unit CQ1-D).
#
#   scripts/cq-ownership-check.sh [options] BRANCH...
#   scripts/cq-ownership-check.sh --self-test
#
# Fails (exit 1) when a commit of a `frontier/cq-*` branch since that
# branch's own fork point
#   - touches one of the design chat's files (§4.5's written list), or
#   - changes a shared herald file (frontier-node/crates/herald/src/
#     {lib,fold,server}.rs) outside a `// MC hook` block.
# Every commit in FORK..TIP is walked, whatever parent it came through
# (integ-W1: a side branch merged with `git merge --no-ff side` is counted),
# except
#   - commits reachable from codex/frontier (--codex): §4.5 exempts what
#     arrives through a merge of codex/frontier, and
#   - commits a merge of the integration branch (--base) brought in: the
#     non-first parent of a merge on the branch's first-parent chain is an
#     ancestor of the base (the integrator's commits and the other units'
#     merged work), unless the branch checked is the base itself. The
#     branch's own first-parent commits are always counted.
# A merge commit counts for its own edits (the lines it adds against every
# parent); its parents' commits are checked one by one.
#
# The design chat's "footprint" (every path its branch has touched since
# CQ0 beyond §4.5's list) is REPORT-ONLY by default (integ-W1): §4.5's
# written list is the rule, and §11 / §9.1 assign some footprint paths to
# MC units (e.g. permutation-server/web/lang/en-frontier.mjs to CQ3-D).
# --footprint-strict makes footprint hits violations.
#
# A `// MC hook` block runs from an opener line `// MC hook…` to the next
# end line `// MC hook end`, each marker alone on its line (leading
# whitespace allowed). A marker with code before it is no marker. An
# unclosed block in a commit's version of a shared file is a violation.
#
# The fork point of a branch, first that applies:
#   1. the branch's creation entry in its reflog ("branch: Created from …"),
#      which survives the integrator's merges of the branch;
#   2. `git merge-base --fork-point BASE BRANCH` (BASE: --base, default
#      frontier/cq-integ), unless it is the branch tip (an already merged
#      branch would then show no commits);
#   3. `git merge-base BASE BRANCH`.
# The method used is printed. --fork REF forces one fork point for every
# branch named.
#
# Options:
#   --base REF         default frontier/cq-integ
#   --cq0 REF          default $CQ0, else 39ff369 (the MC base commit)
#   --design-ref REF   the design chat's branch, default frontier/ui-shell
#                      (skipped silently when it does not exist)
#   --codex REF        the design chat's base, default codex/frontier
#                      (skipped silently when it does not exist)
#   --no-footprint     do not compute or report the footprint
#   --footprint-strict footprint hits are violations (default: warnings)
#   --fork REF         use REF as every branch's fork point
#   --repo DIR         the repository (default: this script's checkout)
#   -q                 print violations and the verdict only
#
# Exit: 0 clean, 1 violations, 2 usage or git errors. Portable to macOS
# bash 3.2 (no associative arrays).
set -u
set -f   # the path patterns below are case patterns, never globs

STATIC_PATTERNS='
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
permutation-server/web/lang/en-frontier-play.mjs
frontier-node/crates/herald/src/roster.rs
frontier-node/crates/herald/tests/server.rs
permutation-gateway/screens/*
permutation-gateway/test/web-frontier-hud.test.mjs
permutation-gateway/test/web-frontier-people.test.mjs
permutation-gateway/test/web-frontier-playtest.test.mjs
permutation-gateway/test/web-frontier-march.test.mjs
permutation-server/web/session.mjs
'
SHARED_HERALD='
frontier-node/crates/herald/src/lib.rs
frontier-node/crates/herald/src/fold.rs
frontier-node/crates/herald/src/server.rs
'

die() { echo "cq-ownership-check: $*" >&2; exit 2; }

# ------------------------------------------------------------------ self-test
self_test() {
  local script tmp r fails=0
  script=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/cq-own-XXXXXX") || die "mktemp"
  r=$tmp/repo
  export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
  export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
  g() { git -C "$r" -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@" >/dev/null 2>&1; }
  w() { mkdir -p "$(dirname "$r/$1")"; printf '%s\n' "$2" > "$r/$1"; }
  expect() { # expect CODE DESCRIPTION ARGS...
    local want=$1 what=$2 got; shift 2
    "$script" -q --repo "$r" --cq0 base0 "$@" >"$tmp/out" 2>&1; got=$?
    if [ "$got" = "$want" ]; then echo "  ok   $what"; else echo "  FAIL $what (exit $got, want $want)"; sed 's/^/       /' "$tmp/out"; fails=$((fails + 1)); fi
  }
  git init -q -b main "$r" || die "git init"
  w frontier-node/crates/herald/src/lib.rs 'pub mod a;
pub mod b;'
  w frontier-node/crates/herald/src/fold.rs 'fn fold() {
    one();
}'
  w permutation-server/web/frontier/app.mjs 'app'
  w permutation-server/web/frontier/herald.mjs 'herald'
  w docs/x.md 'x'
  g add -A && g commit -m base && g tag base0
  g branch frontier/cq-integ
  # the design chat's branch touches a file not in the static list
  g checkout -b frontier/ui-shell && w permutation-server/web/frontier/intro/title.mjs 'title' && g add -A && g commit -m 'ui: title'
  g checkout main
  # 1. clean: an MC hook block in lib.rs, an owned file, docs
  g checkout -b frontier/cq-1x-ok frontier/cq-integ
  w frontier-node/crates/herald/src/lib.rs 'pub mod a;
// MC hook: conquest
pub mod cqfmt;
// MC hook end
pub mod b;'
  w permutation-server/web/frontier/herald.mjs 'herald
export const X = 1;'
  g add -A && g commit -m ok
  # a later edit inside the existing block, and a hook added to fold.rs
  w frontier-node/crates/herald/src/lib.rs 'pub mod a;
// MC hook: conquest
pub mod cqfmt;
pub mod control;
// MC hook end
pub mod b;'
  w frontier-node/crates/herald/src/fold.rs 'fn fold() {
    one();
    // MC hook: conquest dispatch
    conquest::on_record();
    // MC hook end
}'
  g add -A && g commit -m ok2
  # 2. a design-chat file
  g checkout -b frontier/cq-1x-design frontier/cq-integ
  w permutation-server/web/frontier/app.mjs 'app changed' && g add -A && g commit -m bad
  # 3. a shared herald file outside a hook
  g checkout -b frontier/cq-1x-hook frontier/cq-integ
  w frontier-node/crates/herald/src/lib.rs 'pub mod a;
pub mod b;
pub mod c;' && g add -A && g commit -m bad
  # 4. a removal outside a hook
  g checkout -b frontier/cq-1x-remove frontier/cq-integ
  w frontier-node/crates/herald/src/fold.rs 'fn fold() {
}' && g add -A && g commit -m bad
  # 5. an unclosed hook does not cover what follows it
  g checkout -b frontier/cq-1x-unclosed frontier/cq-integ
  w frontier-node/crates/herald/src/lib.rs 'pub mod a;
// MC hook: never closed
pub mod c;
pub mod b;' && g add -A && g commit -m bad
  # 6. the design footprint (a path only the design branch has touched)
  g checkout -b frontier/cq-1x-footprint frontier/cq-integ
  w permutation-server/web/frontier/intro/title.mjs 'mine' && g add -A && g commit -m bad
  # 6b. a side branch merged into the unit branch touches a design-chat file
  g checkout -b side-helper frontier/cq-integ
  w permutation-server/web/frontier/app.mjs 'app via a side branch' && g add -A && g commit -m side
  g checkout -b frontier/cq-1x-sidemerge frontier/cq-integ
  w docs/s.md 's' && g add -A && g commit -m own
  g merge --no-ff -m 'merge a helper branch' side-helper
  # 6c. a marker with code before it is no marker
  g checkout -b frontier/cq-1x-inline frontier/cq-integ
  w frontier-node/crates/herald/src/fold.rs 'fn fold() {
    one();
    evil(); // MC hook
}' && g add -A && g commit -m bad
  # 6d. an opener with code before it does not open a block
  g checkout -b frontier/cq-1x-inlineopen frontier/cq-integ
  w frontier-node/crates/herald/src/lib.rs 'pub mod a;
pub mod evil; // MC hook: sneaky
pub mod c;
// MC hook end
pub mod b;' && g add -A && g commit -m bad
  # 7. a merge of codex/frontier carrying design-chat and herald changes is not counted
  g checkout -b codex/frontier frontier/cq-integ
  w permutation-server/web/frontier/app.mjs 'app from the design chat'
  w frontier-node/crates/herald/src/lib.rs 'pub mod a;
pub mod b;
pub mod roster;'
  g add -A && g commit -m 'design chat'
  g checkout -b frontier/cq-1x-merge frontier/cq-integ
  w docs/y.md 'y' && g add -A && g commit -m own
  g merge --no-ff -m 'merge codex/frontier' codex/frontier
  # 8. a merge whose own resolution edits a shared file outside a hook is counted
  g checkout -b frontier/cq-1x-evilmerge frontier/cq-integ
  w docs/z.md 'z' && g add -A && g commit -m own
  g merge --no-ff --no-commit codex/frontier
  w frontier-node/crates/herald/src/lib.rs 'pub mod a;
pub mod b;
pub mod roster;
pub mod sneaky;'
  g add -A && g commit -m 'merge with an own edit'
  # 9. after the integrator merges the bad branch, it still fails (no vacuous pass)
  g checkout frontier/cq-integ
  g merge --no-ff -m 'integ: merge ok' frontier/cq-1x-ok
  g merge --no-ff -m 'integ: merge design' frontier/cq-1x-design
  # 10. a unit that merges the integration branch (the integrator's own
  #     commits and the merged units) is not blamed for them
  w docs/integ.md 'integ window' && g add -A && g commit -m 'integ: window commit'
  g checkout -b frontier/cq-2x-late base0
  w docs/late.md 'late' && g add -A && g commit -m own
  g checkout -b frontier/cq-2x-catchup frontier/cq-integ~1
  w docs/c.md 'c' && g add -A && g commit -m own
  g merge --no-ff -m 'merge frontier/cq-integ' frontier/cq-integ
  g checkout main

  echo "cq-ownership-check self-test ($r)"
  expect 0 'MC hook blocks, owned files, docs' frontier/cq-1x-ok
  expect 1 'a design-chat file (§4.5)' frontier/cq-1x-design
  expect 1 'a shared herald file outside a hook' frontier/cq-1x-hook
  expect 1 'a removal outside a hook' frontier/cq-1x-remove
  expect 1 'an unclosed hook' frontier/cq-1x-unclosed
  expect 0 'the design footprint is report-only by default' frontier/cq-1x-footprint
  expect 1 'the design footprint fails with --footprint-strict' --footprint-strict frontier/cq-1x-footprint
  expect 0 'the footprint check can be turned off' --no-footprint --footprint-strict frontier/cq-1x-footprint
  expect 1 'a side branch merged into a unit branch is counted' frontier/cq-1x-sidemerge
  expect 1 'a marker with code before it is no marker' frontier/cq-1x-inline
  expect 1 'an opener with code before it opens no block' frontier/cq-1x-inlineopen
  expect 0 'a merge of codex/frontier is not counted' frontier/cq-1x-merge
  expect 1 'a merge counts for its own edits' frontier/cq-1x-evilmerge
  expect 0 'a merged clean branch still passes' frontier/cq-1x-ok
  expect 1 'a merged bad branch still fails (fork point from the reflog)' frontier/cq-1x-design
  expect 1 'one bad branch among good ones fails the run' frontier/cq-1x-ok frontier/cq-1x-design
  expect 0 'a unit merging the integration branch is not blamed for it' --fork frontier/cq-integ~2 frontier/cq-2x-catchup
  expect 0 'a clean late unit' frontier/cq-2x-late
  expect 2 'an unknown branch is an error' frontier/cq-nope
  expect 2 'no branch is a usage error'
  rm -rf "$tmp"
  if [ "$fails" -eq 0 ]; then echo "self-test: PASS"; exit 0; fi
  echo "self-test: FAIL ($fails)"; exit 1
}

# ------------------------------------------------------------------ arguments
BASE=frontier/cq-integ
CQ0_REF=${CQ0:-39ff369}
DESIGN=frontier/ui-shell
CODEX=codex/frontier
FOOTPRINT=1
FOOT_STRICT=0
FORK=
REPO=
QUIET=0
BRANCHES=
while [ $# -gt 0 ]; do
  case "$1" in
    --self-test) self_test ;;
    --base) BASE=${2:?}; shift 2 ;;
    --cq0) CQ0_REF=${2:?}; shift 2 ;;
    --design-ref) DESIGN=${2:?}; shift 2 ;;
    --codex) CODEX=${2:?}; shift 2 ;;
    --no-footprint) FOOTPRINT=0; shift ;;
    --footprint-strict) FOOT_STRICT=1; shift ;;
    --fork) FORK=${2:?}; shift 2 ;;
    --repo) REPO=${2:?}; shift 2 ;;
    -q) QUIET=1; shift ;;
    -h|--help) sed -n '2,62p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) BRANCHES="$BRANCHES $1"; shift ;;
  esac
done
[ -n "$BRANCHES" ] || die "no branch named (usage: $0 [options] BRANCH...)"
if [ -z "$REPO" ]; then
  REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null) || die "not in a git checkout"
fi
G() { git -C "$REPO" "$@"; }
say() { [ "$QUIET" = 1 ] || echo "$@"; }

# ------------------------------------------------------------------ protected paths
FOOT=
if [ "$FOOTPRINT" = 1 ] && G rev-parse -q --verify "$DESIGN^{commit}" >/dev/null 2>&1; then
  if G rev-parse -q --verify "$CQ0_REF^{commit}" >/dev/null 2>&1; then
    FOOT=$(G log --format= --name-only "$CQ0_REF..$DESIGN" | sort -u | grep -v '^$' | grep -vxF "$(printf '%s' "$SHARED_HERALD" | grep -v '^$')" || true)
  else
    die "CQ0 $CQ0_REF is not a commit here (--cq0)"
  fi
fi

is_static() {
  local f=$1 p
  for p in $STATIC_PATTERNS; do
    # shellcheck disable=SC2254
    case "$f" in $p) return 0 ;; esac
  done
  return 1
}
is_shared() { printf '%s\n' "$SHARED_HERALD" | grep -qxF "$1"; }
is_foot() { [ -n "$FOOT" ] && printf '%s\n' "$FOOT" | grep -qxF "$1"; }

if [ -n "$FOOT" ]; then
  extra=
  for f in $FOOT; do is_static "$f" || extra="$extra $f"; done
  [ -z "$extra" ] || say "design footprint since $CQ0_REF on $DESIGN, beyond §4.5's list:$extra"
fi

# ------------------------------------------------------------------ hook blocks
# blocks REV PATH → "start end" lines of the MC hook blocks in that version.
# An unclosed block prints "U start start" (it covers only its opener).
blocks() {
  G show "$1:$2" 2>/dev/null | awk '
    /^[[:space:]]*\/\/ MC hook end[[:space:]]*$/ { if (open) { print s, NR; open = 0 } ; next }
    /^[[:space:]]*\/\/ MC hook/ { if (open) print "U", s, s; s = NR; open = 1; next }
    END { if (open) print "U", s, s }'
}
# lines SIDE: from `git diff -U0` on stdin, the changed line numbers of the
# old (-) or new (+) side.
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
# combined_added: from `git diff-tree --cc -U0 C -- PATH` on stdin, the new
# line numbers of lines added against every parent (the merge's own lines).
combined_added() {
  awk '
    /^@@@/ {
      np = 0; while (substr($0, np + 1, 1) == "@") np++; np--   # parents
      for (i = 1; i <= NF; i++) if (substr($i, 1, 1) == "+") { split(substr($i, 2), a, ","); ln = a[1] + 0 }
      inh = 1; next
    }
    inh == 1 && /^[-+ ]/ {
      pre = substr($0, 1, np)
      if (index(pre, "-") > 0) next          # a line not in the result
      if (pre ~ /^[+]+$/) print ln           # added against every parent
      ln++
      next
    }'
}
# outside BLOCKS: line numbers on stdin not inside any "start end" range.
outside() {
  awk -v B="$1" 'BEGIN { n = split(B, x, ";"); for (i = 1; i <= n; i++) if (x[i] != "") { split(x[i], y, " "); s[++m] = y[1]; e[m] = y[2] } }
    { ok = 0; for (i = 1; i <= m; i++) if ($1 >= s[i] && $1 <= e[i]) ok = 1; if (!ok) print $1 }'
}

VIOL=0
WARN=0
violation() { VIOL=$((VIOL + 1)); echo "VIOLATION $1 $2: $3"; }

check_shared() { # commit path nparents
  local c=$1 f=$2 np=$3 nb ob bad
  if [ "$np" -le 1 ]; then
    if ! G cat-file -e "$c:$f" 2>/dev/null; then violation "$c" "$f" "a shared herald file deleted"; return; fi
    if [ "$np" -eq 0 ] || ! G cat-file -e "$c^:$f" 2>/dev/null; then violation "$c" "$f" "a shared herald file created"; return; fi
    if blocks "$c" "$f" | grep -q '^U '; then violation "$c" "$f" "an unclosed // MC hook block"; fi
    nb=$(blocks "$c" "$f" | sed 's/^U //' | tr '\n' ';'); ob=$(blocks "$c^" "$f" | sed 's/^U //' | tr '\n' ';')
    bad=$(G diff -U0 "$c^" "$c" -- "$f" | lines + | outside "$nb" | head -3 | tr '\n' ' ')
    [ -z "$bad" ] || violation "$c" "$f" "added lines outside a // MC hook block (new lines $bad)"
    bad=$(G diff -U0 "$c^" "$c" -- "$f" | lines - | outside "$ob" | head -3 | tr '\n' ' ')
    [ -z "$bad" ] || violation "$c" "$f" "removed lines outside a // MC hook block (old lines $bad)"
  else
    if blocks "$c" "$f" | grep -q '^U '; then violation "$c" "$f" "an unclosed // MC hook block"; fi
    nb=$(blocks "$c" "$f" | sed 's/^U //' | tr '\n' ';')
    bad=$(G diff-tree --cc -U0 "$c" -- "$f" | combined_added | outside "$nb" | head -3 | tr '\n' ' ')
    [ -z "$bad" ] || violation "$c" "$f" "the merge's own lines outside a // MC hook block (lines $bad)"
  fi
}

# ------------------------------------------------------------------ branches
for b in $BRANCHES; do
  G rev-parse -q --verify "refs/heads/$b" >/dev/null 2>&1 || die "no branch $b"
  tip=$(G rev-parse "refs/heads/$b")
  fork= ; how=
  if [ -n "$FORK" ]; then
    fork=$(G rev-parse -q --verify "$FORK^{commit}") || die "--fork $FORK is not a commit"
    how="--fork"
  fi
  if [ -z "$fork" ]; then
    created=$(G reflog show --format='%H %gs' "refs/heads/$b" 2>/dev/null | tail -1)
    case "$created" in
      *" branch: Created from "*) fork=${created%% *}; how="reflog: ${created#* }" ;;
    esac
  fi
  if [ -z "$fork" ] && G rev-parse -q --verify "$BASE^{commit}" >/dev/null 2>&1; then
    fp=$(G merge-base --fork-point "$BASE" "$b" 2>/dev/null || true)
    if [ -n "$fp" ] && [ "$fp" != "$tip" ]; then fork=$fp; how="merge-base --fork-point $BASE"; fi
    if [ -z "$fork" ]; then fork=$(G merge-base "$BASE" "$b" 2>/dev/null || true); how="merge-base $BASE"; fi
  fi
  [ -n "$fork" ] || die "$b: no fork point (no creation reflog entry, and $BASE is not a common base); use --fork"
  excl=
  if G rev-parse -q --verify "$CODEX^{commit}" >/dev/null 2>&1; then excl="$CODEX"; fi
  # shellcheck disable=SC2086
  commits=$(G rev-list --reverse "$fork..$tip" ${excl:+--not $excl})
  # Commits a merge of the integration branch brought in (the second
  # parent of a first-parent merge is an ancestor of BASE), except the
  # branch's own first-parent commits: exempt.
  chain=$(G rev-list --first-parent "$fork..$tip")
  brought=
  if [ "$b" != "$BASE" ] && G rev-parse -q --verify "$BASE^{commit}" >/dev/null 2>&1; then
    for m in $chain; do
      for p in $(G rev-list --parents -n 1 "$m" | cut -d' ' -f3-); do
        if G merge-base --is-ancestor "$p" "$BASE" 2>/dev/null; then
          # shellcheck disable=SC2086
          brought="$brought $(G rev-list "$fork..$p" ${excl:+--not $excl} | tr '\n' ' ')"
        fi
      done
    done
  fi
  kept=; skipped=0
  for c in $commits; do
    if [ -n "$brought" ] && printf '%s\n' $brought | grep -qxF "$c" && ! printf '%s\n' $chain | grep -qxF "$c"; then
      skipped=$((skipped + 1)); continue
    fi
    kept="$kept $c"
  done
  commits=$kept
  n=$(printf '%s\n' $commits | grep -c . || true)
  say "$b: fork $(G rev-parse --short "$fork") ($how), $n commit(s) on every parent (not ${excl:-codex/frontier (absent)}; $skipped brought by merging $BASE)"
  before=$VIOL
  for c in $commits; do
    np=$(($(G rev-list --parents -n 1 "$c" | wc -w) - 1))
    if [ "$np" -le 1 ]; then
      files=$(G diff-tree --no-commit-id -r --name-only --root "$c")
    else
      files=$(G diff-tree --no-commit-id -r --name-only --cc "$c")
    fi
    for f in $files; do
      if is_shared "$f"; then check_shared "$c" "$f" "$np"
      elif is_static "$f"; then violation "$c" "$f" "a design-chat file (§4.5)"
      elif is_foot "$f"; then
        if [ "$FOOT_STRICT" = 1 ]; then violation "$c" "$f" "a path the design chat's $DESIGN touched since $CQ0_REF"
        else WARN=$((WARN + 1)); echo "WARNING $c $f: a path the design chat's $DESIGN touched since $CQ0_REF (footprint, report-only; --footprint-strict to enforce)"
        fi
      fi
    done
  done
  [ "$VIOL" -eq "$before" ] && say "$b: OK"
done

if [ "$VIOL" -gt 0 ]; then echo "cq-ownership-check: FAIL ($VIOL violation(s))"; exit 1; fi
[ "$WARN" -eq 0 ] || echo "cq-ownership-check: $WARN footprint warning(s), report-only"
say "cq-ownership-check: PASS"
exit 0
