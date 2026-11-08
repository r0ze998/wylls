# 23. 本来のゲームへの接続・⑮との実物の接続・鍵を使わない試験への移行（2026-11-08）

**状態の言い方**（作業の進め方 PR #23 の CLAUDE.md）：実装済み・検証待ち・検証済み・ブロック中。ここに書く試験の結果は cc（この担当）の実行で、**どれも「検証済み」ではない**（検証は Codex）。

**起点**：①は `a110411bb98cabd8ab1f3521cfc1b7d954a27d76`。④の公開の統合候補は `claude/gallant-ride-cunptv` の `cf517b558d1303a84dba618550f40cb460b7ad99`（①は 3f3c8478 の版が入っている）。⑮は GitHub の最新が `preserve/ws15-b1a09a0b`（`b1a09a0b15dd44f587b1158fc40dd3f17577fcca`。④の 06c によれば⑮の cb87e30c は GitHub に無い）。

**許可の範囲（2026-11-08）**：鍵の対の生成・導出・署名はしない（固定の種・CI・呼び出し先も含む）。PDA・with_seed の公開の住所の計算はしてよい。試験は呼び出し先まで確かめたものだけ。

## 23-1. 単位

| # | 単位 | 完了の条件 | 確かめ方 | 依存 | 触るファイル | 状態 |
|---|---|---|---|---|---|---|
| U1 | ①を④の統合候補 cf517b55 に merge できるか | ぶつからずに merge でき、①の鍵を使わない試験が④の no-keys guard の下で通る | 使い捨ての worktree で `git merge ws/01-coop-s1`、`node --import ./scripts/ci/no-keys-guard.mjs --test workstreams/01-national-strategy/test/*.test.mjs` | ④ cf517b55 | なし（①の外は変えない） | 実装済み・検証待ち |
| U2 | ⑮との実物の接続と、二重に数えないこと | ①の板の状態と S1 の記録を⑮の adapter・評価器にそのまま入れ、①の下限と⑮の lowerBound が資源ごとに同じ（届け先の確かめあり）。同じ記録の再読込・同じ隊商の二重の結び付けで量が増えない | `test/coop.ws15.test.mjs`（⑮のファイルがある木だけで走る。無ければ skip） | ⑮ b1a09a0b（④の候補に入っている版） | `coop/export.mjs`、`test/coop.ws15.test.mjs`、`test/coop-chain.mjs`（CARAVAN_RAIDED の bell） | 実装済み・検証待ち |
| U3 | 鍵を使う既存の試験を、入力の差し替えへ移す | ①の `*.test.mjs` がすべて鍵を使わずに通る。移せないものは別のファイルに分け、理由を書く | `test/nokey.mjs` を使う形に直し、guard の下で全体を走らせる | — | `test/nokey.mjs`、`coop.test.mjs`・`coop.continuity.test.mjs`・`coop.longrun.test.mjs`・`coop.send.test.mjs`、`coop.send.wallet-signing.mjs`（分けたもの） | 実装済み・検証待ち |
| U4 | 本来のゲームの入口：ゲームと同じウォレットで署名する | 依頼の画面が、ゲームの `wallet.mjs` が見つける Wallet Standard のウォレット（Phantom などの拡張）を選べる。Dev Wallet は localnet で、選んだときだけ有効になる（有効にすると画面に鍵の種を作るため） | `test/coop.browser.nokey.mjs`（鍵を持たない Wallet Standard のウォレットを画面に登録して押す） | — | `coop/coop-ui.mjs`、`coop/index.html`、`coop/board.mjs`（`--cluster`） | 実装済み・検証待ち |
| U5 | 再起動の後の未確定送信を、本物の画面で | sending の記録が残った送信が着地した後、板を作り直し画面を開き直すと、送る代わりに「着地した隊商 #n を結び付ける」が出て、押すと結び付く | `coop.browser.nokey.mjs` の 5 段目 | U4 | なし（21章の pending.mjs をそのまま使う） | 実装済み・検証待ち |
| U6 | 担当ブランチへの push | `[skip ci]` 付きの通常の push。禁止の CI が動かない。配備・公開が起きない | GitHub Actions の run の一覧、PR の check・status | 外部連携の確認（23-5） | — | 実装済み（48f34e77 を push、branch の workflow run 0 件）・検証待ち |
| U7 | ④・⑮へ連絡 | 契約と差分を、それぞれの会話に送る | 送った文面（23-6） | U1・U2 | — | 送った（返事待ち） |

## 23-2. ⑮との実物の接続（U2）

