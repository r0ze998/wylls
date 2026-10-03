#!/usr/bin/env bash
# Guard: the earlier prototype's (v9) files that the new game must not touch,
# and the byte-exact strings that derive keys and seeds.
#
#   scripts/check-v9-frozen.sh
#
# Needs full git history (the CI job checks out with fetch-depth 0).
#
# Two bases, on purpose:
#
#   PRE_RENAME_BASE  d95fa25  the last commit before the product rename.
#   RENAME_BASE      8c1b5ea  "Rename: Permutation State -> Wylls (visible
#                             names)", the only commit after d95fa25 that is
#                             allowed to touch the two v9 paths below. The
#                             owner approved it (docs/frontier/DECISIONS.md,
#                             V1: product-name strings and comments change,
#                             code identifiers, crate and folder names, hash
#                             inputs and seeds do not). Its changes to the v9
#                             paths are one doc comment in permutation-chain/
#                             src/lib.rs and the key-backup header text in
#                             permutation-server/web/session.mjs.
#
# 1. Nothing under the v9 program or in session.mjs changes after RENAME_BASE.
# 2. Since PRE_RENAME_BASE (so across the rename too):
#    a. the body of sessionText() in session.mjs, the text a wallet signs to
#       make the v9 session key, is byte-identical (the key is derived from
#       the signature over those bytes, so any edit would orphan every v9
#       session key);
#    b. every domain tag and seed literal of the old game still exists in the
#       sources: "PS/...", "permutation-state/..." and the Frontier's
#       "PSF-..." / "PSF_..." (additions are allowed, removal or any edit of
#       one is not; they are hash inputs, DECISIONS V1).
set -euo pipefail

PRE_RENAME_BASE=d95fa25
RENAME_BASE=8c1b5ea
V9_PATHS=(permutation-server/web/session.mjs permutation-chain/src)

cd "$(git rev-parse --show-toplevel)"

for rev in "$PRE_RENAME_BASE" "$RENAME_BASE"; do
  git cat-file -e "$rev^{commit}" 2>/dev/null \
    || { echo "check-v9-frozen: commit $rev is not in this clone (fetch full history)" >&2; exit 2; }
done
git merge-base --is-ancestor "$PRE_RENAME_BASE" "$RENAME_BASE" \
  || { echo "check-v9-frozen: $PRE_RENAME_BASE is not an ancestor of $RENAME_BASE" >&2; exit 2; }
git merge-base --is-ancestor "$RENAME_BASE" HEAD \
  || { echo "check-v9-frozen: $RENAME_BASE is not an ancestor of HEAD" >&2; exit 2; }

fail=0

# 1. v9 files unchanged since the rename commit.
if ! git diff --quiet "$RENAME_BASE" -- "${V9_PATHS[@]}"; then
  echo "check-v9-frozen: v9 files changed since the rename commit $RENAME_BASE:" >&2
  git diff --stat "$RENAME_BASE" -- "${V9_PATHS[@]}" >&2
  fail=1
fi

# 2a. sessionText() is byte-identical to the pre-rename base.
session_text() {  # $1: a revision, or empty for the working tree
  if [ -n "$1" ]; then git show "$1:permutation-server/web/session.mjs"; else cat permutation-server/web/session.mjs; fi \
    | awk '/^export function sessionText\(/ { on = 1 } on { print } on && /^}/ { exit }'
}
a="$(session_text "$PRE_RENAME_BASE")"
b="$(session_text "")"
if [ -z "$a" ] || [ -z "$b" ]; then
  echo "check-v9-frozen: could not find 'export function sessionText(' in session.mjs" >&2
  fail=1
elif [ "$a" != "$b" ]; then
  echo "check-v9-frozen: sessionText() in permutation-server/web/session.mjs differs from $PRE_RENAME_BASE:" >&2
  diff <(printf '%s\n' "$a") <(printf '%s\n' "$b") >&2 || true
  fail=1
fi

# 2b. Domain and seed literals: everything the base had is still there.
LIT='"(PSF[-_][A-Za-z0-9_-]*|permutation-state/[A-Za-z0-9_./{}:-]*|PS/[A-Za-z0-9_/.-]+)'
literals() {  # $1: a revision, or empty for the working tree (tracked files)
  git grep -h -o -E "$LIT" $1 -- '*.rs' '*.mjs' '*.js' | sed 's/^b"/"/' | sort -u
}
missing="$(comm -23 <(literals "$PRE_RENAME_BASE") <(literals ""))"
if [ -n "$missing" ]; then
  echo "check-v9-frozen: domain/seed literals present at $PRE_RENAME_BASE are gone or edited:" >&2
  printf '  %s\n' $missing >&2
  fail=1
fi

[ "$fail" = 0 ] || exit 1
echo "check-v9-frozen: ok (v9 files unchanged since $RENAME_BASE; sessionText and $(literals "$PRE_RENAME_BASE" | wc -l | tr -d ' ') domain/seed literals unchanged since $PRE_RENAME_BASE)"
