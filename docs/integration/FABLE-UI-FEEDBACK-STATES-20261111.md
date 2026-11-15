# 既存 frontier 画面の操作フィードバックと読み込み・エラー表示（2026-11-11）

branch `fable/design-uiux-20261110`、worktree `/Users/r0ze/Projects/wylls-design-fable-20261110`、HEAD `8836f1aa`。担当: Fable 5.2。
commit・push・統合・配備はしていない。鍵・wallet・署名・送信は使っていない。

この文書は、今回の区切り（下の 8 件）の差分だけを正本へ安全に移すための引継ぎである。
確認は保存データ（herald golden `ws19-map-growth-s1`）を GET だけで配信する preview 上で行った。**実プレイ（live chain、wallet、送信）の確認ではない。**

## 1. 移し方（必ず patch だけを当てる）

- 移すのは `docs/integration/FABLE-UI-FEEDBACK-STATES-20261111.patch` だけ。**ファイル全体のコピーはしない。** この worktree の `app.mjs` などは正本より古い土台の上にあり、全体をコピーすると正本側の新しい変更（WorkerPost など）が消える。
- patch は「今回の開始時点 → 現在」の差分だけを含む（5 ファイル、13 hunk、311 行）。前回までの差分（第一改善分 9 ファイルと scroll hook）は含まない。
- patch 自体の SHA-256: `c993d74778f8293954429e40a1fe85a99f29caf4ffd3c071dd46a7624e82a89a`

```sh
# リポジトリのルートで
git apply --check docs/integration/FABLE-UI-FEEDBACK-STATES-20261111.patch
git apply docs/integration/FABLE-UI-FEEDBACK-STATES-20261111.patch
```

正本への適用可否は、正本を変更せずに確認した（対象 5 ファイルと `permutation-server/web` を作業フォルダへコピーして試した）。確認時点の結果:

| ファイル | 正本の内容 | 結果 |
|---|---|---|
| `frontier.css`、`hud/hud.mjs`、`screens/chronicle.mjs`、`web-frontier-design-pass.test.mjs` | この patch の適用前の内容と byte 一致 | そのまま当たり、適用後は下表の「適用後」と byte 一致 |
| `app.mjs` | 一致しない（正本は 4154 行、SHA-256 `7def80faccc5dd1822d6f0c9ddee890ca8cfb1c85d324a3ad9dabb3e5ae44a53`。scroll hook は入っている） | 6 hunk すべて位置ずれ（7 行と 41 行）だけで当たる。適用後の SHA-256 は `a01bc9d009b5545b7a38bd5ccc700eea18293d06d27b4a50d139edb789a984ef`、`node --check` 通過 |

コピーした正本のツリーで `web-frontier-design-pass.test.mjs` を実行すると、適用前は 25 件中 25 通過、適用後は 31 件中 31 通過だった。
`app.mjs` がこの確認のあとさらに変わって当たらない場合は、5 節の hunk 一覧を見て手で入れる（どれも数行で、互いに独立している）。

## 2. 変更ファイルと SHA-256（適用前 = 今回の開始時点、適用後 = 現在の worktree）

| ファイル | 行数 | 適用前 | 適用後 |
|---|---|---|---|
| `permutation-server/web/frontier/app.mjs` | +40 −7 | `f9bb7aa78c903fbaa0236d5e5acee69cd75f5b5f90bb8ce3aeb4f05c691fecd5` | `a0552a4c6c830a99f0a6836fc2aece14522c7bc885b73836f215f6afe18b04b5` |
| `permutation-server/web/frontier/frontier.css` | +32 −2 | `6836d3c9384f31a5f31b85509faea5ffadffea51fe4ef0c4c552b97d61fa71cf` | `d3ff9b1c97fcda16e73f1f7e7dfaeb43ad31b24d0870f3fa23d89bb17c2819ba` |
| `permutation-server/web/frontier/hud/hud.mjs` | +10 −1 | `18651e6fba620be84b215c5758c78fdecfc775e99cf8794bec5de86b89284d77` | `65cfa57cd7761d42c11d76a32968d3736a49dd2934dd7ea534a5544660ce60f9` |
| `permutation-server/web/frontier/screens/chronicle.mjs` | +3 | `73a2bca22c3e598f649e02db3e1bbaf1c209b8f2141809bd5af604c45d1fbad1` | `edbec1a87b3ba8382f04c72c243af3aba740af0f61169e1fed9556cc1616cf72` |
| `permutation-gateway/test/web-frontier-design-pass.test.mjs` | +102 −1 | `c17b84337ab106572864b475a7cb46c3b7b25ed482876105e184f2f43de45414` | `172a28cc9f2897789f2f208e287d24ca6655b389a33396d3ce86b048b642f569` |

