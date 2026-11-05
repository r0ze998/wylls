# ⑤：④の Run との接続、複数プロセスでの予算の二重消費の防止、③への状態の答え（2026-11-05）

起点は ⑤ `711d6c49`。④は GitHub の `preserve/ws04-a967f5f1`（`a967f5f1c64facc32facf07010f39a679c77d80a`）を読みました（読んだだけで、④のコードは実行していません）。

## 1. ④ `a967f5f1` に入った共有の修正（重ねないため）

| 確認 | 結果 |
|---|---|
| ④の木の `permutation-gateway` | `f324e1eb195ab8e036d2dee066d8d1be20798fe1` |
| 中身 | 基準（`560f8659…`）＋ ③ 0005 ＋ ⑤ 0001 と**ファイルごとに同じバイト列**（`gateway.mjs`・`contract.mjs`・`ledger.mjs`・`policy.mjs` と2つの試験） |
| ⑤のパッチで④の木に**入っていない**物 | 0002b（同じバイト列の作り直し）、0003（MCP の `source`）、0004（`agent_whoami`） |
| ④の木への当て方 | **0001 は当てない**（もう入っている）。0002b → 0003 → 0004 の順で当たる。当てた後の `permutation-gateway` は `ff2efb1f3ea705559214f5da1fb4306dc4d6e07a`（以前に試した5つの組み合わせと同じ木） |

## 2. ④の Run との接続

**④にある物（`a967f5f1`、読んだだけ）：**
- 実行器（Rust）：run store（SQLite）、取消・再開。外の担当が Run を登録する口は無い。命令は `runexec demo|status|show|cancel|resume`
- `bridge/agent-gateway-bridge.mjs`：④の実行器が、agent wallet の中継の `POST /f/agent/action` を通って送るための**試験用の橋**。鎖は試験用の偽物で、送るのは SendCaravan だけ。試験の鍵をメモリの中で作り、中継が署名する

**⑤との関係：**
- ⑤の自動運転も、④の Run も、**同じ中継の `POST /f/agent/action`** で送る。中継の台帳・予算・冪等の記録は1つで、両方に効く。
- **⑤の Run を④の store に登録する口は無い。** ⑤の自動運転の行動（Train など）は、④の `RunSpec`（物流）では表せない。④の契約の §6.1 には「AI が作れるのは `RunSpec` だけ」とある。

**つなぐのに④が決める・出す物：**

| 欄・口 | ⑤の今 | ④に必要な物 |
|---|---|---|
| Run の登録 | 無い（⑤は中継へ直接） | 外から Run を登録する口（ライブラリ・HTTP・ファイルのどれか）と、その冪等のキー |
| ⑤の行動の表し方 | Train などの代理の行動 | ④の Run に代理の行動を入れるか。入れないなら、⑤の受領証をどう並べるか（**製品の判断**。下の §6） |
| 署名と有効期限 | 署名は中継の答えから。`valid_until` は **null**（中継は `lastValidBlockHeight` を記録するが、`agent_view` の holds に出さない） | 中継（または④の store）が `valid_until` を返すこと（③-R3） |
| 確定度 | 中継の `GET /f/tx` は `landed` を confirmed と finalized で区別しない | `finalized` かどうかを返すこと |
| 照会不能・不在 | 中継の `expired` は、confirmed の高さだけで判断していて、④の `Absent` の条件（finalized・全履歴）を満たさない | ④の `status(sig)`（③-R4）を、⑤から読む口 |
| 手数料 | 中継が記録するが、⑤からは読めない | `Landed{fee}`・`Failed{fee}` の fee を返すこと |
| 取消の段階 | ⑤は④の3段階の名前で出す。根拠は中継の記録 | ④の `CancelPhase` を読む口 |
| 1つの代理に1つの実行者 | ⑤はプロセスの lease（§3）。④は store の lease と epoch の fencing を持つ（`concurrency` の試験） | 統合する時、⑤の lease を④の store の lease に置き換えるか |

## 3. 複数プロセスでの予算の二重消費の防止（実装した。⑤のコードだけ）

