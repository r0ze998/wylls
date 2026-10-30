# ⑥ 住人が仕組みを作り、公開し、他の人が使い直す

**基準：** 共通基準 commit `4cd901de9f8e0d6c0b2016851d30595c4a70aa46`（PR #22 の統合候補の祖先。main 統合済み・CI 全成功とは扱わない）。ブランチ `claude/wylls-creation-publishing-reuse-31aiyj`。成果物はこのフォルダだけにあり、共通コア・他担当の仕様・共有 UI・CI は変更していない。

**状態（2026-10-30）：** ローカル試作まで完了。ゲーム本体への接続は未完了。

**一言で：** 既存の命令（S1 の荷車、S2 の札の命令）を組み合わせる **型つきの定義（manifest）** と、その **検証器**、そして「作る → 条件を確認 → ローカルの一覧へ公開 → 別の利用者が選ぶ → 実行前に不足を確認 → 採用（固定）→ 自分の依頼で実行（模擬）→ 写して編集」を操作できる **試作** です。プログラミングは参加の条件にしていません（見本を選んで、場所と数を選ぶだけで作れる）。

## 2026-10-30 の決定と、その実装

| 決定 | 実装 | 文書 | テスト |
|---|---|---|---|
| 新しい世界効果は当面コア側だけが追加。雛形は将来の検討案 | 検証器は表にない効果をすべて拒否（変更なし。雛形は実装しない） | [docs/04](docs/04-world-effects.ja.md) | `abcd` |
| 作者の公開停止は新規利用・新規採用だけを止める。採用済みの固定版は止めない。権限取消・期限切れ・残高不足は実行を止める | 採用の記録（`src/adoption.mjs`）、実行時の検査（`src/execute.mjs`） | [docs/05](docs/05-update-policy.ja.md) | `policy`・`runtime` |
| 緊急停止は別の仕組み。誰が何を止められるか | 提案だけ（利用者の停止・施設の持ち主の取り消し（模擬）・作者の公開停止は実装） | [docs/08](docs/08-emergency-stop.ja.md) | `policy` |
| 説明だけの patch でも自動で移さない。版と内容ハッシュに固定。通知と確認を分ける | 更新の通知（`updateNotices`）と、`supersedes` による利用者の確認 | [docs/05](docs/05-update-policy.ja.md) | `policy`・`upgrade` |
| ②③④との接続は渡せる資料に。確定仕様として押し込まない。CI は差分で残す | 引き渡し資料（対応・不一致の候補・未決定事項）、`ci.diff`（未適用） | [handoff/](handoff/README.ja.md) | ― |

## 何が本物で、何が模擬か

| | 状態 | 説明 |
|---|---|---|
| 定義の形式・検証器・紙の自動生成 | **動く** | `src/`。Node とブラウザの両方で同じコード |
| 署名（作者の公開・状態変更、利用者の計画・実行の依頼・停止） | **動く**（鍵は模擬） | WebCrypto の Ed25519。鍵は repo に書いた固定の種（demo seed）から作る。秘密ではないので何も預けないこと |
| ローカルの一覧への公開・停止・取り下げ・版の管理 | **動く** | メモリとブラウザの localStorage だけ。**インターネットへの公開や外部登録はしていない** |
| 写して編集（A） | **動く** | 写らないもの（署名・札・物・記録・作者の場所の既定・主張・説明）を一覧にして示す |
| 実行前の確認・採用（固定） | **動く**（世界は模擬） | 世界のスナップショットは S1 の場所と、**未統合ブランチ `ccr-184d6862-fqutoz` の S2 の札の規則** を写した模擬データ。確認は助言で、何も許可せず何も押さえない |
| 実行 | **模擬だけ** | `src/execute.mjs`。チェーン・中継サーバー・ウォレットに **何も送らない**。手順ごとに権利・物・残高・容量を検査し直す。荷車はすぐ着く（襲撃は指定時のみ）。実行できるのは荷車と工房の手順だけ |
| 完了記録（証明）と束（消費する権利） | **模擬** | 記録は消費されない過去の出来事の証明、束は配達の物を押さえた1回きりの権利（[docs/07](docs/07-guarantees.ja.md)） |
| 実世界（ゲームのチェーン）への作用 | **できない** | ④の Run が⑥の計画と依頼を受け取って既存の命令を送る部分は、まだどこにもない |
| S2 の効果を main（S1）で | **動かない** | S1 だけの世界では、工房の手順は確認でも実行でも `EFFECT_UNAVAILABLE` |
| 新しい種類の世界効果（D） | **追加していない** | 分類と比較だけ。任意コード実行は入れていない |

