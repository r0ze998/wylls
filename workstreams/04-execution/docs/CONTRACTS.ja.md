# 契約案：Run・Event・Receipt と、各担当への引き渡し

**版：④ 0.2（2026-10-30）。** この文書の項目は、すべて**提案**である。確定した契約はまだ一つもない。②③⑤⑥の最新の報告（`dc3bd3d`、`47b05ac6`、`ba3c180b`、`517796dc`＋ADDENDUM）は取得できておらず、接続済みではない（[HANDOFF](HANDOFF.ja.md) §0、§4）。②の StockSwap は④の施設使用と別の契約である（HANDOFF §1）。

| 相手 | 担当 | ④から見た状態 |
|---|---|---|
| ① | 国の制度・進捗 | 提案（§9）。①の制度は作り直さない |
| ② | 施設の利用権 | **未受領。④の提案のみ**（§4）。②の成果物が届くまで、④は独自の仕様を確定しない |
| ③ | 実行経路と正本の読み取り | **未受領。④の提案のみ**（§5）。同上 |
| ⑤ | AI の参加、AI staking、予算、手動と自動の切替 | 提案（§6） |
| ⑥ | 作成、公開、再利用 | 提案（§7） |
| ⑦ | プレイヤー体験、UI/UX、表示の正確性 | 提案（§8） |

（前版では⑤⑥⑦を「表示・AI・監視」と推測して書いていた。上の担当表に訂正した。）

`src/ports.rs` の `Chain` と `Rights` は、②③の契約が届くまでの**仮の adapter 境界**である。模擬正本（`src/sim.rs`、MOCK）だけが実装している。届いた契約と食い違えば、④の側を合わせる。

## 1. Run（④が所有する）

| 欄 | 型 | 意味 |
|---|---|---|
| `run_id` | string | 依頼者が決める冪等キー。同じ id で同じ spec なら同じ run を返す。spec が違えば `Conflict` |
| `owner` | u64 | 依頼者の `citizen_tag` |
| `stock` | Place | 材料が届き、産出物が出る場所（依頼者のもの） |
| `inbound` | (owner_tag, seq)? | 材料を運んでくる隊商 |
| `facility` | {Place, recipe} | 使う施設（②の対象） |
| `inputs` / `outputs` | [u64; 8] | 整数単位 |
| `rights_units` | u64 | 1 回の使用で消費する利用権の単位 |
| `ship` | {dst: Place, cargo} | 送り先（世代を含む）と荷 |
| `deadline_slot` | u64 | この slot 以降は新しい attempt に署名しない |
| `budget` | {max_attempts, max_fee, max_port_errors} | 停止条件 |

Place は S1 の `Place` 記録に合わせる（kind、p、q、at、gen）。世代は識別子の一部である。

外部に見せるもの：
- 状態（15）：[STATE-MACHINE](STATE-MACHINE.ja.md)。
- 保留の印（`held_reason`）。
- 取消の段階（`cancel_phase`）：`StoppingNew`、`AwaitingSigned{until}`、`Completed{effects}`、`Ineffective{at}`。
- 結果（`outcome`）：`delivered`（検証できた量。`None` は検証できない）、`verification`、`cargo_logged`（上限であり、入荷量ではない）、`effects`（停止までに起きた正本の変化）。
- 費用（`fees`）：§6.2。

## 2. Event（④が読む。③と findex に要求する）

| 種類 | 必須の欄 |
|---|---|
| `FacilityUsed` | key、sig、slot、consumed、produced、rights_units |
| `CaravanSent` | (owner_tag, seq)、**sig**、src、dst、**積んだ cargo（損耗の後）**、arrive |
| `CaravanSettled` | (owner_tag, seq)、outcome、dst、cargo、**credited / lost（提案 P1）**、slot |
| `CaravanRaided` | (owner_tag, seq)、choice、raider、taken、slot |
| `PlaceSeized` | place、new_gen、slot |

- 一意の id（sig ‖ 命令の位置 ‖ log の位置）で重複を除く。どの順序で届いてもよい。
- event は hint と証拠であり、状態は正本の読み取りで決める。
- feed に欠落があれば、開いている run を全部見直し、entity 履歴を読む。

## 3. Receipt（④が作る）

```json
{ "run_id": "...", "kind": "facility_used|caravan_sent|caravan_raided|caravan_settled",
  "subject": "fac:<run_id> | cv:<owner_hex>:<seq>",
  "source": "sig:<sig> | event:<id> | history:<id>",
  "slot": 123, "body": { ... } }
```

