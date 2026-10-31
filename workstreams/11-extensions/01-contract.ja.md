# 01 拡張の最小契約（④⑥⑨⑩②への受け渡し、初版）

**位置づけ。** 第三者（利用者・AI）が作った機能を世界に足すときに、各担当の間でそろえる最小の型。案 B（宣言型の効果、[02](02-comparison.ja.md)）を前提に書くが、manifest・権限・版・結果の型は案 C でも使える形にした。コード上の正本は [`ext-kernel/src`](ext-kernel/src) で、この文書と食い違う場合はコードが正しい。

**担当の境界。** ⑥の公開・採用・版管理は作り直さない。ここで決めるのは「⑥の登録簿が最低限持つべき欄」だけ。④の Run、⑨⑩の資源・権限の契約は受領していないので、§4・§6 は差し替え点として書く（[00](00-context.ja.md) §3）。

## 1. Manifest（作者 A が公開する定義）

正準の byte 列で固定し、その SHA-256 を**唯一の識別子**とする。名前・作者・版番号は表示用で、識別には使わない。

```text
manifest_id = sha256("WYLLS-EXT-MANIFEST" ‖ 0x00 ‖ canonical_bytes)

Manifest v1 = {
  magic:         "WXM1"
  schema:        u8 = 1          // manifest の書式版
  effect_set:    u8 = 1          // 使える効果の語彙の版（§2）。検証器が知らない値は UNVERIFIABLE
  core:          { program_version: u16, ruleset_hash: [u8;32] }  // 前提とするコアの版
  author:        [u8;32]         // 公開の署名者（表示と停止権限）
  name:          utf8 ≤ 32 B
  fields:        ≤ 8 × { min: i64, max: i64, init: i64 }   // 拡張が持つ状態。利用者ごとに 1 組
  max_instances: u32             // 状態を持つ利用者数の上限（過大な状態作成の防止）
  pay_cap:       [i64; 8]        // 1 回の呼出しでコア資源を出させる上限（milli）
  entries:       ≤ 4 × { id: u8, args: ≤ 4 × { min, max }, ops: ≤ 32 × Op }
}
```

公開時の静的検査（`Manifest::validate`）: 上限（fields/args/ops/大きさ 1,024 B）、未知の op、範囲外の field・arg 参照、`pay_cap` の負値、`min ≤ init ≤ max`。**分岐・ループ・外部呼出しの op は存在しない**ので、1 回の実行は高々 32 op で止まる。

## 2. 効果（effect_set = 1、コアが解釈する閉じた語彙）

| op | 意味 | コア資源への作用 | 拒否 |
|---|---|---|---|
| `Require(cmp, a, b)` | 条件。偽なら呼出し全体を取り消す | なし | `RequireFailed` |
| `Set(field, x)` / `Add(field, x)` | 拡張の状態を書く（checked、`min..max`） | なし | `FieldBounds`、`Overflow` |
| `Pay(res, x)` | 呼出し者自身の Holding から預け入れ（`Holding::pay`）→ その利用者の escrow | 減（預かり） | `Insufficient`、`PayCap`、`GrantCap` |
| `Refund(res, x)` | escrow から同じ利用者の Holding へ戻す（`Holding::credit`） | 増（預かりの返却のみ） | `EscrowInsufficient` |
| `Burn(res, x)` | Holding から消費（戻らない） | 減（消費） | 同 Pay |
| `Emit(code)` | 結果に記録を 1 つ足す | なし | — |

オペランド: 定数、引数、field、`now_bell`（コアが渡す取引時刻からの鐘）、escrow の残量。

**できないこと（意図的）:** コア資源の発行（mint）、他人の Holding・escrow への書込、他の拡張の状態の読み書き、コア命令の呼出し、乱数、時刻以外の外部入力。資源の総量は「Pay で預かった分を Refund で戻す」か「Burn で減らす」しかなく、拡張は残高を自由に書けない。

## 3. 実行状態の登録簿（⑪の系列。⑥の公開状態とは別）

> **⑥の回答（2026-10-30）を反映。** ⑥の公開状態（登録簿の項目＝作者＋名前ごとの listed / suspended / withdrawn。作者の公開停止は新しい採用と依存だけを止め、採用済みの計画は固定した版のまま動く）と、ここでの**実行状態**（Active / Paused / Revoked、新しい呼出しを拒否する）は別の系列として持つ。自動で写像しない（Paused＝suspended としない）。検証器の「停止中の呼出しは Fail」は実行状態の系列だけを見る。

```text
Registration = {
  manifest_id, author, status: Active | Paused | Revoked,
  supersedes: Option<manifest_id>,   // 更新は「新しい id の登録」。古い id の意味は変わらない
  history: [(ts, status)]            // 検証器が「停止中に実行された呼出し」を見つけるため
}
// ⑥の提案に合わせる場合（未実装）: 各記録を { 対象 manifest_id, 状態, 権限者, 理由, 時刻, 番号 } にする
```

