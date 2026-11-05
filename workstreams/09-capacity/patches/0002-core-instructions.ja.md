# 0002 加工能力のコア命令（④へ。**案。未実装**）

`kernel/` の操作（`Op`）を、Frontier プログラムの命令に写す案です。カーネルの状態遷移と検査（`kernel/src/ledger.rs`）をそのまま命令の本体にする想定で、命令ごとの口座・引数・署名者・エラーを決めます。タグ・CU・Herald の形は ④ が割り当てます（ここでの番号は仮）。

前提：パッチ 0001（`Holding.lent_workshops`、`LENT_WORKSHOPS @ 700`）が入っていること。

> **継続世界の訂正（2026-10-31、[CONTINUITY.ja.md](../CONTINUITY.ja.md)）。** この案の口座は、世界が続く間変わらない鍵から作る（R2。どの鍵かは ④ の共通方針に従う。今のコアの `AddrCtx::of` はシーズンの鍵から作るので、そのままでは使わない）。命令は戦期の境界で拒否しない（R1。今の `player_prologue` は `end_bell` 以後のプレイヤー命令をすべて拒否する）。境界で口座を閉じない（R3）。

## 1. 口座

| 口座 | PDA の種 | 大きさ（概算） | 中身 |
|---|---|---|---|
| **CapacityPool** | `cp ‖ P(i16) ‖ Q(i16) ‖ site(u8) ‖ gen(u8)` | 約 1.3 KB | 施設 ID と世代、owner Citizen、方針 3 バイト、`lent u32`、`owner_seq u32`、直前の所有者操作の hash 32、`lost_at i64`、captor 32、許可 8 件（seq u32, user 32, recipe u8, max_units u32, max_output i64, from i64, until i64, revoked_at i64 = 73 B）、**占有表** 16 件（job_seq u64, units u32, start i64, occ_end i64, open u8 = 29 B） |
| **CapacityJob** | `cj ‖ pool ‖ grant_seq(u32) ‖ job_seq(u32)` | 約 260 B | user、recipe、units、start、end、max_output、hopper[2]、投入 8 件（id u64, input u8, amount i64）、fin（種別 u8 + 時刻 i64）、settled、claimed、refunded、**暫定の預かり残高**（hopper 残 2、output 1） |

- 占有表を Pool に持つのは、`Reserve` と `Reclaim` の検査（任意の時刻で占有 ≤ lent）を 1 口座で済ませるため。Job を全部読まずに済む。占有の終わり `occ_end` は、開始前は `end`、開始後と終了後は `end_eff`（開始時に hopper が固定されるので計算できる）。`SettleJob`・`CancelJob` が書き直す。
- **暫定の預かり**：⑩ の預かりが来るまで、ホッパーと出力の残高を CapacityJob 自身に持つ（Job が預かり主体）。⑩ が来たら、この 3 つの残高を ⑩ の口座への CPI に置き換える（`kernel/src/custody.rs` の trait がその境界）。

## 2. 命令（タグは未割当。④ が割り当てる）

> **2026-11-05：仮タグを取り下げた。** 下の表の `0xC1`〜`0xCE` は並びの目印にすぎない。⑧ の `0xC1 ExtendFrontier`、⑩ の `0xC1–0xCB` と衝突していたため、⑨ は番号を主張せず、④ の共有 ABI の割当に従う（[CONNECT-10.ja.md](../CONNECT-10.ja.md) §4 D7）。⑩ の区画から材料を取る場合、`DepositToJob` は ⑩ の区画と倉の口座を加え、同じトランザクションで ⑩ の `consume` を呼ぶ（同 §2）。

| 仮タグ | 命令 | 種別 | 署名者 | 口座（w = 書込） | 引数 | 主なエラー（`CapError` → プログラムのコードは ④） |
|---|---|---|---|---|---|---|
| 0xC1 | OpenCapacityPool | P | owner の財布 | owner, Citizen, Holding, Province（占領中の検査）, Pool(w, 作成), System | policies(3 B) | NotOwner, WrongGeneration（占領待ち `CapturePending` と同じ検査） |
| 0xC2 | LendCapacity | P | owner の財布 | owner, Citizen, Holding(w), Province, Pool(w) | units u32, seq u32 | NotEnoughWorkshops, Conflict（seq） |
| 0xC3 | ReclaimCapacity | P | owner の財布 | 同上 | units u32, seq u32 | ReclaimBlocked, Conflict |
| 0xC4 | GrantCapacity | P | owner の財布 | owner, Citizen, Holding, Pool(w) | grant_seq, user(Citizen key), recipe, max_units, max_output, from, until | BadWindow, TooMany, Conflict |
| 0xC5 | RevokeCapacity | P | owner の財布 | owner, Citizen, Pool(w), [未開始の Job(w)…]（CancelBooked のとき） | grant_seq | UnknownGrant |
| 0xC6 | ReserveCapacity | P | user（session 可の候補） | user, Citizen, Holding（世代・休眠）, Pool(w), Job(w, 作成), System | grant_seq, job_seq, units, start, end, max_output | CapacityExceeded, GrantUnitsExceeded, GrantOutputExceeded, OutsideGrantWindow, GrantRevoked, OwnerAway, BadWindow |
| 0xC7 | DepositToJob | P | user | user, Citizen, **出どころ（施設の隣の user の Vault）(w)**, Pool, Job(w) | deposit_id u64, resource u8, amount u64 | AlreadyStarted, WrongResource, Custody（Vault の残高不足） |
| 0xC8 | SettleJob | N（誰でも） | 手数料の支払者だけ | Pool(w: 占有表), Job(w), Holding（世代） | — | WrongGeneration |
| 0xC9 | CancelJob | P | user | user, Citizen, Pool(w), Job(w) | — | AlreadyFinal |
| 0xCA | ClaimJob | P | user | user, Citizen, Pool, Job(w), **宛先（施設の隣の user の Vault）(w)** | — | （受け取るものが無ければ何もしない） |
| 0xCB | RecordFacilityLoss | N | 手数料の支払者だけ | Pool(w), Holding（GEN・CAPTURED_BELL・STATE）, [Job(w)…], 宛先（占領した Holding）(w) | — | FacilityLive |
| 0xCC | RetireJob | N | 手数料の支払者だけ | Pool(w), Job(w, 閉じる), 家賃の受取人 | — | NotRetirable（加工中・未受取） |
| 0xCD | RetireGrant | N | 手数料の支払者だけ | Pool(w) | grant_seq | NotRetirable（予約が残る、期限前で取消なし） |
| 0xCE | RetirePool | N | 手数料の支払者だけ | Pool(w, 閉じる), 家賃の受取人 | — | NotRetirable（世代が生きている、予約が残る） |

