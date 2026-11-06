#!/usr/bin/env bash
# ⑯ phase 9: rebuild the composed tree (test-only worktree, local commits, never pushed).
# Usage: compose-phase9.sh <repo> <worktree-dir> <dir-with-⑪-0004-and-0005-patches>
# Needs in <repo>: 8e96f24d (GitHub claude/gallant-ride-cunptv), ef63544c, and ⑱'s b71b8197 (from r18-on-integration.bundle).
set -euo pipefail
R=$1 W=$2 P=$3
export GIT_AUTHOR_NAME=v16 GIT_AUTHOR_EMAIL=v16@invalid GIT_COMMITTER_NAME=v16 GIT_COMMITTER_EMAIL=v16@invalid GIT_AUTHOR_DATE=2026-11-06T00:00:00Z GIT_COMMITTER_DATE=2026-11-06T00:00:00Z
git -C "$R" worktree add --detach "$W" 8e96f24df4aa4ed51277fa42de6a354a21cd2bc6
cd "$W"
test "$(git rev-parse HEAD^{tree})" = ebbc0f764dd02490e2cea15ce0403d9480f59a65
git apply --index "$P/0004-verify-v0e-evidence-is-unverifiable.patch"; git commit -q -m "v16 compose: ⑪ 0004"
test "$(git rev-parse HEAD^{tree})" = 4acd1346da2ee6ad2e0a710a8e6b2f3c954a966e
git apply --index "$P/0005-verify-v0e-cpi-only-and-lost-tail.patch"; git commit -q -m "v16 compose: ⑪ 0005"
test "$(git rev-parse HEAD^{tree})" = d094201993c7a6b03042e5c66600bcca2c80f894
git cherry-pick ef63544c727490fc6801d30affd11c5b7106c480..b71b8197190ff05e9e999eff45a2ddea6b2b8d1f
test "$(git rev-parse HEAD^{tree})" = 34dbdd77e479b75721f068f31262144d19a167c1
echo "composed tree 34dbdd77e479b75721f068f31262144d19a167c1"
