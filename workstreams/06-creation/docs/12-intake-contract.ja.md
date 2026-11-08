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
- `connect-live` 7件のうち6件通過・1件未実行（④の gateway の要求検査。npm の依存が未導入）。
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
