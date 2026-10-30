# ⑫ 事実認定の規則（fold v3）

二度目・三度目のレビュー（2026-10-30）で指摘された「誤った評価で関係を壊す」経路を塞ぐための規則。実装は `src/fold.mjs`、`src/records.mjs`、`src/store.mjs`、`src/index.mjs`。テストは `test/evidence.test.mjs`（v2）と `test/contract-v3.test.mjs`（v3）。重みはすべて仮設定（`WEIGHTS.provisional: true`、`CAUTION.provisional: true`）で、調整していない。**本番の評判ルールとして採用したものではない。**

v2 から維持していること：未確認で信頼度を下げない、配送と約束は明示的な割当でだけ結ぶ、発生時刻と観測時刻を分ける、caution は誠実さの評価ではない。

## 1. 記録がないことは、不履行や嘘の証拠にしない

- 期限＋猶予（6 bell）を過ぎても判断材料が揃わない約束は **`unconfirmed`**（未確認）。理由を必ず付ける：`no_record_found`、`lookup_failed`、`coverage_insufficient`（＋`coverage_gaps` に何が足りないか）、`in_transit`、`settle_unobserved`、`caravan_unknown`、`recipient_unverified` / `recipient_conflict`、`qty_unverified`、`qty_split_ambiguous`、`record_conflict`、`unassigned_caravan`、`coverage_caravan_unresolved`。
- `unconfirmed` は信頼度 E を動かさない。判断を慎重にする **caution 項**は別にあり、入力に `is_honesty_judgment: false` と意味を明記する。証拠が届けば、結果がどちらでも消える。
- 襲撃（`raided`）・目的地消失（`lost`）・精算時の所有者違い（`recipient_changed`）・期限前の取り下げ（`withdrawn`）は**中立**。

## 2. 「未発送」の証明（v3 で厳密化）

`not_sent`（旧 `not_delivered`）が確定するのは、④の `coverage` が次を**すべて**満たすときだけ（`coverageSufficiency`）。一つでも欠ければ `unconfirmed`（`coverage_insufficient`）で、`coverage_gaps` に欠けたものを書く。

| 条件 | coverage の項目 | 欠けたときの印 |
|---|---|---|
| この記憶の世界と同じ cluster・program・**season** | `world` | `other_world_or_season`（記憶側に world が未設定なら `memory_world_unset`） |
| 対象の送り主 | `sender` | 他人の coverage は使わない（`no_record_found`） |
| 約束から期限＋猶予までの全区間 | `from_bell`〜`to_bell`（連続する証明だけ結合） | `window_not_fully_covered` |
| **全送信経路** | `routes` ⊇ `send_caravan/top_level`、`send_caravan/cpi`、`settle_raid/take` | `route_missing:<経路>` |
| 履歴の完全性 | `completeness.gapless` と slot 範囲 | `slot_range_has_gaps` |
| 確定性 | `finality: 'finalized'` | `not_finalized:<finality>` |

経路の一覧はコードから取った：`CARAVAN_SENT` を出すのは `permutation-frontier/src/proc/caravan.rs` の `send_caravan`（0xB1）と、`settle_raid` の TAKE 分岐（奪った隊商を襲撃者の隊商として出し直す）の 2 か所。③（composability）は SendCaravan が別プログラムからの CPI でも呼べること、`frontier-node` の verify がトップレベルの命令しか集めないことを示した。だから、トップレベルだけを読む索引では CPI の経路を覆えない。

**未発送と未到着は別。** 割当てた隊商が出発していて精算記録がなければ、coverage が十分でも `settle_unobserved`（未確認）であり、`not_sent` にはならない。coverage に載っていて誰も割当てていない、約束の場所への隊商があれば `unassigned_caravan`（未確認）。偽の申告の判定（§6）も、十分な coverage があるときだけ行う。

## 3. 約束と配送を推測で結び付けない（v3：割当は署名付きの入力）

- 割当は会話の act ではなく、**署名付きの `allocation` 記録**（`m.allocate`）。署名する内容は `{domain, world, by, op: set|revoke, commitment, caravan, qty, nonce, bell, visibility}` の正規 JSON で、ed25519 署名を呼び出し側が渡す鍵登録（tag → 公開鍵。本線では名簿）で検証する。会話の本文や act では割当できない（`allocate` act は存在しない）。
- 検証に通らないものは拒否する：`auth_bad_signature`（他人になりすまし、署名後の改変、別の世界やシーズン向けの署名）、`auth_unknown_signer`。journal を再生するときにも検証し直すので、ファイルを書き換えた割当は読み込めない。
- **nonce（署名者ごとの通し番号）**：同じ操作の再送は `duplicate`（観測時刻が違っても同じ）。同じ nonce で中身が違えば `nonce_reused` で拒否。署名者・約束・隊商ごとに、**nonce が最大の操作が有効**。到着順ではない。訂正は大きい nonce の `set`、撤回は大きい nonce の `revoke`。古い操作を再送しても戻らない。
- 割当を数えるのは当事者（債務者・債権者）の有効な `set` だけ。第三者は `not_a_party`。両者の数量が違う、または一方だけが撤回しているときは `disputed`、数量は小さいほう。
- 隊商の容量は、有効な割当の署名順に全約束で消費する。超えた割当は `over_allocated`。訂正や撤回で空いた分は他の約束が使え、同じ量が二度数えられることはない。
- 割当の公開範囲も署名に含める（約束が私的なら当事者だけ）。

## 4. 加算量は、当該配送だけの加算として導ける根拠があるときだけ（v3）

`settle_caravan`（`permutation-frontier/src/proc/caravan.rs`）を読んだ結果：

