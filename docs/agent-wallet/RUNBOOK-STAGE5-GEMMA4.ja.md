# 段階5 手順書：Gemma 4 26B での検証（Mac で実施）

目的：今回の変更（判断ごとの記録、`driver`、委任と上限の事前確認、照合規則、厳密スキーマ）を、固定設定の Gemma 4 26B で確かめる。あわせて、厳密スキーマの既定値（off／on）を決めるための比較表を作る。

この手順で確かめないこと：本番の価格や上限、実資金。テスト用 USDC とローカルのテスト用チェーンだけを使う。

> **2026-10-24 追記：どのコミットで実施するか**
>
> `agent-wallet/integrate` には、2026-10-23 に main（PR #11 の S1）が入りました。その main では、`frontier-stack up --conquest` でシーズンを作れません。プログラムは版 4（S1）のシーズンしか受け付けず、スタックはまだ版 3 の征服シーズンを作るためです。詳しくは `STATUS-2026-10-23.ja.md` §9.12 を見てください。
>
> main 側でスタックが S1 に対応するまでは、main を取り込む前のコミット **`49941463`** を使ってください。この PR の修正は、すべてこのコミットに入っています。
>
> ```sh
> git fetch origin agent-wallet/integrate && git worktree add ../aw-stage5 49941463
> ```

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
git log -1 --format=%H                                          # 検証したコミットとして記録する
scripts/build-frontier.sh --features test-beacon
scripts/build-prize.sh
npm ci --prefix permutation-gateway
(cd frontier-node && cargo build --locked --release --workspace)
```

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

10 場面 × 3 回を、スキーマ off と on で 1 回ずつ実行する。

```sh
AGENT_BENCH_LLM=http://127.0.0.1:41901 AGENT_BENCH_REPEATS=3 AGENT_BENCH_OUT=$PWD/.local/stage5/bench-off node permutation-gateway/scripts/agent-decision-bench.mjs
AGENT_BENCH_LLM=http://127.0.0.1:41901 AGENT_BENCH_REPEATS=3 AGENT_BENCH_STRICT=1 AGENT_BENCH_OUT=$PWD/.local/stage5/bench-on node permutation-gateway/scripts/agent-decision-bench.mjs
```

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
# 別のターミナルで（E2E は、シーズンが参加を受け付けるまで最大 5 分待つ）：
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

| スキーマ | 判断（正解／30） | コードの拒否 | 同じ答えの再現（10 場面中） | 1 回あたりの時間（中央値） |
|---|---|---|---|---|
| off | | | | |
| on | | | | |

**実世界の窓（各 7 分）**：E2E の記録（`transcript.json` の `window`）と `finalized.json` から書く。

表は手で写さずに、次のコマンドで作れます。

```sh
node permutation-gateway/scripts/agent-stage5-summary.mjs --dir .local/stage5 > .local/stage5/summary.md
```

- スキーマの種類は、記録から読みます（ベンチの `model.settings.schema`、relay の `terms.runner.schema`）。ディレクトリ名からは判断しません。
- 読み込んだモデルのファイルも一覧にします。Gemma 4 でなければ、そう書きます。
- ファイルが欠けている欄は、そのことを表に書きます。

| 回 | スキーマ | E2E のチェック | 呼び出し | 判断料 | モデルが送った行動 | うち finalized を個別確認 | chain で失敗 | コードの拒否 | 休み | autopilot の代行 | 検証器 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| off-1 | off | /19 | | | | | | | | | |
| on-1 | on | /19 | | | | | | | | | |
| …（6 回） | | | | | | | | | | | |

10 月 17 日の数値（判断 24/30、run 10a〜c）は比較のために並べてよいが、同じ表の行には混ぜない。条件（コミット、スキーマ、tick、間隔）を併記する。

## 5. 合格の目安と、決めるための判断

- 各回の E2E が 19/19（段階 3 の「委任解除後」の手順を含む）。
- モデルが送った行動のうち、finalized を個別に確認できた件数を数える（「送信」だけでは数えない）。
- 検証器が PASS。
- 厳密スキーマの既定値は、判断（正解数）・コードの拒否・費用・モデルが送った行動の数を、off と on で比べて決める。判断が下がるなら on にしない。拒否だけが減って判断が変わらないなら on を推奨する。

## 6. 片付けと共有

- llama-server を止める。`frontier-stack down` を全 run で済ませる。
- 共有するのは `.local/stage5/` の `transcript.json`、`report.md`／`report.json`、`finalized.json`、`verify.txt` だけ。`frontier-node/.local/frontier/<run>/relay/` と `keys/` は共有しない。
