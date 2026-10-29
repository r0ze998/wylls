# ① 国として戦略を立て、参加できる仕組み

WYLLS の「国のチーム戦略」を、実装に渡せるゲーム設計と、選択と失敗を試せる試作にしたもの。

- **基準：** commit `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（PR #22 の統合候補）。`main` へのマージや CI の成功を前提にしていない。
- **作業場所：** 専用の worktree と専用ブランチ `ws/01-national-strategy`。成果物はこのフォルダだけ。共通コア・共有ナビ・共有翻訳・他担当の成果物は変更していない（接続は `proposals/` に提案として分けた）。
- **状態：** 推奨は仮案。決定ではない。

## 一言で

国は物を持たない。国の目標は「呼びかけ」で、各人が**自分の物を、自分の判断で、一つの場所に組み合わせる**。進み具合は**到着済み**だけで数え、軍は**自動で出ない**。遅延・退出・施設の喪失・方針の対立・不在が起きても、関わる人それぞれに「待つ」以外の選択と、その結果が出る。

## 中身

| 文書 | 内容 |
|---|---|
| [docs/01-current-state.ja.md](docs/01-current-state.ja.md) | 今の国・所属・投票・同盟・追放・物資移転を、実装＋テスト／実装のみ／設計のみに分けた整理 |
| [docs/02-border-outpost.ja.md](docs/02-border-outpost.ja.md) | 作例「国境の共同拠点を準備する」：提案→参加→役割分担→準備→成果→失敗後 |
| [docs/03-governance.ja.md](docs/03-governance.ja.md) | 目標の提案と採択の制度3案の比較と推奨の仮案、権限、退出、方針変更、不在 |
| [docs/04-contributions.ja.md](docs/04-contributions.ja.md) | 固定の職業にしない貢献の型、自給、短時間の参加、協力の得と機会費用、他の目標の例 |
| [docs/05-rules-draft.ja.md](docs/05-rules-draft.ja.md) | **推奨ルール案**（R0〜R12） |
| [docs/06-diff-from-current.ja.md](docs/06-diff-from-current.ja.md) | 既存実装との差分、設計文書との食い違い、試作と本番の違い |
| [docs/07-requests.ja.md](docs/07-requests.ja.md) | ②④⑤⑦へ渡す要求 |
| [docs/08-owner-decisions.ja.md](docs/08-owner-decisions.ja.md) | 本人が決める事項 |
| [docs/09-test-results.ja.md](docs/09-test-results.ja.md) | テスト結果（通過・失敗・未実行）と、人間の試遊の案 |
| [proposals/](proposals/README.ja.md) | 接続の差分の提案（未適用） |
| `prototype/` | 国の卓の試作（依存なし） |
| `test/` | ルールのテスト（`node --test`）とブラウザの煙テスト（Playwright） |
| `screenshots/` | 煙テストが撮った画面 |

## 試作の起動

Node 20 以上（確認は Node 22.22.0）。依存のインストールは要らない。

```sh
cd <この worktree>
node workstreams/01-national-strategy/prototype/serve.mjs          # http://127.0.0.1:41871/
node workstreams/01-national-strategy/prototype/serve.mjs --port 8080
```

ブラウザで開き、上の人物（ケイ・ミラ・ソウタ・ハル）を切り替えて、その人の「次に必要な判断」を押す。「出来事」から遅延・退出・施設の喪失・方針の対立・不在を起こす。画面の下の「試し方（5分）」に手順がある。

**ES モジュールなので、`file://` で直接開くと動かない。** `serve.mjs` か、任意の静的サーバーで `prototype/` を配る。

## テスト

```sh
node --test workstreams/01-national-strategy/test/*.test.mjs        # ルール20・乱数40・回帰12（72件）
node workstreams/01-national-strategy/test/browser.smoke.mjs        # ブラウザで押す（9件）。--shots で screenshots/ に保存
```

結果は [docs/09-test-results.ja.md](docs/09-test-results.ja.md)。**どちらも「ルールと画面が書いたとおりに動く」ことの確認で、人間が面白いと感じた証拠ではない。**

## 試作のつくり

- `prototype/model.mjs`：ルール本体。画面を持たない純粋なモジュール（ブラウザと node の両方で動く）。`act`（人の行動、持ち主の確認つき）、`advance`（ターン）、`inject`（試作の出来事）、`needProgress`・`readiness`（進み具合と成立）、`custody`（提供・持ち主・使う人）、`decisionsFor`（人ごとの判断と選択肢と結果）、`perform`（選択肢の実行。画面とテストが同じ道を通る）。
- `prototype/scenario.mjs`：作例のデータ。S1 から写した数字には出典を、仮の数字には［仮］を付けた。
- `prototype/ui.mjs`・`index.html`・`table.css`：画面。共有の CSS や翻訳は使っていない。
- `prototype/serve.mjs`：127.0.0.1 だけで、このフォルダの中だけを配る小さなサーバー。
