# 保存パッケージ（⑲）

2026-10-31。push していないので、④・⑯へは利用者経由でこのパッケージを渡します。④は message 経由ではなく、パッケージでの受け取りを希望しています（message では `<` `>` が置き換わるため）。

## 中身

| ファイル | 内容 |
|---|---|
| `COMMITS.txt` | 基点、HEAD、各 commit の完全な SHA と件名 |
| `wylls-er-candidate.bundle` | 基点 `4cd901de9f8e0d6c0b2016851d30595c4a70aa46` から枝 `claude/ecstatic-cannon-d0jfc4` までの git bundle（`git bundle verify` 済み） |
| `commits/*.patch` | `git format-patch` の各 commit |
| `patches/A-findex.patch` | 独立パッチ A：`frontier-node/` の差分だけ（基点に単独で当たることを確認済み） |
| `patches/B-frontier-er.patch` | 独立パッチ B：`frontier-er/` の差分だけ（同上） |
| `patches/C-docs.patch` | 独立パッチ C：`docs/frontier/er-candidate/` の差分だけ（同上） |
| `results/` | ローカルの実行記録（repo の `docs/frontier/er-candidate/results/` と同じもの） |
| `frontier_er_board.so` | 板のプログラム（SBPF v2）。sha256 `69a4f69ab849f1cfdebc2df20c42bd0cbedc32994d82503d1389b8e3e836435a` |
| `SHA256SUMS` | 上のすべてのファイルの SHA-256 |

この文書の入った commit 自身の SHA は、この文書には書けません。`COMMITS.txt` と最終報告に記載します。

## 当て方（④）

```sh
git fetch /path/to/wylls-er-candidate.bundle claude/ecstatic-cannon-d0jfc4:er-candidate   # 全体
# または、統合の HEAD から作った隔離 worktree に、パッチを個別に当てる
git apply --check patches/A-findex.patch && git apply patches/A-findex.patch
```

パッチ A（findex）は共有コアの近くを変えます。`RpcPoll` が履歴の欠落で失敗するようになり、カーソルに 2 つの項目が増えます（古いカーソルも読める）。採否は④の判断です。パッチ B と C は、既存のコードに影響しません。