**ローカルで防げていることと、②④やチェーンがなければ防げないことの区別**は [docs/07](docs/07-guarantees.ja.md) §3 にまとめました。この試作の「防げている」は、すべて一つのプロセスの中の模擬の話です。

## A・B・C・D の区別

| | この試作での形 | 必要なもの |
|---|---|---|
| **A 定義を写す** | `forkManifest`：定義の構造だけを写し、`derivedFrom` に元を記録 | 新しい作者の署名。写しは何の権利も成果も持たない |
| **B 他人が動かしている施設へ接続** | `uses.*.relation = "connect"`（例：Wの工房へ、使用権の札で） | 利用者自身の札（S2 の束）。確認と実行時に持ち手・取り消し・発行元・世代・期限・残り回数を検査 |
| **C 確定した成果を使う** | `uses.*.relation = "consume"`（例：Mの鉱山の便が届いた物） | 実行の依頼で名指しする、自分の未消費の束（消費する権利）。束が指す記録（証明）が、確定した、成功した、期待する作り手・版・出力の、自分あての配達であること |
| **D 新しい世界効果** | 定義には書けない（`EFFECT_UNKNOWN`／`EFFECT_FORBIDDEN`） | コアの拡張（新しいシーズン） |

## 例：他人の工房を使う補給計画を、入力元と受取先を変えて使い直す

1. **作者A** が「前線補給」を作る：自分の鉱山の倉 → 工房と同じ州の自分の倉へ材料を運ぶ → **工房主W** の工房を使用権の札で3回動かす → 兵器12を前線の倉へ送る。Aの鍵で署名してローカルの一覧へ公開。
2. **利用者B** が一覧で選ぶ。紙（機械が書いたもの）とAの説明は分けて表示される。
3. B は **自分の鍵だけで** 計画を準備する。確認：`MISSING_GRANT`、在庫の不足（警告）、Dの砦あてはウォレットが要る（知らせ）。
4. B が A の定義を写す。署名のない写しは公開できず、Aの名前で出そうとしても `SIGNATURE_INVALID`。
5. B が写しを編集する：**入力元** を「鉱山主M の便が届いた物（C）」に替え、**受取先** を自分で決める入力にする。Bの鍵で公開。
6. 写した直後の計画は、入力・札・束がない（`PARAM_UNBOUND`・`MISSING_GRANT`・`BATCH_INVALID unbound`）。Aの札を名指ししても `GRANT_NOT_HELD`。
7. B が W から使用権の札を得る（S2 の引き換えを模した操作）。M が便を走らせ（模擬）、届いた記録（証明）と、B の束（消費する権利）ができる。
8. B が計画を **採用**（版と内容ハッシュに固定）。計画を持っているだけでは動かず（`RUN_REQUEST_INVALID`）、B が署名した **実行の依頼** で1回動く。Dの砦に兵器12が届き、束は消費済みになる（記録は証明として残る）。
9. B（写しの作者）が公開を停止しても、B の採用済みの計画は次の日も動く。新しい採用は `ENTRY_NOT_LISTED`。
10. 説明だけの patch が出ても通知だけ。計画は確認済みの版のまま。W の取り消し（模擬）は、採用済みの計画も実行時に止める（`GRANT_REVOKED`）。

## 動かし方

