# NFT Citizen の Join 記録：隔離候補

対象は旧 `445585e...` と、その上で作った登録・認証・試験用収穫候補。これは 8 最新版や現在の統合候補に取り込まれたものではない。記録形式・kind 番号・ABI 版・市場方式を確定するものではない。

## 現行 Join と検証

- `permutation-frontier/src/proc/citizen.rs` の Join は財布を元に tag15、Season 配下 Citizen、JoinShard を決め、`JOIN` に財布・国・shard・session・期限を記録する。Citizen の WALLET は以降の正本アドレス検証と認証の双方に使われる。
- `frontier-abi/src/log.rs` の `JOIN` は key 15 B、payload 74 B。`chains_of` はこの tag15 から既存方式の Citizen を解決する。SESSION・VIGIL・TICKET 等も tag15 に依存する。
- `verify/src/facts.rs` は JOIN の tag15 を既存の `citizen_by_tag15` に変換して `citizens`、`by_tag8` を構築し、TICKET も同じ変換を使う。`checks/v1_chains.rs`、`checks/v11_land.rs`、`checks/v12_explore.rs` にも依存がある。現行 JOIN に NFT のアドレスを財布として入れることは、生成された Citizen と記録から復元する Citizen が異なるため不可。
- `verify/src/world.rs` は未知または不正な PS2 記録を問題として記録する。`findex` の `fclient::log::decode_with` は未知 kind の長さを持たない場合、tail を推測できる場合と拒否する場合がある。旧ツールが新しい記録を完全に理解するとは扱わない。

## 候補と安全境界

`frontier-abi/src/resident_join_candidate.rs` は、asset、Citizen、binding、resident、Join 時の owner、generation、faction、shard、session、expiry の固定長サンプルのみを、既存 PS2 と別の形式で読み書きする。旧 JOIN の kind・key・payload・ログ版は変更しない。候補 payload 214 B は既存の soft ceiling 128 B を超え、採用にはログ上限と費用の確認も必要。PS2 の event 番号や新たな protocol 版は割り当てていない。

デコード結果は **未検証の申告**。Join 時の owner は過去の事実であり、後の現在所有者として使わない。検証器で確定するには少なくとも、対象実行が成功し正しい program の命令・口座一覧を使ったこと、信頼した policy と program owner、対応・Citizen・resident の正本アドレス、一意性、該当時点の asset/resident/世代と署名者、記録と実行・post-state とチェーン尾部、十分な履歴・finality を照合する必要がある。証拠がない場合は未確認またはエラーとし、推測で PASS にしない。取引の post-state や asset の状態を得られない経路では照合できる範囲を限定する。

対応案としては、新しい識別済み Join 記録と後続の session/ticket 等の NFT Citizen 参照を導入し、indexer・verifier を先に対応させる。旧 Join は旧条件のまま解析する。新旧ログの順序・チェーン・重複・欠落を検証し、未知の新形式は旧検証器が成功と誤認しないようにする。単に旧 `JOIN` と偽装して `wallet` に asset を詰める案は、既存アドレスや signer の意味と矛盾するので採らない。

必要な残作業: 一意の Citizen の実作成、署名された世代と runtime account 検証、全 P 命令と client/relay、代替の正本アドレスの解決、記録番号と版の統合調整、findex の未知形式の扱い、V1/V11/V12 ほかの replay/事実の更新、旧史と混在時の検証、NFT transfer の迂回不能性、性能・SBF・runtime 試験、独立レビュー。市場方式、既存データ移行、個人情報や資金の引継ぎは決定していない。ログ読取だけで過去の署名や未取得履歴の完全性を保証できない。

## 今回の検証

固定バイトだけの候補 roundtrip、長さ・marker・faction/shard 不正拒否、および旧 JOIN の独立したエンコード・デコードと相互の誤認拒否を、対象名と setup を確認し単一の unit test として実行。鍵生成・導出・署名・PDA 実行・ネットワークは含まない。これは codec の確認であり、program、チェーン、ログ証拠または実 Citizen の試験ではない。
