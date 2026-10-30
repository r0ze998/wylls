# 既存実装の調査（基準 commit `4cd901de`）

この文書は、④が作る実行器の前提になる**現行コードの事実**を記録する。提案は含めない（提案は [CONTRACTS](CONTRACTS.ja.md) と [patches/](../patches/)）。行番号は基準 commit のもの。

## 0. 作業の前提として確認したこと

- 依頼文は AGENTS.md と関連スキルを読むよう指示している。しかし基準 commit `4cd901de`（PR #22 の head `a4fc78c` も同じ）には、`AGENTS.md`、`SKILL.md`、`.claude/` が**存在しない**。そのため [docs/DEVELOPMENT-HANDOFF.ja.md](../../../docs/DEVELOPMENT-HANDOFF.ja.md) と各契約文書を前提にした。
- 引き継ぎ文書の「確認すべきこと 1」（依頼の進捗で、隊商の発送と到着を混同しない）は、本実行器の状態設計で直接扱う（`ShipSubmitted`／`InTransit`／`Arrived` を分ける）。

## 1. 正本は chain、keeper は冪等な任務の集まり

`frontier-node/crates/keeper/src/journal.rs` 冒頭の方針は次のとおり。

> The chain is the state: every duty is idempotent and succeeds once per object, so a restart re-plans from chain reads.

| 仕組み | 場所 | ④での扱い |
|---|---|---|
| SQLite（WAL、`synchronous=FULL`）の journal。送った版をすべて記録する（`attempts`） | `keeper/src/journal.rs` | 同じ設定で run store を作った（`src/store.rs`） |
| 再起動時に、送信中の attempt を `getSignatureStatuses` で照合する。未決のものは採用し、`first_valid_slot + 151` を過ぎたら `expired` にする | `keeper/src/lib.rs:416` `start()` | 同じ判定を run の各段階で使う（`undecided()`）。151 slot（blockhash の有効期間）を「もう着地しない」と判断する根拠にする |
| 書き込みごとに一意の object key を持ち、版ごとに新しい署名と payer を使う。`max_versions` と `per_write_cap` で上限を設ける | `keeper/src/engine.rs` | 一つの run の再試行に上限を設けた（`Budget.max_attempts`、`max_fee`） |
| 同じ keeper id のプロセスを一つに限る（`<journal>.lock` の flock） | `journal.rs` `lock()` | 複数の実行者が一つの store を共有する前提に変えた。flock の代わりに lease と CAS を使う |
| クラッシュ注入（`CrashAt`：journal の n 回目の書き込みで panic） | `journal.rs` | 実行器の名前付き停止点（`CrashPlan`）にした |

## 2. 隊商（S1 stage 1b）

契約文書は `docs/frontier/stage1b/S1-1B-CONTRACT.md`。実装は `permutation-frontier/src/proc/caravan.rs`、カーネルは `permutation-rules/src/frontier/caravan.rs`、keeper の任務は `keeper/src/caravans.rs`。

