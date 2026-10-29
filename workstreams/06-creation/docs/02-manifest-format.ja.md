# 2. 定義の形式（manifest `wylls.creation.manifest/0`）

**正本：** `src/manifest.mjs`（形）と `src/validate.mjs`（意味）。この文書はその説明。食い違えばコードが正しい。

**位置づけ：** 公開された定義は、**説明と接続の約束** です。履行の保証でも、権利そのものでもありません。定義の中には、札（権利）も、物（資源）も、署名の権限も入りません。使う人は、自分の札・自分の場所・自分の署名を持ち込みます。

## 1. 全体

```jsonc
{
  "format": "wylls.creation.manifest/0",
  "name": "front-supply",            // 英小文字・数字・-、3〜40字。作者ごとに一意
  "version": "1.0.0",                // MAJOR.MINOR.PATCH。公開した版は書き換えられない
  "author": "<Ed25519 公開鍵 hex>",   // 作者。署名はこの鍵で確かめる
  "title": "前線補給（工房を借りて兵器を送る）",
  "note": "作者の説明（自由文。機械は確かめない）",
  "validUntilDay": 40,               // 省略可。この日を過ぎた定義は使えない
  "derivedFrom": null,               // 写しなら { author, name, version, hash }
  "params":  { … },                  // 利用者が決める入力
  "uses":    { … },                  // 依存：B（接続）と C（成果を使う）
  "steps":   [ … ],                  // 既存の効果の並び
  "trigger": "manual",               // 合図。今は manual だけが動く
  "limits":  { "runsPerDay": 1 },
  "outputs": { … },                  // 渡すもの
  "claims":  { … }                   // 作者の主張のうち、機械で確かめられるもの
}
```

数はすべて整数（小数は `NUMBER_NOT_INTEGER`）。知らない欄は `SHAPE` で止める。定義の識別子は、正規化した JSON（キーを並べ替え、空白なし）の SHA-256。

## 2. 型

| 型 | 意味 | 由来 |
|---|---|---|
| `int` | 0以上の整数 | |
| `vault` / `village` / `workshop` / `place` | 倉・村・工房のある村・そのどれか。`workshop` ⊂ `village` ⊂ `place`、`vault` ⊂ `place` | S1 の場所 |
| `goods` | 資源ごとの量（食料・木材・石・鉱石・兵器・金・学・影響） | S1 の8資源（兵器は Horses の欄） |
| `grant:use` / `grant:share` / `grant:receipt` | 使用権・持ち分・受け取りの札 | S2 の束。②の Grant に置き換える |
| `result:delivery` / `result:run` | 確定した配達・確定した生産の記録 | ④の Receipt に置き換える |

入力（params）にできるのは場所と数だけ。物の組は手順の中に `{ "goods": { 資源: 式 } }` で書く。札と記録は **入力にできない**（`TYPE_UNKNOWN`）。必ず `uses` を通して、種類と発行元を宣言する。

## 3. 入力 `params`

```jsonc
"source":   { "type": "vault", "own": true, "ja": "材料を出す倉", "default": "vault:A-mine" },
"workshop": { "type": "workshop", "ja": "使う工房", "default": "village:W" },
"runs":     { "type": "int", "min": 1, "max": 6, "default": 3, "ja": "1日に工房を動かす回数" }
```

- `own: true`：利用者自身の場所でなければならない（実行前の確認で `NOT_OWNER`）。
- 量に効く `int`（工房の回数・荷の量・受け取りの量・札の量）には `max` を付ける。付けないと処理量の上限を検査できず `LIMIT_EXCEEDED`。
- `default` は作者の状況の値。写すと場所の既定は消える（`src/fork.mjs`）。利用者が既定のまま他人の場所を指すと `PARAM_DEFAULT_FOREIGN`（警告）。

## 4. 依存 `uses`：B と C を分ける

```jsonc
"uses": {
  // B：他人が動かしている施設・倉へ接続する。権利は利用者自身の札
  "ws":  { "relation": "connect", "target": { "param": "workshop" }, "grant": "use", "amount": { "param": "runs" }, "ja": "工房" },
  // C：別の定義の実行で確定した成果を使う。1回の実行で記録を1つ使い切る
  "ore": { "relation": "consume", "manifest": { "author": "<M>", "name": "mine-delivery", "range": "^1.0.0", "hash": "<省略可>" },
           "output": "delivered", "type": "result:delivery", "ja": "Mの鉱山の便が届いた記録" }
}
```

- `connect` の `target` は入力か固定の場所だけ。`grant` と target の型の組は決まっている：`use`→`workshop`、`share`/`receipt`→`vault`（違えば `GRANT_KIND_MISMATCH`）。
- `consume` の依存は、どれかの手順の `after` に名前を挙げる（その手順が物を使う場所に届いていることを確かめるため。挙げなければ `REF_UNKNOWN`）。記録は、作った定義の **公開した出力の名前**（`outputs` のキー）で照合する。
- `consume` の `range` は `1.2.3`（その版だけ）・`^1.2.3`・`~1.2.3`。`hash` を書けば、その内容の版だけ。宣言した `type` は、依存先の出力の型と一致しなければならない（公開時に `TYPE_MISMATCH`）。
- **A（定義の写し）は依存ではない。** 写しは `derivedFrom` に元を記録するだけで、元の定義にも、元の作者の札にも、何も接続しない。

