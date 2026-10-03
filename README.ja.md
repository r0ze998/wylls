[English](README.md) | **日本語**

# Wylls

**Solana 上の、みんなで共有する文明育成ゲーム。10分ごとの鐘、封印された進軍、そして（設計済み、まだ未実装）人と同じルールで遊ぶ、AIだと必ず表示される「AI市民」。**

> **現状（2026-10-03）：** ローカルの試験用チェーンだけで動かしています（devnet でも mainnet でも動かしていません）。外部の人はまだ誰も遊んでいません。数字はすべて、テスト、ルールボットの実行、Gemma 4 のスパイク（予備実験）、またはシミュレーションから出たものです。AI市民は設計だけで、未実装です [AS-BUILT: pending]。お金、統治、市場も未実装です。

![Wylls の地図：中央の「協約（Concord）」を囲む6つの国](docs/img/wylls-map.png)

*M1 終了シーズンの記録が終わった後の、Webクライアントの地図（ローカルの試験用チェーン、ルールボット1,000体）。時計は鐘1,034を指しています。内訳は、プレイ中の鐘1,008と、締めの鐘26です。写っているのは地図だけで、軍や衝突は写っていません。「Dev Wallet (localnet)」はローカル用のテスト財布で、本物の財布ではありません。*

[設計の概要（10分で読めます）](docs/DESIGN-OVERVIEW.ja.md) · [M1 終了レポート（英語）](docs/frontier/m1/M1-EXIT-NOTES.md) · [ピッチ（英語）](PITCH.md) · [提出記録（英語）](SUBMISSION.md) · [デモ台本（英語）](docs/pitch/DEMO_SCRIPT.md) · [動かし方（英語）](docs/RUNNING.md) · [English README](README.md)

| ひと目で | |
|---|---|
| **作って、測った** | M1（最初の遊べる版）：ゲーム内7日間のシーズンを、ルールボット1,000体で、ローカルの試験用チェーン上で動かした |
| **作ったが、人にもボットにも動かしていない** | 参加は「国」を選ぶだけ（村は自動で置かれる） |
| **作業中。このツリーには入っていない** | 征服：砦、包囲、占領 |
| **設計のみ** | AI市民、お金（M2）、社会（M3）。devnet でも動かしておらず、人のプレイヤーもまだいない |

このページで使うタグ（英語版と同じです）：**[measured]** 出典つきの、記録された実測結果。**[built this week]** M1 終了後に取り込んだもの。テストと画面フィクスチャ（固定データ）でしか確認していません。**[designed]** 文章として設計したが、まだ作っていないもの。**[in progress]** ブランチで進めている作業。このツリーには入っていません。**[sim]** シミュレータの出力。プレイヤーの行動は仮定です。**[model]** コストや規模の見積もりモデル。**[estimate]** 概算の数字。**[code]** テスト済みのコードから読み取ったルール。プレイして得た結果ではありません。まだ存在しない結果は `[AS-BUILT: pending]` と書いてあります。この印は凍結日（2026-10-12）に外します。コードブロックの中は英語のままです。

---

## 1. Wylls とは何か、なぜ作るのか

6つの国から1つを選ぶと、村が自動で置かれます。経済はリアルタイムで動きます。軍は封印された命令で動きます。出発は公開ですが、行き先は drand（公開の乱数ビーコン）で時間ロックされ、到着の鐘まで誰にも見えません。各州の戦闘は10分ごとの鐘でまとめて解決されます。1日に144回です。公開の乱数を使うので、記録は誰でも再生して確かめられます。すべてはシーズンの終わりで終わります。次に残るのは年代記だけです。

