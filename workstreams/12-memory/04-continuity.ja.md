# ⑫ 継続世界への移行（記憶 v4）

2026-10-31 の共通方針訂正（シーズン制の廃止、世界は継続）に対する⑫の対応。⑫の担当は「記憶と評判の履歴を維持する。減衰や訂正は別の規則とし、一括リセットしない」こと。**世界・期間・識別子・時計の正本は④（横断設計は⑧）のもので、⑫は定義しない。** ⑫は④から渡される前提を明示し、それを使う側として実装した。本番移行の実行ではなく、隔離環境での移行候補である。

## 1. 残っていたシーズン依存

### コードで確かめた、記憶に効く依存（チェーン側。持ち主は④・⑧）

| 箇所 | 依存 | 記憶への影響 |
|---|---|---|
| `frontier-abi/src/prologue.rs:962` `bell_at(genesis_ts, t)` | bell は Season の genesis から数える | 新しい Season で bell が 0 に戻る。記録の時刻を混ぜると、新旧が逆転したり衝突したりする |
| `frontier-abi/src/addr.rs:303` `with_seed(&self.season, …)` | citizen・holding・caravan の口座は Season 口座から導かれる | 同じ wallet でも Season ごとに citizen tag（＝caravan の `owner_tag`）と場所の口座が変わる |
| `permutation-frontier/src/proc/caravan.rs:927` | `settle_caravan` は Season が RUNNING か ENDED のときだけ受け付ける | 境界をまたぐ隊商の精算は④の判断。⑫は精算の事実があれば受け取る |

### 既存の AI 市民の記憶（`permutation-gateway/citizens`、未変更。`test/citizens-characterization.test.mjs` で挙動を固定）

| 箇所 | 挙動 | 確認した結果 |
|---|---|---|
| `memory/retrieve.mjs:35` | `created_bell < bellNow` の episode しか取り出さない | 新しい Season（bell 100）では、前の Season の episode（bell 4000〜5900）が**すべて見えなくなる** |
| `memory/ledger.mjs:152` | `day <= decay_day` なら何もしない | 新しい Season の day 1 では、減衰と日次のリセットが止まる |
| ledger の trust のキー | Season から導いた citizen tag | 同じ wallet の新しい tag は trust 0 から始まり、grievance が引き継がれない |
| `memory/store.mjs` `Episodes`（上限 200） | 重要度が低いものから、保存リストからも削除する | Season とは無関係だが、継続世界では履歴の上限になる（判断事項） |
| `mind/gate.mjs:82` | `endBell` 付近では `season_end` として autopilot | 行動の停止は⑬・⑤の担当（報告のみ） |
| `mind/prompt.mjs:81` | 「Season ends at turn …」を表示 | 文言は⑦・⑬の担当（報告のみ） |
| `mind/seal.mjs`、`audit/season_end.mjs`、`mind/records.mjs` | Season 終了で封印し、公開し、M11 で再生する | 公開と検証の単位は④・⑯の担当（報告のみ） |
| `memory/episodes.mjs` `genesis_ts`、`PRE_GENESIS` | episode の bell は Season 基準 | アダプタで世界時計へ写す |

### ⑫自身（v3 まで）

- 記憶の世界を `{cluster, program, season}` とし、coverage の一致条件に **season** を含めていた。そのため期間が切り替わると、前の期間の証明が使えなくなっていた。
- 署名付き割当の署名対象にも season を含めていた。
- caravan・場所・発送者の tag に partition がなく、Season ごとに変わる tag を本人とみなしていた。
- fold が一部 O(n²) で、履歴が増えると遅くなっていた（16,000 記録で 3.3 秒）。

## 2. 変更した挙動（記録 v4・fold v4・判断入力 v4）

- **世界**は `{cluster, world_id}` に変えた（④が定義）。Season と戦期は世界の識別に含めない。今の Season 口座は、④が登録する**partition**（`{id: {program, season}}`）として扱う。登録されていない partition の事実は journal に残し、使わず `unusable` として報告する。登録されれば使う（データは失わない）。
- **時刻**：すべての `bell` は④の世界時計で数える。減衰（半減期）は世界時計で連続して進み、境界でリセットしない。
- **識別子**：caravan は `{partition, sender(tag), seq}`、場所は `{partition, kind, p, q, at, gen}` で表す。tag と本人を結ぶのは④の `identity_alias`、異なる partition の場所を同じとみなすのは④の `place_alias` だけ。証明がなければ `identity_unverified` や `place_identity_unverified`（未確認）にし、別人・誤配送・未発送にはしない。同じ tag に別々の本人が証明されたら未確認に戻す。
- **評判**は本人（principal）単位で積み上がる。partition をまたいでも同じ相手の履歴として数える。上限なく増えることはない（古い根拠は減衰する）。
- **未発送の証明**は、partition ごとの coverage を `identity_alias` でつなぎ、期間全体を覆う必要がある。境界の後半が欠けていれば `window_not_fully_covered`。
- **署名付き割当**の署名領域を v2 にし、world から season を外した。境界をまたいでも有効のまま。nonce は署名者ごとに partition をまたいで一本で数える。
- **旧版（v3）の扱い**：v3 の journal はそのまま読む。割当の署名は v3 の署名領域（v1）で検証し、書き換えも再署名もしない。④が登録した legacy partition で v4 の形に読み替えるのは読込み時だけで、元の記録は変えない。season が登録と合わない v3 の coverage や割当は使わない。判断記録は、当時の入力（契約 v3）とハッシュのまま残す。
- **範囲検査**：世界 bell は u32、caravan の seq は u32、nonce は安全な整数（2⁵³ 未満）に限る。
- **性能**：fold の 2 乗の部分を索引にした。30,400 記録で fold 0.6 秒、再生（署名の再検証込み）0.8 秒（`results/longrun.json`、計測環境に依存）。
- **既存 AI 記憶への読取り専用アダプタ**（`continuity/citizens-adapter.mjs`、移行候補で、どこからも呼ばれていない）：episode を世界時計に写して既存の `retrieve` をそのまま使う、世界日で既存の `advanceDay` を回す、partition ごとの ledger を本人単位で合算して見せる。既存のファイルや保存データは変更しない。

