# ④への接続差分と不一致（受領した ③ `acdcd0bf`・④ `2e536b6b` と照合、2026-10-30）

**統合の担当は④です。** 共有ファイル（`permutation-gateway/` など）は、⑤の側だけでは確定させていません。下のパッチはどれも未適用で、⑤のブランチ（`9f1209c4` 以降）は共有コードを変えていません。決めるのは④です。

**区別：** 「確認済み」は、受け取ったコードを使い捨ての worktree で動かして確かめたものです（試験用の鎖、MOCK）。「文書から」は、④・③の文書を読んだだけのものです。どれも本番の鎖・本番のモデル・本番の課金では確かめていません。

## 1. 共有コードのパッチの組み合わせ（確認済み）

対象：⑤ 0001（細かい上限）・0002（同じバイト列の作り直し）・0003（MCP の `source`）と、③ 0005（SendCaravan を代理人の行動に）。

| 組み合わせ（順に当てる） | 結果 |
|---|---|
| 0001 ↔ 0005 | どちらの順でも当たる |
| 0003 ↔ 0005 | 当たる |
| **0002 ↔ 0005** | **文字の上で衝突する**（`gateway.mjs` の `#build`：0005 は `accountsFor(…)` の行に `route` を足し、0002 はその次の `feePayer` の行を変える）。意味は独立 |
| 0005 → **0002b** → 0001 → 0003 | 当たる。`0002b` は 0002 を 0005 の上に作り直した物（両方の変更を残しただけ）：`patches/0002b-…-on-top-of-ws03-0005.patch` |

**4つを当てた状態での試験：**

| 試験 | 結果 |
|---|---|
| `permutation-gateway` の全体 | 2,543 件、通過 2,542、失敗 0、スキップ 1（Gemma のモデルファイルがない） |
| `agent-wallet-*`・`frontier-relay*` | 111/111（③が報告した 0005 単独の 102 件に、⑤の新しい試験 9 件） |
| ③の MCP の試験（`WS03_GATEWAY_ROOT` で指定） | 42 件：通過 40、失敗 1、スキップ 1。0005 だけの時と同じ。失敗は `sdk-client.test.mjs` で、依存の `@modelcontextprotocol/sdk` が無いため |
| ⑤の試験 | ⑤ 37/37、model-api 45/45、③との統合 3/3 |

**④に決めてほしいこと：**
1. 0005 を採るなら、0002 か 0002b のどちらを使うか。
2. 当てる順。
3. 0002 の直し方そのもの（支払い者を避ける。別の案：命令に区別の欄を足す）。

## 2. 同じ Citizen での ③（本人の MCP）と⑤（自動運転）：受領したコードで見つけた不一致

| # | 不一致 | 確かめ方 | 影響 | 提案（④・共有コアの判断） |
|---|---|---|---|---|
| **2.1** | **代理1つに capability は1つだけ。** ③の接続の同意（caravan のスコープ）で、本人が `rotate-capability` に署名する。そうすると、⑤が持っていた token は `BadCapability` になる。逆に、本人が⑤のために回すと、③が封印した token が使えなくなる | 統合試験 1・3（③の本物のサーバー） | session が Citizen に1つなので、別の代理にも分けられない（2つ目の代理の鍵は session になれない）。**今のままでは、③と⑤は同じ Citizen で同時に書き込めない** | 共有コアの変更：代理に、送り手ごとの capability（`source` に結びつけ、別々に取り消せる）を持たせる。それまでは「どちらか一方」を本人が選ぶ |
| 2.2 | `agent_view` は公開の読み取りで、capability を確かめない。回された後も「auto・委任あり」と見え、⑤の事前確認では分からない | 統合試験 1、⑤の試験 | ⑤が、送れない操作のためにモデルの代金を払い続けうる | ⑤の側で直した：`BadCapability` が返ったら自動運転を止める。再開には、本人が渡す新しい token が要る。共有側の案：capability を確かめる読み取り（例：`agent_whoami`） |
| 2.3 | 送り手の記録：③の文書は「runner は `ai`」と書く。しかし⑤の自動運転は `agent-mcp.mjs` を通るので、今は `mcp` と記録される（③と同じ）。区別できるのは冪等キーだけ（③ `ws03:`、⑤ `mcp:p05.`） | ⑤の試験・統合試験 2 | 中継の記録の `source` だけでは、③と⑤を分けられない | パッチ 0003：⑤は `source: 'ai'`（キー `ai:p05.…`） |
| 2.4 | 順序：③が⑤の観測と送信の間に送ると、⑤の判断は古い観測に基づく | 統合試験 2（③の本物の `send_caravan` を、⑤のモデルが考えている間に） | — | ⑤の側で実装：観測の時の `historySeq` を印にし、印の後に `ws03:` などの記録があれば、その回は送らない（`OwnerActed`）。次の回に送る。③の側の約束（③も印を尊重するか）は③の判断 |
| 2.5 | mode は1つで全員に効く（③ 11 §3.3-1）。`manual` は③の送付も止める | 文書から（③） | 本人が会話で送る間だけ⑤を止める手段がない | ⑤の自動運転の停止（`Autopilot.stop`）は⑤だけを止め、③は止めない。中継の mode を送り手ごとに分けるかは共有コアの判断 |