```sh
# テスト（依存なし。Node 20/22）
node workstreams/06-creation/cli/fixtures.mjs --check
node --test workstreams/06-creation/test/*.test.mjs

# 上の例を端末で通す
node workstreams/06-creation/cli/demo.mjs

# ブラウザの試作（127.0.0.1 だけで待ち受け）
node workstreams/06-creation/proto/serve.mjs      # → http://127.0.0.1:8606/proto/
# ブラウザの通し確認（Playwright が要る。開発用コンテナにはある）
node workstreams/06-creation/proto/e2e.mjs [画像の保存先]
```

画面の使い方：上の「今の人」で 作者A／利用者B／工房主W／鉱山主M／Bの味方D を切り替えます。どの操作も今の人の鍵だけで署名し、「世界と台帳」タブの署名の記録で、誰の鍵が何に署名したかを確かめられます。

## 成果物の地図

| 納品物 | 場所 |
|---|---|
| 既存の S2〜S4 設計・SDK・公開機能の確認 | [docs/01-survey.ja.md](docs/01-survey.ja.md) |
| 定義形式（計画・採用・実行の依頼を含む） | [docs/02-manifest-format.ja.md](docs/02-manifest-format.ja.md)、`src/manifest.mjs`・`src/types.mjs`・`src/catalog.mjs` |
| 検証器 | [docs/03-validator.ja.md](docs/03-validator.ja.md)、`src/validate.mjs`・`src/registry.mjs`・`src/plan.mjs`・`src/codes.mjs` |
| 採用・実行（模擬）・記録と束 | `src/adoption.mjs`・`src/execute.mjs`・`src/ledger.mjs`、[docs/07](docs/07-guarantees.ja.md) |
| 動く作成・利用・写しの試作 | `proto/`（ブラウザ）、`cli/demo.mjs`（端末） |
| 成功／失敗の fixture | `fixtures/ok/`（4件）・`fixtures/ng/`（23件）・`fixtures/cases.json`・`fixtures/world.json`（`cli/fixtures.mjs` で再生成、`--check` で一致を確認） |
| 既存機能で表現できる範囲と拡張が必要な範囲 | [docs/04-world-effects.ja.md](docs/04-world-effects.ja.md) |
| 公開停止・固定版・更新の扱い | [docs/05-update-policy.ja.md](docs/05-update-policy.ja.md) |
| ローカルで防げること／②④・チェーンが要ること | [docs/07-guarantees.ja.md](docs/07-guarantees.ja.md) |
| 緊急停止（提案） | [docs/08-emergency-stop.ja.md](docs/08-emergency-stop.ja.md) |
| 独立レビュー11件の一覧 | [docs/09-review-findings.ja.md](docs/09-review-findings.ja.md) |
| ②③④・共有UI・CI への引き渡し | [handoff/](handoff/README.ja.md)（`ci.diff` は未適用） |

## テストの結果

[テストの結果は、このブランチの最新 commit で実行した結果を下に記す]

## 判断してほしいこと（まとめ）

1. 1日の回数を「実行の開始」で数えるか「成功」で数えるか（[docs/05](docs/05-update-policy.ja.md) §4）。
2. 緊急停止の権限者・範囲・作者の注意の知らせ（[docs/08](docs/08-emergency-stop.ja.md) §4）。
3. 配達の物を押さえる「束」をコアの仕組みとして求めるか、C を自由在庫から取る形に下げるか（[handoff/04](handoff/04-run-receipt.ja.md) §1.4）。
4. ②③④への依頼（[handoff/README](handoff/README.ja.md) の最後）を各担当に渡すか。

## 変えていないもの

共通コア（`frontier-abi`・`permutation-frontier`・`permutation-rules`）、他担当の仕様、共有 UI（`permutation-server/web`）、CI の設定、`workstreams/06-creation/` の外のどのファイルも変更していない。push・main への merge・deploy・課金・実資金の利用・既存作業の停止や削除はしていない。