**番号と鍵（継続世界）。** grant_seq は Pool ごと、job_seq は許可ごとに増えるだけ（閉じた番号への操作は `Retired`）。Job には再利用しない uid を持たせ、預かりの冪等キーの範囲にする（Job の口座と一緒に閉じる）。世代が一周したときに古い世代の Pool が残っていれば `OpenCapacityPool` は `GenerationReused`。

**種類と境界。** 所有者・利用者の命令（0xC1–0xC7, 0xC9, 0xCA）も、誰でも送れる命令（0xC8, 0xCB–0xCE）も、戦期の境界では拒否しない。特に `CancelJob`・`ClaimJob`（物を返す・渡す）は、どの状態でも通す。

**材料の出入口の暫定案（既存の実経路につなぐ）。** S1 には、他人の村へ届く隊商（PR #20）と、タイルに置く Vault がすでにある。利用者は施設の隣のタイルに**自分の Vault** を建て、隊商で材料をそこへ送る（BuildVault は村の site のタイルそのものを拒むが、州の持ち主や距離は検査しない。`proc/caravan.rs` `build_vault`。設計 14 の「自分の村の土地は持ち主だけが建てられる」とは食い違うので、コードに従った）。`DepositToJob` はその Vault から Job へ、`ClaimJob` は Job からその Vault へ移す。持ち帰りは既存の SendCaravan。これで「運搬と襲撃の遊び」（決定ログ 29 の A2）が残り、新しい運搬命令は要らない。⑩ の預かりが来たら、Vault の代わりに ⑩ の口座を使う。

**喪失の時刻。** 占領は `Holding.CAPTURED_BELL`（その bell の開始時刻）、解放は `last_owner_action + release_after_secs`（`LifecycleParams`）。どちらも Holding から決まるので、`RecordFacilityLoss` を誰がいつ送っても同じ結果になる。占領の処理（`proc/conquest.rs`）はパッチ 0001 で `lent_workshops = 0` にする。解放（ReleaseDormant）された Holding は閉じられるので lent は残らないが、④ で確認が要る。

## 3. 検証器・Herald・予算

- **検証器（V 番号は ④）**：(a) 任意の時刻で占有 ≤ lent、(b) lent ≤ 工房の棟数、(c) Job ごとに settled = 閉じた式の値、消費 = レシピ × settled、(d) 預かりの保存則、(e) Holding の兵器の率が `production − lent × WORKSHOP_DELTA` に従う（0001 の `settle` をそのまま再生すれば成り立つ）。改ざんの種類の候補：占有の水増し、settled の水増し、claimed の巻き戻し、喪失後の受取。
- **再生検証器はトップレベル命令しか集めない**（③ の発見 4）。CPI で呼ぶ外部の組合などを認めるなら、同じ変更が要る。
- **Herald**：`h/capacity.json`（施設ごとの lent、空き枠の時間表、許可の一覧、Job の状態）。
- **CU・取引の大きさ**：未測定。Reserve の占有検査は 16 件の掃引で軽いはず。RevokeCapacity（CancelBooked）と RecordFacilityLoss は Job を複数書くので、Job 数に上限（16）と、口座の列挙を分ける必要がある。
- **ルールの hash**：0001 は lent = 0 なら結果を変えないので、版を上げていない。命令を入れるときに `HOLDING_VERSION_V4` を上げるか、S2 の版を立てるかは ④ の判断。

## 4. カーネルとの対応

| カーネル | 命令 |
|---|---|
| `Op::OpenPool` | 0xC1 |
| `Op::Lend` / `Op::Reclaim` | 0xC2 / 0xC3 |
| `Op::Grant` / `Op::Revoke` | 0xC4 / 0xC5 |
| `Op::Reserve` | 0xC6 |
| `Op::Deposit` | 0xC7 |
| `Op::Settle` | 0xC8 |
| `Op::Cancel` | 0xC9 |
| `Op::Claim` | 0xCA |
| `Op::FacilityLost` | 0xCB |
| `Op::Retire` / `Op::RetireGrant` / `Op::RetirePool` | 0xCC / 0xCD / 0xCE |

カーネルの `World::apply` が「失敗したら何も変えない」のは、取引の失敗と同じ扱い。自然キー（grant_seq, job_seq, deposit_id）は PDA の住所と Job 内の投入表になる。
