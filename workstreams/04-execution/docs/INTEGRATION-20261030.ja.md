# ④ ローカル統合：③パッチ 0005 ＋ ⑤パッチ 0001 ＋ 隊商 Run 経路（2026-10-30）

**状態：ローカル統合のみ。** 公開 push・merge・deploy・API 課金・鍵の設定はしていない。実チェーン・実際の relay の鍵・財布・有料 API には一度も接続していない。

## 0. ブランチと前提

| 項目 | 値 |
|---|---|
| ブランチ | `ws04/integration-20261030`（新規、独立。worktree `/home/user/wylls-ws04-int`） |
| 分岐元 | ④ `2e536b6b119d8eaa4e9f4d795e856b696249a664`（`claude/gallant-ride-cunptv` と保存パッケージは変更していない） |
| 基準 | `4cd901de9f8e0d6c0b2016851d30595c4a70aa46` |
| 受領済みパッケージ | 1 回目（②`dc3bd3d`・③v2`47b05ac6`・④`2e536b6b`・⑤`ba3c180b`・⑥r2`517796dc`）と 2 回目（①`0dd4e5d`・③v4`acdcd0bf`・⑤`6cdd648c`・⑦v2`1f2d7419`・⑧`f0dd683d`）を、それぞれ別の場所に復元したまま保持（置換・削除なし） |

**使わなかったもの（代替にしていない）**：①の後続 `2c5d30a`→`ccc2f8e` と、⑧の新版（`4f628faf`・`4991db38`・`2318b004`・`25bc01d9`、地図拡張）は実物を受け取っていない。旧版（①`0dd4e5d`、⑧`f0dd683d`）で代替したことにはしていない。この統合は①⑧のどちらにも依存しない。

## 1. 共有コードのパッチ（担当別に、そのまま適用）

| commit（この branch） | 出所 | 対象 | 採否 |
|---|---|---|---|
| `31ceb016`（完全 SHA は保存パッケージの MANIFEST） | ③ v4 `patches/0005-agent-wallet-sendcaravan.patch`（v2 と同一） | `permutation-gateway/src/frontier/agent/{contract,gateway}.mjs`＋試験 1 本 | **ローカル統合のみ採用**。本採用は⑤（代理の財布の担当）と統合担当の判断 |
| `eb5ad70d` | ⑤ `ba3c180b` `patches/0001-agent-wallet-staking-limits.patch`（木の中の写しと同一） | `permutation-gateway/src/frontier/agent/{contract,gateway,ledger,policy}.mjs`＋試験 1 本 | 同上 |

**競合**：両者は `contract.mjs`・`gateway.mjs` で重なる（⑤ README の予想どおり）。どちらの順でも文字上の衝突なく当たり、結果の木は同じ（確認済み）。この branch では ③→⑤ の順にした。

**意味上の相互作用（試験で確認）**：
- 0001 の `expiresAt` は SendCaravan（0005）にも効く：期限後の送付は `PolicyExpired` で、署名前に拒否された（`expired_permission_from_patch_0001_holds_the_run`）。
- 0001 の価格・上限は、SendCaravan の価格表（`prices.game.SendCaravan`）が空の間は 0 円の確保で、隊商には効かない。価格を付けるかは⑤の判断（③ 0005 の適用条件 (2)）。

**試験（`permutation-gateway`、両パッチ適用後）**：
- `agent-wallet-*`・`frontier-relay*`：107/107 通過（既存 97＋0005 の 5＋0001 の 5）。
- `npm test` 全体：2,539 件、通過 2,538、失敗 0、スキップ 1（Gemma 4 のモデルファイルが無い）。
- 依存は `npm ci --ignore-scripts`（npm registry、無料、install スクリプトは実行していない）。

## 2. 隊商 Run 経路の接続（④ ↔ 代理の財布）

`src/gateway.rs` の `GatewayPort` が、④の `Chain` を次のように実装する。

