# 鍵を使わない CI（④、2026-11-06、提案・未適用）

**規則**（利用者）：鍵の生成・導出・署名を伴う試験は、共通セットアップも含めて行わない。push で自動的に起動する CI でも同じ。

## 1. 現状（`.github/workflows/ci.yml`、main と全担当の branch で同じ内容）

- **起動条件**：`on: push`（branch の指定なし）と `pull_request`。
  - そのため、**どの branch に push しても**、全 9 job が動きます。
  - `doctrine-balance.yml` は手動（`workflow_dispatch`）だけで、鍵も使いません。
- **鍵を使う段**（`scripts/ci/check-ci-keyfree.py` で機械的に数えた結果は 14 件）：

| job | 段 | 何が鍵を使うか |
|---|---|---|
| program | `permutation-chain/svm-tests/run.sh` | LiteSVM の試験（Keypair の生成・署名）、SBF build |
| frontier-program | SBF v2 build ×2、Prize SBF build、LiteSVM G1–G13 | LiteSVM の試験。`cargo-build-sbf` は program の keypair が無いと作る（作らないことを、まだ確かめていない。鍵の生成として扱う） |
| prize-program | Prize SBF build、`permutation-prize/svm-tests`（LiteSVM） | `tests/pool.rs` が Keypair を生成して署名する |
| frontier-node | `cargo test --workspace`（debug と release） | test payer の seed からの導出（`Payers::new`）、署名した取引、test-beacon の鍵（drand-replay `--test-key`） |
| gateway | `npm test` | 262 件の試験ファイルのうち 94 件が、自分で、または import した test helper や src を通して、`Keypair.generate`・`fromSeed`・`generateKeyPairSync`・`createPrivateKey`・`subtle.importKey`（秘密鍵）・署名を使う（83 件は静的な走査で、11 件は guard が実行中に止めて見つけた） |
| receipt-tests | `npm test` | client と server の試験 4 件が Keypair・署名を使う |

- **実際に動いた記録**（GitHub Actions、2026-11-05〜06、push で起動したもの）：

| branch | 回数 |
|---|---|
| ④ `claude/gallant-ride-cunptv` | 16 回（すべて success。Prize と Frontier の LiteSVM の段、frontier-node の試験も完了） |
| ⑳ `claude/funny-wozniak-cy4n64` | 13 回 |
| ⑯ `claude/dreamy-ramanujan-ijj8qj` | 9 回 |
| ⑨ `claude/elegant-bohr-co2uhr` | 5 回 |
| ⑩ `claude/great-babbage-3ogkqu` | 4 回 |
| ⑬ `claude/eager-cerf-k74z5s` | 4 回（1 回は照会した時点で実行中） |
| ⑫ `claude/trusting-allen-dox8j6` | 3 回 |
| ⑪ `claude/kind-fermat-earbxe` | 2 回 |
| `integration/ws09-13-v16-d0949fd4` | 3 回 |

**つまり、禁止された試験は、すでに CI で動いています。** 鍵は CI の runner の中で作られる試験用の鍵で、本物の資金とは結びついていない、と④は判断しています。ただし、それを確かめる手段はありません（log は読んでいません）。

## 2. 提案（この commit の `ci.yml`）

- **起動条件**：`push`・`pull_request` はそのまま。`workflow_dispatch` を足し、入力 `key_tests` の既定値を `no` にする。
- **鍵を使う段**：上の表の段は**消さずに**、`key-tests` job へ移します。中身は変えていません。
  - この job は `if: github.event_name == 'workflow_dispatch' && inputs.key_tests == 'approved'` のときだけ動きます。push と pull request では決して動きません。
- **機械的な検査**：`scripts/ci/check-ci-keyfree.py` を足し、browser-smoke の段として毎回動かします。
  - `key-tests` 以外の job に、LiteSVM、SBF build、Agave の install、`npm test`、`cargo test --workspace`、鍵の CLI が入ると失敗します。
  - `key-tests` の `if` が上の形でなければ、失敗します。
  - 現状の ci.yml では 14 件、提案では 0 件です。
- **Node の試験**：`scripts/ci/node-keyfree.sh` で動かします。仕組みは三段です。
  1. 一覧 `scripts/ci/node-key-tests.txt`（98 件。`scripts/ci/scan-node-key-tests.mjs` が、ファイルと、それが import する test helper を辿って作った 87 件と、guard が実行中に止めた 11 件）にあるファイルは動かしません。
  2. 一覧が古い（走査の結果と違う）か、一覧にないのに鍵の API の名前を含むファイルがあれば、その時点で失敗します。
  3. 動かす全ファイルに `scripts/ci/no-keys-guard.mjs` を先に読み込ませます。import の先で鍵の操作に届いても、その場で `NoKeysGuard` として拒否されます。
     - 対象は次のとおりです。node:crypto の鍵生成・署名・導出、WebCrypto の generateKey・sign・deriveKey・deriveBits・秘密鍵の importKey、web3.js の Keypair.generate・fromSeed・fromSecretKey と Transaction の sign、@noble/curves と、web の sdk に同梱した noble の BLS12-381 の sign・getPublicKey・randomPrivateKey。
     - 確認：6 種の呼び出しを、6/6 実行前に拒否しました。
     - 限界：この guard は、知っている API を拒否するだけです。試験が自前で持ち込んだ別の実装は拒否できません。
