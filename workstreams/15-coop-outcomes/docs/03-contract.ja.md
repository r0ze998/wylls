# イベント・目標・判定結果の契約（版 0、草案）

①（依頼）・④（実行と到着の確定）・⑭（塔）と共有するための草案。コードの正本は [src/contract.mjs](../src/contract.mjs)（入力）と [src/evaluate.mjs](../src/evaluate.mjs)（判定結果）。食い違えばコードが正しい。

## 1. 入力：`{state, events}`

### 1-1. state（戦期の始まりに固定するもの）

| 欄 | 中身 |
|---|---|
| `period` | `{id, opensAt, endsAt, optionsAt?}`。鐘で数える |
| `nations` | 国の id の一覧（S1 は6か国固定） |
| `actors` | `{id, nation, cluster?, kind?}`。`cluster` は「同じ人」を表す**模型のラベル**（本番の保証ではない） |
| `lots` | 始まりの荷 `{lot, owner, resource, qty, verified}`。荷は資源1種ずつ |
| `keeps` | 要塞の持ち主 `{keep, nation}` |
| `streams` | 記録の流れごとの番号の範囲 `{from, through?, kinds?}`。`through` があれば末尾の欠落も分かる。`kinds` はその流れが運ぶ種類（ほかの種類は拒否し、欠落の影響もその種類に限る） |

### 1-2. イベントの封筒（全種共通）

| 欄 | 意味 |
|---|---|
| `id` | 出どころの中で一意。同じ id・同じ中身は重複（1回だけ使う）、同じ id・違う中身は**衝突**（どちらも使わず、その位置を欠落として扱う） |
| `stream`, `seq` | 記録の流れと、その中の番号。番号は連続する。欠落の直前に見えた記録の鐘より後に決まる判定で、欠けた流れが関わる種類を運びうるものは `indeterminate`（賞金も同じ） |
| `sub` | 任意。一つの記録から作った n 番目のイベント（隊商の積荷を資源ごとに分けるとき） |
| `at` | 起きた鐘。並びは `at → stream → seq → sub → id` の順に決める（入力の並び順は結果に影響しない） |
| `verified` | `chain`（記録・口座から読んだ）／`derived`（チェーンの事実から計算）／`chain_lower_bound`（少なくともこれだけ）／`unverified`（数えない） |

### 1-3. 種類

| kind | 必須の欄 | 出どころの例 |
|---|---|---|
| `actor.join` / `actor.move` / `actor.expel` | `actor`, `nation` | JOIN、追放の投票 |
| `lot.produce` | `lot, owner, resource, qty` | 生産（今の試作は始まりの在庫だけ） |
| `ship.send` | `ship, from, to, resource, qty`（`lot` 任意） | CARAVAN_SENT。`to` が `project:<id>` なら、着いたときに送り手の投入になる（①の依頼） |
| `ship.arrive` | `ship, qty` | CARAVAN_SETTLED（届いた） |
| `ship.raid` | `ship, raider, taken, burned` | CARAVAN_RAIDED |
| `ship.lost` | `ship` | CARAVAN_SETTLED（失われた） |
| `project.open` | `project, goal, steward`（`structure`, `deadline` 任意） | ①の依頼（板） |
| `contribute` | `project, actor, lot, qty` | 自分の持つ荷を計画に入れる |
| `build.complete` | `project, structure` | STRUCTURE_BUILT（①の板で計画と結ぶ） |
| `structure.seized` | `structure, by` | STRUCTURE_SEIZED |
| `use` | `structure, actor, how` | FORT_GARRISONED（`garrison`）。塔・柵の利用の記録はチェーンにない |
| `keep.set` | `keep, nation` | KEEP |
| `territory.counter` | `nation, bells` | TERRITORY_BELLS の値 |
| `nation.goal` | `nation, goal` | 対応する投票の種類は**まだない** |
| `tower.sighting` / `tower.report.used` | `sighting, tower, actor` / `sighting, actor` | ⑭（任意） |
| `position` | なし | 判定に使わない記録。番号の欠落と区別するためだけに置く |

