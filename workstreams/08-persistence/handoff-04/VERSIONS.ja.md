# ⑧の保存パッケージの版（④・⑯への引き渡し）

**最新の正本：v6**（`wylls-08-archive-v6.tar.gz`。この索引は v6 の中に入るため、v6 自身の SHA-256 は v6 に同梱の `.sha256` と引き渡しの報告に記載）。旧版（v1〜v5）は消さずに残します。v6 の継続世界の候補は、v4・v5 と同じ `e3d773df` です。v6 で増えたのは、試験の記録・試験の道具・文書の訂正だけです。push は配備設定の確認待ちで保留中のため、引き渡しはこのパッケージと固定の SHA で行います。

## 版の一覧

| 版 | ファイル | SHA-256 | 位置づけ |
|---|---|---|---|
| **v6（最新の正本）** | `wylls-08-archive-v6.tar.gz` | 同梱の `.sha256` を参照 | v5 の内容に加え、封印進軍の実ローカル試験、再送防止の候補の手数料の比較（`99b6c5fc`）、27章の訂正（Reveal の照合）と④への明示事項 |
| v5（旧版、保持） | `wylls-08-archive-v5.tar.gz` | `5ad98c218098616a483795a8c37787b7b89e19ac892f4de4fb31fec751227be6` | 継続世界の候補 `e3d773df`＋実ローカル試験（隊商2件・倉1件、キーパーの修正候補）＋27章（`ca67d40e`）。11ブランチ |
| v4（旧版、保持） | `wylls-08-archive-v4.tar.gz` | `78a2e4db581d5d31d8be568c66aa69f46dbfa31f512410b61213ca97720533ec` | 継続世界の候補 `e3d773df` までの10ブランチ。v5 と同じ候補を含む |
| v3（旧版、保持） | `wylls-08-archive-v3.tar.gz` | `87545f4ad6daaed3fa39aaae66dccd8360235d05e0a08b8d0ff56aac0e43b311` | 地図の配線（`c11b5c6c`）まで。継続世界は含まない |
| v2（旧版、保持） | `wylls-08-archive-v2.tar.gz` | `bb3dc595f9861457f9da0c6378a88bb9f53d8f2d34c7e5a710cb5fa1b4bedc99` | 地図の A・B・統合まで |
| v1（旧版、保持） | `wylls-08-persistence-archive-f0dd683d.tar.gz` | `c9177992b7b16dad638e773e2241e6570dbcf1e7d6412c67049c85d308d46a9a` | ⑧の文書（`f0dd683d`）まで |

- すべて thin bundle で、前提は基準 `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（tree `fb0635892650f4ae2b028ec488d14ddb75fe5eeb`）です。
- 各版の中の `SHA256SUMS`、`MANIFEST.ja.md`、`RESTORE.ja.md` を見てください。

## v5 の主なブランチ（完全な HEAD と tree）

| ブランチ | HEAD | tree | 役割 |
|---|---|---|---|
| `workstream/08-continuous` | `e3d773dfab450b5cbc4de9326e8c9e84e5c09cde` | `eef2a87301d57ad42293cf94cc6b2853fd147f4c` | **継続世界の候補**（④・⑯の検証の対象） |
| `workstream/08-map-live` | `c11b5c6c4a2f261f108997c2910cc4c09fab4303` | `8fcdca20ee8e9219c441caf71d40075be0c06f9b` | 地図拡張（候補の起点） |
| `workstream/08-cont-verify` | `b519cd18e203a75ec7921f01aef46b29f8f202ea` | `c084b2150e3cd7d0c397341ec0ecfc85b9770b24` | 試験の道具（`497af1b3`）、キーパーの修正候補（`5366f7c5`、未採用）、記録 |
| `workstream/08-persistence` | `ca67d40ec74d25b1c9691613380fa12bb0c9f1a4` | `023b7120c5872e690410160deafef9a07498fe45` | ⑧の文書（v5 の時点） |

v5 の作成後、`workstream/08-persistence` には④への明示事項（`0ed8328d`）とこの索引を足しています。どちらも次の版に入れます。

## パッチの適用順（v5）

1. **継続世界だけ：**
   - `workstream/08-map-live`（`c11b5c6c`、tree `8fcdca20…`）に、`patches/continuous-on-map-live.diff` を当てる。
   - 結果の tree が `eef2a873…` と一致することを確かめる。
2. **継続世界を含む全部：** 基準に `patches/continuous-all-on-base.diff` を当てる。
3. **試験の道具・修正候補・記録：** 候補 `e3d773df` に `patches/verify/*.patch` を `git am` で当てる。
   - 結果の tree が `c084b215…` と一致することを確かめる。
   - キーパーの修正候補（2つ目のパッチ）は未採用です。候補の本体には入れていません。
4. **commit ごとに当てる場合（継続世界）：** 次の順にします。
   - `7d01171a`
   - `68639777`、および `5e762e19` → `5e901dcd`（この2系統は互いに独立）
   - `90f20062` → `cbb1f21c` → `e3d773df`
