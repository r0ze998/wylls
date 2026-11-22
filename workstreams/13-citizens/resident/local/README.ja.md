# ⑬ 住民をローカルの世界の外部の住民として動かす（TEST のみ）

2026-11-22。`reports/playable-2-3-4-13.md` §2 の 2 番目。⑬ の頭脳（目標・上限・記憶）を、⑤B（#57）の外部の住民の道に載せた。
プログラムも relay もランチャーも変えていない。モデルも有料 API も使わない（規則だけ）。

## 動かし方

```sh
# 1 回だけ：TEST 鍵（0600、公開アドレスだけを表示）
node -e "import('./workstreams/03-composability/mcp/examples/external-resident/key.mjs').then(m => console.log(m.createKeyFile('/path/r13.json').address))"
# 世界：運営がそのアドレスを受け入れる
scripts/play-local.sh --demo --ai 1 --external <アドレス>
# 住民：自分のプロセス、自分の鍵
node workstreams/13-citizens/resident/local/client.mjs --launcher http://localhost:41920 --key /path/r13.json \
  --dir /絶対パス/r13 [--goal village-first|surplus-use] [--nation 0-5] [--mcp http://127.0.0.1:<port>/mcp]
```

判断の記録は `<dir>/decisions.jsonl`、記憶は `<dir>/state.json`（rename で書く）。`touch <dir>/HALT` で一時停止。

## 対応表

| ⑬ の部品 | ローカルでの意味 | ファイル |
|---|---|---|
| 参加（`live/candidates.mjs` UNSUPPORTED.join） | ⑤B の新しい住民の道：運営が公開アドレスを受け入れ、住民がページと同じ開始の道を押し、自分で Join に署名する | `client.mjs` → `agent.mjs` `discoverWorld` |
| 目標 `GOALS`（growth・use・planDepth・reserve・patienceBells） | growth：計画の建物（その村がいちばん少なく作る資源、ページの `BUILD_ITEMS` と `buildOffers` の数）。use：計画と蓄えを超えた在庫で兵を訓練、予備兵 100 以上で部隊を編成 | `brain.mjs` `assessReal`・`localCandidates` |
| 候補と「保留の理由」 | 6 つの命令それぞれ。読めない数は保留（0 とみなさない） | `brain.mjs` |
| 決め方 | 料金のかからない規則（点数がいちばん高い保留なしの候補）。provider を差すときは ⑬ の `decideLive` の境界（`charges:false`、提示した候補だけ） | `brain.mjs` `decideLocal` |
| 上限 `DEFAULT_LIMITS` | 1 ターン 1 回（世界の規則、設定ではない）。失敗ごとに保留が倍（4・8・16・32、最大 36 ターン）。待つと見る間隔が倍（最大 4 ターン）。判断回数 500。1 日 144 回。Harvest は他にすることがないとき 6 ターンに 1 回 | `brain.mjs` `LOCAL_LIMITS`、`runner.mjs` |
| 記憶・再起動 | `intended` を保存 → 署名を保存（送る前）→ 送る → 署名で結果を追う。再起動で `intended` は「送っていない」。署名のある未決の行がある間は新しい命令を出さない | `journal.mjs`、`runner.mjs` |
| 観測 | 公開の herald の自分の記録だけ（`/h/season`、`/h/status`、`/h/me/<自分>`、村が無い間は自分の国の州の空き地、村ができたら自分の州だけ：`resolvedNext` を見て、世界の決着が前のターンに届くまで編成を保留する。プログラムの `resident_ok` と同じ。ページの「編成」ボタンも同じ理由で保留し、押しておくと整ったときに 1 回だけ送る。×60 では自分の州が整っている時間が短い：verify-pr143 の計測で人のページの州は約 15%、外部の住民の州は約 3%）。MCP は読み取りだけ（記録用に村の在庫を読む） | `observe.mjs` |

S1 の値から変えた上限（住民自身の設定。⑬ の S1 の値より緩いが、世界の規則（1 ターン 1 回）より緩くはならない）：`wakeEveryBells` 3→1、`actionsPerDay` 12→144、`idleBackoffMaxBells` 24→4。
S1 の値は S1 の 30/時のバケットに合わせたもので、1 ターン 1 回の世界では 30 ターンに 10 回しか動けないため。

## 数ターンの計画（④ が実行する、2026-11-22）

`--plan --runexec <runexec の絶対パス>` を付けると、村ができたあと、住民は自分の村の次の命令を **12 手の計画**にし（建物の列 → 収穫 → 訓練 → 建物 → 訓練 → … → 部隊の編成。`plan.mjs`）、④ の計画の記録（`workstreams/04-execution` の `runexec plan …`、SQLite、既定は `<dir>/plans.sqlite`）がそれを 1 ターン 1 手ずつ実行する（`executor.mjs`）。6 つの命令だけ。隊商は入れない（Q4、記録の側でも `NotLocalOrder` で断る）。

