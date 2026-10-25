# 引き継ぎ：起動、ファイル、残り

2026-10-24。ブランチ `design/visual-uplift`（起点 `e4019d7a` = main `c59372cc` ＋ 段階 1f の 2 commit）。push・main へのマージ・デプロイはしていない。

## 起動

### 1. 見本の世界（チェーン不要、いちばん早い）

```sh
cd permutation-gateway/screens && npm ci     # playwright-core と axe（Chromium は `npm run browser` で入る。既にあれば不要）
node -e "import('./server.mjs').then(async ({startServer}) => { const s = await startServer({ port: 41380 }); s.stage('holding'); s.live(true, { turn: 30 }); console.log(s.url); })"
# http://127.0.0.1:41380/frontier/?intro=0
```

ブラウザには、見本の世界の利用者の鍵を入れる必要がある（`world.mjs storageFor`）。`uplift-shots.mjs` が入れ方の見本。

### 2. ローカルの征服の世界（本物のローカルチェーン、プログラム v3）

S1 のビルドでは世界を作れない（00-SCOPE 2 章）。S1 の前の版のビルド（`frontier/season-complete` の worktree）で世界を作り、このブランチのクライアントを配る：

```sh
cd .claude/worktrees/season-complete
./frontier-node/target/release/frontier-stack up --config <このブランチ>/.local/uplift-cq.toml \
  --conquest --mode accel --beacon test-key --preseason-scale 2000 --scale 10 --game-hours 72 \
  --bots 10 --personas off --run-id uplift-cq1 --base-port 41300 --season 301 --keep-running
# http://127.0.0.1:41340/frontier/frontier/   止める: frontier-stack down --run-id uplift-cq1
```

`.local/uplift-cq.toml` は `[paths] web` をこのブランチの `permutation-server/web` に、`runs` をこのブランチの `.local/runs` にする（記録はこのブランチの中にだけ書かれる）。

### 2b. ローカルの S1 の世界（プログラム v4、このブランチのビルド）

このブランチで直した 2 点で起動できるようになった：スタックの `--s1`（季節を S1 の設定で作る）と、キーパーが S1 の季節で S1 の予算表を使うこと（以前は MC の表のままで、最初の種の取引が `MaxLoadedAccountsDataSizeExceeded` で失敗し、土地が開かなかった）。

```sh
cargo build --locked --release -p stack -p keeper      # frontier-node で
./frontier-node/target/release/frontier-stack up --s1 --mode accel --beacon test-key --preseason-scale 2000 \
  --scale 10 --game-hours 72 --bots 10 --personas off --run-id uplift-s1d --base-port 41500 --season 303 --keep-running
# http://127.0.0.1:41540/frontier/frontier/   止める: frontier-stack down --run-id uplift-s1d
```

ボットを村として参加させるには `--bots-args --conquest` も付ける（付けないとボットは動くが参加しない。今回の `uplift-s1d` は付けておらず、村は自分の 1 つだけだった）。S1 の世界の規則モジュールは、上の 2b の残り（`frontier-v3.wasm`）を参照。

S1 の施設（倉・物見櫓など）は、ボットも誰も建てないので、地図に出すには自分で建てる。クライアントは命令の形（`fplay.mjs` の BuildVault / BuildStructure）を作れるが、**それを送るボタンはまだない**（遊ぶ人向けの建て方の画面は、この変更に含めていない）。

### 3. 美術方針の比較ページ

```sh
python3 -m http.server 41390 --bind 127.0.0.1    # リポジトリの根で
# http://127.0.0.1:41390/docs/design/uplift/preview/index.html
node docs/design/uplift/preview/shoot.mjs --out .local/shots/directions     # 全場面の写真
node docs/design/uplift/preview/measure.mjs                                # 1 枚を描く時間
```

### 4. 変更前後の写真と、フレーム時間

```sh
cd permutation-gateway/screens
node uplift-shots.mjs --tree <変更前のチェックアウト> --out ../../.local/shots/before
node uplift-shots.mjs --tree ../.. --out ../../.local/shots/after
node uplift-perf.mjs --tree <変更前のチェックアウト>
node uplift-perf.mjs --tree ../..
```

### 4b. 状態ごとの確認と、生きた世界での前後比較

```sh
cd permutation-gateway/screens
node uplift-states.mjs                    # 命令の札と報告を 10 の状態で（キーボード、動きを減らす、規則モジュールなし、中継の故障、英語 360、横向き、色なし、報告 2 つ、行き先の変更）
node uplift-shots.mjs --tree ../.. --out ../../.local/shots/land --vp land    # スマホを横に（844 × 390）
# 動いている世界（herald のポート H）に、変更前と変更後のクライアントを並べる
node uplift-proxy.mjs <変更前のチェックアウト>/permutation-server/web 41396 H &
node uplift-proxy.mjs ../../permutation-server/web 41395 H &
node uplift-perf-live.mjs 3 "before=http://127.0.0.1:41396/frontier/frontier/spectate.html?intro=0&probe=2&at=1,0,30,0.9" \
                            "after=http://127.0.0.1:41395/frontier/frontier/spectate.html?intro=0&probe=2&at=1,0,30,0.9"
```

