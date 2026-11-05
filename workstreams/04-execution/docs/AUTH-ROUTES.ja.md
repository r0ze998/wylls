# 認可と送信経路の統合案（④、2026-10-31）

**提案である。** 共有コードには当てていない。権限の拡大や本番の鍵の設定もしない。根拠は統合ブランチの実物（③0005・⑤0001 を当てた gateway）と、⑤の CONTRACT-DIFF-4 §2〜3、④の INTEGRATION-20261030 の G-1〜G-4 である。

二つの問題を分けて扱う。

- **A. capability の共存**：誰が代理として書けるかと、その取り消し。
- **B. 直列化**：一つの Citizen について、署名・seq・予算が同時に二つ進まないこと。

A を解いても B は解けない。逆も同じである。

## 1. 今の経路

| 経路 | 署名する者 | 鍵 | 直列化 |
|---|---|---|---|
| R1 代理の財布 gateway（⑤の自動運転、④の GatewayPort） | gateway | relay の keyring の session key | gateway の hold（予算）は同期処理。seq は build の時に読む |
| R2 ③の MCP（本人の会話） | 同じ gateway（R1） | 同じ session key | R1 と同じ |
| R3 ④の実行器が直接署名する（P5 `prepare`） | ④ | session key を④が持つ | ④の store の `sole_owner_send` だけ。R1・R2 は見えない |
| R4 本人の wallet | 本人 | wallet | なし（本人の操作） |

**今の衝突（実物で確認済み）**：

- 代理一つに capability は一つである。③が回すと⑤の token が `BadCapability` になる（⑤ §2.1）。
- R3 と R1・R2 が同じ Citizen の seq を取り合う。④の `sole_owner_send` は④の store の中だけの条件である（⑤ §3）。
- 中身が同じ SendCaravan を 0002b が別の fee payer で作り直すと、手数料が二重にかかりうる（RECONCILE-20261030c §5.6）。

## 2. A：capability の共存

| 案 | 内容 | 評価 |
|---|---|---|
| A1 送り手ごとの capability | 代理一つに、`source`（`mcp`／`ai`／`ws04` など）ごとの token を持たせる。別々に発行・取り消しでき、記録の `source` に結び付ける | **推奨**。本人の同意を送り手ごとに出し、取り消しも送り手ごとにできる。⑤の提案と同じ |
| A2 一つの token を共有する | 全員が同じ token を使う | 不可。一人を止めると全員が止まり、誰が送ったかを区別できない |
| A3 送り手ごとに別の代理 | 代理を分ける | 不可。Citizen の session key は一つ（⑤ §2.1） |

## 3. B：署名・seq・予算の直列化

| 案 | 内容 | 評価 |
|---|---|---|
| B1 gateway を session key の唯一の署名者にする | ④の実行器も gateway の client になる（GatewayPort は実装済み）。gateway は Citizen ごとに一列で build・送信する。seq を持つ命令（SendCaravan）は、その列の中で `Citizen.CARAVANS` を読む | **推奨**。予算の hold と seq の読み取りが同じ列に入る。鍵が一か所に留まる |
| B2 ④が直接署名し、gateway の履歴で他の送り手を検出する | R3 のまま | 検出は事後になる。二重の手数料と seq の取り合いは防げない |
| B3 program の seq の検査だけに頼る | — | ゲームの効果は一度までで守られる。手数料・予算・失敗の記録は守られない |

## 4. 推奨（A1＋B1）の変更範囲

| 場所 | 変更 | 担当 |
|---|---|---|
| `permutation-gateway/src/frontier/agent/{contract,gateway,ledger}.mjs` | 送り手ごとの capability（A1）。Citizen ごとの直列の列（B1）。結果に `lastValidBlockHeight`／`slotFloor`（G-1）を返す。署名の後に失敗したときも署名を返す（G-2）。key ごとの結果を読む口（G-3） | ⑤・共有コア（④が統合） |
| 同 `gateway.mjs` の 0002b | seq を持つ命令は作り直しから外す | ⑤ |
| `permutation-gateway/mcp/agent-mcp.mjs` | `source` を送り手ごとの capability に結び付ける（⑤ 0003 の続き） | ③⑤ |
| `workstreams/04-execution/src/gateway.rs` | `valid_until` を G-1 の値から取る。G-3 で結果を引く | ④ |
| ④の P5（直接署名） | 使わない（R3 を廃止） | ④ |

**変えないこと**：session key と capability の有効期限、予算の上限は、世界が続いても永久化しない（⑤の方針）。

## 5. 継続世界との関係

今の session、invite、署名文、鍵の保存名は season id を含む（`fsession.mjs:25-30` など、CONTINUITY §1）。世界を続けるなら、この id は「世界の id」として固定し、二度と変えない。戦期の番号は別の欄にし、認可の識別子には入れない。
