#!/usr/bin/env bash
# mk-wt.sh <name> <commit>: a detached worktree under the scratchpad with ⑯'s repro tests copied in (tests only)
set -euo pipefail
S=${V16_WORK:?set V16_WORK to the directory holding the v2-* worktrees}
name="$1"; commit="$2"; d="$S/v2-$name"
cd ${V16_REPO:?set V16_REPO to the wylls checkout}
if [ ! -d "$d" ]; then git worktree add --detach "$d" "$commit" >/dev/null 2>&1; fi
echo "$name: $(git -C "$d" rev-parse HEAD) tree $(git -C "$d" rev-parse 'HEAD^{tree}')"
for f in frontier-abi/tests/v16_period_boundary.rs frontier-node/crates/herald/tests/v16_caravan_holder.rs frontier-node/crates/verify/tests/v16_unknown_tag.rs frontier-node/crates/keeper/tests/v16_early_reveal.rs frontier-node/crates/keeper/tests/v16_reveal_versions_fees.rs; do
  mkdir -p "$d/$(dirname "$f")"; cp "$f" "$d/$f"; done
cp permutation-gateway/test/v16-*.test.mjs "$d/permutation-gateway/test/"
[ -e "$d/permutation-gateway/node_modules" ] || ln -s ${V16_REPO:?set V16_REPO to the wylls checkout}/permutation-gateway/node_modules "$d/permutation-gateway/node_modules"
