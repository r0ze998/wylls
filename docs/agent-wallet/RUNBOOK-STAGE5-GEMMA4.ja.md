# 段階5 手順書：Gemma 4 26B での検証（Mac で実施）

目的：今回の変更（判断ごとの記録、`driver`、委任と上限の事前確認、照合規則、厳密スキーマ）を、固定設定の Gemma 4 26B で確かめる。あわせて、厳密スキーマの既定値（off／on）を決めるための比較表を作る。

この手順で確かめないこと：本番の価格や上限、実資金。テスト用 USDC とローカルのテスト用チェーンだけを使う。

## 前提：どの木で行うか（2026-10-24 改訂）

段階 5 は、**最新の S1 と agent wallet を統合した `agent-wallet/integrate` の HEAD** で行う。

- 以前この手順書に書いた旧コミット `49941463`（S1 より前のプログラム）は、比較と再現のためだけに残す。段階 5 の結果としては扱わない。
- 統合先は main。PR #10 のマージは、段階 5 を含む最新の検証が済むまで保留している。

**始める前に満たしていること（どれか 1 つでも欠けていたら、まだ始めない）**

1. S1 のローカルスタックの修正（`HANDOFF-S1-LOCAL-STACK.ja.md` §4 の 1〜5）が main に入り、`agent-wallet/integrate` に取り込まれている。
   - 確かめ方：§1 の「S1 のシーズンが立つか」の手順がすべて通る。
2. agent の runner が S1 の費用を知っている。**2026-10-24 に対応済み**（`STATUS-2026-10-23.ja.md` §9.14）。
   - runner は、ヘラルドの `rulesetHash` からシーズンの規則を読み、S1 の表（工房、強い兵の武具）をモデルに伝える。
   - 同じ表で、払えない答えをチェーンの手前で止め、厳密スキーマにも反映する。
   - 確かめ方：各回の `transcript.json` の判断の理由や `finalized.json` に、武具の足りない訓練による「chain で失敗」が出ていないこと。
3. `STATUS-2026-10-23.ja.md` に、最新の HEAD での実チェーンと実ブラウザの確認（作成〜出金、手動プレイへの復帰）が記録されている。段階 5 はその上で行う。

## 0. 守ること

- 有料の API は使わない（モデルはローカルの llama-server だけ）。
- ポートは 41000〜41999 の範囲だけ。ほかのスタックと重ならない百の位を選ぶ（`lsof -nP -iTCP -sTCP:LISTEN` で確認）。下の例は 41600 番台。
- run id とシーズン番号は、毎回新しいものにする（conquest の run id は一度しか使えない）。
- 結果を共有するときは、`relay/` と `keys/` のディレクトリ（運営トークン、seed、鍵ファイル）を含めない。

## 1. 準備（1回だけ）

```sh
git fetch origin agent-wallet/integrate
git worktree add ../aw-stage5 origin/agent-wallet/integrate     # 既存の作業ツリーには触れない
cd ../aw-stage5
git log -1 --format=%H                                          # 検証したコミットとして記録する（49941463 ではないこと）
scripts/build-frontier.sh --features test-beacon
scripts/build-prize.sh
npm ci --prefix permutation-gateway
(cd frontier-node && cargo build --locked --release --workspace)
```

**S1 のシーズンが立つか（最初に 1 回）**：モデルなしで短く立てて、S1 であることを確かめてから片付ける。

```sh
RUN=stage5-s1check; R=$PWD/frontier-node/.local/frontier/$RUN/relay
FRONTIER_AGENT_WALLET=1 FRONTIER_AGENT_RUNNER=1 FRONTIER_AGENT_CUSTODY_KEY_FILE=$R/agent-custody.json FRONTIER_AGENT_KEYS_DIR=$R/agent-keys \
frontier-node/target/release/frontier-stack up --conquest --mode accel --beacon test-key --preseason-scale 2000 --scale 10 \
  --game-hours 48 --season-end-at-play-end --bots 0 --personas off --prize-so permutation-prize/target/deploy/permutation_prize.so \
  --entry-fee 25000000 --run-id $RUN --base-port 41600 --season 69 &
# 「s of setup」が出てから、数分待って：
curl -s http://127.0.0.1:41640/h/season | grep -o '"rulesetHash":"[0-9a-f]*"'   # 234c0dc2…（RULESET_HASH_V3、S1）であること
curl -s http://127.0.0.1:41640/h/status/conquest | grep -o '"conquest":[a-z]*'      # true であること
curl -s http://127.0.0.1:41640/h/status | grep -o '"rings":\[[^]]*\]'              # ring が 5 つ公開されていること
frontier-node/target/release/frontier-stack down --run-id $RUN
```

- 起動の途中で `run failed: … {"Custom":1}` と出る：S1 のスタック修正がまだ入っていない（CreateSeason が `BadData`）。
- `rulesetHash` が `5fbaf678…`（RULESET_HASH_V2、MC）：S1 のプログラムではない。ビルドし直す。
- ring が公開されない：keeper の読み込み上限が S1 用になっていない（`HANDOFF-S1-LOCAL-STACK.ja.md` §3 の 2）。