### 1-4. 荷（lot）の決まり

- 荷は一度しか使えない。送る・入れると減る。持っていない量を使うと `insufficient`（二重消費）。
- 荷には**出どころ**（その戦期に入ったときの持ち主、または作った人）が付いて回る。奪った荷も出どころは変わらない。共同目標の「どの国が加わったか」は出どころで数える（`attribution: 'origin'`）。
- 同じ鐘の出来事は流れの名前の順に並ぶ（`chain` が `ws01` より先）。

## 2. 目標（ルールの版に含まれる）

| 区分 | 判定 |
|---|---|
| 共同 | 3段階を別々に判定：**材料の投入**（資源ごとに、確かめられた到着から入った量を要求量まで先着で）→ **建設の完了**（期限内）→ **実際の利用**（必要な数の国の、別々の人に使われた）。加えて**国の多様性**（各国が少なくとも一つの資源で要求量の一定割合以上を、独立した参加者で）。すべて満たした鐘が達成の鐘 |
| 国 | 国ごとに一つ（投票、なければ既定）。目標の量は国の人数に比例（小国は小さい） |
| 個人 | 誰でも一人で目指せる：材料を入れた（完成した計画に）・他国の建物を使った・計画を開いて他人の材料で完成させた・他国の隊商から奪った・塔の目撃が使われた（塔の入力があるときだけ） |

報酬枠は `目標|戦期|受取人`。個人の枠は同じ `cluster`（同じ人）で1つ。一つの投入が共同・国・個人の**別の枠**に数えられるのは正当。

## 3. 判定結果（`evaluate(ruleset, input)` の戻り値）

| 欄 | 中身 |
|---|---|
| `evaluator`, `ruleset{id,version,variant,hash}`, `inputHash`, `verdictHash` | 再生の照合用。`verdictHash` は `diagnostics` 以外のすべての sha256 |
| `identity` | `productionGuarantee: false` と注記 |
| `records` | 衝突・形の不正・欠落・拒否した記録（理由の符号つき） |
| `period` | `closeAt`, `closedBy`（`schedule` か `joint:<目標>`）、`status`、`scope{ends, continues}` |
| `achievements{joint,national,personal}` | 各目標の `status`（`achieved`／`not_achieved`／`indeterminate`／`not_offered`／`not_awarded`）、`reasons[{code, evidence[], detail}]`、共同は `stages` |
| `awards` | 報酬枠の一覧（お金ではない記録） |
| `scores` | 要塞の数・領土の鐘 |
| `resources` | 資源ごとの流れ（**資源をまたいだ合計の欄はない**） |
| `prize` | 現行の規則で名指しされる国、`newMoney: 0`, `fromAchievements: 0` |
| `options{at, byActor}` | その鐘で各人が取れる選択肢と分類（`wait`／`follow`／`lead`／`compete`／`oppose`／`personal`／`move`） |
| `diagnostics` | 重複の数・入力の並びの乱れ（届け方しだいで変わるので hash の外） |

理由の符号と文は `REASONS`（[src/contract.mjs](../src/contract.mjs)）。

## 4. 各担当への依頼（受領していないもの）

| 相手 | ほしいもの | 今の扱い |
|---|---|---|
| ① | `fold()` の実物の形、`link` の caravan の `ownerTag` の表し方（10進の文字列か） | 伝え聞いた形で [adapters/ws01.mjs](../src/adapters/ws01.mjs) を書いた。量は①の到着の見え方ではなく S1 の記録から取る（二重に数えない） |
| ④ | Run Receipt の `body` の欄、P1（`credited`）の採否 | [adapters/ws04.mjs](../src/adapters/ws04.mjs) は欄を仮定。村あての `RuleDerived` を正確な量とするか下限とするかは呼び出し側で選ぶ（既定は①の下限） |
| ⑭ | `tower-facts/0` の各事実の欄 | [adapters/ws14.mjs](../src/adapters/ws14.mjs) は欄を仮定。塔は任意入力 |
