# ⑤：④の実登録簿・③・⑬への接続、資格情報の競合の解消、二重にならないことの確認（2026-11-06）

起点は ⑤ `e9d1551aa049f25c54fd6ebc24185d93a2d8ac4c`。

## 1. 今の最新版（この作業で照合した物）

| 担当 | commit | 場所 | ⑤との関係 |
|---|---|---|---|
| ④ | `8e96f24d`（`claude/gallant-ride-cunptv`） | GitHub | ⑤の同時登録の修正案を `b858e40d` として採用済み。`runexec` と `clients/acts.mjs` は 95686606 から変わっていない（`acts.rs` の修正と `act_cli` の試験だけ） |
| ③ | `acdcd0bf`（`preserve/ws03-mcp-acdcd0bf`） | GitHub | 2026-10-30 から更新なし。MCP の同意で `rotate-capability` を送る（`mcp/src/http.mjs:164`） |
| ⑬ | `de6df669`（`claude/eager-cerf-k74z5s`） | GitHub | ⑤ `e9d1551a` の費用台帳・lease・価格表を使っている |
| ⑤ | この作業の HEAD（報告に書く） | ローカルと包み | — |

## 2. ③との資格情報の競合（④と解消）

**問題：** 代理1つに capability は1つです。③の MCP の同意（`rotate-capability`）がその1つを回すので、⑤の自動運転の token が `BadCapability` になります。

**④の推奨：** `AUTH-ROUTES.ja.md` の A1（送り手ごとの capability）です。共有コアで、⑤が書き、④が統合する分担になっています。

**作った物（共有コードへの提案。⑤は直接当てていない）：**

| 物 | 中身 |
|---|---|
| `patches/on-ws04-8e96f24d/0004-0005-…patch`（④の木への提案） | 一般の token は今のまま（どの送り手にも使える）。そのほかに、所有者が送り手ごとの token（`ai`・`mcp`）を出せる。`rotate-capability` に `params.source` を付けると、その送り手の token だけを替える。`revoke-capability` は、その送り手の token だけを消す。送り手の token は、その source の要求にだけ通る。`whoami` は、どの token かを返す（`capabilitySource`）。view は送り手ごとの版だけを出す（hash は出さない）。A1 より前の記録も、そのまま動く。 |
| 同じパッチ | 0002b の作り直しを、seq を持つ命令（`SendCaravan`）には使わない（AUTH-ROUTES §4） |
| `patches/for-ws03-acdcd0bf/0001-…patch`（③への提案） | ③の同意の命令に `params: {source: 'mcp'}` を付ける。③のサーバーは、その命令と、`mcp` の token の答えだけを受け取る。A1 の無い中継では、今までどおり1つの token を回す |
| ⑤の `access-check.mjs` | `agent_whoami` が別の送り手の token（`mcp`）と答えたら、モデルを呼ぶ前に `OtherSendersToken` で止める |

**④の木で確かめたこと：**
- `agent-wallet-sender-capability.test.mjs`（4件、鍵なし）が通過しました。作り：記録は固定の文字列、所有者の命令は gateway を直接呼ぶ、代理は manual なので、どの要求も認証の後の門で止まります。
- 確かめた内容：
  - ③が同意をやり直しても、⑤の `ai` の token は通ります。
  - 送り手の token は、別の source の要求には `BadCapability` になります。
  - 一般の token を回しても、送り手の token は残ります。
  - 送り手の token を取り消すと、その送り手だけが止まります。
  - 保存した状態に token の値は入りません。
  - 再起動の後も、A1 より前の記録でも動きます。
- ④の `agent-wallet-run-facts`（3件）も通過しました。

**④が決めること：** 統合するかどうか。所有者のブラウザから、送り手ごとの token を出す画面（③の同意以外）。B1（Citizen ごとの一列）は、まだ作っていません。

**未確認：** ③の試験（所有者の署名で鍵を作る）は実行していません。③のパッチは、構文の確認だけです。

## 3. 二重にならないことの確認：自動運転を通しで、本物のプロセスで

`test/safety-e2e.test.mjs`（新規）。自動運転の全体（start → tick → participate → 行動）を子プロセスで動かします。プロセスを殺す、再起動する、2つ同時に起動する、所有者が止める、を行います。

