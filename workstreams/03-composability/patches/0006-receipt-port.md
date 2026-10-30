# 0006 ④ の実行台帳とつなぐ口（提案。未確定・未適用）

**状態（2026-10-30 更新）：** ③の側は採用して実装した（`mcp/src/receipt-port.mjs`、適合試験 `mcp/test/port-conformance.mjs`、[13](../13-runreceipt-port.ja.md)）。④との契約は未確定のまま。

**最初の状態：** ④の成果（`2e536b6b`、前回の報告は `bd415e7`）を受け取っていないので、契約は確定しない。これは③が④に**渡せる**形と、③の側で差し替える場所だけを示す。今回、共通部分（`permutation-gateway` など、③の外）のコードは変えていない。

## ③の側で差し替える場所（`workstreams/03-composability/mcp/src/`）

| 今の MOCK | 役割 | ④の契約が来たら |
|---|---|---|
| `ports.mjs` `receiptOf(op)` | 操作の状態を受領証の形にする（`wylls.mock-run-receipt/0`） | ④の受領証を返す（③は自分の形を作らない） |
| `ports.mjs` `cancellationOf(link, ops)` | 取消の 3 区分（新規要求の停止、照合待ち、完了） | ④の取消状態を読む |
| `server.mjs` `arrivalOf(op)` | 輸送の終わりと到着量（`unverified` / `none`）を分ける | ④の「到着量の未検証」の状態を読む |
| `server.mjs` `track(op)` / `evidence(op)` | チェーンと herald から状態を進める（問い合わせのたびに） | ④が状態を進めるなら、③は照会するだけにする |
| `server.mjs` `ownerOperations(owner)` | 取消の後の所有者の照会（署名つき） | ④の照会の API に、所有者の確認（署名）を付けて渡す |

## ③が④に渡せるもの（今ある値）

| 値 | 中身 |
|---|---|
| `operationId` | `op_` + SHA-256(linkId, requestId) の先頭 |
| `idempotencyKey` | `ws03:<linkId>:<requestId>`（⑤の gateway の冪等キーと同じ） |
| `source` | `mcp` |
| `owner`、`agentId` | 接続（link）の所有者と代理人 |
| `plan` | 出発、宛先、積荷（送った量）、歩数、`seq` |
| `attempts`、`unknownSince` | 試行の数（送る前にストアに書く）、結果不明になった時刻 |
| `gateway` | ⑤の ActionResult の写し（`status`、`signature`、`charges`） |
| `hold` | `CapabilityUnavailable` など、③が送れない理由 |

## ④に決めてほしいこと（③は推測で決めない）

1. 受領証の状態名と遷移。③の `hold`（送れない保留）をどう表すか。
2. 取消の 3 区分の名前。照合待ちを誰が終端まで進めるか（④か③か）。
3. 到着量の検証のしかた（倉庫は容量で切られる。村は生産と重なる）。検証できない時の表し方。
4. 費用の 4 区分（予約・確定・未確定・解放）と、③の接続の上限（確保・消費・解放）との関係。③は費用を持たない。
5. 照会の認証。所有者の署名（③の `/owner` と同じ形）を④の照会に使うか。
6. 識別子の規則。③の `operationId` をそのまま使うか、④が付け直すか。

## 必要なファイル（未受領）

- ④ `2e536b6b`：RunReceipt の契約の文書かスキーマ、取消・照合・到着量の状態を扱うコードと試験。
- ⑤ `ba3c180b`：パッチ 0001 の本体と、それが変える `permutation-gateway/src/frontier/agent/` のファイル（③のパッチ 0005 との照合のため）。
