# 接続の提案（未適用）

この作業は、共通コア・共有ナビ・共有翻訳・他担当の成果物を変更していない。つなぐときの差分を、ここに提案として置く。**どれも適用していない。** 適用するかは本人と各担当が決める。

| ファイル | 中身 | 触る共有物 | 確認 |
|---|---|---|---|
| `0001-nav-nation-table.patch` | Frontier の下のナビに「国の卓」のタブを足す（`table.html` へ、旗の絵）。英訳 `'国の卓': 'Nation table'` を足す | 共有ナビ（`permutation-server/web/frontier/index.html`）、共有翻訳（`permutation-server/web/lang/en-frontier.mjs`） | 基準 commit 4cd901d に `git apply --check` で当たることを確認。`table.html` 自体はまだない（試作は `workstreams/01-national-strategy/prototype/` にある） |

## 本番に入れるときに要るもの（差分はまだ書いていない）

1. **目標の記録の置き場所：** 評議会のサービス（`permutation-gateway/citizens/social/`）の伝言と同じ、署名つきのオフチェーン記録に「目標」「賛同」「申し出」「依頼」「返事」「方針変更」の種類を足す。国ごとの閲覧権限が要る（⑤ 5-1）。評議会のコードは AI 実行の保護対象（`citizens/registrar.mjs:69`）なので、変更は担当と相談する。
2. **画面：** 試作の `model.mjs` の計算（`needProgress`・`readiness`・`custody`・`decisionsFor`）を、ヘラルドの公開データ（`h/caravans.json`・`h/structures.json`・`h/nations.json`）と目標の記録から作る。ルール部分は画面と切り離してあるので、そのまま持っていける形にした。
3. **テスト：** `permutation-gateway` の `npm test`（`node --test`）に、試作のテストを移す。