どれかに当たったら、段階 5 は始めない。

モデルサーバーを起動する（固定設定：別名 `gemma-4-26b-a4b-it`、41901 番、スロット 1、コンテキスト 16384、thinking off）。

```sh
sh permutation-gateway/citizens/llama/start-pinned.sh /tmp/llama-stage5.log &
# モデルのパスは既定で固定設定のもの。別の場所なら AI_MODEL=<gguf のパス>、llama-server が別の場所なら LLAMA_SERVER=<パス> を前に付ける
# "model loaded" を待ってから：
curl -s http://127.0.0.1:41901/v1/models    # id が gemma-4-26b-a4b-it であること
curl -s http://127.0.0.1:41901/props | grep -o '"model_path":"[^"]*"'    # 読み込んだファイルが Gemma 4 26B の gguf であること
```

**注意**：起動スクリプトは、どのモデルを読み込んでも別名を `gemma-4-26b-a4b-it` にします。`/v1/models` の id だけでは、本当に Gemma 4 かは分かりません。読み込んだファイルは `/props` の `model_path` で確かめてください。この値はベンチと E2E の記録にも残ります（`report.json` と `transcript.json` の `model.modelPath`）。

## 2. 判断ベンチ（チェーン不要、各 3〜5 分）

MC の 10 場面 × 3 回と、S1 の 4 場面 × 3 回を、スキーマ off と on で 1 回ずつ実行する（合わせて 4 回）。

```sh
AGENT_BENCH_LLM=http://127.0.0.1:41901 AGENT_BENCH_REPEATS=3 AGENT_BENCH_OUT=$PWD/.local/stage5/bench-off node permutation-gateway/scripts/agent-decision-bench.mjs
AGENT_BENCH_LLM=http://127.0.0.1:41901 AGENT_BENCH_REPEATS=3 AGENT_BENCH_STRICT=1 AGENT_BENCH_OUT=$PWD/.local/stage5/bench-on node permutation-gateway/scripts/agent-decision-bench.mjs
AGENT_BENCH_LLM=http://127.0.0.1:41901 AGENT_BENCH_REPEATS=3 AGENT_BENCH_RULES=s1 AGENT_BENCH_OUT=$PWD/.local/stage5/bench-s1-off node permutation-gateway/scripts/agent-decision-bench.mjs
AGENT_BENCH_LLM=http://127.0.0.1:41901 AGENT_BENCH_REPEATS=3 AGENT_BENCH_RULES=s1 AGENT_BENCH_STRICT=1 AGENT_BENCH_OUT=$PWD/.local/stage5/bench-s1-on node permutation-gateway/scripts/agent-decision-bench.mjs
```

- `AGENT_BENCH_RULES` を付けないと、これまでと同じ MC の 10 場面だけを実行する（10 月 17 日の結果と比べられる）。
- S1 の 4 場面：
  - 武具がないので普通の兵を訓練する。
  - 武具があり、強い兵も選べる状態で訓練する。
  - 鉱石が上限まで余っているので工房を建てる。
  - 何も払えないので休む。
- S1 の場面では、モデルに S1 の表（工房、強い兵の武具）を伝え、S1 の規則で払えるかを判定する。

`report.md` の 1 行目に、どちらのスキーマで実行したかが書かれる（`JSON schema: loose …` または `strict (per action)`）。

## 3. 実世界の窓（1 回あたり約 15 分。off と on を各 3 回）

1 回ごとに、新しいスタックを立てて、E2E を流して、片付ける。`STRICT` を `0` と `1` で切り替え、`N` を 1〜3 で回す（off-1, on-1, off-2, on-2, off-3, on-3 の順にすると、時間帯の影響が偏らない）。

