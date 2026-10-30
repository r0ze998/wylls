# ⑫ 接続契約 v3（④ 実行・⑤ provider と予算・⑬ 独立住民）

版：記録 v3、判断入力 `wylls.memory12.decision-input/v3`。初期化は `createMemory({path, world: {cluster, program, season}, keys: {tag: ed25519 公開鍵 hex}})`。⑫は記憶・検索・関係更新の module だけを持つ。**モデル呼出し、scheduler、予算管理、実行は持たない。** 実体は `src/index.mjs`（`createMemory`）。v1 からの変更点は末尾。

## 1. ④（実行）→ ⑫：事実イベント

④が chain／実行記録・索引から確認した事実だけを `m.observe(fact)` で渡す。発言から fact は作れない。

```js
m.observe({
  kind, bell,                 // bell = 発生した chain bell
  created_bell,               // ④がそれを観測して渡した bell（>= bell。省略時 bell）
  source: { chain: 'local' | 'index', sig, ix },  // 記録（または索引の証明）の参照。id はこれだけから決まる
  visibility: { scope: 'public' } | { scope: 'nation', nation } | { scope: 'parties', members: [tag...] },
  data,
})  // -> {status: 'added' | 'duplicate' | 'collision' | 'refused', id, reason?}
```

場所は `{kind: 1 holding | 2 vault, p, q, at, gen}`（fclient `LogPlace`）、隊商 id は `{sender, seq}`（記録の `owner_tag`, `seq`）。

| kind | data | 由来・意味 | ⑫の扱い |
|---|---|---|---|
| `caravan_sent` | `{caravan, dst, cargo, eta_bell?}` | `CqEvent::CaravanSent` | 発送。**履行ではない** |
| `caravan_settled` | `{caravan, outcome: 0 DELIVERED / 1 LOST, dst, cargo_recorded}` | `CqEvent::CaravanSettled` | 精算が起きたこと。**量・受取人は確定しない** |
| `caravan_credited` | `{caravan, place, credited, unit: 'whole_units', basis: 'exec_record', exec: {sig, ix}}` | **新規依頼**：settle 命令の実行記録から、**この配送だけ**で増えた量（残高の前後差は不可） | 倉宛ての量の唯一の根拠。村宛てでは規則による導出と一致すること（違えば `record_conflict`） |
| `caravan_raided` | `{caravan, raider, taken}` | `CqEvent::CaravanRaided` | 中立 |
| `place_owner` | `{place, owner, from_bell, to_bell \| null}` | **新規依頼**：その区間の所有者（null＝この記録の bell まで） | 精算時点の受取人 |
| `coverage` | `{world: {cluster, program, season}, sender, from_bell, to_bell, routes: [...], completeness: {gapless, from_slot, to_slot}, finality, caravans: [{sender, seq}...]}` | **新規依頼**：その世界・送り主の、区間内に、列挙した全経路で出た `CARAVAN_SENT` は**これで全部**（`to_bell` ≤ 記録の bell） | 未発送・偽申告を確定できる唯一の根拠。world 一致・`finalized`・gapless・経路 3 つ（`send_caravan/top_level`、`send_caravan/cpi`、`settle_raid/take`）がすべて揃うときだけ使う |
| `lookup_failed` | `{query: coverage \| caravan \| place_owner \| credit, sender?, caravan?, reason}` | **新規依頼**：照会できなかった | 未確認（不在扱いしない） |
| `march_sent` | `{owner, host_id, dest, arrive_bell}`（封印された行軍は `parties:[owner]`） | DEPART＋自分の送信記録 | 可視性の試験用 |
| `rollback` | `{fact, reason}`（**対象と同じ visibility 必須**） | 再編・誤配信・誤った証明の取り消し | 対象と、そこから導いた判定を除外 |

④への依頼（v1 からの変更を含む）：

