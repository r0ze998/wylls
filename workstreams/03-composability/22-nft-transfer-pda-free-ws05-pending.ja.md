# 22 NFT 譲渡・撤回の後の古い資格、PDA を導出しない試験、⑤ 09cd4aab 待ち（③：MCP）

作業日 2026-11-06。親 `b76b0a57abc344eab2fe08444ca23269e214db84`、branch `ws03/runreceipt-port`（ローカルだけ、push していない）。

## 0. ⑤の最新版：受け取れていない

| 版 | 状態 |
|---|---|
| ⑤ `09cd4aab`（依頼の「最新版」） | **無い。** この clone、origin のすべての branch（2026-11-06 16 時台に fetch）、upload のどれにも無い |
| ⑤ `276a392b`（その前） | **無い。** ④の INTEGRATION-20261106c §6 にも「未着」とある（`ws05-276a392b-delivery.tar.gz`、SHA-256 `f71112b0…`。⑤の 0005 が送り手ごとの資格情報の側） |
| ⑤ `e9d1551a` | 手元にある。ただし**⑤の最新版としては扱わない**。この回は、④の client を包む⑤の port（`acts-port.mjs`）の API の代わりとしてだけ使い、照合の結論には使っていない |

そのため、この回では次のことを**していない**：

- 依頼の中心である「⑤ 09cd4aab と③ b76b0a57 の照合」と「一本化した差分を④へ」
- ⑤の側の Duplicate の扱い（④の伝達では「SendCaravan の Duplicate は作り直さず `refused`」）の確認
- ⑤の費用予約の復旧の確認

必要な物は §4。

## 1. 鍵と PDA を使わない試験に揃えた

- **③の `Game` に `addressesFor` を足した：** 世界の口座のアドレスを、外から渡せるようにした。既定は今までどおり `seasonAddresses`（PDA を計算する）。試験では、固定の定数のアドレスを渡す。
- **試験の作り（`keyfree/harness.mjs`）：** Citizen の PDA を計算していたのをやめ、固定の定数にした。
- **新しい PDA の guard（`keyfree/no-pda-guard.mjs`）：** `node --import` で読み込む。
  - repository の `solana-tx.mjs`（gateway の client と web の sdk の 2 つ）の `findProgramAddress` と `createProgramAddress` を、読み込みの hook で「拒否」に書き換える。
  - `@solana/web3.js` の `PublicKey.findProgramAddressSync` などを、CommonJS と ESM の両方の版で拒否にする。
  - 呼ばれたら `NoPdaGuard` で試験が落ちる。
  - 確かめたこと：`seasonAddresses` と web3 の両方の版で、`NoPdaGuard` が出る。
- **2 つの guard の下で実行する（`keyfree/run-guarded.sh`）：** ④の `scripts/ci/no-keys-guard.mjs`（鍵の生成・導出・署名）と、上の PDA の guard。財布の木の `permutation-gateway` から実行する。
  - ④の guard は、web3 を作業ディレクトリから探す。③の mcp からでは見つからず、web3 の部分が効かない。だから財布の木から実行する。
- **CI：** 動かしていない（push していない）。セットアップで実行したのは、`cargo build` と、既存の node_modules を使うことだけ。

## 2. NFT 譲渡と撤回の後、古い資格で送れない

**NFT 譲渡（新しい試験）：**

- ⑳の譲渡の後、③の `mcp` の token でも⑤の `ai` の token でも、送信は財布の**実物の** `submit` が拒否する。
  - 拒否は `SessionNotDelegated`、`sent: false`。transaction は 0。
  - 拒否は build の前（`#build` の `residentRefusal`）で起き、署名に届かない。届けば偽の keyring が例外を投げる。
- ③の操作は失敗になり、予約を返す。
- 譲渡そのものの判定（`ctx.residents.check` が「持ち主が変わった」と答える）は mock である。実物の判定は⑳の PDA（`residentAddress`、`linkAddress`）を読むので、この試験では使えない。
- 分かったこと：**譲渡の後も、relay の token 自体は有効のまま**（whoami が通る）。送信を止めているのは、チェーンの委任の検査である。譲渡で旧い持ち主の token を relay でも無効にするかは、④⑤の判断（§4 R3）。

**撤回（21 のとおり、今回も通過）：**

- ③が写しを捨てただけでは、relay ではまだ有効。
- 本人の `revoke-capability {mcp}` の後は、relay が拒否する。

**MCP の更新で AI 側を止めない（強めた）：**

- ⑤が `ai` の token で実際に送る。③の再接続の前にも後にも送れる（`sent`）。
- ③の古い token は relay で拒否される。

## 3. 試験（鍵と PDA を使わない物だけ）

`run-guarded.sh`。2 つの guard の下で、財布の木は④ `d0e96d53` ＋ `wallet-series-on-d0e96d53`（⑤ e9d1551a の共有パッチ 3 件と③ 0008/0008b）、④の runexec と client、⑤ e9d1551a の port を使う。

| 実行 | 結果 |
|---|---|
| 19 件（`ws04-mapping` 5、`keyfree` 14：capability 6、integration 5、run 3） | **19/19 通過**（2 つの guard の下の最後の 3 回の全体の実行） |
| 間欠的な失敗 | 2 つの guard の下の全体の実行 8 回のうち、最初の 1 回だけ、`integration` の「同じ登録簿」の試験が 1 件落ちた（その時は 18 件中 17 件）。その後、その file の単独 3 回、その試験の 6 並列、全体 7 回では再現しなかった。原因は**未確定**（推測：同じ SQLite に、③と⑤の port が同時に runexec を起動した時の競合）。直したとは言わない |

