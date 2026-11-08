# 12. 計画 → Dispatch の接続：③⑤の route との入力契約（案、2026-11-08）

**位置づけ：** 既存の権限と意図を変えない、技術的な接続の契約案です。新しい永続的な権限、署名の方式、利用者の経済的な約束は足しません。それらが要る点は §3 に選択肢と影響だけを書き、決めずに残します。

**基点：** ④の公開版 `claude/gallant-ride-cunptv` = `20db3313adf25481b714798759b1fdd0cb917275`（⑥ `148bcebd` と③⑤の共有コアが入っている）。③ `c95287d51dff8e92a1a9db67163b37b35e6d94eb`。

## 1. 役割（④ AUTH-ROUTES の推奨 A1＋B1 に沿う）

| 誰 | すること | しないこと |
|---|---|---|
| gateway の route（③⑤の担当。**未作成**） | 依頼者を認証する（本人の財布・期限内のセッション・NFT パスの持ち主）。⑥の `intake` を呼ぶ。④の場所・Citizen を読む | ⑥の計画を書き換えない |
| ⑥（`src/connect/intake.mjs`・`dispatch.mjs`・`ports.mjs`） | 採用済みの計画から実行 id・requestId を固定し、控えに書いてから④③を呼ぶ。状態を読むだけの照会を返す | 依頼者を認証しない。`authenticatedBy` を書かない。署名しない。鍵を持たない |
| ④ `runexec run accept` | 依頼者がパスの今の持ち主かをチェーンで確かめる（違えば exit 5 `NotAuthorized`、何も書かない） | ― |
| gateway（送り手ごとの capability、Citizen ごとの一列） | 唯一の署名者として送る（B1） | ― |

## 2. 入力契約（route → ⑥ `intake`）

```js
intake({
  dispatch,                       // ⑥ の Dispatch（控えは route の側が置く。§3 D2）
  route: "run" | "act",           // run: ④ run accept/view。act: ③ MCP（AI の会話から）
  adoption: (planHash) => null | problem,   // ⑥ の採用の記録（AdoptionBook.problem）
  binding: (plan, requester) => null | problem,   // §3 D1。既定は無い（無ければ全部拒否）
  request: {
    plan, planHash, env, nonce,   // ⑥ の採用済みの計画、その版と内容ハッシュの固定、依頼の番号（≤16）
    requester,                    // run のみ：gateway が認証した {actor, generation, citizen, authenticatedBy}。そのまま④へ
    places, ownerTag,             // run：④③がチェーンから読んだ場所と Citizen の tag
    view,                         // act：③ get_village_status の持ち主の場所
    deadlineSlot, budget,         // §3 D3
  },
})
```

**保つ約束（どの route でも変えない）：**

| 約束 | 実装 |
|---|---|
| 認証済みの依頼者だけ。⑥は作らない | `requesterProblem`：欠け・未知の欄・空の `authenticatedBy` は計画しない。④へはそのまま渡す |
| 実行 id・requestId は計画から決まる | 実行 id `ws06:<計画のハッシュ>:<番号 ≤16>:<手順 ≤40>`（≤127）、requestId `ws06.<48桁>`。同じ依頼は同じ値 |
| PlanUsed・別の接続での requestId の再利用は保留 | `ports.mjs` の DEFINITIVE3。計画も id も作り直さない |
| 結果不明は再送しない | act の `unknown` は保留。再起動しても送らない |
| `landed` は完了ではない | 完了は、④の Run がすべての段を「履行完了」と検証したときだけ |
| 照会は読むだけ | `status(dispatch, key)` は控えを読むだけで、③④を呼ばない。④の `run view` も読むだけ |

## 3. 決めていないこと（選択肢と影響。⑥は決めない）

**D1：計画と認証済みの依頼者の結び付け（誰がその計画を動かせるか）**

⑥の試作では、利用者が自分の鍵で計画に署名して採用し、実行の依頼にも署名していました（Ed25519、試作の固定の種）。ゲームの中の鍵は財布とセッション鍵で、⑥の鍵はありません。

