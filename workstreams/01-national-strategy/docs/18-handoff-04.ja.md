# 18. ④への引き渡し：依頼と到着量の契約・共有コードのパッチ

**状態（2026-10-30）：** ブランチ `ws/01-coop-s1`（`ccc2f8e` から）。ローカルの実装とテストまで。**本物のチェーンでは未検証**（Agave 3.1.9 を入れる操作は許可されず、回避していない。17章 17-4b）。

## 18-1. ①が使う到着量の正本と順番

| 順 | 何で確かめるか | 使い道 |
|---|---|---|
| 1 | **チェーンの取引の記録**：隊商の口座の住所（`faddr` の Caravan、`ownerTag`・`seq` から）に触れた取引を `getSignaturesForAddress` → `getTransaction` で読み、**このプログラムが出した**（ログの invoke の入れ子で判定）**成功した取引**の PS2 の記録 CARAVAN_SETTLED（92）・CARAVAN_RAIDED（93）を `flog.mjs` の `decodeRecord` で読む（`coop/chain.mjs` `caravanEndFromChain`） | **量を数えるのはこれだけ**（`source: 'chain-log'`、取引の署名つき） |
| 2 | チェーンの隊商の口座（輸送中だけある。確定で閉じる：`caravan.rs` `close_caravan`）：`OWNER_CITIZEN`・`STATE`・`DST`・`CARGO` | 結び付けの確かめ（持ち主・輸送中・行き先・積荷） |
| 3 | ヘラルドの `h/caravans.json`（`moving`、パッチ 0002 の `ended`） | 表示と、チェーンの記録との突き合わせ（食い違いは `heraldDisagrees` で示す）。量は数えない |

**実入荷量：** ④の分類に合わせた（19章）。村あては RuleDerived（整数単位で記録の cargo が入荷量。加算処理との対応は19章 19-2）、倉あては Unverifiable、届かなかったものは KnownZero。依頼の届け先は村だけ。

## 18-2. 契約（1本の隊商ごと）

`{ requestId, caravanId: {ownerTag, seq}, owner: {ownerTag}, responder, state, delivered, verification, cargoLogged, dstGen, basis, source, signature, note, recipient, currentOwner, counted, notCountedWhy, heraldDisagrees?, duplicateOf? }`（2026-10-30、④の受領版 2e536b6b に合わせて改めた。照合は19章）

- `state`：`moving` / `delivered` / `misdelivered` / `lost` / `raided-taken` / `raided-burned` / `unknown`
- `delivered`・`verification`：④と同じ意味。村あて DELIVERED は `RuleDerived`（cargo を整数単位の入荷量）、倉あては `null`・`Unverifiable`、LOST・襲撃・別の場所は 0・`KnownZero`、チェーンの記録がまだなら `null`・`null`
- `recipient`：到着時の受取人（村の世代が到着の記録と同じときだけ今の口座から。違えば未検証）。`currentOwner`：今の持ち主
- `counted`：共同の目的に数えた量（Recorded・RuleDerived で、受取人が依頼した人で、重複でないときだけ）
- `duplicateOf`：同じ隊商が二つ目の依頼に結び付いていたとき（数えない）
- 届け先の持ち主（Holding の `OWNER_CITIZEN`・`GEN`）と国（Citizen の `WALLET`・`FACTION`、`EXPELLED_SINCE` が0でなければ国籍未検証）もチェーンで確かめる（`coop/chain.mjs`）

## 18-3. 共有コードのパッチ（どれも未適用。④がまとめて判断）

| パッチ | 中身 | 確認 |
|---|---|---|
| `proposals/0002-herald-caravan-ended.patch` | ヘラルドの `h/caravans.json` に `ended`（確定・襲撃、新しい512件）。`cargo` は積荷で加算量ではない、と説明 | `git apply --check`。当てて `cargo test --locked -p herald --lib` 39件 pass。①はこれがなくても、チェーンの記録で数える（表示が「不明」になるだけ） |
| `proposals/0004-fcodec-i16-array.patch` | 共有の `fcodec.mjs` が `[i16;N]`（Caravan の `PROVINCES`）を読めず、Caravan の口座の decode が例外になる。型を1つ足す | `git apply --check`。当てても当てなくても `permutation-gateway` の `web-*.test.mjs` は同じ結果（911件中 pass 896・fail 14。fail 14 は当てる前からある）。①は表の名前で直接読むので、これに依存しない |
| `proposals/0003-s1-coop-entry.patch`（⑦向け） | 村の引き出しに「国をまたぐ依頼」の入口 | `git apply --check` |

## 18-4. ①が④から受け取りたいもの（手元にない）

④の最新 `bd415e7` は、この作業の手元・`git fetch`・GitHub の API のどれでも取得できなかった。照合に要るのは次の3つ：

1. ④の**到着の確定の契約**の文書（到着状態・検証済み量の欄と意味）。特に「検証済み量」が積荷か加算量か。
2. **倉あての加算量**をどう記録する案か（プログラムの CARAVAN_SETTLED に加算量を足す／ヘラルドが同じ取引の前後の倉の口座を比べる／記録しない）。
3. ④が `h/caravans.json` 以外の新しい公開物（到着の一覧など）を作るなら、その形と、チェーンの取引の記録との対応（取引の署名を載せるか）。

これが届いたら、18-2 の欄を④の名前と意味に合わせ、①の数え方（18-1）が④の検証済み量と一致するかを確かめる。
