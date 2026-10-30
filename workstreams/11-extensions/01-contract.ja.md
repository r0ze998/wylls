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

## 3. 登録簿（⑥が持つ欄の最小集合）

```text
Registration = {
  manifest_id, author, status: Active | Paused | Revoked,
  supersedes: Option<manifest_id>,   // 更新は「新しい id の登録」。古い id の意味は変わらない
  history: [(ts, status)]            // 検証器が「停止中に実行された呼出し」を見つけるため
}
```

| 操作 | 誰が | 効果 | 実行済みの効果 |
|---|---|---|---|
| 公開 | 作者 | 静的検査を通った manifest を Active で登録 | — |
| 更新 | 作者 | 新しい id を `supersedes` 付きで登録。古い id はそのまま | 変わらない。利用者の許可は古い id に固定 |
| 一時停止／再開 | 作者・運営（緊急停止） | 新しい呼出しを拒否／再開 | 変わらない。escrow は `Withdraw` で戻せる |
| 取消 | 作者・運営 | 恒久的に拒否 | 変わらない。escrow は `Withdraw` で戻せる |

`Withdraw`（コア定義の出口、拡張のコードを実行しない）: 停止中または取消後に、利用者が自分の escrow を全額自分の Holding へ戻す。停止で利用者の資源が閉じ込められない。

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

1. ⑥: 登録簿の `status` と `history` を⑥の版管理に載せられるか。運営の緊急停止を⑥の権限表に入れるか。
2. ④: `SeqMismatch` かつ `last_receipt` 一致を「完了済み」とする判定でよいか。Receipt を Run の結果の型にそのまま入れられるか。
3. ⑨⑩: 資源の「預かり（escrow）」を⑨⑩の保管の契約で表せるか。拡張が持つ escrow をコアの保管と別勘定にしてよいか。
4. ②: Grant の `per_call`／`budget`／`max_calls`／`expires_ts` は②の Grant の欄と対応がつくか。
