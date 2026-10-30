# 同じ Citizen での競合：再現の試験と、既にある試験との対応表（④向け、2026-10-30）

**対象：** 1つの Citizen、1つの代理の上で動く3つの送り手です。
- ③の MCP（本人の操作）：**本物**（受領した `acdcd0bf` のサーバー）
- ⑤の自動運転：⑤のコード。モデルは 127.0.0.1 の HTTP fixture
- ④の実行器：**代役**。中継の `POST /f/agent/action` に、④の形のキー（`ws04:<run>:<attempt>`、`source: 'ai'`）で、③の隊商と同じ行動を送るだけです。④の Rust のコードは動かしていません

**鎖：** 試験用の偽物（scripted chain）で、program は動きません。そのため、隊商の番号（`CARAVANS`）を鎖が確かめる部分は再現できません。試験の中で「鎖が番号を進めた」ことを手で写しています（`w.state.caravans`）。

**token：** 今は、代理1つに capability が1つしかありません。3つの送り手が同時に動くには、同じ token を共有するしかありません。これは今の仕組みで支えられた使い方ではなく、試験の中だけで、③が受け取った token を写して使っています（`AUTH-OPTIONS-4.ja.md`）。

## 実行のしかた

```
WS03_MCP=<③の木>/workstreams/03-composability/mcp \
WS03_GATEWAY_ROOT=<0005→0002b→0001→0003 を当てた木>/permutation-gateway \
  node --test --test-timeout=60000 workstreams/05-ai-participation/model-api/integration/same-citizen-contention.test.mjs
```

環境変数が無いとスキップします。スキップは合格に数えません。共通の準備は `integration/ws03-harness.mjs` にあります。

## 新しく足した試験（`integration/same-citizen-contention.test.mjs`、6件、すべて通過）

| # | 場面 | 確かめる不変条件 |
|---|---|---|
| C1 | 試験用の価格で、中継の予算に2回分しか入らない時に、③・⑤・④が同時に送る | 中継の台帳は予算を超えない。冪等キーは記録に1回まで。価格付きの送信は2件まで。台帳の検査に不整合なし。⑤の推論の費用は⑤の台帳だけ（`d05-` のキー）で、中継の推論の計量は使わない。**観察：** 5回とも、④が⑤の考えている間に送ったので、⑤は `OwnerActed` で送らなかった（予算の拒否は起きなかった） |
| C1b | ③と⑤が先に予算を使い、その後で④が送る | ④は `BudgetExceeded` で断られる。何も保留されず、何も送られない。中継の使用額は 40,000 のまま。⑤の推論の台帳は別（単位：試験用 USDC） |
| C2 | ③が計画した後に、④が同じ番号の隊商を先に送る（鎖が番号を進めたことは手で写す） | ③は古い計画を `PlanStale` で断り、何も送らない。⑤は隊商を出さない（`NOT_FOR_AUTOPILOT`）ので、番号を取らない |
| C3 | ⑤のモデルが考えている間に、本人が `manual` にする | ⑤は送らない。推論の代金は払われ、戻らない。③と④は `AgentStopped`。`auto` に戻した後、古い epoch の要求は `StaleMode`、③の古い計画も断られる |
| C4 | ⑤だけを止めて、取り消す | ③と④は送り続けられる（中継の mode は `auto` のまま）。⑤の受領証の取消の段階は `Completed`（効果なし）で、根拠は「中継の `agent_act` の答えと `GET /f/tx`（④の run store ではない）」。止めた後は、モデルを呼ばない |
| C5 | ⑤のプロセスが止まっている間に③が送り、⑤が新しいプロセスで再開する | 新しいプロセスは、記録の run id の続き（`t2`）から始める。③の記録は新しい印より前なので、⑤は新しい観測で1回だけ送る。⑤の冪等キーは重ならない |

`integration/ws03-same-citizen.test.mjs`（前回の3件。capability の回転と順序の印）も、同じ準備で通ります。

## 既にある試験との対応表（重ねて作っていない物）

| 論点 | ④（Rust、模擬の正本） | ③（MCP、試験用の鎖） | ⑤ | 今回の C |
|---|---|---|---|---|
| 費用の二重予約 | `faults: fee_budget_is_bounded`、`right_units_are_reserved_across_runs` | 同じ requestId の重複（`duplicates: …`） | `staking: concurrent runs …`、`model-api: concurrent calls …`、`http: the same decision asked twice …` | C1・C1b（3つの送り手で、中継の台帳1つ） |
| 隊商の番号 | `faults: seq_taken_by_another_send`、`seq_taken_seen_in_entity_history`、`concurrency: second_run_of_an_owner_waits_for_the_seq`、`routes: executor_on_another_store_takes_the_seq` | `PlanStale`（`server.mjs:171`） | 隊商を送らない（`citizen: the autopilot never proposes SendCaravan …`） | C2（④が先に番号を取ると、③が断る） |
| 手動の優先 | `faults: cancel_*`（④の取消） | ③ owner の試験（失効・取消の後） | `participation: stopped or revoked …`、`staking: stopping the agent right after it started …` | C3（3つの送り手が同時に止まる） |
| 取消 | `faults: cancel_before_send`・`cancel_races_the_send_write`・`cancel_while_in_flight`・`cancel_in_transit_is_too_late`、`signed: …` | 接続の取消（`after a revocation: …`） | `staking: a stop in three stages …`、`citizen: ④'s names: cancel phases …`、`citizen: a stop or cancel never releases …` | C4（⑤だけが止まる） |
| 再起動 | `faults: stop_and_restart_at_every_point`、`restart_after_validity_ran_out`、`concurrency: zombie_executor_is_fenced` | `the relay answered but the MCP server never recorded it (crash) …` | `participation: restart in the middle …`、`staking: the executor restarts …`、`citizen: a restarted autopilot continues …` | C5（⑤の再起動の間に③が送る） |
| 未確定の費用 | `faults: indeterminate_is_held_then_resumed` | `outcome unknown …` | `staking: undecided money is never released …`、`model-api: a timeout after sending is undecided …` | C3（推論の代金は戻らない） |
| capability | — | `a capability sealed under another key …` | `citizen: the owner rotates the capability …`、`citizen: after a BadCapability stop …` | `ws03-same-citizen` 1・3 |

## ④がこの試験を使う時に置き換える所

- **④の代役（`fourStandIn`）** を、④の実行器の送信に置き換えます。④が中継の `submit` の後ろに入るなら、キーの形（`ws04:`）と `source` を④が決めます。
- **鎖の番号を手で写す所**（`w.state.caravans`）は、本物の program か④の模擬の正本で置き換えます。
- **token の共有**は、④が選ぶ認可の形（`AUTH-OPTIONS-4.ja.md` の B・C・D）に置き換えます。
