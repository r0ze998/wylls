# 22. ④の現在版との照合、依頼から照会までの一続きの接続、⑮へ渡す fold() の出力

**状態（2026-11-06）：** ブランチ `ws/01-coop-s1`、起点 `205058916c45839cbe18af165cdde4baaa7e85f0`。**鍵の生成・導出・署名を伴う試験は、共通の準備も含めて行っていない**（22-6）。共有コードは変えていない。

## 22-1. ④の現在版

| | 版 |
|---|---|
| ④の現在版 | `claude/gallant-ride-cunptv` `8e96f24df4aa4ed51277fa42de6a354a21cd2bc6`（2026-11-06。`workstreams/04-execution` を変えた最新のコミット） |
| ①が前に照合した版 | 受領版 `2e536b6b`（`8e96f24d` の祖先） |
| ④の量の正本 | `docs/QUANTITY-CONTRACT.ja.md`（CONTRACTS・HANDOFF・STATE-MACHINE と食い違えばこれを正とする、と④が書いている） |

④が①に揃えてほしいと書いた点（QUANTITY-CONTRACT §7 ①）と、①の対応：

| ④の求め | ①の前 | ①の今（場所） |
|---|---|---|
| 村あての RuleDerived は整数の**下限**：実際は［b, b＋1） | 「整数単位の入荷量」と書き、表示は「届いた n」 | 量の区間 `amount`（`lower-bound`・`unknown`・`zero`）を到着ごとに出す。表示「届いた 木材 119 以上」（`ws04.mjs` `amountOf`・`deliveredText`） |
| 記録の cargo が 0 なだけでは KnownZero にしない（1 未満の端数） | 下限 0 の到着を Failed にしていた（`toWs04Terminal`） | RuleDerived の 0 は Partial、「0 以上」。0 と分かるのは焼却・奪取の記録、口座の持ち主の書き換え、LOST だけ |
| 別の宛先で確定しただけでは「奪われた」にしない（DestinationMismatch、量を述べない、相手の名前や評判に使わない） | `misdelivered` を KnownZero（0）にしていた | `misdelivered` は `delivered: null`・`verification: null`・`held: 'DestinationMismatch'`、「別の場所に着いた（原因を確認中）」。④の終わりは `DestinationMismatch`（保留） |
| ヘラルドの一覧からの推定 2 か所（襲撃の印＋cargo 0 ⇒ 焼かれた、行き先違い ⇒ 奪われた） | そのとおり推定していた（`arrival.mjs`） | 前者は `raided-unconfirmed`（記録で確かめていない）、後者は `misdirected`（原因を確認中）。チェーンの隊商の口座で行き先が違うときは、口座の持ち主（OWNER_CITIZEN）が送った人でなければ奪われた証拠（take だけが書き換える）、同じなら `misdirected` |
| 合計の目標は三つの区分（達成・未達・判定できない）。下限の和が目標未満なだけで「未達」としない | 依頼の充足を partial／failed などで出していた。共同の目的は「未達成」 | 依頼の充足を **fulfilled（下限 ≥ 依頼量）／not-reached（すべて終わり、上限 ≤ 依頼量）／undetermined（その間・輸送中・原因を確認中）** に（`fulfilmentOf`）。共同の目的は依頼が増えうるので「未達」を証明せず、「まだ達成と言えない」（`verdict: 'undetermined'`） |
| Fulfilled／Partial は run の依頼量（`spec.ship.cargo`、損耗の前）と下限 b の比較 | 送った荷（CARAVAN_SENT の cargo）と比べていた | 同じ（命令の整数単位の荷 ＝ CARAVAN_SENT の cargo）。変えていない |

上限は「未満」で持つ（`maxExclusive`・`upperExclusive`）。村あて b＋1、量を確認できない到着は cargo_logged＋1、受取人・時刻が未検証の到着も b＋1（後で数えうる）、0 と分かる到着・受取人が依頼した人でないと分かった到着・応じる前の送信は 0。

## 22-2. 共有パッチ（二重に当てない）