| 案 | 内容 | 影響 |
|---|---|---|
| D1-a 財布で採用に署名する | 採用（計画）に、本人の財布で署名する | 新しい署名の方式になる。財布の承認画面が増える。代理（AI）は採用できない |
| D1-b 認証済みの依頼者の Citizen で結ぶ | 計画に Citizen を書き、route が認証した `requester.citizen` と一致すれば動かせる。署名は既存の gateway の認証だけ | 新しい署名は要らない。その Citizen のセッション（代理を含む）が、採用済みの計画を動かせる。それを許すかは権限の判断 |
| D1-c 採用は財布、実行の依頼はセッション | 採用だけ D1-a、各回の実行は D1-b | 採用時に一度だけ署名が要る。各回は既存の認証のまま |

`intake` には既定の `binding` がなく、渡されなければ `BINDING_UNDECIDED` ですべて拒否します。

**D2：控え（ジャーナル）の置き場**

| 案 | 影響 |
|---|---|
| route を持つサーバー（gateway）のファイル・DB | 再起動に耐える。利用者ごとの分け方と保持期間の決定が要る |
| ③の store（JsonStore、再起動に耐える。D5-b のとき） | ③の提示。利用者ごとの分け方と保持期間の決定が要る |
| MCP クライアントの側（D5-a のとき） | ③⑤に変更なし。控えはクライアント（利用者の AI の側）にある |
| ④の run store に置く | ④の契約の変更になる（④は Run 側に欄を足さないと回答済み） |

**D3：`deadlineSlot` と `budget` の出どころ**

⑤の予算（`budget.max_fee` は手数料の上限）と結び付けるか、route が固定値を入れるか。利用者の支出の上限に関わるので、⑤と利用者の判断です。⑥は値を作りません。

**D4：経済的な約束**

⑥は、手数料・報酬・作者への支払いを何も足しません。荷車の手数料（50,000 lamports 以上）は③④の既存の命令の値のままです。

**③からの事実（2026-11-08、③ `c95287d5` 時点の回答）：**
- ③の認証は、本人が財布の署名で同意した接続（link）による OAuth。主体は `{owner, agentId, linkId, scopes}` で、`citizen` と `generation` の欄はない。NFT の持ち主の確かめは③ではなく⑤の財布が送信の組み立て時に行う。
- **したがって、今の③は④の受付が求める依頼者 `{actor, generation, citizen, authenticatedBy}` を、認証済みの値として出せない。** 出すなら新しい契約になる（`citizen`・`generation` の読み取りの追加を含む）。
- ③のサーバーは⑥の Dispatch も控えも持たず、`intake` を呼ぶ道具もない。③の上限（送信回数・積荷）は② MOCK の許可の上限で、手数料の予算ではない（予算は⑤）。
- ③は、D1・D3 を権限と支出の判断として利用者に回し、⑤にも転送した。D1 が決まるまで③は route を足さない。

**D5：route の担当**

③（MCP の会話から）と⑤（自動運転・ブラウザ）のどちらが、どの `source` で `intake` を呼ぶか。④は③⑤と利用者に回しました。③の示した案：

| 案 | 内容 | 影響 |
|---|---|---|
| D5-a ③は route にならない | 今のまま、MCP クライアント（利用者の AI）が③の道具を呼び、⑥の `intake` はクライアント側で動く（act の経路） | ③に新しいものはない。認証は OAuth と財布の検査のまま。④の run 経路（到着・量の判定）は使わない |
| D5-b ③が route になる | ③に `intake` を呼ぶ MCP の道具を足し、`authenticatedBy: 'ws03-oauth:<linkId>'` と owner・agentId を渡す | 新しい入口と権限の境界になり、利用者の承認が要る。`citizen`・`generation` の読み取りの追加も要る |

## 4. 実装の区分

| 区分 | 中身 | 状態 |
|---|---|---|
| **部品（⑥の実装）** | `intake.mjs`・`dispatch.mjs`・`ports.mjs`・`caravan.mjs` | 実装済み。鍵なしの試験 20件（`intake` 2・`ports` 2・`dispatch` 6・`connect` 10） |
| **代役（試験の偽物・stand-in）** | ④の run store と③の送信の偽物（冪等の振る舞いは実物に合わせた）、依頼者の stand-in（公開アドレスの形だけ）、③の `get_village_status` の形の場所 | 実物の代わり。実物と同じとは扱わない |
| **実コード接続（実物で照合）** | ④ `cf517b55`（と同一の口の `20db3313`）の `clients/runs.mjs` と `runexec`：受付の拒否が保留になる、④自身のストアを `run view` で読む。③ `c95287d5` のソース：requestId・runId の規則、計画の答え、荷の名前 | `connect-live` 6件通過・1件未実行（gateway の npm 依存） |
| **未実装** | ③⑤の route（依頼者の認証 → `intake`）。D1 の binding。控えの置き場（D2）。④の受付で依頼者が通る経路を⑥から通すこと（チェーンが要る） | **未完成**。⑥の部品だけでは、ゲームの中から計画は動かない |