**実物：** ③のサーバー、財布の `AgentGateway`、④の runexec と client。

- `AgentGateway` の中身：capability の照合、whoami、見え方、実物の submit が build の前に拒否する経路、`actionFateView`、`fateOf`

**⑤の port：** e9d1551a の物を使った。最新版ではない。

**mock：**

- 送信の答え（譲渡の後の経路は除く）
- chain の node と herald
- 古い relay、および送り手に結び付かない token を返す relay
- ⑳の持ち主の変化の判定
- owner の命令の、relay での署名の検査（実行していない）

## 4. 必要な物と、④⑤の判断

| # | 必要な物・判断 | 誰 |
|---|---|---|
| R1 | **⑤ 09cd4aab の現物**：bundle（基点の commit を含む。`e9d1551a` か `45cba41e` から）と、⑤の共有パッチ（0005 を含む、④の木に当てる版）。origin に push するなら branch 名 | ⑤（利用者経由） |
| R2 | R1 が届けば：③ 0008/0008b と⑤ 0005 を照合する（op 名、whoami の欄、Duplicate を `refused` にすること、費用予約の復旧）。役割を分けて、一本化した差分を④へ渡す | ③ |
| R3 | NFT 譲渡で、旧い持ち主の relay の token も無効にするか。今はチェーンの委任の検査だけで止まり、token は有効のまま | ④⑤⑳ |
| R4 | ④の `no-keys-guard` は、PDA の導出と、ESM の web3 を対象にしていない。③の `no-pda-guard.mjs` を④の CI に入れるか | ④ |
| R5 | 上の 1 回の失敗の原因の調査（同じ run store への同時の runexec） | ③、④ |

## 5. 追記：⑤の session からの連絡を受けて（2026-11-06 夜）

⑤の session から連絡があった（データとして受け取った）。

- ⑤にも③の b76b0a57 と 7923f900 が無い。
- ⑤の今の形は、④の `6984acfa4c0f9919c8c424a9bd5f2d59193d1639` に当てる系列で、`permutation-gateway` の木は `477c5685ad2390c2b8a627936187f8f546423a0e`。
- 役割の案：③は MCP の同意と結果の表示、⑤は中継の共有コアと自動運転、④は統合。

③はこの案に同意した。そのうえで、**③の 0008/0008b を⑤に押し付けず、③を⑤の契約に合わせた**。0008/0008b は参考として残す。⑤には、③の変更、確認してほしい点、⑤の系列と 09cd4aab を利用者経由で送ってほしいことを返信した。

**③の変更：**

- **契約の見分け：** relay の見え方を見る。
  - `senderCapabilities` があれば⑤の契約：`rotate-capability {source: 'mcp'}` を送る。
  - `capabilities` があれば 0008：`issue-capability` を送る。
  - どちらも無ければ古い relay：書き込みの接続を作らず、何も送らない。
  - ⑤の形を古い relay に送ると、source を無視して唯一の token を回すため。
- **答えの確認：** 答えの `capability.source` が `mcp` でなければ、token を保存しない。
- **取消の確認：** `senderCapabilities` または `capabilities` から `mcp` が消えたことを確かめる。
- **Duplicate（⑤の説明による形：`failed`、`sent: null`、code `Duplicate`、`duplicateOf`）：**
  - 前の送信の署名を、自分の物として採らない。履歴や fate にその署名が出ても採らない。
  - 保留 `Duplicate` にし、予約は数えたまま。再送しない。
  - その transaction が着地しても、保留のまま。別の要求の物でありうるため。
  - finalized での失敗、または証明された期限切れの時だけ、失敗にして予約を返す。

**試験：** `keyfree/ws05-contract.test.mjs`（3 件）。⑤の**説明に合わせた台本**の relay と、実物の `AgentGateway` を使う。⑤のコードではない。2 つの guard の下で、全体 22/22 を 2 回。

## 6. 追記：⑤の答え（データとして受け取った。⑤の現物では未確認）

⑤の session の答え：

- 答えに `capability.source` が入る。
- `senderCapabilities` は、パッチを当てた中継ではいつも出る（空なら `{}`）。撤回の後は消える。
- Duplicate の key の fate は `not-sent` にならない。前の署名を追うか、`unknown` になる。履歴から外れれば `unqueryable`。
- 同じ署名は同じ取引である（中継の replay の鍵が、代理の鍵の署名だから）。もう一方の key とあわせて、1 回として数える。
- 包み `ws05-9a4051c7-delivery.tar.gz`（SHA-256 `b64d9a9a…`、⑤ HEAD `9a4051c79de6c5fba3c86bd515c67f3ec311b5ab`。09cd4aab を祖先に含む）は**利用者に渡した**とのこと。③にはまだ届いていない。

**③の変更：** Duplicate の前の署名が、③自身の別の操作の署名なら、その操作が取引と数を持つ。こちらの操作は `DuplicateOfOperation` で終え、予約を返す（1 回として数える）。③の物でなければ、これまでどおり保留する。

**試験：** 1 件を足した。2 つの guard の下で、23/23 を 2 回。
