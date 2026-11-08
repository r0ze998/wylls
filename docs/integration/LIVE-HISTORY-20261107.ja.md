# Live履歴も完全性未確認として扱う

c7b3c54cを基準に、fetch_txsのlocalnet経路をUnknownへ統一した。前後のrunId一致、ledgerBytes非縮小だけでは、その間の全feed取得と同じsnapshotを保証しない。保存archiveとliveを同じ安全基準にした。

取得した取引、個別のFAIL所見は保存する。既存のself_contained規則は変更せず、その規則で確定するFAILは全体でもFAILのまま。それ以外はUNVERIFIABLEで、PASSにはしない。ResidentFeedもUnknownを受け取り、所有者履歴を完全として扱わない。

4のscan実装は未取得・未統合。この変更はatomic snapshot実装ではなく安全制限。実ノード、実チェーン、署名、鍵生成を使う試験は行わない。固定バイトとunsigned取引を返すHTTP模擬ノードで検査する。

検証結果：ledger_history 7件、resident_ledger 3件を関数名指定で実行し全件通過。verifyのtests対象clippyも通過。V0・V27の自己完結FAILを維持し、前後サイズ一致と増加の両方でUnknownになることを確認した。

## 追記（⑲、2026-11-08）

④ の scan を統合した後の扱いです。ライブの読取りは `ledger_feed` として扱い、確かめられなかったことを名前付きの欠け（`prefix_identity_unverified`、`point_in_time_unverified`）として持ちます。欠けがあるうちは unproven で、PASS にはなりません。

欠けが消えるのは、次の両方が成り立つときだけです。

1. **前半の同一性**：すべての読取りが scan で返り、毎回、同じ runId のままでは巻き戻りえない台帳だった（`durable`、またはメモリだけの台帳で `ledgerBytes` が 0）。
2. **時点**：最終状態を読んだ後の `frontier_status` で、runId・台帳の長さ・台帳のサイズが、読取りを終えた時点と同じ（`seal_point_in_time`）。

この 2 つがそろえば、読取りの最中に巻き戻りは起きず、読取りを終えてから最終状態を読み終えるまでに台帳へ何も加わっていません。そのため、1 回でまとめて読んだ（atomic snapshot）のと同じになります。

アーカイブは、台帳の前半の要約が無いので、`prefix_identity_unverified` が残り、PASS にはなりません（`docs/frontier/history-coverage.ja.md` §8）。