1. **受取人を推測して付けない**。v1 で依頼した「受取人 tag の解決」は取り下げ、`place_owner` の区間証明に置き換える。所有者が分からなければ送らない（⑫は `recipient_unverified` にする）。
2. **加算量は settle 命令の実行記録から、その配送の分だけ**。v2 の依頼（口座残高の前後差）は取り下げる。並行する入出庫・生産・消費が混ざるため。村（holding）宛ては、`Holding::credit` → `Store::add` が全量を上限なしで加算するので、⑫が規則 `holding-credit-uncapped/v1` で導く（④の記録は任意で、出すなら一致が必要）。倉（vault）宛ては `min(have + c, max(cap, have))` で、その瞬間の在庫と上限に依存するので、④の実行記録が無ければ⑫は量を未確認のままにする。単位は整数単位（`whole_units`、log と同じ）。
3. **完全性と確定性を証明できる区間だけ `coverage` を出す**。世界（cluster・program・season）、`finalized` の slot 範囲で穴がないこと、`CARAVAN_SENT` を出す全経路を読んだことを明示する。経路はトップレベルの `send_caravan`、CPI 経由の `send_caravan`（③が実証。verify はトップレベルしか集めない）、`settle_raid` の TAKE。満たせない区間は出さない。照会が失敗したら `lookup_failed`。
4. **遅れて届いた記録には、本当の `bell` と遅い `created_bell` を付ける**。⑫は期限内かどうかを `bell` で判断し、`created_bell` で「いつ知ったか」を扱う。
5. 同じ記録は何度送ってもよい（`created_bell` が違っても `duplicate`）。同じ `source` で中身が違えば `collision` として拒否・記録され、最初が残る。訂正は `rollback`＋正しい記録で。
6. 資源名は `food wood stone ore horses gold science influence`（`Resource` の順）。0 は省略可。
7. 実装の手掛かり（未確認）：findex は event index と account snapshot を持つ。所有者の区間と送り主別の発送一覧は event index から導ける見込みがある。ただし加算量は、snapshot の前後差ではなく settle 命令単位の実行記録から取ること（倉宛てを命令単位で測れないなら出さない）。CPI 経由の `CARAVAN_SENT` を findex が取り込んでいるかは未確認（③は verify がトップレベルだけを集めると報告）。

## 2. ⑬（独立住民の目標と行動ループ）↔ ⑫

| 呼び出し | 用途 |
|---|---|
| `m.say({speaker, bell, channel, visibility, text, act})` | 社会層が**署名を検証した**発言を記録 |
| `m.knowledge({tag, nation}, clock, {observedBy})` | その住民の知識（可視性で絞った後の純 fold） |
| `m.summary(viewer, clock)` | 出典 id 付きの要約行（`said / verified / interpreted / unknown`） |
| `m.allocate(signed)` | **署名付きの割当**（下記）。検証に失敗すれば拒否 |
| `m.note(...)` / `m.correct(...)` | 本人の解釈と、その訂正（自分の note だけ） |
| `await m.choosePartner({viewer, bell, request, candidates, limits, policy, policyName})` | 取引相手の選択。判断記録に入力（request・candidates・limits）と引用 id を残す |
| `m.reassess(decisionId, observedBy)` | 判断時点の bell で評価し直す。`late_arrivals`（使う）、`later_events`（使わない）、`backdated`（除外）を分け、元の入力と `then_reproducible` を返す |

act（whitelist。余分な field は拒否）：

| act | 形 | 意味 |
|---|---|---|
| `request` | `{to, resource, qty, by_bell, place}` | **場所（世代込み）が必須** |
| `accept` | `{ref: request id, qty, by_bell}` | 約束 id ＝ この発言の id。`authority:false`, `contract:false` |
| `decline` / `retract` | `{ref}` | 期限前の取り下げは中立 |
| `claim_sent` / `claim_delivered` | `{ref, caravan?}` | 「送った」「届いた」は別の申告。名指しがあれば照合しやすい |
| `testimony` | `{about, ref, says}` | 第三者の証言。表示と照合のみ |

**割当（allocation）は act ではない。** 署名する内容は `{domain: 'wylls-memory12-allocation/v1', world, by, op: 'set'|'revoke', commitment, caravan: {sender, seq}, qty, nonce, bell, visibility}` の正規 JSON（`allocationBytes`）。これを署名者の ed25519 鍵で署名し、`{...内容, created_bell, sig}` を `m.allocate` に渡す。鍵登録（`keys`）は⑬または社会層が名簿から渡す。nonce は署名者ごとに 1 回だけ使う。署名者・約束・隊商ごとに、nonce が最大の操作が有効。訂正は大きい nonce の `set`、撤回は `revoke`。

