# 契約案：Run・Event・Receipt と、②③⑤⑥⑦への引き渡し

**状態：提案（④の版 0.1）。** ②（利用権）と③（実行経路）からは、まだ契約を受け取っていない。この文書は④から見た**必要条件**を書いたもので、②③の設計を確定するものではない。②③の契約が届いたら、adapter（`src/ports.rs` の `Chain` と `Rights`）を合わせ、食い違いはこの文書に記録する。

⑤⑥⑦の担当範囲は、依頼文に書かれていない。そのため、各節は**受け手の役割**（表示、AI・自動化、監視・検証）で書いた。番号との対応が違っていれば、指摘を受けて直す。

## 1. Run（④が所有する）

| 欄 | 型 | 意味 |
|---|---|---|
| `run_id` | string | 依頼者が決める冪等キー。同じ id で同じ spec なら同じ run を返す。spec が違えば `Conflict` |
| `owner` | u64 | 依頼者の `citizen_tag` |
| `stock` | Place | 材料が届き、産出物が出る場所（依頼者のもの） |
| `inbound` | (owner_tag, seq)? | 材料を運んでくる隊商（任意） |
| `facility` | {Place, recipe} | 使う施設（②の対象） |
| `inputs` / `outputs` | [u64; 8] | 整数単位 |
| `rights_units` | u64 | 1 回の使用で消費する利用権の単位 |
| `ship` | {dst: Place, cargo} | 送り先（世代を含む）と荷 |
| `deadline_slot` | u64 | この slot 以降は新しい attempt に署名しない |
| `budget` | {max_attempts, max_fee, max_port_errors} | 停止条件 |

Place は S1 の `Place` 記録に合わせる：`kind`（1 holding、2 vault）、`p`、`q`、`at`（site または tile）、`gen`。**世代も識別子の一部**として扱う。

外部に見せる状態は [STATE-MACHINE](STATE-MACHINE.ja.md) の 14 状態と、保留の印（`held_reason`）。`detail` には `ship_seq`、`sent_cargo`、`outcome{delivered, credit_unverified, note}`、`reason`、`settle`、`raid` を記録する。

## 2. Event（④が読む。③と findex に要求する）

| 種類 | 必須の欄 | 一意の id |
|---|---|---|
| `FacilityUsed` | key, sig, slot, consumed, produced, rights_units | sig ‖ 命令の位置 ‖ log の位置 |
| `CaravanSent` | (owner_tag, seq), **sig**, src, dst, **積んだ cargo（損耗の後）**, arrive | 同上 |
| `CaravanSettled` | (owner_tag, seq), outcome, dst, cargo, **credited（提案）**, slot | 同上 |
| `CaravanRaided` | (owner_tag, seq), choice, raider, taken, slot | 同上 |
| `PlaceSeized` | place, new_gen, slot | 同上 |

規則（`Executor::ingest`）：
- 一意の id で重複を除く（`events` テーブルの主キー）。**どの順序で届いてもよい**。位置（`pos`）は cursor にだけ使う。
- event は hint と証拠である。状態は event から直接変えず、正本の読み取りで決める。
- feed に欠落がある（`gap`）場合は警告を記録し、開いている run を全部見直す。見直しでは entity 履歴（findex の entity 索引）を読む。

## 3. Receipt（④が作る。⑤⑥⑦が読む）

```json
{ "run_id": "...", "kind": "facility_used|caravan_sent|caravan_raided|caravan_settled",
  "subject": "fac:<run_id> | cv:<owner_hex>:<seq>",
  "source": "sig:<sig> | event:<id> | history:<id>",
  "slot": 123, "body": { ... } }
```

- **Receipt は過去の出来事の証拠であり、今も資源が残っていることの証明ではない**。施設の Receipt に「武器 3 を産出」とあっても、次の段階は正本の在庫を読み直してから進む（不変条件 R6）。
- id は `(run_id, kind, subject, source)` のハッシュ。何度記録しても一件になる。
- `caravan_settled` の `body.credited` が無い場合（現行 chain）、入った量は**未確認**である。表示や AI はこれを全量到着として扱わない。

## 4. ②（利用権）への要件

④は `Rights::check(holder, facility, units) → Allowed{remaining, expires_slot} | Expired | Insufficient{remaining} | None` を呼ぶ。