使ったもの：①の台本（`test/scenario-e2e.mjs`）の板の `state()` と、同じ台本の偽のチェーンの取引のログ（PS2）。⑮の `src/adapters/ws01.mjs`・`src/adapters/s1-chain.mjs`・`src/evaluate.mjs`・`src/rulesets.mjs`（RULESETS.B）・`scenarios/world.mjs`（baseState）を**変えずに**読み込む。S1 の記録は、ゲームの `flog.mjs` の `decodePage` で読む（⑮の想定する入力の形）。⑮の呼び出し先：自分のモジュールと `permutation-gateway/client/src/sha256.mjs`（hash）だけ（鍵・署名・通信なし）。

| 確かめたこと | 結果 |
|---|---|
| ⑮の adapter に fold() の状態をそのまま入れる | **止まる**（`requests` が object：`(board.requests ?? []) is not iterable`） |
| ①の `boardForEvaluators`（契約 ws01-board v1、`coop/export.mjs`）を入れる | 通る。依頼 5 件が project.open、断り 0、S1 の記録の未解決 0 |
| ①が数えた下限（木材 209・石材 200）と、⑮の `resources[r].arrived.lowerBound` | **同じ**（⑮の `destination` に、記録の場所が依頼の届け先と同じかの確かめを入れたとき）。焼かれた石材 50 は⑮でも `raidedBurned` |
| ⑮の今の `linkResolver` のまま | 木材が **30 多い**：別の村に確定した隊商（①は「原因を確認中」で数えない）を、⑮は依頼の到着として数える（場所を見ていない） |
| 同じ記録を二度入れる（再起動・読み直し） | ⑮は重複として除き、量も `verdictHash` も同じ |
| 記録が欠けた板・別の板を混ぜ、同じ隊商が二つの依頼に結び付く | ⑮の adapter は先着（r2）だけを採り `duplicateOf`、①の `allocate` も二つ目を数えない。量は増えない |

⑮へ揃えてほしい点（⑮のコードは変えていない。23-6 で連絡）：

1. `fromWs01Board` は `requests` を配列として読む → ①の `boardForEvaluators(state)` を入力にする（fold() の形は①の板と画面が使うので変えない）。
2. 隊商の鍵は `caravanKey`（`<programId>/<seasonId>:<ownerTag>:<seq>`）。⑮の s1-chain は `epoch` で文脈を分けるが、`linkResolver(place, ownerTag, seq)` には文脈が渡らないので、文脈をまたぐと別の隊商を同じ依頼に引き当てうる。
3. `linkResolver` は、記録の場所（`placeOf(r.dst)`）が依頼の届け先（`to`：kind 1・p・q・site・gen）と同じときだけ依頼の到着とする（①の `isRequestDestination`）。違えば④ QUANTITY-CONTRACT の DestinationMismatch（原因を確認中、数えない）。
4. CARAVAN_SETTLED の記録の cargo が全部 0（1 未満の端数）のとき、⑮は `ship.arrive` を出さないので、その隊商は輸送中のまま残る（①は「0 以上」・Partial・終わった扱い）。

## 23-3. 鍵を使わない試験への移行（U3・U4・U5）

| ファイル | 前 | 今 |
|---|---|---|
| `coop.test.mjs`（27） | testSigner・signRecord・verifySig | 決まった住所の人・`unsigned:<signer>` の印・板の verify の差し替え（`test/nokey.mjs`）。中身の改ざん（同じ署名で答えを変える）の確かめは本物の署名が要るので外した（1 行） |
| `coop.continuity.test.mjs`（3）、`coop.longrun.test.mjs`（2） | testSigner・signRecord | 同上 |
| `coop.send.test.mjs`（14） | Dev Wallet で署名し、偽の中継が手数料の鍵で署名 | 計画（planSend）から `fplay.buildShape` で署名の無い取引の中身を作り、署名の欄に決まったバイト列を入れて偽のチェーンに載せる（`programChain`）。在庫の競合・番号の競合・結果不明・中身の不一致は同じことを確かめる |
| `coop.send.wallet-signing.mjs`（3、**未実施**） | — | ウォレットと中継の署名の経路（sendPlanned → fplay.submit。submit は中継の手数料の鍵の署名を Ed25519 で確かめる）。入力の差し替えでは移せない |
| `coop.browser.nokey.mjs`（8、新） | — | 鍵を持たない Wallet Standard のウォレットを画面に登録して押す。ウォレットを選ぶ・依頼・応答・ゲームから送った隊商の結び付け・到着・再起動の後の未確定送信・取消・スマホの幅 |
| `coop.browser.mjs`（9、**未実施**）、`coop.realrelay.mjs`（4、**未実施**） | — | Dev Wallet の鍵・中継の手数料の鍵・乱数の鍵で署名する。冒頭に理由を書いた |
| `scenario-e2e.mjs`・`coop.e2e.test.mjs`・⑮の JSON | 導出しない住所の表 | 本物の住所（PDA・with_seed。許可された公開の住所の計算）。⑮の JSON の owner tag は本物の S1 の計算の値になった |

