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

同じ固定の時計、同じ乱数、同じ場面で撮る。`s09-s1sample` は S1 の情報の **見本** を差し込んだ場面（フィクスチャは S1 の情報を配らない）。

## ファイル

| 種類 | ファイル |
|---|---|
| 文書 | `docs/design/uplift/00-SCOPE`（基準と範囲）、`01-ART-DIRECTION`（3 案と推奨）、`02-CORE-FLOW`（中心の流れ）、`03-COMPONENTS`（トークンと部品）、`04-VERIFY`（検証）、この文書 |
| 比較ページ | `docs/design/uplift/preview/`（scene, common, dirA/B/C, panels, preview, shoot, measure） |
| クライアント（新規） | `frontier/map/structures.mjs`、`frontier/hud/forecastbook.mjs`、`frontier/uplift.css` |
| クライアント（変更） | `map/village.mjs`（道具を公開）、`map/s1marks.mjs`、`map/sprites.mjs`（格子の濃さ）、`map/actions.mjs`（範囲の格子）、`hud/forecast.mjs`（構えの比較）、`hud/marchcard.mjs`（見通し、比較、取り消せない一行）、`screens/report.mjs`（予測と確定）、`screens/holding.mjs`（満杯まで）、`app.mjs`（比較の計算、予測の保存）、`frontier.css`（状態のトークン）、`index/spectate/practice.html`（uplift.css）、`lang/en-frontier-play.mjs` |
| 試験・道具 | `permutation-gateway/test/web-frontier-uplift.test.mjs`、`screens/uplift-shots.mjs`、`screens/uplift-perf.mjs`、`test/web-frontier-s1.test.mjs`（古い見た目を固定していた 1 行を書き直し） |

## 残り（優先順）

1. **S1 の世界を手元で起動できるようにする**（スタックの道具。ゲーム処理側の作業）。それまで、S1 の施設の絵は見本の情報でしか確かめられない。
2. 隊商を送る・護衛を先に出す・奪うか焼くかの **操作の画面**（規則は S1 にある。プレビューは `preview/?frame=caravan|raid`）。
3. 地図の見た目の次の段：村の段階と建物の種類を遠目にも読めるようにする、国の印を名札以外にも（地図の旗）。
4. HUD の重なり：軍を選んだときの操作の帯とドックが二段になる（今の作りのまま）。
5. AI の委任・停止の画面は `agent-wallet/*` が main に入ってから（状態を混ぜない案は `preview/?frame=ai`）。