| 事実 | 根拠 | ④にとっての意味 |
|---|---|---|
| **SendCaravan は `seq` を引数に取り、`Citizen.CARAVANS` と一致しなければ `BadData` で拒否する** | `proc/caravan.rs:695` | 同じ seq の要求は、chain 上で一度しか効かない。**現行 chain で使える要求識別子は (owner_tag, seq)**。ただし拒否コードが汎用の `BadData` なので、重複と他の誤りを区別できない（→ patches P2） |
| Caravan account の seed は `cv ‖ owner_tag ‖ seq`。settle で閉じる | 契約 §1.2、§3.4 | account が無いことは「未作成」か「settle 済み」を意味する。どちらかは送信の照合とイベントで決める |
| 他人の場所への送付には、**送信者本人の** wallet の署名が必要。session key では `WalletRequired` になる。受取人は署名しない | 契約 §3.3、`proc/caravan.rs:726-729`、[SIGNATURES](SIGNATURES.ja.md) | **自動実行（委任された session key）で送れるのは自分の場所だけ**。他人宛ては、送信者本人の署名待ちで止める |
| 送る荷は塔の損耗の後の値（`CARAVAN_SENT.worn_bps`） | `fclient/src/conquest.rs` `CaravanSent` | 送った量が依頼量より少ないことがある（部分到着の原因 1） |
| **倉庫（vault）は `CAP` を超える分を黙って捨てる。`CARAVAN_SETTLED` には元の cargo が記録され、実際に入った量は記録されない** | `proc/caravan.rs:1005`（`min(cap.max(have))`）、`:1037`（`cargo_log(&cargo)`） | **settle の記録は、到着した量の証明にならない**（部分到着の原因 2。→ patches P1） |
| holding への加算には上限が無い（`Accrual::add`「may exceed the cap」） | `permutation-rules/src/frontier/holding.rs:296` | holding 宛てなら、規則から入荷量 ≥ 記録の cargo と言える（`RuleDerived`。記録は milli の加算量を整数に切り捨てた値なので下限。proc/caravan.rs:401-407） |
| session key には命令の範囲が無い（有効期限だけ） | `frontier-abi/src/prologue.rs:1120-1131` | ④の「物流だけ」は off-chain の制限（→ patches P6） |
| 宛先が無いか世代が違えば cargo は失われる（`STATE 3`、`outcome LOST`） | 契約 §3.4 | 宛先の世代変更を、送る直前と到着時の両方で扱う |
| capture-locked の holding への settle は `CapturePending` で拒否され、keeper が後で再試行する | `proc/caravan.rs:981` | 到着が遅れるだけなので、`InTransit` のまま待つ |
| 襲撃：take なら caravan ごと襲撃者のものになり（seed は同じ、所有者と宛先が変わる）、burn なら荷を失い空で進む。窓の後は DefaultRaid が keeper によって実行される | 契約 §3.5、`keeper/src/caravans.rs:284` | take は `owner_now ≠ owner`、burn は荷 0 の settle として観測する |
| SettleCaravan と DefaultRaid は keeper の D 任務で、誰でも送れる | `keeper/src/caravans.rs` | **④は settle を送らない**（keeper の `csettle` と重複させない）。settle は観測するだけ |
| holding の在庫は時間で変わる（生産・維持費）。`Holding::stock_at(now)` で精算した値を読む | `permutation-rules/src/frontier/holding.rs:786` | 実際の adapter は、保存された生の値ではなく、精算後の値を返す必要がある（CONTRACTS ③-R2） |

## 3. イベント

- PS2 の記録 `CARAVAN_SENT`（91）、`CARAVAN_SETTLED`（92）、`CARAVAN_RAIDED`（93）、`VAULT_SEIZED`（94）を `fclient::conquest::CqEvent` が読む。
- keeper は再起動のとき feed を cursor 0 から読み直す（`caravans.rs` 冒頭）。findex は entity ごとに索引を作り、herald はそれを読む。
- **records は hint と証拠であり、状態を決める正本ではない**。④でも同じ扱いにした（`Executor::ingest`）。

## 4. 施設の利用権・施設操作

- 「施設・資源・利用権を結びつける層」は決定ログ上の方向だけで、**実装は存在しない**（`docs/design/redesign/15-direction-2026-10-23.ja.md`、`17-…`）。利用権は②の担当。
- そのため、施設操作（要求キー `fac:<run_id>` による一意性）と利用権の検査（`Rights`）は **MOCK** で実装し、提案として [CONTRACTS](CONTRACTS.ja.md) に分けた。②の設計を④が決めたことにはしない。

## 5. 再利用したもの・新設しなかったもの

- 再利用：`permutation_rules::frontier::caravan::caravan_id`、`holding::RESOURCES`、`frontier_abi::v2::log::{caravan_outcome, raid_choice}`、`frontier_abi::v2::layout::s1::place::{KIND_HOLDING, KIND_VAULT}`、`frontier_abi::v2::Ix`（自動化を許す命令の表）。
- 汎用のワークフローエンジンは作らなかった。状態は依頼の一つの流れ（受付 → 施設 → 発送 → 到着）に限り、遷移表は `model::allowed` の一つの関数にまとめた。
- 共通コア（program、rules、abi、keeper、herald、web）には**変更を加えていない**。必要な変更は [patches/](../patches/) に案として分けた。