| 操作 | 誰が | 効果 | 実行済みの効果 |
|---|---|---|---|
| 公開 | 作者 | 静的検査を通った manifest を Active で登録 | — |
| 更新 | 作者 | 新しい id を `supersedes` 付きで登録。古い id はそのまま | 変わらない。利用者の許可は古い id に固定 |
| 一時停止／再開 | 作者・運営（緊急停止） | 新しい呼出しを拒否／再開 | 変わらない。escrow は `Withdraw` で戻せる |
| 取消 | 作者・運営 | 恒久的に拒否 | 変わらない。escrow は `Withdraw` で戻せる |

`Withdraw`（コア定義の出口、拡張のコードを実行しない。r3 で改訂）:
- **開く条件**（`exec::exit_reason`、コア側と検証器が同じ関数を使う）: (1) 実行状態が Paused / Revoked、(2) その利用者の Grant が無い・取り消し・期限切れ・回数切れ、(3) manifest の `core` が今のコアの版と違う。どれでもなければ閉じている（manifest 自身の entry が返却の道）。r2 までは (1) だけで、Grant の期限切れやコアの更新で預かりが取り出せなくなる穴があった。
- **一度だけ**: 返却後に instance を `closed` にする（状態の hash に含む）。閉じた instance はどの entry も実行せず（`InstanceClosed`）、2 度目の出口も拒否。預かりが 0 なら `NothingToWithdraw`。
- **行き先**: 署名者は Citizen の wallet か期限内の session、行き先はその Citizen が所有するどの Holding でもよい（最初の Holding を失っていても戻せる）。他人の Holding は `NotOwner`。
- receipt の `events` に開いた理由（1 停止、2 Grant の終了、3 コアの版の変更）を 1 byte 残す。
- 利用者は自分の Grant をいつでも取り消せるので、**v1 の預かりは利用者が自分でいつでも取り戻せる**（「見張りの誓い」の時間の縛りも、利用者自身が破れる）。v1 の op は預かりを他人に約束しないので、これで他人は損をしない。利用者をまたぐ op を足すなら（effect_set 2）、この性質を見直す必要がある。

**Grant の更新も検証の対象（r3）。** Grant の書き換えは呼出しの記録の列のどこで起きたか（`grant_log: (位置, Grant)`）と、最終状態（`grants_after`）を検証器に渡す。Grant の更新の順序を入れ替えても結果が変わらない場合（例: 停止中の出口の前後の取り消し）は、記録からは区別できない。チェーン上では slot の順で決まる。

## 3a. 継続世界（r4）

- 世界は終わらない。拡張の状態・Grant・預かり・receipt の鎖は、所有者の**変わらない識別**で引き、期間ごとに作り直される口座のアドレスでは引かない（根と対応は④が決める）。
- 拡張自身の期限（Grant の `expires_ts`、manifest の欄の範囲、`max_instances`）は世界の寿命と別。期間の境界はこれらを変えない。
- 出口は期間の状態で閉じない。返却義務に期限はない。
- 古い seq の呼出しは何より先に `SeqMismatch`（再送の答えはいつも同じ）。
- 検証は窓ごと。各窓が前の窓の終わりから始まることを照合する（`verify_windows`）。
- 詳細と試験: [09](09-continuing-world.ja.md)。

## 3b. 分割書込み（r3）

1 取引（1,232 B）に載らない manifest は buffer に分けて書く（`buffer.rs`）。
- `open(作者, 期待する manifest_id, 長さ)`: 長さ 1–1,024、既に登録済みの id や同じ (作者, id) の buffer は拒否。
- `write(作者, id, offset, bytes)`: 順序は自由。範囲外・空は `OutOfBounds`。既に書いた byte と同じなら受理（重複は無害）、1 byte でも違えば片全体を拒否（`ChunkConflict`、新しい部分も書かない）。他人は (作者, id) が違うので `NoBuffer`。
- `finalize`: 全 byte がそろい（`Incomplete`）、その hash が期待した id と一致し（`HashMismatch`）、通常の公開検査（解読・静的検査・作者の署名）を通ったときだけ登録し、buffer を閉じる。失敗しても buffer は残る。書き間違えた byte は直せないので `abandon` して開き直す。
- **登録前はその id で何も実行できない**（`NotRegistered`）。

## 4. 許可（Grant。⑨⑩②の契約が届いたら差し替え）

```text
Grant = {
  citizen, manifest_id,              // 版を固定。別の id には効かない
  entries: u8 bitmask,
  per_call: [i64; 8],                // 1 回の Pay+Burn の上限（manifest の pay_cap とも照合）
  budget:   [i64; 8],                // 累計の上限（消費すると減る）
  max_calls: u32, expires_ts: i64, revoked: bool
}
```

