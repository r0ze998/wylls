# ⑤：④の実物の登録簿への接続（2026-11-06）

起点は ⑤ `b21a9fa8`。④は GitHub の `claude/gallant-ride-cunptv` の `9568660675ad5464dcd2ce1a0f266f5a7dfb39cb`（`b82fafa8` で外からの入口、`95686606` で契約 §7）。④の依頼済みの「外部からの登録・照会口」は、もう届いていました。

## 1. 実物と代替（どちらを使ったかは、記録ごとに書く）

| | 実物（real） | 代替（substitute） |
|---|---|---|
| 作り | `fourActsPort`：④の `clients/acts.mjs` → `runexec act register\|status\|list`（④の run store、SQLite） | `localActsPort`：⑤の `acts-registry.mjs`（同じ契約のファイル版）＋ `fate-reader.mjs` |
| 使う時 | ④の `runexec` と client のパスが渡された時（`loadFourActsPort`） | それが無い時 |
| 受領証 | `connection: "real"`、`port: "④ runexec act (run store)"` | `connection: "substitute"`、`port: "⑤ local substitute …"` |
| 照会 | `status --gateway <port>`：④が財布の `GET /f/agent/fate` を一度読み、④の store に記録 | ⑤が同じ道を読み、⑤のファイルに記録 |

どちらも同じ形を返します：④の受領証（`p04-acts/0.1`）、`next`（`done`／`new-attempt`／`wait`／`hold`／`read-again`）、`newAttemptAllowed`。誤りも④の名前です（`BadRequest`・`NoRecord`・`Conflict`・`StoreError`・`Spawn`）。

## 2. ⑤の動き（④の §7.3 のとおり）

1. **送る前に登録する。** participate の `registerAct` で、`agent_act` の前に登録します。登録できなければ（`Conflict`・store が開けない・バイナリが無い）、その行動は**送りません**。次の回に、同じ requestId で登録からやり直します。
2. 送った後に、`status` を一度読みます（記録は登録簿に残ります）。
3. 次の回からは、`verifyPending` が登録簿の `status` で追います。
   - 新しい試行を許すのは、`newAttemptAllowed`（`not-sent`・`expired`）の時だけです。新しいキーで試します。
   - `unknown`（結果不明）は `hold` です。**時間がたっても、未実行とはみなしません。** 試験では、30日（代替）と5日（実物）、送り直さないことを確かめました。
   - `unqueryable`（照会不能）は `read-again` で、行動については何も言いません。
4. **登録の runId は、自動運転ごとに1つ**（`p05-autopilot:<agentId>`）にしました。回ごとの id は、⑤の journal に残ります。
   - 理由：登録の後、送る前にプロセスが落ちた場合、次の回は同じキーを別の回の id で登録します。④はそれを `Conflict` として拒否するので、その行動は永久に送れなくなります。試験（S2）で見つけました。
5. ③への答え（`status-query` 0.3）は、`connection`（real／substitute）と `registry` を返します。`registry` は次の3つを区別します。
   - `no-record`：登録が無い。④の `NoRecord`、⑬の `null`
   - `unreadable`：登録簿を読めない
   - `recorded`：記録がある。`next`・`validUntil`（ブロック高）・`signedAt`・`cancel`・`retention` も返す

## 3. ④の側で見つけた物

- **同じ新しいキーを、2つのプロセスが同時に登録すると、負けた方が `BadRequest`（`UNIQUE constraint failed`）になります。** ④の `register` は、読んでから書く形で、1つの取引になっていません。本当は、同じ `run4Id` が返るべきです。
  - 再現：4プロセス × 15キーを同時に登録すると、60回中3回が失敗しました。
  - ⑤の側の対応：この1種類の誤りに限って、1回だけ登録し直します（登録は冪等なので安全）。
  - ④への提案：`patches/for-ws04-95686606/0001-…patch`（`INSERT … ON CONFLICT DO NOTHING` の後、勝った行を既存の行と同じように比べる）。
  - 提案の確認：パッチを当てたバイナリで同じ試験を5回行い、300回の登録がすべて成功しました。④の `tests/acts.rs`（6件）と `tests/act_cli.rs`（5件）も通過しました。⑤は④のコードを変えていません。
- 影響は小さいです。⑤では、登録に失敗すると送らないので、二重送信にはなりません。1回分の回が無駄になるだけです。⑤のプロセスの lease があるので、1つの代理の登録が同時に起きることは通常ありません。

## 4. 試験

**鍵の生成・導出・署名を伴う物は実行していません。** 各試験ファイルとその共通の準備を読んでから実行しました。④の `runexec act` は、SQLite と 127.0.0.1 への GET だけを使い、送信も署名もしません（`main.rs` の `act` と `acts.rs` を読みました）。財布の `GET /f/agent/fate` は、Node の台本のサーバーです（④の財布と同じく chunked で答えます）。

| 試験 | 接続 | 結果 |
|---|---|---|
| `acts-runexec.test.mjs` X1〜X6 | **実物**（④ `95686606` の `runexec`、手元で offline でビルド、sha256 `0b5a13e7…`。④の `clients/acts.mjs`） | 6/6、3回 |
| 同じファイル、バイナリなし | 未接続 | 6件とも skip（理由を表示） |
| `acts-port.test.mjs` S1〜S4 | 代替 | 4/4 |
| 既存の鍵を使わない試験（model-api・http・relay-tree・multiprocess・longrun・acts-fate） | — | 38/38 |
| ④の `tests/acts.rs`・`tests/act_cli.rs`（⑤の提案パッチを当てた木で） | ④の試験 | 11/11 |

実物の試験の中身：
- X1：登録・照会・一覧、④の誤りのコード、`run4Id` が⑤の計算と一致すること
- X2：再起動。プロセスがすべて終わっても store が答える。確定した state は変わらず、食い違う読みは `conflict` として残る
- X3：複数のプロセス。4つが登録し、2つが同時に読む。1行ずつで、何も失われない
- X4：照会不能と結果不明の区別。閉じた port と 503 は `unqueryable` で、署名と寿命は残る。`unknown` は何度読んでも `hold`。証明された `expired` だけが `new-attempt`
- X5：同じ答えの台本で、代替と実物の答えが同じになること
- X6：participate を通しで動かす。回ごとに⑤を再起動する。送る前に登録されていること、結果不明を5日間送り直さないこと、`expired` の後に新しいキーで1回だけ送ること

実行していない物：自動運転の通しの試験（鍵を作る fixture を使う）、⑤の lease とあわせた自動運転の複数プロセスの試験（同じ理由）。本物の財布・鎖・モデルにはつないでいません。

## 5. まだつながっていない所

| 項目 | 状態 |
|---|---|
| ④の `runexec` のある場所 | ⑤の動く所に、ビルドした `runexec` と④の `clients/acts.mjs` が要ります。⑤の木には④のファイルが無いので、パスで渡します |
| 本物の財布 | `GET /f/agent/fate` があるのは、④の木の中継（＋⑤の共有パッチ）だけです。⑤の基準の中継には無いので、`status` は `unqueryable` になります（送りません） |
| RunReceipt の `from4` の欄 | ④の `toP05Act()` で埋められます。⑤の RunReceipt にはまだつないでいません。自動運転の記録（`rec.acts`）には、`run4Id`・`signedAt`・`validUntil` が入ります |
| `registeredSlot` | ⑤は slot を読まないので 0（④の既定値）です |
| 鍵を作る試験 | 実行していません |