- **新しい job `exec-native`**：④ の `e2e-native`（本物の prize と game の program を host で動かす。鍵なし）。
- **frontier-node**：fmt と clippy（全 target を compile するが、実行はしない）、それに `findex` と `herald` の lib の試験だけを動かします。
  - `keeper` の lib の試験は、`Payers::new(&[9; 32])` で導出するので、外しました。

### 実行する検査と、実行しなくなる検査

| 実行する（push・PR） | 実行しなくなる（`key-tests` だけ。承認があるまで未実行） |
|---|---|
| browser-smoke の全部と、鍵の検査 | permutation-chain の SBF build と LiteSVM |
| receipt の Rust（fmt、clippy、test）、npm audit、Node の鍵なしの試験 2 ファイル（13 件が合格） | receipt の Node の試験 4 ファイル |
| Rules、permutation-chain の host、layouts、server の試験と bins | Frontier の SBF v2 の再現 build（2 回、hash の一致、e_flags） |
| frontier-sim の全部 | Prize の SBF build |
| gateway と web の鍵なしの試験ファイル 168 件（guard 付き） | gateway と web の 94 件 |
| check-v9-frozen、fmt、Rules の clippy、ABI の clippy・試験・vector、Frontier の host の試験（既定と no-default） | Frontier の LiteSVM の G1–G13（CU の上限を含む） |
| frontier-node の fmt・clippy、findex と herald の lib の試験 | frontier-node の workspace の試験（debug、release） |
| frontier-wasm の 2 つの build と hash | Prize の LiteSVM（fmt、clippy、試験） |
| prize の fmt・clippy・host の試験、exec-native | — |

**失う安全性**：SBF の build が本番と同じ形か（e_flags、overflow の検査、2 回の build の hash の一致）、CU の上限、LiteSVM での実際の取引。これらは、承認のうえで手動で動かすまで確かめられません。

### 手元での確認（2026-11-06、この木で。鍵は使っていない）

- `scripts/ci/check-ci-keyfree.py`：提案した ci.yml は 0 件。今の ci.yml は 14 件。
- guard：6 種の鍵の操作を、6/6 実行前に拒否した。
- gateway：`scripts/ci/node-keyfree.sh permutation-gateway 'test/*.test.mjs' 'screens/logic.screen.mjs'` を実行した。
  - 結果：試験ファイル 168、試験 1,722 件。合格 1,721、失敗 0、skip 1。guard の拒否は 0 件。
  - 途中で guard が 11 ファイルを止めた。src の鍵の生成・導出・署名に届いていたので、一覧に足した。
- receipt：2 ファイル、13/13 合格。
- exec-native：12 + 3 + 4 + 1 件が合格。fmt も通過。
- GitHub での実行は、まだしていません（push していないため）。

## 3. 適用の注意（④は push していません）

- **新しい ci.yml の効き方**：push の起動では、**push された commit の中の ci.yml** が使われます。
  - この変更を含む commit を push すると、その run は新しい ci.yml で動き、鍵を使う段は動きません。
  - ただし、この変更を**含まない** branch（main と、ほかの全担当の branch）では、push のたびに今までどおり動きます。
  - 全担当が止まるのは、この変更が各 branch に入るか、main に入ってから各担当が取り込んだ後です。
- **当面の推奨（利用者の判断）**：この変更が入るまで、どの担当も push を止める。または、Actions を repository の設定で一時的に無効にする（Settings → Actions → Disable actions）。後者は④には操作できません。
- **実行中の run**：⑬（`claude/eager-cerf-k74z5s`）の 1 件が、照会した時点で実行中でした。取り消すかどうかは利用者の判断です。④は操作していません。
- **自動の配備・公開・課金**：
  - ci.yml と doctrine-balance.yml に、配備・公開の段はありません（`permissions: contents: read`、secret を使わない）。
  - **Actions の分（minutes）**：repository が private なら、owner の無料枠を消費し、超えれば課金されうる。公開か private か、課金の設定は、④からは**不明**です。
  - **GitBook**：`claude/determined-ride-engpa4` に `gitbook-design/.gitbook.yaml` があります。GitBook の Git Sync が設定されていれば、push で公開されうる。設定は GitHub の外にあり、④からは**不明**です。
  - ほかの配備の設定（vercel、netlify、pages、fly、Docker など）は、main・④・GitBook の branch のどれにも見つかりませんでした。
  - `claude/nice-edison-3boh5r` の Artifact build script は手動の変換で、自動の公開はありません。
- **各担当の push 先**（GitHub で見えるもの）：

| 担当 | branch |
|---|---|
| ④ | `claude/gallant-ride-cunptv` |
| ⑨ | `claude/elegant-bohr-co2uhr` |
| ⑩ | `claude/great-babbage-3ogkqu` |
| ⑪ | `claude/kind-fermat-earbxe` |
| ⑫ | `claude/trusting-allen-dox8j6` |
| ⑬ | `claude/eager-cerf-k74z5s` |
| ⑯ | `claude/dreamy-ramanujan-ijj8qj` |
| ⑳ | `claude/funny-wozniak-cy4n64` |
| ①②③⑤⑥⑦⑧⑭⑮⑰⑱⑲ | `preserve/*`（10 月末以降の push はない） |
| ③（`modest-goldberg`）、gitbook（`determined-ride`）、その他 | 誰の push かは不明 |
