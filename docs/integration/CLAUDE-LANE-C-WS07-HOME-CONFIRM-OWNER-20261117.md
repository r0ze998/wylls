# Lane C ⑦：最初の村の確定（confirmHome）の帰属 — 本人・世界が替わったとき（2026-11-17）

- ブランチ：`claude/lane-c-ws07-home-confirm-owner-20261117`（起点 `9f935e73`）
- 実行：**何も実行していません**。試験、構文の確認、import、ページ、world、guard、runner、ウォレット、送信のどれもです。回帰は書いただけです。実際のページ・実際の送信では確かめていません。
- 位置づけ：既存の保存 key・保存場所・控えの形・送信の決まりの中でできる保護だけです。新しい保存先、新しい範囲、新しい決まりは足していません。1〜20の完成ではありません。

## 確認した実経路（変更前、ソースを読んだもの）

`confirmHome()` は、`busy` を立てたあと、次の待ちをはさみます：接続（`ACTIONS.connect`）、`refresh()`、控えの確認（`tx.track`／local play は `recheckLocalPending`）、`loadEnvelope`、`ACTIONS.join()`、`waitForOwn`（最大5回の `refresh`）、`ACTIONS.session()`、`act('PlaceHome')`。

| 経路 | 起きること |
|---|---|
| 待ちのあとの `pending()`／`error()` | `FS.homeChoice` を**その時点で**引くので、本人が替わって作り直された一覧に、前の確定の表示・エラーを書く。一覧が無い（`resetViewer` 直後）ときは null 参照で落ちる |
| `finally` | `FS.homeChoice.busy = false`。新しい一覧が自分の確定を始めていれば、その `busy` を外す（二重の確定を始められる） |
| 待ちのあとの後続 | `FS.citizen`／`FS.session`／`FS.holdings` を読んで続行する。本人が替わっていても、Join・SetSession・PlaceHome へ進みうる |
| 控えの確認のあとの消去 | `saved.pending.kind === 'Join' && FS.citizen` で控えを消す。待ちのあとに本人が替わっていると、**別の本人の記録が見えた**ことで、**いまの key** の控えを消す |
| PlaceHome の `onSent`／`onLost` | `saveHomePatch`＝**callback が呼ばれた時点**の key（世界＋本人）。送信の待ちの間に替わると、送った署名を別の本人・世界の記録へ書く。元の記録には何も残らない |
| 通常の Join の `onSent`／`onLost` | さらに `if (FS.homeChoice?.busy)` を **callback の時点**で見る。本人が替わって一覧が捨てられていると、**送った署名をどこにも書かない**。新しい本人が確定中なら、その記録へ書く |
| 訪問者 → 接続 | `adoptConnectedWallet` → `resetViewer` が `FS.homeChoice` と `FS.joinDraft` を捨てる。続きは、作り直された（`busy` でない）一覧で動き、選択が無ければ null 参照で落ちて一般のエラーになる |
| local play | `settleLocalSend` が、範囲が替わっていたら callback を呼ばない（既存の決まり。署名はページの中の台帳が持つ）。上の「別の記録へ書く」は起きない |

## 既存の保存の契約（調べたもの。変えていません）

- key：`wylls-home:v1:{cluster}:{programId}:{seasonId}:{本人}`（`home.mjs` `homeKey`。本人＝NFT の asset、なければウォレット、なければ `visitor`）。
- 場所：通常は端末の保存、local play はページのメモリだけ（`homeStorage`）。
- 形：`{ v: 1, selected, pending: { kind: 'Join'|'PlaceHome', signature, scope? }, seen }`。`scope` は local play の送信だけが付けます。
- 控えを消すのは：確認で失敗・期限切れ／Join で本人の記録が見えた／送信の `onLost`／最初の村を見た（`ackHomeGrant`、`updateHomeGrant`）。

## 変更（`controller.mjs` だけ）

1. **補助**：`homeNoteNow()`（いまの key と場所を一度に控える）、`saveHomeAt`、`dropHomeNote`（控えが、その送信の書いた署名のときだけ消す）、`homeJoinStill`（確定 → Join へ渡す一回かぎりの問い）。`homeKeyNow`／`readHome`／`saveHomePatch`／`homeStorage` の行は、そのままです。
2. **`confirmHome()`**
   - 開始時に `run = { choice, ctx, world, visitor, note, sent }` を控えます。`mine()`＝その一覧がいまも `FS.homeChoice` で、`contextSeq` が同じ（本人・接続先・世界の変更で進む番号）。
   - `pending`／`error`／選択の取り消しは `run.choice` へ、`mine()` のときだけ。
   - 待ちのあと、後続の前に `mine()` を確かめて止まります（下の表）。
   - 関数の中の `saveHomePatch` は、`run.note` へ書きます。**署名つきの控えは、`mine()` でなくても必ず保存**。それ以外（控えの消去、選択）は `mine()` のときだけ。
   - PlaceHome の `onLost` は `dropHomeNote(run.note, run.sent)`。
   - `finally` は `run.choice` の印だけ外します。文脈が替わったあとも画面に残っていた一覧（世界の変更で、確定中だったので残したもの）は、ここで捨てます。
   - 訪問者の接続：`takeOver()`（下）。
3. **`ACTIONS.join` の通常の部分だけ**（local play の部分と、`join: async () => {` の行は不変）
   - 鍵の導出のあと、確定から渡された問いが偽なら、覚えず・送らずに `{ ok: false, code: 'ContextChanged' }` を返します（画面には何も言いません）。
   - 控えを書く先（`noteAt`）と「確定の一部か」を、`act`／`paidJoin` に渡すのと同じ、待ちのない区間で決めます。そこから署名するウォレットを読むまでに、待ちはありません（`actOnce` は Join の署名者を最初の待ちの前に読み、`paidJoin` は先頭で読みます）。
   - `onSent` はそこへ書き、`onLost` は自分の署名のときだけ消します。

