# 22. commit の索引と保存

**ブランチ：** `workstream/08-persistence`（ローカルだけ。push していない）
**基準：** `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（PR #22 の統合候補。main 統合済み・CI 全成功とは扱わない）

変更は全て `workstreams/08-persistence/` の中だけです。共有コア、他担当の仕様、本番のコードは変えていません。

| 順 | commit | 日時（UTC） | 中身 | 主なファイル |
|---|---|---|---|---|
| 1 | `b5532088494980cb42c98210754280facc59f205` | 2026-10-29 23:03 | ⑧の最初の版：現行ルール表、残す・戻すの表、案 P0・A・B・C、シミュレーター、結果、筋書き、権利の境界、試遊の観察項目 | 01〜08章、`sim/`（rng、stats、params、proposals、scenarios、world、metrics、run、report、テスト）、`results/` |
| 2 | `d03bb1810a015623ba3bda4539a2aef305c23f3c` | 2026-10-30 01:10 | 仮定と発見を分ける。B を B1・B2 に分ける。指標の定義、軍の解散、離脱・復帰の感度、シーズン終了時の疑いの LiteSVM 再現、多重アカウント、①・⑤への引き渡し、4場面の試遊案 | 09〜15章、`sim/paired.mjs`、`results/{core,replication-seeds101-130,sensitivity,exploits,retention}`、`repro/` |
| 3 | `83602346fd05dfc5d467b2096681d5c7ba3fbe72` | 2026-10-30 01:34 | 6国の初期配置の比較（PL-W、PL-G、PL-S）。中央の塔の確認済み・未確認の範囲。①への引き渡し。既存の結果が変わらないことの確認 | 16・17章、`sim/geo.mjs`、`sim/placement.mjs`、`results/placement/` |
| 4 | `4a359a03f7a0075bc063a2ff552b2bc71e02e4fb` | 2026-10-30 02:09 | 協力型の勝利条件の検査器と、仮の規則（CMP、TRD、COOP）での動作確認。①への必要入力 | 18・19章、`sim/coop.mjs`、`sim/coop-run.mjs`、`sim/coop.test.mjs`、`results/coop/` |
| 5 | この索引を含む commit（SHA は保存パッケージの `MANIFEST.ja.md`） | 2026-10-30 | 結論の範囲の固定と訂正（勝利条件と賞金の分離、二重計上の定義、配送と貢献、統計の説明）。①への接続の1枚。この索引。コードと結果は変えていない | 20〜22章、18・19章と README の注記 |

## 保存パッケージ

チャットに添付した保存パッケージ（`wylls-08-persistence-archive-*.tar.gz`）の中身と復元の手順は、パッケージの中の `RESTORE.ja.md` と `MANIFEST.ja.md` にあります。

- Git bundle は**基準 commit を前提にした thin bundle**です。復元には、`4cd901de9f8e0d6c0b2016851d30595c4a70aa46` を含むリポジトリ（`https://github.com/r0ze998/wylls`。PR #22 の統合候補のブランチ、またはその commit を持つクローン）が要ります。
- 基準 commit が手に入らない場合に備えて、パッチ（`git format-patch`）と、成果物のファイルそのもの（tar）も同梱しています。