呼出しの条件: 署名者が Citizen の wallet か期限内の session 鍵（コアの `player_prologue` と同じ規則）、Grant の citizen と manifest_id が一致、Holding の所有者が同じ Citizen。**他人の Grant・Holding は使えない。**

⑨⑩への差し替え点: `GrantAdapter::authorize(grant, call) -> Allow | Deny{code}` と `consume(grant, spent)`（③の [04](https://github.com/r0ze998/wylls/blob/2f8ec700/workstreams/03-composability/04-interface-contract.ja.md) §4 と同じ形）。

## 5. 呼出しと結果（④の Run へ渡す型）

```text
Call = { manifest_id, citizen, entry, args: [i64; ≤4], seq: u64, signer, now_ts }

Receipt v1 = {
  receipt_version: 1, effect_set, manifest_id, citizen, entry, args, seq, now_ts,
  pre_state: sha256(instance), post_state: sha256(instance),
  holding_delta: [i64; 8], escrow_delta: [i64; 8], burned: [i64; 8],
  events: [u8], prev_receipt: [u8;32]
}
receipt_id = sha256("WYLLS-EXT-RECEIPT" ‖ 0x00 ‖ canonical_bytes)
```

- **二重実行:** `seq` は利用者ごとの状態の `seq` と一致しなければ拒否（`SeqMismatch`）。成功で 1 進む。④が再送しても 2 回目は必ず拒否される（同じ結果を返すのではない）。④は `SeqMismatch` かつ状態の `last_receipt` が自分の receipt_id なら「既に完了」と扱える。
- **偽の完了記録:** 状態は最後の receipt_id（`last_receipt`）を持ち、各 receipt は前の receipt_id を持つ鎖になる。完了の根拠は「鎖の先頭が状態と一致し、検証器が再実行して同じ receipt を得る」こと。ログに receipt の形の文字列があるだけでは完了ではない。
- **原子性:** 途中の op が失敗したら、状態・Holding・escrow・Grant の消費のどれも書かない。

エラーの層: `Static`（公開時）／`Auth`（署名・Grant・所有）／`Registry`（停止・版）／`Exec`（op の失敗）。番号は `ext-kernel/src/error.rs`。

## 6. 検証（第三者）

入力: 登録簿の履歴、manifest の byte 列（id で照合）、初期状態、Call と Receipt の列、最終状態。

出力は既存の検証器（`frontier-node/crates/verify`）と同じ三値: `Pass` / `Fail(code)` / `Unverifiable(reason)`。

- 知らない `effect_set`・`receipt_version`・op、manifest の欠落、状態の欠落 → **Unverifiable**（Pass にしない）。
- 再実行の結果が Receipt と違う、鎖が切れている、停止中の時刻の呼出し、最終状態の不一致 → **Fail**。

## 7. 未決（各担当に確認したいこと）

1. ⑥: **回答あり（2026-10-30、要約）。** (a) 公開状態と実行状態は別系列にする（上記 §3）。(b) 運営の緊急停止は⑥の権限表で「提案・未決定」の行。作者や運営が採用済みの計画を止められるとは確定させない。システムの安全停止（コア・プログラムの停止）も別の行。署名済み・送信済みの操作が止まるかは④とチェーン次第。(c) 表示する上限には、単位（資源／推論費用／手数料）・範囲（1 回の呼出し／1 回の実行／1 日）・強制する場所（⑥の模擬／実行サービス／チェーン）を添える。⑪の `pay_cap` と Grant の `per_call` は「コア資源・1 回の呼出し・コアの解釈器（チェーンに組み込んだ場合はチェーン、現状はホストの試作）」。(d) ⑥の識別子（定義＝作者の公開鍵＋名前、版＝semver、内容ハッシュ＝正準 JSON の接頭辞なし SHA-256、Ed25519 の分離ドメイン署名）と `manifest_id` は別の型で、相互参照するが同一視しない。結びつけるなら⑥の計画に `{ extension: manifest_id }` を足して計画の署名に含める（⑥側の新しい契約案）。(e) 新しい id・新しい Grant の採用は⑥の計画の更新と自動では同じにならない。旧版は「公開停止・新版の公開」だけなら続けられ、権利の取消・期限・残高不足・施設の閉鎖や奪取・⑪の実行状態での拒否では実行できなくなる。
2. ④: `SeqMismatch` かつ `last_receipt` 一致を「完了済み」とする判定でよいか。Receipt を Run の結果の型にそのまま入れられるか。
3. ⑨⑩: 資源の「預かり（escrow）」を⑨⑩の保管の契約で表せるか。拡張が持つ escrow をコアの保管と別勘定にしてよいか。
4. ②: Grant の `per_call`／`budget`／`max_calls`／`expires_ts` は②の Grant の欄と対応がつくか。
