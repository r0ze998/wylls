# MagicBlock ER 接続候補と公開 RPC の追従（⑲）：索引

2026-10-31。基点は `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`。枝は `claude/ecstatic-cannon-d0jfc4` で、push・merge・配備はしていません。

**状態：候補・未採用。** 決定 O8（Season 1 は Solana 本体のみ）と「no MagicBlock」の現行プログラムは、どちらもそのままです。公開 devnet では何も実行していません。統合は④、独立検証は⑯です。

## 要点（継続世界の方針訂正に合わせた 4 項目）

1. **残っていたシーズン依存**
   - 旧版の委任は「シーズンに 1 回だけ委任、終わりに解除、脱出は期限の後」でした。
   - findex と herald はアドレス文脈を 1 つの Season ID に結び付けています。
   - 検証器は「静かな終わり」の最終状態を前提にしています。
   - findex のアーカイブは際限なく増えます。
   - 公開 RPC は取引の版 0 しか取りません。
   - 詳細は [CONTINUING-WORLD.ja.md](CONTINUING-WORLD.ja.md) §1。
2. **変更した挙動**
   - 委任セッションを期間から切り離しました。閉じるのは commit の予算・検証者の交代・保守のときだけで、再委任でも一本の版の鎖が続きます。
   - 書込みは `(seq, head)` の compare-and-set です。同じ要求は二度効かず、失われた版の上にも効きません。
   - ER が書込みを失ったら止めます（high-water）。
   - findex は、公開 RPC の履歴欠落で止まり、黙って保存しなくなりました。minContextSlot の読取りには印を付けられます。
3. **試験で確認したこと**：mock、ローカル（LiteSVM＋実物の委任プログラム 3 種、ローカルの base＋MagicBlock ER で 2 回）、findex。公開 devnet は未実行です。[RESULTS.ja.md](RESULTS.ja.md)。
4. **移行や仕様判断が残る点**：[CONTINUING-WORLD.ja.md](CONTINUING-WORLD.ja.md) §4。

## 文書

| 文書 | 内容 |
|---|---|
| [DESIGN.ja.md](DESIGN.ja.md) | S1 で何を速くし、何を L1 に残すか（口座ごとの表）。信頼境界。書込主体・確定性・使えなくなった場合 |
| [RECOVERY.ja.md](RECOVERY.ja.md) | 障害ごとの判断と手順。脱出。keeper・herald・検証器が参照するもの。公開 RPC の取得と復旧 |
| [RESULTS.ja.md](RESULTS.ja.md) | mock・ローカル・公開 devnet（未実行）を分けた結果 |
| [OPERATIONS.ja.md](OPERATIONS.ja.md) | 必要な運用設定。再現手順。devnet で試すための承認依頼 |
| [CONTINUING-WORLD.ja.md](CONTINUING-WORLD.ja.md) | 継続世界：依存・変更・試験・残る判断 |
| [DIFF-UNKNOWNS.ja.md](DIFF-UNKNOWNS.ja.md) | 旧版との差。未確認事項。文書とコードの食い違い（すべて） |
| [PACKAGE.ja.md](PACKAGE.ja.md) | 保存パッケージ（commit と SHA-256） |
| `results/` | ローカルの実行記録（JSONL）。findex の live 試験の出力 |

## コード（独立したパッチ。統合は④）

| パッチ | 場所 | 依存 | 既存への影響 |
|---|---|---|---|
| A. findex | `frontier-node/crates/findex/`（ingest.rs・provenance.rs・lib.rs・index.rs の doc、tests/ingest.rs） | なし | RpcPoll が履歴欠落で失敗するようになる（正しい挙動への変更）。provenance は追加だけ |
| B. 候補の crate 群 | `frontier-er/`（モデル・調停器・計画器、`program/` の板のプログラム、`svm-tests/` の LiteSVM の試験・ローカルの一巡・履歴の調査） | 単独の workspace。ルートの workspace と lock には入れていない | なし |
| C. 文書 | `docs/frontier/er-candidate/` | なし | なし |

命令番号・口座の magic・版・エラー番号は、この候補の中だけの仮のものです。④の登録表では確定させていません。