- **Receipt は過去の出来事の証拠であり、今も資源が残っていることの証明ではない。** 次の段階は、正本の在庫と利用権を読み直してから進む。
- `caravan_sent` は、自分の署名が着地したことと、記録の中身（送り元、宛先、資源、量）が spec と一致したことの両方を確認してから作る。`(owner, seq)` が一致するだけでは作らない。
- `caravan_settled` の `cargo` は上限である。入った量は `credited`（P1）か規則（holding）からだけ得る。

## 4. ②（利用権）への要求（提案。②の成果物を待つ）

④は `Rights::check(holder, facility, units) → Allowed{remaining, expires_slot} | Expired | Insufficient{remaining} | None` を仮定している。

| # | 要求 | 理由 |
|---|---|---|
| ②-R1 | 検査は、ある時点の残量を返す読み取りであること。予約や lock は求めない | 予約は④が run store の中で行う |
| ②-R2 | **施設の使用と同じ原子的な処理の中で、利用権を再検査し、消費すること** | 検査から着地までの間に失効しうる |
| ②-R3 | 失効と不足を区別できる拒否コード | 扱いが違う |
| ②-R4 | 利用権の識別子を安定させること | 予約のキーに使う |

## 5. ③（実行経路と正本）への要求（提案。③の成果物を待つ）

| # | 要求 | 現行 chain での状況（基準 commit） |
|---|---|---|
| ③-R1 | 施設要求の要求キーによる重複拒否と、キーによる記録の検索 | 施設の命令は無い（MOCK、P3）。SendCaravan は (owner_tag, seq) で満たしている |
| ③-R2 | 在庫の読み取りは min_slot 以降の値であり、holding は `stock_at(now)` で精算した値であること | `ChainPort::accounts(keys, min_slot)` で読める。精算は adapter の仕事 |
| ③-R3 | 署名を送信の前に確定すること。**署名済みのワイヤのバイト列を返し、④がそれを保存し、同じバイト列を再送できること**。`valid_until` を返すこと | Solana の tx と blockhash（151 slot）で満たせる |
| ③-R4 | `status(sig)` は Landed{fee} / Failed{fee} / Pending / Absent / Unavailable を区別すること。**Absent は、対象期間（blockhash の slot から `valid_until` まで）を覆い、欠落が無いと保証でき、確定（finalized）した履歴を照会して見つからない場合に限る**（[HANDOFF](HANDOFF.ja.md) §3）。一つでも保証できなければ Unavailable を返す。履歴の欠落や照会不能を、失敗の確定・未課金・再署名可能として扱わない | `getSignatureStatuses`（`searchTransactionHistory`）と tx meta の fee で作れる見込み。完全性と確定性を adapter が保証できるかは**未確認** |
| ③-R5 | 事前検査で拒否した要求を転送しないこと。**ただし④は、拒否された署名済みのバイト列を、有効期間が終わるまで「着地しうる」と扱う**（別の経路のコピーが着地しうるため） | RPC の `skipPreflight=false` |
| ③-R6 | 実行者の鍵は委任された session key であること。他人宛ての SendCaravan は chain が拒否する（[SIGNATURES](SIGNATURES.ja.md)） | 満たしている。ただし session key には命令の範囲の指定が無い（P6） |
| ③-R7 | entity 履歴を返し、`CaravanSent` に sig を含めること | findex の entity 索引はある。sig を含むかは未確認 |
| ③-R8 | settle の記録に入った量と失われた量を載せること | **未対応**（P1） |
| ③-R9 | seq の不一致を専用のコードで返すこと | `BadData` と区別できない（P2）。④は必須にしない |

## 6. ⑤（AI の参加、AI staking、予算、手動と自動の切替）への引き渡し

### 6.1 自動で行えること

- AI が作れるのは `RunSpec` だけである。進軍、襲撃、包囲、押収、投票は `Request` で表せず、許可表にも無い。ただしこれは **off-chain の制限**であり、session key 自体は session 可の命令すべてに署名できる（SIGNATURES §3）。
- 自動では**自分の場所の間の送付だけ**を行う。他人宛ては wallet 署名待ちの保留になる。
- `run_id` を冪等キーとして使う。応答が無いときに新しい id で出し直さない。

### 6.2 費用の契約（予約・確定・未確定）

run ごとの費用は、attempt の表から計算する（`Store::fees`、`FeeBook`）。

