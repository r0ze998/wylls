# 復元手順

1. GitHub の `r0ze998/wylls` を clone し、`main` が `921429322d5aecd1a3df0dd8d82c405c87dd985a` を含むことを確認する。
2. `git bundle verify verify16.bundle`（前提 commit が揃っていれば ok）。
3. `git fetch verify16.bundle HEAD:refs/heads/verify16` → `git checkout verify16`（HEAD = `fc8e8ec3c9cda422e73a7506b384ea6e083c1cf5`）。
4. 試験の実行は README.ja.md。修正候補の適用は patches/README.ja.md（隔離 worktree を推奨）。
5. 同梱の SHA256SUMS で各ファイルを照合する。

bundle の前提が無い環境では、同梱の patches/ と、ブランチ上の試験ファイル（README.ja.md の表）を手で配置する。
