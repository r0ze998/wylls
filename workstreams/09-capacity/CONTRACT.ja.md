# ⑨ 加工能力の貸し出し：接続契約（版 0.3）

作業日 2026-10-30。基準 commit `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（作業開始時の HEAD は `921429322d5aecd1a3df0dd8d82c405c87dd985a` = `main`、未 commit 変更なし。`4cd901de` は文書だけの 6 commit 先で、早送りで合わせた）。

この文書は、⑨が実装より先に公開した**接続面**です（版 0.1 は commit `9b801368`、実装の前）。版 0.2 は実装に合わせた改訂で、変更点は §9 にまとめます。④（統合）へは操作・状態・イベント・エラー、⑩（預かり・所有権）へは必要な入出力と不変条件、⑥（作成画面・手順）へは再利用できる加工手順を渡します。版 0.1 は「仮」で、⑩・④から資料が来たら差し替える箇所を §6 に挙げます。

> **区別の約束。** ここでの「実装済み」は `kernel/`（純 Rust、`permutation-rules` の実物の `Holding`・工房定数・隊商の歩行を使う）で動いて試験された、という意味です。**オンチェーンの命令はまだ無い**（§5 に不足するコア命令を具体化）。預かりは ⑩ の資料が無いので **模擬（`MockCustody`）** です。

## 1. 何を貸すのか（コードに合わせた定義）

S1 のコードでは、工房は「1日に何回動かす」施設ではなく、**連続変換**です（`permutation-rules/src/frontier/arms.rs`、`holding.rs`）。工房 1 棟は 1 時間に兵器 4 を作り、兵器 1 につき鉱石 2・木材 1 を使います。施設の能力は「工房の棟数 × 時間」です。

したがって⑨の貸す単位は **工房 1 棟分の連続変換能力（以下「枠」= 1 unit）** とし、利用は「枠数 k × 期間 [start, end)」で予約します。

| 用語 | 意味 | 型（`kernel/src/model.rs`） |
|---|---|---|
| 所有者（owner） | 施設（Holding）の持ち主。貸し出し・許可・取消をする | `Actor` |
| 利用者（user） | 許可を受けて加工を予約・投入・受取する人 | `Actor` |
| 施設 ID と世代 | Holding の住所（P, Q, site）と `GEN`。占領・解放で世代が変わると、旧世代への許可・予約はすべて無効 | `FacilityId { p, q, site, gen }` |
| レシピ | 入力と出力と速度。S1 は 1 種（`RECIPE_ARMS`：鉱石 2 + 木材 1 → 兵器 1、枠 1 つで兵器 4/時） | `Recipe`, `RecipeId` |
| 貸出枠（pool） | 所有者が自分の連続生産から外して貸し出しに回した工房の棟数 `lent`。外した分は所有者自身の生産から引かれる | `Pool` |
| 許可（grant） | 所有者 → 利用者。レシピ、同時枠の上限、出力総量の上限、期間 [from, until) | `Grant` |
| 予約・加工（job） | 利用者が許可の範囲で取る `k` 枠 × [start, end)、出力上限 `max_output` | `Job` |
| 数量 | すべて milli 単位（`fixed::MILLI` = 1000）。兵器 1 = 1000 | `i64` |

### 二重使用を起こさない規則（最重要）

1. 所有者の Holding の兵器生産は `production[ARMS] − lent × WORKSHOP_DELTA` で回る（コアのパッチ 0001）。貸出枠に入れた工房は、所有者の連続生産から**同じ時刻に**外れる。連続生産を放置して別口で増やすことはない。
2. 予約は貸出枠の中だけで取れる。任意の時刻 t で「その時刻を占める予約の枠の合計 ≤ `lent`」。
3. 所有者は、将来のどの時刻でも予約に使われていない枠だけを取り戻せる（`Reclaim`）。
4. 加工は利用者が投入した材料（ホッパー）だけを使う。所有者の倉の鉱石・木材は使わない（材料が混ざらない）。

## 2. 操作（④へ）

全操作は `Ledger::apply(now, signer, op)` に渡ります（`kernel/src/ledger.rs`）。オンチェーンでは各操作が 1 命令になる想定です（§5）。

| 操作 | 署名者 | 引数 | 効果 |
|---|---|---|---|
| `OpenPool` | 所有者 | facility, policies | 施設の世代ごとの貸出枠を作り、§4 の方針を固定する |
| `Lend` | 所有者 | facility, units, seq | 所有者の工房 `units` 棟を貸出枠へ。Holding を owner touch し、`lent += units` |
| `Reclaim` | 所有者 | facility, units, seq | 将来の占有の最大 ≤ `lent − units` なら、`lent −= units` |
| `Grant` | 所有者 | grant_seq, user, recipe, max_units, max_output, from, until | 許可を作る |
| `Revoke` | 所有者 | grant | 新しい予約を止める。未開始の予約は方針（§4）に従う。加工中は止めない |
| `Reserve` | 利用者 | job_seq, grant, units, start, end, max_output | 予約。許可・期間・枠・出力予算・離席方針を検査 |
| `Deposit` | 利用者 | job, deposit_id, resource, amount, from | 利用者の置き場 `from` から預かり（ホッパー）へ。開始前だけ |
| `Cancel` | 利用者 | job | 開始前：全額返却。加工中：その時刻まで精算し、以降の枠を返す |
| `Settle` | 誰でも | job | 純関数で現在までの出力を確定（何度呼んでも同じ） |
| `Claim` | 利用者 | job, to | 確定した出力と（終わった予約なら）返却材料のうち、未受取分を `to` へ。加工中でも出来た分は受け取れる |
| `FacilityLost` | 誰でも（コアの観測） | facility | コアが記録した世代の終わり（時刻 `at` と占領者）で全予約を締め、損失方針（§4）で配分 |
| `Retire` | 誰でも | job | 終わって全部を渡し終えた予約の記録を閉じる。出力は許可の `spent` に残る |
| `RetireGrant` | 誰でも | grant | 取り消されたか期限が来て、予約が残っていない許可を閉じる |
| `RetirePool` | 誰でも | facility | 失われた世代で、予約が残っていない貸出枠を閉じる |

再送・再起動の扱い：

- **自然キー。** 許可は `(facility, grant_seq)`、予約は `(grant, job_seq)`、投入は `(job, deposit_id)`。同じキーで**同じ中身**の再送は `AlreadyApplied`（状態不変）、**違う中身**は `Conflict`。オンチェーンでは PDA の住所がこのキーになる。
- **所有者の増減は楽観的な番号。** `Lend`/`Reclaim` は増減なので自然キーが無い。`seq` が貸出枠の `owner_seq` と同じときだけ適用し、直前と同じ操作の再送は `AlreadyApplied`、それ以外の古い番号は `Conflict`。
- **時刻は戻らない。** 適用した最後の時刻より前の操作は `TimeReversed`。失敗した操作は何も変えない（時刻も進めない）。
- **出力は時刻の純関数。** `Settle` を何回・どの順で呼んでも同じ値（経路独立。`Holding::settle` と同じ考え方）。
- **受取は差分。** `Claim` は「確定量 − 受取済み」だけを渡す。2 回目は `AlreadyApplied`（0）。
- **状態は Borsh で保存できる。** 途中で保存・復元しても結果は変わらない（試験 `restart_*`）。

## 3. 状態とイベント（④へ）

### 予約の状態（時刻から導く部分と、保存する部分）

```
Booked ──(now ≥ start)──▶ Running ──(now ≥ end_eff)──▶ Completed
  │                          │
  ├─Cancel──▶ Cancelled      ├─Cancel──▶ Cancelled（その時刻まで精算）
  ├─Revoke(CancelBooked)─▶ Cancelled
  └─FacilityLost─▶ Lost      └─FacilityLost─▶ Lost（at まで精算）
