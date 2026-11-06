# ⑭が渡す事実の契約（版1、`wylls.ws14.tower-facts/1`）

コードの正本は [proto/contract.mjs](proto/contract.mjs)（`toFacts`・`checkFacts`・`KINDS`）。食い違えばコードが正しい。試験は [proto/contract.test.mjs](proto/contract.test.mjs)。

**中央塔は採用済みのルールではありません。** この事実は、⑭の比較用の模型（玩具）が作ったもので、チェーンの記録でも人の申告でもありません。

## 1. 全体

```
{ schema: 'wylls.ws14.tower-facts/1',
  source: 'model: …（チェーンの記録ではない）',
  world: { ends: false },
  time: { unit: 'model hour', bellsPerHour: 6, observedUntilHour, atHour },
  case: 'A' | 'B' | 'C', params, tower,
  boundaries: [{ index, hour }],
  events: [ 封筒 ] }
```

- `world.ends` は常に `false`。勝者・点数・順位・賞金・世界の終わりの欄はない（`checkFacts` が拒否する）。
- `boundaries` は、模型に「ここで区切れ」と頼んだ時刻の一覧（`periodHours`、仮の切り替え）。**ルールの戦期ではない。** 区切りで何も戻さない・閉じない・精算しない。戦期の正本は ⑧→④（候補：Season v2 の `RSV_552`）で、⑮は `windows` を外から受け取る。⑭は `windows` を作らない。

## 2. 封筒（全種共通）

| 欄 | 意味 |
|---|---|
| `seq` | 0 から欠けずに続く番号。模型が記録した順 |
| `hour` | 起きた**模型の時刻**（模型は1時間ずつ進む）。チェーンの時刻ではない。ターンに直すなら `time.bellsPerHour`（6）を掛け、直したことを明記する |
| `kind` | 種類（3章） |
| `actor` | 模型の村の番号。塔そのものの出来事は `null`。ウォレットや Citizen ではない |
| `nation` | `actor` の国（模型の 0〜5）。`actor` が `null` なら `null` |
| `verified` | **常に `'unverified'`**。表示してよいが、何かの証明として数えない |

## 3. 種類

| kind | 欄 | 意味 |
|---|---|---|
| `tower.board_post` | `req` | `actor` が自分の開いた依頼 `req` を塔の掲示に出した（全国に見える）。**依頼であって目撃ではない。塔は何も見張らない** |
| `tower.board_taken` | `req, poster, cross` | `actor` が村 `poster` の掲示の依頼 `req` に応え、荷を**送った**（届いたではない）。`cross`＝`poster` と `actor` の国が違う |
| `tower.board_fulfilled` | `req, responder, cross` | 掲示の依頼 `req` の両方の荷が**届いた**：`responder` の荷が依頼主（`actor`）に、依頼主の払いが `responder` に |
| `tower.relay_offer` | `offer` | 申し出 `offer` が中継の倉に着き、開いた（C） |
| `tower.relay_swap` | `offer, cross, contributor` | `actor` の払いが倉に着き、申し出 `offer` を取った。荷は帰り道。`contributor`＝建設に何か出した人か |
| `tower.sent` | `role, res, amount` | 塔へ荷を送った（`give` か `upkeep`）。送っただけ |
| `tower.pledged` | `res, amount` | 運び手を待つ荷を村に差し出した |
| `tower.carried` | `for, amount` | 村 `for` の差し出した荷を運び出した |
| `tower.contribution` | `amount, carrier, stage` | `actor` の荷が塔に**届いた**（`carrier`：運んだ人、なければ `null`） |
| `tower.escort` | — | 中央への道をしばらく護衛した |
| `tower.upkeep_delivered` | `amount` | 倉の維持費（food）が届いた |
| `tower.stage_opened` | `stage`（`retry` 任意） | 段階が始まった（期限切れの後は `retry: true`） |
| `tower.stage_completed` | `stage, contributors, nations` | 段階の必要量がそろった |
| `tower.stage_lapsed` | `stage, fraction, contributors` | 段階が期限までにそろわなかった（塔自身の規則。期間とは無関係） |
| `tower.refund_claim` | `amount` | 期限切れの段階に入れた荷が、`actor` の引き取り分になった |
| `tower.claim_withdrawn` | `amount` | 引き取り分を持ち帰りに出た |
| `tower.dormant` / `tower.awake` | `stage` / — | 維持費切れで倉が止まった／再開した |
| `centre.raid` | `stage, fraction` | `actor` が中央付近で襲撃を始めた（どの案でも起こる） |
| `period.boundary` | `index` | 模型に頼んだ区切り（1章）。何も戻さない |

