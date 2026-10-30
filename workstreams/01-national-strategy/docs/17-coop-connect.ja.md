# 17. 競争以外の協力を本物のゲームにつなぐ最小版（国をまたぐ物資の依頼）

**状態（2026-10-30）：** ブランチ `ws/01-coop-connect`（`0dd4e5d` から）。ローカルの実装・テスト・commit まで。push・merge・deploy はしていない。**本物のローカルのチェーンでの一巡は未実施**（17-4）。

## 17-1. 動く経路

```
依頼（依頼した人のウォレットの署名）
 → 応じる／断る（応じる人のウォレットの署名。資源は動かず、義務もない）
 → 隊商：ゲームの村の引き出し「交易と防備」→「隊商を送る」（S1 の SendCaravan。ほかの人あては送り主のウォレットで署名）
 → 結び付け（隊商の持ち主の署名。板がヘラルドの輸送中の一覧で、持ち主・行き先・積み荷を照らす）
 → 到着の確定（ヘラルドの h/caravans.json の ended＝CARAVAN_SETTLED / CARAVAN_RAIDED。④のパッチ）
 → 共同の目的（資源ごと。確定した到着だけ。判定は仮で切り替え可能）
```

| 部品 | 場所 | 中身 |
|---|---|---|
| 署名付きの記録 | `coop/record.mjs` | 依頼・応答（応じる／断る）・取り下げ・取消・結び付け・抜ける の6種。Ed25519（ウォレットの `solana:signMessage`）。物々交換・加工の貸出・到着時払いの種類はない |
| 到着の確認（④との契約の形） | `coop/arrival.mjs` | 隊商ごとに 状態・持ち主の印・確かめた量。17-3 |
| 目的と判定 | `coop/goal.mjs` | 目的1件「渡り場の貯蔵庫を建てる」（費用は S1 の `VAULT_COST`：木材200・石材200・金50。ほかの人から木材200・石材200［仮］）。判定 仮A（確定した到着だけ、資源ごと）／仮B（＋到着の後に依頼した人の新しい貯蔵庫が見えた）。共同・国・個人を別々に返す |
| 板 | `coop/board.mjs` | 記録を受け取り、署名・時刻・状態を確かめて追記で保存。**資源を動かさない・隊商を送らない・誰の代わりにも署名しない。** ゲームと同じ入口にするため、ほかの要求はヘラルドへ転送 |
| 画面 | `coop/index.html`・`coop-ui.mjs` | 共同の目的・国の記録・自分 を別々の枠に。依頼を出す・応じる・断る・取り下げる（別の相手へ）・取り消す（自分で進める／ほかの理由）・抜ける・隊商を結び付ける・判定の切り替え |

**選択として残したもの：** 相手を変える（取り下げて別の依頼に応じる。依頼した人は別の人の応答を待てる）、協力せず自分で進める（取消の理由「自分で進める」）、途中で抜ける（自分の依頼は取消、応じた答えは取り下げ。送った隊商はそのまま届く）。

**しないこと：** 依頼への参加で資源を動かす・義務を生む。国による徴収。報酬・賞金。勝利条件の採用・世界の終了・中央塔の用途・国別専用の資源は決めていない。

## 17-2. 起動（ローカルの S1 の世界がある場合）

```sh
# 1. S1 の世界（docs/RUNNING.md の 3章。cargo-build-sbf 3.1.9 が要る）
frontier-node/target/release/frontier-stack up --conquest --mode accel --beacon test-key --scale 10 --game-hours 16 \
  --season-end-at-play-end --bots 0 --personas off --run-id coop-1 --base-port 41900 --season 91
# 2. ④のパッチ（確定の記録 ended）を当てたヘラルドで動かす：proposals/0002-herald-caravan-ended.patch
# 3. 板（program id は frontier-node/.local/frontier/coop-1/state.json）
node workstreams/01-national-strategy/coop/board.mjs --herald http://127.0.0.1:41940 --program <program id> --season 91
# 4. 人ごとに別の入口（Dev Wallet は入口ごと）：http://p1.localhost:41873/frontier/frontier/ と http://p1.localhost:41873/ws01/
```

板の入口（41873）からゲームを開くと、ゲームと依頼の画面が同じ Dev Wallet（`ps-dev-wallet`）で署名する。

## 17-3. ④と合わせる契約（依頼 ID・隊商 ID・所有者・到着状態・検証済み量）