`request = {resource, qty, need_by_bell, failure_cost}`、`candidates = [{id, tag, price_per_unit, distance, stock, arrive_bell}]` は⑬（または世界）が code で作る。`limits = {budget}` は⑬／⑤が渡す。⑫は journal や発言から limits を読まない。

## 3. ⑤（provider と予算）↔ ⑫

⑤は `policy(input) -> answer` を実装して `choosePartner` に渡す。⑫は通信しない。

- 入力（`wylls.memory12.decision-input/v3`、JSON のみ。実例 `results/inputs/*.json`）：`self, bell, observed_by, request, limits, cost_model{dist_cost, caution{share, cap, is_honesty_judgment: false, meaning}, formula}, weights（仮設定であることを含む）, candidates[{…, eligible, ineligible_reason, reliability{E, r, s, n_direct, n_observed, verified, claims}, unknown{open_overdue, open_total, neutral, caution_is_honesty_judgment: false}, memory[ids]}], memory[{id, about, epistemic, text, sources}], untrusted_messages[...], rules[], answer_schema`。判断記録はこの入力をそのまま保存する（`input`、`input_sha256`）。
- 出力：`answer_schema`（`{choice, cite[], why}`、追加 field 禁止）。Claude なら tool の input_schema、GPT なら json_schema の structured output にそのまま使える。
- 検証（`validateAnswer`）：未知・不適格の候補、未知の引用 id、追加 field は拒否し、参照ルールで決める（`refused` に理由）。policy が throw した場合（予算超過・timeout）も同じ。policy には入力の複製を渡す。
- **決定的な参照ルールの結果と、実 LLM の結果を混ぜない**。判断記録の `policy` に `reference-v2` か、⑤が渡した `policyName` が残る。実 LLM の評価（同じ入力で何を選び、何を引用したか）は⑤側の試験として別に記録する。

## 4. 共通の約束事

- 可視性：`public` / `nation` / `parties`。fold の**最初**で絞るので、派生値にも見えない記録は混ざらない。
- journal は追記のみ。訂正・失効・rollback はすべて新しい記録。`Journal.open(path)` で再起動時に再生する（最後の行が壊れていれば無視して `torn` に数える）。
- 時刻は bell（10 分）。

## v2 → v3 の変更（互換性なし）

- `caravan_credited`：`basis` は `exec_record` だけ（`account_diff` は拒否）。`unit` と `exec {sig, ix}` が必須。村宛ては⑫が規則で導く。
- `coverage`：`world`・`routes`・`completeness`・`finality` が必須。十分性は⑫が判定し、欠けたものを `coverage_gaps` に出す。
- 状態：`not_delivered` を `not_sent` に改名。未着（発送済みで精算なし）は未確認のまま。
- 割当：`allocate` act を廃止し、署名付きの `allocation` 記録にした（nonce、訂正、撤回、公開範囲も署名に含む）。
- 判断記録：入力そのものと `input_sha256` を保存する。`reassess` の出力を変更（`late_arrivals`、`later_events`、`backdated`、`original`、`then_reproducible`）。
- 判断入力 v3：caution に `is_honesty_judgment: false` と意味を追加。

## v1 → v2 の変更（互換性なし）

- 記録 v2：全記録に `created_bell`。fact の形を変更（隊商 id、場所と世代、`cargo_recorded`）。`caravan_credited`・`place_owner`・`coverage`・`lookup_failed` を追加。
- act：`request` に `place` 必須。`allocate`・`claim_sent` を追加。`claim_delivered` に任意の `caravan`。
- 状態：`broken` を廃止し、`not_delivered`（完全な索引による確認）と `unconfirmed`（未確認＋理由）に分割。`in_progress`・`recipient_changed` を追加。
- 判断入力 v2：`unknown`・`weights`・caution 項・`observed_by` を追加。判断記録に `candidates`・`limits`・`nation` を追加（再評価用）。
