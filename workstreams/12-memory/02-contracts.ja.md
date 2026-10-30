# ⑫ 接続契約（④ 実行・⑤ provider と予算・⑬ 独立住民）

版：`wylls.memory12.*/v1`。⑫は記憶・検索・関係更新の module だけを持つ。**モデル呼出し、scheduler、予算管理、実行は持たない。** 実体は `src/index.mjs`（`createMemory`）。

## 1. ④（実行）→ ⑫：事実イベント

④が chain／実行記録から確認した事実だけを `m.observe(fact)` で渡す。発言から fact は作れない（`utterance` の act に該当型が無く、未知の act・余分な field は拒否）。

```js
m.observe({
  kind: 'caravan_sent' | 'caravan_settled' | 'caravan_raided' | 'march_sent' | 'rollback',
  bell,                                   // 記録が公開になった chain bell
  source: { chain: 'local', sig, ix },    // tx 署名と、その tx 内の記録の位置。id はこれだけから決まる
  visibility: { scope: 'public' } | { scope: 'nation', nation } | { scope: 'parties', members: [tag...] },
  data,                                   // 下表
})  // -> {status: 'added' | 'duplicate' | 'collision' | 'refused', id, reason?}
```

| kind | data | 由来（既存コード） |
|---|---|---|
| `caravan_sent` | `{sender, seq, recipient, cargo:{wood:100,...}, arrive_bell}` | `CqEvent::CaravanSent{owner_tag, seq, dst, cargo, arrive_ts}` |
| `caravan_settled` | `{sender, seq, recipient, outcome: 0 DELIVERED / 1 LOST, cargo}` | `CqEvent::CaravanSettled{owner_tag, seq, outcome, dst, cargo}` |
| `caravan_raided` | `{sender, seq, raider, taken}` | `CqEvent::CaravanRaided{owner_tag, seq, raider_tag, taken}` |
| `march_sent` | `{owner, host_id, dest:{p,q}, arrive_bell}`（**封印された行軍は `parties:[owner]`**） | DEPART＋自分の送信記録 |
| `rollback` | `{fact: <id>, reason}`（**対象と同じ visibility 必須**。違えば `rollback_visibility_mismatch`） | slot の再編・誤配信の取り消し |

④への依頼：
1. **受取人の解決**：`CARAVAN_SETTLED` は目的地の場所（`LogPlace` kind/p/q/at/gen/tile）しか持たない。精算時点の保有者（村・倉庫）を `recipient` tag として解決して渡す。解決できなければ送らない（推測しない）。
2. **発送と到着を分ける**：`caravan_sent` は履行ではない。⑫は `caravan_settled` DELIVERED だけを履行の根拠にする（引き継ぎ文書の確認項目 1 と同じ）。
3. **重複配信は同じ `source` で**：同じ記録は何度送ってもよい（`duplicate`）。同じ `source` で中身が違うと `collision` として拒否・記録され、最初が残る。
4. 資源名は `food wood stone ore horses gold science influence`（`Resource` の順）。0 の資源は省略可。

## 2. ⑬（独立住民の目標と行動ループ）↔ ⑫

⑬が行動ループの中で呼ぶ。⑫は自分から時間を進めない。

| 呼び出し | 用途 |
|---|---|
| `m.say({speaker, bell, channel, visibility, text, act})` | 社会層が**署名を検証した**発言を記録。`act` は `request{to,resource,qty,by_bell}` / `accept{ref,qty,by_bell}` / `decline{ref}` / `claim_delivered{ref}` / `testimony{about,ref,says}` / `retract{ref}` のみ |
| `m.knowledge({tag, nation}, bell)` | その住民がその bell に知っていること（可視性で絞った後の純 fold）。`commitments`, `reliability`, `testimonies`, `notes`, `facts` |
| `m.summary(viewer, bell)` | 出典 id 付きの要約行（`epistemic: said / verified / interpreted`） |
| `m.note({owner, bell, about, text, basis, by:'code'|'model', expires_bell})` | 本人の解釈。根拠にはならない |
| `m.correct({owner, bell, target, reason, replacement})` | 自分の note の訂正だけ（他人の発言・事実は不可） |
| `await m.choosePartner({viewer, bell, request, candidates, limits, policy, policyName})` | 取引相手の選択。入力を作り、policy に渡し、検証し、`decision` 記録（引用 id 付き）を残す |

`request = {resource, qty, need_by_bell, failure_cost}`、`candidates = [{id, tag, price_per_unit, distance, stock, arrive_bell}]` は **⑬（または世界）が code で作る**。`limits = {budget}` は**⑬／⑤が渡す**。⑫は journal や発言から limits を読まない。

約束の状態（派生、保存しない）：`promised`（話しただけ。`authority:false`, `contract:false`）→ `fulfilled` / `late` / `partial`（DELIVERED の fact が必要）・`raided` / `lost` / `withdrawn`（中立）・`claimed_unverified`（申告のみ）・`broken`（期限＋6 bell 過ぎて fact なし。申告済みなら `false_claim`）。

## 3. ⑤（provider と予算）↔ ⑫

⑤は `policy(input) -> answer` を実装して `choosePartner` に渡す。⑫は通信しない。

- 入力 `input`（`wylls.memory12.decision-input/v1`、JSON のみ）：`self, bell, request, limits, cost_model, candidates[{…, eligible, ineligible_reason, reliability{E,r,s,n_direct,n_observed}, memory[ids]}], memory[{id, about, epistemic, text, sources}], untrusted_messages[{id, from, bell, trust:'untrusted', text}], rules[], answer_schema`。実例：`results/inputs/*.json`。
- 出力：`answer_schema`（`{choice, cite[], why}`、追加 field 禁止）。Claude なら tool の input_schema、GPT なら json_schema の structured output にそのまま渡せる。
- 検証（`validateAnswer`）：未知・不適格の候補、未知の引用 id、追加 field は拒否 → 参照 policy で決め、`refused` に理由を返す。⑤の予算超過・timeout は `policy` が throw すれば同じく参照 policy に落ちる。
- policy には入力の**複製**を渡す。policy が書き換えても呼び出し側の limits は変わらない（テスト済み）。
- token 予算：v1 の入力は小さい（例：約 3 KB）。⑤が上限を持つ場合、⑫は今後 `memory[]` を「選ばれうる候補の verified → interpreted → said」の順で切る（未実装。限界参照）。

## 4. 共通の約束事

- 可視性：`public` / `nation`（国の卓）/ `parties`（直接会話・私的な実行記録）。fold の**最初**で絞るので、派生値（信頼度など）にも見えない記録は混ざらない。
- journal は追記のみ。訂正・失効・rollback はすべて新しい記録。`Journal.open(path)` で再起動時に再生（最後の行が壊れていれば無視して `torn` に数える）。
- 時刻は bell（10 分）。