## 23-4. 試験（cc の実行。検証待ち）

| 試験 | 場所 | 結果 |
|---|---|---|
| `node --import scripts/ci/no-keys-guard.mjs --test workstreams/01-national-strategy/test/*.test.mjs`（16 ファイル） | ①の木 | 229 通過、5 skip（⑮が無い）、0 失敗 |
| 同上 | ④ cf517b55 に①を merge した使い捨ての木 | **234／234 通過**（⑮との接続 5 件を含む）。guard の拒否 0 |
| `node --import …/no-keys-guard.mjs test/coop.browser.nokey.mjs` | 同じ二つの木 | 8／8 |
| `test/browser.smoke.mjs`（国の卓） | merge した木 | 14／14 |
| 実行していない | — | `coop.send.wallet-signing.mjs`・`coop.browser.mjs`・`coop.realrelay.mjs`（鍵）。本物のチェーン（Agave は未承認） |

guard（④ `525a623f` の `scripts/ci/no-keys-guard.mjs`）は node:crypto・WebCrypto の鍵の生成・署名・導出、@solana/web3.js の Keypair・署名、noble の曲線を、使う前に止める。ブラウザの中のコードは guard の外なので、画面が呼ぶもの（`wallet.mjs` の connect・signMessage、`record.mjs` の signRecord）を読んで確かめた：試験のウォレットだけを呼び、Dev Wallet は有効にしない（`localStorage` の `ps-dev-wallet` が無いことも試験で確かめる）。

## 23-5. push の前の外部連携の確認（U6）

| 連携 | 確かめたこと | 判断 |
|---|---|---|
| GitHub Actions | `.github/workflows/ci.yml` は `on: push`（すべてのブランチ）と `pull_request`。中に鍵を使う試験がある。`doctrine-balance.yml` は手動だけ | push の最後の commit に `[skip ci]` を入れ、push の後に run が無いことを確かめる |
| Vercel・Netlify | PR #20（Web の画面を変えた）・#23 の check はすべて GitHub Actions の CI の job で、commit status は 0、bot のコメントも無い。リポジトリのどの木にも `vercel.json`・`netlify.toml` が無い | 連携していれば PR ごとに status・コメントを出すので、**連携していない**と判断した。ただし各サービスの設定画面はこの環境から見られない |
| GitBook | `.gitbook.yaml` は `claude/determined-ride-engpa4` の `gitbook-design/` にだけある。①のブランチにも main にも無い。GitBook の Git Sync はスペースごとに一つのブランチと同期する | ①のブランチへの push は公開を起こさないと判断した（設定画面は見られない） |

本番の配備は、どの連携でも①のブランチへの push からは起きない（本番は main などの決めたブランチ）と判断した。

## 23-6. ④・⑮への連絡

2026-11-08、①の版 48f34e77 を示して送った（どちらも delivered。返事はまだ無い）：

| 宛先 | 中身 |
|---|---|
| ⑮ session_01C5Nj2bMKyve1rAhRwWMmdb | 23-2 の結果と、揃えてほしい点 (a) 入力は boardForEvaluators（ws01-board v1）(b) 隊商の鍵に文脈 (c) linkResolver の場所の確かめ (d) cargo 0 の確定 (e) 依頼の状態の値。⑮ cb87e30c が GitHub に無いので、版の SHA と bundle を頼んだ |
| ④ session_01C5Nj2aHp7d9xEM41j6obNp | 23-7 の適用の仕方（cf517b55 への merge・合成した木 0ce703ce・guard の下の試験の結果）、QUANTITY-CONTRACT §7 ①への対応、共有パッチの照合（0002b の名前は⑤のパッチと別物）、⑮との接続。0002b の採否を頼んだ |

## 23-7. ④への適用の仕方

- ①のブランチ `ws/01-coop-s1` は 3f3c8478 の子孫で、①の外のファイルを変えていない。④の候補 cf517b55 に `git merge ws/01-coop-s1` でぶつからずに入る（U1）。
- 共有のパッチは①のブランチでは当てていない。④の候補には 0002b（0002 ではない）・0003・0004 が当たる（22章 22-2）。
- 試験：④の 06c §4 の「⑥ ① ⑮ ⑭ ⑧ の Node の試験（guard 付き）」の行で、①は guard が止める件が 0 になる見込み（今の①の `*.test.mjs` は鍵を使わない）。

