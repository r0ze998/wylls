# ⑦ 統合の確認条件と保全

この文書は、⑦ の成果を統合するかどうかを決めるための条件表である。機能は増やしていない。ここに書いた「未修正」「未検証」は、そのまま判断の材料として残した。

- push・merge・deploy はしていない。
- 権限で拒否された SBF 環境（Agave）は、回避も再試行もしていない。
- 外部への募集や送信はしていない。

---

## 0. 修正版 v2（この節が最新。§1〜§7 は v1 の記録として残す）

### 0.1 ブランチと commit

- 新しい作業ブランチ：`claude/ws07-return-fixes-oixhgs`（ローカルのみ。push していない）
- 分岐元：`e9e20d1f230438048c54c6cf7384ca9d854364b2`。保全のため、元のブランチ `claude/wylls-ui-ux-visual-oixhgs` と v1 の保存パッケージは、変更せずに残した。
- v1 のパッチは `patches/v1/` に移し、中身は変えていない（SHA256 は §1.3 と同じ）。v2 のパッチは `patches/v2/` に入れた。

### 0.2 v2 のパッチ：基準・順序・依存

基準は `a997a756db1f3ffdea32d3d4a736fff85534585c` で固定する（局所修正を含み、パッチ側には含まない）。

| 順 | パッチ | 中身 | 単独で当たるか | 依存 |
|---|---|---|---|---|
| 0001 | 締め切り表示 | ターンの長さと締め切りをシーズンから読む（v1 の 0003） | **当たる** | なし |
| 0002 | 柵と予測 | 柵を避ける経路、プログラムと同じ組み立ての予測、包囲の事前判定（v1 の 0001） | 当たる | なし |
| 0003 | 留守の要約（修正済み） | v1 の 0002 に、C1〜C6 の修正を入れたもの | 当たらない | **0002 が必要**（import 行とテストのファイルを共有） |
| 0004 | 表示契約と協力入口 | ④⑤ の状態の表示、① の協力入口の枠（`CONTRACTS.ja.md`） | 当たる | なし |
| 0005 | S1 部品の画面テスト | Chromium で、S1 の記録から実クライアントの部品を描く | — | 0003 と 0004 が必要 |

`git am` で当たるかを、基準の上で組み合わせごとに確かめた。

| 組み合わせ | 結果 |
|---|---|
| 0001、0002、0004 をそれぞれ単独 | 当たる |
| 0001+0002、0001+0004、0002+0004、0002+0003、0002+0003+0004、0001+0002+0003、0001+0002+0004、0001〜0004 | 当たる |
| 0003 単独、0001+0003 | 当たらない（0003 は 0002 が必要） |

v1 では「0003（締め切り）が 0002（留守）の上でしか当たらない」という問題があった。v2 では締め切りを先頭に置き、基準だけで当たるようにした。

### 0.3 C1〜C6 の修正と回帰テスト

修正は 0003 にある：`hud/returnsum.mjs`、新しい `hud/awayread.mjs`、`hud/returnwords.mjs`、`app.mjs`、`hud/feed.mjs`。回帰テストは `permutation-gateway/test/web-frontier-ws07-away.test.mjs` の 21 件で、通常テスト（`npm test`）に入る。