`git fetch` の後、2026-11-01 以降に更新されたすべての origin のブランチと main で確かめた（`git apply --check` と `-R`、共有ブランチには何も当てていない）：

| ブランチ | 0002 | 0002b | 0003 | 0004 |
|---|---|---|---|---|
| ④の現在版 `gallant-ride-cunptv` `8e96f24d`、統合 `integration/ws09-13-v16-d0949fd4` `ef63544c`、`great-babbage` `79fbce83`、`eager-cerf` `de6df669` | ぶつかる | **当たる** | 当たる | 当たる |
| main `92142932` ほか 7 本 | **当たる** | ぶつかる | 当たる | 当たる |

- どのブランチでも、0002 と 0002b の**どちらか一方だけ**が当たり、どちらも「もう入っている」ではない（二重に当たらない）。ヘラルドの `caravan.rs` は④の現在版と統合で同じ blob（`6a7a3478`）。
- ④の現在版の使い捨ての worktree に 0002b を当てて `cargo test --offline -p herald --lib` **40／40 通過**（終わってから worktree を消した）。
- **名前の重なり：** ④の `bridge/probe-0002b-sendcaravan.test.mjs` の「0002b」は**⑤の共有パッチ**（衝突した取引を組み直す）で、①の 0002b（ヘラルドの `ended`）とは別物。

## 22-3. 依頼から照会までの一続き（`test/scenario-e2e.mjs`、`test/coop.e2e.test.mjs` 6 件）

| 段 | 本物のコード | 偽物 |
|---|---|---|
| 依頼・応答・sending・結び付けの記録 | `board.mjs` の受け取り、`record.mjs` の `fold`（`createFolder`）、`store.mjs` の区間（4 KB で閉じる） | 記録の署名（`sig: 'unsigned:<signer>'` を確かめるだけの `verify` に差し替え） |
| 送出 | `send.mjs` `planSend`（Citizen・村・州の口座から送り元・道・番号）、ゲームと同じ `fplay.buildShape`（署名の無い取引の中身） | 署名の欄（決まったバイト列）、チェーン（着地） |
| 送信の結果 | `chain.mjs` `sendOutcome`（取引の中身が計画と一致するか） | — |
| 到着の結果 | `caravanHistory`・`arrival.mjs`・`goal.mjs`・`ws04.mjs` | チェーンの記録（CARAVAN_SENT・SETTLED・RAIDED） |
| 再起動の後の照会 | 同じフォルダで板を作り直して `view` | — |
| 住所 | — | `ids.mjs` `tableAddresses`（番号を振るだけ。find_program_address・create_with_seed を呼ばない） |

確かめたこと：着地の前の二度目の送付を断る → 着地 → **板の再起動** → 照会で `landed` → 結び付けの前の送付を断る（`landed-unlinked`）→ 結び付け → 確定 → 依頼 5 件がそれぞれ fulfilled／undetermined（下限 9・上限 11 未満）／not-reached（焼却）／undetermined（原因を確認中）／not-reached（1 未満の端数、上限 1）→ **もう一度再起動**して照会が同じ（記録の数も同じ、二重に数えない）。

## 22-4. ⑮へ渡す fold() の出力（`test/fixtures/ws15-fold-e2e.json`）

上の台本の板の `state()`（`createFolder` の状態そのもの。保存した記録を `fold()` で畳み直しても同じことを試験で確かめる）と、同じ板の照会の抜き出し（到着ごとの `amount`・`terminal`・`counted`・`countUpper`・`countFinal`、依頼ごとの `fulfilment`、共同の目的）。2 回作って同じバイト列（決まった時計・決まった値）。作り直し：`node workstreams/01-national-strategy/test/make-ws15-fixture.mjs`。

**本物と違う値：** ウォレット・住所・owner tag・署名の欄は試験用の決まった値。owner tag（例 `1003`）は導出しない住所の表の番号で、本物の S1 の値ではない（本物は Citizen の住所の先頭 8 バイト）。