## 5. 再検証（2026-11-08、④ 公開 `20db3313adf25481b714798759b1fdd0cb917275`、③ 公開 `6ee7c4d17c1b74731bf7b420e88b229609ec7f97`）

**差分の確認：**
- ④ `cf517b55`→`20db3313`：`workstreams/04-execution` の `src`・`clients`・`tests`・Cargo の各ファイルは同一。ただし依存の `permutation-rules`・`frontier-abi` が変わったので、`runexec` を `20db3313` から作り直した（sha256 `d51171f2263bd77688c2386e0499584811f3d453d0c2b5c14d64f652de57492a`）。
- ③ `c95287d5`→`6ee7c4d1`：`mcp/src`・`permutation-server/web/frontier`・`web/sdk`・gateway の `agent/` は同一。③の照合は同じ内容を読む。

**呼び出し経路の監査（鍵・署名）：**
- ④の `src`・`clients`・依存のライブラリには、鍵の生成・導出・署名の呼び出しがない。あるのは PDA の公開アドレスの算出（`intake_rpc.rs` の `find_program_address`）だけ。
- ③の試験が読み込む `fplay.mjs` には、送信の関数の中に署名がある。試験が呼ぶのは `cargoBytes`・`placeData`（純粋な関数）だけ。万一呼ばれても、鍵の API を拒否する guard が止める。
- 実チェーンは読まない。④の受付は、届かないノード（127.0.0.1:9）を指す。

**結果（鍵なし。Node 22.22.0 と 20.20.0）：**
- `connect-live` 7件のうち6件通過・1件未実行（④の gateway の要求検査。npm の依存が未導入。下の「未実行の1件」）。
- 鍵なしのオフライン試験 20件（`intake` 2・`ports` 2・`dispatch` 6・`connect` 10）通過。
- scratch の④の試験 `ws06_check`（`20db3313` の実行器、④には残していない）3件通過。

| 確かめたこと | どこで |
|---|---|
| 契約の互換（実行 id・requestId の規則、④の RunSpec が施設なしを受ける、④の照会の形、③の荷の名前） | `connect-live` 1・3・5・6（実物）、`connect`（オフライン） |
| 依頼者はそのまま④へ。拒否は保留で、id を変えない | `connect-live` 4（④の client と runexec） |
| unknown は再送しない（再起動をまたいでも） | `dispatch`（偽物）、`connect-live` 7（④の act の登録簿の7状態） |
| PlanUsed・別の接続での requestId の衝突は保留 | `ports`・`dispatch`（偽物）、`connect-live` 6（③のソースにその答えがあり、requestId の確認が計画より前） |

## 6. 新しい入口 `intake` について、検証していないこと

- **route から呼ばれること：** route が無い（③⑤とも未作成）。`intake` の呼び出し元は試験の中だけ。
- **認証済みの依頼者の中身：** 試験の依頼者は公開アドレスの形の stand-in。③の OAuth の主体には `citizen`・`generation` が無く、今の③からは渡らない（§3 の③からの事実）。
- **結び付け（D1）：** 未決。`binding` は試験の中で渡した関数だけで、本物の判定は無い。
- **④の受付が依頼者を通すこと：** チェーン（パスの PDA の口座）が要る。⑥からは拒否の側だけを試した。通る側は④の `tests/intake_chain.rs` が確かめている。
- **③のサーバーを動かすこと：** 財布の木と⑤の依存が要る。③の規則はソースで照合し、③の振る舞いは偽物で再現しただけ。③自身の鍵なし試験（27/27、③の報告）は⑥では回していない。
- **控えの置き場（D2）と、期限・予算（D3）：** 未決。試験はメモリと一時ファイルだけ。

### 5.1 ④の gateway の要求検査（`connect-live` 2）：④の環境で通過（2026-11-08）