| # | 修正 | 回帰テスト（抜粋） |
|---|---|---|
| C1 欠けがあっても位置が進む | 要約に `confirm` を持たせた。欠けがあれば `{ok:false, why:'gap'}` で「確認した」を出さず、理由を出す。`confirm()` も ok でなければ書かない。読み込みは確認位置そのものから行うので、年代記の窓のせいで欠けが出ることはない | 「C1: with a gap … the mark does not move」「C1: the reader reads from the mark itself …」 |
| C2 初回の窓より前まで確認済みになる | 初回は、窓の最初のターン（読み始めが遅ければ、読めた最初のターン）を `horizonBell` として位置と一緒に保存する。次回は「この端末では第 N ターンより前の出来事は見ていません」と出す | 「C2: a first look marks its window's first turn as the horizon …」「C2: … says from which turn it read」 |
| C3 常に `complete: true` を渡していた | 専用の読み込み器が、最後のページか、失敗か、ページ数の上限かを返す。途中で止まったら「途中で失敗」「まだ続きがある」と出し、読めた最後の記録までしか確認済みにしない。続きは次に、そこから読む | 「C3: a page that fails stops the reading …」「C3: the page limit is not a complete read」 |
| C4 奪われた隊商の持ち主を取り違える | 隊商ごとに、いまの持ち主（`caravanBook`）を記録から積み上げる。2 回目以降の知らせにも引き継ぎ、道中の隊商の分は確認位置と一緒に保存する。送った記録も奪われた記録も読めていない隊商は「持ち主不明」とし、送り主の到着とは言わない。項目には送り主と持ち主を別々に持たせる | 「C4: a caravan taken from the viewer arrives for the taker …」「C4: between two looks the book is carried on …」「C4: the book is kept with the mark …」「C4: with neither the send nor the take read, the holder is unknown …」 |
| C5 重複・順序 | `normalizeRecords` で、seq ごとに 1 件にし、昇順に並べ、seq の無い記録を除いて数える。ページが重なっても 1 回だけ読む | 「C5: records read twice or out of order …」「C5: overlapping pages from the herald are read once」 |
| C6 シーズン・ウォレットの切替 | 読み込み器を、herald・シーズン・ウォレットの組（scope）に結びつけた。scope が変わったら最初から読み、ほかの scope の知らせを消し、遅れて届いた古い結果は捨てる。確認位置がシーズンの先頭より先を指していれば使わず（`markAhead`）、「確認した」で置き換える | 「C6: another wallet and another season never read this one's mark or book」「C6: a reading started for one scope and overtaken by another is stale」「C6: a mark beyond the season's head …」 |
| 再読込・二度押し・保存失敗・別端末 | 確認位置は後ろへ戻らない（別のタブの古い要約に引き戻されない）。書いたあとに読み直して確かめる。黙って書き込みを捨てる保存領域も「失敗」と扱う。v1 形式の位置も読める | 「a reload without "seen" …」「storage that refuses or silently drops a write …」「another device …」「a version 1 mark …」 |

### 0.4 通常のテストと REPRO の分離

- **通常のテスト**：修正後の正しい挙動を求める。
  - `permutation-gateway/test/web-frontier-ws07-*.test.mjs`：パッチ側。`npm test` に入る。away 21 件、contracts 8 件、s1walk、terms、guide。
  - `workstreams/07-player-experience/tests/*.test.mjs`：43 件。⑦ の model のテスト。
- **REPRO**：欠陥の存在を確かめる。`workstreams/07-player-experience/tests/repro/*.repro.test.mjs` の 12 件。
  - 基準（パッチなし）では通る。パッチを当てると、直った欠陥の分だけ失敗する。
  - 常時テストには入れない。各ファイルの先頭にもそう書いた。
- **画面テスト（S1 の記録から部品を描く）**：`permutation-gateway/screens/ws07-s1.screen.mjs` の 8 件（0005）。
  - S1 の記録は、v2 のログ表から作った合成で、チェーンで記録したものではない。
  - ページ全体は起動していない。S1 の世界には配置 v2 の固定データが要るが、screens の固定データには無い。
  - 「確認した」の配線は、テスト用ページで app.mjs と同じ手順を組んだもの。app.mjs そのものの配線は、通常テストの「the page reads the away summary from its own reader …」が、ソースを読んで確かめている。
  - M1 の画面テスト（78 件）が通っても、S1 の画面が動いたとは言えない。この 8 件も、「S1 の記録を実際の部品で描けた」ところまでしか言えない。

### 0.5 テストの結果（v2）

| 対象 | 木 | 結果 |
|---|---|---|
| `npm test`（0001 だけ） | `31247c7a…` | 2,534 通過、失敗 0、スキップ 1 |
| `npm test`（0002 だけ） | `619dc71f…` | 2,537 通過、失敗 0、スキップ 1 |
| `npm test`（0004 だけ） | `2f74b6fc…` | 2,539 通過、失敗 0、スキップ 1 |
| `npm test`（0001〜0005） | `9aae9692…` | 2,571 通過、失敗 0、スキップ 1 |
| M1 画面テスト `frontier.screen.mjs`（0001〜0005） | `9aae9692…` | 78/78。固定版 playwright-core 1.58.2 のブラウザが未導入のため、用意済みの 1.63.0 で実行 |
| S1 部品の画面テスト `ws07-s1.screen.mjs`（0001〜0005） | `9aae9692…` | 8/8 |
| ⑦ の通常テスト `tests/*.test.mjs` | パッチなし、あり | 43/43、43/43 |
| ⑦ の REPRO `tests/repro/*.test.mjs` | パッチなし | 12/12 通過 |
| ⑦ の REPRO `tests/repro/*.test.mjs` | パッチあり | 7 通過、5 失敗（直った欠陥の分。意図どおり） |