⑮の `src/adapters/ws01.mjs`（`preserve/ws15-b1a09a0b`、伝え聞いた形で書かれたもの）との食い違い（この JSON を⑮の関数に入れて確かめた。⑮のコードは変えていない）：

| ⑮が仮定した形 | ①の実物 |
|---|---|
| `requests` は配列 | **id を鍵にした object**。そのままでは `(board.requests ?? []) is not iterable` で止まる。`Object.values(requests)` にすると通る（事象 1 件、断り 0） |
| 隊商の鍵 `${ownerTag}:${seq}` | 鍵に**文脈**を含む：`link.caravan.ctx`（`<programId>/<seasonId>`）。Citizen はシーズンごとの口座で番号も 0 から。文脈をまたぐと同じ `ownerTag:seq` が別の隊商になりうる |
| 依頼の状態 `open`・`accepted` | 記録の状態は `open`・`cancelled` だけ。期限切れは時刻で読む（`stateAt` → `expired`）。`accepted` は無い（応答は `responses[wallet].answer`） |
| link の欄 `{responder, caravan, at}` | そのとおり。加えて `claimedNation`（申告。判定に使わない）、`n`（記録の順）。先着は `n`（受け取った順）で決まる |
| — | `sendings`（結果不明の送信の記録）、`rejected`・`accepted`（記録の ID）、`left` |

量は①の到着の見え方ではなく S1 の記録から取る、という⑮の分担は①と食い違わない。①の照会の `amount` は、⑮が「判定できない」を出すときの照合用に使える。

## 22-5. ①の中で変えたほかのもの

- `coop/ids.mjs`：住所と owner tag の決め方を一か所に（本番はゲームと同じ `faddr.mjs`、試験は導出しない表）。`record.mjs`・`chain.mjs`・`goal.mjs`・`board.mjs`・`send.mjs`・`test/coop-chain.mjs` はここを通す。
- `createBoard({verify})`：記録の署名の確かめを試験でだけ差し替えられる（既定は Ed25519 の `verifySig`。CLI からは変えられない）。
- 画面の言い方（22-1）。鍵を使うので実行していない `coop.test.mjs`・`coop.browser.mjs` の期待も、新しい言い方・状態に合わせた（1 か所ずつ）。

## 22-6. 試験

| 試験 | 鍵・署名・住所の導出 | 結果 |
|---|---|---|
| 試作 8 ファイル（161）、`coop.contract04`（7）、`coop.nokey`（9）、`coop.e2e`（6、新） | なし | **183／183 通過** |
| ヘラルド `cargo test --offline -p herald --lib`（④の現在版 `8e96f24d` ＋ 0002b、使い捨ての worktree） | なし | **40／40 通過** |
| `coop.test`・`coop.send.test`・`coop.continuity.test`・`coop.longrun.test`・`coop.browser`・`coop.realrelay` | `testSigner`・`signRecord`・Dev Wallet・本物の住所の導出 | **実行していない** |
| 国の卓 `browser.smoke` | なし | **14／14 通過** |

画面（`coop-ui.mjs`）はブラウザで確かめていない（依頼の画面の試験は Dev Wallet の鍵を使う）。`node --check` だけ。

## 22-7. 残件・決めてほしいこと

1. 鍵を使う試験（上の 6 ファイル）を、固定の試験用の種で回してよいか。今回の差し替えの口（`verify`、`useAddresses`）があるので、署名・導出をしない形に書き直すこともできる（どちらにするか）。
2. ⑮の adapter の直し（`requests` を object として読む、隊商の鍵に文脈を含める）は⑮が行う。①は形を変えない（変えるなら⑮と合わせる）。
3. 「判定できない」をなくすには④の P1 案 A（milli で正確な `credited`）が要る（④ patches P1、④の 4.）。①は案 A・案 B のどちらでも読めるよう、`Recorded` を下限として扱っている。
4. 本物の owner tag を入れた fold() の出力が要るなら、住所の導出を伴う（Citizen の住所 → 先頭 8 バイト）。承認があれば作る。
5. 本物のチェーンでの確認：Agave の導入が未承認のまま。