```sh
(cd workstreams/04-execution && cargo build --release --locked --bin runexec)
(cd workstreams/03-composability/mcp && npm ci)   # client.mjs は --mcp が無くても mcp-client.mjs を読み込む
(cd permutation-gateway && npm ci --ignore-scripts)
node workstreams/13-citizens/resident/local/client.mjs --launcher http://localhost:41550 --key /path/r13.json --dir /絶対パス/r13 \
  --plan --runexec "$PWD/workstreams/04-execution/target/release/runexec" [--plan-db /絶対パス/plans.sqlite] [--plan-steps 12]
```

| 規則 | どこで |
|---|---|
| 計画の手ごとの意図を、署名の**前**に ④ に書く（`plan intend`）。署名は送る**前**に ④ に書く（`plan signed`）。④ が断ったら送らない | `runner.mjs`（④ → ⑬ の日誌の順） |
| 着地・失敗は、記録した署名をチェーンで読んで決める。署名が残ったまま止まったら、再起動で署名を読む。二度と送らない | `executor.mjs` `reconcile`、④ `settle` |
| 1 ターン 1 手（Join は数えない）を ④ の記録でも守る（計画をまたいで） | ④ `intend` の `TurnUsed` |
| 2 つ目のプロセスは動けない：lease と epoch。新しいプロセスは前の lease（20 秒）が切れるまで待つ。古いプロセスの署名は `Fenced` で断られ、送られない。署名のない意図は `not-sent` に戻る | ④ `claim` |
| チェーンが断った（failed・refused）、署名の行方が有効期間内に分からない（expired-unknown）、世界が変わった（建物の数が計画と違う、ページが出さない、待っても足りない、48 ターン待った）→ 計画を止め、今の村から作り直す（`replaces`）。ただし最初の手が同じ確かめですぐ止まる計画は作らない（作って止めてを繰り返すと計画の上限 24 個を使い切るため）。そのターンは住民の頭脳が決め、次の回にまた計画を試す | ④ `settle` / `stop`、`plan.mjs` `checkStep`、`executor.mjs` `next` |
| 自分のプロセスの、署名のない意図が残った（署名の記録とその後の `not-sent` の記録の両方が失敗した）→ 何も送っていないので `not-sent` に戻して続ける（前は再起動まで止まっていた） | `executor.mjs` `next` |
| 送る前の確かめは、ページが人に対して行うものと同じ（`buildOffers`・`trainCost`・部隊の規則・`resident_ok`） | `plan.mjs` |
| S1 の世界（Season の layoutVersion 2・programVersion 4 以上）では、ページと同じく S1 の規則を有効にし（`setS1`）、鉱山を村の**地形の鉱石**より上の分で数える（プログラムの `copy_number` と同じ）。地形の鉱石は自分の Holding の `TERRAIN_ORE` で読む。読めないときは、自分の PlaceHome から数えた着地済みの鉱山の数から決める。どちらも無いと段の基準（15/時）で数え、少なく見えることがあると記録に書く（前は常に段の基準で数え、4 つめの鉱山を 2 つめの値段で見積もって 8 回 `Insufficient` で断られた。LP9-4） | `observe.mjs`、`brain.mjs` `villageOre` |
| 自分の村で着地した建物を記憶に数える（`state.json` の `village`。日誌の行は 96 で消えるため）。herald の記録がまだ自分の着地した建物を見せていない（記録の数 < 着地した数 + 1）間は、計画を作り直さず、その建物を送らず、新しい計画も作らずに待つ。記録の数が計画より多い（別の建物がある）ときは作り直す | `brain.mjs` `recordBehind`、`plan.mjs` `checkStep`、`executor.mjs` `next` |
| チェーンが資源不足（`Custom(21)` = `Insufficient`）で断った建物は、断られたときの在庫を覚え、その建物にかかる資源（Build の基本の値段で 0 でないもの）がどれも増えるまで送り直さない。新しい計画の最初の手にもしない。その建物が着地すると消える。失敗の保留（倍になる保留）はそのまま | `brain.mjs` `refusalHold`、`plan.mjs` |

計画の待ち方は住民自身の設定（`PLAN_LIMITS`：手数 12、1 手の待ち 48 ターン、1 つの世界で計画 24 個まで、訓練 100、部隊 100）。

## できないこと

- 隊商・掲示板の返答と送り・行軍・投票：ローカルの act relay にない（6 つの命令だけ）。隊商は Q4（r0ze の判断待ち）。
- 広い土地（`--wide`）：play-local が `--external` と一緒に使わせない（住民は PlaceHome で家を置く）。