## 5. 手順 `steps`：既存の効果だけ

| `effect` | 既存の命令 | ある場所 | 引数 | 出力 |
|---|---|---|---|---|
| `caravan.send` | SendCaravan (0xB1) + SettleCaravan | main（S1） | `from`（自分の倉か村）・`to`・`cargo` | `delivered: result:delivery` |
| `workshop.run` | UseRun (0xC8) | S2 ブランチだけ | `via`（use の接続）・`vault`（自分の・共有でない・工房と同じ州）・`runs`（1〜24） | `made: result:run` |
| `receipt.withdraw` | ClaimReceipt + WithdrawReceipt + SettleCaravan | S2 ブランチだけ | `via`（receipt の接続）・`amount`・`to` | `delivered` |
| `shares.withdraw` | WithdrawShares + SettleCaravan | S2 ブランチだけ | `via`（share の接続）・`to` | `delivered` |

正本は `src/catalog.mjs`。各効果は、使う物・作る物・取引数・CU・荷車の精算預け・失敗の仕方を持ち、紙と上限の検査はそこから計算する。

```jsonc
{ "id": "make", "effect": "workshop.run", "after": ["haul"],
  "args": { "via": { "use": "ws" }, "vault": { "param": "workVault" }, "runs": { "param": "runs" } } }
```

- 式は6つだけ：整数、`{ "param": 名前, "times"?: k }`、`{ "use": 依存 }`、`{ "step": 手順, "out": 出力 }`、`{ "place": "vault:…", "type": … }`、物の組 `{ "goods": { 資源: 式 } }`。
- `after` は、確定を待つ手順の id か `{ "use": consume依存 }`。循環は `STEP_CYCLE`。工房の手順が待つ配達は、工房の倉に届かなければならない（`FLOW_PLACE_MISMATCH`）。届く量が足りなければ警告（`FLOW_SHORT`）。
- 準備の操作（倉を建てる・札を出す・引き換え）は手順にしない。定義の外で一度行う（`SETUP`、`EFFECT_UNKNOWN` の detail）。
- 既存の命令にない効果（D）は、`EFFECT_UNKNOWN`（コア拡張が要る）か `EFFECT_FORBIDDEN`（設計で禁止）。[04](04-world-effects.ja.md)。

## 6. 合図・上限・出力

- `trigger`：`manual` | `daily` | `below` | `arrival`。段階3は未実装なので、`manual` 以外は警告 `TRIGGER_UNAVAILABLE` を出し、機械の事実は「手で実行」になる。
- `limits.runsPerDay`：1日の実行回数。上限（［フェーズ6］の仮の値、`CAPS`）：手順8・荷車4台/回・24回/日・取引96件/日・400万CU/日・工房はすべての工房の手順の合計で24回/日。
- `outputs`：`{ 名前: { "from": { "step", "out" } } }`。C の依存先になれるのはここに出した出力だけ。

## 7. 主張 `claims`：作者の言葉のうち、機械で照合するもの

| 主張 | 機械の事実 |
|---|---|
| `trigger` | 実際に動く合図（未実装の合図は manual） |
| `runsPerDay` | `limits.runsPerDay` |
| `outputsPerRun` | 出力の物の量（入力の既定値で計算。既定がなければ式の文字列） |
| `grants` | 要る札の種類 |
| `consumes` | 使う成果の依存名 |
| `deliversTo` | 出力の届け先の入力名 |
| `signer` | `session`（届け先がすべて `own` の入力）か `wallet-unless-own` |

食い違えば `CLAIM_MISMATCH`、上の表にない主張は `CLAIM_UNKNOWN`（自由文の `note` へ移す）。`note` は照合しないが、紙では「作者の説明」として機械の紙と分けて出し、保証の言葉には警告（`NOTE_PROMISE`）を出す。

## 8. 公開の封筒と計画

- 公開：`{ manifest, hash, signature }`。署名は作者の鍵で `"wylls.creation.publish/0" ‖ 0x00 ‖ hash`。
- 状態の変更（停止・取り下げ・再開）：作者の鍵で `"wylls.creation.status/0"`。署名する内容は `{ author, name, status, seq }` で、`seq` はその名前の状態の履歴の長さ。古い署名を後から出し直して、後の変更を取り消すことはできない。
- 計画（利用者が準備するもの）：`{ format: "wylls.creation.plan/0", manifest: { author, name, version, hash }, actor: 利用者の公開鍵, bindings: { params, grants, receipts }, preparedDay }` を **利用者の鍵** で `"wylls.creation.plan/0"` に署名。作者の秘密鍵は使わない。
- 署名の領域を分けているので、公開の署名を計画や状態変更に使い回せない（`test/roles.test.mjs`）。
