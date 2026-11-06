# 数量契約（④の正本、2026-10-30）

隊商が運んだ量・入った量・進捗に数える量を、どの単位・精度で、何を根拠に述べるかの約束。④の実装（`src/model.rs` の `Outcome`・`Verification`、`src/executor.rs` の `on_arrived`）はこの文書に従う。他の文書（CONTRACTS §9、HANDOFF §2、STATE-MACHINE「到着量の判定」）と食い違うときは、この文書を正とする。

**範囲**：①③⑦⑫⑮に揃えてほしい点は §7 に**提案**として書いた。④は他の担当の作業を変更していない。各担当の採否は確認していない。

すべて MOCK とローカルの実証（SQLite、模擬正本、実際の gateway のコード＋模擬チェーン）による。実チェーンでは確かめていない。

## 1. 単位と丸め（program の実物から）

| 量 | 単位 | 丸め | 根拠 |
|---|---|---|---|
| program 内部の資源（holding の `Accrual`、vault の `VA::store`、caravan の `CV::cargo`） | milli（1 単位＝1000）、`i64` | なし | `permutation-rules/src/fixed.rs` `MILLI` |
| SendCaravan の命令の cargo | 整数単位 `u32` → ×1000 で milli | なし | `frontier-abi/src/v2/ix.rs:165` `cargo_milli` |
| 損耗 | milli に `v − floor(v × bps / 10000)` | 損耗分を切り捨て（残りは切り上げ側） | `permutation-rules/src/frontier/structure.rs:245` `wear` |
| 記録の cargo（CARAVAN_SENT・SETTLED・RAIDED） | 整数単位 `u32` | **`floor(milli / 1000)`**（負は 0、`u32` で飽和） | `permutation-frontier/src/proc/caravan.rs:401-407` `cargo_log` |
| holding への加算 | milli、上限なし、全量 | なし | `holding.rs:296`（`Accrual::add`）、`proc/caravan.rs:994` |
| vault への加算 | milli、`CAP` で切り捨て、捨てた分は記録されない | — | `proc/caravan.rs:1003-1007`（:1005） |
| burn | caravan の milli をすべて 0 にする | — | `proc/caravan.rs:1223-1227` |
| take | 全量のまま持ち主と宛先を襲撃者に書き換える（持ち主の書き換えは take だけ） | — | `proc/caravan.rs:1229-1305`（`OWNER_CITIZEN` は :1282） |

④の `Res`（`[u64; 8]`）は**整数単位**である。milli は扱わない。

## 2. 一つの run について区別する四つの量

| 量 | ④の欄 | 意味 |
|---|---|---|
| 記録の量 | `outcome.cargo_logged` | settle の記録の cargo（整数、切り捨て）。holding では入った量の下限、vault では入った量の上限（＋1 未満） |
| 検証した量 | `outcome.delivered` ＋ `outcome.verification` | 下の §3 の確度つき。`None` は「分からない」 |
| 進捗に数える量 | （①⑥が決める。④の提案は §5） | 検証した量の下限だけ |
| 実際の量 | （誰も直接は持たない） | §3 の区間でだけ述べる |

**「進捗に数えない」と「実際に 0 だった」は別である。** 進捗への算入が 0 でも、実際の量は「分からない」または「0 以上」でありうる。実際に 0 と言えるのは §3 の `KnownZero` だけ。

## 3. 確度（`verification`）と、実際の量の区間（資源ごと、整数単位）

| `verification` | 根拠 | `delivered` | 実際に入った量 |
|---|---|---|---|
| `RuleDerived` | holding へ DELIVERED（加算は全量、記録は切り捨て） | `Some(b)`：記録の cargo | **［b, b＋1）**。b＝0 でも 0 とは限らない |
| `Recorded` | 記録の `credited`（P1。今の④は案 B＝整数の切り捨てとして読む） | `Some(b)` | ［b, b＋1）。P1 案 A（milli）なら正確（§6） |
| `Unverifiable` | vault へ DELIVERED、`credited` 無し | `None` | ［0, cargo_logged＋1）。**分からない**（`DeliveredUnverified`） |
| `KnownZero` | 証拠がある 0：この隊商の burn の記録（milli も 0）、この隊商の take の記録または口座の持ち主の変更、settle の outcome LOST | `Some(0)` | **ちょうど 0**（spec の宛先について） |
| `NotShipped` | 送っていない | — | 0（送付がない） |

**証拠の条件（R-1、2026-10-30 に修正）**：

- 記録の cargo が全部 0 なだけでは `KnownZero` にしない。1 未満の端数も 0 と記録される。この隊商（同じ owner・seq）の CARAVAN_RAIDED BURN の記録があるときだけ 0 と断定する。feed に無ければ、隊商の entity 履歴からも探す。
- 別の宛先で settle しただけでは「奪われた」としない。この隊商の CARAVAN_RAIDED TAKE の記録（または隊商の口座の持ち主が別の Citizen になっていること。take だけがそれを書き換える）があるときだけ `Raided` とする。無ければ `DestinationMismatch`（原因未確認）で保留にする。量は述べず、**誰の名前も出さず、責任や評判に使わない**。
- 他の caravan の記録や、別の種類（burn と take）の記録は証拠にしない。
- 回帰試験：`tests/arrival.rs` の `fraction_below_one_unit_is_not_known_zero`（0.9 単位入った。記録は 0、Partial、下限 0、宛先に 900 milli が実在）、`burn_record_from_history_makes_zero_known`、`destination_mismatch_without_raid_record_is_unconfirmed`、`raid_record_must_match_the_caravan_and_the_kind`、`tests/faults.rs` の `inbound_fraction_is_not_reported_lost`。旧い判定に戻す変異 4 件はすべて検出する。