| ④の段階 | 実装 | 実物 / 模擬 |
|---|---|---|
| SendCaravan の要求 | `POST /f/agent/action`（③ 0005 の `SendCaravan`、`transport` 群）を、試験用の橋渡し `bridge/agent-gateway-bridge.mjs` 経由で呼ぶ | **gateway のコードは実物**（共有コード＋2 パッチ）。橋渡しは試験用 |
| 署名と送信 | gateway が送る直前に署名する（`beforeSend`）。④は署名前のバイト列を持てないので、**試行の札** `gw:<slot>:<冪等キー>` を先に記録する。冪等キーは試行ごとに固定（`ws04:<owner>:<seq>:<n>`）で、同じ試行の再送は gateway の replay になる | 実物（gateway の冪等性） |
| 着地 | gateway の偽チェーン（agent wallet の試験の scripted chain）が即 finalized にする。④の port は、**gateway が実際に署名した命令のバイト列**を取り出し、`frontier_abi::v2::ix::SendCaravan::decode` で読んで、その中身を模擬正本に着地させる | **チェーンは模擬** |
| 照合 | 署名は gateway の答え、または答えが失われた時は代理人の公開履歴（`GET /f/agent?id=`、読み取りのみ）から得る（`Chain::chain_sig`）。④は「自分の試行が指すチェーン署名」で `CaravanSent` を照合し、中身（送り元・宛先・資源・量）を spec と比べる | 照合の論理は④の実物、記録は模擬 |
| 施設の使用・利用権 | 模擬のまま（②の StockSwap は未採用で、加工能力の貸出の命令は無い） | 模擬 |
| 到着量 | 模擬正本の settle の記録（`credited` あり／なしの両方を④の既存試験で扱う） | 模擬 |

### 2.1 試験（`tests/gateway.rs`、9 件、全通過）

Node と `permutation-gateway/node_modules` が要るので、既定の `cargo test` では ignored（理由付き）。`cargo test --test gateway -- --ignored` で実行した。

| 試験 | 確かめたこと |
|---|---|
| `gateway_send_fulfils_with_the_signed_content_checked` | 正常系。偽チェーンへの送信は 1 件、受領証は札でなくチェーン署名を名指し |
| `gateway_answer_lost_is_recovered_from_history_without_a_second_send` | 答えが失われても、同じキーの再送（replay）で送信は 1 件 |
| `lost_answer_under_cancel_is_read_from_history_not_resent` | 取消中は再送しない。公開履歴から送信済みを知り、gateway への呼び出しは 1 回だけ。取消は「手遅れ」と記録 |
| `crash_before_the_gateway_call_resends_the_same_key` | 記録の後・呼び出しの前に停止。再起動（記憶なし）後に同じキーで送り、送信は 1 件、試行は 1 回 |
| `policy_refusal_holds_the_run_with_the_outputs_at_stock` | `transport` を許可しない方針：署名前の拒否（`ActionNotAllowed`）で保留、送信 0、産出物は在庫の場所 |
| `manual_mode_holds_then_auto_and_resume_ship_once` | ⑤の手動モード：`AgentStopped` で保留 → 自動に戻して `resume` → 新しいキーで 1 回送る |
| `expired_permission_from_patch_0001_holds_the_run` | ⑤ 0001 の `expiresAt` の後：`PolicyExpired` で保留、送信 0 |
| `failure_after_signing_without_a_signature_is_held_not_guessed` | 署名後に送信が失敗した時、gateway の答え（`failed`）に署名が無い。チェーンには隊商があるが（試験の神託で模擬正本に着地）、④は自分のものと判断できず `Indeterminate` で保留。2 回目の送信はしない |
| `source_other_than_the_village_is_refused_before_any_call` | 送り元が代理人の村でない run は、gateway を呼ばずに署名前の拒否として保留 |

変異（壊して試験が落ちるかの確認、`gateway` の試験で）：

| 変異 | 結果 |
|---|---|
| MG1 チェーン署名を対応づけない | 4 件が検出 |
| MG2 答えの無いキーを「不在」とする | `crash_before_…` が検出 |
| MG3 公開履歴を読まない | `lost_answer_under_cancel_…` が検出 |
| MG4 全試行の署名が分からなくても「他人の送信」とする | `failure_after_signing_…` が検出 |
| MG5 署名前の拒否でも有効期間を待つ | 4 件が検出（この変異で、次の確認時刻の `u64::MAX` が SQLite の i64 で -1 になる潜在欠陥を見つけ、直した） |
| MG6 送り元が村かの確認を外す | **検出されない**。gateway が村以外から送る場面は、共有コードを改変しないと作れない。防御として残し、試験していないことを記録する |