## 3. ④の契約と⑤の対応

| ④の契約（文書） | ⑤の今 | 一致 | 不一致・決めてほしいこと |
|---|---|---|---|
| **AI が作れるのは `RunSpec` だけ**（CONTRACTS §6.1）。自動では、自分の場所の間の送付だけ | ⑤の自動運転は、代理人の行動（`economy` 群：Train など）を、既存の MCP `agent_act` で送る。隊商（SendCaravan）は送らない（`NOT_FOR_AUTOPILOT`） | 隊商を送らない点は一致 | **⑤の Train などは④の Run の外にある。** ④の Run（物流）に、代理人の1回の行動を入れるか。入れないなら、⑤の行動の受領証（RunReceipt の port）を④の Receipt とどう並べるか |
| Receipt の `kind`：`facility_used`・`caravan_*` | ⑤の port は、自動運転の1回ごとに `acts[]`（Train など）を持つ | — | ④の Receipt に、代理人の行動の種類（例：`agent_action`）を足すか。⑤の port の欄（`RECEIPT_FIELDS`）を④の Receipt の `body` にどう写すか |
| 費用の4区分 `reserved`・`charged`・`unconfirmed`・`released`（§6.2）。**relay の手数料（lamports）、attempt ごと** | ⑤の推論の費用は `reserved`・`settled`・`undecided`・`released`（試験用 USDC）。④の名前での見方（`fourClasses()`、受領証の `inferenceIn4Names`）を足した | 意味は一致（`settled`＝`charged`、`undecided`＝`unconfirmed`）。「期限だけで未課金としない」「0 としない」も同じ | **単位と対象が違う。** 足し合わせない。④の `max_fee`（lamports）と⑤の予算（試験用 USDC）の関係。lamports を予算に換算するかは⑤の判断と書かれているが、⑤は換算していない（運営が払う手数料で、本人の予算から引いていない） |
| 取消の3段階 `StoppingNew` → `AwaitingSigned{until}` → `Completed{effects}`、`Ineffective{at}` | ⑤の port は同じ名前で段階を出す（`cancelPhase`）。`until` は null | 段階の名前と意味は一致 | `until`（`valid_until`）を中継が返さない（③-R3）。④が中継から受け取る形 |
| `Absent` の条件（全履歴・完全・確定。③-R4） | ⑤は署名の結果を `GET /f/tx` で読むだけで、`Absent` を自分では判断しない。分からなければ `unknown` | 一致（⑤は不在と言わない） | — |
| 到着量の未検証（`DeliveredUnverified`）：0 でも全損でもない | ⑤は隊商を送らないので、到着量を数えない | 一致 | ⑤が隊商を使うのは、④の到着量の状態を読めるようになってから |
| 署名済みの要求は、store では止められない | ⑤は送り直さない。止めると、新しい判断と送信だけが止まる | 一致 | — |
| ④の実行器は session key で署名する（P5 `prepare`）。同じ owner の送信が飛んでいないこと（`sole_owner_send`） | session key は⑤の中継の keyring にある。③も⑤も、同じ中継で同じ session key を使う | — | **④の実行器が別の場所で session key を持つと、Citizen の1枠を③⑤と取り合う。** `sole_owner_send` は④の store の中だけの条件で、③の送付（中継経由）は見えない。④の実行器を中継の `submit` の後ろに置くか、中継の記録（`historySeq`）を④も見るか |

## 4. ⑤が④に渡す物

- `src/run-receipt.mjs`：⑤が読む欄（`RECEIPT_FIELDS`）と、④だけが出せる欄（`run4Id`、`acts[].signedAt`、`acts[].cancellable`、`cancel.stage`、`cancel.until`）
- `src/run-receipt.conformance.mjs`：④の実装もかけられる適合の確認
- `src/citizen-boundary.mjs`：seq の印と、本人の取り分の規則（⑤の側だけ）
- `integration/ws03-same-citizen.test.mjs`：③の本物のサーバーとの試験（受領した③の木と、0005 を当てた中継の木を環境変数で指定）
- パッチ：`patches/0001`、`0002`、`0002b`、`0003`（未適用）

## 5. まだ⑤の側にない物

- ④の Run・Receipt・取消を実際に呼ぶ口（④は Rust の実行器で、⑤の JavaScript から呼ぶ方法（HTTP、プロセス、ファイル）が決まっていない）
- （④の `cargo test` は、使い捨ての clone で 62 件すべて通過した。`RECEIVED-2026-10-30.ja.md`）
- ③の側の約束（§2.4）と、capability の分け方（§2.1）
