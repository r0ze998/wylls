# Wylls 世界の原図（world map）

Wylls の世界全体を一枚にした、文字なしの高精細マップです。全景・各国・町・前線・暮らしの投稿用画像も、ここから切り出します。

描いているのは**ゲーム自身の描画処理**です。地形、川、村と施設、砦と国旗、軍勢、鐘の塔、雲の海は、ゲームのクライアント（`permutation-server/web/frontier/map/*`、`people/*`、`art/*`）の描画関数と素材をそのまま呼んでいます。新しい画像素材や画像生成は使っていないので、絵柄はゲーム画面と同じです。同じコマンドを実行すれば、同じ絵がもう一度できます。

## 何を描いているか（根拠と補完の区別）

| 内容 | 根拠 | 区分 |
|---|---|---|
| 世界の形：大協約を中心に、六角形の州が輪をなす。1 州は 61 マス | `permutation-rules/src/frontier/geometry.rs`、`fgeo.mjs` | ルール（確定） |
| 開いている輪：0〜4（61 州）。その外は雲の海 | 記録したシーズン 92 | 記録 |
| 地形・資源・村の候補地：州ごとに生成。同じ輪の 6 つの国の土地は、形が同じ | 記録したシーズン 92 の Province アカウント（`terrain.rs` の生成） | 記録 |
| 6 つの国：アステル、ボレアリス、シンダー、ダンマール、エンバー、フィヨルダル。各国の本国は 6 分割の 1 つ | `fi18n.mjs`、`wedgeOf` | 確定 |
| 砦と、その州を持つ国（国境の線と色）：各州の砦の保持国 | シーズン 92 の砦の記録。輪 1 と大協約には砦がない | 記録 |
| 蛮族の野営地 54、自由都市 24 | シーズン 92 | 記録 |
| 大協約と鐘の塔（第 1 輪の候補地は予約済み） | シーズン 92、`belltower.mjs` | 記録 |
| **村 163（ほかに記録の 1）と、その大きさ・城壁・守備兵** | `data/demo-1.json`（`scripts/demo-state.mjs`、seed 7） | **制作上の補完（デモ）** |
| **立っている軍勢 48、前線 2 か所の攻防、野営地への攻撃 2 か所** | 同上 | **制作上の補完（デモ）** |
| **人々の動き**（用事に出る町の人、畑・森・丘との往復、足場で働く人、煙、砦前の訓練、乱戦の土煙、雲の際の斥候、大協約を行き交う旅人） | `render/life.mjs`（ゲームの人物描画 `figure`、`actor`、`scaffold` を使用） | **演出（補完）** |
| **道（routes レイヤー）**：隣り合う州の砦どうしを、境の中ほどを通って結ぶ | 読みやすくするための線。ルール上の道ではない（ルールに道を作る命令はない） | **補完（初期は非表示）** |

**なぜ村がデモなのか。** 記録したローカルの S1 シーズン（92）では、ボットの参加がすべて拒否されました（`RelayRejected`）。そのため、村は人間の 1 つしかありません。そこで、記録の**空いている本物の候補地だけに**、ルールの形に合わせてデモの村を置きました。置いたのは、自国の 6 分割の輪 2〜4 だけです。砦から 2 マス以内と野営地の上には置いていません。投稿などで使うときは「デモ状態」と明記してください。実際の対局記録ではありません。

**載せていないもの。** 非公開の情報は載せていません。封をした進軍の行き先、所有者のアドレス、鍵もありません。描いた軍勢は、州の中に立っている軍勢（公開の記録の形）だけです。人と AI は見た目で区別しません。AI を見分ける印は描いていません。

## 成果物（`dist/`、再生成できる）

| ファイル | 中身 |
|---|---|
| `world/world-notext.jpg` | 原図（7,397×6,226）、文字なし |
| `world/world-borders.jpg` | 国の色と国境の線を重ねたもの |
| `world/world-ja.jpg`、`world-en.jpg` | 国境、国名、大協約、町の名前（町・都市・城塞）を重ねたもの |
| `world/world-layers.ora` | 全レイヤー（land、life、realms、grid、routes、labels-ja/en、names-ja/en）を重ねた編集用ファイル（OpenRaster。GIMP、Krita で開ける）。大きいのでリポジトリには含めない |
| `layers/*.png` | 透明なレイヤー：realms、grid、routes、labels-ja/en、names-ja/en。原図と同じ大きさと位置 |
| `posts/<名前>-notext.jpg`、`-ja.jpg`、`-en.jpg` | 投稿用 10 種（下の表） |
| `contact-sheet.jpg` | 投稿用の一覧 |