**結果（④が④の統合の環境で実行し、⑥が版と同一性を確かめた）：**
- ⑥の木：`96ffd72e5327b99bf362d140070e798f5f46161e`。④は `workstreams/06-creation` だけを sparse で checkout した。
- WS04_ROOT・WS03_ROOT：④の統合候補 `b3d0897869add543985c3f7a6c7aa8b7991f9bf1`（tree `2e378f3a9fb60e82d504e9b2de410acea9ae132b`）。
- 依存：`permutation-gateway` は `npm ci --ignore-scripts` 済み。`@solana/web3.js` 1.99.0、`@magicblock-labs/ephemeral-rollups-sdk` 0.17.2。
- 実行：node v22.22.0、`node --import <WS04_ROOT>/scripts/ci/no-keys-guard.mjs --test --test-name-pattern "gateway accepts" workstreams/06-creation/test/connect-live.test.mjs`。RUNEXEC_BIN は候補の runexec。
- 結果：`ok 1 - ④'s gateway accepts the action ③ would build from 06's call; the key fits`。1件中1件通過、失敗 0、省略 0。guard で止まったものは無い。呼び出し先は `parseActionRequest` だけで、署名も送信もしていない（④の報告）。

**⑥が GitHub 上で確かめたこと：**
- `contract.mjs`・`routes/errors.mjs`・`client/src/{chain,codec,pda}.mjs`・`package-lock.json` は、`20db3313` と `b3d08978` で同一。lockfile の sha256 `95f3f6b3…19e6b` も一致。
- `workstreams/03-composability` は `6ee7c4d1` と同一。
- `permutation-server/web/frontier/fplay.mjs` は `6ee7c4d1` から変わっているが、試験が呼ぶ `placeData`・`cargoBytes`・`PLACE_KIND` は同一。

**数え方：** `connect-live` の7件は、6件がこの環境（④ `20db3313`・③ `6ee7c4d1`）、1件が④の環境（④ `b3d08978`）で通過した。一つの環境で7件を通したものではない。

### 5.1 の以前の記録（未実行だった理由）

- **試験の中身：** ④の `permutation-gateway/src/frontier/agent/contract.mjs` の `parseActionRequest` に、③が組み立てる形の SendCaravan の要求（⑥の requestId・runId 入り）を通し、受け付けること、`source: "ws06"` は拒否されることを確かめる。形の検査だけで、署名も送信もしない。
- **止めているもの（2026-11-08、④ `20db3313` の `permutation-gateway/package-lock.json`、sha256 `95f3f6b3ee4f24882368198423befb9d1c53612b8c9a81495d7afa35db119e6b`）：**
  - `contract.mjs` は `routes/errors.mjs` → `client/src/chain.mjs` を経て、外部の `@solana/web3.js` 1.99.0 と `@magicblock-labs/ephemeral-rollups-sdk` 0.17.2 を読み込む（ローカルのファイル8つ）。
  - どちらもこの環境に無い。全体を探した（`node_modules` も npm のキャッシュも無い）。グローバルにも無い。
  - この回はソフトを入れないので、`npm ci` はしていない。
- **呼び出し経路の監査：** `parseActionRequest` は形の検査だけ。読み込み時に動くのは④の `client/src/pda.mjs` の PDA の算出（許可の範囲）。鍵の生成・導出・署名は無い。実行するときは④の `scripts/ci/no-keys-guard.mjs` を前に読み込み、鍵の API が呼ばれたら止める。
- **④に依頼したこと：** 依存の入った④の統合の環境で、この1件だけを guard 付きで回してもらう。手順は次のとおり。

```
WS03_ROOT=<③ 6ee7c4d1> WS04_ROOT=<④ 20db3313（npm ci --ignore-scripts 済みの permutation-gateway）> RUNEXEC_BIN=<20db3313 の runexec> \
  node --import <WS04_ROOT>/scripts/ci/no-keys-guard.mjs --test --test-name-pattern "gateway accepts" workstreams/06-creation/test/connect-live.test.mjs
```

## 7. ローカルの状態の扱いの修正（2026-11-08、④ 公開 `16576826084a8ea7bd6b12b845d50b97f3d14904` の上で）

D1〜D5 は未決のまま。`intake` は閉じたまま（依頼者が無ければ `NoAuthenticatedRequester`。⑬ `resident/ports/ws04-run.mjs` と同じ名前）。

