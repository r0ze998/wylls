# 21 権限の発行・更新・取消、⑥の実行 ID（③：MCP）

作業日 2026-11-06。親 `7923f900060208ed340ea59b322e7e18bef21999`、branch `ws03/runreceipt-port`（ローカルだけ、push していない）。**この回の試験は、すべて鍵を使わない物である**（20 §0）。

## 0. 使った版

| 担当 | 版 | 状態 |
|---|---|---|
| ④ | `d0e96d5394d88decf878676f37bc3782654d1045`（GitHub `claude/gallant-ride-cunptv`、統合候補 2026-11-06b の公開版） | 取得した |
| ⑤ | `276a392b00a5981f09f5c921befc7a69e5fb04f4` | **取得できなかった**。この clone、origin、upload のどれにも無い。④の文書には「delivery ws05-276a392b、利用者宛ての包み」とある。代わりに `e9d1551a`（前回の包み）と、④が伝えた 276a392b の前提を使った |
| ⑥ | `517796dce6dec5c1496775d73ad84a0cb8befa09`（`preserve/ws06-creation-517796dc`） | 読んだ。⑥の実行は⑥自身の模擬（計画のハッシュ、使い捨て番号、通し番号）である。④の Run にはまだつながっていない（④ INTEGRATION-20261106b §2） |

**財布の木：** ④ `d0e96d53` ＋⑤の共有パッチ 3 件 ＋③ 0008 ＋③ 0008b。

- `permutation-gateway` の tree は `a75a802c02cd7a89fa55852dc9dd7f2dce6af1e4`。
- 隔離した worktree の commit は `f16eaa784ab191afe04c441e65c1b546f264ab00`。
- ⑤の 0004b は `app.mjs` で④の residents の道とぶつかった。両方の道を残して解いた。

**④の runexec：** `d0e96d53` を `cargo build --locked` でビルドした（sha256 `4983898d…`）。④の `cargo test --test acts --test act_cli` は 12/12。

## 1. whoami の契約を一つに（0008b）

`patches/0008b-agent-wallet-capability-whoami-contract.patch`（sha256 `9a1a4a95…`、0008 の上に当てる）。

- `whoami` は `capabilitySource`（結び付いた送り手。送り手を区別しない token なら `null`）と、`capabilitySourceVersion` を返す。⑤ 276a392b の名前（④の伝達による）に揃えた。③の 0008 の `source` と `sourceCapabilityVersion` はやめた。`capabilityVersion` は、送り手を区別しない token の版のまま。
- ⑤の形（`rotate-capability` ＋ `params.source`）も、0008 の relay では、その送り手の発行として扱う。
- **注意（⑤の形の危険）：** 0008 の無い relay では、⑤の形は `params.source` を無視して、代理の唯一の token を回す。つまり③の token を止める。③は別の op（`issue-capability`）を使う。古い relay は、この op を「知らない命令」として拒否するので、何も回らない。

**④⑤に決めてほしいこと：**

- op 名をどちらにするか。③の推奨は `issue-capability`。
- ⑤の 276a392b の現物と照らして、一本化すること。

## 2. 発行・更新・取消（③の変更）

| 段 | ③の動き | relay の側で確かめたこと（鍵を使わない試験） |
|---|---|---|
| 発行 | 同意で `issue-capability {source: 'mcp'}` を求める。答えの token が `source: 'mcp'` でなければ保存せず、拒否する（`capability_separation_unavailable`） | ③の token は `capabilitySource: 'mcp'`。⑤の `ai` の token は働き続ける |
| 更新（再接続） | 新しい接続が、relay の `mcp` の token を置き換える | 古い③の token は、relay で `BadCapability` になる。古い接続から送ると、relay が拒否する。⑤の token はそのまま |
| 取消 | 本人が link の取消と relay の `revoke-capability {source: 'mcp'}` に署名する。署名する文は `POST /link/revoke/statement` で作る。③は、自分の写しを捨てた後、その命令を relay に送る。そして relay の見え方に `mcp` が無いことを確かめ、link に `relayRevoke: {confirmed}` を記録する | 写しを捨てただけでは、relay ではまだ有効（試験で確認した）。命令の後は、relay で `BadCapability`。⑤の token はそのまま。③は⑤の送り手を取り消せない（`source: ai` の命令は 400） |

**取消で relay の命令が無い時：** `relayRevoke: {confirmed: false, why}` を返す。「relay では、本人が取り消すか、新しい接続が置き換えるまで有効」と明示する。

## 3. 古い relay への後戻り：止める

