# 接続の提案（未適用）

この作業は、共通コア・共有ナビ・共有翻訳・他担当の成果物を変更していない。つなぐときの差分を、ここに提案として置く。**どれも適用していない。** 適用するかは本人と各担当が決める。

| ファイル | 中身 | 触る共有物 | 確認 |
|---|---|---|---|
| `0001-nav-nation-table.patch` | Frontier の下のナビに「国の卓」のタブを足す（`table.html` へ、旗の絵）。英訳 `'国の卓': 'Nation table'` を足す | 共有ナビ（`permutation-server/web/frontier/index.html`）、共有翻訳（`permutation-server/web/lang/en-frontier.mjs`） | 基準 commit 4cd901d に `git apply --check` で当たることを確認。`table.html` 自体はまだない（試作は `workstreams/01-national-strategy/prototype/` にある） |
| `0002-herald-caravan-ended.patch`（2026-10-30、④へ） | ヘラルドの `h/caravans.json` に `ended`（CARAVAN_SETTLED と CARAVAN_RAIDED の記録、新しい512件）を足す。依頼に結び付けた隊商が届いたか・何を運んだかを確かめるのに要る。`cargo` は記録の積荷で、宛先に加算された量ではない（村あては下限、倉あては不明。17章 17-3）。④の実入荷量の記録案とは未照合 | 共通コア（`frontier-node/crates/herald/src/caravan.rs`） | `git apply --check` で当たる。当てた状態で `cargo test --locked -p herald --lib` 39件が通る。当てた後は元に戻した |
| `0002b-herald-caravan-ended-on-ef63544c.patch`（2026-11-05、④へ） | 0002 と同じ中身を、統合側の最新 `integration/ws09-13-v16-d0949fd4`（`ef63544c`）の `caravan.rs`（`0bec3450` で raided の扱いが変わった）に合わせ直したもの。**0002 と 0002b はどちらか一方だけを当てる**（二重に当てない） | 共通コア（同上） | `ef63544c` の上で `git apply --check` が当たる。当てた使い捨ての worktree で `cargo test --offline -p herald --lib caravan` 4件が通る（21章 21-5） |
| `0004-fcodec-i16-array.patch`（2026-10-30、④へ） | 共有の `fcodec.mjs` に `[i16;N]` の型を足す（Caravan の口座の `PROVINCES` が読めず decode が例外になる） | 共有の画面のコード（`permutation-server/web/frontier/fcodec.mjs`） | `git apply --check` で当たる。当てても当てなくても `permutation-gateway` の `web-*.test.mjs` は同じ結果（pass 896・fail 14、fail は当てる前から） |
| `0003-s1-coop-entry.patch`（2026-10-30、⑦へ） | 村の引き出し「交易と防備」に「国をまたぐ依頼」を足し、この村を届け先にして依頼の画面を開く。開く先の住所と英訳は統合で決める | 共有 UI（`permutation-server/web/frontier/screens/s1.mjs`） | `git apply --check` で当たる。当てた状態でモジュールが読み込めることを確認 |

## 本番に入れるときに要るもの（差分はまだ書いていない）

1. **目標の記録の置き場所：** 評議会のサービス（`permutation-gateway/citizens/social/`）の伝言と同じ、署名つきのオフチェーン記録に「目標」「賛同」「申し出」「依頼」「返事」「方針変更」の種類を足す。国ごとの閲覧権限が要る（⑤ 5-1）。評議会のコードは AI 実行の保護対象（`citizens/registrar.mjs:69`）なので、変更は担当と相談する。
2. **画面：** 試作の `model.mjs` の計算（`needProgress`・`readiness`・`custody`・`decisionsFor`）を、ヘラルドの公開データ（`h/caravans.json`・`h/structures.json`・`h/nations.json`）と目標の記録から作る。ルール部分は画面と切り離してあるので、そのまま持っていける形にした。
3. **テスト：** `permutation-gateway` の `npm test`（`node --test`）に、試作のテストを移す。