| # | 不具合 | 起きること | 直したこと | 試験（鍵なし） |
|---|---|---|---|---|
| 1 | 結果不明（`unknown`）で保留にした送信を、その後読まなかった | ④がのちに `landed`・`failed` に決めても、⑥は「保留」のままで変わらない | 結果不明による保留だけは、④の状態を読み続ける（送らない）。確定した状態が来たら保留を解く。拒否による保留は読まない | `dispatch`：再起動をまたいで unknown→landed、送信は1回、完了にはしない。拒否の保留は読まない |
| 2 | 一つの控えのファイルに、二つの処理が書けた | それぞれが手元の写しで上書きし、後に書いた方だけが残る（計画済みの依頼や進んだ状態が消える） | `fileJournal` が `<path>.lock` を排他的に作って持つ。二つ目は `JournalLocked` で拒否。持ち主の pid が動いていなければ引き継ぐ。`close()` で外す | `dispatch`：二つ目の拒否、死んだ持ち主の引き継ぎ、close で外れる |
| 3 | 同じ依頼に `advance` を同時に二回呼べた | 同じ受付・送信を二度出しうる（③④は冪等なので二重には動かないが、⑥がそれに頼っていた） | 同じ鍵の `advance` は一つの処理の中で一度に一回。二回目は状態だけを返す（`busy: true`） | `dispatch`：受付は1回。ガードを外すと試験が失敗する |
| 4 | 名前の付け替えの後に、ディレクトリを fsync していなかった | 電源が落ちると、控えが古い版に戻りうる | 付け替えの後にディレクトリを fsync する | `dispatch`：ディレクトリの fd が fsync されたこと |

**変異の確認：** 1〜4 の修正をそれぞれ外すと、どれも試験が失敗する（3 は、ガードを外すと待ち続けるので 500 ms で失敗させる）。

**結果：**
- オフライン 23件（`intake` 2・`ports` 2・`dispatch` 9・`connect` 10）が Node 22.22.0・20.20.0 で通過。
- `connect-live` は④ `16576826` から作り直した `runexec`（sha256 `9df87c7133d082121e96d37e5f0b97b017240d4bdf83ab62c34989ef64af5d00`）で 6件通過・1件省略。省略の1件は gateway の要求検査で、④の環境で通過済み（§5.1）。
- scratch の④の実行器の確認 3件通過（④には残していない）。

**確かめたこと：** `16576826` までに④の依存（`permutation-rules`・`frontier-abi`）が変わったが、`Resource` の順と `ARMS = Resource::Horses` は同じ。変わったファイルに鍵の生成・導出・署名の呼び出しは無い。

**判断が要るので直していないもの：** なし。この回の4件は、どれも新しい権限・規則を要しない。

## 8. 控えのロックの修正（⑯の指摘、2026-11-08、④ `4d44f021` 上）

⑯が⑥ `7232c86b` のロックに3点を再現した。控えの上書きと、同じ実行 id・requestId の再実行の問題で、実際の二重送信まで確かめたという意味ではない。⑯の probe とログは当初受け取れなかったため、⑥は同じ3点を自分で再現し、直した（`1360ce51`）。その後に届いた⑯の probe で確かめ直した結果は §8.1。

| # | 不具合（⑥ `7232c86b`） | 再現（`handoff/ws16-probe/journal-lock-probe.mjs`、鍵なし、④の guard 付き） | 修正 |
|---|---|---|---|
| 1 | 同じ処理の中で二回 open できた（自分の pid の lock を「古い」と見て奪った） | `BAD same-process second open: opened` | lock に pid・処理の開始時刻・open ごとの token を書く。持ち主が動いていれば、自分の処理でも拒否（JournalLocked） |
| 2 | 古い lock を二人が同時に奪えた（読む → 消す → 作る の間に割り込める） | `BAD stale-lock takeover race: A writes, B writes` | 奪う側は `<path>.lock.takeover` を排他的に作ってから、lock を読み直し、判断した時と同じときだけ置き換える。奪う途中の処理が生きていれば拒否、死んでいれば片付けてやり直す |
| 3 | lock を失った書き手の save が通った | `BAD writer that lost the lock: saved` | save の前に、lock がこの open の token のままかを確かめる。違えば JournalFenced で何も書かない。close も自分の token のときだけ外す |