- relay の見え方に `capabilities` が無い（送り手ごとの capability が無い）時、③は**書き込みの接続を作らない**。
  - 同意の段階で 409 `capability_separation_unavailable` を返す。
  - 理由も返す：「代理の唯一の token を回すと、自動運転などほかの送り手が止まる。読み取りだけで接続するか、relay を更新する」。
  - relay には何も送らない。
- 運営が明示した時だけ、これまでの回し方を許す（`WYLLS_MCP_ALLOW_GLOBAL_ROTATE=1`）。試験では、これを許すと⑤の token が止まることも示した。
- 見え方に `capabilities` があるのに、送り手に結び付かない token を返す relay：その token は保存せず、同じ理由で拒否する。

## 4. ⑥の実行 ID を④の登録簿と結果照会まで

- `send_caravan` に、任意の `runId`（呼び出し側の実行 ID。8〜128 文字）を足した。
  - ④の登録簿には、その `runId` を run として登録する（無ければ③の操作 id）。
  - 同じ requestId の run は固定する。違う run での再試行は `IdempotencyConflict`。
- 新しい道具 `get_run_status {runId}`：
  - この接続のその run の操作を、それぞれ追跡する。送信はしない。
  - ④の登録簿のその run の受領書を返す（ほかの送り手の物も、`source` つきで）。
- 受領証に `runId` を出す。所有者の照会にも出る。
- **⑥の側はまだつながっていない。** ⑥の実行（`wylls.creation.run/0`）は⑥の模擬で、④の Run に「荷車だけの Run」を足すのは④の作業である。③は、⑥がどの文字列を実行 ID として渡すかを決めていない。試験では `ws06.run.517796dc.0001` を使った。

## 5. 試験（鍵を使わない物だけ。2026-11-06）

`npm run test:keyfree`：財布の木は上記、④の runexec と client、⑤ `e9d1551a` の port を使う。**18 件すべて通過。**

| ファイル | 件数 | 中身 |
|---|---|---|
| `keyfree/capability.test.mjs`（新） | 5 | 発行（⑤の形と③の形の共存、whoami の契約）、更新（古い token は relay で拒否）、取消（写しを捨てただけでは有効、命令の後は拒否）、古い relay では止まり⑤の token は無事、結び付かない token は保存しない |
| `keyfree/run.test.mjs`（新） | 3 | ⑥の run の 2 回の送信が④の登録簿の同じ run に入り、`get_run_status` で読める（送信なし）。消失、再起動、取消、結果不明を通して、登録 1・送信 1、結果不明は保留で再送しない。③（mcp）と⑤（ai）が同じ代理と登録簿で、それぞれの capability で動く |
| `keyfree/integration.test.mjs` | 5 | 前回の 5 件（whoami の欄名を合わせた） |
| `ws04-mapping.test.mjs` | 5 | ④の語彙 |

**ほかの試験：**

| 試験 | 結果 |
|---|---|
| 財布の 0008/0008b の試験（3 件）と④の `agent-wallet-run-facts`（4 件） | 7/7 |
| ⑤の鍵を使わない試験（④の runexec と client つき） | 48/48 |
| ④ `cargo test --test acts --test act_cli` | 12/12 |

**実物と mock：**

- 実物：③のサーバー、財布の `AgentGateway`、④の runexec と client、⑤の port。
- mock：
  - 送信の答え、chain の node、herald
  - 古い relay、および送り手に結び付かない token を返す relay（どちらも台本）
  - owner の命令の relay での署名の検査は実行していない（relay の既存の route のコード）
- 実行していない段：本人の wallet の署名を伴う段（同意、取消の文、所有者の照会）。

**実行していないもの：**

- 鍵を使う試験：③の `fixture.mjs` を使う 14 本、⑤の `citizen` など、④の `tests/gateway.rs`
- 実チェーン、有料 API、実アカウント

**CI：** push していないので動いていない。

## 6. 残件

| # | 項目 | 誰が |
|---|---|---|
| R1 | ⑤ 276a392b の現物との照合と一本化（op 名、欄名、Duplicate の扱い） | ④⑤（③は現物を待つ） |
| R2 | 0008/0008b の採否と統合 | ④⑤ |
| R3 | ⑥の実行 ID の形と、荷車だけの Run を④の Run に足すこと | ④⑥ |
| R4 | 取消の画面（本人が link と relay の命令に一度に署名する）。今は API だけ | ③ |
| R5 | 鍵を使う③の試験を、鍵を使わない作りに移す | ③ |
| R6 | 結果不明をいつまで待つか（④ §6） | ④（仕様） |