同じ固定の時計、同じ乱数、同じ場面で撮る。`s09-s1sample` は S1 の情報の **見本** を差し込んだ場面（フィクスチャは S1 の情報を配らない）。

## ファイル

| 種類 | ファイル |
|---|---|
| 文書 | `docs/design/uplift/00-SCOPE`（基準と範囲）、`01-ART-DIRECTION`（3 案と推奨）、`02-CORE-FLOW`（中心の流れ）、`03-COMPONENTS`（トークンと部品）、`04-VERIFY`（検証）、この文書 |
| 比較ページ | `docs/design/uplift/preview/`（scene, common, dirA/B/C, panels, preview, shoot, measure） |
| クライアント（新規） | `frontier/map/structures.mjs`、`frontier/hud/forecastbook.mjs`、`frontier/uplift.css` |
| クライアント（変更） | `map/village.mjs`（道具を公開、工房の鍛冶場）、`map/board.mjs`（工房の数）、`map/s1marks.mjs`、`map/sprites.mjs`（格子の濃さ）、`map/actions.mjs`（範囲の格子）、`hud/forecast.mjs`（構えの比較）、`hud/marchcard.mjs`（見通し、比較、取り消せない一行）、`screens/report.mjs`（予測と確定）、`screens/holding.mjs`（満杯まで）、`app.mjs`（比較の計算、予測の保存）、`frontier.css`（状態のトークン）、`index/spectate/practice.html`（uplift.css）、`lang/en-frontier-play.mjs` |
| 試験・道具 | `permutation-gateway/test/web-frontier-uplift.test.mjs`、`screens/uplift-shots.mjs`、`screens/uplift-perf.mjs`、`test/web-frontier-s1.test.mjs` と `test/web-frontier-board.test.mjs`（古い見た目を固定していた 1 行ずつを書き直し） |

## 残り（優先順）

1. **ゲーム処理側の 3 つの直しを、担当が確かめる**（デザインの作業の中で見つけた不具合。本番の S1 の季節にも効く。別の変更として取り出してもよい）：キーパーの S1 予算表（`keeper/src/lib.rs follow_abi`）、herald の S1 情報の配信（`herald/src/cqroutes.rs`）、スタックの `--s1`。
1a. **持ち主に確認**：herald の `h/structures.json` は、物見櫓の知らせ（持ち主だけに向けたもの＝notify 0 も）と要塞に送った兵の数を、ログインなしで誰にでも配る。`structure.rs` は「公開の記録から作るので、絞るのは読む側」としている。この作りでよいか。
1b. **S1 の季節でボットが動かない**（`--conquest` でも 1 歩も進まない）。S1 の作業の残り（S1-1B-NOTES「Bots (1f)」）。人の多い S1 の世界で地図を確かめるには、これが要る。
1c. **大きな世界でドラッグ中に新しい州の地面を作る 1 枚**は、まだ変更前より重い（p95 で約 +25%、04-VERIFY 3 回目）。次の手：動いている間は国土の絵（なじませ・岸）を後回しにし、止まってから作る。ただし岸の形が後から変わって見えるので、見た目との釣り合いを確かめること。
2. S1 の施設を建てる・隊商を送る・護衛を先に出す・奪うか焼くかの **操作の画面**（規則は S1 にあり、命令の形のうち建てる 2 つはクライアントにある。プレビューは `preview/?frame=caravan|raid`）。**建てるボタンだけを先に出さなかった理由**：倉は隊商とつながって初めて役に立ち、物見櫓の役目（見えた知らせ）もまだ画面に届かない。塔の数値は契約で仮の値（S1-1D §9 は持ち主の選択待ち）。いま出すと、払っても得が見えない操作になる。隊商の送り・知らせの表示と一緒に作るのがよい。
2b. **S1 の規則モジュール `frontier-v3.wasm` を、持ち主の再現ビルドで作って入れる**（`scripts/build-wasm.sh --s1`）。クライアントはもう S1 の季節でこれを読みにいく。無いあいだ、S1 の季節では地形と予測が出ない（起点でも同じ。起点はルールの不一致で出なかった）。
3. 地図の見た目の次の段：建物の種類を遠目にも読めるようにする。中くらいの縮尺（`uplift-shots.mjs s12-mid / s13-mid2`）では、村の格の札と国旗はすでに出ている。
4. HUD：軍を選んだときの操作の帯とドックが二段になる（見て確かめ、短い帯として読めるので変えていない）。実機のスマホ（縦・横）での確認は、まだ描画のエミュレーションだけ。
5. AI の委任・停止の画面は `agent-wallet/*` が main に入ってから（状態を混ぜない案は `preview/?frame=ai`）。
