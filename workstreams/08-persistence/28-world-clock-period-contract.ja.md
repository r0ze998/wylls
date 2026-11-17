# 28 世界ID・時計・期間の契約（④と整理した版。①⑫⑬⑮へ）

- **日付：** 2026-11-06
- **照合した版：**
  - ④の最新 `8e96f24df4aa4ed51277fa42de6a354a21cd2bc6`（`origin/claude/gallant-ride-cunptv`）
  - ④の `CONTINUITY.ja.md` §4.1 と `contracts/registry.txt`
  - ⑫ `ea0636eb`（`adapters/ws08-world.mjs`、`canonical.mjs`）
  - ⑬ `de6df669`（`resident/frame.mjs`、`WORK-20261106b`）
  - ⑮ の「世界と戦期」の設計（23章）
  - ① `3f3c8478`（`coop/board.mjs`）
- **位置付け：** ④の案（世界の口座を固定し、`season_id` を増やさない）と、⑫⑬がすでに使っている形に合わせた、共通の読み方の**候補**です。正本は④の registry と④の文書です。⑧は横断設計として、この形を提案します。
- **決めないこと：**
  - 戦期の長さ・区切り方・集計
  - 賞金・参加費・NFT
  - 戦期の口座（④の P-C4）の中身
  - 地図の上限の採否

## 1. 世界ID

| 項目 | 契約 | 正本の在りか |
|---|---|---|
| 世界の口座 | ゲームの program の下の Season PDA `["season", le64(season_id)]` | チェーン（④の registry `[world]`） |
| すべての口座の住所 | `sha256(世界の口座 ‖ seed ‖ program)` | 同上 |
| `season_id` | 世界の口座を作ったときの番号。**以後増やさない**。名前は Season のままだが、意味は世界の番号 | Season のオフセット 8（u64） |
| `world_id`（文字列） | `<program の base58>/<世界の口座の base58>` | ⑫⑬と同じ形。⑧が定義を追認 |
| 世界の名前 | `{cluster, world_id}`。cluster が違えば別の世界 | herald `/h/season` の `cluster`・`programId`・`seasonAddress` |
| 継続する世界かどうか | 征服パラメータのバイト80 `CONTINUOUS` = 1、かつ `end_bell` = `join_close_bell` = u32::MAX | Season のバイト（正本）。herald の `continuous` は写し |
| 読めない世界 | フラグが 0・1 以外、配置（バイト77）が 0・1 以外、継続なのに `end_bell` が有限、層と program の版の不一致 → **読まない**（`BadWorldMode`、`InvalidSeasonMode`） | ④の fail-closed の規則。⑧の移植で配置にも適用 |
| 有限の旧版の Season | それぞれが別の世界の口座。終わった記録として読むだけ。⑫は「世界なしの partition」（`world_not_continuous`）として扱う | — |

- **地図拡張は世界IDを変えません。** 広がった輪も、同じ世界の口座の下の州です。
- **後から来る人も同じ世界です。** 継続世界には参加の締切がありません。

## 2. 時計

| 項目 | 契約 |
|---|---|
| 世界の bell | `bell = floor((t − genesis_ts) / bell_secs)`。`t ≥ genesis_ts` のときだけ。u32 |
| `genesis_ts` | Season のオフセット 144（i64、unix 秒）。herald `genesisTs` |
| `bell_secs` | Season のオフセット 140（u32）。herald `bellSecs`。今の型はすべて 600 ですが、**読み取り、仮定しない**（⑫と同じ） |
| 0 に戻さない | 戦期の境界でも、地図拡張でも、再起動でも、`genesis_ts` と bell の番号を変えない。封印進軍の開封（⑱）と記憶の減衰（⑫）が、これに依存します |
| 時計が同じとは | `{kind: 'season-bell', genesisTs, bellSecs}` の3つが全部一致すること（⑬の定義を追認） |
| slot から bell へ | ブロックの時刻（`getBlockTime`）が分かるときだけ写す。分からなければ保留し、推測しない（⑫の `clockFromGenesis`） |
| 日 | `floor(bell / (86,400 / bell_secs))`。画面の `BELLS_PER_DAY = 144` は `bell_secs = 600` のときだけ正しい |
| 上限 | u32::MAX は「終わりなし」（`NO_END_BELL`）の印です。使える bell は u32::MAX − 1 まで（600秒なら約81,700年） |

- **上限付近の注：** ベル u32::MAX を超える時刻では、カーネルの `bell_at` は「なし」を、画面の `bellAt` は数え続けた値を返します（⑧の照合 `kernel-parity`）。到達しない時刻のため、どちらにも変更は求めません。

## 3. 期間（戦期）

