# ⑤：送り手ごとの権限を同じ gateway で（発行・更新・撤回）、待っていた要求の再確認、NFT の譲渡、鍵も導出も使わない試験（2026-11-06）

起点は ⑤ `09cd4aabae8c3d47af526aaceae2fd9844589d6a`。

## 1. 突き合わせの相手

| 担当 | commit | 状態 |
|---|---|---|
| ③ | **`b76b0a57`：⑤に届いていない** | GitHub のどのブランチの先端にも、pull request の参照にも無い。この環境への添付も無い。③のセッションに、パッチを渡すよう依頼した（send_message、届いた）。③の GitHub 上の最新は、まだ `acdcd0bf795d10a65f6b8192076c4f8d6357e557` |
| ④ | `6984acfa4c0f9919c8c424a9bd5f2d59193d1639`（`claude/gallant-ride-cunptv` の最新） | ⑤の共有パッチを、この上に作り直した（gateway は d0e96d53 から変わっていない） |

**③の実物との突き合わせは、まだできていません。** 以下の形を、③の 0008 と照らして合わせる必要があります。照らす点は③に送りました。

## 2. 送り手ごとの権限：同じ gateway での発行・更新・撤回（`patches/on-ws04-6984acfa/`、⑤は当てていない）

| 操作 | owner command | 効果 |
|---|---|---|
| 一般の token の発行・更新 | `rotate-capability`（source なし） | 今までどおり。ai でも mcp でも通る |
| 送り手の token の発行・更新 | `rotate-capability`、`params.source: 'ai'\|'mcp'` | その送り手の token だけを替える。その source の要求にだけ通る |
| 撤回 | `revoke-capability`、`params.source: 'ai'\|'mcp'\|'any'` | その送り手の token、または一般の token（'any'）を消す。他の token はそのまま |
| 確認 | `POST /f/agent/whoami` | `capabilitySource`（'ai'\|'mcp'\|'any'）。view は `senderCapabilities` の版だけ（hash は出さない） |

**0007（新）：待っていた要求も、撤回・更新の後は送らない**
- 0006 の Citizen の列で、認証から送信までの間に待つ時間ができていました。その間に token が撤回されても、送ってしまう恐れがありました。
- 今は、要求を通した資格（一般か送り手か、と版）を、2回確かめます：
  - 列の番が来た時
  - 送る直前（beforeSend、同期）
- 撤回・更新されていれば `BadCapability` で、何も送りません。拒否は、そのキーの答えとして残り、同じキーは replay になります。

**NFT の譲渡**
- ④の住民の確認（`residentRefusal`、④ `d0e96d53` から）が、まだ有効な token の送信を、取引を作る前に拒否します。
  - 持ち主が変わった：`SessionNotDelegated`、`resident: 'ResidentHolderChanged'`
  - 持ち主を読めない：`ResidentUnverified`。「変わっていない」とはみなしません
- token 自体は認証を通ります（whoami）。止まるのは送信です。

## 3. Duplicate と結果不明（0006 から変えていない）

SendCaravan の `Duplicate` は：
- `failed`・`sent: null` で返し、前の送信の署名と寿命を付けます。過去に送っていないことの証明にはしません。
- fate が結果不明・照会不能の間は保留し、送り直しません。証明された `expired` の時だけ、新しいキーで試します。

⑤の participate も、`failed` で `sent` が false でない物は追って、送り直しません（`acts-fate` A5・A6、`safety-e2e` E1・E7）。

## 4. 費用の予約の復旧（`ws13-stop`、`safety-e2e` E3・E4）

- 予約の直後に止まった：次に開いた時に解放します。それまでは上限に数えるので、二重には使えません。
- 呼び出し中に止まった：未確定のまま、額も残します（解放もせず、0 にもしない）。
- 生きた別のプロセスが持っている時：開くことを拒否します。

## 5. 鍵の生成・導出（PDA を含む）・署名を伴う試験はしない：見つけたこと、直したこと、守り方