### 待ちごとの扱い

| 待ち | 替わっていたら |
|---|---|
| 接続 | 訪問者が、同じ世界で接続した場合だけ続行の候補。ほかは止まる |
| `refresh()`（記録の読み込み） | 止まる（訪問者の接続なら `takeOver()` が成り立つときだけ続く） |
| 控えの確認（通常・local play） | 控えを消さない。エラーを出さない。止まる |
| 区画の読み直し | 止まる（選択を取り消さない、保存しない） |
| Join（鍵の導出のあと） | 送らない |
| Join（送ったあと） | 控えは送ったときの記録に残る。後続は止まる |
| 本人の記録が見えるのを待つ | 控えを消さない。止まる |
| 鍵の登録のあと | PlaceHome を送らない |
| PlaceHome（送ったあと） | 控えは押したときの記録に残る。画面には何も出さない |
| 最後の反映待ち | 何も出さない |

### 訪問者が押して接続した場合

既存の作りでは、接続すると訪問者の一覧と国の選択は捨てられます。これを持ち越すと、訪問者として選んだものでウォレットの Join・PlaceHome を送ることになるので、**持ち越していません**。続行するのは、次のすべてが成り立つときだけです：押したときウォレットが無かった／接続後も世界が同じ／いまの一覧（ウォレット自身のもの）が確定中でなく、選択をすでに持っている。成り立たなければ、何も送らずに戻ります（変更前は null 参照で落ちて「参加を完了できませんでした」が出ていた経路です。いまは何も出ません）。

## 静的な逆レビュー

- **成功**：`mine()` はずっと真。書き込み先は `run.choice`＝`FS.homeChoice`、保存先は `run.note`＝いまの key。変更前と同じ結果です。
- **失敗（送信前の拒否、チェーンの失敗）**：エラーは `run.choice` へ。`onLost` は、自分の署名の控えが残っていれば消します。
- **新しい要求**：確定中は `busy` なので、二度目の `home-confirm`、`home-pick`、候補の読み直しは始まりません（既存の守り）。本人が替わったあとの新しい確定は別の `run` で、前の確定の終わりに `busy` を外されません。
- **途中の切替（本人）**：`resetViewer` が一覧を捨て、番号を進めます。前の確定は次の `mine()` で止まります。送信済みなら、控えは前の本人の記録にあります。
- **途中の切替（世界）**：`adoptPinnedWorld` は確定中の一覧を残し、番号を進めます。前の確定は止まり、終わりに一覧を捨てます。
- **結果が分からない送信**：控えを消す場所は、変更前と同じ5か所（確認の2×2、Join が見えたあと）＋ `onLost` だけで、どれも条件を緩めていません。`mine()` でないときは、消しません。再送の入口は増えていません。
- **二つの送信が同じ記録に控えを書く場合**：前の送信の `onLost` が、後の送信の控えを消さないようにしました（署名で照合）。

## 未実行の回帰

- 新規 `permutation-gateway/test/web-frontier-ws07-home-confirm-owner-text.test.mjs`（10件、文字の照合のみ。K1 保存先、K2 run、K3 表示と終わり、K4 待ちごとの停止、K5 送信済みの保存、K6 消去の条件、K7 通常の Join、K8 訪問者の接続、K9 不変の行、K10 再送の入口なし）。
- 更新 `web-frontier-ws07-home-reread-text.test.mjs`（H10 の、`confirmHome` の行のピンだけ）。
- **どちらも走らせていません。** ピンは、Python の文字列・順序・件数の一致で、ソースと合うことだけを確かめました。既存の `web-frontier-local-play.test.mjs`／`web-frontier-local-play-act.test.mjs` が文字で固定している行（local play の Join の控え、PlaceHome の `onSent`、二つの確認ブロック、`join` の行、`homeKeyNow` ほか）は、変えていません。それらの試験も走らせていません。

## 保証していないこと・未決（ここで止めたもの）

1. **保存 key は世界の「世代」を持ちません。** key は cluster・program・seasonId・本人だけです。ページの世界の印（`providerWorld`）は世代と season の口座も含みます。seasonId が同じまま世界の印だけが替わる場合、前の世界の控えと選択を、新しい世界が同じ key で読みます。直すには key の契約を変える必要があるので、触っていません。**親の判断が要ります。**
2. **前の本人・世界の記録に残した控えは、その本人・世界に戻って確定を押したときにだけ確かめられます。** 戻らなければ、そのままです（自動で確かめる処理は足していません）。
3. **NFT の本人の PlaceHome**：`actOnce` は、署名するウォレットを読む前に、世代の読み取りを待ちます。その間にウォレットが替わった場合の署名者は、控えを書く記録（押したときの本人）と一致しないことがあります。送信の側（`actOnce`）は主の領域なので、触っていません。
4. **確定の中の鍵の登録（`ACTIONS.session`）** と、**確定を通らない単独の Join** は、鍵の導出の待ちの間の切替を見ていません。前者は終わったあとに止まるだけ、後者は対象外です。
5. **local play**：範囲が替わったときに控えを書かないのは、既存の決まりのままです。署名はページのメモリの台帳にだけ残り、ページを閉じると無くなります。
6. **訪問者の接続後**に続行しなかったとき、画面は何も言いません。案内の文は新しい文言になるので、足していません。
7. 実際のページ、ウォレット、world、送信では、何も確かめていません。
