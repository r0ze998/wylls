# 13 RunReceipt port、取消・照会・到着量、⑤との予算境界

作業日 2026-10-30。ブランチ `ws03/runreceipt-port`（ローカルだけ）。起点は `acdcd0bf`（tag `ws03-v4`）。`47b05ac6`（tag `ws03-handoff-v2`）と保存パッケージ v1〜v4 はそのまま残している。

**fixture と④の本物の契約を混同しない。** この文書で「MOCK」と書くものは、③が自分の追跡を仮の形で出しているものである。④の契約ではない。④の成果物はまだ受け取っていない（§5）。

## 1. 最初に通すもの：読取と本人の場所の間の隊商

| 段階 | 経路 | 確かめたこと |
|---|---|---|
| 読取（村、倉庫、道中、⑤の予算） | `get_village_status`、`check_resource_shortfall` | 実チェーン（season 97） |
| 本人の場所の間の隊商 | `prepare_caravan` → `send_caravan` → `get_operation_status` | 実チェーン（隊商 2 本、`completed`／`delivered`、量は `unverified`） |
| 取消の後の照会 | `/owner`（所有者のウォレットの署名） | 実チェーン（取消は `done`） |
| 他人宛て | ③は `NotYourPlace` で断る。プログラムも session なら `WalletRequired` で断る | 模擬（③）とソース（`caravan.rs:727`）。**財布で承認する経路は省略していない。作ってもいない** |

## 2. RunReceipt port（パッチ 0006 の採否）

**採用：③の側の口として。** ④との契約は未確定のまま。

- `src/receipt-port.mjs`：port は `{contract, real, receipt(op), cancellation(link, ops), arrival(op)}`。
  - 今あるのは `LocalReceiptPort` だけ。③自身の追跡で、`contract: wylls.mock-run-receipt/0`、`real: false`。
  - 取消・到着量の扱いも port の中にある（`arrivalOf` を `server.mjs` から移した）。
- **取り違えの防止：**
  - `real: false` の port は、契約名に mock を含まなければ起動しない（`assertReceiptPort`）。fixture が④の物に見えることはない。
  - `WYLLS_MCP_RECEIPT_PORT` に `local` 以外を指定すると、起動の時に失敗する。④の adapter がこの build に無いため。黙って MOCK に戻ることはしない。
  - 起動時のログに port の契約名と、MOCK であることを出す。
- **適合試験：** `test/port-conformance.mjs` の `portConformance(port)`。④の adapter も同じ試験を通すこと。
  - 受領証が操作を名指すこと。終端の判定。
  - MOCK かどうかの表示。
  - 送付は到着ではないこと（道中に `arrival` が無い）。
  - 届いた量は、検証済みでない限り `unverified` で、`received` を名乗らない。lost は `none`。
  - 生きている接続に取消は無い。取り消した接続は `newRequests: stopped` と照合待ちの一覧を持ち、`reconciling` から `done` に進む。
  - 保留（`hold`）が見えること。
- **server：** 受領証・取消・到着量は、すべて port を通して出す（`createWyllsMcp({receipts})`）。

## 3. ⑤との予算境界

`src/budget-port.mjs`：

- `budgetOf(view)`：⑤の `GET /f/agent` の値をそのまま見せる（`owner: '⑤'`）。③は計算せず、台帳・保留・価格表を持たない。
- `FIVE_REFUSALS`：`POST /f/agent/action` が返しうる⑤の拒否コード 19 個。それぞれに、誰の判断か（`⑤` か `chain`）、種類（budget、policy、mode、delegation、request、agent）、同じ requestId で再送してよいか、次の手を付ける。
  - 拒否した操作の `error.boundary` に載せる（試験：`ActionNotAllowed` は `⑤`／`policy`）。
- **試験で⑤のコードと照合する：** gateway の `ERR` にある 27 個すべてが、`FIVE_REFUSALS` か「action からは返らない」一覧（`FIVE_NOT_FROM_ACTIONS`、8 個）のどちらかに入ること。⑤がコードを改名・追加すると、試験が落ちる。知らないコードは `unknown` として出し、推測しない。
- 残高の補充（入金）はツールにしない（`InsufficientBalance` の次の手は「代理人ページでウォレットが署名する送金。ツールではない」）。

**同時に動いた時の責任**（11 §3.1 のまま）：

| 担当 | 守るもの |
|---|---|
| チェーン | 隊商の通し番号と村の資源 |
| ⑤ | 予算（1 プロセス、同期の保留） |
| ③ | 接続の上限（② MOCK）と、自分の操作の記録 |

mode を送り手ごとに分けるかは、⑤の判断として残る。

## 4. パッチ 0005 と⑤の 0001 の衝突

**⑤の 0001 を受け取っていないので、照合していない。** 0005 がこの repo の HEAD に今もきれいに当たることは確かめた（一時 worktree で `git apply`。gateway の試験は 102/102）。

⑤の 0001 と重なりうる場所（0005 の hunk）:

| ファイル | 場所 | 0005 の変更 |
|---|---|---|
| `permutation-gateway/src/frontier/agent/contract.mjs` | `ACTION_GROUPS`（32 行付近） | `transport: ['SendCaravan']` を足す |
| 同上 | `parseActionRequest`（113 行付近） | `action.route` を読み、`parseRoute` を足す |
| `permutation-gateway/src/frontier/agent/gateway.mjs` | import（28 行付近） | S1 の v2 の seed tag と `place` の符号化を足す |
| 同上 | `accountsFor`（64 行・76 行付近） | 引数に `route` を足し、`SendCaravan` の口座の並びを足す |
| 同上 | `#build`（482 行付近） | `route` を `accountsFor` に渡す |
| `permutation-gateway/test/agent-wallet-sendcaravan.test.mjs` | 新規 | 試験 5 件 |

⑤の 0001 が同じ場所（特に `ACTION_GROUPS`、`parseActionRequest`、`accountsFor`）を変えていれば、手で合わせる必要がある。確かめる点：

- SendCaravan をどの群に入れるか（既定で許すか）。
- `action.route` の形。
- seed tag の出所（v1 と v2）。
- 宛先の持ち主の検査を gateway でもするか。今の 0005 はプログラムに任せている（`WalletRequired`）。
- runner の候補に入れるか。
- 価格表。

## 5. ④⑤の資料：必要なファイルとフィールド

2026-10-30 に確かめた。
- `git fetch origin <sha>`："couldn't find remote ref"。
- GitHub：commit の照会は "No commit found"、commit の検索は 0 件。
- ブランチの一覧（79）に該当なし。`feature/agent-wallet` は 10 月 16〜17 日の古い⑤で、手元の tree に含まれる。

### ④ `2e536b6b`（前回は `bd415e7`）

- **ファイル：** RunReceipt の契約の文書かスキーマ（JSON Schema か TypeScript の型）。照会の API（HTTP の経路と認証）。取消・照合・到着量を扱うコードと試験。
- **フィールド：**
  - 操作の識別子と、その生成規則（③の `requestId`・`idempotencyKey` との対応）。
  - 状態の列挙と遷移。保留（③の `hold: CapabilityUnavailable`）の表し方。
  - 取消の 3 区分の名前。照合待ちの一覧。照合を終端まで進める主体。
  - 到着量：検証済み・未検証・なしの表し方。量（資源ごと）と、検証の根拠。
  - 費用の 4 区分（予約・確定・未確定・解放）の値と単位。⑤の `charges` との対応。
  - 照会の認証（所有者の署名か、別の方法か）。
  - 契約の版の名前。③の `real: true` の adapter が名乗る名前。

### ⑤ `ba3c180b`

- **ファイル：** パッチ 0001 の本体。それが変える `permutation-gateway/src/frontier/agent/contract.mjs`、`gateway.mjs`、`runner.mjs`、`ledger.mjs`（該当するもの）と、その試験。AI staking の文書。
- **フィールド：**
  - `ACTION_GROUPS` と `NEVER_DELEGATED`。
  - `ERR`（追加・改名。③の試験が照合する）。
  - `GET /f/agent` の `balance`、`policy.budget`、`day`、`quota`、`mode`、`modeEpoch`、`delegation` の形。
  - `POST /f/agent/action` の要求（`action.route` を含むか）と応答（`status`、`charges`、`error.code`）。
  - mode を送り手ごとに分けるか（`source: mcp` と `ai`）。

## 6. 共有コードと④向けのパッチ

**今回、共有コード（③の外）は変えていない。** port、境界、試験はすべて `workstreams/03-composability/mcp/` の中にある。④向けに渡せるもの：

- 口と適合試験：`src/receipt-port.mjs` と `test/port-conformance.mjs`。④の adapter は `portConformance` を通せばよい。
- ③が渡す値と、④に決めてほしいこと：[patches/0006](patches/0006-receipt-port.md)（採用。③の側は実装済み）。
- ④の照会を共通の場所（たとえば `permutation-gateway`）に置く場合、その変更は④の契約を見てから④向けのパッチにする。今は作らない（推測になる）。

## 7. 試験の結果（2026-10-30、この作業機）

| 試験 | 結果 |
|---|---|
| MCP（パッチ無し） | 48 件：27 通過・21 省略・0 失敗 |
| MCP（パッチ 0005 を当てた gateway） | 48 件：47 通過・1 省略・0 失敗 |
| 追加した試験（6 件） | port の適合（local）、④の adapter を求めると失敗する・MOCK が④を名乗れない、server が port を通して答える、⑤のコードの照合、⑤の予算の表示、⑤の拒否が持ち主つきで届く |
| ローカルの実チェーン E2E | **PASS、14 記録点（season 97）**。port に移した後に再実行した |

## 8. 止まっていること（承認の手前）

- 実機の OAuth 登録（Claude Code、ChatGPT、Claude の hosted）、ウォレットの署名、アカウント・公開・費用を伴う操作は行っていない。手順と承認の項目は 12 §5。
- ④⑤の成果物が無いので、④の adapter（`real: true`）と、0005 と⑤の 0001 の照合は作業できない。具体的に要る物は §5。