今回変更していないもの: `controller.mjs`、`fexpedition-compose.mjs`、`fexpedition-return.mjs`、`fi18n.mjs`、辞書（`lang/*`）、Rust、gateway のソース。`frontier.css` の末尾（「the film's frame」以降）は不変。
新しい文言は足していない。使った文言はすべて既存の辞書にある（`シーズンの記録を読めません`、`通信の状態を確かめてください。読み込み直すと、もう一度試します。`、`記録を読み込んでいます…`、`{0}（{1}）`）。

## 3. 再現 → 修正 → 確認（8 件）

確認はすべて実ページ（`spectate.html`、`index.html`、`practice.html`、wallet なし）を Chromium で操作して行った。「前」は今回の開始時点、「後」は現在。

### キーボード

| # | 再現手順 | 前 | 後 | 変更箇所 |
|---|---|---|---|---|
| 1 | 観戦で drawer の「？」に focus して Enter、続けて Escape | 閉じたあと focus が `body` | 開いた「？」キー（`button.term-q`）に戻る | `app.mjs`: `closeTermPop({focus})`、`term`、`term-close`、Escape |
| 2 | 検索キーを Enter、`4,0` と入力して Enter | 移動後 focus が `body` | 地図（`canvas#frontier-map`）に移る | `app.mjs`: `search-go` |
| 3 | プレイ画面で dock の「Marches」に focus して Enter（「More」は Space） | focus が `body`、次の Tab は dock の先頭「Map」 | 押したキーに残り、次の Tab は隣のキー | `app.mjs`: `renderPlay` の dock を `keepState` で描く |
| 4 | 「Records」を Enter で開き、Tab を 26 回 | 6 回目以降、シートの裏の地図キー・検索キー・レンズに focus が入る | シートのキー → 上端の帯（brand、dial、音、言語）→ シートの閉じるキー、の巡回だけ | `frontier.css`: シートが覆う部品を `visibility: hidden` |

### 読み込み・エラー表示

| # | 再現手順 | 前 | 後 | 変更箇所 |
|---|---|---|---|---|
| 5 | `/h/season` が 503 を返す preview で観戦を開く | バナー「Unknown error (HTTP503)」、状態「Loading…」のまま、順位カードは 6 国とも「0 villages · 0 provinces」、見どころと年代記は「Loading the record of events」のまま | バナー「The season's record cannot be read. (HTTP503)」、状態の表示なし、順位カードは「The season's record cannot be read. / Check your connection. Reloading tries again.」、見どころと年代記は「The record of events could not be loaded (HTTP503). …」 | `app.mjs`: `bannerText`、`renderStatus`。`hud/hud.mjs`: `renderRail`。`screens/chronicle.mjs`: `chronicleState`。`frontier.css`: `#season-status:empty` |
| 6 | すべての `/h/` が 3 秒遅れる preview で観戦を開き、1.2 秒後を見る | 順位カードが 6 国とも 0 | 「Reading the record…」 | `hud/hud.mjs`: `renderRail` |
| 7 | 5 と 6 の画面で、読み込み状況の行（`.read-state`）を見る | アイコンが文の上の行に単独で出る | アイコンと文が同じ行 | `frontier.css`: `.read-state` |
| 8 | 390×844 の観戦で、拒否通知（ラベル付き effects demo `?fx=refused`）と 5 のバナーを見る | 通知の上端 162px が 3 段目のキー「Records」（160〜204px）に重なり「Try again」が半分隠れる。バナーは「World」「Records」に重なる | 通知とバナーは 212px から。キーに重ならない | `frontier.css`: スマホで地図キーが 3 段のときの `.feed` と `.banner` |

実測の補足:
- 4 の「後」の巡回順: `wide-in` → `wide-out` → `wide-recentre` → `wide-concord` → `wide-reload` →（ブラウザ）→ `a.brand` → `#bell-pill` → `#sound-btn` → 言語キー → `#wide-close` → `#wide-canvas`。シートを Escape で閉じると focus は従来どおり地図に戻る。
- 8 のキーの位置（CSS px）: home 338,60〜382,104、chart 301,110〜382,154、wide 286,160〜382,204。地図キーが 2 段の場合（村のプレートに home がある play、参加前）は従来の位置のまま。

