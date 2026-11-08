# ② 現状監査：権限と工房の生産（基準 `4cd901d`）

**状態：** 事実の記録（第2回で、権限の一覧を `05-DELEGATION.ja.md` に、再生の確認を `06-EVENTS.ja.md` に分けた）。基準 commit は `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（PR #22 の統合候補。main 統合済み・CI 全成功とは扱わない）。行番号はこの commit のもの。

## 1. チェーンが実際に検査する権限

対象は S1 プログラム `permutation-frontier`。プレイヤー命令（P）は、すべて共通の前処理 `player_prologue`（`frontier-abi/src/prologue.rs:1085-1137`）を通る。

| 主体 | 鍵の持ち主 | チェーンが検査すること | 検査しないこと | 根拠 |
|---|---|---|---|---|
| 所有者の財布 | プレイヤー | `actor == Citizen.WALLET`、actor と payer の署名、Citizen の正規アドレス、季節（PDA・Running・ruleset）、行動バケツ（`debit_bucket`）、`bell < end_bell` | — | `prologue.rs:1096-1137`, `:1141-1166` |
| セッション鍵（`Citizen.SESSION`） | 財布が SetSession で指名。代理 AI の場合は運営の relay 内（`keyring.mjs`） | `actor == SESSION`、`SESSION != 0`、`now < SESSION_EXPIRY`。SetSession は財布だけ（`citizen.rs:472` は `session_ok=false`）。期限は最大30日（`citizen.rs:473`, `MAX_SESSION_SECS`） | **行動の種類・対象・数量・予算・回数**。セッション鍵は、その Citizen のプレイヤー命令を、下の4つの例外を除いて全部実行できる | `prologue.rs:1120-1131` |
| セッション鍵の例外（財布が必要） | — | CloseVault（`caravan.rs:1855`）、CloseStructure（`structure.rs:557`）、他人の場所への SendCaravan（`caravan.rs:727`）、SetSession。RetireHost は財布またはセッションを個別に確認（`conquest.rs:1638-1653`） | — | 各行 |
| `Holding.DELEGATE`（32 B） | — | **何も検査しない**。占領時にゼロにされるだけ | 権限として未使用 | `v2/layout/player.rs:122`, `conquest.rs:1432` |
| 手数料の支払い者（relay の payer） | 運営 | 署名と書込み可能だけ | Citizen に対する権限はない | `prologue.rs:1096-1100` |
| キーパー（D 級命令） | 誰でも | 規則で決まった精算（隊商の到着など）だけ | 所有者の資源を任意には動かせない | `v2/tags.rs`（class D） |
| AI 住民・スクリプト bot | 運営（fleet seed から導出） | 独立した Citizen として、上と同じ | 人間の代理ではない | `frontier-node/crates/agents/src/keys.rs:1-12` |

**チェーン上にないもの：** 代理の札、使用権の札、施設利用権、行動の許可リスト、予算、1日の上限。**他人の施設を使う命令**もない。他人へ資源を移す手段は「財布の署名つきの隊商」だけで、届いた資源は受け手の所有になる。

## 2. チェーンの外の検査（迂回できる）

代理 AI の財布（`permutation-gateway/src/frontier/agent/`、relay を `--agent-wallet` で起動したときだけ）が送信前に検査する。

| 検査 | 場所 | 鍵の持ち主が RPC へ直接送れば迂回できるか |
|---|---|---|
| 所有者の署名・能力トークン | `gateway.mjs:396-407`, `owner-auth.mjs:41-52` | できる |
| 行動の許可リストと `NEVER_DELEGATED`（Join, SetSession, PlaceHome, FileTicket, FileOutpost, DeclareSiege, RetireHost） | `policy.mjs`, `contract.mjs:30-44` | できる |
| 村は1つだけ（`WrongVillage`） | `gateway.mjs:415` | できる |
| 予算（`total`, `perDay`, `callsPerDay`） | `ledger.mjs:166-177`, `policy.mjs:5-28` | できる |
| 停止（`manual`）、`modeEpoch`、`policyVersion` | `gateway.mjs:411-413`, `:444-450` | できる |
| エージェント鍵の relay 直送の拒否（`AgentKeyDirect`） | `routes/relay.mjs:105-109` | できる（relay を通らない送信には効かない） |
| relay の形の許可・レート・1日の件数 | `routes/relay.mjs:103-177`, `quota.mjs` | できる |
| チェーン上のセッション鍵と期限の照合 | `gateway.mjs:476-482` | チェーンも別に検査する |

設計文書も同じことを書いている：「**Enforced by the operator's server only** … a party holding the agent *seed* could go around them by sending to the RPC directly」（`docs/agent-wallet/DESIGN.md:106`）。MCP サーバ（`permutation-gateway/mcp/agent-mcp.mjs`）は能力トークンだけを持ち、権限を足さない。

## 3. 「予算」は何を縛るか

予算の単位は **テスト USDC**（`policy.mjs:5-8`）。推論の呼び出し1回あたり 0.01、ゲームの行動の価格表は空で 0 として保留される（`DESIGN.md:138`）。SOL 手数料は relay が払い、記録だけ。**食料・木材・鉱石・武具・兵のようなチェーン上のゲーム資源は、予算の対象ではない。** 予算の設定があっても、チェーン上の資源の上限は何も保証されない。セッション鍵を持つ者は、規則の範囲で村の資源を全部使える。

## 4. 工房の生産は現行コードでどう進むか

- 工房は **建物（Build の item 8、`arms::ITEM_WORKSHOP`）**。1つ建てると、その村の `production[ARMS]` に 4 個/時（`WORKSHOP_DELTA`）が足される（`permutation-rules/src/frontier/arms.rs:44-106`、`holding.rs:526`, `:692`）。
- 武具は Horses の倉の枠を使う（`arms::ARMS = Resource::Horses`）。
- **生産は連続**で起こる。村の倉は settle のたびに時間で積分され、工房は**同じ村の倉の**鉱石 2・木材 1 を武具 1 に変える。材料が尽きると、続く割合だけで動く（`permutation-rules/src/frontier/holding.rs:46`, `:410-560`, `:657-`）。
- **「加工を1回呼ぶ」命令は存在しない。** 工房は持ち主の村の倉にだけ入出力を持つ。他人の材料を入れる口も、できた物を他人へ出す口もない。
- 武具の使い道は、強い兵の訓練（`train_v3`, `proc/holding.rs:904-908`）と攻城の宣言（`siege_cost`, `proc/conquest.rs:800-803`）。

## 5. 利用権の接続に必要な最小のコア変更（特定）

1. **口を作る：** 施設の倉から出し入れする、新しいプレイヤー命令。連続生産のカーネル（`Holding::settle`）は**変えない**。そのため S1 の ruleset hash（`RULESET_HASH_V3`）は変わらない。
2. **権利の記録：** 発行者・利用者・施設（鍵と世代）・受取先・上限・期限・予約を持つ、チェーン上のアカウント。
3. **署名の規則：** 発行は所有者の財布、利用は利用者自身の鍵（財布またはそのセッション）。所有者の鍵は使わない。
4. **ログ：** 検証器と herald のための PS2 記録の種類（未実装。`03-CONTRACT.ja.md` §8）。

方式は「**工房在庫の交換権**」にした（採用は未決定）。利用者の鉱石・木材が施設の倉に入り、施設がすでに作った武具が利用者の倉に出る。**加工の実行でも、将来の生産能力の予約でもない。** 連続生産は変えていない。施設の工房が作っていない武具は出てこない。差分と検証は `02-SPEC.ja.md`、`03-CONTRACT.ja.md`、`patches/v1/` にある。

## 6. 監査で見つけたこと

- **予算はゲーム資源を縛らない**（§3）。代理を「予算つき」と表示すると、チェーン上の上限まで約束しているように読める。
- **セッション鍵の範囲が広い**（§1）。代理 AI の鍵を持つ運営プロセスは、所有者が SetSession で取り消すか期限が切れるまで、その Citizen の P 命令のほとんどを実行できる。
- **`Holding.DELEGATE` が未使用**のまま残っている。将来の権限の検査がこの欄を読むなら、占領時にゼロにする処理だけでは足りない（世代の固定が要る）。
- **代理の札**（`docs/design/redesign/24-ai-roles.ja.md:42`、［決定］）と**使用権の札**（`20-stage2-play.ja.md:29`、§5 以外は提案）は、どちらも未実装。
