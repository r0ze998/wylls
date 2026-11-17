# ⑫ 鍵を使わない試験の分離と、⑬ 01ea277e との照合の可否（2026-11-06）

対象：⑫ `ea0636eb60f14189d9954719664147ece4c129ee` に、この回の変更を加えた版（コミットの SHA は報告に記す）。

## 1. ⑬ 01ea277e は GitHub に無い

`git ls-remote origin` で見える 133 個の ref のどれも `01ea277e` を指していない。どの ref の履歴にも含まれていない。GitHub の commit API も「No commit found for SHA: 01ea277e」を返す。⑬の担当ブランチ `origin/claude/eager-cerf-k74z5s` は、まだ `f40ac0d1` のままである。

照合には、次のどちらかが要る。

- ⑬が `01ea277e` を自分のブランチに push する。
- ⑬が git bundle を渡す。作り方は `git bundle create ws13-01ea277e.bundle f40ac0d1..<01ea277e を含むブランチ>`（`f40ac0d1` から先の履歴を含める）。あわせて 40 桁の完全な SHA も渡す。

受け取れば `sh workstreams/12-memory/tools/check-integration.sh <file>.bundle#<完全SHA>` で照合できる。bundle を `git bundle verify` で検査してから、オブジェクトだけを取り込む。ブランチは作らず、変えない。

⑬の `ws12-adapter.test.mjs` と、住民を走らせる比較試験は、⑬の `small()` が `@solana/web3.js` を読み込み、⑬の模擬世界が起動時に鍵を作って署名する。そのため、⑬の新版が来ても鍵を使わない実行では動かない。動かすには、⑬が鍵を作らない入口（固定の公開データの注入など）を用意するか、npm 依存の導入と⑬の鍵生成を承認する必要がある。

## 2. 鍵を使わない試験の分離

- `tools/nokey-guard.mjs`：node:crypto の鍵の生成・導出・署名の入口をすべて例外にする前置きのモジュール。対象は `generateKeyPair*`・`generateKey*`・`createPrivateKey`・`createSecretKey`・`sign`・`createSign`・DH/ECDH・`hkdf`・`pbkdf2`・`scrypt`、および WebCrypto の `generateKey`・`deriveKey`・`deriveBits`・`sign`・`importKey`。他者が作った署名の検証は残す。
- `tools/test-nokey.sh`：この前置きの下で試験を走らせ、1 件ずつ次のどれかに分ける。
  - `ran`：鍵を使わずに成功した。
  - `needs-key`：鍵を作る・使う直前に止まった。この実行では走らせていない。
  - `skipped`：理由を示して skip した。
  - `FAILED`：それ以外の理由で失敗した。本当の失敗なので、終了コードを 1 にする。
- `fixtures/scenario.mjs` の試験用の固定鍵を遅延評価にした。以前は読み込んだだけで 5 人分の鍵を導出していた。今は、署名された allocation を検証するときに初めて導出する。⑬の sidecar 試験は、この fixture を読み込むだけで鍵を使わなくなった。
- `tools/mutate.sh` と `tools/check-integration.sh` も、既定で鍵を使わない実行にした。鍵を使う試験も走らせるのは `WITH_KEYS=1` のときだけ。

## 3. この回に走らせた試験（すべて鍵を使わない実行）

| 試験 | 結果 |
|---|---|
| ⑫の全試験ファイル（`test-nokey.sh`） | ran 41・needs-key 69・skipped 4・FAILED 0 |
| ⑬ f40ac0d1 に⑫を重ねたもの（`check-integration.sh`。⑬の最新として渡されたものではない） | ⑫：ran 42・needs-key 69・skipped 3・FAILED 0。⑬の `ws12-public-evidence.test.mjs`：ran 6・FAILED 0。⑬の `ws12-adapter.test.mjs`：`@solana/web3.js` が無く読み込めない |
| 変異試験（鍵を使わない試験だけで検出） | 80 か所中 46 か所を検出。残る 34 か所は、署名された allocation を通る経路（誰がどの隊商を約束に充てたか）の規則で、鍵を使う試験だけが検出する |