変更なしで問題なかったもの（同じ手順で前後とも同じ結果）: 閉じる→再選択、閉じる→同じマスを再選択、3 か所の連続クリック、ダブルクリック、drawer 開閉の連打、dial 4 連打、レンズ連打、全体図 3 連打、全体図上での選択、Escape による drawer と選択の解除、M キー。前回の scroll hook も再測定して変化なし（新しい選択で先頭へ、選択不変の再描画と drawer 内の「View」では位置を保つ、スマホの owner は `#panel`）。

## 4. テスト（すべて `no-key-node.mjs` 付き、guard の検出 0）

```sh
cd permutation-gateway
node --import ./screens/codex/no-key-node.mjs --test test/web-frontier-design-pass.test.mjs
```

- `web-frontier-design-pass.test.mjs`: 31 件中 31 通過（今回 6 件追加）。追加分は、観戦の順位カード（読み込み中・失敗・最初の応答後）、年代記の状態、バナーの文言、focus を戻す hook とスタイルの pin。
- 鍵を使わない 135 ファイル（`web-frontier-*`、`web-lang`、`web-i18n`、`screens/logic.screen.mjs` のうち鍵 import のないもの）: 1314 件、1304 通過、10 失敗。
- 失敗 10 件は今回の開始時点と同じ。9 件は assertion の出力まで一致。残る 1 件（`web-frontier-conquest-wiring.test.mjs:80`）は同じ正規表現の不一致で、失敗メッセージが `app.mjs` の全文を表示するため追加行が現れるだけである。
- 対象外: 鍵 import を guard が止めるファイル（`web-frontier-territory` など）と、開始時点でも読み込み時に落ちる `web-frontier-errors`。迂回も再実行もしていない。

## 5. `app.mjs` の 6 hunk（手で入れる場合）

どれも表示と focus だけで、ゲームの状態・command・gate・world の読み込みは読み書きしない。

1. `renderStatus` の直前に `export function bannerText(error, haveSeason)` を追加。`renderStatus` 内で、季節がなくエラーがあるとき状態の語を空にし、バナーの文を `bannerText(FS.error, !!s)` にする。
2. `renderPlay`: `if (tabs) setHtml(tabs, renderTabs(…))` を `if (tabs) keepState(tabs, () => setHtml(tabs, renderTabs(…)))` に。
3. `closeTermPop` を `closeTermPop({ focus = false } = {})` にし、直前に `let termFrom = null;` を追加。`focus` のとき、開いた「？」を term と順番で探し直して focus する。
4. `search-go`: `setSearch(false, { focus: false })` の直後に `$('frontier-map')?.focus?.({ preventScroll: true })`。
5. `term` の action: 開くときの `document.activeElement` が同じ term の「？」なら `termFrom` に記録。`'term-close'` は `closeTermPop({ focus: true })`。
6. Escape の処理: `FS.term` のとき `closeTermPop({ focus: true })`。

## 6. 直していないもの

- 州の読み込みが失敗または 404 のとき、詳細カードは「Loading what is in this province…」のまま残る。失敗の印が `controller.mjs`（`wantProvince` / `loadEnvelope`）にないため、表示側だけでは区別できない。別担当の変更が要る。
- プレートの「Choose a nation」を Enter で押すと focus は `body` になるが、次の Tab は国選びの閉じるキー、その次は最初の旗に入る（実測）。変更していない。
- 検索結果を矢印キーで移動する操作はない。新機能になるので足していない。

## 7. 未検証

- wallet 接続・送信・live chain を伴う実プレイ。
- 村を持った状態の実ページ（行動バー、到着候補・出発・帰還）。
- Safari、Firefox、実機スマホ（確認は Chromium のみ。`:has()` を使っている）。

## 8. 証跡

比較画像と操作の記録は作業フォルダにあり、セッションをまたぐと消えることがある（前回は `/tmp` の基準とともに消えた）。要点の数値はこの文書に写してある。

- `/private/tmp/claude-501/-Users-r0ze-Projects-wylls-design-fable-20261110/d3ddee7f-38b8-4cc2-9fc9-098bca13cf8e/scratchpad/round3/`（`before/`、`after/`、`sheets/`、`probes/`、`INDEX.txt`）
- 今回の開始時点の hash 一覧と web のコピー: 同じ作業フォルダの `round3-baseline/`、`round3-before-web/`