| # | 要件 | 理由 |
|---|---|---|
| ②-R1 | 検査は、ある時点の正本の残量を返す読み取りであること（予約や lock を求めない） | 予約は④が run store 内で行う。②の状態を④が書き換えない |
| ②-R2 | **施設の使用と同じ原子的な処理の中で、利用権を再検査し、消費すること** | 検査から着地までの間に失効しうる（`rights_expire_while_in_flight`） |
| ②-R3 | 失効と不足を区別できる拒否コード | 失効は失敗にする。不足は、他の run の予約が原因なら待つ |
| ②-R4 | 利用権の id、または (holder, facility) の対応を安定させる | 予約のキーに使う |

## 5. ③（実行経路と正本の読み取り）への要件

`Chain` trait（`src/ports.rs`）を参照。

| # | 要件 | 現行 chain での状況 |
|---|---|---|
| ③-R1 | **要求キーによる重複拒否**：施設要求には `key` を持たせ、同じ key の二度目は効果なしで拒否する（`AlreadyDone`）。key から正本の記録を引けること（`facility_use(key)`） | 施設の命令は無い（MOCK）。SendCaravan は (owner_tag, seq) で満たしている |
| ③-R2 | 在庫の読み取りは、ある slot 以降の正本の値であり、holding は `stock_at(now)` で精算した値であること | keeper の `ChainPort::accounts(keys, min_slot)` で読める。精算は adapter で行う |
| ③-R3 | 署名を送信の前に確定すること（署名済みのバイト列を返す `prepare`）と、有効期間の終わり（`valid_until`）を返すこと | Solana の tx と blockhash で満たせる（151 slot） |
| ③-R4 | `status(sig)` は Landed / Failed / Pending / Absent / Unavailable を区別すること。**Absent は「有効期間を過ぎ、もう着地しない」の意味に限る** | `getSignatureStatuses` と blockhash の有効期間から作れる（keeper `start()` と同じ判定） |
| ③-R5 | 事前検査（preflight）で拒否した要求は転送しないこと | RPC の `skipPreflight=false` |
| ③-R6 | 実行者の署名鍵は、自動化を許した命令しか送れないこと（`policy::AUTOMATABLE`）。他人宛ての SendCaravan は wallet が要る | relay の allow-list と session key で満たせる（S1-1B §3.3、§4.5） |
| ③-R7 | entity 履歴（`caravan_history`）を返すこと。`CaravanSent` には sig を含めること | findex の entity 索引がある。sig を含めるかは未確認 |
| ③-R8 | SettleCaravan の記録に、実際に入った量（`credited`）を載せること | **未対応**（patches P1） |
| ③-R9 | seq の不一致を専用のコードで返すこと | **`BadData` と区別できない**（patches P2）。④は正本の読み取りで判断しているので、必須ではない |

## 6. 表示（⑤と想定）への引き渡し

- 状態ごとの言い方は、STATE-MACHINE の「発送と到着を混同しない」の表に従う。`ShipSubmitted` を「輸送中」と表示しない。
- 量は、依頼量（`ship.cargo`）、積んだ量（`sent_cargo`）、届いた量（`outcome.delivered`、未確認の印つき）を分けて表示する。部分輸送の時間を、不足分が全部そろう時間として表示しない（引き継ぎの確認事項 2）。
- 保留中の run は、理由と、人に必要な操作（wallet の署名、`resume`、`cancel`）を表示する。
- 共有 UI の変更は④では行わない。表示の案は patches P4。

## 7. AI・自動化（⑥と想定）への引き渡し

- AI が作れるのは `RunSpec` だけである。進軍、襲撃、包囲、押収、投票の命令は、`Request` で表せず、許可表にも無い（`policy`）。**④は攻撃や進軍を自動で始めない**。
- AI は `run_id` を冪等キーとして使う。応答が無いときに新しい id で出し直さない（二重の依頼になる）。同じ id で出し直せば同じ run が返る。
- AI が判断に使ってよいのは、正本の読み取りと Run の状態である。Receipt を残量として扱わない。

## 8. 監視・検証（⑦と想定）への引き渡し

- 監視の窓口は `Store::status`（`runexec status`）。状態ごとの件数、保留の一覧、未決の attempt の数、最も古い未完の run の経過、警告の件数、feed の cursor を返す。
- 検証者は次を突き合わせる。run store の `transitions`（version ごとに一件）、`attempts`（署名・要求キー・有効期間）、`receipts`（出典つき）と、chain 上の記録（verify の V23 caravans）。照合の手順は [RUNBOOK](RUNBOOK.ja.md) §4。
- 不一致の型：①Receipt があるのに正本の記録が無い。②一つの要求キーに二つの着地がある（あってはならない）。③終端の run が予約を持っている。