④の既存試験（62 件）は、この branch でも全通過（`cargo test`、gateway の 9 件は ignored として別に実行）。

### 2.2 ③⑤への接続依頼（この統合で見つかった欠け）

| # | 欠け | 影響 | 依頼先 |
|---|---|---|---|
| G-1 | `ActionResult` に有効期限（`lastValidBlockHeight`）と、作る前に読んだ slot（`slotFloor`）が無い。価格 0 の行動では、送った直後に確保が解放され、gateway の中でも失われる | ④は「全履歴で不在」（HANDOFF §3）を証明できず、送ったが着地していない試行を `Unavailable` とするしかない。取消の完了・seq の付け直しが保留になる | ⑤（gateway）・③（MCP の受領証） |
| G-2 | 署名の後に送信が失敗した時の答え（`status: failed`）に署名が無い。公開履歴にも無い | 着地していても④は自分の送信と言えない（`failure_after_signing_…`） | ⑤ |
| G-3 | 冪等キーで結果を読む専用の照会が無い。公開履歴は直近 50 件 | 古い試行は照会できなくなり、`Unavailable` になる | ⑤ |
| G-4 | 送り元が所有者の倉庫の場合、この port は扱わない（村だけ） | 倉庫発の run は保留 | ④（次の段階）。gateway 側は対応済み |
| G-5 | ⑤の `fate.mjs` は、④の「不在」の条件（有効期限・finalized・履歴の範囲）と同じ規則で判定している | 判定の規則は一致。上の G-1 で値を渡せば、④は同じ判定をそのまま使える | （一致の記録） |

## 3. 実物との照合（未受領扱いだった契約）

### 3.1 ② `dc3bd3d`（StockSwap、未採用）

②の `docs/03-CONTRACT.ja.md` で確認した：StockSwap は「施設がすでに作った武具を、同じ州で隊商を使わずに交換する」案で、**加工能力の貸出ではなく、その代替でもない**（未採用、統合判断待ち）。④の HANDOFF §1 の表の「未確認」欄は次のとおり埋まる（④の施設使用の提案と同じ契約としては扱わない）。

| 観点 | ② StockSwap（実物の契約案） |
|---|---|
| 必要な入力 | Grant（`IssueGrant {nonce, kind=1, max_swaps, max_units, expires_ts}`、発行者の財布の署名）、`ReserveSwap {units, seq}`、`ExecuteSwap {seq}`、`ReleaseSwap {}` |
| 原子的な検査 | 予約で、受取口の鉱石 2u・木材 u と、施設の武具 u を預かる。在庫が無ければ予約は失敗（待機なし） |
| 重複の拒否 | `seq` は Grant の `SWAPS` が基準。再送は `SeqMismatch` で失敗 |
| 記録 | **PS2 の記録が無い**（②自身が統合前の必須課題とする。検証器は Holding を書く交換を FAIL にする） |
| ④への依頼（②の文書） | 段階の間は Reserve で両側を押さえ、確定は Execute、巻き戻しは実行前の Release だけ。再試行・期限・別施設への切替は④の側 |

④はこの命令を実装していない（未採用のため）。採用された場合、④の「施設の段階」とは別の段階（交換）として、`seq` を Grant から固定する形で組み込める見込み。

### 3.2 ③ `acdcd0bf`（v4）

- ③の提案 0006（④との受領証の口）の質問への④の答え：
  1. 受領証の状態名・遷移：④の 15 状態と保留（STATE-MACHINE）。③の `hold` は④の `held_reason`（`GatewayRefused(code)` など）に対応。
  2. 取消の 3 区分：`StoppingNew` / `AwaitingSigned{until}` / `Completed{effects}`（＋`Ineffective`）。照合待ちを終端まで進めるのは④。
  3. 到着量：settle の記録（`credited`）か規則だけで判定し、検証できなければ `DeliveredUnverified`。**③ 10-handoff §3.5 の「倉庫なら決着の前後の中身の差を示す」提案は、④の規則（残高差で推測しない）と食い違う**。差は他の入出庫と混ざるので、量の根拠にしない（表示するなら「参考」と明記）。
  4. 費用：④の 4 区分は④の run の手数料。gateway 経由では手数料は relay の pool が払い、⑤の帳簿（`network`）に入るので、④の試行の手数料は 0 として記録する。
  5. 照会の認証・6. 識別子：未決定（④は `run_id` と試行の札を持つ。③の `operationId` との対応は未実装）。