## 3. 試験で確認したこと（75 件すべて通過。変異試験 57/57）

**境界の通過**（`test/continuity.test.mjs`。p1 = 世界 bell 0〜199、p2 = 200〜）

- p1 でした約束が、p2 の隊商で p2 の場所に届いた場合：同じ場所と同じ本人の証明があれば `fulfilled`。どちらかが欠ければ未確認になる（誤配送・未発送にはならない）。
- p1 で出発し、境界後に精算した隊商は 1 回の配送として数え、数量は 100。
- 評判：p1 と p2 の履行が同じ本人の 2 件になる。p1 の根拠の重みは世界時計の経過どおりに減り、境界でリセットされない。
- 未発送：p1 と p2 の coverage をつないで期間全体を覆う。p2 の tag の本人証明が来るまでは未確認。
- 割当：p1 で署名したものが p2 でも有効。p2 での訂正（nonce 2）が優先され、nonce 1 の再使用は拒否。
- 封印行軍と私的会話：境界の前後（bell 199・200・300）とも、第三者には見えない。
- 境界で再起動しても、再起動なしと状態ハッシュ・記録数が一致する。再配信は重複として扱い、配送と評判の件数は 1 回。
- 未登録の partition の事実は記録に残り、報告され、登録後に使われる。
- 境界前の判断を、境界後に届いた p1 の記録で再評価できる（元の入力も再現できる）。
- 同じ tag に矛盾する本人証明、別の world 向けの正しい署名の割当は、どちらも使わない。

**旧版**

- v3 の journal 4 本（`fixtures/legacy-v3/`、v3 コードで生成）を v4 で開くと、journal のハッシュは書き込まれたとおり、署名検証も通る。約束の状態・申告の判定・E・選択・判断入力のハッシュは v3 の結果と一致する。
- registry の season が違えば、v3 の coverage と割当は使わない。
- v3 の約束が、v4 の次の partition の配送で `late` として記録される。v3 と v4 の記録が混在しても、v3 は書き換えない。

**長期運用**（`test/longrun.test.mjs`、境界の試験とは別）

- 300 partition（世界 bell 60,000）で、id はすべて一意、根拠 300 件すべてが残り、数量の合計も正しい。最古の根拠は減衰して重み 0 と表示されるが、出典付きで一覧に残る。
- 評判は有界で収束する（150 partition と 300 partition で E の差は 0.001 未満）。
- 再起動して再生すると同じハッシュになる。fold の時間には緩い上限を設けた。判断記録のサイズは履歴の長さではなく、入力の上限で抑えられる。
- 上限：bell・seq は u32、nonce は 2⁵³ − 1 まで。

**既存 AI 記憶**（`test/citizens-characterization.test.mjs`、合成データ）

- 上の表の 4 つの挙動を、既存コードをそのまま実行して固定した。アダプタを通すと、前の Season の episode が取り出せる、世界日で減衰する、本人単位の trust が見える。

## 4. 移行や仕様判断が残る点

1. **④（⑧と）が決めること**：`world_id`、partition の登録（Season 口座の扱い）、世界時計（partition の bell → 世界 bell の対応）、`identity_alias`・`place_alias` の証明の出し方と根拠、境界をまたぐ隊商の精算の可否。⑫はこれらを受け取る側で、fixture では仮の値を使っている。
2. **既存 AI 記憶の切替**：アダプタは移行候補で、どこからも呼ばれていない。M11 の再生（`audit/season_end.mjs`）は Season 単位なので、world 単位の再生方法は④・⑯と決める必要がある。
3. **履歴の上限**：既存の episode 上限（200）は保存リストからも削除する。継続世界で「想起の上限」と「保存の上限」を分けるかは判断事項。⑫の journal は削除しないため、30,400 記録で 13 MB になる。分割や圧縮の方針は、④の保存方針と合わせて決める。
4. **戦期の集計**：⑫には戦期の概念を入れていない。戦期ごとに評判を集計する、見せるといった要件が出ても、それは表示や集計の側で行い、記憶の履歴や減衰は変えない前提。
5. **AI の行動停止と表示**：`season_end` での autopilot（⑬・⑤）、「Season ends」の表示（⑦・⑬）、Season 終了時の封印と公開（④・⑯）は報告のみで、変更していない。
6. **鍵の継続**：割当の鍵登録は本人単位を前提としている。鍵の更新や失効、partition ごとに鍵が変わる場合の扱いは未決定。