- パッチを当てても通ったままの REPRO 7 件は、留守の要約の 3 件、予測の 3 件、不足の 1 件。
- これらはパッチが残した古い関数（M1 の経路の予測、`feed.diffFeed`、年代記の窓、昇格カード）の性質を固定している（§2.2）。
- 留守の要約の欠陥そのものは、通常テスト側の away 21 件で、修正後の挙動として確かめている。

v2 の 0004 は、最初の版で既存のテストが 2 件失敗した。理由は 2 つあったので、ここに記録しておく。
- CSS の末尾は「映像の枠」の規則のために空けておく決まりがあり、既存のテストがそれを確かめていた。
- 辞書に、同じ日本語を別の英語で訳した項目があった（「なし」「解放：{0}」）。

どちらも 0004 の中で直し、既存のテストは変えていない。

### 0.6 まだ確かめていないこと（v2）

- ページ全体を S1 で起動した画面（S1 の配置 v2 の固定データが無い）
- 実チェーンの S1 記録での留守の要約（S1 の記録ログは保存されていない。SBF 環境は権限で拒否されたまま回避していない）
- ④⑤① の実物との接続（成果物を受け取っていない。`CONTRACTS.ja.md` §5）
- 試作（`prototype/`）の留守の画面は、v1 の model（`src/return-summary.mjs`）のままで、C1〜C6 の修正は入っていない。修正後の挙動の基準は、0003 とその画面テスト。

## 1. commit と変更範囲

### 1.1 基準と commit