## 23-8. 残件・ブロック中

| 残件 | 状態 | 必要なもの |
|---|---|---|
| ゲームの村の引き出しの入口（提案 0003、⑦の `s1.mjs`） | ブロック中（⑦の判断） | ⑦の採否。cf517b55 には当たる |
| 0002b（ヘラルドの `ended`） | ブロック中（④の判断） | ④の採否 |
| 本物のチェーンでの一巡 | ブロック中 | Agave 3.1.9 の導入の承認 |
| ウォレット・中継の署名の経路の試験（3＋9＋4 件） | ブロック中 | 鍵の使用の許可、または署名を確かめない中継（本番のコードの変更が要る） |
| ⑮の adapter の直し（23-2 の 1〜4） | ⑮の判断 | ⑮の版 |
| 「判定できない」をなくす | ④・プログラムの担当 | P1 案 A（milli で正確な credited） |
| 前の文脈の口座が閉じた後の証拠、文脈の正本 | ④⑧ | 20章 M1〜M4 |

## 23-9. ⑮の返事と、⑮の新しい版での照合（2026-11-08 の後半）

⑮は (a)〜(e) に対応し、`claude/determined-maxwell-uhc6a3` `2a3a0c946f5ec31911da51282937f04deca9abcb`（tree `c154f2cb…`、[skip ci]）に push した。⑮の変更は `workstreams/15-coop-outcomes` の中だけで、加えた import は node:fs・os・path だけ（鍵・署名・通信なし。試験のファイルは `createHash` だけ）。

| 確かめたこと | 結果（cc の実行、検証待ち） |
|---|---|
| ④ `f7d3b70d` ＋ ① ＋ ⑮ `2a3a0c94` の merge（使い捨て、tree `b70d9564…`） | ぶつからない |
| その木で①の `*.test.mjs`（guard） | 234／234 |
| その木で⑮の `*.test.mjs`（guard） | 133／133 |
| `coop.browser.nokey.mjs` | 8／8 |

⑮から届いた①の試験の差分（`workstreams/15-coop-outcomes/patches/ws01-coop-ws15-test-48f34e77.patch`。⑮の新しい挙動に合わせた 3 か所）を当てた。そのうえで、⑮の版を名前ではなく振る舞いで見て、合わない版では理由つきで skip するようにした（④の候補には⑮ `95f44cf3` が入っており、それは requests の object は読むが、linkResolver が場所を見ない）：

| ⑮の版 | `coop.ws15.test.mjs` |
|---|---|
| `2a3a0c94`（⑮の最新） | 5 通過 |
| `95f44cf3`（④の候補 f7d3b70d の中） | 3 通過・2 skip（場所を見ない版） |
| `b1a09a0b` | 2 通過・3 skip |

## 23-10. ゲームの村のカードからの入口（⑦、2026-11-08）

⑦は提案 0003 を当てず、村のカードの既存の枠（`hud/coopentry.mjs`）に①の入口を登録した：`claude/wylls-ui-ux-visual-oixhgs` `f28911882be2a74f3e99bcaa69d753cf96a4e7f1`（`hud/coopboard.mjs`）。⑦は同じ origin の `GET /coop/config` を読み、404 なら出さず、読めなければ理由つきで押せなくし、`?to=p,q,site,gen` で①の画面を新しいタブで開く。

- ①：`/coop/config` に `page`（この板の画面の道、同じ origin）を足した。0003 は不要（当てない）。
- **食い違い（⑦へ連絡）：** ⑦は `String(config.season)` を今のシーズン ID と比べるが、①の `season` は `{programId, seasonId}` の object。①の本物の config を⑦の `boardState` に入れると、いつも「別の世界（シーズン）」になり押せない（使い捨ての worktree で確かめた）。`config.season.seasonId` と比べれば通る（同じ確かめで、季節の確かめを通り、村の選択の段に進む）。①は `season` の形を変えない（①の画面が使う）。
- `coop.test.mjs` の HTTP の試験で、config の `season` の形と `page` を確かめる。
- 2026-11-08：⑦が直した（`claude/wylls-ui-ux-visual-oixhgs` `243693829bb3d1af5d86e4b7a90c7314fe42371c`、[skip ci]）。①の本物の config を⑦の `boardState`・`boardHref` に入れて確かめた（cc、検証待ち）：同じシーズンは季節の確かめを通って村の選択の段へ、別のシーズンは「別の世界」で押せない、開く先は `config.page`。
