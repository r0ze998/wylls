# ⑤ 人間の意図と権限を守って、AIが国の活動に参加する

**状態：** 監査と局所デモ。**提案であり、採用済みの仕様ではありません。** 共有コア・共通API・他の担当の仕様は変えていません（このフォルダの外のファイルは一つも変更していない。共有コアへの変更は `patches/` に未適用の差分として分けた）。公開の push・main への merge・配備・実資金・追加課金・外部のLLM・独立AIの本番登録は、どれもしていません。

- 共通基準 commit：`4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（PR #22 の統合候補の途中。main 統合済みではなく、CI 全成功でもない）。
- 作業ブランチ：`claude/ai-participation-audit-dbzqw0`（基準 commit から分岐）。
- `AGENTS.md` と関連スキル（`.claude/skills/` など）は、基準 commit にも他のブランチにもありませんでした。読んだのは `docs/DEVELOPMENT-HANDOFF.ja.md`、`docs/agent-wallet/`（DESIGN・MCP・STATUS ほか）、`docs/design/redesign/24-ai-roles`・`29-remaining-decisions`・`99-decisions`、AI住人の契約、試遊甲のキット、関係するコードです。
- ②（権利）・④（Run）の契約は届いていません。③は未 merge のブランチ `claude/modest-goldberg-c180fk` に成果物があり、読むだけにしました。接続は**仮アダプター**です（[ADAPTERS](ADAPTERS.ja.md)、[STAKING-BOUNDARIES](STAKING-BOUNDARIES.ja.md)）。

## 追加要件：AI staking（2026-10-30）

agent に予算と行動範囲を任せ、預けた残高から推論とゲーム内の支出を払う仕組みです。前回の成果の上に足しました。前回の成果は壊していません（既存の19件のテストはそのまま通る）。

| 文書 | 中身 |
|---|---|
| [STAKING-STATUS](STAKING-STATUS.ja.md) | 現状の確定：起動設定・モデル呼び出し・実行経路・支払い・記録。**「Gemma で動いている」は repo の中では確かめられない**（記録のモデル名は設定した別名）。前回の⑤と今回の要件の対応 |
| [STAKING](STAKING.ja.md) | モデルと予算の分離、どこで何を強制するか、最小実装、必須の検証、デモ、模擬と本物の区別、残る不足 |
| [STAKING-BOUNDARIES](STAKING-BOUNDARIES.ja.md) | ②③④・画面の担当への依頼事項 |
| [patches/](patches/README.ja.md) | 共有コア（代理の財布）への統合用パッチと、適用の条件（未適用） |
| `logs/staking/` | デモの記録、パッチを当てた状態でのテスト結果 |

| コード | 中身 |
|---|---|
| `src/staking/providers.mjs` | モデルの提供者（loopback の OpenAI 互換・台本・外部は宣言だけ）。設定したモデルと実際のモデルを分けて記録 |
| `src/staking/pricing.mjs` | 推論費用の見積り・実測・換算（試験値だけ）と、決済方法の整理 |
| `src/staking/budget.mjs` | 実行層のカテゴリ別の上限（同期的な予約）、本人向けの明細、追跡 |
| `src/staking/session.mjs` | 予算設定 → 許可範囲 → 自動開始 → 実行 → 停止 → 手動復帰 → 引出し |
| `src/staking/outcomes.mjs` | 受理・着地・効果・隊商の出発と到着を分ける |
| `src/staking/fake-model-server.mjs` | loopback の **fake** の OpenAI 互換サーバー（モデルではない） |
| `test/staking.test.mjs` | AI staking の検証 13件 |
| `demo/run-staking-demo.mjs` | AI staking のデモ。`logs/staking/` に記録を書く |

## 目的と、このデモがすること

会話を増やすことではなく、**人間が決めた目的と制約の中で、実際の世界の状態を読み、合法な行動を選び、結果を確かめて国の活動に参加する**こと。デモの流れ：

1. 国の公開の依頼を読む（北方拠点の共同作戦：槍兵200、木材900を北の倉へ、構えの投票、見張り塔の利用、期限切れの依頼、他国の依頼、攻撃者の依頼）。
2. 自分の在庫と委任を確かめる（`agent_view` の mode・方針の版・停止と再開の版・鎖上の委任、本人の委任条件、村の蓄え）。
3. 参加案を出す（規則、または台本のモデル）。
4. 許可の範囲で実行する（`agent_act`。中継が同じ確認をもう一度する）。
5. 着地と効果を確かめる（`GET /f/tx` と世界の公開の状態）。確かめた物だけを「協力した」と記憶する。
6. 実行できない物は、理由と本人の判断を返す（隊商は財布の署名が要る、投票は代理に任せない決定、施設の利用はプログラムにない）。

## 成果物

| 文書 | 中身 |
|---|---|
| [CURRENT-SUPPORT](CURRENT-SUPPORT.ja.md) | 現行対応表：MCP の道具、行動の許可リスト、runner・予算・停止・権限版・重複防止。隊商・投票・施設の利用は動かない、という事実と根拠 |
| [ROLES](ROLES.ja.md) | 代理・独立住人・組み立ての手伝い・運営AIの、目的・観測・記憶・費用・権限・停止する人 |
| [ADAPTERS](ADAPTERS.ja.md) | ②③④への仮アダプターと、正式な契約への接続案。本物と模擬の区別 |
| [MCP-EXTENSIONS](MCP-EXTENSIONS.ja.md) | 必要な MCP 拡張の案（`action_status`・`agent_whoami`・`village_state`・`nation_requests` ほか） |
| [RULES-VS-MODEL](RULES-VS-MODEL.ja.md) | 規則の代理とAIの判断を同じ条件で比べた結果 |
| [TEST-REPORT](TEST-REPORT.ja.md) | 通過・失敗・未実行のテスト、commit |
| `logs/` | 実行の記録（デモが書く） |

| コード | 中身 |
|---|---|
| `src/participate.mjs` | 一回の参加：再開 → 確認 → 観測 → 委任 → 計画 → ガード → 実行 |
| `src/adapters.mjs` | ②`grantFrom`、③`CommandContract`、④`RunJournal`（すべて仮） |
| `src/guard.mjs` | 提案の確認（命令契約・委任・依頼・蓄え・期限・1日の上限） |
| `src/deciders.mjs` | 規則の代理、モデルの代理（プロンプトと答えの schema） |
| `src/local-world.mjs` | 局所の世界（本物の中継・代理の財布・MCP、scripted chain、効果の模擬、依頼板の fixture、台本のモデル） |
| `test/participation.test.mjs` | 再現テスト 19件 |
| `demo/run-demo.mjs` | デモ。`logs/` に記録を書く |

## 動かし方

```sh
(cd permutation-gateway && npm ci)                                   # 共有コードの依存（局所、無料）
node --test workstreams/05-ai-participation/test/*.test.mjs           # 再現テスト
node workstreams/05-ai-participation/demo/run-demo.mjs               # 参加のデモ（logs/ を書き直す）
node workstreams/05-ai-participation/demo/run-staking-demo.mjs       # AI staking のデモ（logs/staking/ を書き直す）
```

ネットワーク・外部のモデル・鍵ファイルは使いません。署名と agent id は毎回変わります（新しい鍵）。結果は変わりません。

## 本物と模擬

| 本物（共有コードをそのまま呼ぶ） | 模擬・fixture |
|---|---|
| 中継の route、代理の財布（資格・重複・mode・版・許可・村・料金・委任・取引の組み立てと署名・中継の形の確認と模擬実行）、MCP サーバー、`GET /f/tx` | 鎖は gateway のテストの scripted chain（署名を確かめ、送った物を記録する。ゲームのプログラムは動かさない）。Train の支払いと兵の増加は `settle()` の真似。国の依頼板は fixture（どこにもない）。モデルは台本 |

**模擬のモデルでの成功を、実LLMや本番の成功とは言いません。** 鎖の着地も scripted chain の答えです。

## デモの結果（`logs/north-op.report.json`）

| 依頼 | 結果 | 理由 | 本人の判断 |
|---|---|---|---|
| N-1 北方拠点の守り：槍兵200 | 送った → 着地 → 兵が200増えたのを確認 → 「協力した」と記憶 | 委任の範囲内（食料120・鉱石40・金20） | — |
| N-2 北の倉へ木材900 | 本人へ | 他人の倉への隊商は、鎖が財布の署名を求める（`WalletRequired`） | 隊商の欄で、宛先・荷・量を確かめて財布で署名する |
| N-3 構えの投票に賛成 | 本人へ | 代理に投票は任せない（29 の E2） | 自分で投票するか決める |
| N-4 見張り塔の利用 | 本人へ | 施設の利用権はプログラムにない（試遊甲では札と台帳） | 試遊の手順で行うか、実装を待つ |
| N-5（期限切れ） | 読まない | 期限が過ぎた | — |
| N-6（他国） | 読まない | 委任は自分の国だけ | — |
| X-1・X-2（攻撃者） | 読まない | 本人が従うと決めた相手ではない | — |

2回目の実行：最初の送りを確かめ（`contributed`）、同じ依頼にもう一度は送らない（`AlreadyContributed`）。

## 人間が目的や上限を変えると、行動はこう変わる（`logs/mandate-variations.json`）

同じ世界・同じ依頼板で、本人の委任条件だけを変えました。

| | 本人が決めたこと | 代理がしたこと | 本人に回したこと |
|---|---|---|---|
| A | 基準：1件あたり兵200、部分協力可、担当官の依頼だけ | N-1 に槍兵200 | 隊商・塔・投票 |
| B | 1件あたり兵100に下げる | N-1 に槍兵**100** | 同上 |
| C | 部分協力を許さない（上限は兵100） | **何もしない** | N-1「上限を200に上げるか、部分協力を許すか」＋同上 |
| D | 訓練を任せない（収穫だけ） | **何もしない** | N-1「訓練を委任に加えるか、自分で行うか」＋同上 |
| E | 国の誰の依頼にも従う、1日の上限2倍 | N-1 に200、**攻撃者の X-1 にも200** | 同上 |
| F | 停止（manual） | 何もしない（計画もしない） | — |
| G | 委任条件の期限切れ | 何もしない | — |

E は、規則の代理でも「従う相手」の設定が守りになっていることを示します。

## 本人（持ち主）に決めてほしいこと

1. **代理の札（②）に入れる上限。** 今の中継の方針は USDC と行動の種類だけで、資源の量・依頼ごとの上限・期限・従う相手を強制できない。この作業では代理の側だけで守った（仮）。正式には中継か鎖で守る必要がある。
2. **自分の倉どうしの隊商を代理に開くか。** 鎖は許しているが、代理の経路にない（[MCP-EXTENSIONS](MCP-EXTENSIONS.ja.md) の6）。
3. **国の依頼板をどこに置くか。** 今はどこにもない。国ごとの閲覧の権限と、書いた人の身元（財布の署名）が要る。
4. **モデルを呼ぶ場面を絞るか**（[RULES-VS-MODEL](RULES-VS-MODEL.ja.md) の3）。
5. **推論費用の精算方法**（AI staking）。今は台帳から1回いくらの固定額だけ。実測、運営の立て替え、本人自身のキーのどれを採るか。採るなら、利用ID・換算の出所・精算の周期・換算差を誰が負うかも（[STAKING](STAKING.ja.md) §1）。
6. **本番の価格と上限の既定値。** どれも試験値のまま。固定していない。
7. **パッチ 0001 を採るか**（中継で、1回の上限・カテゴリ別の上限・権限の期限を強制する）。採るなら、②の Grant と欄の形をそろえる（[patches/README](patches/README.ja.md)）。
8. **外部のモデル提供者を有効にするか。** 今は宣言だけで、通信もキーの読み取りもしない。