| 区分 | 意味 | 予算への算入 |
|---|---|---|
| `reserved`（予約） | 署名済みで、まだ着地しうる attempt の手数料。事前検査で拒否されたものも、有効期間の間は含める | 算入する |
| `charged`（確定費用） | chain が報告した、着地した attempt（成功・失敗とも）の手数料 | 算入する |
| `unconfirmed`（未確定費用） | 着地した、または失敗として着地しうるが、手数料が報告されていない attempt（status の履歴が使えない、seq を他人に使われた後のコピーなど）。上限値として扱う | 算入する |
| `released`（解放） | ③-R4 の条件で不在と確認された attempt。**予算の予約を解放しただけで、返金ではない**（もともと課金されていない） | 算入しない |

- **期限だけで「未課金」と判断しない。** `released` に移すのは、status が `Absent`（③-R4 の条件を満たすもの）を返したときだけである。`Unavailable` の間は `reserved` か `unconfirmed` のままにする。
- 手数料は relay の payer（運営者の SOL）が払う。依頼者の残高やゲーム内の資源への換算は⑤が決める。④は lamports で記録するだけである。
- 予算の判定は `reserved + charged + unconfirmed + 次の attempt の手数料 ≤ max_fee`。
- 手動と自動の切替：手動に戻すと（agent wallet の `manual`）、新しい要求は止まる。**署名済みの要求は止まらない**（§8.2 の取消と同じ限界）。session の回収は wallet の `SetSession` で行う。

## 7. ⑥（作成、公開、再利用）への引き渡し

- 他人が作った仕組みの成果を「使えた」と数えるのは、正本で確定した段階だけにする（`FacilityConfirmed` の Receipt、検証済みの `delivered`）。
- `DeliveredUnverified` の run は、検証済みの量が 0 なので**算入量は 0** とする。ただし**実際の到着量を 0 や全損と記録・表示しない**（実際の量は「分からない」。上限 `cargo_logged` は参考値として別に表示する）。算入量と実際の到着量の状態は別の欄にする（[HANDOFF](HANDOFF.ja.md) §2）。`Partial` は検証された量だけを数える。
- 取消や期限切れの run でも、`outcome.effects` に記録された変化（施設が使われた等）は実際に起きている。「使われなかった」と数えない。

## 8. ⑦（プレイヤー体験、UI/UX、表示の正確性）への引き渡し

### 8.1 状態の言い方

| 表示 | 根拠 |
|---|---|
| 「発送を依頼した」 | ShipRequested |
| 「発送を受け付けた（未確定）」 | ShipSubmitted |
| 「輸送中 n 個」（n は積んだ量 `sent_cargo`） | InTransit |
| 「到着した」 | Arrived 以降 |
| 「届いた n 個」 | Fulfilled、または Partial（`delivered`、検証済み） |
| 「到着したが、入った量を確認できない（最大 n 個）」 | DeliveredUnverified。**「届いた」「一部届いた」とは表示しない** |

### 8.2 取消の言い方（取消と実際の資源の変化を矛盾させない）

| `cancel_phase` | 表示 | 資源 |
|---|---|---|
| `StoppingNew` | 「取消を受け付けた。新しい要求は出さない」 | まだ変わりうる |
| `AwaitingSigned{until}` | 「送信済みの要求が slot {until} まで成立しうる。確認待ち」 | まだ変わりうる |
| `Completed{effects}` | effects が空なら「取消した。何も変わっていない」。空でなければ「取消した。ただし取消の前に {effects} が成立した」 | 確定 |
| `Ineffective{at}` | 「輸送中のため取り消せない」 | 道の結果に従う |

### 8.3 その他

- 保留中の run は、理由と、人に必要な操作（送信者本人の wallet 署名、`resume`、`cancel`）を表示する。
- 部分輸送の時間を、不足分が全部そろう時間として表示しない。
- 共有 UI は④では変更しない（P4）。

## 9. ①（国の進捗）への引き渡し

数量の単位・精度・確度・合計の目標の判定は [QUANTITY-CONTRACT](QUANTITY-CONTRACT.ja.md) が正本（この節より優先）。

- 国の目標の進捗に数えてよいのは、**検証済みの到着量**（`verification` が `Recorded` または `RuleDerived` の `delivered`）だけである。`RuleDerived` は整数の**下限**であり、正確な量ではない（記録は milli の加算量の切り捨て。①の `qtyKind: 'lower-bound'` と同じ扱い。[RECONCILE-20261030c](RECONCILE-20261030c.ja.md) §2）。
- `DeliveredUnverified` は**進捗への算入量を 0** とする。これは実際の到着量を 0 と断定することではない（実際の量は不明）。`cargo_logged` を進捗に足さない（[HANDOFF](HANDOFF.ja.md) §2）。
- `ShipSubmitted` と `InTransit` は「見込み」であり、進捗ではない。
