# 現行対応表：代理AIが今できること・できないこと

調べた対象：共通基準 commit `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（PR #22 の統合候補の途中。main 統合済みではなく、CI 全成功でもない）。表の「根拠」はこの commit のファイルと行です。

記号：**○** 今のコードで動く（テストあり）／**△** 一部だけ、または条件つき／**×** ない。

## 1. MCP の道具（`permutation-gateway/mcp/agent-mcp.mjs`）

| 道具 | 状態 | 中身 | 根拠 |
|---|---|---|---|
| `agent_view` | ○ | 中継の見え方（`GET /f/agent?id=`）。mode、`policy.version`、`modeEpoch`、許可した行動、予算、残高、履歴、鎖上の委任（`delegation`）、今日の取引枠（`quota`） | `agent-mcp.mjs:36`、`routes/agent.mjs:57-68` |
| `agent_terms` | ○ | 推論の単価（試験値 10,000 = 0.01 テストUSDC）、ゲームの価格表（空）、手数料は中継が払う | `agent-mcp.mjs:41` |
| `agent_act` | ○ | 行動を1つ頼む。`requestId`・`policyVersion`・`modeEpoch` が必須。村は view から読み、呼び手には選ばせない | `agent-mcp.mjs:46`、`:126` |
| `world_read` | △ | `season` と `province`（p, q）の2つだけ。隊商（`h/caravans.json`）、建物（`h/structures.json`）、国（`h/nations.json`）、自分の村の状態は読めない | `agent-mcp.mjs:63`、`:141` |
| 行動の結果（着地） | × | `GET /f/tx/{signature}` は中継にあるが、MCP の道具ではない。MCP だけのAIは、送った行動が着地したか確かめられない | `routes/season.mjs:45-60` |
| 持ち主の命令（作成・方針・停止・出金・トークン再発行） | ×（意図どおり） | 道具にない。持ち主の財布の署名だけ | `agent-mcp.mjs` の TOOLS、`test/agent-wallet-mcp.test.mjs` |

**この作業で見つけたこと：** `agent_view` は公開の読み取りで、接続トークンを確かめません（`GET /f/agent?id=` は agent id だけで読める）。そのため、持ち主がトークンを取り替えた後も、古いトークンの代理は view を読んで計画を立て、`agent_act` で初めて `BadCapability` で断られます。何も送られず、何も請求されません。ただし、モデルに判断させる代理なら、断られる前にモデルの料金を払ってしまいます（`test/participation.test.mjs` の「stopped or revoked」で再現）。

## 2. 行動の許可リスト

| 行動 | 代理に任せられるか | 代理の経路で送れるか | 根拠 |
|---|---|---|---|
| Harvest, Build, Train, Muster, Garrison（economy） | ○ 方針で許せば | ○ | `contract.mjs:30`、`gateway.mjs:67-80` |
| Explore（explore） | ○ | ○ | 同上 |
| Depart, Dissolve（military） | ○ 方針で許せば | ○ ただし運営の runner は進軍を選ばない（候補にない） | 同上、`runner.mjs:268` |
| SetVigil（vigil） | ○ | ○ | 同上 |
| Join, SetSession, PlaceHome, FileTicket, FileOutpost, DeclareSiege, RetireHost | × 方針に何と書いても任せられない | × | `contract.mjs:44` |
| **SendCaravan（隊商）** | × 許可リストにない | × `accountsFor` が知らない。さらに**他のプレイヤーの村・倉へ送るには財布の署名が要る**（鎖が `WalletRequired` で断る）。代理の鍵（session key）では送れない | `gateway.mjs:79`、`permutation-frontier/src/proc/caravan.rs:22`、`:727-729` |
| **Vote, Propose（国の投票）** | × 許可リストにない。**決定：代理に投票は任せない**（2026-10-23、29 の E2） | × | `docs/design/redesign/29-remaining-decisions.ja.md:48`、`99-decisions.ja.md` |
| BuildVault, BuildStructure, FortGarrison, RaidCaravan など S1 の命令 | × | × | `gateway.mjs:67-80` |
| **施設の利用（使用権の札）** | × プログラムに命令がない。試遊甲では紙の札と台帳で手動 | × | `docs/frontier/playtest-kou/HAND-RULES.ja.md` |
| 共同作戦への参加登録、国の依頼板 | × どこにもない（プログラム・herald・中継のいずれにも） | × | — |

まとめ：**隊商・投票・施設の利用は、今の代理の経路では動きません。** この作業のデモでも、動くものとしては扱っていません（理由と本人の判断を返すだけ）。

## 3. 実行の仕組み（runner・予算・停止・権限版・重複防止）

| 項目 | 状態 | 中身 | 根拠 |
|---|---|---|---|
| 確認の順番 | ○ | 資格 → 重複 → mode → 方針の版・mode の版 → 許可 → 自分の村 → 予算の確保 → 鎖上の委任 → 取引の組み立てと署名 → 中継の形・枠・模擬実行 → 送る直前にもう一度 mode と版 | `gateway.mjs:374-475` |
| 予算 | ○ | テストUSDC。`total`・`perDay`・`callsPerDay`（モデルを呼ぶ回数）。モデル1回 0.01（試験値）、規則の autopilot は無料。ゲームの価格表は空 | `policy.mjs`、`ledger.mjs:175-177`、`gateway.mjs:512` |
| **資源の上限** | × | 方針は USDC と行動の種類だけ。「食料は1日300まで」「兵は1件200まで」は書けない | `policy.mjs` |
| **期限** | △ | 鎖上の委任の期限（`SESSION_EXPIRY`）だけ。方針そのもの・一つの依頼への協力に期限はない | `gateway.mjs:481` |
| 停止 | ○ | 持ち主の `mode manual`。新しい依頼はすぐ断る。送った物は戻さない。鎖の上で取り消すのは持ち主の `SetSession` | DESIGN.md §0、§5.1 |
| 権限版 | ○ | `policyVersion`（方針を変えるたびに増える）と `modeEpoch`（停止・再開のたびに増える）。古い版の依頼は `StalePolicy`・`StaleMode` | `gateway.mjs:410-416`、`:444-448` |
| 重複防止 | ○ | 冪等キー。同じキー・同じ内容なら記録した結果を `replayed: true` で返し、二度送らない。同じキーで違う内容は `IdempotencyConflict`。MCP は `mcp:<requestId>` | `gateway.mjs:374-394`、`agent-mcp.mjs:123` |
| 運営の runner | △ | 中継の中で動く。観測は herald の公開記録、引き金（持ち主・結果・出来事・ターン）、間隔・回数の上限。候補は Harvest・Train・Build・SetVigil だけ。**国の依頼は読まない** | `runner.mjs:195`、`:268`、`:466` |
| 結果の確認 | △ | 中継は reconcile で、お金の確保だけ鎖の答えで清算する。**行動の効果（兵が増えたか）を確かめて記憶する仕組みはない** | `fate.mjs`、`gateway.mjs:546` |
| 速さの上限 | ○ | `POST /f/agent/action`：住所ごと 40/2秒、代理ごと 30/1秒。取引の枠は持ち主と代理で共有 | `app.mjs:66`、MCP.md |
| 秘密 | ○ | モデルの入力は公開の記録から作る。トークン・鍵・持ち主の住所は入れない（テストあり） | DESIGN.md §5.1、§7.2 |

## 4. この作業で足したもの（共有コードは変えていない）

| 足したもの | 何をするか | 場所 |
|---|---|---|
| 依頼を読む→在庫と委任を確かめる→案→許可内で実行→着地と効果を確かめる | 上の ○ の仕組みを MCP の道具経由で使う。新しい権限は作らない | `src/participate.mjs` |
| 本人の「目的と上限」（仮の委任条件） | 中継の方針を**狭めるだけ**。資源の上限・兵の上限・期限・取消・従う相手・部分協力の可否・書いたときの方針の版 | `src/adapters.mjs` `grantFrom` |
| 命令の一覧（仮の命令契約） | プログラムの ABI と代理の経路をコードから読み、隊商・投票・施設の利用を「動かない理由」つきで返す | `src/adapters.mjs` `CommandContract` |
| 実行の記録（仮の Run） | 追記だけの記録。再起動の再開、効果の確認、確かめた結果だけを記憶 | `src/adapters.mjs` `RunJournal` |