```sh
STRICT=0; N=1; RUN=stage5-$([ $STRICT = 1 ] && echo on || echo off)-$N; SEASON=$((70 + N + 10*STRICT))
R=$PWD/frontier-node/.local/frontier/$RUN/relay
FRONTIER_AGENT_WALLET=1 FRONTIER_AGENT_RUNNER=1 FRONTIER_AGENT_TICK_MS=8000 FRONTIER_AGENT_MIN_CALL_GAP_MS=30000 FRONTIER_AGENT_RECONCILE_MS=5000 \
FRONTIER_AGENT_LLM_URL=http://127.0.0.1:41901 FRONTIER_AGENT_LLM_ALIAS=gemma-4-26b-a4b-it FRONTIER_AGENT_LLM_STRICT_SCHEMA=$STRICT \
FRONTIER_AGENT_CUSTODY_KEY_FILE=$R/agent-custody.json FRONTIER_AGENT_KEYS_DIR=$R/agent-keys \
frontier-node/target/release/frontier-stack up --conquest --mode accel --beacon test-key --preseason-scale 2000 --scale 10 \
  --game-hours 48 --season-end-at-play-end --bots 0 --personas off --prize-so permutation-prize/target/deploy/permutation_prize.so \
  --entry-fee 25000000 --run-id $RUN --base-port 41600 --season $SEASON &
# 別のターミナルで（E2E は、シーズンが参加を受け付けるまで最大 5 分待つ）。まず、このシーズンが S1 であることを記録する：
mkdir -p .local/stage5/$RUN && curl -s http://127.0.0.1:41640/h/season > .local/stage5/$RUN/season.json
AGENT_E2E_URL=http://127.0.0.1:41640 AGENT_E2E_RPC=http://127.0.0.1:41610 AGENT_E2E_MODEL=real AGENT_E2E_LLM=http://127.0.0.1:41901 \
AGENT_E2E_WINDOW_MS=420000 AGENT_E2E_RUN_DIR=$PWD/frontier-node/.local/frontier/$RUN AGENT_E2E_OUT=$PWD/.local/stage5/$RUN \
node permutation-gateway/scripts/agent-wallet-e2e.mjs
# スタックを止める前に：モデルが選んで送った行動を、1 件ずつチェーンに照会する
node permutation-gateway/scripts/agent-finalized-count.mjs --rpc http://127.0.0.1:41610 --state $R/agent-wallet.json > .local/stage5/$RUN/finalized.json
frontier-node/target/release/frontier-stack verify --run-id $RUN > .local/stage5/$RUN/verify.txt
frontier-node/target/release/frontier-stack down --run-id $RUN
```

`agent-finalized-count.mjs` は、エージェントの**全期間**で、モデルが選んで送った行動を数えます。E2E の「窓」（7 分）だけを数えるものではないので、E2E の `modelActionsSent` より大きくなることがあります。

このスクリプトは 2026-10-23 のリハーサル（Linux、Gemma 3 4B）で、動いているチェーンに対して初めて実行しました。そこで、状態ファイルの読み方の誤り（何も数えずに空の結果を返していた）を見つけて直しています。今は、エージェントが見つからなければエラーで止まります。`--state` と `--url` の 2 つの読み方で、同じ数になることも確かめました。

## 4. 記録する表

**判断ベンチ（10 場面 × 3 回）**

| 場面 | スキーマ | 判断（正解） | コードの拒否 | 同じ答えの再現 | 1 回あたりの時間（中央値） |
|---|---|---|---|---|---|
| MC 10 場面 | off | ／30 | | ／10 | |
| MC 10 場面 | on | ／30 | | ／10 | |
| S1 4 場面 | off | ／12 | | ／4 | |
| S1 4 場面 | on | ／12 | | ／4 | |

**実世界の窓（各 7 分）**：E2E の記録（`transcript.json` の `window`）と `finalized.json` から書く。

表は手で写さずに、次のコマンドで作れます。

```sh
node permutation-gateway/scripts/agent-stage5-summary.mjs --dir .local/stage5 > .local/stage5/summary.md
```

- シーズンの種類（S1／MC／M1）は、各回の `season.json` の `rulesetHash` から読みます。
- スキーマの種類は、記録から読みます（ベンチの `model.settings.schema`、relay の `terms.runner.schema`）。ディレクトリ名からは判断しません。
- 読み込んだモデルのファイルも一覧にします。Gemma 4 でなければ、そう書きます。
- ファイルが欠けている欄は、そのことを表に書きます。

| 回 | シーズン | スキーマ | E2E のチェック | 呼び出し | 判断料 | モデルが送った行動 | うち finalized を個別確認 | chain で失敗 | コードの拒否 | 休み | autopilot の代行 | 検証器 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off-1 | S1 | off | /19 | | | | | | | | | |
| on-1 | S1 | on | /19 | | | | | | | | | |
| …（6 回） | | | | | | | | | | | | |

10 月 17 日の数値（判断 24/30、run 10a〜c）は比較のために並べてよいが、同じ表の行には混ぜない。条件（コミット、スキーマ、tick、間隔）を併記する。

## 5. 合格の目安と、決めるための判断

- 各回のシーズンが S1 である（`season.json` の `rulesetHash` が `RULESET_HASH_V3`。集計表の「シーズン」欄が S1）。
- 各回の E2E が 19/19（段階 3 の「委任解除後」の手順を含む）。
- モデルが送った行動のうち、finalized を個別に確認できた件数を数える（「送信」だけでは数えない）。
- 検証器が PASS。
- 「chain で失敗」が出たら、その行動の内容を記録する。武具の足りない訓練なら、前提 2（runner が S1 の費用を知らない）による失敗。
- 厳密スキーマの既定値は、判断（正解数）・コードの拒否・費用・モデルが送った行動の数を、off と on で比べて決める。判断が下がるなら on にしない。拒否だけが減って判断が変わらないなら on を推奨する。

## 6. 片付けと共有

- llama-server を止める。`frontier-stack down` を全 run で済ませる。
- 共有するのは `.local/stage5/` の `season.json`、`transcript.json`、`report.md`／`report.json`、`finalized.json`、`verify.txt` だけ。`frontier-node/.local/frontier/<run>/relay/` と `keys/` は共有しない。
