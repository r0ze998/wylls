#!/usr/bin/env bash
# One recorded key-free run of one named test file (workstream 04, 2026-11-08), under workstream 16's conditions
# (verification/16-independent/REPORT.ja.md §29.36 B and D):
#   record-keyfree-run.sh <out dir outside this checkout> <expected HEAD sha> <package dir> <test file>
# It adds no guard of its own: it checks the conditions, then runs scripts/ci/node-keyfree.sh (which preloads the repo
# scripts/ci/no-keys-guard.mjs) for exactly one file, and saves everything. Refused, with nothing run (exit 9):
#   - HEAD is not the expected sha, or `git status --porcelain=v1 -uall` is not empty;
#   - the test file is not named in scripts/ci/node-key-subset.txt, or its closure digest there differs from now;
#   - a node_modules directory exists from <package dir> up to /, or in $HOME/.node_modules, $HOME/.node_libraries,
#     <node prefix>/lib/node (the guard's preload would then import packages nobody audited);
#   - the sha256 of the guard's preload files differs from the one pinned in node-key-subset.txt;
#   - the out dir is inside this checkout.
# NODE_OPTIONS, NODE_PATH, WS04_SCAN_ROOT, RUNEXEC_BIN and RUNEXEC_VIEW_BIN are removed from the run's environment.
# Saved in <out dir>: tree.txt, node_modules-check.txt, preload-sha256.txt, env.txt, <name>.stdout, <name>.stderr,
# <name>.exit, and sha256.txt over all of them.
set -euo pipefail
out="$1"; want_head="$2"; dir="$3"; file="$4"
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
subset="$root/scripts/ci/node-key-subset.txt"
no() { echo "not run: $*" >&2; exit 9; }
mkdir -p "$out"; out="$(cd "$out" && pwd -P)"
case "$out/" in "$root"/*) no "the out dir is inside this checkout";; esac
cd "$root"
[ "$(git rev-parse HEAD)" = "$want_head" ] || no "HEAD is $(git rev-parse HEAD), not $want_head"
[ -z "$(git status --porcelain=v1 -uall)" ] || no "git status is not empty"
{ git rev-parse HEAD 'HEAD^{tree}'; git status --porcelain=v1 -uall | sha256sum; } > "$out/tree.txt"
rel="$dir/$file"
line="$(grep -E "^${rel//./\\.}  closure=" "$subset" || true)"
[ -n "$line" ] || no "$rel is not named in scripts/ci/node-key-subset.txt"
pinned="$(printf '%s' "$line" | sed -E 's/^[^ ]+  (closure=[0-9a-f]+).*/\1/')"
now="$(env -u NODE_OPTIONS -u NODE_PATH node scripts/ci/scan-node-key-tests.mjs --digest "$rel")"
[ "$pinned" = "$now" ] || no "$rel closure is $now, pinned $pinned"
nodebin="$(env -u NODE_OPTIONS -u NODE_PATH sh -c 'command -v node')"
{
  p="$root/$dir"; while [ "$p" != "/" ]; do [ -e "$p/node_modules" ] && echo "FOUND $p/node_modules" || echo "absent $p/node_modules"; p="$(dirname "$p")"; done
  for x in "$HOME/.node_modules" "$HOME/.node_libraries" "$(dirname "$(dirname "$nodebin")")/lib/node"; do [ -e "$x" ] && echo "FOUND $x" || echo "absent $x"; done
} > "$out/node_modules-check.txt"
! grep -q '^FOUND' "$out/node_modules-check.txt" || no "a node_modules directory is on the resolution path (see node_modules-check.txt)"
preload_files="$(sed -nE 's/^# preload: //p' "$subset")"
[ -n "$preload_files" ] || no "node-key-subset.txt names no preload files"
# shellcheck disable=SC2086
sha256sum $preload_files | sort -k2 > "$out/preload-sha256.txt"
have="$(sha256sum < "$out/preload-sha256.txt" | cut -c1-64)"
want="$(sed -nE 's/^# preload-sha256: ([0-9a-f]{64})$/\1/p' "$subset")"
[ "$have" = "$want" ] || no "the guard's preload files are $have, pinned $want"
clean=(env -u NODE_OPTIONS -u NODE_PATH -u WS04_SCAN_ROOT -u RUNEXEC_BIN -u RUNEXEC_VIEW_BIN)
"${clean[@]}" sh -c 'command -v node; node --version; echo "NODE_OPTIONS=${NODE_OPTIONS-unset}"; echo "NODE_PATH=${NODE_PATH-unset}"' > "$out/env.txt" 2>&1
name="$(basename "$file" .test.mjs)"
set +e
"${clean[@]}" bash scripts/ci/node-keyfree.sh "$dir" "$file" > "$out/$name.stdout" 2> "$out/$name.stderr"
code=$?
set -e
echo "$code" > "$out/$name.exit"
(cd "$out" && sha256sum tree.txt node_modules-check.txt preload-sha256.txt env.txt "$name.stdout" "$name.stderr" "$name.exit" > sha256.txt)
echo "recorded in $out ($name exit $code)"
exit "$code"
