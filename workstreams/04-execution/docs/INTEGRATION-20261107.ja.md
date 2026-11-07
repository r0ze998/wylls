# 統合 2026-11-07（④、ローカル、push していない）

## 1. 順序

1. 3ad0bcdb（利用者の CC の統合候補。⑲ r2、⑪ 0011 を含む）
2. → ⑳ 552c1d14、9e9fe7af、030bf677、72d84173
3. → ⑲ 7ab2b0b2（利用者から受け取った bundle `ws19-ledger-on-72d84173`、SHA-256 `23dffcb5c2a5249922b88b3a592d36a7e604ab052dabcf67817b847cb1f8b0e9`、前提は 72d84173。照合済み）
4. → ⑳ 7d077fc6
5. ＋ ④ r4（57c5c171。31 項目の照合）＋ ④ の試験

**二重に当てていないもの**：⑲ r2（c022f4fc）と ⑪ 0011（3c6d2b6b）は、3ad0bcdb にすでにあります。もう一度は当てていません。

## 2. 履歴の試験の期待値の変更（⑲）を読んだ結果

- **変更**：`tests/history.rs` の 2 か所の assert。
  - 変更前：feed の cursor だけのアーカイブを `ledger_feed` とする。
  - 変更後：`unproven` とする。
- **判断**：期待値は厳しくなる方向にしか変わっていません（台帳の履歴として信用しない）。このため、不具合を隠す変更ではありません。
  - 台帳の履歴になるのは、`input::read_archive` が `findex::ledger::join` で欠けがないと確かめたアーカイブだけです。

## 3. 誤って PASS にならないことの確認（④ の独立した試験 `findex/tests/ws04_join_adversarial.rs`、7 件、鍵なし）

| 場合 | 結果 |
|---|---|
| 同じ runId のまま末尾が巻き戻り、もう片方のアーカイブが巻き戻り後の台帳を読んでいる | 「一つの番号に二つの取引」：whole にならない |
| 共有の取引の番号を、片方だけで動かす（5 通り）。または署名を変える（3 通り） | どれも whole にならない |
| 片方のアーカイブが短い | 短い方の cursor で切る。それより先は結合しない（beyond として数える） |
| 短い方が、自分の cursor より先の記録を持つ | whole にならない |
| 片方のアーカイブが何も読んでいない | 0 で切る。何も結合しない |
| runId が違う | whole にならない |

- **⑲ の試験で確かめていること**：再開のとき、アーカイブの最後の記録が同じ番号・同じ署名で node に残っていなければ、拒否します（`a_rewound_ledger_under_the_same_run_id_is_refused`）。

## 4. 見つかった限界（⑲・⑳ へ。修正は未着手）

- **どちらにも見えない巻き戻り**
  - **起きること**：A が番号 5 を記録した後、node が巻き戻ります。番号 5 には、どちらの program にも関係しない取引が付きます。B は巻き戻った後に読みます。
  - **結果**：`join` は whole=true を返し、A の古い番号 5 を含めてしまいます（④ が実行して確かめました）。
  - **気づける時点**：A を次に再開したときです。その前に、A のアーカイブだけで検証すると、node が今はもう持っていない取引を含んだ履歴を、`ledger_feed` として扱います。
  - ⑲ の module の注記には、この限界が書いてあります。
- **対策の案**
  - 検証で `--rpc` があるとき、各アーカイブの最後の記録が、同じ番号・同じ署名で node に残っているかを確かめる（再開のときと同じ確認）。
  - あわせて、`frontier_status` の `ledgerBytes` を記録し、前回より減っていないかを確かめる。
- **住民プログラムの判定が止まる範囲**：アーカイブの cursor は、その program 自身の最後の番号です。そのため、住民プログラムの最後の取引より後の行為は、UNVERIFIABLE のままです。台帳の先頭（tip）を記録するかどうかは、未決です。

## 5. 実行した試験（鍵ペアの生成なし、署名なし。PDA は計算する）

- **findex**：lib 10、ledger 9、ws04_join_adversarial 7、coverage 14、no_hidden_gap 4、open_items 5、store_failure 5、ingest 4（鍵を使わない 4 件だけを名前で選んだ）
- **verify**：lib 45、history 16、ledger_history 3、resident_ledger 3、new_bands 7
- **herald**：ingest_health 3
- **通しの場面**：固定ファイルの照合 31/31。この merge で、通しの場面のコードは変わっていません。

## 6. 実行していない試験

- **鍵を使うもの**
  - findex の ingest の 4 件（feed_and_rpc_poll…、rpc_poll_pages_the_local_node、enriched_poll の 2 件）
  - verify の tests/common を使う試験（record、tamper、coverage など）
  - LiteSVM と SBF
- **そのほか**
  - findex の `rpc_poll_against_a_live_node`
  - 住民プログラムを載せた、本物の frontier-localnet での実行
  - CI
