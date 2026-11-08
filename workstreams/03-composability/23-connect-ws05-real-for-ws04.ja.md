# 23 ⑤の共有中継（実物）との接続と、④への一つの接続差分（③：MCP）

作業日 2026-11-08。branch `claude/modest-goldberg-c180fk`（GitHub、`[skip ci]` 付きで push）。

## 0. 使った版（取得先）

| 担当 | 版 | 取得先 |
|---|---|---|
| ⑤ 本体 | `10e749677d96301766c2930a8f903baf28cce0bc`（親 `9a4051c79de6c5fba3c86bd515c67f3ec311b5ab`。09cd4aab を祖先に含む） | GitHub `claude/ai-participation-provider-budget` |
| ⑤ 共有コア | `e29ec011f99761594c59a6e4b0c4681c5938d443`。④ `6984acfa` ＋⑤ 0002c・0003・0004b・0005・0006・0007。`permutation-gateway` の木は `477c5685ad2390c2b8a627936187f8f546423a0e` | GitHub `claude/ai-participation-shared-on-ws04-6984acfa` |
| ④ 最新候補 | `cf517b558d1303a84dba618550f40cb460b7ad99`（tree `75b67dc4f929527deaf885ae8858325e0b23b482`） | GitHub `claude/gallant-ride-cunptv` |
| ⑥ | `59bc9565552d9f048b0fe0a8e14ab8f8a611ca0c`（⑥の連絡による。③は⑥の試験を実行していない） | GitHub `claude/wylls-creation-publishing-reuse-31aiyj` |

**共有中継の正本は⑤である。** ③の 0008・0008b（`patches/0008-*.patch`、`patches/0008b-*.patch`）は**取り下げ**、参考として残す。④に当てる物ではない。

## 1. ④への一つの接続差分

| 段 | 中身 | 担当 |
|---|---|---|
| 1 | ④ `cf517b55` に、⑤の `workstreams/05-ai-participation/patches/on-ws04-6984acfa/*.patch`（6 件）を `git am`。古い `6984acfa` の木を上書きしない | ⑤（正本） |
| 2 | ③の `workstreams/03-composability/` を、③の branch の commit から足す（`git checkout <③の commit> -- workstreams/03-composability`）。③の外は触らない | ③ |

**段 1 の確認：**

- 6 件すべて、衝突なしで当たる。
- `permutation-gateway/src/frontier/agent`、`permutation-gateway/mcp`、`routes/agent.mjs` の木は、⑤の `e29ec011` と同じ。
- 変わるファイルの集合も、⑤の branch（`6984acfa..e29ec011`）と同じ（12 件）。
- ④が 6984acfa の後に変えた所（run の受付、地図の試験など）は、そのまま残る。

結果の木の SHA と、その上での試験は §3。

## 2. MCP の確認（⑤の実物の上で）

③の鍵を使わない試験は、`WS03_GATEWAY_ROOT` を⑤の共有コアの木にして実行した。財布の `AgentGateway` は⑤の実物で、次の部分は⑤のコードがそのまま動く：

- 送り手ごとの token の発行・更新・撤回（`rotateCapability`／`revokeCapability`）
- 送り手との結び付き
- `whoami`（`capabilitySource`。一般の token は `'any'`）
- 見え方（`senderCapabilities`）

| 確かめたこと | 結果 |
|---|---|
| 同意 | ⑤の見え方の `senderCapabilities` を見て、`rotate-capability {source: 'mcp'}` を送る。答えの `capability.source` が `mcp` の時だけ封印して持つ |
| token の分離 | ③の token は ai として送れない。⑤の token は mcp として送れない（⑤の照合が拒否する） |
| 更新 | ③の再接続で、古い③の token は⑤の relay で `BadCapability` になる。⑤の ai の token は止まらず、更新の前にも後にも送れる |
| 撤回 | ③が写しを捨てただけでは、relay では有効のまま。本人の `revoke-capability {mcp}` の後は拒否され、`senderCapabilities` から `mcp` が消える |
| 古い relay | 書き込みの接続を作らず、何も送らない |
| Duplicate | ⑤の形（`failed`、`sent: null`、`duplicateOf`）を、③は保留し、再送しない。③自身の別の操作の署名なら、1 回として数える。**⑤の実物の Duplicate の経路は、署名の後で起きるので、③の試験からは通していない**（台本）。⑤の財布の試験 `agent-wallet-citizen-lane` などで確かめた |
| 送信待ちの要求が、撤回・更新の後に送られない（⑤ 0007） | ⑤の財布の試験 `agent-wallet-revoke-transfer` で確かめた（③の試験からは通せない：署名の後の段） |