| 宛先 | コードの動き | ⑫の扱い |
|---|---|---|
| 村（holding、kind 1） | 同じ時刻までの生産を精算した後、`Holding::credit` → `Store::add` で積荷を全量加算（上限なし。`holding.rs` の注記「may exceed the cap」） | **規則 `holding-credit-uncapped/v1` で⑫が導く**。`basis: rule_derived`、単位 `whole_units`、精度「milli 単位の切り捨て。正確な下限」、入力は settle 記録の id |
| 倉（vault、kind 2） | `min(have + c, max(cap, have))`。加算量はその瞬間の在庫と上限で決まり、記録に残らない | ④の **実行記録**（`caravan_credited`、`basis: exec_record`、単位、settle 命令の `exec: {sig, ix}`）があるときだけ。無ければ `qty_unverified`（`credit.basis: none`） |

- **口座残高の前後差（`account_diff`）は記録として受け付けない**。並行する入出庫・生産・消費が混ざるため。
- 村宛てで④の実行記録が規則と食い違えば `record_conflict`（どちらかを選ばない）。
- 複数の約束で 1 隊商を分けていて加算が足りないとき、内訳は推測しない。下限と上限を持たせ、`qty_split_ambiguous` にする。
- 受取人は精算時点の所有者（`place_owner` の区間）で判断する。世代が違う場所は別の場所（`misdirected`）。

## 5. 発生時刻と観測時刻、再評価（v3：遅着と新しい行為を分ける）

- 全記録に `bell`（発生）と `created_bell`（観測）を持たせる。`created_bell < bell` は拒否。期限内かどうかは精算の発生 bell で判断する。
- 判断記録には、ポリシーに見せた**入力そのもの**と `input_sha256` を保存する。元の判断と当時見えていた情報は書き換えない。
- `m.reassess(id, observedBy)` は判断時点の bell で判断し直し、次を分けて返す：

| 区分 | 定義 | 扱い |
|---|---|---|
| `late_arrivals` | 判断時点までに**起きていた**ことが、判断後に観測された（`bell ≤ 判断 bell < created_bell ≤ observedBy`） | 使う |
| `later_events` | 判断後に**起きた**こと（新しい約束、割当、配送） | 一覧に出すが、過去の判断の評価には使わない |
| `backdated` | 判断後に記憶へ入ったのに、判断前に観測したと称する記録 | 矛盾として除外し、一覧に出す |

- `then_reproducible`：判断記録より前に journal にあった記録から、同じ入力（同じハッシュ）が再現できるか。
- 判断後に初めて割当て・配送した善行は、今の評価では `late` として残るが、過去の判断の再評価は変えない（テスト済み）。

## 6. 評判と観測の不足を分ける

- `E, r, s`：**確認済みの根拠だけ**の Beta 推定（仮の重み）。`fulfilled` r+1、`late` r+0.5・s+0.5、`partial` r+f・s+(1−f)、`not_sent` s+1、偽の申告 s+0.5。
- `verified`・`claims`・`unresolved`・`neutral`・`mismatches`・`evidence[]` を別に出す。

偽の申告（`contradicted`、信頼度に入る）の基準は 2 つだけで、どちらも §2 の十分な coverage が前提：

| 基準 | 内容 |
|---|---|
| `caravan_absent_in_complete_index` | 名指しした隊商が、約束から申告までを覆う十分な coverage に無い |
| `no_caravan_to_place_in_complete_index` | 隊商を名指ししない申告で、十分な coverage に、約束から申告までに送り主から約束の場所への発送が無い |

食い違い（`mismatch`、表示するが数えない）：`caravan_of_another`、`caravan_to_other_place`、`premature`（猶予 2 bell）、`not_delivered_by_record`。「送った」と「届いた」は別に判定する。

## テストとの対応

| 指摘 | テスト（抜粋） |
|---|---|
| v3-1 加算量の根拠 | `credit: a balance difference … is refused`、`credit: a village (holding) delivery is credited by the pinned rule…`、`credit: an execution record that disagrees…`、`credit: a vault delivery without 4's execution record stays unverified…`、`credit: a capped vault credit is partial only once…` |
| v3-2 未発送の証明 | `not sent: only a sufficient coverage proves it…`（world・season・program・cluster・finality・gapless・各経路・区間・送り主・world 未設定）、`not sent: a claim is judged false only against a sufficient coverage`、`not sent is not "not arrived"…` |
| v3-3 割当の認証 | `allocation: what a message says allocates nothing…`、`…a resend is a duplicate, a reused nonce…`、`…operations that arrive out of order…`、`…a correction and a revoke free capacity…`、`…concurrent allocations…`、`…the debtor revokes and the creditor still allocates…`、`…an edited journal line fails verification…` |
| v3-4 再評価 | `reassess: late arrivals of past facts are used; events after the decision are listed…; backdated records are excluded`、`reassess: a good deed done after the decision does not rewrite the past judgement` |
| caution の表示 | `caution is labelled as not an honesty judgment…` |
| v2 の指摘 | `test/evidence.test.mjs`（記録遅延、並行取引、部分履行、未検証量、受取人変更、観測欠落、訂正後の回復、偽の判定基準） |

v2 の 25 か所に加え、v3 で 19 か所（合計 44 か所）の防御を 1 つずつ壊し、毎回少なくとも 1 件のテストが失敗することを確認した。v3 で追加したのは、残高差を受理、村の食い違いを無視、倉に村の規則を適用、world・finality・gapless・経路の検査、world 未設定、不十分な coverage を使用、追記時と再生時の署名検証、nonce 再使用、到着順で有効化、撤回の無視、撤回と設定の食い違いを隠す、world を署名に含めない、backdated を使用、新しい行為を混入、caution の表示を反転。再現は `sh workstreams/12-memory/tools/mutate.sh`、記録は保存パッケージの `test-results/mutation-check.txt`。
