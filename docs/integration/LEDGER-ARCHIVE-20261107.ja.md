# 台帳アーカイブ読取りの安全制限付き統合

## 対象

c94a5df7eefefb5d5199eb6c75045599d08ab872 を基点に、⑲ 7ab2b0b2 と⑳ 7d077fc677b4f70da4c89f6aaafc6bcfe84a9fe3 を通常mergeした。競合なし。広域Open実装87088006は別枝であり、この木には含めていない。

## 読めるようになったもの

- per-program archiveに元台帳のfeed_seq、開始位置、ledger IDを保存する。
- archive内seqと元台帳seqを区別し、共有取引の重複・順序・署名欄の整合を照合する。
- ResidentFeedを住民プログラムのarchiveから読み、元台帳seqへ戻す。
- これは署名の生成ではない。保存された署名欄の固定データの一致を調べる。

## 巻き戻り欠陥は未解決

A archiveがseq5を保存した後に同じrunIdのノードが巻き戻り、そのseqが両プログラムと無関係な取引に置換され、Bだけ同期した場合、古いAと新しいBの構造上の結合は矛盾を検出できない。Aを再開するまで気づかない。今回この欠陥を修復したとは扱わない。

安全上、上流のarchiveからLedgerFeedへの昇格をそのまま採用しなかった。

- 正常に元seqを復元できても read_archive は Unknown を返す。
- ResidentFeed::from_archive は完全な範囲を主張せずthrough 0。V28はその履歴から所有者の完全性を認めない。
- joinのJSONはwhole:false、構造上の整合だけarchive_consistentで表示する。
- Joined::whole() は上流互換の構造判定として残るが、完全性の根拠には使わない。既知の見逃しが起こる固定入力も試験に残した。
- 同期中のrollback継続監視、gapの永続化、共通の鮮度証明は今後の対策。live readや他のledger経路まで完全に解決したとは主張しない。

## 試験

鍵ペア生成・秘密鍵導出・署名なし。Address/Signatureは固定バイト、Transaction::new_unsigned、模擬HTTPノード。対象関数名を完全一致で指定した。

- findex/tests/ledger.rsの上流9件＋構造一致を完全性と誤表示しない追加1件: 10件通過。
- verify/tests/ledger_history.rs: 3件通過。archiveの番号復元とUnknown維持、情報不足、新しいledgerへの切替。
- verify/tests/resident_ledger.rs: 3件通過。archiveは不完全のまま、live経路と分けて確認。
- 計16件。安全制限で変更された文言・sourceの旧期待値は調整後に再実行した。
- cargo check --offline --workspace --all-targets通過。
- cargo clippy --offline -p verify -p findex --tests -- -D warnings通過（コンパイルのみ）。

既存verifier全体、署名付きE2E、実チェーンは今回実行していない。④31項目照合r4/r5は本体未受領で未統合。NFT賞金成功でもない。UI画面、V26/27/28の判定本体は変更していない。

[skip ci]付き保全枝のみ。main・公開・本番配備は変更しない。