**見つけたこと：⑤の `src/adapters.mjs` が、読み込んだ時と実行中に、ゲームのアドレスを導出していました。**
- 読み込んだ時：`new FrontierAddresses(...)` の中で `seasonPda` を呼んでいました。
- 実行中：命令が gateway で作れるかを、`accountsFor` を実際に呼んで確かめていました。`accountsFor` はアドレス（PDA と seed 付きのアドレス）を導出します。
- そのため、participate や adapters を読み込む⑤の試験（`acts-fate`・`acts-port`・`safety-e2e` など）は、前の回までの実行で PDA を導出していました。前の回までの指示は「鍵の生成・導出・署名」で、PDA を名指ししておらず、⑤はこれを数えていませんでした。

**直したこと：**
- 作れる命令の一覧は、gateway のソースの文字（`accountsFor` の `case` の名前）から読むようにしました（`GATEWAY_BUILDS`）。実行もせず、導出もしません。
- 一覧は、SetVigil・Harvest・Train・Build・Muster・Garrison・Dissolve・Explore・Depart です。

**守り方：`test/no-keys-guard.mjs`（新）**
- 試験の前に読み込みます。`NODE_OPTIONS="--import …/no-keys-guard.mjs"` で、子プロセスにも効きます。
- 次を呼ぶと、例外になります：
  - node:crypto の鍵の関数（生成・鍵の物・sign/verify・HMAC・導出・鍵の交換）
  - `@solana/web3.js` の `Keypair.generate`・`fromSeed`・`fromSecretKey`、`PublicKey` の PDA と seed 付きアドレスの導出、取引の署名
  - 共有コードの導出・署名の関数（`findProgramAddress`・`createProgramAddress`・`withSeed`・`seasonPda`・`programDataAddress`・鍵のファイル・`signTalk`・`coSign`・`signCommand`・`signAs`）。読み込む時に書き換えます
- `test/no-keys-guard.test.mjs` で、12 通りがすべて止まり、sha256 は使えることを確かめました。
- 守れない物：
  - Rust の `runexec`（Node の外）。`act` の命令は SQLite と 127.0.0.1 の読み取りだけなのを、コードで確かめています
  - 依存の中の、別の純 JS の鍵の実装

この回の試験は、すべてこのガードを付けて実行しました。

## 6. 試験（ガード付き。鍵・導出・署名・実 AI・有料 API・CI なし）

| 試験 | 結果 |
|---|---|
| ⑤の全体（11ファイル、ガードの自己確認を含む）、④ 6984acfa の実物の登録簿あり | 60/60、2回 |
| ④ 6984acfa に⑤のパッチ（0002c〜0007）を当てた木：`agent-wallet-revoke-transfer`（新、3）・`citizen-lane`（3）・`sender-capability`（4）・`run-facts`（3） | 13/13 |

**push していないので、CI は起動していません。**

④の `runexec` は 6984acfa の木から offline でビルドしました（sha256 `d0a6260ead147566c45aeddbfe9e7d2c41472ee8fcb7ff6e558feb6916551c18`、取得なし）。

⑬の試験は、この回は実行していません。理由：⑬の世界が導出をしないかを、このガードで確かめていないため。前の回の⑬の実行では、⑬自身のガード（node:crypto だけ）を使っていました。

## 7. ③・④・⑤の役割（④へ渡す差分）

| 担当 | 受け持つ物 | 渡す物 |
|---|---|---|
| ③ | MCP の同意・OAuth、`mcp` の token の封印と使い方、MCP の結果（`failed` / `sent: null` の Duplicate を含む）を利用者に見せること | `proposal-for-ws03`（同意に `source: 'mcp'`）。③の 0008 と照らす |
| ⑤ | 中継の共有コアの、送り手ごとの token（発行・更新・撤回）、Citizen の列、待っていた要求の再確認、Duplicate の扱い。自動運転（`ai`） | `shared-patches-on-ws04-6984acfa`（0002c・0003・0004b・0005・0006・0007） |
| ④ | 統合と、住民（NFT）の確認、登録簿 | ⑤と③のパッチの一本化 |

## 8. 複数の機械（CONNECT-7 §4 から変わらない）

- 送り手の token の台帳と、待っていた要求の再確認は、1つの中継の状態の中でだけ効きます。
- 中継が複数のプロセス・機械で別々の状態を持てば、撤回は別の中継には届きません。