| 投稿 | 比率と大きさ | 内容 |
|---|---|---|
| 01-world-16x9 | 16:9、3840×2160 | 全景 |
| 02-world-4x5 | 4:5、2160×2700 | 全景 |
| 03-world-1x1 | 1:1、2160×2160 | 全景 |
| 04-concord-1x1 | 1:1 | 大協約と鐘の塔 |
| 05-front-aster-16x9 | 16:9 | 前線：アステルの砦を攻めるボレアリス |
| 06-front-dunmar-4x5 | 4:5 | 前線：ダンマールの砦を攻めるエンバー |
| 07-town-life-4x5 | 4:5 | 町の暮らし（シンダーとボレアリスの境） |
| 08-nation-aster-16x9 | 16:9 | 国：アステル |
| 09-camp-raid-1x1 | 1:1 | 蛮族の野営地を攻める |
| 10-edge-of-the-clouds-16x9 | 16:9 | 開いた土地の端と、雲の海 |

近景の投稿は、原図の画像を拡大して切り出したものではありません。**同じ世界・同じデータ**を、その範囲だけ高い密度（1 ワールド px あたり最大 2 px。ゲームの素材の最大解像度）で描き直しています。そのため、道・川・建物の大きさ・光の向きは原図とそのままつながります。

## 再出力の手順

前提：Node 22、Python 3 と Pillow、事前に入っている Playwright と Chromium。チェーンもビルドも不要です。

```sh
node media/world-map/scripts/fetch-fonts.mjs        # 一度だけ：ラベルの書体（Shippori Mincho B1、Noto Sans JP、OFL）
node media/world-map/scripts/render.mjs --data season-92.json --demo demo-1.json --scale 1.25 --lang ja --out media/world-map/out/master-ja
node media/world-map/scripts/render.mjs --data season-92.json --demo demo-1.json --scale 1.25 --lang en --out media/world-map/out/master-en --layers labels,names
node media/world-map/scripts/posts.mjs --lang ja --out media/world-map/out/posts-ja
node media/world-map/scripts/posts.mjs --lang en --out media/world-map/out/posts-en
python3 media/world-map/scripts/package.py         # dist/ を作る
```

1 回の描画は 15〜25 秒です。

- **別のシーズンから作る：** `node media/world-map/scripts/extract-season.mjs <herald の files ディレクトリ> season-N` を実行してから、`--data season-N.json` で描きます。村が入った本物の記録があれば、`--demo` を外すとデモを使わずに記録だけで描けます。
- **デモを変える：** `node media/world-map/scripts/demo-state.mjs season-92 demo-2 <seed>` を実行します。
- **投稿を足す・動かす：** `posts.json` を編集します。`at` にはアンカー（world、concord、front:i、camp:i、town:国、nation:国）か、`{x, y}`（ワールド px）を指定します。`span` は横幅（ワールド px）、`words` は文字版に重ねるレイヤーです。
- **ブラウザで見る：** `node media/world-map/scripts/serve.mjs` を起動し、`http://127.0.0.1:41781/media/world-map/render/index.html?data=season-92.json&demo=demo-1.json&scale=0.4&show=base,realms,labels` を開きます。

## 素材の出典

- 地形、川、海岸、森、山、村、砦、国旗、兵、鐘の塔、雲：Wylls のクライアント（`permutation-server/web/frontier/art/`、コードによる描画）。出典とライセンスは `permutation-server/web/frontier/art/README.md` を参照してください。兵の絵は持ち主の引き継ぎパック（2026-10-10）です。
- 書体：Shippori Mincho B1、Noto Sans JP（SIL Open Font License、Google Fonts から取得。リポジトリには含めない）。
- 地理：ローカルのテストチェーンのシーズン 92（2026-10-24、S1 のルール、ボット 6 体。参加はすべて拒否された）。テスト用のトークンだけで、価値はありません。

## 今後差し替えるもの

1. **デモの村と軍勢を本物の記録に替える。** ボットが村を作れる S1 シーズンの記録ができたら、`extract-season.mjs` で取り込み、`--demo` を外します。
2. **S1 の建物（倉、見張り塔、柵、要塞、荷車）。** `main` には描画処理がありません（段階 1f、別ブランチ）。記録に構造物や荷車が入れば、描画処理が統合されたあとに描けます。
3. **道。** 道を作る命令がルールに入れば、routes レイヤーを、記録の `roadMask` に基づく本物の道に替えます。
4. **地名。** 村の名前はゲームが生成するもの（`holdingName`）です。山脈・川・地方の固有名はルールにも設定にもないので、付けていません。付けるなら世界設定の判断になります。
5. **開く輪の数。** 世界は輪 5 以降へ広がります。開いた輪が増えた記録で描き直せば、そのまま広がった世界になります。
