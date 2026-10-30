# ① 国として戦略を立て、参加できる仕組み

WYLLS の「国のチーム戦略」を、実装に渡せるゲーム設計と、選択と失敗を試せる試作にしたもの。

- **基準：** commit `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（PR #22 の統合候補）。`main` へのマージや CI の成功を前提にしていない。
- **作業場所：** 専用の worktree と専用ブランチ `ws/01-national-strategy`。成果物はこのフォルダだけ。共通コア・共有ナビ・共有翻訳・他担当の成果物は変更していない（接続は `proposals/` に提案として分けた）。
- **状態（2026-10-30）：** 設計とローカルの試作まで完了。**本物の S1 への接続と人間の試遊は未完了。** 推奨は仮案で、決定ではない。

## 一言で

国の目標は「呼びかけ」で、各人が**自分の物を、自分の判断で、一つの場所に組み合わせる**。この試作の範囲では、国による徴収と国の共有資産は作らない（ゲーム全体の原則ではない。既存の「国の取り分」は別の未統合事項）。採択（賛同3）は試遊の仮説で、賛同は資源を出す約束でも発送の権限でもない。成立は**期限のターンに、条件が実際に使える状態でそろっているか**で判定し、軍は**自動で出ない**。遅延・退出・施設の喪失・方針の対立・不在が起きても、関わる人それぞれに「待つ」以外の選択と、その結果が出る。

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
| [docs/09-test-results.ja.md](docs/09-test-results.ja.md) | 結果：テスト・S1 への接続・人間の理解・面白さを分けて。保全の状態 |
| [docs/10-playtest-plan.ja.md](docs/10-playtest-plan.ja.md) | 人間3〜5人の試遊の準備（既存の試作を使う）。募集・外部送信はしていない |
| `playtest/observation-sheet.csv` | 試遊の記録用紙（空の雛形） |
| [docs/11-nations-tower-placement-now.ja.md](docs/11-nations-tower-placement-now.ja.md) | 追加検証（2026-10-30）：6国の説明と実装された能力、中央の塔、現行の初期配置 |
| [docs/12-placement-comparison.ja.md](docs/12-placement-comparison.ja.md) | 初期配置 A・B・C の比較（B が最初の試作候補）、場面、配置運と戦略、中央塔との相性、試遊の質問 |
| [docs/13-handoff-08.ja.md](docs/13-handoff-08.ja.md) | ⑧への引き渡し（⑧の成果物は手元になく、接続していない） |
| `prototype/placement.html` | 配置を切り替える地図。数字の比較と、その配置の距離で国の卓を開く |
| [docs/14-international-supply.ja.md](docs/14-international-supply.ja.md) | 追加（2026-10-30）：国を越えた小さな供給網。シナリオ、共同成果、得と費用、退出、代わりの手、権限、勝利条件の比較（採用しない）、数え方、②④の境、⑧への比較条件と失敗仮説 |
| [docs/15-supply-consistency.ja.md](docs/15-supply-consistency.ja.md) | 整合確認（2026-10-30）：作例の全操作と実装範囲（S1 の贈与・②の候補・模擬・新しい契約。②④の成果物は取得できず未検証）、人ごとの時間順の記録、「自分の物から先に」の限定、共同・国・個人の評価の分離 |
| [docs/16-handoff-08-win-conditions.ja.md](docs/16-handoff-08-win-conditions.ja.md) | ⑧への引き渡し（一つにまとめたもの）：0a／0b／X／Y を評価するための入力。採用はしない |
| [docs/17-coop-connect.ja.md](docs/17-coop-connect.ja.md) | **競争以外の協力を本物のゲームにつなぐ最小版**（ブランチ `ws/01-coop-connect`）：署名付きの依頼の記録、S1 の隊商、到着の確定（④との契約）、共同・国・個人の別表示。動く経路・未接続・統合用の変更一覧 |
| [docs/18-handoff-04.ja.md](docs/18-handoff-04.ja.md) | ④への引き渡し：到着量の正本（チェーンの取引の記録）と契約、共有コードのパッチ 0002・0004、④から受け取りたいもの |
| [docs/19-reconcile-04.ja.md](docs/19-reconcile-04.ja.md) | ④の受領版（2e536b6b）との到着量の照合、到着時の受取人と今の持ち主、まだ合っていない点 |
| `coop/` | 国をまたぐ依頼の板と画面（`node coop/board.mjs --herald … --program … --season …`） |
| `prototype/supply.html` | 国際供給網の最小デモ（配置は固定。交換は②を模したもの） |
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

ブラウザで開き（配置の比較は `/placement.html`）、上の人物（ケイ・ミラ・ソウタ・ハル）を切り替えて、その人の「次に必要な判断」を押す。「出来事」から遅延・退出・施設の喪失・方針の対立・不在を起こす。画面の下の「試し方（5分）」に手順がある。

**ES モジュールなので、`file://` で直接開くと動かない。** `serve.mjs` か、任意の静的サーバーで `prototype/` を配る。

## テスト

```sh
node --test workstreams/01-national-strategy/test/*.test.mjs        # ルール20・条件15・乱数40・回帰12・配置15・供給網18・供給網の回帰11・供給網の乱数30（161件）＋国をまたぐ依頼26件（`coop.test.mjs`）・この画面から送る13件（`coop.send.test.mjs`）＝200件
node workstreams/01-national-strategy/test/browser.smoke.mjs        # ブラウザで押す（14件）。--shots で screenshots/ に保存
node workstreams/01-national-strategy/test/coop.browser.mjs         # 国をまたぐ依頼をブラウザで押す（8件）
node workstreams/01-national-strategy/test/coop.realrelay.mjs       # 本物の中継とヘラルドへの道（4件。要：gateway の npm ci、frontier-herald の build。無ければ skip）
```

結果は [docs/09-test-results.ja.md](docs/09-test-results.ja.md)。**どちらも「ルールと画面が書いたとおりに動く」ことの確認で、人間が面白いと感じた証拠ではない。**

## 試作のつくり

- `prototype/model.mjs`：ルール本体。画面を持たない純粋なモジュール（ブラウザと node の両方で動く）。`act`（人の行動、持ち主の確認つき）、`advance`（ターン）、`inject`（試作の出来事）、`needProgress`・`readiness`（進み具合と成立の条件）、`allocations`（今ある物と兵を、二重に数えないよう目標に割り当てる）、`cosignCount`（賛同を村と判断する人に分けて数える）、`custody`（提供・持ち主・使う人）、`decisionsFor`（人ごとの判断と選択肢と結果）、`perform`（選択肢の実行。画面とテストが同じ道を通る）。
- `prototype/scenario.mjs`：作例のデータ。S1 から写した数字には出典を、仮の数字には［仮］を付けた。
- `prototype/ui.mjs`・`index.html`・`table.css`：画面。共有の CSS や翻訳は使っていない。
- `prototype/serve.mjs`：127.0.0.1 だけで、このフォルダの中だけを配る小さなサーバー。