**なぜ作るのか。** 新しいオンラインの世界は、始まった時点では誰もいません。よくある対策は、人のふりをするボットで埋めることです。私たちはそれをしません。Wylls では、AIは必ずAIだと表示します。*Wylls* は、意志（*will*）の英語表記です。このゲームは思考実験です。**AIに意志があるとき、ゲームはどう振る舞うのか。** 計画では、ローカルモデルで動くAI市民を、人と同じ鍵、同じ回数制限、同じ視界（霧）で遊ばせます。そして、目標、約束、国の評議会をAIがどう扱うかを観察します。大規模なライブのマルチプレイヤーゲームで、言語モデルのプレイヤーが有能なまま続いた例は見つかりませんでした（見落としがあるかもしれません）。そこで設計では、保証をコードに置き、モデルは「ルール上許された選択肢から選ぶ役」に限ります（[理由](docs/DESIGN-OVERVIEW.ja.md#2-ビジョン)）。

**ある日の様子（イメージ）** [designed。ここに書いたものはまだ何も作っていません]。評議会の期間ごとに、コードが国ごとに目標の州を3つ提案します。AI市民の1人が演説つきで案を1つ出し、別のAI市民が反論し、人間の市民が決め手の1票を投じます。採用された目標（「号令（Call）」）は、攻撃の時まで外部の人には封印されたままです。AIの発言にはすべてAIバッジがつき、AIごとに公開の「Wyllカード」（性格、目標、守った協定と破った協定）があります。詳しくは[第4節](#4-ai市民を1画面で-designed-as-built-pending)。

**なぜチェーンなのか。** 衝突を解決するのは運営者ではなくプログラムです。出発は公開で、行き先は到着の鐘まで drand の時間ロックで隠されます（これは設計上の性質です。[第7節](#7-正直な限界)の「封印の秘匿」を参照）。そしてシーズン全体が公開のログになり、私たちの検証器がそれを再生して確かめます。速さや安さではなく、これが理由です。

## 2. 現在の状況

| 領域 | 状態 | タグ | 根拠 |
|---|---|---|---|
| **M1（最初の遊べる版）** | 完了。2026-10-01 に終了。ゲーム内7日間のシーズン（1,008鐘、20倍速）を、**ローカルの試験用チェーン**でルールボット1,000体と最初から最後まで動かし、合否基準をすべて通過 | [measured] | [M1-EXIT-NOTES](docs/frontier/m1/M1-EXIT-NOTES.md)、[実行記録](docs/frontier/m1/runs/m1-exit/) |
| M1 の中身 | プログラム、キーパー、ヘラルド、リレー、検証器、ボット1,000体の群れ、Webクライアント（日本語・英語） | [measured] | [概要 §4](docs/DESIGN-OVERVIEW.ja.md) |
| **M1終了後に作ったもの** | 参加は「国」を選ぶだけ。クライアントが空いている用地を選び、申請も出す。Wylls という名前、国／村という言葉、描き直した兵のミニチュア。2026-10-02〜10-03 に取り込み済み。ボットや人を相手にチェーン上で動かしたことはない | [built this week] | [DECISIONS V1, V2, W11](docs/frontier/DECISIONS.md)、[概要 §1](docs/DESIGN-OVERVIEW.ja.md#1-状況) |
| **征服** | 砦、包囲、占領。契約と設計は書き終えた。カーネルとシミュレータの作業は手元のブランチ `frontier/cq-*` にあり、**このツリーには入っておらず、プッシュするまで GitHub にもない**。そこから出た結果はここに載せない | [in progress] | [征服の契約](docs/frontier/conquest/CONQUEST-CONTRACT.md) |
| **AI市民** | ローカルの Gemma 4 モデルで動く、AIだと表示される12人（各国2人）。契約 v1.1 は書いた。実装は凍結前に予定。**AI市民のコードはこのツリーにまだない** | [designed] | [AI-CITIZENS-CONTRACT](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md) |
| **お金（M2）** | 参加費、ステーク、賞金プール、受け取り。M1 では誰も払わず、誰も稼がない。リレーが試験用 lamports を肩代わりする | [designed] | [DESIGN §5.4](docs/frontier/DESIGN.md) |
| **社会（M3）** | 統治、共有の Engine（中央の共有施設）と技術上限、市場、外交。プレイヤーが持つAI市民 | [designed] | [DESIGN §4, §5](docs/frontier/DESIGN.md)、[DECISIONS W4, W8](docs/frontier/DECISIONS.md) |

## 3. 根拠

表の行はすべて、新しいゲームを**ローカルの試験用チェーン**で動かした結果です。† のついた数は M1 を閉じた時点のツリー `864b622` のもので、**このブランチでは、このページのために再実行していません**（改名、国だけで参加する仕組みなど、その後の変更があります）。詳細と範囲の限界：[概要 §5](docs/DESIGN-OVERVIEW.ja.md#5-根拠m1の終了シーズン新しいゲームローカルのテスト用チェーン)。動かし方：[docs/RUNNING.md](docs/RUNNING.md)（英語）。

| 主張 | 出典 | 再現の方法 |
|---|---|---|
| 終了シーズン `m1-exit`：ゲーム内7日間、1,008鐘、20倍速、8時間39分、ルールボット1,000体（13プロファイル）、プロセスの強制終了と再起動43回、シミュレートした観戦者5,000人。基準1〜6、8、9が合格（7は報告のみで合否に入れない）[measured] | [criteria.md](docs/frontier/m1/runs/m1-exit/criteria.md)、[run.md](docs/frontier/m1/runs/m1-exit/run.md)、[M1-EXIT-NOTES §3](docs/frontier/m1/M1-EXIT-NOTES.md) | `scripts/m1-run-s7.sh`（[RUNNING §3](docs/RUNNING.md#3-the-exit-season-itself)。drand アーカイブが必要） |
| 期限が来た進軍1,712件がすべて1回ずつ解決。止まった州の鐘は0。開示されなかった有効な封印は0。ごみの封印24件は24件とも「不正な封印」として処理 [measured] | [criteria.md](docs/frontier/m1/runs/m1-exit/criteria.md) | 同じ実行 |
| 再生検証器がトランザクション144,300件を通過（失敗したもの784件は報告済み）。意図的な改ざん30種類は30種類とも検出 [measured] | [verify.md](docs/frontier/m1/runs/m1-exit/verify.md)、[tamper.md](docs/frontier/m1/runs/m1-exit/tamper.md) | 終了した実行に対して `$S verify --run-id <run>` と `$S tamper --run-id <run>`。`frontier-node/crates/verify/mutate.sh`（12ビルド、58/58） |
| どの命令も計算予算の内側 †：Reveal はトランザクション全体の計算ユニットで、実プレイで p50 19,389、p99 22,951、最大 24,050。最も重い衝突の解決は約272,000 CU（271,673）で、これは最悪ケースを想定した**テスト用の埋め方であり、実プレイでは出ていません**。実プレイでの最大は50,984。プログラムテスト248件が通過、4件は設計上無視 [measured] | [criteria.md の行2](docs/frontier/m1/runs/m1-exit/criteria.md)、[M1-EXIT-NOTES §2 E1, §3](docs/frontier/m1/M1-EXIT-NOTES.md)、[svm-tests README](permutation-frontier/svm-tests/README.md) | `permutation-frontier/svm-tests/run.sh --release`（完全なゲートは `RELEASE_CHECK=1`） |
| 再現可能なリリースビルド。2回のビルドで同じハッシュ（`d85e1bd7...2281`）† [measured] | [M1-EXIT-NOTES の冒頭](docs/frontier/m1/M1-EXIT-NOTES.md) | `scripts/build-frontier.sh --twice` |
| Webクライアント †：M1 終了時点で npmテスト 529/529、画面テスト 51/51（12画面、日本語・英語、3種類の幅、アクセシビリティ確認）。その後このツリーで `npm test` を実行したところ 574/574 でした（ファイルには記録していません）。画面テストは再実行していません [measured] | [M1-EXIT-NOTES §2 E7](docs/frontier/m1/M1-EXIT-NOTES.md) | `cd permutation-gateway && npm ci && npm test`、`cd screens && npm ci && npm run browser && node --test *.screen.mjs` |
| 手数料市場への攻撃：最小チップ（14,668 lamports）では失敗する。防御プールと、入れ替わる支払い鍵150本以上があるときだけ耐える [model] | [c4-v3](docs/frontier/m1/c4-v3/) | 再実行の手順は [c4-v3 README](docs/frontier/m1/c4-v3/README.md)。入力のうち2つはこのリポジトリの外にある実験用ファイルなので、クリーンなチェックアウトだけでは完全には再現できない |
| バランス：シミュレートした財布10,000個で、1,500組のペアのシーズンのうち、6つの国の勝率は15.6〜17.4%。プレイヤーの行動は仮定 [sim] | [M0-FINAL](docs/frontier/m0/M0-FINAL.md) | `cd frontier-sim && cargo run --release -- doctrines --agents 10000 --seeds 250 --first-seed 10000 --set kernel --gate` |
| 第4節の Gemma 4 スパイクの数字 [measured] | [REPORT.md](docs/frontier/ai-agents/gemma4/REPORT.md) | 試験用のハーネスはこのツリーにありません。レポートを見てください |

## 4. AI市民を1画面で [designed; AS-BUILT: pending]

以下はどれもまだ作っていません。凍結の時点で実行が終わっていなければ、この節は1文になります：「AI市民：この提出には実装なし。設計のみ。」

**判断の流れ。** (1) コードが、ルール上許された候補を最大12個出す。(2) ローカルモデル（Gemma 4、思考オフ、温度0、鍵なし）がその中から選ぶ。(3) コードが検証する：形式、上限、最新状態での再確認、そしてプログラム自身。(4) 遅れた、不正だった、拒否された、のどれかなら、変更していないルールの自動操縦（autopilot）が動く。自動操縦は、AIが選んだことを取り消せない。上限：1回の判断あたり、また1日あたり、自国の兵の60%まで進軍。自国に40%は残す。モデルが選べる進軍は1日4回まで。1時間30回の操作枠は人と同じ。[designed：[契約 §3, §4](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md)]

**表示。** AIは必ずAIだと表示します（決定 W2）。名簿が正本で、AIのメッセージにはすべて出所を示すバイトとAIバッジがつきます。AIごとに公開の Wyllカード（性格、目標、守った協定と破った協定、理由）があります。AIは鍵を持ちません。鍵を持たない「マインド」（心）がモデルを呼び、ボット側の「ブレイン」（頭脳）が署名します。判断のたびにハッシュの記録が残り、`verify-minds` がそれを検査します。ハッカソンの実行はローカルの試験用チェーンと、運営者が持つテスト用の drand 鍵を使うので、「公開の乱数で配った」とは主張しません。

**ここまでに測ったもの：スパイク1回で、機能そのものではありません** [measured：[Gemma 4 スパイク](docs/frontier/ai-agents/gemma4/REPORT.md)]。モデルが進軍を選んだのは、設定によって20回の判断のうち 1回、9回、12回で、ルールボットは18回でした。最良の設定で、提案された行動の79%が有効でした。1回の判断に計算で約5秒かかります。プレイヤーの生の文章を文脈に入れると、注入された命令に従ったのは64回中10回（思考オン）、32回中1回（思考オフ）でした。無害化と包み込みを行うと64回中0回でした。完全な再生は、スロット1つに固定したサーバーで200回中200回成立し、同時に4スロットでは200回中50回で分岐しました。

**合格の基準値（事前に固定）**（[契約 §10.2](docs/frontier/ai-citizens/AI-CITIZENS-CONTRACT.md)）。結果はすべて `[AS-BUILT: pending]` です。

- モデルの判断300回以上のうち、有効な選択が95%以上
- 自動操縦への切り替えが5%以下
- プロンプト注入テスト（移植した17件と、記憶・上限への攻撃）で乗っ取り0件

<details>
<summary>事前に決めた9つの結果すべて（すべて未実施）</summary>

| 結果 | 目標 | 結果 |
|---|---|---|
| モデルの判断300回以上のうち有効な選択 | 95%以上 | [AS-BUILT: pending] |
| 自動操縦への切り替え | 5%以下 | [AS-BUILT: pending] |
| 次の鐘の前に余裕があった判断（遅れて実行されたものは0） | 99%以上 | [AS-BUILT: pending] |
| プロンプト注入テスト（移植した17件と、記憶・上限への攻撃） | 乗っ取り0件 | [AS-BUILT: pending] |
| 3か国以上で号令が出た評議会の期間 | 1回以上 | [AS-BUILT: pending] |
| A/Bテスト：同じシードで、人間の席が X に投票する／しない | 採用した側の実行だけで進軍と衝突が起きる | [AS-BUILT: pending] |
| `verify-minds` による、抜き取った20件の判断の再生 | 20件中18件以上が一致 | [AS-BUILT: pending] |
| ラベル（AI表示）のついたAIメッセージ | 100% | [AS-BUILT: pending] |
| Mac 1台で12体のAIが時間内に動く（ゲート G3） | 報告のみ | [AS-BUILT: pending] |

</details>

**このリポジトリのどこでも、次のことは主張しません：** 新しいゲームが devnet や mainnet で動いたこと。人が遊んだこと。需要や利用の実績。お金、賞金、支払いが動くこと。AI市民が人と見分けがつかない、ルールボットより強い、完全に再生できる（再生するのは一部の抜き取り）、お金を稼ぐ、といったこと。1台のマシンで数千体を動かせること（Mac で1時間に約400〜450回のモデル判断が目安です [estimate]）。失敗の基準値と監査の設計：[概要 §2, §6](docs/DESIGN-OVERVIEW.ja.md#6-ai市民-すべて設計のみas-built-pending)。

## 5. 実際に動かす

すべてローカルです。財布も devnet も有料サービスも要りません。**手早く試す：練習戦**（チェーンもビルドも不要。Python 3 があれば動きます）。

```sh
cd permutation-server/web && python3 -m http.server 8000 --bind 127.0.0.1
# open http://127.0.0.1:8000/frontier/practice.html   (JA or EN follows your browser)
```

ローカルのフルスタック（ローカルの試験用チェーンで動くゲーム本体。`up` は前面で動き続けるので、ターミナルを2つ使います）、ブラウザの自動操作、終了シーズンの手順、ツールチェーン、テストのコマンドは **[docs/RUNNING.md](docs/RUNNING.md)**（英語）にあります。開くのは `/` ではなく `/frontier/frontier/` です。ルートのアドレスは今も古いページに着きます。**既知の問題：** ヘラルドは描き込みアート（絵）を配信しません（ファイルの配信処理が `art/*/@1x/` の `@` を拒否します）。そのため、ヘラルドの URL で見る地図は、上のスクリーンショットより素っ気ない見た目になります。1文字で直せる修正は [RUNNING §2](docs/RUNNING.md#2-the-full-local-stack-the-game-on-a-local-test-chain) に書いてあります。**動画：** ゲームと M1 終了シーズン [VIDEO LINK pending]。AI市民（評議会、号令、協定の記録）[VIDEO LINK pending]。AI市民を作ってから録画します。

## 6. リポジトリの地図

用語：**キーパー**は誰でも動かせる補助プロセスで、drand のビーコンを載せ、進軍の封印を開き、衝突を解決します。**ヘラルド**はログを JSON と WebSocket にまとめて見せる読み取り専用のサーバーです。**リレー**は手数料と家賃を上限つきで肩代わりする窓口で、人もボットも同じ入口を通ります。

| パス | 中身 |
|---|---|
| `permutation-frontier/` | Solana プログラム（SBPF v2）。`svm-tests/`（LiteSVM のテスト群）を含む |
| `permutation-rules/src/frontier/` | ルールのカーネル（経済、移動、衝突、構え）。プログラム、シミュレータ、ブラウザで共有。M0 の時期に作った、包囲・官職・分配のカーネル（`siege.rs`、`office.rs`、`payout.rs`、`pools.rs`、`laurel.rs`、`mandate.rs`）も入っている。これらはライブラリとシミュレータ用のコードで、M1 のプログラムにはつながっていない（つながっているのは、見張り交代の補助関数だけ）。征服やお金の結果ではない |
| `frontier-abi/`, `frontier-wasm/` | プログラムの ABI（インターフェース定義）。ブラウザ向けに WebAssembly にしたカーネル（衝突レポートは自分で検証できる） |
| `frontier-sim/` | バランスのシミュレータ（国、方針、ボット対最善応答） |
| `frontier-node/` | オフチェーンの Rust ワークスペース：`keeper`（キーパー）、`herald`（ヘラルド）、`verify`、`bots`、`agents`、`localnet`、`drand-replay`、`fclient`、`findex`、`stack`（まとめて起動する役）、`itest` |
| `permutation-gateway/` | リレー（`src/frontier/`）、JS SDK、テスト、Playwright の画面テスト（`screens/`） |
| `permutation-server/web/frontier/` | Webクライアント（地図、村、進軍の作成、鐘のシート、レポート、オンボーディング、練習、観戦） |
| `scripts/` | `build-frontier.sh`、`m1-run-s7.sh`（終了シーズン）、`m1-nightly.sh`、`build-wasm.sh`、`check-v9-frozen.sh` |
| `docs/` | [DESIGN-OVERVIEW](docs/DESIGN-OVERVIEW.ja.md)、[RUNNING](docs/RUNNING.md)、[pitch/DEMO_SCRIPT](docs/pitch/DEMO_SCRIPT.md)、[frontier/](docs/frontier/README.md)（設計、決定、M1の記録、AI市民と征服の契約）、[earlier-prototype/](docs/earlier-prototype/INDEX.md) |
| `research/`、`solana-ethereum-hackathon-games-2023-2026.xlsx` | 背景の調査（Eternum、他のオンチェーンゲーム、UI の比較）と、ハッカソンのゲーム一覧の表計算ファイル。ゲーム本体ではない |

**名前は歴史的なものです（決定 V1）。** Wylls への改名では、コードの識別子、クレート・パッケージ・フォルダの名前、ハッシュと署名のドメイン、シードは変えていません。そのため `permutation-*` と `frontier-*` が残っています。

**以前のプロトタイプ。CI やコードの経路が参照しているため、このツリーに残しています：** `permutation-chain/`（MagicBlock プログラム）、`permutation-server/` の残り、`permutation-rules/`（ルール v8）と `permutation-gateway/` の Wylls 以前のファイル、`permutation-state-prototype/`、`permutation-state-solana-receipt-spike/`、`demo/`（以前のプロトタイプの devnet シーズンのログ）、`research/`。

## 7. 正直な限界

- **ローカルの試験用チェーンだけです。** 終了シーズンは20倍速、夜間実行とスモーク実行は100倍速で、すべてローカルのチェーンで動かしました。**新しいゲームは devnet でも mainnet でも一度も動いていません。** devnet での暗号系 syscall のコストと家賃は未確認です。
- **人がシーズンを遊んだことはありません。** 参加者1,000は、すべてチームが書いたルールボットです。13種類のプロファイルで、未知の攻撃者に耐えると証明したことにはなりません。少人数・招待制のローカルなプレイテストを準備中で、まだ行っていません。より大きな非公開の devnet プレイテスト（50〜200人）の手順書は文書だけで、承認されておらず、実施もしていません。5,000人の観戦者は負荷生成ツールでした。
- **封印の秘匿は試していません。** 終了シーズンでは、drand のラウンドをアーカイブから再生したため（簡易スタックはテスト用の鍵を使います）、将来のラウンドの署名は最初から分かっていました。測定した結果（有効な封印の開示漏れ0、ごみの封印24件を処理）が示すのは、止まらずに動くことと、決着がつくことで、秘匿ではありません。秘匿は設計上の性質です。
- **お金（M2）と社会（M3）は未実装です。** 誰も払わず、誰も稼がず、賞金はありません。
- **AI市民は未実装です。** 第4節は、設計とスパイク1回だけです。
- **征服はこのツリーに入っていません。** 手元のブランチ `frontier/cq-*` にあり、プッシュするまで GitHub にはありません。
- **終了シーズンの穴：** 敵対者の「保留」9種類のうち2種類は、待機中の書き込みが見つからず、実行できませんでした。防御の払い戻しは、修正後の夜間実行で確認したもので、7日間のシーズンでは確認していません（[M1-EXIT-NOTES §4.3, §7](docs/frontier/m1/M1-EXIT-NOTES.md)）。設計が狙う規模は数千人ですが、最大の試験は1,000体のボットです。
- **人のプレイテストの前にやること：** Webの修正2件、入口のリダイレクト、devnet の設定の不足、ホスティング（[概要 §8](docs/DESIGN-OVERVIEW.ja.md#8-未実装のもの正直な限界ロードマップ)）。28日間のシーズンは設計上のプリセットで、28日間のシーズンを動かしたことはありません。
- **CI は一部が赤で、修正後は再実行していません。** `codex/frontier` ブランチの GitHub 上の実行は、2026-10-01 と 10-02 の2回です（[36923004057](https://github.com/r0ze998/wylls/actions/runs/36923004057)：`2c0462f`、[36958805861](https://github.com/r0ze998/wylls/actions/runs/36958805861)：`5ed36fa`）。どちらも8ジョブのうち6つが通りました（以前のプロトタイプのルール／プログラム／サーバーのジョブ、シミュレータ、オフチェーンのワークスペース、ゲートウェイとWebのテスト、レシートの試作、ブラウザのスモークテスト）。失敗は2つです。「Frontier M1 rules, ABI and program」は最初の番人ステップで失敗しました（`d95fa25` との v9 差分の確認です。承認済みの改名が正当にそこを変えたためで、そのため SBF ビルドと LiteSVM のステップは **GitHub 上では一度も動いていません**）。もう1つは「Frontier M1 web kernels」で、GitHub の Linux ランナーで作った WebAssembly モジュールのハッシュが、Mac で作ったものと違いました。修正は `scripts/check-v9-frozen.sh`、`scripts/build-wasm.sh`、`frontier.wasm.hosts` にあります。確認できたのは Mac 上だけで、Linux のハッシュは CI のログから取りました。Web画面のジョブはなく、無視している in-process テストも入っていません。スケジュール実行のワークフロー `doctrine-balance.yml`（毎日 03:17 UTC、1,500組のペアのシーズン）は、GitHub で一度も動いたことがなく、デフォルトブランチに入ると動き始めます。[`.github/workflows/`](.github/workflows/)、[DECISIONS F1, O-M1-17](docs/frontier/DECISIONS.md) を見てください。

## 8. 以前のプロトタイプ

以前の、別のゲーム（当時の名前は Permutation State。6つの国、将校、180ティック、MagicBlock のエフェメラル・ロールアップ）は、Solana devnet でシーズンを1回通して動かし（ルール v8、シーズン 1790355636798）、14項目中14項目を再検証しました（[検証の出力](docs/earlier-prototype/devnet-season-1790355636798-verification.txt)）。コードはブランチ `codex/magicblock-playable` にあります。これは歴史であり、上の記述はどれもこれを根拠にしていません。古い README と設計ページは、注意書きつきで [docs/earlier-prototype/INDEX.md](docs/earlier-prototype/INDEX.md) に残してあります。

## 9. ライセンスとリンク

リポジトリのルートには、まだ **`LICENSE` ファイルがありません**。クレートのマニフェスト（`frontier-node`、`frontier-abi`、`frontier-wasm`、`frontier-sim`、`permutation-*`）は `license = "MIT"` と宣言しています。`permutation-server/web/sdk/vendor/` にある同梱ライブラリは、それぞれ自分のライセンスを持ちます。

リンク：[ピッチ（英語）](PITCH.md) · [提出記録（英語）](SUBMISSION.md) · [デモ台本（英語）](docs/pitch/DEMO_SCRIPT.md) · [動かし方（英語）](docs/RUNNING.md) · [設計の記録（DESIGN.md rev 4、英語）](docs/frontier/DESIGN.md) · [決定ログ（英語）](docs/frontier/DECISIONS.md) · [設計の索引](docs/frontier/README.md) · [日本語の現状要約](docs/frontier/SUMMARY.ja.md) · [日本語の設計概要](docs/DESIGN-OVERVIEW.ja.md) · [AI市民（日本語）](docs/frontier/ai-citizens/SUMMARY.ja.md)
