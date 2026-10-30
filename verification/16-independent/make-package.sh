#!/usr/bin/env bash
# ⑯ 保存パッケージ: この検証ブランチの bundle、パッチ、ログ、文書、復元手順、SHA256。
#   verification/16-independent/make-package.sh [out-dir]
# 何も push しない。bundle の前提は GitHub main の 921429322d5aecd1a3df0dd8d82c405c87dd985a。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="${1:-$here/dist}"
mkdir -p "$out"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
head="$(git -C "$root" rev-parse HEAD)"
base=921429322d5aecd1a3df0dd8d82c405c87dd985a
name="wylls-verify16-$stamp"
work="$out/$name"
rm -rf "$work" && mkdir -p "$work"
git -C "$root" bundle create "$work/verify16.bundle" "$base..HEAD" >/dev/null 2>&1 || git -C "$root" bundle create "$work/verify16.bundle" HEAD
git -C "$root" rev-parse HEAD > "$work/HEAD.sha"
git -C "$root" rev-parse "HEAD^{tree}" > "$work/HEAD.tree"
cp -r "$here/patches" "$here/logs" "$work/"
cp "$here"/*.md "$work/"
cat > "$work/RESTORE.ja.md" <<R
# 復元手順

1. GitHub の \`r0ze998/wylls\` を clone し、\`main\` が \`$base\` を含むことを確認する。
2. \`git bundle verify verify16.bundle\`（前提 commit が揃っていれば ok）。
3. \`git fetch verify16.bundle HEAD:refs/heads/verify16\` → \`git checkout verify16\`（HEAD = \`$head\`）。
4. 試験の実行は README.ja.md。修正候補の適用は patches/README.ja.md（隔離 worktree を推奨）。
5. 同梱の SHA256SUMS で各ファイルを照合する。

bundle の前提が無い環境では、同梱の patches/ と、ブランチ上の試験ファイル（README.ja.md の表）を手で配置する。
R
( cd "$work" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )
tar -C "$out" -czf "$out/$name.tar.gz" "$name"
sha256sum "$out/$name.tar.gz" > "$out/$name.tar.gz.sha256"
echo "package: $out/$name.tar.gz"
cat "$out/$name.tar.gz.sha256"