依頼の点と、鍵を使わない試験の対応：

| 点 | 試験（`test/adapters-canonical.test.mjs`） |
|---|---|
| 世界 ID | `/h/season` の各欄の欠落、`continuous` でない世界、別の世界の finality、④のストアの世界の宣言 |
| ゲーム時計 | `bellSecs` を herald から読む。event 行の無い slot・世界開始前・食い違いは不明。⑬の bell は、読み替えが示されるまで `clock_unverified` |
| finalized の根拠 | `commitment: 'finalized'`・出典・世界が必要。herald の `latestSlot` は根拠にしない |
| 欠けたイベント | 時計の無い slot は `clock_unmapped`、spec の無い送出は `dst_unknown` で保留。何も無い約束は `no_record_found` で、「未発送」にはしない |
| 遅延結果 | 確定が途中なら保留し、確定が進んだときに残りが入る。後で読み直しても重複になるだけで、衝突しない |
| 再起動で重複保存しない | 段階ごとに開き直して取り込んでも、各事実は journal に 1 件。複数の run・複数の読み経路で届いた同じ出来事も 1 件 |
| 根拠のない記録を確定扱いしない | 何も無い、確定なし、時計なし、本人の対応なし、送出までしか確定していない、allocation なし——のどの段階でも、約束は `unconfirmed`。評判（r・s・証拠）は動かず、未確定として横に並ぶ |

## 4. 前回の報告の訂正と、この回の逸脱

- 前回（ea0636eb）報告した「111 件」と「80/80」は、固定の試験鍵で署名する試験を含む数だった。鍵を使わない実行に限ると、上の表の数になる。
- **この回の逸脱**：⑬の版の確認の途中で、一度 `tools/mutate.sh` を以前の設定のまま走らせた。そのため、固定の試験鍵（fixture の定数の seed）による導出と署名を含む試験が実行された。実際の鍵・秘密・外部への送信は無い。そのあと既定を鍵を使わない実行に変え、以降はその設定だけで走らせた。

## 5. ④への CI の差分

`handoff/ci-ws12-tests.patch` を作り直した。sha256 は報告に記す。

- job `memory12`：鍵を使わない実行。⑫の試験と⑬の sidecar 試験を走らせる。
- job `memory12-signed`：固定の試験鍵による署名を含む全体。リポジトリ変数 `WS12_SIGNED_TESTS` が `true` のときだけ走る。

統合候補 `ef63544c` と `main` `92142932` の両方で `git apply --check` が通り、適用後の YAML が読めることを確認した。共有の CI ファイルには適用していない。

## 6. 入力の契約（変更なし。07-canonical.ja.md の 1 節）

- `/h/season`
- `/h/events`
- `/h/me/{wallet}`（citizen 口座の WALLET @ 64・CITIZEN_TAG @ 208、アドレス先頭との照合）
- ④の SQLite（読み取り専用）
- finality の表明 `{commitment: 'finalized', slot, world_id, source}`
- ④のストアと herald の世界の宣言 `{ws04World, programId, seasonAddress, source}`
- ⑬へは `read({counterparty, worldBell})`（f40ac0d1 の形）

## 7. 残件

1. ⑬ 01ea277e の受領（push か bundle）と、その上での照合。
2. ⑬に、鍵を作らずに住民を走らせる入口があるか（⑬の判断）。
3. allocation は署名で本人を確かめる設計（v3 の指摘による）。そのため、充当を通る規則 34 か所は鍵を使わない試験では確かめられない。署名済みの allocation を固定の公開データ（あらかじめ作った署名つきの記録）として fixture に持てば、署名せずに検証だけで試験できる。ただし、それを作る時点で一度署名が要る。どうするかは判断を仰ぐ。
4. 前回からの残件（finalized の出し手、④のストアの世界文字列の書式、event 行の無い slot の bell、⑬の bell の表明、sidecar の principal の長さ、coverage の作り手）は、どれもまだ解決していない。
5. 遅れた返済・私的記憶の公開と譲渡は未決なので、変えていない。