| 項目 | 形 | 出どころ |
|---|---|---|
| 依頼 ID | 依頼の記録（署名を除く）の sha256、16進 | `record.mjs` `recordId` |
| 隊商 ID | `{ownerTag: 10進の文字列, seq}`（S1 の Caravan の鍵 `caravan_seed`） | ヘラルドの `moving[].ownerTag/seq` |
| 所有者 | `ownerTag`：ウォレット → Citizen の口座 → 先頭8バイト（`faddr.mjs` の `citizenTag`）。奪われたら `raiderTag` | 結び付けの時に板が照らす |
| 到着状態 | `moving` / `delivered` / `misdelivered` / `lost` / `raided-taken` / `raided-burned` / `unknown` | `arrival.mjs` `arrivalOf` |
| 検証済み量 | 依頼の資源ごとの、CARAVAN_SETTLED（DELIVERED、依頼の届け先）の `cargo`（経路の塔の目減りの後）。それ以外は `null`（未検証・数えない） | ヘラルドの `ended`（パッチ） |

**④へのパッチ `proposals/0002-herald-caravan-ended.patch`（未適用）：** ヘラルドの `h/caravans.json` に `ended`（確定と襲撃の記録、新しい512件）を足す。今のヘラルドは確定した隊商を一覧から消すだけで、届いたか・失われたか・どれだけかを出していない。チェックポイントは `ended` のない古い形も読める。パッチを当てたヘラルドのテスト 39件が通る（今の38件＋足した1件。既存の1件に `ended` の確かめを足した）。`ended` のないヘラルドでは、消えた隊商は `unknown`（未検証）になり、量を数えない。

## 17-4. 未接続・模擬の部分（明示）

| 部分 | 状態 |
|---|---|
| **本物のローカルのチェーンでの一巡** | **未実施。** S1 のプログラムを組み立てる `cargo-build-sbf`（Agave 3.1.9）がこの環境になく、入れる操作（外部のインストーラの実行）は許可されなかった。だから、隊商がチェーンに載ってヘラルドに出る部分は、テストでは偽のヘラルドで模している |
| 隊商の命令 | 実物のモジュール（`fplay.mjs` の `accountsFor`・`buildShape`）で組み立て、署名者が送り主のウォレットだけであること、隊商の口座が `ownerTag` と番号から決まることを確かめた。チェーンへは送っていない |
| 到着の確定 | ヘラルドのパッチは Rust のテストで確かめた。そのパッチのヘラルドが書いた形の見本（`test/fixtures/herald-caravans-ended.json`、Rust が書き出したもの）を、既存の画面の解析（`herald.mjs` `parseCaravans`）と①の読み取りの両方が受け付ける。本物の世界の到着では確かめていない |
| 国 | 記録の国は**申告**（未検証）。ヘラルドの村の陣営で照らすのは未実装 |
| 施設の観測（仮B） | 板がヘラルドの貯蔵庫の一覧を見た時刻で判定。**届いた物で建てたかは区別できない**（在庫は混ざる） |
| 板 | 記録の改ざんと別人の名乗りは署名で防ぐ。**板が記録を出さない（隠す）ことは防げない。** 記録はチェーンに載せていない |
| 一人の判定 | 複数のウォレットは区別しない（本人確認は決めていない） |
| ⑦の入口 | `proposals/0003-s1-coop-entry.patch`（未適用）：村の引き出し「交易と防備」に「国をまたぐ依頼」を足し、この村を届け先にして依頼の画面を開く。開く先の住所と英語の訳は統合で決める |
| AI の参加（⑤） | 対象外 |

## 17-5. テスト

- `test/coop.test.mjs`（13件）：一巡（応じても0 → 本物の命令の形 → 輸送中は0 → 確定で目減り後の量 → 資源ごとの判定 → 仮B）、資源を合計しない、取消、失敗（LOST）、略奪（奪う・焼く・確定の記録なしで行き先が変わる）、相手の退出と別の相手、未検証（ended なし）、結び付けの確かめ、記録の確かめ（改ざん・別人・時刻・自分の依頼・依頼にない量・知らない種類）、期限、追記の保存、Rust の見本、HTTP の入口と転送。
- `test/coop.browser.mjs`（8件）：2人の Dev Wallet で、依頼 → 応じる（0のまま）→ 結び付け → 確定 → 共同の目的（木材196／200・石材0／200 で未達成）→ 取消（自分で進める）、スマホの幅、ページのエラーなし。
- ヘラルドのパッチ：当てた状態で `cargo test --locked -p herald --lib`（39件、pass 39）。当てた後は元に戻した。

## 17-6. 統合用の変更一覧

| 変更 | 担当 | ファイル | 状態 |
|---|---|---|---|
| ヘラルドの `h/caravans.json` に `ended` | ④（統合） | `proposals/0002-herald-caravan-ended.patch` → `frontier-node/crates/herald/src/caravan.rs` | 未適用。`git apply --check` 可 |
| 村の引き出しの入口 | ⑦ | `proposals/0003-s1-coop-entry.patch` → `permutation-server/web/frontier/screens/s1.mjs` | 未適用。`git apply --check` 可 |
| 依頼の記録・到着の契約・目的・板・画面 | ① | `workstreams/01-national-strategy/coop/` | このブランチ |