| 場面 | 守る仕組み | 結果 |
|---|---|---|
| E1 中継は実行したが、答えが失われた（そのプロセスは3回とも答えを聞けない） | 同じ requestId の replay（中継の冪等） | 次のプロセスが replay して、実行は1回、モデルの呼び出しも1回 |
| E2 行動の途中でプロセスが殺された（中継は実行済み） | journal の act-begin → 同じ requestId で再開 | 実行は1回。死んだプロセスの lease は引き継ぎ |
| E3 モデルの呼び出し中に殺された | lease の回復：呼び出し中の費用は undecided | **未確定のまま、金額も残る**（解放もせず、0 にもしない）。次の判断は別の予約で、実行は1回 |
| E4 モデルの答えが失われた（送ったが返事が無い） | `unknown` → undecided | 何も送らない。再起動しても未確定の額は同じ |
| E5 2つのプロセスが同時に起動した | プロセスの lease | 1つだけが動き、もう1つは `AlreadyRunning`。実行は1回 |
| E6 モデルの答えの後、行動の前に所有者が止めた | 送る直前の観測の確認 | 何も送らない。呼び出しの費用は1回だけ確定。再開の後、新しい判断で1回だけ実行 |
| E7 答えが失われた行動の後、所有者が止めて再開した | 中継の順番（冪等の確認が門より先）＋同じ requestId | 再開しても送り直さない。実行は1回 |

すべての場面で、次も確かめています：呼び出しの鍵ごとに予約は1つ。終わった時に、予約中・呼び出し中の物が残っていない。

**実物と mock：**

| 部分 | この試験では |
|---|---|
| ⑤の自動運転・participate・費用の台帳・lease・journal | **実物**（⑤のコード） |
| 行動の登録簿 | ⑤の代替（既定）と、**④の実物**（`RUNEXEC_BIN`・`FOUR_ACTS_CLIENT` を渡した時。④ `8e96f24d` の `runexec` を offline でビルド、sha256 `da8755f6…`） |
| 中継の `agent_act` | **mock**（requestId ごとの冪等をファイルで持つ台本。中継のコードではない。中継の冪等は、中継自身と④の試験の範囲） |
| モデル | **mock**（⑤の fixture transport。実 AI は呼んでいない） |
| 世界・鎖 | **mock**（固定のデータ。鎖は使わない） |

## 4. ⑬との接続

- ⑬ `de6df669` の `test/ws05-cost.test.mjs` を、⑤の最新の木に向けて実行しました。⑬のガード（`--import ./test/keyless-guard.mjs`：node:crypto の鍵の関数を止める）を付けています。
- 結果：11件のうち10件が通過し、1件は⑫の checkout が要るので skip でした。通過した中には、④の実登録簿（④ `8e96f24d` の `runexec`）を使う試験が含まれます。
- ⑬が使う⑤の部品（`price-book`・`run-cost`・`cost-store`・`file-mutex`・`process-lease`）は、e9d1551a から変えていません。

## 5. 試験の一覧（鍵の生成・導出・署名を伴う物は実行していない。実 AI・有料 API なし）

各試験ファイルと共通の準備を読んでから実行しました。

| 試験 | 件数 | 結果 |
|---|---|---|
| ⑤ 既存（model-api・http・relay-tree・multiprocess・longrun・acts-fate・acts-port。acts-port に S5「別の送り手の token を止める」を追加） | 43 | 通過 |
| ⑤ `acts-runexec`（④の実物の登録簿） | 6 | 通過（④ 8e96f24d の runexec） |
| ⑤ `safety-e2e` E1〜E7、代替の登録簿 | 7 | 3回とも通過 |
| ⑤ `safety-e2e` E1〜E7、④の実物の登録簿 | 7 | 2回とも通過 |
| ④の木：`agent-wallet-sender-capability`（新）・`agent-wallet-run-facts` | 4＋3 | 通過 |
| ④ `8e96f24d` の `runexec` に同じキーを同時に登録（⑤の再試行なし） | 300回 | 失敗 0（④の修正が効いている） |
| ⑬ `ws05-cost.test.mjs`（⑤の最新に向けて、⑬のガード付き） | 11 | 10通過、1 skip |

## 6. まだ確かめていない・つながっていない所

| 項目 | 状態 |
|---|---|
| 送り手ごとの capability | 提案のパッチまで。④の統合と③の採用を待ちます。統合されるまでは、③の同意が⑤の token を無効にします。⑤はその時 `BadCapability` で止まり、所有者の再開を待ちます（今までどおり） |
| 本物の中継・財布・鎖 | 使っていません。`agent_act` の冪等は mock の台本です |
| 実 AI | 呼んでいません。費用は⑤の FIXTURE の価格です |
| 複数の機械 | ⑤の lease と台帳は1台の中だけです |
| ③の試験 | 実行していません（鍵を作る） |
| 結果不明をいつまで待つか | 未決のまま（⑤は待ち続けます） |