| 部品 | 中身 |
|---|---|
| `src/file-mutex.mjs` | プロセスの間の mutex（`wx` で作るファイル、持ち主の pid。持ち主が死んでいるか古ければ引き継ぐ。中継の `agent/lock.mjs` と同じ規則）と、途中で切れない書き込み（fsync してから rename） |
| `src/process-lease.mjs` | **代理ごとに1つの自動運転（プロセスをまたいで）**。生きている lease（プロセスが生きていて、heartbeat が新しい）があれば `AlreadyRunning`。死んだプロセスや、heartbeat が TTL より古い（止まった）プロセスの lease は、次の epoch で引き継ぐ |
| `src/cost-store.mjs` | **プロセスの間で共有する費用の台帳**。予約・確定・解放・未確定を、ファイルの mutex の中で1つの取引として行う。予約には持ち主（lease）を記録し、lease が自分の物でなければ予約しない（`LeaseLost`）。持ち主が死んだ項目は、呼び出し中なら「未確定」（解放しない、0 にしない）、呼ぶ前なら「解放」 |
| `src/autopilot.mjs` | lease を使う時：開始で取り、死んだ持ち主の項目を回復する。回ごとに更新し、他のプロセスに引き継がれていたら止まる（`stopped-lease-lost`）。**行動の直前にも lease を確かめる**（長い回の途中で引き継がれた時に、送らない） |
| `src/run-cost.mjs` | `fromJSON` に `applyRestart` を足した（共有の台帳を読み直す時は、再起動の規則を当てない） |

**守れないこと：**
- 別の機械のプロセスは見えません。同じファイルシステムだけです。複数の機械には、④の run store のような共有の store が要ります。
- 止まったプロセスが、引き継がれる前に始めていたモデルの呼び出しは、止められません。その費用は「未確定」として残ります。
- 中継がもう受け付けた送信も止められません。中継の冪等の記録で、同じ requestId は1回だけになります。
- lease の TTL は、1回の判断（モデルの時間切れ＋行動）より長くする必要があります。短すぎると、生きているプロセスが引き継がれます（その場合も、行動の直前の確認で送りません）。

## 4. ③への状態の答え（`src/status-query.mjs`）

④の言葉（Landed／Failed／Pending／Absent／Unavailable）で、⑤の記録（journal）と中継の `GET /f/tx` から答えます。**中継が示せる以上のことは言いません。**

| 中継・記録 | ⑤の答え |
|---|---|
| 中継が断った（送っていない） | `submission: refused`（コード付き）、鎖の照会なし、終わり |
| 始めたが中継の答えが分からない | `submission: begun-unknown`、`Unavailable`、終わりではない（次の回に同じ requestId で中継が再生する） |
| `landed`・`failed` | `Landed`・`Failed`。確定度は「confirmed か finalized か区別されない」。終わりとは言わない |
| `expired` | **`Unavailable`**（`Absent` ではない）。費用は保留のまま |
| `unknown`・答えなし | `Unavailable`（まだ着地しうる） |
| `valid_until` | 常に **null**（理由付き） |

`Absent` は、中継の答えからは決して出しません（試験で確かめた）。token の値は答えに入りません。

## 5. 試験

**鍵を作る・導出する・署名する試験の扱い：**
- この回の指示では、それを伴う試験は行いません。⑤の試験のうち、ローカルの中継の fixture を使う物（`createLocalWorld`、③の試験の世界）は、試験の鍵をメモリの中で作り、中継が署名します。
- それらの試験は、この回の最初（指示との関係に気づく前）に一度実行しました。結果はすべて通過でしたが、**この回の合格の根拠には数えません。**
- 以後は実行していません。

| 試験 | 鍵 | この回の結果 |
|---|---|---|
| `test/model-api.test.mjs`（11） | なし | 通過 |
| `test/http.test.mjs`（12） | なし | 通過 |
| `test/relay-tree.test.mjs`（1） | なし | 通過 |
| `test/multiprocess.test.mjs`（5：P1〜P4、P6） | なし（中継も鎖も無い。子プロセスと共有ファイルだけ） | 通過（3回連続、その前に5回） |
| `test/continuing.test.mjs` の T5（長く動いた時の状態） | なし | 通過 |
| `test/multiprocess-world.test.mjs`（P5、P7）、`autopilot`・`citizen`・`continuing`（T1〜T4）、⑤の `participation`・`staking`、`integration/*` | **あり**（fixture の試験の鍵、中継の署名） | この回の根拠にしない（上のとおり、最初に一度だけ通過） |

## 6. 製品の判断が要る点

- **⑤の自動運転の行動（Train などの代理の行動）を、④の Run として扱うか。**
  - ④の契約の §6.1 は、AI が作れるのを `RunSpec`（物流）だけとしています。
  - ⑤の自動運転は、物流（隊商）を送りません（到着量を検証できないことがあるため）。
  - 次のどれかを、決めてほしいです。
    - (a) ④の Run を代理の行動まで広げる
    - (b) ⑤の行動は Run の外に置き、⑤の受領証と④の Receipt を並べて見せる
    - (c) ⑤の自動運転にも物流を任せ、④の Run に一本化する
