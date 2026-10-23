# デザイントークンと主な部品

2026-10-24。今のクライアントのトークン（`permutation-server/web/frontier/frontier.css` の `:root`）に、状態のトークンを足した。新しい部品は `uplift.css` にまとめた。

## トークン

### 既存（変えていない）

| 群 | 名前 | 用途 |
|---|---|---|
| 金属（HUD） | `--metal` `--metal-2` `--metal-glass` `--brass` `--brass-hi` `--brass-lo` `--hud-ink` `--hud-ink-2` | 上の帯、村の札、ドック、小地図 |
| 紙（文書） | `--paper-sheet` `--sheet` `--ink` `--ink-2` `--ink-rule` `--ink-soft` `--ink-stamp` | 引き出しの札、報告、命令 |
| あなた | `--you`（金）。地図では `palette.mjs YOURS_MARK`（金・象牙の芯・暗い縁） | 自分の物だけ |
| 国 | `palette.mjs` の FILL / DARK / LIGHT / DEEP / INK / ON / MARK / LAND | 用途ごとに列を選ぶ。色だけで国を言わず、印を添える |
| 文字 | `--t1` 12、`--t2` 14、`--t3` 17、`--t4` 24。`--ui`（ゴシック）、`--display`（明朝） | 名前と見出しは明朝、数字は等幅 |
| 余白 | `--s1` 4、`--s2` 8、`--s3` 12、`--s4` 16 | |
| 動き | `--in` 220ms、`--out` 160ms、`--press` 70ms | 動きを減らす設定では止める |

### 追加：判断の状態（`--st-*`）

状態は **色と形の両方** で言う。色だけに頼らない。

| 状態 | トークン | 形 | 使う場所 |
|---|---|---|---|
| 予測（ルールが試した見込み） | `--st-forecast` `--st-forecast-bg` | 点線の枠、縞の背景 | 見通しの予測、構えの比較、報告の予測の列 |
| 確定（記録の数） | `--st-done` `--st-done-bg` | 塗りつぶしの判 | 報告の確定の列、送信の済んだ段 |
| 待機（送った、まだ決まらない） | `--st-wait` `--st-wait-bg` | 丸い枠 | 送信の進行中の段、満杯までの時間 |
| 失敗（断られた、何も変わらない） | `--st-fail` `--st-fail-bg` | 角を一つ欠いた枠 | 予測の幅の外 |
| 封印・取り消せない | `--st-sealed` | 錠の印 | 封の押印の上の一行 |

## 部品

| 部品 | クラス / 関数 | 中身 |
|---|---|---|
| 状態の札 | `.state-tag` ＋ `.state-forecast` / `.state-done` / `.state-wait` / `.state-fail` / `.state-sealed` | 数字の前に置き、その数字の種類を言う小さな語 |
| 見通し | `marchcard.mjs outlook()` / `.mc-outlook` `.mo-cell` | 2 列 × 2 段の事実。各欄は「見出し・値・出どころの一行」 |
| 構えの比較 | `marchcard.mjs stanceCompare()` / `.mc-compare` `.mcc-row` | 行がそのままボタン（role=radio）。選んだ行に縁 |
| 取り消せない一行 | `.order-irrev` | 錠の印と一文 |
| 予測と確定 | `report.mjs renderPrediction()` / `.rep-predict` `.rp-table` | 予測（点線の札）と確定（判）の 2 列 |
| 満杯まで | `.ledger-fullin` | 1 時間以内に満杯になる蔵に、その時間 |
| 施設の絵 | `map/structures.mjs` paintVaultArt / paintTowerArt / paintPalisadeArt / paintFortArt / paintCartArt / paintYoursRing | 村の道具（`village.mjs villageKit`）で描く。描けない文脈（試験の記録器）では何もしない |
| 予測の帳面 | `hud/forecastbook.mjs` keepForecast / forecastFor | 送ったときの予測をこの端末に残す |

## 守ること

- 予測の数字には必ず「予測」の札を付ける。確定の数字には「確定」の札か、記録から来たことを言う一行を付ける。
- 見えていない土地については、数を言わない（「わからない」）。
- 他国の封印中の進軍に、線・矢印・向きを描かない。
- 取り消せない操作のボタンの近くに、取り消せないことを書く。
- 新しい語は `L\`…\`` で書き、英語を `lang/en-frontier-play.mjs` に足す（同じ日本語に別の英語を当てない：`web-lang.test.mjs`）。