- ③のパッチ 0005 は、この branch で④から実際に使った（§2）。

### 3.3 ⑤ `ba3c180b`／`6cdd648c`

- パッチ 0001 を適用し、⑤の上限（期限）が④の隊商に効くことを確かめた（§1）。
- `fate.mjs` の判定規則が④の「不在」の条件と一致することを確認（§2.2 G-5）。
- ⑤の後続（`21abfc59`・`ffcb2a07`・`6cdd648c`、model-api：Claude/GPT の代理推論）は、この統合には入れていない。**LLM の応答は検証していない**（実 API も鍵も使わない指示のため。⑤の試験は fixtures と loopback の provider）。

### 3.4 ⑥ `517796dc`（r2、ADDENDUM 優先）

- ADDENDUM §1：回数制限の正本は未決定。④の受理の時点で数えても、別の経路からの操作は縛れない（④の実行器も同じ限界：store の中だけ）。
- ADDENDUM §2：StockSwap は⑥の工房の代替にしない（②の実物と一致）。
- ⑥の確認事項 3・4（`00-correspondence`）への④の答え：⑥が証拠として受け入れてよいのは `Fulfilled` と、`Partial` の検証済みの量だけ。`DeliveredUnverified` は証拠にしない（到着量 0 という意味でもない）。「一度だけ使った」印の置き場は④に無い（未実装）。

### 3.5 ⑦ `1f2d7419`

INTEGRATION §0 を確認した：v2 のパッチの基準は `a997a756`（⑦自身の commit、共有の `guide.mjs` を変える）で、0003 は 0002 に依存、0005 は 0003・0004 に依存（0003 単独は当たらないことを確認）。0004 は④⑤の状態の表示契約を含む。⑦のパッチは、この branch には**入れていない**（④の実行器と同じファイルを触らず、表示側の採否は⑦と統合担当の判断のため）。

### 3.6 ① `0dd4e5d`・⑧ `f0dd683d`

旧版として受領・検証のみ。後続（①`ccc2f8e`、⑧の地図拡張）は未受領で、この統合では使っていない。

## 4. 模擬と実証の区別

| 主張 | 根拠 | 区分 |
|---|---|---|
| ③0005＋⑤0001 は共存し、gateway の既存試験を壊さない | `npm test` 2,538/2,539（1 スキップ） | **ローカル実証**（Node、実際の gateway コード） |
| ④の run が gateway 経由で隊商を 1 回だけ送る（答えの消失・停止・再起動・取消でも） | `tests/gateway.rs` 9 件 | gateway は実物、**チェーンは模擬** |
| ⑤の方針・停止・期限が④の隊商に効く | 同上 | 同上 |
| 送った中身が spec と一致する | gateway が署名した命令のバイト列を frontier-abi で復号して照合 | 署名と命令の符号化は実物、着地は模擬 |
| 実チェーンでの成立、実際の到着量、施設の利用権 | — | **未実証**（SBF の program を作る Solana の platform-tools が無い。②の利用権は未採用） |
| LLM の応答 | — | **未実行**（実 API・鍵を使わない） |

## 5. 止まっている所と必要なもの

| 何 | 障害 | 必要なもの |
|---|---|---|
| 実チェーン（ローカル validator）での run | SBF の program（`permutation_frontier.so`、S1）が作れない。`scripts/build-frontier.sh` は `~/.local/share/solana/install/active_release`（platform-tools）を前提にし、この環境に無い | platform-tools の入った環境、または S1 の `.so`（ビルド済み）と、それを読む `frontier-localnet`（frontier-node、toolchain 1.95） |
| 実際の relay・財布・鍵での送信 | 禁止（鍵の設定・課金なし） | — |
| ⑤ model-api（LLM） | 実 API は禁止 | —（fixtures の範囲は⑤の試験で確認済みとの報告） |
