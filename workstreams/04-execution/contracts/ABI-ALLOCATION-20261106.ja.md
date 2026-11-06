# 共有 ABI の番号の割当（④、2026-11-06、**仮**）

統合の担当（④）が、命令 tag・記録の kind・Citizen の予約領域を、担当どうしで重ならないように割り当てる。**仮の割当**で、統合候補に入るときに確定し、`contracts/registry.txt`（`e2e-native/tests/registry.rs` が生成）とエラー番号の照合（`error_codes.rs`）で検査する。番号を使うコードは、確定まで各担当の feature（例：⑳の `nft-experimental`）の内側に置く。

基準：統合候補 `ef63544c727490fc6801d30affd11c5b7106c480`。

## 1. 命令 tag（v2、`frontier-abi/src/v2/tags.rs`）

使用中：0x01–0x09、0x10–0x15、0x20–0x24、0x30–0x38、0x40–0x48、0x50–0x55、0x60–0x66、0x70、0xA0–0xA8、0xAF、0xB0–0xBF、0xC0（FastForward）。

| 帯 | 担当 | 内容 | 状態 |
|---|---|---|---|
| 0xC1 | ⑧ | ExtendFrontier | ⑧の branch（`b519cd18`）で使用中。そのまま |
| 0xC2–0xCF | ⑩ | 保管（custody）の命令。⑩ の仮 0xC1–0xCB（11 個）は 0xC2–0xCC へ 1 つずらす | 仮 |
| 0xD0–0xDF | ⑨ | 能力（capacity）の命令。⑨ の仮 0xC1–0xCE（14 個、取り下げ済み）は 0xD0–0xDD へ | 仮 |
| 0xE0–0xE7 | ⑳ | NFT 住民：0xE0 CreateResidentPolicy、0xE1 JoinResident、0xE2 ResidentAct、0xE3–0xE7 予備 | 仮 |
| 0xE8–0xFE | — | 未割当（申し出の順に④が割り当てる） | — |
| 0xFF | 試験だけ | 本番の program では使わない | — |

注意：⑪の検証器の試験は「知らない tag」として 0xD4 を使っている（`11-extensions/patches/0001…`）。⑨の帯に入るので、0xFE に替える（0xFE は割り当てない）。

## 2. 記録の kind（**訂正 2026-11-06**：初版は v1 の表しか数えず、v2 の表と重なる 90–94 を⑳に割り当てていた。⑳の指摘で直した）

記録の kind は二つの表を合わせた一つの番号空間（`frontier-abi/src/log.rs` の v1 と、`frontier-abi/src/v2/log.rs` の `cq_kinds!`）。program 側の上限は `permutation-frontier/src/events.rs` の `MAX_KIND_V2`（今 103）と `WIDTHS_V2`。

使用中：v1 は 1–17、20–28、30–32、34、40–43、50–53、60–62、70。v2 は 80–88（SIEGE_DECLARED … OUTPOST_SETTLED）、89（RESERVED_KIND）、90–94（VAULT_BUILT、CARAVAN_SENT・SETTLED・RAIDED、VAULT_SEIZED）、95–102（STRUCTURE_*・NATION_*・RAID_OPENED・FORT_GARRISONED）、103（REST）。

| kind | 担当 | 内容 | 状態 |
|---|---|---|---|
| 104 | ⑧ | FRONTIER_EXTENDED（⑧の branch `b519cd18` で使用中） | そのまま |
| 105–109 | ⑩ | 保管の記録。⑩ の仮 104 は⑧と衝突するので 105 から | 仮 |
| 110–124 | S2（stage 2e、`ccr-184d6862-fqutoz`、未統合） | その branch の 103–115 は main の REST=103 と衝突している。使う場合は 110–122 に移す。それまで予約 | 予約 |
| 125–129 | ⑨ | 能力の記録が要る場合 | 仮 |
| 130 | ⑳ | RESIDENT_JOINED：key＝住民 ID（15 B）、payload＝asset 32・faction 1・shard 1・generation 4・join_bell 4（42 B） | 仮 |
| 131–134 | ⑳ | 予備 | 仮 |

- 新しい kind を出すときは、`MAX_KIND_V2` と `WIDTHS_V2` を広げる（同じ変更で）。
- `VERSION` は上げない。ただし今の `decode` は知らない kind を `UnknownKind` で拒否するので、program と読み手（keeper・herald・検証器・fclient）は同じ変更で更新する。
- 本文の上限（`SOFT_BODY_MAX = 128`）：kind 130 は link 無しで 64 B。
- 照合の道具が要る：命令 tag と記録の kind の重なりを検査する試験を、エラー番号の照合（`e2e-native/tests/error_codes.rs`）と同じ形で足す（④の残件）。

## 3. Citizen の予約領域（`frontier-abi/src/v2/layout/player.rs` の `citizen`）

`RSV_348 @ 348`（36 B）を⑳に割り当てる（他の担当の要求は無いことを確認した）：

| 欄 | 位置 | 長さ | 内容 |
|---|---|---|---|
| RESIDENT_ASSET | 348 | 32 | NFT の asset |
| RESIDENT_FLAGS | 380 | 1 | bit0＝NFT Citizen |
| RSV_381 | 381 | 3 | 予約 |

layout の版（`LAYOUT_VERSION = 2`）は変えない（予約領域の中で、0 が今の意味と同じなので）。

## 4. 版

- 命令を足すので **program の版**（Season の `PROGRAM_VERSION`）は上げる。値は統合のときに④が決める。feature の内側の試験 build は別の値にし、本番の値と混ぜない。
- **ruleset の hash** は kernel の版の表から作るので、命令 tag や記録の kind では変わらない。規則（kernel）を変える場合だけ変わる。

## 5. ⑳の案への④の意見（番号以外）

- **WALLET＝全 0 のとき、財布から作る住所と記録の key を使わない。** `sha256("PSF-CIT" ‖ wallet)` は全 0 の財布で全員同じになり、NFT Citizen どうしの口座と記録の key が衝突する。NFT Citizen の口座の住所と、その Citizen の記録（VIGIL・TICKET・OUTPOST など）の key は、住民 ID（`PSF-RES`）から作る。前置きが違うので、財布から作る key とは重ならない。
- 財布・session の判定が全 0 の WALLET で拒否側に倒れるのは安全側でよい。ただし、拒否に頼る箇所と、住民 ID に置き換える箇所を、⑳の洗い出しの一覧で分けて示してほしい（④の executor・acts の `agentId` も影響を受ける）。