**壊さないもの：**
- 生きている持ち主の lock は奪わない。
- 正当な再起動（持ち主の pid が無い、または同じ pid でも開始時刻が違う＝前の実行）は引き継ぐ。
- 再利用された pid（別の処理）も、開始時刻で見分けて引き継ぐ。

**限界：** 持ち主の確かめはこの機械の処理の表（`/proc`）による。別の機械や別の pid 名前空間から同じファイルを書く場合は見分けられない。

**結果：**
- probe：修正前（`7232c86b`）は BAD 3件、修正後は 0件。
- 鍵なしの試験：`dispatch` 14件（同じ処理の二回目・close の持ち主、生きている持ち主と再起動と pid の再利用、奪い合いの決定的な割り込み・奪う途中の生死、柵（fence）と close・柵の後に外への呼び出しが無いこと、本物の8処理×5回の奪い合いで毎回1つだけ勝つ、ディレクトリの fsync）。
- オフライン合計 28件が Node 22.22.0・20.20.0 で通過。`connect-live` は④ `16576826` の `runexec` で 6通過・1省略。
- 変異の確認：同じ pid を古いと見る、読み直しを外す、mutex を外す、save の柵を外す、close が誰の lock でも外す、開始時刻を無視する、の6つは、どれも試験が失敗する。

**静的 import の監査：** `src/connect/dispatch.mjs` が読み込むのは⑥の `src/` の13ファイル（`keys.mjs` は `plan.mjs` 経由の import だけで、`fileJournal` の経路からは呼ばれない）と `node:crypto`（`randomUUID`。token のためで、鍵ではない）・`node:fs`。外部のパッケージは無い。

### 8.1 ⑯の probe での確かめ直し

⑯の probe（`claude/dreamy-ramanujan-ijj8qj` `36ec6937` の `verification/16-independent/probes/v16-ws06-journal-lock.test.mjs`、ログ `verification/16-independent/logs/phase20/v16-ws06-lock.log`）を静的に確かめた。import は `node:test`・`node:assert`・`node:fs`・`node:os`・`node:path` と、`V16_WS06_DISPATCH` で指す `dispatch.mjs` だけで、鍵・ネットワーク・子プロセスは使わない。これを④の guard 付きで流した。

probe は、この機械に無い pid（111・222・999）と、注入する `alive` を使う。`1360ce51` では、次の2点が残っていた。

| # | `1360ce51` での結果 | 原因 | 修正 |
|---|---|---|---|
| J2 | 同じ pid の二回目の open を受け付けた | 「自分の処理か」を `/proc` だけで判断していた。処理の表に無い pid は死んだとみなされ、奪われた | lock の pid と開始時刻がこの open と同じなら、この処理とみなして拒否する（処理の表を見る前に判断） |
| J4（対照） | 生きている持ち主が奪われた | `alive` の注入を黙って無視していた（`startOf` だけを読んでいた） | `alive(pid)` が渡されたら、pid があるかどうかはそれで答える。開始時刻は今までどおり `startOf` から読む |

J1（奪い合い）と J3（柵）は、`1360ce51` ですでに直っていた（A は JournalLocked、A.save は JournalFenced）。

**結果：**
| ⑥ | J1 | J2 | J3 | J4 |
|---|---|---|---|---|
| `7232c86b`（④ `4d44f021` に入ったもの） | 両方が開く、A の状態が消える | 受け付ける | 古い状態で上書き | 通過 |
| `1360ce51` | A は JournalLocked | 受け付ける | JournalFenced | **失敗** |
| この修正 | A は JournalLocked | JournalLocked | JournalFenced、控えは B のまま | 通過 |

- ⑯の probe は Node 22.22.0・20.20.0 で 4通過。⑥の probe は 3件とも ok。
- `dispatch` は 15件。⑯の probe と同じ形（処理の表に無い pid、注入した `alive`）で J1〜J4 を確かめる試験を1件足した。
- オフライン合計 29件が Node 22・20 で通過。`connect-live` は④ `16576826` の `runexec` で 6通過・1省略（ゲートウェイの確認。④の環境で通過済み）。
- 変異の確認：足した2つの守り（この処理の判断、`alive` の注入）は、どちらも外すと試験が失敗する。
- ⑯が監査で外した `roles.test.mjs`（`generateKey()` を呼ぶ）は、⑥もこの確認では流していない。