## 4. Fulfilled／Partial は何に対する判定か

- 比べる量は**この run の依頼量**（`spec.ship.cargo`、資源ごと、整数単位、損耗の前）と、§3 の下限 b。
- `Fulfilled`：すべての資源で b ≥ 依頼量。実際の量も依頼量以上（証明）。
- `Partial`：どれかの資源で b < 依頼量。依頼量は整数なので b＋1 ≤ 依頼量で、実際の量 < b＋1 ≤ 依頼量。**この run については依頼量に届いていない**（証明）。
- ただし Partial は、**複数の run を足した目標の未達を意味しない**。各 run の実際の量は［b, b＋1）なので、n 本の run の合計は［Σb, Σb＋n）にある（資源ごと）。例：0.9 単位が 2 本 → 各 b＝0、合計 1.8。目標 1 は達成しているが、Σb＝0。
- 合計の目標について言えること（目標 G、対象の run がすべて確定していて、対象外の入荷を含めない場合）：
  - Σb ≥ G なら達成（証明）。
  - Σb＋n ≤ G なら未達（証明。n は RuleDerived・Recorded の run の数。KnownZero の run は 0 で、端数を持たない）。
  - その間は**判定できない**（「未達」と表示しない）。`DeliveredUnverified` の run が一つでもあれば、上限は cargo_logged＋1 未満まで広がる。

## 5. 進捗への算入（①⑥への提案）

- 算入してよいのは `Fulfilled`・`Partial` の `delivered`（下限）だけ。`DeliveredUnverified` は算入 0、ただし実際の量は「分からない」と記録・表示する（0 や全損とは書かない）。
- `DestinationMismatch` で保留の run は、算入 0、状態は「原因未確認」。
- 後で P1 などで検証できた場合に算入を増やすかは①⑥の判断。

## 6. P1（未適用）との関係

P1 の案は [patches/README.ja.md](../patches/README.ja.md) P1。単位・精度・丸め・範囲は、**案 A（milli、正確）と案 B（整数の切り捨て、下限）のどちらか一つ**にし、混ぜない。案 A なら §3 の `Recorded` は正確な量になり、§4 の合計の目標も、各 run の量を足して判定できる。案 B は今の扱いと同じ（下限）。

## 7. 各担当に揃えてほしい点（提案。④は他の担当の作業を変えていない）

| 担当 | 受け取った版（照合済み） | 揃っている点 | 揃えてほしい点 |
|---|---|---|---|
| ① 国の戦略・国をまたぐ協力 | `3f3c8478`（以後の `f5a953b` は未受領） | 村あては記録の cargo を下限とする（`qtyKind: 'lower-bound'`）。倉あては未検証で、残高から推し量らない | (a) 合計の目標は §4 の三つの区分（達成・未達・判定できない）で判定する。下限の和が目標未満なだけで「未達」としない。(b) `misdelivered`（別の宛先で settle）は、take の記録が無ければ「原因未確認」と表示し、相手の責任や評判に使わない。(c) チェーンの記録からの `raided-burned`／`raided-taken`（①の `coop/arrival.mjs` 96-97 行）は CARAVAN_RAIDED を根拠にしていて一致。(d) ただし、ヘラルドの一覧からの判定に R-1 と同じ形の推定が 2 か所ある（どちらも量は数えないので、算入には影響しない）：125 行は「襲撃の印＋cargo が全部 0 ⇒ `raided-burned`」（1 未満の積荷も 0 と表示されうる）、128 行は「行き先が依頼の届け先と違う ⇒ `raided-taken`（奪われたとみられる）」（襲撃の証拠なし）。後者は「原因未確認」とし、相手の名前や評判に結び付けないことを提案する |
| ③ 実行経路・正本 | `acdcd0bf`（以後の `a361a30f` は未受領） | — | ③ 10-handoff §3.5 の「vault の前後の残高の差」は採らない（他の入出庫が混ざる。④ INVARIANTS）。量の確度は §3 の名前で返す |
| ⑦ プレイヤー体験・表示 | 前回受領分（⑦ v2 `1f2d7419`）。表示の実装は照合していない | — | RuleDerived・Recorded の量は「n 個以上」と表示する。`DeliveredUnverified` は「入った量を確認できない（最大 n 個＋端数）」。`DestinationMismatch` は「別の場所に着いた（原因を確認中）」。「奪われた」「0 個」「全損」と表示しない |
| ⑫ | **④は⑫の担当範囲の定義も成果物も受け取っていない** | — | 照合していない。⑫の資料が届いたら、§2〜§4 の区別を基準に照合する |
| ⑮ 協力の達成・勝利の評価器 | 予告のみ（成果物は未受領） | RuleDerived を下限とする既定（⑮の連絡）は、この文書と一致する（④の旧い「正確な量」が誤りだった） | (a) `verification` は Receipt の body ではなく Run の `outcome` にある。(b) 襲撃の欄名は `raider`（`raider_tag` ではない）。(c) Receipt の重複は `kind|subject` で除く（同じ出来事を feed と entity 履歴の両方から読むと `source` が違う）。(d) 判定は §4 の三つの区分 |
