# 未知の記録と索引：隔離候補

対象はローカル候補。NFT JOIN の正式番号・版は決めず、PS2 kind に追加しない。索引・検証器の元データや既存 DB は変更していない。

## 検証器

`verify/src/world.rs` は PS2 v2 の厳密 decoder が読めない記録を `Problem` に記録し、`checks/v1_chains.rs` はそれを `Undecodable` の FAIL にする。旧 JOIN は同じ v2 decoder が V1 種別として読む。NFT JOIN 候補の `UntrustedJoin` は検証器に事実として取り込まれておらず、所有者の証明にもならない。今回新しい kind は定めていないため、新形式の所有権を検証できるようになったわけではない。

## 索引候補

従来の `index_one` は program frame のログ抽出の失敗や v2 decoder が読めない body を黙って飛ばして `last_seq` を進めた。新候補はどちらも error とし、SQLite のバッチを rollback する。既知の旧 JOIN は同じ v2 decoder で処理する。`records` も不明な kind の末尾を推測せず、v2 の厳密 decoder を使う。別 program の frame は従来どおり対象外。

archive/index 間に gap があると続行せず、index add/rebuild は連続 seq を要求する。再構築の削除・再投入は同じ SQLite transaction に入れ、途中失敗では旧 index を rollback により保つ。既存 schema 2 のまま以前の索引を信頼することを避けるため、古い `last_seq > 0` かつ strict marker が無い DB は拒否し、勝手に削除・再構築しない。別 index に archive から再構築する必要がある。元 DB は残す。

coordinator は追いつき確認前と書込前に blocked 状態を保存し、archive と index が同じ seq まで正常に処理された時だけ解除する。Reader の open とイベント読出しは blocked または不明なら error。これは対象 archive をこの decoder で連続処理したという局所的な状態であり、外部チェーン履歴が完全である、finalized である、または NFT の所有者が証明済みであることを意味しない。

## 未検証・注意

未知記録や破損記録が一件あると索引を止めるため、復旧・互換版が揃うまで herald の可用性に影響する。これまでの「不正な program-frame ログを飛ばす」挙動は意図的に変更している。blocked 状態を SQLite に保存できない障害、過去の未取得履歴、既存 reader との並行状態、archive の障害・再起動、厳密なリプレイ、他サービスの直接 SQLite 接続、複数 process を含む一連の動作は未検証。`Index::conn` / `Reader::conn` の直接利用は API の read gate を迂回できるので、実運用での完全な fail-closed と主張しない。DB 書込不全時は呼出側もエラーで停止する必要がある。

今回の test は固定バイトの旧 JOIN と未知形式を decoder で確認し、別々の test で索引に使う decoder が旧 JOIN を読み未知 kind を拒否すること、およびメモリ内 SQLite の blocked flag が不明/1 なら読出し拒否することを確認。いずれも test 名・setup を個別確認してから 1 件ずつ実行し、鍵生成・導出・署名・外部通信は使っていない。索引の実 archive ingestion、上記の transaction rollback、古い DB の移行・reader 並行は実行していない。既存 fixture の中には署名型や鍵の可能性があるため今回実行していない。