```

`Booked` と `Running` は保存せず時刻から導きます（`Job::phase(now)`）。保存するのは `Open` と終端（`Completed{at}`、`Cancelled{at}`、`Lost{at}`）だけです。

**出力の式（閉じた形）。** 開始時刻にホッパーが固定される（開始後の投入は拒否）ので、

```
limit   = min(max_output, ore / 2, wood / 1, k × 4000 × (end − start) / 3600)   [milli]
out(t)  = min(limit, ⌊k × 4000 × (min(t, end) − start) / 3600⌋)
end_eff = start + ⌈limit × 3600 / (k × 4000)⌉  （ただし ≤ end）
消費     = 鉱石 2 × out、木材 1 × out（ちょうど。端数は出ない）
```

材料不足は `limit` を下げ、早く終わります（`end_eff < end`）。早く終わった枠は `end_eff` から空き、他の予約に使えます。材料が兵器 1 未満なら `limit = 0`、開始と同時に終わり全額返却です。

### 各時点の材料と成果物の場所（`Place`）と所有者

| 時点 | 材料（鉱石・木材） | 成果物（兵器） |
|---|---|---|
| 投入前 | 利用者の Holding／倉（利用者のもの） | — |
| 運搬中 | 利用者の隊商（`InTransit`、利用者のもの。襲撃されうる） | — |
| 投入後・開始前 | `Hopper(job)`：施設の場所にある預かり。**所有は利用者** | — |
| 加工中 | ホッパー残（利用者）＋ `Consumed`（消費済み） | `Output(job)`：施設の場所。**所有は利用者** |
| 終了後・未受取 | ホッパー残 → `Refund(job)`（利用者） | `Output(job)`（利用者） |
| 受取後 | 利用者が指定した場所（`Claim` の宛先） | 同左 |
| 施設喪失 | 損失方針で、利用者か占領者へ | 同左 |

### イベント（`kernel/src/event.rs`）

`PoolOpened`, `Lent`, `Reclaimed`, `Granted`, `Revoked{cancelled}`, `Reserved`, `Deposited`, `Started`, `Settled{out, used[鉱石, 木材], total}`, `Completed`, `Cancelled`, `Lost`, `Claimed{output, refund[鉱石, 木材], to}`, `Forfeited{output, refund, to, owner}`（喪失で占領者へ移った分）, `FacilityLost{at, captor}`。預かりの移動は ⑩ 側の記録（模擬では `custody::Move` の列）で、保存則の検査はこの列から再計算できます。

### エラー（安定コード。`kernel/src/error.rs`）

| コード | 名前 | いつ |
|---|---|---|
| 1 | `NotOwner` | 所有者でない者が Lend/Reclaim/Grant/Revoke |
| 2 | `NotUser` | 許可の利用者でない者が Reserve/Deposit/Cancel/Claim |
| 3 | `WrongGeneration` | 施設の世代が許可・予約と違う（占領・解放の後） |
| 4 | `FacilityGone` | 施設が失われた後の操作 |
| 5 | `NotEnoughWorkshops` | Lend が工房の棟数 − 既に貸した数を超える |
| 6 | `CapacityExceeded` | 予約の期間内のどこかで、占有 + k > lent |
| 7 | `ReclaimBlocked` | 取り戻すと将来の予約が貸出枠を超える |
| 8 | `GrantUnitsExceeded` | 同じ許可の重なる予約の枠合計が max_units を超える |
| 9 | `GrantOutputExceeded` | 予約の出力上限の合計が max_output を超える |
| 10 | `OutsideGrantWindow` | [start, end) が [from, until) に入らない |
| 11 | `GrantRevoked` | 取り消された許可で予約 |
| 12 | `BadWindow` | start ≥ end、start < now、長すぎる、units = 0 |
| 13 | `AlreadyStarted` | 開始後の投入 |
| 14 | `AlreadyFinal` | 終わった予約の Cancel・投入 |
| 15 | `UnknownGrant` / 16 `UnknownJob` | |
| 17 | `Conflict` | 同じキーで違う中身 |
| 18 | `OwnerAway` | 離席方針 `RefuseNewWhenDormant` で、所有者が休眠中に予約 |
| 19 | `WrongRecipe` / 20 `WrongResource` | |
| 21 | `TooMany` | 固定長の表（予約・投入）が満杯 |
| 22 | `Custody` | ⑩ の預かりが拒否（残高不足など） |
| 23 | `Overflow` | |
| 24 | `TimeReversed` | 前に適用した操作より前の時刻 |
| 25 | `UnknownPool` | 貸出枠・施設が無い |
| 26 | `FacilityLive` | 世代が終わっていない施設に `FacilityLost` |
| 27 | `BadPlace` | `Claim` の宛先が予約の置き場（`Hopper`／`Output`）。帳簿の外に物が残るのを防ぐ |
| 28 | `Retired` | 閉じた記録、または最大以下の番号（番号は増えるだけ） |
| 29 | `GenerationReused` | `u8` 世代番号が一周し、同じ施設 ID の終了履歴がある。2026-11-05 の隔離統合候補では退役後も同じ ID の新規貸出を拒否する |
| 30 | `NotRetirable` | 閉じる条件を満たさない |

## 4. 未決定の損失配分（仮案。切り替え可能）

方針は `Lend` のときに貸出枠へ固定します（後から利用者に不利に変えられない）。`kernel/src/policy.rs`。

| 項目 | 選択肢 | 既定（仮） | 理由 |
|---|---|---|---|
| 施設喪失（占領・解放）のとき、施設にあるホッパー残と未受取の出力 | `CaptorTakesAll`／`UserKeepsAll`／`UserKeepsOutput`（出力は利用者、材料は占領者） | `CaptorTakesAll` | 段階2 §5 の決定（倉が奪われたら札は無効、中身は奪った側）に揃える。施設のそばに物を置く危険が遊びになる |
| 所有者の離席（休眠） | `Unaffected`／`RefuseNewWhenDormant` | `Unaffected` | 貸出枠は所有者が先に約束したもの。所有者がいなくても利用者が加工できることがこの機能の要点 |
| 所有者の取消（Revoke）と未開始の予約 | `HonorBooked`／`CancelBooked` | `HonorBooked` | 予約した利用者はすでに材料を運んでいる。加工中は方針によらず止めない |

解放（`RELEASE_AFTER` の後の第一 Holding）は施設喪失として扱い、`captor` は「なし」（`CaptorTakesAll` でも占領者がいないので、利用者へ返す）。

## 5. 不足するコア命令（④へ。具体案は `patches/`）

既存の命令だけでは「所有者の署名なしに、利用者が他人の工房で加工して受け取る」ことはできません。

1. **Holding に貸出数 `lent` が無い**（`patches/0001-holding-lent-workshops.patch`、`permutation-rules` の変更として独立）。`RSV_700`（4 バイト、未使用）を `LENT_WORKSHOPS u32` にする案。工房の棟数（`copy_number`）は `production[ARMS]` から数えるので、`production` を書き換えて貸すことはできない（Build の費用が狂う）。
2. **CapacityPool／Grant／Job の口座と 10 命令**（`patches/0002-core-instructions.ja.md`）。
3. **ホッパーと出力の置き場**：⑩ の預かりに依存。暫定は「施設の隣のタイルに置いた利用者の倉（Vault）」との出し入れに写す案（隊商は既存の SendCaravan で他人の村へ届く、PR #20）。

## 6. ⑩ の預かりへの要求（入出力と不変条件）

⑨ は汎用の預かり台帳を確定させません。必要な口だけを trait `Custody`（`kernel/src/custody.rs`）として出し、模擬 `MockCustody` で動かします。

### 入出力

| 呼び出し（`Custody` trait） | 入力 | 出力 | 意味 |
|---|---|---|---|
| `import` | key, at, owner, resource, amount | — | コアから預かりへ入る（Holding が払った隊商の荷、到着） |
| `transfer` | key, by（`Kernel` か本人）, from, to, resource, amount, owner | — | 置き場の間の移動。投入（本人 → `Hopper`）、受取・返却・喪失（`Kernel`: `Hopper`/`Output` → 宛先） |
| `consume` | key, at（`Hopper`）, resource, amount | — | レシピの入力を使う（`Kernel` だけ） |
| `produce` | key, at（`Output`）, owner, resource, amount | — | レシピの出力を作る（`Kernel` だけ） |
| `export` | key, by, at, resource, amount | — | 預かりからコアへ出る（Holding への入庫） |
| `balance` | at, resource | owner, amount | 照会 |
| `forget` | scope（予約の uid） | — | 閉じた予約の冪等キーを捨てる（版 0.3。継続世界で鍵の記録を有界にする） |

版 0.1 の `lock`／`release` は、`transfer` の二つの向きにまとめた（同じ不変条件で足りるため）。

### 不変条件（⑨ の試験が検査し、⑩ の実装にも求める）

- **C1 非負。** どの置き場の残高も 0 未満にならない。
- **C2 保存則。** 資源ごとに「全置き場の合計 + 消費済み − 生産済み」が一定。
- **C3 レシピ。** 生産 = 消費 ÷ レシピ比（兵器 1 = 鉱石 2 = 木材 1）。job ごとにちょうど成り立つ。
- **C4 権限。** ホッパー・出力から動かせるのは job の主体（⑨ のカーネル）だけ。所有者 A も動かせない。
- **C5 所有の明示。** 各ロットに所有者が付き、`release` でだけ変わる。
- **C6 冪等。** 同じ `key` の `lock`/`release` は 2 回目に何もしない。
- **C7 一括移転。** 施設喪失の移転は job 単位で全部か無しか。

## 7. ⑥ へ：再利用できる加工手順（`kernel/src/plan.rs`）

「他人の工房で加工してもらう」を、数字を入れれば使える手順にします。`plan(recipe, units, want_output, depart_at, travel_secs)` が次を返します。

1. 必要な材料：`ore = 2 × want`, `wood = 1 × want`。
2. 加工時間：`⌈want × 3600 / (units × 4000)⌉` 秒。
3. 最早の開始：材料の到着（`depart_at + travel_secs`）以後。到着前に開始すると材料不足で早く終わる。
4. 終了と受取：`end_eff` 以後に `Settle` → `Claim` → 帰りの隊商。

手順（人でも AI でも同じ。所有者の鍵は使わない）：

1. 所有者が `Lend` と `Grant` を一度だけ署名（以後は離席してよい）。
2. 利用者が自分の材料を隊商で施設へ送る（既存の SendCaravan）。
3. 利用者が `Reserve`（到着後に開始）。
4. 到着した材料を `Deposit`。
5. 時間が経つ（誰も署名しなくてよい）。
6. 誰かが `Settle`、利用者が `Claim`、帰りの隊商。

失敗の分岐：運搬中の襲撃（材料が届かない → 材料不足で 0 出力、全額返却）、開始前の取消、加工中の取消、施設喪失（§4）、許可の取消（§4）。

## 8. 版と差し替え点

| 箇所 | 今 | 差し替え |
|---|---|---|
| 預かり | `MockCustody`（模擬） | ⑩ の実装 |
| 許可 | ⑨ の `Grant`（施設の利用に限る） | ② の Grant が汎用になれば、⑨ の `Grant` はその「施設利用」の種類として写す |
| 所有者の工房 | パッチ 0001 を当てた `Holding`（試験は一時 worktree で実行）／当てない場合は写し（§ README） | コアに入れば直接 |
| 命令 | 無し（カーネルのみ） | 0002 の案を ④ が割り当て |

## 9. 版 0.1 → 0.2 の変更

- `OpenPool` を足した（方針を最初に固定する口。0.1 では `Lend` の中で暗黙だった）。
- イベントを実装に合わせた（`Moved` は ⑩ 側の記録へ、`Forfeited`・`PoolOpened`・`FacilityLost` を追加）。
- `Lend`/`Reclaim` に楽観的な番号 `seq` を足した（増減の再送で二重に貸さないため）。
- `Deposit` に `from`、`Claim` に `to` を足した（場所を明示するため）。`FacilityLost` の `at`・`captor` は引数ではなく、コアの記録から読む（送り手が時刻を偽れないように）。
- エラー 24–27 を足した。
- ⑩ への口を `import`/`transfer`/`consume`/`produce`/`export`/`balance` に整理した。

## 10. 継続世界（版 0.3、2026-10-31）

世界は期間で終わらない（[CONTINUITY.ja.md](CONTINUITY.ja.md)）。この契約は次を保証する。

- 開始・終了・期間の概念を持たない。戦期の境界で、どの操作も拒否しない（`Op::class()` は所有者・利用者・誰でも、の 3 種）。
- 記録は閉じられる（`Retire*`）ので、施設ごとの状態は有界。許可・予約の番号は増えるだけで、閉じた番号は再利用されない（`Retired`）。
- 予約ごとに再利用しない uid を持ち、預かりの冪等キーの範囲にする。⑩ への口に `forget(scope)` を足した。
- 許可は必ず有限で、自動延長しない。許可の期限は世界の寿命と別。