`checkFacts` が確かめること：番号が欠けない、時刻が戻らない、`verified` が `unverified`、種類ごとの欄がある、応答は先に掲示された依頼に対してだけ、`poster` は掲示した村、`cross` は国の違いと一致、果たされた側は依頼主、`boundaries` と `period.boundary` が一致、禁止された欄がない。知らない種類は拒否する（読む側は、知らない種類を飛ばしてよい）。

## 4. 版0からの変更（2026-11-05）

| 版0 | 版1 | 理由 |
|---|---|---|
| 時刻の欄 `t` | `hour` | ⑮の受け取り側は `hour` を読んでいた。版0では時刻が読めていなかった |
| 番号なし | `seq` | ⑮の封筒は流れの中の連番を求める |
| `verified` なし | 常に `unverified` | 模型の事実を証拠として数えさせない |
| 区切りを渡さない | `period.boundary` と `boundaries` | 区切りをまたいだ事実を、⑮が区切りと並べて読めるように |
| 応答に依頼主がない | `board_taken.poster`、`board_fulfilled.responder` | 依頼を引き直さずに、誰と誰の協力かが分かるように |
| `world` なし | `world.ends: false` | 世界は終わらない |

## 5. ⑮の受け取り側との照合

**現在の状態（2026-11-06）：** ⑮の最新版 `cb87e30c` は契約 v1 に対応済みと報告されています。⑭はその版をまだ受け取っておらず、照合していません。手元・GitHub（全参照・API）・添付のどこにもありませんでした。**下の表は旧版 `b1a09a0b` についての記録で、⑮の今の不具合ではありません。**

### 5.1 旧版 `b1a09a0b`（`preserve/ws15-b1a09a0b` の `src/adapters/ws14.mjs`）での記録（2026-11-05）

`node workstreams/14-central-tower/proto/check-ws15.mjs <⑮の ws14.mjs>` で、⑭の実際の出力（B、種1、21日、7日ごとの区切り）を通した結果：

| 項目 | 旧版での結果 | 当時⑮側に必要だったこと（⑮の判断） |
|---|---|---|
| 版1 をそのまま渡す | スキーマ違いで拒否（0件）。誤読より安全 | 版1 を受け付ける |
| 名前だけ版0にして通す | 掲示631件が `tower.sighting`（目撃）になる | 掲示を目撃に写さない。⑭の塔には目撃がない。P-scout（塔で見たことが他の人に使われた）は⑭の事実からは作れない |
| 〃 | 応答597件は `tower.report.used` にならない（`by`・`of` を読むが、⑭にその欄はない） | 協力を数えるなら `board_taken`（`actor`・`poster`・`req`・`cross`）か `board_fulfilled`（`actor`・`responder`）を読む |
| 〃 | 1171件が `verified: 'chain'`、631件が `'derived'`。`unverified` は0件 | ⑭の事実はすべて `unverified` として扱う |
| 〃 | 区切り2件は `position` になり、区切りとして渡らない | 区切りは `boundaries` で受け取れる。ただし評価期間（`windows`）にはしない |
| 時刻 | ⑮は `map.bellOfHour(f.hour)` で変換する。版0には `hour` がなかった | 版1 の `hour` に `time.bellsPerHour` を掛ける |

⑭は⑮のコードを変えていません。

### 5.2 最新版 `cb87e30c` との照合（未実施）

照合に要るもの（⑮の `cb87e30c`、前提コミットを明記した bundle か GitHub の push）：`workstreams/15-coop-outcomes/src/adapters/ws14.mjs`、`src/contract.mjs`、⑭の出力を使う試験と fixture。受け取ったら、⑭が渡した契約 v1 の fixture（`bde8d1c1` で作った A・B・C）を⑮の受け取り側に通して、時刻・掲示と応答の意味・`actor`・`unverified` の扱いを確かめる。