## 3. 試験（鍵ペアの生成・導出・署名なし。呼び出し先を確かめた物だけ）

**ガード：** 3 つを使った。

- ⑤の `no-keys-guard.mjs`（`NODE_OPTIONS`。子プロセスにも効く）
- ④の `scripts/ci/no-keys-guard.mjs`
- ③の `no-pda-guard.mjs`

PDA の計算は今回から許されているが、③の試験は固定の定数で動き、PDA も使わない。

| 試験 | 木 | 結果 |
|---|---|---|
| ③ `run-guarded.sh`（24 件） | 財布＝⑤ `e29ec011`。④ `cf517b55` の runexec と client。⑤ `10e74967` の port | 24/24 を 2 回 |
| ⑤の財布の試験（`agent-wallet-revoke-transfer`、`citizen-lane`、`sender-capability`、`run-facts`） | ⑤ `e29ec011` | 13/13（⑤の記録と同じ） |
| ⑤ model-api（⑤の handoff の 11 ファイル） | ⑤ `10e74967`。④ `cf517b55` の runexec と client | 60/60（⑤の記録と同じ） |
| ④ `cargo test --test acts --test act_cli` | ④ `cf517b55` | 12/12 |
| 一つの接続差分の木での③と⑤の試験 | §1 の木 | §3.1 |

### 3.1 一つの接続差分の木

この節は、木を作った後に足す（下の追記）。

## 4. ⑥との調整（⑥の連絡への答え）

| ⑥の問い | ③の答え |
|---|---|
| `PlanUnknown/PlanUsed/PlanExpired/PlanStale` は、その requestId で何も送っていない時だけか | `PlanUnknown`・`PlanExpired`・`PlanStale` は、その requestId の操作が無い時だけ返る（`store.operation(opId)` の確認が先）。同じ requestId と runId で計画を作り直してよい。**`PlanUsed` は違う。** その計画は別の requestId の操作がもう送った（答えに `operationId`）。作り直すと 2 回目の送信になりうるので、⑥は保留すること |
| idempotencyKey `ws03:<linkId>:<requestId>` は固定か | 形は固定。ただし linkId は接続ごとに変わる。**再接続の後の同じ requestId は、③が `RequestIdUsedOnAnotherConnection` で拒否する**（今回足した。前の操作を名指しし、何も送らない）。⑥は末尾の `:<requestId>` で引いてよい |
| ⑥の形の runId と requestId で試験を回せるか | 回した。`keyfree/run.test.mjs` は⑥の形（`ws06:<64桁>:<依頼>:<手順>`、`ws06.<48桁>`）で動く。⑥の読み方（`registry.acts` の source `mcp`、key の末尾）も試験に入れた |

**今回の変更：**

- `get_run_status` は、④の list で未確定の行を、④の status で読み直す（読むだけ、50 件まで）。どの接続から聞いても同じ状態になる。

## 5. 未確認と残件

| # | 項目 | 担当 |
|---|---|---|
| U1 | ⑤の実物の Duplicate と、送信待ちの要求の再確認を、③の MCP の経路から通すこと。署名の後の段なので、鍵を使わない試験では通せない | — |
| U2 | 実チェーン、実アカウント、本人の wallet の署名を伴う段（同意、取消の文、所有者の照会） | — |
| U3 | ⑥の実装（③は⑥の試験を実行していない） | ⑥ |
| R1 | 結果不明をいつまで待つか。NFT の譲渡で旧い持ち主の relay の token も無効にするか（ゲームの規則。③は決めない） | ④⑤⑳ |
| R2 | 間欠的な失敗（22 §3）の原因 | ③④ |