| 項目 | 契約 |
|---|---|
| 正本 | **未決**。④の P-C4（戦期の口座）の案はありますが、中身は決まっていません |
| それまでの渡し方 | 外からの入力 `windows: [{id, opensAt, endsAt}]`（⑮の形） |
| 単位（⑧の提案。④の確認待ち） | `opensAt`・`endsAt` は**世界の bell**（u32）で、半開区間 `[opensAt, endsAt)`。秒や slot で持つ側は、2章の時計で bell に直してから渡す |
| `id` | 入力を出す側が付ける不透明な文字列。`season_id` からは作らない |
| 境界で起きること | 世界の状態は何も変わらない。番号が進むだけ（④の模擬の正本と同じ） |
| 旧版の有限の Season | その世界の `[0, end_bell)` が、その世界だけの区間。新しい世界の bell と比べない |

- 戦期の長さ・何を数えるか・賞金の配り方は、この契約では決めません。
- 賞金の旧経路（Season 単位の pool）は、有限の世界の互換として残ります（④の試験済み）。継続世界では InitPool が `ContinuousSeason`（0x112）で拒否します。

## 4. 地図拡張との関係（⑧）

- **実効の最外輪：** `max(Season の r_max, Frontier の r_max_ext)`。Frontier のオフセット 66（u16）。
- **上限：** 征服パラメータの `r_max_ceiling`（バイト78〜79）で、最大でも輪128（ハードリミット）。**無限の地図ではありません。**
- **賞金との関係：** 賞金の集計は輪17まで（InitPool が `CeilingPastTally` 0x111 で拒否）。上限と賞金の関係は未決です。
- **最初の本拠の配置：** 征服パラメータのバイト77 `PLACEMENT`（0：扇形、1：分散）。どちらを採るかは未決です。
- **履歴：** 拡張は `ExtendFrontier`（0xC1）で、ログの種類 `FRONTIER_EXTENDED`（104）として残ります。

## 5. 履歴（④の M4・M7）

- **出来事の識別：** ④の規則（`署名 ‖ 命令の位置 ‖ ログの位置`）。herald の `/h/events` の番号は畳み込みごとのもので、正本にしません。
- **口座ごとの連続性：** すべての口座が `EVENT_SEQ`（オフセット24）と `EVENT_HEAD`（オフセット32、ハッシュの鎖）を持ちます。欠落の検査に使えます。⑧は追加していません。
- **M7 履歴の圧縮：** 未決です。⑧からは事実だけを出します。
  - ローカルでの実測：1ゲーム日あたり、61州で約0.37 GB、169州で約0.7 GB。
  - keeper の journal（平文・持ち主の材料）には、削除の経路がありません（⑱）。
  - 検証器は CreateSeason から全部を再生します。区切り（checkpoint）の定義が要ります。
  - 地図拡張で州が増えると、増え方も大きくなります。
  - 圧縮の規則は④と決める事項として残します。

## 6. 番号の割り当て（④の最新での状態）

| 番号 | 意味 | ④の `8e96f24d` | ⑧の移植 `workstream/08-on04` |
|---|---|---|---|
| エラー 94 | `ContinuousWorld` | 採用済み（⑩は 95） | 同じ |
| prize 0x111 | `CeilingPastTally` | 空き | 追加 |
| prize 0x112 | `ContinuousSeason` | 採用済み | 同じ |
| 命令 0xC1 | `ExtendFrontier` | 空き | 追加（registry を再生成。差分はこの1行だけ） |
| ログ 104 | `FRONTIER_EXTENDED` | 空き | 追加 |
| 征服 77 | `PLACEMENT` | 予約（0 必須） | 項目に |
| 征服 78〜79 | `R_MAX_CEILING` | 予約（0 必須） | 項目に |
| 征服 80 | `CONTINUOUS` | 採用済み | 同じ |
| Frontier 66 | `R_MAX_EXT` | 予約 `RSV_66` | 項目に |

- **注：** ④の registry には、prize のエラー 0x111・0x112 が載っていません（0x110 まで）。登録の対象にするかは④の判断です。
- **旧版との読み合わせ：** ⑧の地図の program でローカルに作った世界（mx-1、上限7）の Season のバイトは、④の最新では「予約のバイトが 0 でない」として読めません。⑧の移植では読めます（画面の復号で確認）。

## 7. 各担当にとって

| 担当 | 今使っているもの | この契約との差 |
|---|---|---|
| ① 協力の板（`coop/board.mjs`） | `--program`・`--season` と、Season から導いた住所 | 差なし。`season_id` が増えないので、住所はそのまま。継続世界では、評価の区間を3章の `windows`（bell）で受け取る形に寄せられます |
| ⑫ 記憶 | `{cluster, world_id}`、Season の bell、`bellSecs` を読む | 差なし。旧版の Season は partition |
| ⑬ 住民 | ⑫と同じ world_id。時計は `{kind, genesisTs, bellSecs, source}` | 差なし |
| ⑮ 協力の達成評価 | `windows: [{id, opensAt, endsAt}]` | 単位を世界の bell の半開区間にする提案（④の確認待ち） |

## 8. 機械で読む形

同じ内容を `contract/world-clock-period.json` に置きます（例と、各項目の在りか）。