| 種類 | 完全な SHA | 中身 |
|---|---|---|
| 基準 | `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（tree `fb0635892650f4ae2b028ec488d14ddb75fe5eeb`） | PR #22 の統合候補。main への merge 済みでも CI 通過済みでもない |
| 局所修正 | `a997a756db1f3ffdea32d3d4a736fff85534585c`（tree `f9003cd8906e60bba6c6413355f52d2e77c62200`） | 共有クライアントの 2 ファイルだけ（下記） |
| 成果物 | `b9452f5b42c451ff009819bf99bcdf93ff743b82`（tree `ad18c62959b4bd43909beb79ff2503c4e1ac16e6`） | `workstreams/07-player-experience/` の追加だけ。ほかのファイルには触れていない |
| 整理 | この文書を入れた commit（SHA は保存パッケージの `MANIFEST.txt` に記録） | 本書、試作の 2 文言、試作の記録の取り直し。これも `workstreams/` の中だけ |

ブランチは `claude/wylls-ui-ux-visual-oixhgs` で、push はしていない。

### 1.2 局所修正 `a997a756` が触れたファイル

| ファイル | 変更 |
|---|---|
| `permutation-server/web/frontier/hud/guide.mjs` | +12 行。conquest と S1 のシーズンでは、地図のガイドが引き出しの手順（conquestObjective）に従う |
| `permutation-gateway/test/web-frontier-ws07-guide-s1.test.mjs` | 新規 3 件。修正前は 1 件通過・2 件失敗、修正後は 3 件通過 |

### 1.3 未適用のパッチ（`patches/`）

| 順 | ファイル | SHA256 | 中身 |
|---|---|---|---|
| 1 | `0001-Web-client-S1-walks-round-the-palisades-that-stop-th.patch` | `a87a095306347301c490c2b813636b5878f1dd7771e32c3be0df334bb00b73d2` | 柵を避ける経路（進軍の計画と隊商の道）、プログラムと同じ組み立ての予測、包囲の事前判定 3 件、herald が州のバイト列を保つ変更 |
| 2 | `0002-Web-client-S1-what-happened-while-away-from-the-reco.patch` | `23c8482c2626e628c69729725ea174a085fb162fa34dfd9d054035e243c79f1a` | 留守の要約（`hud/returnsum.mjs`、`hud/returnwords.mjs`）、知らせの種類 away/s1、`away-seen` の操作 |
| 3 | `0003-Web-client-the-turn-s-length-and-the-season-s-deadli.patch` | `cf737de77fb1440b06d34933e584889615cf9594f912681a156fc5a026fec98b` | ターンの長さと締め切りをシーズンから読む（`seasonterms.mjs`）。既存テスト 3 件の文の固定を更新 |

- 適用順は 0001 → 0002 → 0003。0002 は 0001 の上に、0003 は 0002 の上に作ってある（どちらも `app.mjs` と `en-frontier-play.mjs` を共有する）。順番を入れ替えたり、途中を抜いたりすると当たらない（§4.1 の末尾）。
- パッチの `From <sha>` 行は、作業用の別 worktree で作った commit の SHA である。このリポジトリには存在しない。

### 1.4 検証した最終 tree

`git am` は committer の日時を入れるため、適用後の **commit SHA は毎回変わる**。照合には **tree SHA** を使う。

| 基準 | 適用後の tree | 状態 |
|---|---|---|
| `a997a756` + 0001〜0003 | `2a049560d1a9394988315ce28a38d42b35098cb3` | **検証済みの最終 tree**。npm test 2,542 通過、失敗 0、スキップ 1（§6） |
| `b9452f5b` + 0001〜0003 | `1f238edba6e7843597b145eaf10ff2583b4c9960` | 上と同じクライアントに `workstreams/` を足したもの。`workstreams/` の外の差は 0 件と確認済み |
| `4cd901de` + 0001〜0003 | `94a6a27ded6facbd8b2db19085c9fc12401421bd` | 当たるが、ガイドの局所修正を含まない。**テストしていない。統合には使わない** |

### 1.5 二重に適用しない手順

1. 局所修正は `a997a756` だけにある。パッチ 0001〜0003 は `hud/guide.mjs` にもそのテストにも触れていない（0001 の `import * as guide` は文脈行で、変更ではない）。
2. 統合は「`a997a756` を取り込み、その上に 0001 → 0002 → 0003 を `git am` する」の 1 通りに限る。`a997a756` を取り込んだ枝に `guide.mjs` の差分を手で写さないこと。
3. `workstreams/07-player-experience/src/` は、試作とテストのための**同じ規則の別の写し**である。クライアントは読み込まない。パッチ側（`web/frontier/s1walk.mjs`、`hud/forecastmodel.mjs`、`hud/returnsum.mjs`、`seasonterms.mjs`）は、`L` の翻訳と import の形が違う（差分 20〜132 行）。
   - `src/` をクライアントへ写してはいけない。パッチと二重になる。
   - 統合後はパッチ側を正とする。`src/` は ⑦ の記録として残すか、削除するかを統合時に決める。二重に保守すると、規則の修正が片方にしか入らなくなる。
4. 検証ベクトル `vectors/s1-walk-v1.json` と、0001 が足す `permutation-gateway/test/fixtures/s1-walk-v1.json` は、中身が同じである（差 0 行）。
5. 適用後は §1.4 の tree SHA と照合する。

### 1.6 他担当と競合しうるファイル

④ と ⑤ の差分は取得できなかった（`bd415e7` と `ba3c180b` は origin の全ブランチを取得しても見つからない）。そのため、競合は**推定**である。

| ファイル | 触れるパッチ | 競合しうる担当（推定） |
|---|---|---|
| `permutation-server/web/frontier/app.mjs` | 0001・0002・0003 | 全担当。共有コントローラー。④ の取消状態、⑤ の費用表示が入る可能性が高い |
| `permutation-server/web/frontier/controller.mjs` | 0001 | ④（隊商の送信と取消）、⑤ |
| `permutation-server/web/lang/en-frontier-play.mjs` | 0001・0002・0003 | 全担当。翻訳辞書で、追記どうしの位置競合が起きやすい |
| `permutation-server/web/lang/en-frontier.mjs` | 0003 | ⑥、全担当 |
| `permutation-server/web/frontier/herald.mjs` | 0001 | ②③（読み取りの契約） |
| `permutation-server/web/frontier/screens/s1.mjs` | 0001 | ①（国の卓・国の方針） |
| `permutation-server/web/frontier/screens/onboarding.mjs`、`screens/join.mjs`、`intro/title.mjs`、`hud/glossary.mjs` | 0003 | ⑥（作成・公開）、① |
| `permutation-server/web/frontier/hud/feed.mjs` | 0002 | ④（到着・取消の知らせ） |
| `hud/marchcard.mjs`、`map/keepmount.mjs`、`fkeepreach.mjs` | 0001 | ②③ |
| 既存テスト `web-frontier-fix2`、`web-frontier-wave2-hud`、`web-frontier-words` | 0003 | 同じ文を固定している担当すべて |

新しく足すだけのファイル（`s1walk.mjs`、`hud/forecastmodel.mjs`、`hud/returnsum.mjs`、`hud/returnwords.mjs`、`seasonterms.mjs`、`web-frontier-ws07-*.test.mjs`）は、名前が重ならないかぎり競合しない。

---

## 2. REPRO と回帰テスト

### 2.1 常時テストの構成

- `permutation-gateway` の `npm test` が読むのは `test/*.test.mjs` と `screens/logic.screen.mjs` だけである。
- `workstreams/07-player-experience/tests/` は**常時テストに入っていない**（手で `node --test` する）。
- そのため、パッチ適用後も `npm test` はそのまま成功する（§6 で 2,542 通過・失敗 0）。修正後の正しい挙動を求める回帰テストは、すべてパッチ側の `permutation-gateway/test/web-frontier-ws07-*.test.mjs` に入っている。

### 2.2 REPRO と回帰テストの対応

REPRO は「欠陥がいまのページにある」ことを固定する検査である。修正後に失敗すれば、欠陥が消えたことを示す。常時テストに入れるものではない。

| REPRO（`workstreams/.../tests/`） | パッチ適用後 | 修正後の挙動を求める回帰テスト（常時テストに入る） |
|---|---|---|
| `caravan-preview` 「隊商を最速の道で送り、止める柵を外さない」 | 失敗に変わる | `web-frontier-ws07-s1walk` 「a caravan is sent round a palisade that stops it…」（0001） |
| `march-palisade` 「進軍の計画を呼ぶ側が柵を渡さない」 | 失敗に変わる | `web-frontier-ws07-s1walk` 「the port is the rules crate's…fastest_path round palisades」「off S1 nobody is stopped; on S1 the viewer's walker reads…」（0001） |
| `siege-precheck` 「自分の村が保護中でも包囲を出す」「包囲中・賭け金未決の村にもう一度出す」（2 件） | 失敗に変わる | `web-frontier-ws07-s1walk` 「the siege offer holds back the refusals the page can tell…」（0001） |
| `season-terms` 「ターンの長さを文に書き、参加の締め切りを言わない」 | 失敗に変わる | `web-frontier-ws07-terms` の 3 件と、更新した `fix2`・`wave2-hud`・`words`（0003） |
| `forecast-s1` 「砦の守備兵を数えない」「要塞を数えない」「物見櫓の減りを入れない」（3 件） | **通ったまま** | `web-frontier-ws07-s1walk` 「the S1 forecast counts the keep…and the towers' wear」「the envelope keeps the Province bytes…」（0001） |
| `return-summary` 「初回の知らせは空」「2 回目以降も S1 の損失が知らせにならない」「年代記は 500 件前から読み 400 件保つ」（3 件） | **通ったまま** | `web-frontier-ws07-s1walk` 「the away notice offers "seen"…」「the away items read the codes as the program numbers them…」（0002）。要約の規則は `workstreams/.../tests/return-summary.test.mjs` の model テストだけ（常時テスト外） |
| `shortfall` 「昇格カードは不足量だけで、いつ・どう埋まるかを言わない」 | **通ったまま** | なし。不足の比較は試作だけで、パッチにしていない |

「通ったまま」の 7 件は、パッチが古い関数を消さずに S1 の経路だけを差し替えたため、古い関数が今も同じ値を返している。
- `hud/forecast.mjs` の `forecast`/`forecastInputs` は M1 の経路で使われ続ける。S1 は `app.mjs` から `modelForecast` を呼ぶ。
- `feed.diffFeed` と年代記の窓は変えていない。留守の要約は別の経路として足した。

この 7 件は、統合後は「ページの欠陥」ではなく「古い関数の性質」を固定していることになる。そのまま常時テストに入れると、誤解を生む。

### 2.3 統合後の構成（提案）

1. 常時テストは `npm test` のままにする。⑦ の回帰テスト `web-frontier-ws07-*.test.mjs` はパッチと一緒に入る。
2. `workstreams/07-player-experience/tests/` は常時テストに入れない。
   - REPRO 12 件（前の版で「13 件」と書いたのは、注釈の行まで数えた誤り）は、「基準 `a997a756` で通る」ことを記録した証拠として残す（§6 のログ）。
   - パッチ適用後に流すと 5 件が意図どおり失敗する。v2 では `tests/repro/` に分けた（§0.4）。
3. 不足の比較を本体に入れる場合は、その時点で `shortfall` の model テストを `permutation-gateway/test/` に移し、回帰テストを書き足す。

追加の実験はしていない。上の対応は、§6 のログ（パッチ前後の `node --test` の結果）と、テスト名から作った。

---

## 3. 予測と確定の区別

### 3.1 記録 1 件で確かめたことの範囲

| 確かめたこと | 確かめていないこと |
|---|---|
| 記録された 1 回の到着（uxs1、シーズン 98、ターン 619。守備兵 100 の砦へ 500 の軍勢）で、プログラムと同じ組み立ての予測（487〜489）の中に、チェーンの記録（488.122）が入った | すべての S1 の条件で予測と結果が一致すること |
| 同じ入力を規則モジュール `frontier-v3.wasm` の `resolve_from_inputs` に渡すと、シード 4 通りでチェーンの digest と一致した | 要塞と物見櫓の減りは、記録の州を加工した入力で、モジュールとの一致だけを見た。チェーンの記録とは照合していない |

予測は「このモジュールに、いまページが持っている入力を渡したら何が返るか」である。結果の約束ではない。

### 3.2 予測が外れうる条件（画面と文書にそのまま書く）

| 条件 | 予測への影響 | いまの扱い |
|---|---|---|
| **観測できる入力** | ページが持つ州のデータ（守備兵、要塞、建物、見えている軍勢）だけを使う | 予測の材料は「第 N ターンに読んだ州」と書く |
| **見えない敵の行動** | 視界外の軍勢、同じターンに着く他国の進軍、封をしたまま見えない進軍は入らない | 「見えていない軍勢は含みません」と書く。数を推測しない |
| **柵・物見櫓が変わる** | 送ったあとに建つ、壊れる、奪われると、経路の可否と減りが変わる。柵が道をふさげば、封を開けるときに拒否される | 「いまの建物で計算」と書く |
| **国の方針が変わる** | 戦争・通行・同盟の切替で、誰が止められ誰が減るかが変わる（議題は決着まで時間がかかる） | 進行中の議題があれば、それを並べて示すのが条件（未実装） |
| **読み取りの古さ** | 州の読み取りから送信・到着までのあいだの変化は入らない | 読み取ったターンを必ず出す。古いまま「確定」と言わない |
| **乱数** | プログラムのシードで結果が揺れる | 範囲で出す。中央値を「結果」と言わない |

### 3.3 経路の評価で使う言葉

- 隊商プレビューの「略奪の危険」は、**いま見えている他国の軍勢**だけを数える。見えていないマスは「不明」と出す。
- 「安全」とは言わない。今回、試作の 2 か所の文言をこの方針に合わせて直した（機能の変更はない）。
  - 「略奪の危険：いま見えている範囲にはありません」に「（見えない軍勢・これからの動きは不明）」を足した。
  - 「守備隊のいるマス：他国の略奪は起きません」を「いまの記録では守備隊のいるマス：他国の略奪の対象外（着くまでに変わることがあります）」にした。
  - 地図の CSS クラス `turn safe` を `turn sheltered` に改めた。
- 予定（送る前の計算）と確定（チェーンの記録）は、別の欄に分けたまま保つ。

---

## 4. 復帰要約の継続性

「確認済み」の位置は、プレイヤーが「見た」を押したときだけ動く。読み込んだだけでは動かない。

| 場面 | 期待する扱い | 根拠（テスト・コード） | 状態 |
|---|---|---|---|
| 初回参加（この端末に記録なし） | 直近 144 ターンだけを見て、そう書く。それより前は推測しない | `return-summary.test.mjs`「a gap…a first look on a device covers a stated window only」 | model で確認済み |
| 再訪 | 確認済みの位置より後だけを出す。読み込んだだけの分は既読にしない | 同「the summary starts after what the player confirmed, not after what the page fetched」 | model で確認済み |
| 別のウォレット | 「別のウォレット」と書き、前のウォレットの位置を使わない | 同「another wallet, a new season and storage that refuses are each said, never mixed」 | model で確認済み |
| 別のシーズン | 「前のシーズンの出来事は含みません」と書く | 同上 | model で確認済み |
| 別の端末 | 位置は端末ごとの localStorage にある。別の端末では「初回」と同じ扱いになり、文がそう言う（「初めてか、別の端末か、ブラウザの記録が消えた場合」） | 同「a gap…」 | model で確認済み。端末をまたぐ同期はない |
| 保存ができない | 書き込みの失敗を報告し、保存できたことにしない | 同「…storage that refuses…」 | model で確認済み |
| 他人の出来事 | 他人の隊商の到着、他国の議題は出さない | 同「the summary lists the viewer's own losses first…」 | model で確認済み |
| 奪われた隊商のその後 | 奪った側のものとして扱い、送り主の到着として出さない | 同「a taken caravan is the raider's from then on…」 | 要約（初回の 1 回）では確認済み。**2 回目以降は未修正（下の C4）** |
| 履歴の欠け | 確認済みの位置と、最初に読めた記録のあいだを「欠け」と名指しし、中身を推測しない | 同「a gap…is named and not filled in」 | model で確認済み |
| 途中までしか読めない | `incomplete` と書く | 同上（`complete: false`） | model では確認済み。**クライアントは常に `complete: true` を渡す（下の C3）** |
| 重複・順序 | 同じ seq を 2 度出さない。seq の昇順に処理する | 要約は seq の昇順と重複なしを前提にしている。重複を除く処理はない | **未検証（下の C5）** |

### 4.1 パッチ 0002 の統合前条件（v1 の記録。v2 の 0003 で修正済み：§0.3）

| # | 所見 | 場所 | 統合前に要ること |
|---|---|---|---|
| C1 | **欠けがあっても「見た」で位置が先へ進む。** `away-seen` は要約の `gap` を見ずに、`confirm(…toSeq…)` を呼ぶ。読めなかった欠けの分まで確認済みになり、「未取得の出来事を既読にしない」という条件に反する | `app.mjs` の `'away-seen'`（0002）、`hud/returnsum.mjs` の `confirm` | 欠けがあるときは位置を欠けの手前（`gap.afterSeq`）で止めるか、「見た」を出さずに理由を書く。回帰テストを足す |
| C2 | **初回は 144 ターンの窓しか出さないのに、「見た」で先頭まで確認済みになる。** 別の端末から来た人の、窓より前の出来事が確認済みになる | 同上 | 窓より前を確認済みにすることを文で言うか、位置を窓の始めにする。①〜⑥ の担当と決める |
| C3 | クライアントは年代記（先頭の 500 件前から読み、400 件だけ保つ）を `read: { after: 最初の seq − 1, complete: true }` として渡す。窓より古い位置は「欠け」として出るが、先頭まで読めたかどうかは確かめていない | `app.mjs` の `awayItems` | 先頭まで読めたかを controller から受け取り、`complete` に入れる |
| C4 | **2 回目以降の知らせ（`s1Items`）は `itemOf(x, me)` を holders なしで呼ぶ。** 奪われた隊商が後で着くと、送り主の到着として出うる | `app.mjs` の `s1Items` | `summarize` と同じ持ち主の追跡を通す |
| C5 | 年代記に同じ seq が 2 度入る場合や、順序が入れ替わる場合（再接続など）の扱いを確かめていない | `controller.mjs` の年代記の組み立て | seq での重複除去と並べ替えを入れるか、controller の保証をテストで固定する |
| C6 | シーズンを切り替えたときに、`FS.chronicle` に前のシーズンの記録が残るかを確かめていない | `controller.mjs` | 切り替えで年代記を空にすることを確かめる |

C1 と C4 は、要件（未取得を既読にしない、他人の出来事を混ぜない）に直接反する。**0002 は、この 2 件を直すまで統合しない**ことを勧める。0002 を外して `a997a756` に 0001 → 0003 を `git am` すると、**0003 は当たらない**（確認済み。0003 は 0002 が変えた `app.mjs` と `en-frontier-play.mjs` の上に作ってある）。0002 を外して統合するなら、0003 を作り直す必要がある。

---

## 5. 他担当の状態表示との接続条件

**④・⑤ の成果物は取得できなかった**（§1.6）。下の表は、依頼文にある報告の要約だけから作った**未検証の対応表**である。接続した画面は作っていない。

### 5.1 ④（報告 `bd415e7`）：取消と到着量

| ④ の状態 | ⑦ の表示要件 | ⑦ で関わる画面 |
|---|---|---|
| 新規要求の停止 | 「これから先の送信を止めました」とだけ言う。送信済みのものが止まったとは言わない | 隊商プレビュー、不足の比較の「運ぶ」 |
| 署名済み要求の確認待ち | 予定でも確定でもない第 3 の欄として「署名済み・チェーンの確認待ち」を出す。到着時刻を確定として出さない | 隊商プレビュー（予定と確定の区別） |
| 成立済みの効果を含む取消完了 | 「取消は完了。ただし成立済みの分（例：到着済みの積荷）は戻りません」と、成立済みの効果を並べる | 留守の要約、知らせ |
| 到着量未検証 | 「部分到着」とは別の状態として出す。量を推測せず「到着量はまだ確かめられていません」と言う | 留守の要約（`CARAVAN_SETTLED`）、不足の比較の「運ぶ」の到着量 |
| 部分到着 | 記録にある量だけを出す。差を損失と断定しない（略奪か、輸送の減りか、上限による切り捨てかを区別する） | 留守の要約、不足の比較 |

### 5.2 ⑤（報告 `ba3c180b`）：費用と手動切替

| ⑤ の状態 | ⑦ の表示要件 | ⑦ で関わる画面 |
|---|---|---|
| 予約 | 「使える量」から引いて見せる。ただし「支払済み」とは言わない | 不足の比較（「全部そろう時点」の計算で予約分を差し引く） |
| 確定 | 確定した額だけを「使った」と言う | 留守の要約、昇格・建設カード |
| 未確定 | 予約とも確定とも違う欄に出す。数字は範囲か「未確定」 | 不足の比較、無効なボタンの理由 |
| 解放 | 予約が戻ったことを言い、不足の比較を計算し直す | 不足の比較 |
| 手動切替でも、既存の署名済み操作は止まらない | 切替の画面で「すでに署名した操作は止まりません」と明記する。止まったように見える表示（灰色化だけ）を避ける | 無効なボタンの理由、留守の要約 |

### 5.3 接続する前に要ること

1. ④ と ⑤ の状態の名前と遷移を、それぞれの成果物（コード・ABI・テスト）で確かめる。報告の文だけで画面を作らない。
2. ⑦ の model（`shortfall.mjs` の手持ち・予約・輸送中、`caravan-preview.mjs` の予定と確定、`return-summary.mjs` の項目）に、上の状態を入力として足す。そのときに回帰テストを書く。
3. 状態の表示は色だけに頼らない（記号と文で言う）。⑦ の試作の決まり（`VISUAL.ja.md`）に従う。

---

## 6. 表現と検証範囲

### 6.1 変えずに保つ表現

- **「記録の地図」は視覚の案である。採用済みの美術方針ではない。** 既存の美術方針を置き換える提案ではなく、判断する場面のレンズとして足す提案で、普段の見た目を替えるかは試遊（`PLAYTEST.ja.md` の V1〜V3）で決める。
- **「ガイドが本国の砦へ向かわせる」は再現しなかった。** ガイドは本国の砦を候補から外している（`REPORT.ja.md` 主張 5）。再現したのは、S1 で地図のガイドが M1 の手順に従っていた別の問題で、`a997a756` で直した。
- 画面テストの合格は、面白さや初心者の理解の証明ではない。

### 6.2 証拠の層（混同しない）

| 層 | 何で確かめたか | 言えること | 言えないこと |
|---|---|---|---|
| M1 の画面テスト（78 件） | 既存の `screens/` を、M1 の固定データで Playwright 実行 | 既存画面が壊れていない | S1 の挙動、理解、面白さ |
| S1 の規則モジュール | `frontier-v3.wasm`（program_version 4）をテストから呼ぶ | 同じ入力にモジュールが返す値 | チェーン上の状態、ほかのプレイヤーの行動 |
| ルールの crate の移植 | `rust-vectors/` が書いた 240 件のベクトルとの一致 | 移植した関数（柵・物見櫓・経路）がその入力で crate と同じ値を返す | ベクトルにない入力 |
| 過去のチェーン記録 | `uxs1-keep-two-turns.json`（ローカルチェーンに記録された 1 件） | その 1 件で予測の範囲に結果が入った | すべての S1 条件での一致 |
| S1 の実チェーン | **未実行**（SBF 環境の導入が権限で拒否された） | — | すべて |
| 人間の理解・面白さ | **未実行**（`PLAYTEST.ja.md` に問いと手順） | — | すべて |
| 試作の画面の点検（52 件） | 試作用の架空データで、PC とスマホ | 試作の操作（戻る・取消・二重押し・失敗・再読込・キーボード）が動く | 本物の画面での挙動 |

---

## 7. 保存パッケージ

パッケージの作り方と中身は、パッケージ内の `RESTORE.ja.md` と `MANIFEST.txt` に書いた。このリポジトリには、パッケージそのものは入れていない（自分自身の bundle を含められないため）。
